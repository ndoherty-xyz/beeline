import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { targetToRect, type Trace } from "../eval/replay.ts";
import { predictTargetProbabilities, scoreTargets, type ModelWeights } from "../src/model.ts";

// Written by train/train.py: random weights, synthetic clicks, and what the Python model gives for them.
const fixture: { weights: ModelWeights; traces: Trace[]; scores: number[][][]; probabilities: number[][][]; withinProbabilities: number[][][] } = JSON.parse(
  readFileSync(new URL("model-fixture.json", import.meta.url), "utf8"),
);
const { weights } = fixture;

// Python's BLAS sums in a different order and its log1p/hypot may differ in the last bit, so not bit-exact.
const TOLERANCE = 1e-12;

test("TS scores, shares and within-window probabilities match the Python model on every sample of the fixture", () => {
  fixture.traces.forEach((trace, traceIndex) => {
    const history = trace.samples.map(([t, x, y]) => ({ t, x, y }));
    const targetRects = trace.targets.map(targetToRect);
    history.forEach((_, sampleIndex) => {
      const where = `trace ${traceIndex}, sample ${sampleIndex}`;
      const scores = scoreTargets(weights, history.slice(0, sampleIndex + 1), targetRects);
      const probabilities = predictTargetProbabilities(weights, history.slice(0, sampleIndex + 1), targetRects);
      scores.forEach((score, target) => assert.ok(Math.abs(score - fixture.scores[traceIndex][sampleIndex][target]) < TOLERANCE, where));
      probabilities.forEach((probability, target) =>
        assert.ok(Math.abs(probability - fixture.probabilities[traceIndex][sampleIndex][target]) < TOLERANCE, where),
      );
      // The same weights with the none option switched on.
      const withinProbabilities = predictTargetProbabilities({ ...weights, withinMs: 300 }, history.slice(0, sampleIndex + 1), targetRects);
      withinProbabilities.forEach((probability, target) =>
        assert.ok(Math.abs(probability - fixture.withinProbabilities[traceIndex][sampleIndex][target]) < TOLERANCE, where),
      );
    });
  });
});
