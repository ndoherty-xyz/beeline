import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { fineTuneOutputLayer } from "../packages/beeline/src/finetune.ts";
import type { ModelWeights } from "../packages/beeline/src/model.ts";
import type { Trace } from "../packages/beeline/src/traces.ts";

// Written by train/train.py: random start weights fine-tuned on synthetic clicks, with the batch orders it drew.
const fixture: { start: ModelWeights; traces: Trace[]; orders: number[][]; steps: number; weights: ModelWeights } = JSON.parse(
  readFileSync(new URL("finetune-fixture.json", import.meta.url), "utf8"),
);

// Python rounds its inputs to float32, so the two drift apart slightly over the steps.
const TOLERANCE = 1e-6;

test("TS output-layer fine-tune matches train.py's on the fixture", () => {
  const orders = [...fixture.orders];
  const weights = fineTuneOutputLayer(fixture.start, fixture.traces, { steps: fixture.steps, shuffleIndices: () => orders.shift()! });
  assert.equal(orders.length, 0);
  const pairs: [string, number, number][] = [
    ...weights.outputWeights.map((weight, index): [string, number, number] => [`outputWeights[${index}]`, weight, fixture.weights.outputWeights[index]]),
    ...weights.noneWeights.map((weight, index): [string, number, number] => [`noneWeights[${index}]`, weight, fixture.weights.noneWeights[index]]),
    ["noneBias", weights.noneBias, fixture.weights.noneBias],
  ];
  for (const [name, actual, expected] of pairs) assert.ok(Math.abs(actual - expected) < TOLERANCE, `${name}: ${actual} vs ${expected}`);
  // The fine-tune moved them, and left the hidden layer alone.
  assert.ok(Math.abs(fixture.start.noneBias - fixture.weights.noneBias) > 1e-3);
  assert.deepEqual(weights.hiddenWeights, fixture.start.hiddenWeights);
});
