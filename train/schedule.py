"""Offline replay of an on-device update schedule: as the user's clicks accumulate, either keep fine-tuning the current
model every 100 clicks, or retrain from scratch at a few checkpoints. Writes one weights file per checkpoint for
eval/finetune.ts to score on the same held-out clicks as train.py.

Usage: uv run --project train train/schedule.py data/traces-<date>.jsonl data/adserp-traces.jsonl <out dir>

Writes <out dir>/<strategy>-<clicks so far>.json:
- chain-output / chain-all: starting from the AdSERP-only model, every 100 clicks fine-tune the latest model on every
  click so far (output layer for 300 steps, or the whole network for 100).
- retrain-user / retrain-mix: train from scratch on the clicks so far, alone or with AdSERP's training people.
"""

import argparse
import json
from pathlib import Path

from train import (
    ADSERP_HELD_OUT_PEOPLE,
    HELD_OUT_SHARE,
    build_snapshots,
    export_weights,
    find_acquisitions,
    find_empty_clicks_without_retry,
    label_snapshots,
    load_traces,
    train,
)

WITHIN_MS = 650
FINE_TUNE_LEARNING_RATE = 1e-3
TRAINABLE_BY_LAYERS = {
    "output": ["output_weights", "none_weights", "none_bias"],
    "all": None,
}

UPDATE_EVERY_CLICKS = 100
CHAIN_RECIPES = {"chain-output": ("output", 300), "chain-all": ("all", 100)}
# Checkpoints written for scoring; the last is every training click.
SCORED_CLICK_COUNTS = [100, 200, 300, 500, 1000, 1500, 2000]
RETRAIN_CLICK_COUNTS = [200, 500, 1000, 1500, 2000]


def build_inputs(traces):
    """Return each trace's snapshots and labels, as train() takes them."""
    snapshots, times = zip(*(build_snapshots(trace) for trace in traces))
    labels = [label_snapshots(trace, snapshot_times, WITHIN_MS) for trace, snapshot_times in zip(traces, times)]
    return list(snapshots), labels


def main():
    """Replay each strategy over the user's training clicks in time order, writing weights at the scored checkpoints."""
    parser = argparse.ArgumentParser()
    parser.add_argument("traces")
    parser.add_argument("adserp")
    parser.add_argument("out_dir", type=Path)
    args = parser.parse_args()
    args.out_dir.mkdir(parents=True, exist_ok=True)

    # The same split as train.py.
    traces = load_traces(args.traces)
    acquisitions = find_acquisitions(traces)
    split = round(len(acquisitions) * (1 - HELD_OUT_SHARE))
    user_train = acquisitions[:split]
    trained_until = user_train[-1]["time"]
    empty_clicks = [trace for trace in find_empty_clicks_without_retry(traces) if trace["time"] <= trained_until]
    adserp_acquisitions = find_acquisitions(load_traces(args.adserp))
    held_out_people = sorted({trace["person"] for trace in adserp_acquisitions})[::5][:ADSERP_HELD_OUT_PEOPLE]
    adserp_train = [trace for trace in adserp_acquisitions if trace["person"] not in held_out_people]

    write = lambda name, fit: (args.out_dir / f"{name}.json").write_text(
        json.dumps(export_weights(*fit, trained_until, held_out_people, WITHIN_MS)) + "\n"
    )
    adserp_snapshots, adserp_labels = build_inputs(adserp_train)
    base = train(adserp_snapshots, adserp_labels)
    user_snapshots, user_labels = build_inputs(user_train)
    empty_snapshots, empty_labels = build_inputs(empty_clicks)

    def clicks_so_far(count):
        """Return the snapshots and labels of the first count clicks and the clicks on nothing recorded by then."""
        empty_indices = [i for i, trace in enumerate(empty_clicks) if trace["time"] <= user_train[count - 1]["time"]]
        return (
            user_snapshots[:count] + [empty_snapshots[i] for i in empty_indices],
            user_labels[:count] + [empty_labels[i] for i in empty_indices],
        )

    final_count = len(user_train)
    update_counts = list(range(UPDATE_EVERY_CLICKS, final_count, UPDATE_EVERY_CLICKS)) + [final_count]
    for strategy, (layers, steps) in CHAIN_RECIPES.items():
        model = base
        for count in update_counts:
            model = train(*clicks_so_far(count), start=model, trainable=TRAINABLE_BY_LAYERS[layers], steps=steps, learning_rate=FINE_TUNE_LEARNING_RATE)
            if count in SCORED_CLICK_COUNTS or count == final_count:
                write(f"{strategy}-{count}", model)
                print(f"wrote {strategy}-{count}", flush=True)

    for count in RETRAIN_CLICK_COUNTS + [final_count]:
        snapshots, labels = clicks_so_far(count)
        write(f"retrain-user-{count}", train(snapshots, labels))
        write(f"retrain-mix-{count}", train(snapshots + adserp_snapshots, labels + adserp_labels))
        print(f"wrote retrain-user-{count} and retrain-mix-{count}", flush=True)


if __name__ == "__main__":
    main()
