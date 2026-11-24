import assert from "node:assert/strict";
import { test } from "node:test";
import {
  predictForesightPoint,
  segmentIntersectsRect,
  type Rect,
  type TimedPoint,
} from "../packages/extension/src/baselines.ts";
import { lineSegmentIntersectsRect } from "./foresight-4.3.0/helpers/lineSegmentIntersectsRect.ts";
import { createMouseHistory, predictNextMousePosition } from "./foresight-4.3.0/helpers/predictNextMousePosition.ts";

const square: Rect = { left: 10, top: 10, right: 20, bottom: 20 };

test("predictForesightPoint returns the current point without usable velocity", () => {
  assert.deepEqual(predictForesightPoint([{ t: 0, x: 5, y: 6 }]), { x: 5, y: 6 }, "no history");
  assert.deepEqual(predictForesightPoint([{ t: 0, x: 1, y: 1 }, { t: 81, x: 5, y: 6 }]), { x: 5, y: 6 }, "history older than 80 ms");
  assert.deepEqual(predictForesightPoint([{ t: 0, x: 5, y: 6 }, { t: 16, x: 5, y: 6 }]), { x: 5, y: 6 }, "not moving");
});

test("predictForesightPoint reaches 200 * ln(1 + speed * 120 / 200) px along the velocity", () => {
  // 1 px/ms to the right, with an older point outside the 80 ms window that must be ignored.
  const frameHistory = [{ t: 0, x: 500, y: 500 }, ...[100, 116, 132, 148].map((t) => ({ t, x: t, y: 20 }))];
  const predicted = predictForesightPoint(frameHistory);
  assert.ok(Math.abs(predicted.x - (148 + 200 * Math.log(1.6))) < 1e-9);
  assert.equal(predicted.y, 20);
});

test("segmentIntersectsRect", () => {
  assert.equal(segmentIntersectsRect({ x: 0, y: 15 }, { x: 30, y: 15 }, square), true, "crosses");
  assert.equal(segmentIntersectsRect({ x: 0, y: 15 }, { x: 5, y: 15 }, square), false, "stops short");
  assert.equal(segmentIntersectsRect({ x: 12, y: 12 }, { x: 14, y: 14 }, square), true, "inside");
  assert.equal(segmentIntersectsRect({ x: 15, y: 15 }, { x: 15, y: 15 }, square), true, "point inside");
  assert.equal(segmentIntersectsRect({ x: 0, y: 25 }, { x: 30, y: 25 }, square), false, "parallel, outside");
  assert.equal(segmentIntersectsRect({ x: 0, y: 20 }, { x: 30, y: 20 }, square), true, "along an edge");
  assert.equal(segmentIntersectsRect({ x: 0, y: 10 }, { x: 10, y: 0 }, square), false, "diagonal past the corner");
  assert.equal(segmentIntersectsRect({ x: 0, y: 20 }, { x: 20, y: 0 }, square), true, "diagonal through the corner");
});

/**
 * Function to make a seeded random number generator (mulberry32), so failures reproduce.
 * @param seed Any 32-bit integer.
 * @returns A function returning floats in [0, 1).
 */
function seededRandom(seed: number): () => number {
  return () => {
    seed = (seed + 0x6d2b79f5) | 0;
    let r = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    r = (r + Math.imul(r ^ (r >>> 7), 61 | r)) ^ r;
    return ((r ^ (r >>> 14)) >>> 0) / 4294967296;
  };
}

test("the port matches Foresight.js 4.3.0 on random movements", () => {
  const random = seededRandom(1);
  let now = 0;

  for (let run = 0; run < 50; run++) {
    const targetRects: Rect[] = Array.from({ length: 30 }, () => {
      const left = random() * 1400;
      const top = random() * 800;
      return { left, top, right: left + 10 + random() * 200, bottom: top + 10 + random() * 60 };
    });
    const libraryHistory = createMouseHistory();
    const frameHistory: TimedPoint[] = [];
    let x = random() * 1500;
    let y = random() * 850;
    let vx = 0;
    let vy = 0;
    for (let frame = 0; frame < 200; frame++) {
      // 60 or 120 Hz frames with jitter and the odd pause; velocity wanders, and sometimes the cursor stops.
      now += random() < 0.05 ? 50 + random() * 500 : (run % 2 ? 8.3 : 16.6) + random() * 0.4;
      vx = random() < 0.1 ? 0 : vx + (random() - 0.5) * 8;
      vy = random() < 0.1 ? 0 : vy + (random() - 0.5) * 8;
      x += vx;
      y += vy;

      const libraryPredicted = { x: 0, y: 0 };
      predictNextMousePosition({ x, y }, now, libraryHistory, 120, libraryPredicted);
      const libraryHits = targetRects.map((rect) => lineSegmentIntersectsRect({ x, y }, libraryPredicted, rect));

      frameHistory.push({ t: now, x, y });
      const predicted = predictForesightPoint(frameHistory);
      const hits = targetRects.map((rect) => segmentIntersectsRect({ x, y }, predicted, rect));

      assert.deepEqual(predicted, libraryPredicted, `run ${run}, frame ${frame}`);
      assert.deepEqual(hits, libraryHits, `run ${run}, frame ${frame}`);
    }
  }
});
