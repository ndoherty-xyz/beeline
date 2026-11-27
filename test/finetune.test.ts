import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { fineTune } from "../packages/beeline/src/finetune.ts";
import type { ModelWeights } from "../packages/beeline/src/model.ts";
import type { Trace } from "../packages/beeline/src/traces.ts";

// Written by train/train.py: random start weights fine-tuned on synthetic clicks, with the batch orders it drew and the
// expected parameters after training.
const fixture: {
  start: ModelWeights;
  traces: Trace[];
  orders: number[][];
  steps: number;
  weights: ModelWeights;
} = JSON.parse(readFileSync(new URL("finetune-fixture.json", import.meta.url), "utf8"));

test("the full TypeScript update matches Python on every learned parameter", () => {
  const orders = [...fixture.orders];
  const actual = fineTune(fixture.start, fixture.traces, { steps: fixture.steps, shuffleIndices: () => orders.shift()! });
  for (const key of ["hiddenWeights", "hiddenBiases", "outputWeights", "noneWeights", "noneBias"] as const) {
    const values = [actual[key]].flat(2);
    const expected = [fixture.weights[key]].flat(2);
    assert.equal(values.length, expected.length, key);
    values.forEach((value, i) => assert.ok(Math.abs(value - expected[i]) < 1e-6, `${key}[${i}]`));
  }
});
