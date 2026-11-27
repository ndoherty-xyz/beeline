import { predictTargetProbabilities, type ModelWeights, type TimedPoint } from "../../packages/beeline/src/model.ts";
import { HOVER_MS, PREFETCH_THRESHOLD } from "../../packages/beeline/src/prefetch.ts";
import { targetToRect, type Trace } from "../../packages/beeline/src/traces.ts";
import { predictForesightPoint, segmentIntersectsRect } from "../../packages/extension/src/baselines.ts";

export type Policy = "Hover" | "Beeline + hover" | "Foresight + hover";
const FETCH_MS = 400;
const WINDOW_MS = 1000;

/**
 * Function to find the first prefetch time for each same-origin target in a click window.
 * @param trace The trace with ordered samples since the last scroll.
 * @param policy The predictor to run alongside the hover timer.
 * @param weights The fitted Beeline weights.
 * @returns Target indexes and times in milliseconds relative to the click.
 */
function firstPrefetches(trace: Trace, policy: Policy, weights: ModelWeights): Map<number, number> {
  const first = new Map<number, number>();
  const rects = trace.targets.map(targetToRect);
  rects.forEach(({ left, top, right, bottom }, target) => {
    if (trace.targetLinks![target] !== 1) return;
    let entered: number | undefined;
    for (const [time, x, y] of trace.samples) {
      if (time < -WINDOW_MS) continue;
      if (entered !== undefined && time >= entered + HOVER_MS) break;
      if (x >= left && x <= right && y >= top && y <= bottom) entered ??= time;
      else entered = undefined;
    }
    if (entered !== undefined && entered + HOVER_MS <= 0) first.set(target, entered + HOVER_MS);
  });
  if (policy === "Hover") return first;

  const history: TimedPoint[] = [];
  for (const [t, x, y, , , frame] of trace.samples) {
    if (!frame && policy === "Foresight + hover") continue;
    const cursor = { t, x, y };
    history.push(cursor);
    if (!frame || t < -WINDOW_MS) continue;
    let fires: boolean[];
    if (policy === "Beeline + hover") {
      fires = predictTargetProbabilities(weights, history, rects).map(p => p >= PREFETCH_THRESHOLD);
    } else {
      const predicted = predictForesightPoint(history);
      fires = rects.map(rect => segmentIntersectsRect(cursor, predicted, rect));
    }
    fires.forEach((fire, target) => {
      if (fire && trace.targetLinks![target] === 1 && t < (first.get(target) ?? Infinity)) first.set(target, t);
    });
  }
  return first;
}

/**
 * Function to score one prefetch policy across held-out click windows.
 * @param traces Held-out v2 traces in time order, with samples since the last scroll.
 * @param policy The prefetch policy.
 * @param weights The fitted Beeline weights.
 * @returns Mean milliseconds saved per eligible navigation and the unused prefetch count.
 */
export function scorePolicy(traces: Trace[], policy: Policy, weights: ModelWeights) {
  const firstFetch = new Map<string, number>();
  const used = new Set<string>();
  let savedMs = 0;
  let navigations = 0;
  for (const trace of traces) {
    const keys = trace.targetDestinations!.map(id => `${trace.page}:${id}`);
    for (const [target, time] of firstPrefetches(trace, policy, weights)) {
      const key = keys[target];
      firstFetch.set(key, Math.min(trace.time + time, firstFetch.get(key) ?? Infinity));
    }
    if (trace.targetLinks![trace.clicked] !== 1 || trace.outcome?.navigatedMs === undefined) continue;
    navigations++;
    const key = keys[trace.clicked];
    const start = firstFetch.get(key);
    if (start === undefined || used.has(key)) continue;
    used.add(key);
    savedMs += Math.min(FETCH_MS, trace.time - start);
  }
  if (!navigations) throw new Error("No same-origin navigations on held-out pages.");
  return { savedMsPerNavigation: savedMs / navigations, unused: firstFetch.size - used.size };
}
