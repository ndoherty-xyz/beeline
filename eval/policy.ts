// Reproduce the README comparison from one trace export: node eval/policy.ts <export.jsonl>
import { readFileSync } from "node:fs";
import defaultWeights from "../packages/beeline/src/default-weights.json" with { type: "json" };
import { fineTune } from "../packages/beeline/src/finetune.ts";
import { PREFETCH_THRESHOLD } from "../packages/beeline/src/prefetch.ts";
import { selectTrainingClicks } from "../packages/beeline/src/traces.ts";
import { CLICKS_PER_UPDATE } from "../packages/extension/src/personal-model.ts";
import { findFirstFires, replayForesight, replayModel, samplesSinceLastScroll, type Trace } from "./replay.ts";

const traces: Trace[] = readFileSync(process.argv[2], "utf8").trim().split("\n").map(line => JSON.parse(line));
const training = selectTrainingClicks(traces.filter(trace => trace.time <= defaultWeights.trainedUntil)).slice(0, CLICKS_PER_UPDATE);
if (training.length < CLICKS_PER_UPDATE) throw new Error("The export needs 100 usable clicks before the held-out split.");
const weights = fineTune(defaultWeights, training);
const trainingPages = new Set(training.map(trace => trace.page));
const holdout = traces.filter(trace => trace.version === 2 && trace.time > weights.trainedUntil && !trainingPages.has(trace.page))
  .sort((a, b) => a.time - b.time);
for (const trace of holdout) trace.samples = samplesSinceLastScroll(trace).sort((a, b) => a[0] - b[0]);

/**
 * Function to approximate continuous hover over each same-origin anchor using its recorded box.
 * @param trace The click window.
 * @returns Each target's first hover timer expiry relative to pointerdown, in milliseconds.
 */
function findHoverFires(trace: Trace): Map<number, number> {
  const fires = new Map<number, number>();
  trace.targets.forEach(([left, top, width, height], target) => {
    if (trace.targetLinks![target] !== 1) return;
    let entered: number | undefined;
    for (const [time, x, y] of trace.samples) {
      if (time < -1000) continue;
      if (entered !== undefined && time >= entered + 100) break;
      if (x >= left && x <= left + width && y >= top && y <= top + height) entered ??= time;
      else entered = undefined;
    }
    if (entered !== undefined && entered + 100 <= 0) fires.set(target, entered + 100);
  });
  return fires;
}

for (const policy of ["Hover", "Beeline", "Foresight"]) {
  const firstFetch = new Map<string, number>();
  const used = new Set<string>();
  let navigations = 0;
  let savedMs = 0;
  for (const trace of holdout) {
    const first = findHoverFires(trace);
    if (policy === "Beeline") {
      for (const { t, probabilities } of replayModel(trace, weights)) {
        if (t < -1000) continue;
        probabilities.forEach((p, target) => {
          if (p >= PREFETCH_THRESHOLD) first.set(target, Math.min(t, first.get(target) ?? t));
        });
      }
    } else if (policy === "Foresight") {
      for (const [target, t] of findFirstFires(trace, replayForesight(trace).filter(frame => frame.t >= -1000))) {
        first.set(target, Math.min(t, first.get(target) ?? t));
      }
    }
    // Keep the first fetch time per destination across all click windows on the page.
    const keys = trace.targetDestinations!.map(id => `${trace.page}:${id}`);
    for (const [target, t] of first) {
      if (trace.targetLinks![target] !== 1) continue;
      const key = keys[target];
      firstFetch.set(key, Math.min(trace.time + t, firstFetch.get(key) ?? Infinity));
    }
    if (trace.targetLinks![trace.clicked] !== 1 || trace.outcome?.navigatedMs === undefined) continue;
    navigations++;
    const key = keys[trace.clicked];
    const start = firstFetch.get(key);
    if (start === undefined || used.has(key)) continue;
    used.add(key);
    savedMs += Math.min(400, trace.time - start);
  }
  if (!navigations) throw new Error("No same-origin navigations on held-out pages.");
  console.log({ policy, pages: new Set(holdout.map(trace => trace.page)).size, navigations,
    hits: used.size, savedMsPerNavigation: savedMs / navigations, unused: firstFetch.size - used.size });
}
