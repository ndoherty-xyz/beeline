import assert from "node:assert/strict";
import { test } from "node:test";
import {
  findFirstFires,
  isAcquisition,
  replayChromePrediction,
  replayForesight,
  replayHover,
  scorePredictor,
  type Trace,
} from "../eval/replay.ts";

// The cursor moves right at 1 px/ms along y = 50, from x = 0 (250 ms before the click) to x = 200 (50 ms before),
// with Chrome predicting 20 px ahead. Targets: 0 is the clicked one, 1 is on the way, 2 is off the path.
const straightTrace: Trace = {
  time: 0,
  device: "mouse",
  viewport: [1000, 800],
  samples: Array.from({ length: 21 }, (_, index) => {
    const t = -250 + index * 10;
    return [t, t + 250, 50, t + 270, 50, 1];
  }),
  targets: [
    [180, 30, 40, 40],
    [80, 40, 20, 20],
    [80, 200, 20, 20],
  ],
  clicked: 0,
  pointerCursor: false,
};

test("isAcquisition is false when the cursor starts on the clicked target", () => {
  assert.equal(isAcquisition(straightTrace), true);
  assert.equal(isAcquisition({ ...straightTrace, samples: straightTrace.samples.slice(-3) }), false);
  assert.equal(isAcquisition({ ...straightTrace, samples: [] }), false);
});

test("each baseline fires the clicked target at the expected time", () => {
  // Hover: the cursor reaches x = 180. Chrome: its prediction reaches x = 180. Foresight at 1 px/ms reaches
  // 200 * ln(1.6) = 94 px ahead, so it fires from x = 90.
  assert.equal(findFirstFires(straightTrace, replayHover(straightTrace)).get(0), -70);
  assert.equal(findFirstFires(straightTrace, replayChromePrediction(straightTrace)).get(0), -90);
  assert.equal(findFirstFires(straightTrace, replayForesight(straightTrace)).get(0), -160);
});

test("scorePredictor counts hits, every first fire, and lead times", () => {
  assert.deepEqual(scorePredictor([straightTrace], replayHover), { clicks: 1, hits: 1, fires: 2, leadTimesMs: [70] });
});

test("isAcquisition is false for a click that hit no target", () => {
  assert.equal(isAcquisition({ ...straightTrace, clicked: -1 }), false);
});
