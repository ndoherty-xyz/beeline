import assert from "node:assert/strict";
import { test } from "node:test";
import { scorePolicy } from "../eval/helpers/replay.ts";
import defaultWeights from "../packages/beeline/src/default-weights.json" with { type: "json" };
import type { Trace } from "../packages/beeline/src/traces.ts";

test("wait saved includes missed navigations and each destination counts once per page", () => {
  // Two anchors point to destination 7. The third is cross-origin.
  const click: Trace = {
    version: 2, page: "a", time: 2000, viewport: [200, 200], pointerCursor: false, clicked: 0,
    targets: [[0, 0, 20, 20], [0, 0, 20, 20], [0, 0, 20, 20]], targetLinks: [1, 1, 2],
    targetDestinations: [7, 7, 8], samples: [[-800, 10, 10, 10, 10, 1]], outcome: { id: "a-1", press: [], navigatedMs: 10 },
  };
  const traces = [
    click,                                              // 700 ms lead, capped at 400.
    { ...click, time: 3000, clicked: 1 },               // Same fetch, no second credit.
    { ...click, page: "b", time: 4000, samples: [] },   // Miss.
    { ...click, page: "c", time: 5000, clicked: 2 },    // One unused same-origin destination.
  ];
  assert.deepEqual(scorePolicy(traces, "Hover", defaultWeights), { savedMsPerNavigation: 400 / 3, unused: 1 });
});
