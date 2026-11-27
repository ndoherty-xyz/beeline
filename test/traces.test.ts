import assert from "node:assert/strict";
import { test } from "node:test";
import { isAcquisition, samplesSinceLastScroll, type Trace } from "../packages/beeline/src/traces.ts";

const straightTrace: Trace = {
  time: 0, viewport: [100, 100], targets: [[50, 0, 20, 20]], clicked: 0, pointerCursor: false,
  samples: [[-200, 0, 10, 0, 10, 1], [-150, 30, 10, 30, 10, 1], [-50, 60, 10, 60, 10, 1]],
};

test("an acquisition requires movement onto the clicked target", () => {
  assert.equal(isAcquisition({ ...straightTrace, clicked: -1 }), false);
  assert.equal(isAcquisition(straightTrace), true);
  assert.equal(isAcquisition({ ...straightTrace, samples: straightTrace.samples.slice(-1) }), false);
  assert.equal(isAcquisition({ ...straightTrace, samples: [] }), false);
});

test("samplesSinceLastScroll keeps v1 samples and drops v2 samples up to the last scroll", () => {
  assert.deepEqual(samplesSinceLastScroll(straightTrace), straightTrace.samples);
  const scrolled: Trace = {
    ...straightTrace,
    scrollers: [
      { page: true, events: [[-200, 0, 10]] },
      { page: false, events: [[-150, 0, 40]] },
    ],
  };
  assert.deepEqual(
    samplesSinceLastScroll(scrolled).map(([t]) => t),
    [-50],
  );
});
