"""Train beeline's base model on recorded traces and export it for packages/beeline/src/model.ts.

Usage: uv run --project train train/train.py data/traces-<date>.jsonl [--adserp data/adserp-traces.jsonl] [--within-ms 650] [--out weights.json]

The model learns each target's chance of being clicked within --within-ms: a softmax over the targets plus a
"no click by then" option, scored from the motion features alone. --adserp mixes in other people's traces from
eval/convert-adserp.ts, holding out whole people.

Writes packages/beeline/src/model-weights.json (or --out) (gitignored: trained on personal movement), and test/model-fixture.json: synthetic
traces and random weights with the scores Python gives them, which test/model.test.ts checks the TS model
reproduces.
"""

import argparse
import json
import math
from pathlib import Path

import numpy as np

from beeline_model import MOTION_FEATURE_COUNT, compute_features, predict_probabilities, score_targets

REPO = Path(__file__).resolve().parent.parent
HELD_OUT_SHARE = 0.2
SNAPSHOT_WINDOW_MS = 1000
SNAPSHOT_STRIDE = 2  # every other sample: ~16 ms at 120 Hz
HIDDEN_UNITS = 128
EPOCHS = 30
TRACES_PER_BATCH = 32
LEARNING_RATE = 3e-3
WEIGHT_DECAY = 1e-4
RETRY_GAP_MS = 1000
ADSERP_HELD_OUT_PEOPLE = 10
# AdSERP is one layout (search results on one screen size), so it gets only twice the weight of its click count.
ADSERP_REPEATS = 2


# Data ----------


def load_traces(path):
    """Load every trace, keeping only the samples after the last scroll (eval/replay.ts samplesSinceLastScroll), sorted."""
    traces = []
    for line in Path(path).read_text().splitlines():
        trace = json.loads(line)
        last_scroll = max((event[0] for scroller in trace.get("scrollers", []) for event in scroller["events"]), default=-math.inf)
        trace["samples"] = sorted((sample for sample in trace["samples"] if sample[0] > last_scroll), key=lambda sample: sample[0])
        traces.append(trace)
    return traces


def find_acquisitions(traces):
    """Return the clicks where the cursor moved onto the clicked target (eval/replay.ts isAcquisition), oldest first."""
    acquisitions = []
    for trace in traces:
        if trace["clicked"] == -1 or not trace["samples"]:
            continue
        x, y = trace["samples"][0][1:3]
        left, top, width, height = trace["targets"][trace["clicked"]]
        if not (left <= x <= left + width and top <= y <= top + height):
            acquisitions.append(trace)
    return sorted(acquisitions, key=lambda trace: trace["time"])


def find_empty_clicks_without_retry(traces):
    """Return clicks on nothing with no target click in the second after (eval/replay.ts findEmptyClicksWithoutRetry)."""
    trace_by_id = {trace["id"]: trace for trace in traces if "id" in trace}
    empty_clicks = []
    for trace in traces:
        if trace.get("version") != 2 or trace["clicked"] != -1 or trace["pointerCursor"] or not trace["samples"]:
            continue
        following = trace_by_id.get(f"{trace['page']}-{trace['seq'] + 1}")
        if not following or following["clicked"] == -1 or following["time"] - trace["time"] > RETRY_GAP_MS:
            empty_clicks.append(trace)
    return empty_clicks


def to_rects(targets):
    """Convert recorded [x, y, width, height] targets to an (N, 4) array of [left, top, right, bottom]."""
    targets = np.asarray(targets, dtype=np.float64).reshape(-1, 4)
    return np.hstack([targets[:, :2], targets[:, :2] + targets[:, 2:]])


def build_snapshots(trace):
    """Return model inputs for every snapshot of one click, as an (S, N, features) float32 array, and their times."""
    samples = np.asarray(trace["samples"], dtype=np.float64)
    times, xs, ys = samples[:, 0], samples[:, 1], samples[:, 2]
    rects = to_rects(trace["targets"])
    # Counting back from the last sample, which is where the cursor rested at the click even if that was earlier.
    snapshot_indices = np.flatnonzero(times >= min(-SNAPSHOT_WINDOW_MS, times[-1]))[::-1][::SNAPSHOT_STRIDE][::-1]
    features = np.stack([compute_features(times, xs, ys, index, rects) for index in snapshot_indices]).astype(np.float32)
    return features, times[snapshot_indices]


def label_snapshots(trace, snapshot_times, within_ms):
    """Return the label per snapshot: the clicked target's index, or -1 (none) where the click is further off than
    within_ms."""
    return np.where(snapshot_times >= -within_ms, trace["clicked"], -1)


# Training ----------


def compute_loss_and_gradients(params, inputs, group_sizes, labels):
    """Return the mean cross-entropy over snapshots, gradients for each param, and the mean probability given to the
    clicked target where there is one.

    inputs holds every snapshot's targets back to back; group_sizes gives each snapshot's target count and labels
    the clicked target's index within it, or -1 for the none option.
    """
    hidden_pre = inputs @ params["hidden_weights"].T + params["hidden_biases"]
    hidden = np.maximum(0, hidden_pre)
    scores = hidden @ params["output_weights"]

    starts = np.concatenate([[0], np.cumsum(group_sizes)[:-1]])
    group_max = np.maximum.reduceat(scores, starts)
    motion = inputs[starts, :MOTION_FEATURE_COUNT]
    none_scores = motion @ params["none_weights"] + params["none_bias"]
    group_max = np.maximum(group_max, none_scores)
    exponentials = np.exp(scores - np.repeat(group_max, group_sizes))
    none_exponentials = np.exp(none_scores - group_max)
    totals = np.add.reduceat(exponentials, starts) + none_exponentials
    probabilities = exponentials / np.repeat(totals, group_sizes)

    has_target = labels >= 0
    label_rows = (starts + labels)[has_target]
    none_probabilities = none_exponentials / totals
    label_probabilities = np.concatenate([probabilities[label_rows], none_probabilities[~has_target]])
    loss = -np.log(label_probabilities + 1e-12).mean()
    clicked_mean = probabilities[label_rows].mean()

    score_gradient = probabilities
    score_gradient[label_rows] -= 1
    score_gradient /= len(group_sizes)
    hidden_gradient = np.outer(score_gradient, params["output_weights"]) * (hidden_pre > 0)
    gradients = {
        "output_weights": hidden.T @ score_gradient,
        "hidden_weights": hidden_gradient.T @ inputs,
        "hidden_biases": hidden_gradient.sum(axis=0),
    }
    none_gradient = (none_probabilities - ~has_target) / len(group_sizes)
    gradients["none_weights"] = motion.T @ none_gradient
    gradients["none_bias"] = none_gradient.sum()
    return loss, gradients, clicked_mean


def stack_batch(snapshots, labels):
    """Flatten a list of per-click (S, N, F) arrays and their (S,) labels into inputs, group sizes and labels."""
    inputs = np.concatenate([block.reshape(-1, block.shape[2]) for block in snapshots])
    group_sizes = np.concatenate([np.full(block.shape[0], block.shape[1]) for block in snapshots])
    return inputs, group_sizes, np.concatenate(labels)


def train(train_snapshots, train_labels, held_out_snapshots, held_out_labels):
    """Fit the scorer with Adam on standardised inputs; returns params and the standardisation."""
    rng = np.random.default_rng(0)
    all_inputs = np.concatenate([block.reshape(-1, block.shape[2]) for block in train_snapshots])
    mean = all_inputs.mean(axis=0, dtype=np.float64)
    std = np.maximum(all_inputs.std(axis=0, dtype=np.float64), 1e-6)
    del all_inputs
    standardise = lambda block: ((block - mean) / std).astype(np.float32)
    train_snapshots = [standardise(block) for block in train_snapshots]
    held_out = stack_batch([standardise(block) for block in held_out_snapshots], held_out_labels)

    feature_count = train_snapshots[0].shape[2]
    params = {
        "hidden_weights": rng.normal(0, 1 / np.sqrt(feature_count), (HIDDEN_UNITS, feature_count)),
        "hidden_biases": np.zeros(HIDDEN_UNITS),
        "output_weights": rng.normal(0, 1 / np.sqrt(HIDDEN_UNITS), HIDDEN_UNITS),
        "none_weights": np.zeros(MOTION_FEATURE_COUNT),
        "none_bias": np.array(0.0),
    }
    first_moment = {name: np.zeros_like(value) for name, value in params.items()}
    second_moment = {name: np.zeros_like(value) for name, value in params.items()}
    step = 0
    for epoch in range(EPOCHS):
        order = rng.permutation(len(train_snapshots))
        losses = []
        for start in range(0, len(order), TRACES_PER_BATCH):
            batch = order[start : start + TRACES_PER_BATCH]
            inputs, group_sizes, labels = stack_batch([train_snapshots[i] for i in batch], [train_labels[i] for i in batch])
            loss, gradients, _ = compute_loss_and_gradients(params, inputs, group_sizes, labels)
            losses.append(loss)
            step += 1
            for name, gradient in gradients.items():
                gradient = gradient + WEIGHT_DECAY * params[name]
                first_moment[name] = 0.9 * first_moment[name] + 0.1 * gradient
                second_moment[name] = 0.999 * second_moment[name] + 0.001 * gradient**2
                corrected_first = first_moment[name] / (1 - 0.9**step)
                corrected_second = second_moment[name] / (1 - 0.999**step)
                params[name] -= LEARNING_RATE * corrected_first / (np.sqrt(corrected_second) + 1e-8)
        held_out_loss, _, held_out_metric = compute_loss_and_gradients(params, *held_out)
        print(
            f"epoch {epoch + 1:2d}: train loss {np.mean(losses):.3f}, "
            f"held-out loss {held_out_loss:.3f}, held-out mean p of the clicked target within the window {held_out_metric:.1%}",
            flush=True,
        )
    return params, mean, std


# Export ----------


def export_weights(params, mean, std, trained_until, held_out_people, within_ms):
    """Fold the standardisation into the hidden layer and none option and return weights in the packages/beeline/src/model.ts format."""
    hidden_weights = params["hidden_weights"] / std
    none_weights = params["none_weights"] / std[:MOTION_FEATURE_COUNT]
    return {
        "trainedUntil": trained_until,
        "heldOutPeople": held_out_people,
        "hiddenWeights": hidden_weights.tolist(),
        "hiddenBiases": (params["hidden_biases"] - hidden_weights @ mean).tolist(),
        "outputWeights": params["output_weights"].tolist(),
        "withinMs": within_ms,
        "noneWeights": none_weights.tolist(),
        "noneBias": float(params["none_bias"] - none_weights @ mean[:MOTION_FEATURE_COUNT]),
    }


def make_fixture_traces():
    """Make synthetic clicks covering the feature code's branches, in the recorded trace format.

    Synthetic so that no real trace is committed.
    """
    rng = np.random.default_rng(1)
    traces = []
    for index in range(6):
        targets = [[float(v) for v in np.round([rng.uniform(0, 1100), rng.uniform(0, 700), rng.uniform(4, 300), rng.uniform(4, 120)], 1)] for _ in range(12)]
        left, top, width, height = targets[0]
        targets.append([left + 2, top + 2, round(width / 3, 1), round(height / 3, 1)])  # nested inside target 0
        clicked = int(rng.integers(0, len(targets)))
        left, top, width, height = targets[clicked]
        start = rng.uniform(0, [1200, 800])
        end = np.array([left + width / 2, top + height / 2])
        times = list(np.arange(-600, 0, 8.1))
        progress = np.clip(np.linspace(-0.2, 1.1, len(times)), 0, 1)
        positions = start + (end - start) * (10 * progress**3 - 15 * progress**4 + 6 * progress**5)[:, None]
        positions += rng.normal(0, 2, positions.shape)
        samples = [[round(t, 1), round(x, 1), round(y, 1), round(x, 1), round(y, 1), 1] for t, (x, y) in zip(times, positions)]
        if index == 0:
            samples = samples[:1]  # a single sample
        elif index == 1:
            samples = [[t, *samples[0][1:]] for t, *_ in samples[:20]]  # never moves
        elif index == 2:
            samples = samples[:30] + [[round(t + 120, 1), *rest] for t, *rest in samples[30:]]  # pauses
            samples.insert(1, list(samples[0]))  # a repeated timestamp, as recorded
        traces.append({"time": index, "device": "trackpad", "viewport": [1200, 800], "samples": samples, "targets": targets, "clicked": clicked, "pointerCursor": False})
    return traces


def make_fixture_weights(feature_count):
    """Make random weights in the model-weights.json format, so the fixture reveals nothing about the trained ones."""
    rng = np.random.default_rng(2)
    return {
        "trainedUntil": 0,
        "heldOutPeople": [],
        "hiddenWeights": rng.normal(0, 1 / np.sqrt(feature_count), (HIDDEN_UNITS, feature_count)).tolist(),
        "hiddenBiases": rng.normal(0, 0.5, HIDDEN_UNITS).tolist(),
        "outputWeights": rng.normal(0, 1 / np.sqrt(HIDDEN_UNITS), HIDDEN_UNITS).tolist(),
        "withinMs": 650,
        "noneWeights": rng.normal(0, 1, MOTION_FEATURE_COUNT).tolist(),
        "noneBias": float(rng.normal(0, 1)),
    }


def score_fixture_trace(weights, trace):
    """Return the scores and probabilities the model gives every target at every sample of a trace."""
    samples = np.asarray(trace["samples"], dtype=np.float64)
    rects = to_rects(trace["targets"])
    features = [compute_features(samples[:, 0], samples[:, 1], samples[:, 2], index, rects) for index in range(len(samples))]
    scores = [score_targets(weights, f) for f in features]
    return [s.tolist() for s in scores], [predict_probabilities(weights, f).tolist() for f in features]


def main():
    """Train on the export given on the command line and write the weights and parity fixture."""
    parser = argparse.ArgumentParser()
    parser.add_argument("traces")
    parser.add_argument("--adserp", help="also train on AdSERP traces, holding out whole people")
    parser.add_argument("--within-ms", type=int, default=650, help="learn each target's chance of a click within this many ms")
    parser.add_argument("--out", default=REPO / "packages/beeline/src/model-weights.json", type=Path)
    args = parser.parse_args()

    traces = load_traces(args.traces)
    acquisitions = find_acquisitions(traces)
    split = round(len(acquisitions) * (1 - HELD_OUT_SHARE))
    train_traces, held_out_traces = acquisitions[:split], acquisitions[split:]
    trained_until = train_traces[-1]["time"]
    print(f"{len(acquisitions)} clicks: training on {len(train_traces)}, holding out the newest {len(held_out_traces)}")
    # Clicks on nothing are the only windows where no target is about to be clicked.
    empty_clicks = find_empty_clicks_without_retry(traces)
    train_traces += [trace for trace in empty_clicks if trace["time"] <= trained_until]
    held_out_traces += [trace for trace in empty_clicks if trace["time"] > trained_until]
    print(f"plus {len(empty_clicks)} clicks on nothing, split at the same time")
    held_out_people = []
    if args.adserp:
        adserp_acquisitions = find_acquisitions(load_traces(args.adserp))
        people = sorted({trace["person"] for trace in adserp_acquisitions})
        held_out_people = people[::5][:ADSERP_HELD_OUT_PEOPLE]  # every fifth person
        adserp_train = [trace for trace in adserp_acquisitions if trace["person"] not in held_out_people]
        train_traces += adserp_train * ADSERP_REPEATS
        held_out_traces += [trace for trace in adserp_acquisitions if trace["person"] in held_out_people]
        print(f"plus AdSERP: training on {len(adserp_train)} clicks ({ADSERP_REPEATS}x), holding out {len(held_out_people)} people")

    train_snapshots, train_times = zip(*(build_snapshots(trace) for trace in train_traces))
    held_out_snapshots, held_out_times = zip(*(build_snapshots(trace) for trace in held_out_traces))
    train_labels = [label_snapshots(trace, times, args.within_ms) for trace, times in zip(train_traces, train_times)]
    held_out_labels = [label_snapshots(trace, times, args.within_ms) for trace, times in zip(held_out_traces, held_out_times)]
    params, mean, std = train(list(train_snapshots), train_labels, list(held_out_snapshots), held_out_labels)

    weights = export_weights(params, mean, std, trained_until, held_out_people, args.within_ms)
    args.out.write_text(json.dumps(weights) + "\n")
    fixture_weights = make_fixture_weights(len(weights["hiddenWeights"][0]))
    fixture_traces = make_fixture_traces()
    fixture_outputs = [score_fixture_trace(fixture_weights, trace) for trace in fixture_traces]
    fixture = {
        "weights": fixture_weights,
        "traces": fixture_traces,
        "scores": [scores for scores, _ in fixture_outputs],
        "probabilities": [probabilities for _, probabilities in fixture_outputs],
    }
    (REPO / "test/model-fixture.json").write_text(json.dumps(fixture) + "\n")
    print(f"wrote {args.out} and test/model-fixture.json")


if __name__ == "__main__":
    main()
