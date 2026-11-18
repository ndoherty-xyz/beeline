"""Train beeline's base model on recorded traces and export it for src/model.ts.

Usage: uv run --project train train/train.py data/traces-<date>.jsonl

Writes src/model-weights.json (gitignored: trained on personal movement), and test/model-fixture.json: synthetic
traces and random weights with the scores Python gives them, which test/model.test.ts checks the TS model
reproduces.
"""

import json
import sys
from pathlib import Path

import numpy as np

from beeline_model import compute_features, score_targets, softmax

REPO = Path(__file__).resolve().parent.parent
HELD_OUT_SHARE = 0.2
SNAPSHOT_WINDOW_MS = 800
SNAPSHOT_STRIDE = 2  # every other sample: ~16 ms at 120 Hz
HIDDEN_UNITS = 32
EPOCHS = 30
TRACES_PER_BATCH = 32
LEARNING_RATE = 3e-3
WEIGHT_DECAY = 1e-4


# Data ----------


def load_acquisitions(path):
    """Load the clicks where the cursor moved onto the clicked target (eval/replay.ts isAcquisition), oldest first."""
    acquisitions = []
    for line in Path(path).read_text().splitlines():
        trace = json.loads(line)
        if trace["clicked"] == -1 or not trace["samples"]:
            continue
        trace["samples"].sort(key=lambda sample: sample[0])
        x, y = trace["samples"][0][1:3]
        left, top, width, height = trace["targets"][trace["clicked"]]
        if not (left <= x <= left + width and top <= y <= top + height):
            acquisitions.append(trace)
    return sorted(acquisitions, key=lambda trace: trace["time"])


def to_rects(targets):
    """Convert recorded [x, y, width, height] targets to an (N, 4) array of [left, top, right, bottom]."""
    targets = np.asarray(targets, dtype=np.float64).reshape(-1, 4)
    return np.hstack([targets[:, :2], targets[:, :2] + targets[:, 2:]])


def build_snapshots(trace):
    """Return model inputs for every snapshot of one click, as an (S, N, features) float32 array."""
    samples = np.asarray(trace["samples"], dtype=np.float64)
    times, xs, ys = samples[:, 0], samples[:, 1], samples[:, 2]
    rects = to_rects(trace["targets"])
    # Counting back from the last sample, which is where the cursor rested at the click even if that was earlier.
    snapshot_indices = np.flatnonzero(times >= min(-SNAPSHOT_WINDOW_MS, times[-1]))[::-1][::SNAPSHOT_STRIDE][::-1]
    return np.stack([compute_features(times, xs, ys, index, rects) for index in snapshot_indices]).astype(np.float32)


# Training ----------


def compute_loss_and_gradients(params, inputs, group_sizes, labels):
    """Return the mean cross-entropy over snapshots, gradients for each param, and per-snapshot top-1 hits.

    inputs holds every snapshot's targets back to back; group_sizes gives each snapshot's target count and
    labels the clicked target's index within it.
    """
    hidden_pre = inputs @ params["hidden_weights"].T + params["hidden_biases"]
    hidden = np.maximum(0, hidden_pre)
    scores = hidden @ params["output_weights"]

    starts = np.concatenate([[0], np.cumsum(group_sizes)[:-1]])
    group_max = np.repeat(np.maximum.reduceat(scores, starts), group_sizes)
    exponentials = np.exp(scores - group_max)
    probabilities = exponentials / np.repeat(np.add.reduceat(exponentials, starts), group_sizes)
    label_rows = starts + labels
    loss = -np.log(probabilities[label_rows] + 1e-12).mean()
    top1_hits = scores[label_rows] >= group_max[label_rows]

    score_gradient = probabilities
    score_gradient[label_rows] -= 1
    score_gradient /= len(group_sizes)
    hidden_gradient = np.outer(score_gradient, params["output_weights"]) * (hidden_pre > 0)
    gradients = {
        "output_weights": hidden.T @ score_gradient,
        "hidden_weights": hidden_gradient.T @ inputs,
        "hidden_biases": hidden_gradient.sum(axis=0),
    }
    return loss, gradients, top1_hits


def stack_batch(snapshots, clicked):
    """Flatten a list of per-click (S, N, F) arrays into inputs, group sizes and labels."""
    inputs = np.concatenate([block.reshape(-1, block.shape[2]) for block in snapshots])
    group_sizes = np.concatenate([np.full(block.shape[0], block.shape[1]) for block in snapshots])
    labels = np.concatenate([np.full(block.shape[0], label) for block, label in zip(snapshots, clicked)])
    return inputs, group_sizes, labels


def train(train_snapshots, train_clicked, held_out_snapshots, held_out_clicked):
    """Fit the scorer with Adam on standardised inputs; returns params and the standardisation."""
    rng = np.random.default_rng(0)
    all_inputs = np.concatenate([block.reshape(-1, block.shape[2]) for block in train_snapshots])
    mean = all_inputs.mean(axis=0, dtype=np.float64)
    std = np.maximum(all_inputs.std(axis=0, dtype=np.float64), 1e-6)
    del all_inputs
    standardise = lambda block: ((block - mean) / std).astype(np.float32)
    train_snapshots = [standardise(block) for block in train_snapshots]
    held_out = stack_batch([standardise(block) for block in held_out_snapshots], held_out_clicked)

    feature_count = train_snapshots[0].shape[2]
    params = {
        "hidden_weights": rng.normal(0, 1 / np.sqrt(feature_count), (HIDDEN_UNITS, feature_count)),
        "hidden_biases": np.zeros(HIDDEN_UNITS),
        "output_weights": rng.normal(0, 1 / np.sqrt(HIDDEN_UNITS), HIDDEN_UNITS),
    }
    first_moment = {name: np.zeros_like(value) for name, value in params.items()}
    second_moment = {name: np.zeros_like(value) for name, value in params.items()}
    step = 0
    for epoch in range(EPOCHS):
        order = rng.permutation(len(train_snapshots))
        losses = []
        for start in range(0, len(order), TRACES_PER_BATCH):
            batch = order[start : start + TRACES_PER_BATCH]
            inputs, group_sizes, labels = stack_batch([train_snapshots[i] for i in batch], [train_clicked[i] for i in batch])
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
        held_out_loss, _, held_out_hits = compute_loss_and_gradients(params, *held_out)
        print(
            f"epoch {epoch + 1:2d}: train loss {np.mean(losses):.3f}, "
            f"held-out loss {held_out_loss:.3f}, held-out top-1 {held_out_hits.mean():.1%}"
        )
    return params, mean, std


# Export ----------


def export_weights(params, mean, std, trained_until):
    """Fold the standardisation into the hidden layer and return weights in the src/model.ts format."""
    hidden_weights = params["hidden_weights"] / std
    return {
        "trainedUntil": trained_until,
        "hiddenWeights": hidden_weights.tolist(),
        "hiddenBiases": (params["hidden_biases"] - hidden_weights @ mean).tolist(),
        "outputWeights": params["output_weights"].tolist(),
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
    """Make random weights in the src/model-weights.json format, so the fixture reveals nothing about the trained ones."""
    rng = np.random.default_rng(2)
    return {
        "trainedUntil": 0,
        "hiddenWeights": rng.normal(0, 1 / np.sqrt(feature_count), (HIDDEN_UNITS, feature_count)).tolist(),
        "hiddenBiases": rng.normal(0, 0.5, HIDDEN_UNITS).tolist(),
        "outputWeights": rng.normal(0, 1 / np.sqrt(HIDDEN_UNITS), HIDDEN_UNITS).tolist(),
    }


def score_fixture_trace(weights, trace):
    """Return the scores and probabilities the model gives every target at every sample of a trace."""
    samples = np.asarray(trace["samples"], dtype=np.float64)
    rects = to_rects(trace["targets"])
    scores = [score_targets(weights, compute_features(samples[:, 0], samples[:, 1], samples[:, 2], index, rects)) for index in range(len(samples))]
    return [s.tolist() for s in scores], [softmax(s).tolist() for s in scores]


def main():
    """Train on the export given on the command line and write the weights and parity fixture."""
    acquisitions = load_acquisitions(sys.argv[1])
    split = round(len(acquisitions) * (1 - HELD_OUT_SHARE))
    train_traces, held_out_traces = acquisitions[:split], acquisitions[split:]
    print(f"{len(acquisitions)} clicks: training on {len(train_traces)}, holding out the newest {len(held_out_traces)}")

    train_snapshots = [build_snapshots(trace) for trace in train_traces]
    held_out_snapshots = [build_snapshots(trace) for trace in held_out_traces]
    params, mean, std = train(
        train_snapshots, [t["clicked"] for t in train_traces], held_out_snapshots, [t["clicked"] for t in held_out_traces]
    )

    weights = export_weights(params, mean, std, train_traces[-1]["time"])
    (REPO / "src/model-weights.json").write_text(json.dumps(weights) + "\n")
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
    print("wrote src/model-weights.json and test/model-fixture.json")


if __name__ == "__main__":
    main()
