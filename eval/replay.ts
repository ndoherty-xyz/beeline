// Offline replay: runs recorded traces through the baselines and scores them. Pure, so it runs in Node.

import { predictForesightPoint, segmentIntersectsRect, type Rect, type TimedPoint } from "../packages/extension/src/baselines.ts";
import { predictTargetProbabilities, type ModelWeights } from "../packages/beeline/src/model.ts";
import {
  findEmptyClicksWithoutRetry,
  isAcquisition,
  RETRY_GAP_MS,
  samplesSinceLastScroll,
  targetToRect,
  type Outcome,
  type Trace,
} from "../packages/beeline/src/traces.ts";

export { findEmptyClicksWithoutRetry, isAcquisition, samplesSinceLastScroll, targetToRect, type Outcome, type Trace };

/** What a predictor expects at one moment: it fires for every target the segment touches. */
export type PredictionSegment = { t: number; from: { x: number; y: number }; to: { x: number; y: number } };

// Predictors ----------

/**
 * Function to replay hover: a target fires when a sample lands inside it.
 * @param trace The recorded click.
 * @returns One zero-length segment per sample.
 */
export function replayHover(trace: Trace): PredictionSegment[] {
  return trace.samples.map(([t, x, y]) => ({ t, from: { x, y }, to: { x, y } }));
}

/**
 * Function to replay Chrome's `getPredictedEvents`: a target fires when the line to the predicted point touches it.
 * @param trace The recorded click.
 * @returns One segment per sample, from the cursor to Chrome's farthest predicted point.
 */
export function replayChromePrediction(trace: Trace): PredictionSegment[] {
  return trace.samples.map(([t, x, y, predictedX, predictedY]) => ({ t, from: { x, y }, to: { x: predictedX, y: predictedY } }));
}

/**
 * Function to replay Foresight on the samples it would have processed, one per animation frame.
 * @param trace The recorded click.
 * @returns One segment per Foresight frame, from the cursor to Foresight's predicted point.
 */
export function replayForesight(trace: Trace): PredictionSegment[] {
  const frames: TimedPoint[] = trace.samples.filter((sample) => sample[5] === 1).map(([t, x, y]) => ({ t, x, y }));
  return frames.map((cursor, index) => ({ t: cursor.t, from: cursor, to: predictForesightPoint(frames.slice(0, index + 1)) }));
}

export const BASELINES = {
  hover: replayHover,
  getPredictedEvents: replayChromePrediction,
  foresight: replayForesight,
};

// Scoring ----------

/**
 * Function to find when each target first fired, treating each first fire as one prefetch.
 * @param trace The recorded click.
 * @param segments The predictor's segments, oldest first.
 * @returns Target index to the time it first fired, in ms before the click.
 */
export function findFirstFires(trace: Trace, segments: PredictionSegment[]): Map<number, number> {
  const targetRects = trace.targets.map(targetToRect);
  const firstFires = new Map<number, number>();
  for (const { t, from, to } of segments) {
    targetRects.forEach((rect, index) => {
      if (!firstFires.has(index) && segmentIntersectsRect(from, to, rect)) firstFires.set(index, t);
    });
  }
  return firstFires;
}

/**
 * Function to give each target its own fetch, so every target that fires counts once.
 * @param trace The recorded click.
 * @returns One key per target: its index.
 */
export function fetchKeysByTarget(trace: Trace): number[] {
  return trace.targets.map((_, index) => index);
}

/**
 * Function to key targets by what a prefetch would fetch: http links by destination, so links to the same page
 * share one fetch, and -1 for everything else, which can't be prefetched.
 * @param trace A v2 recorded click.
 * @returns One key per target: its destination id, or -1.
 */
export function fetchKeysByDestination(trace: Trace): number[] {
  return trace.targetLinks!.map((link, index) => (link === 1 || link === 2 ? trace.targetDestinations![index] : -1));
}

/**
 * Function to tell whether a click followed an http link and the page navigated: the clicks a prefetch could speed up.
 * @param trace The recorded click.
 * @returns True for a v2 click on a same- or cross-origin link that navigated.
 */
export function isLinkNavigation(trace: Trace): boolean {
  const link = trace.targetLinks?.[trace.clicked];
  return (link === 1 || link === 2) && trace.outcome?.navigatedMs !== undefined;
}

/** A predictor's totals over a set of clicks. */
export type PredictorScore = { clicks: number; hits: number; fires: number; leadTimesMs: number[] };

/**
 * Function to score a predictor over clicks: whether the clicked target's fetch fired, how early, and how many
 * fetches fired in total.
 * @param traces The clicks to score.
 * @param replay The predictor.
 * @param toFetchKeys Which targets share a fetch (-1: never fetched); by default each target is its own.
 * @returns Its totals.
 */
export function scorePredictor(
  traces: Trace[],
  replay: (trace: Trace) => PredictionSegment[],
  toFetchKeys: (trace: Trace) => number[] = fetchKeysByTarget,
): PredictorScore {
  const score: PredictorScore = { clicks: traces.length, hits: 0, fires: 0, leadTimesMs: [] };
  for (const trace of traces) {
    const fetchKeys = toFetchKeys(trace);
    // Each fetch fires when the first of its targets does.
    const fetchFires = new Map<number, number>();
    for (const [target, t] of findFirstFires(trace, replay(trace))) {
      const key = fetchKeys[target];
      if (key !== -1) fetchFires.set(key, Math.min(t, fetchFires.get(key) ?? t));
    }
    score.fires += fetchFires.size;
    const clickedFire = fetchFires.get(fetchKeys[trace.clicked]);
    if (clickedFire === undefined) continue;
    score.hits++;
    score.leadTimesMs.push(-clickedFire);
  }
  return score;
}

// Model ----------

/** The model's probability for every target at one Foresight frame. */
export type ModelFrame = { t: number; probabilities: number[] };

/**
 * Function to replay the model on the same frames Foresight processes, each seeing every sample up to it.
 * @param trace The recorded click.
 * @param weights The trained weights.
 * @returns One set of probabilities per frame, oldest first.
 */
export function replayModel(trace: Trace, weights: ModelWeights): ModelFrame[] {
  const history: TimedPoint[] = trace.samples.map(([t, x, y]) => ({ t, x, y }));
  const targetRects = trace.targets.map(targetToRect);
  return trace.samples.flatMap((sample, index) =>
    sample[5] === 1 ? [{ t: sample[0], probabilities: predictTargetProbabilities(weights, history.slice(0, index + 1), targetRects) }] : [],
  );
}

/**
 * Function to score the model like a yes/no predictor: a target fires the first time its probability reaches the
 * threshold.
 * @param replays Each click with its model frames.
 * @param threshold The probability that fires a target.
 * @param toFetchKeys Which targets share a fetch (-1: never fetched); by default each target is its own.
 * @returns The model's totals at that threshold.
 */
export function scoreModelAtThreshold(
  replays: { trace: Trace; frames: ModelFrame[] }[],
  threshold: number,
  toFetchKeys: (trace: Trace) => number[] = fetchKeysByTarget,
): PredictorScore {
  const score: PredictorScore = { clicks: replays.length, hits: 0, fires: 0, leadTimesMs: [] };
  for (const { trace, frames } of replays) {
    const fetchKeys = toFetchKeys(trace);
    const clickedKey = fetchKeys[trace.clicked];
    const fired = new Set<number>();
    for (const { t, probabilities } of frames) {
      probabilities.forEach((probability, target) => {
        const key = fetchKeys[target];
        if (key === -1 || probability < threshold || fired.has(key)) return;
        fired.add(key);
        if (key === clickedKey) score.leadTimesMs.push(-t);
      });
    }
    score.fires += fired.size;
    if (fired.has(clickedKey)) score.hits++;
  }
  return score;
}

/**
 * Function to pick a value at a quantile of a list.
 * @param values The values.
 * @param quantile Between 0 and 1.
 * @returns The value at that quantile, or NaN for an empty list.
 */
export function pickQuantile(values: number[], quantile: number): number {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * quantile))] ?? NaN;
}

/**
 * Function to score the model at the thresholds that match Foresight on the same clicks: the lowest that reaches
 * Foresight's precision, and the highest that keeps Foresight's median lead time.
 * @param replays Each click with its model frames.
 * @param toFetchKeys Which targets share a fetch (-1: never fetched).
 * @returns The two thresholds with the model's totals there, either missing if none qualifies.
 */
export function scoreModelAtForesight(replays: { trace: Trace; frames: ModelFrame[] }[], toFetchKeys = fetchKeysByTarget) {
  const foresight = scorePredictor(
    replays.map(({ trace }) => trace),
    replayForesight,
    toFetchKeys,
  );
  const modelScores = Array.from({ length: 99 }, (_, index) => (index + 1) / 100).map((threshold) => ({
    threshold,
    score: scoreModelAtThreshold(replays, threshold, toFetchKeys),
  }));
  const atPrecision = modelScores.find(({ score }) => score.hits / score.fires >= foresight.hits / foresight.fires);
  // Lead isn't monotonic at high thresholds, where a few clicks fire, so stop at the first that falls short.
  const firstShortOfLead = modelScores.findIndex(({ score }) => !(pickQuantile(score.leadTimesMs, 0.5) >= pickQuantile(foresight.leadTimesMs, 0.5)));
  const atLead = modelScores[(firstShortOfLead === -1 ? modelScores.length : firstShortOfLead) - 1];
  return { foresight, atPrecision, atLead };
}

/**
 * Function to count how often the model's most likely target is the clicked one at a time before the click.
 * @param replays Each click with its model frames.
 * @param msBefore How long before the click.
 * @returns Clicks with a frame by then, and how many of those had the clicked target on top.
 */
export function computeTopOneAccuracy(replays: { trace: Trace; frames: ModelFrame[] }[], msBefore: number): { frames: number; correct: number } {
  const frames = replays.flatMap(({ trace, frames }) => {
    const frame = frames.findLast(({ t }) => t <= -msBefore);
    return frame ? [{ trace, probabilities: frame.probabilities }] : [];
  });
  const correct = frames.filter(({ trace, probabilities }) => probabilities.indexOf(Math.max(...probabilities)) === trace.clicked);
  return { frames: frames.length, correct: correct.length };
}

// Near misses ----------

/** A click on empty space followed by a click on a nearby target, measured on that target's rect at the miss. */
export type NearMiss = {
  miss: Trace;
  retry: Trace;
  /** Index of the retried target in the miss trace. */
  target: number;
  /** How far the click was outside the target, in CSS px: dx < 0 left of it, dy < 0 above it, 0 within its span. */
  dx: number;
  dy: number;
  distance: number;
};

const NEAR_MISS_MAX_DISTANCE_PX = 40;

/**
 * Function to pair each v2 click on empty space with the next click on the same page, when that click hits a target
 * within a second and the target was close to the miss. The labels are proxies: a nearby retry isn't proof of intent.
 * @param traces The recorded clicks.
 * @returns The near misses, and how many retries were skipped because their target's id wasn't in the miss trace.
 */
export function findNearMisses(traces: Trace[]): { nearMisses: NearMiss[]; unmatchedRetries: number } {
  const traceById = new Map(traces.filter((trace) => trace.id).map((trace) => [trace.id!, trace]));
  const nearMisses: NearMiss[] = [];
  let unmatchedRetries = 0;
  for (const miss of traces) {
    if (miss.version !== 2 || miss.clicked !== -1 || miss.pointerCursor) continue;
    const retry = traceById.get(`${miss.page}-${miss.seq! + 1}`);
    if (!retry || retry.clicked === -1 || retry.time - miss.time > RETRY_GAP_MS) continue;
    const target = miss.targetIds!.indexOf(retry.targetIds![retry.clicked]);
    if (target === -1) {
      unmatchedRetries++;
      continue;
    }
    const { left, top, right, bottom } = targetToRect(miss.targets[target]);
    const [x, y] = miss.click!;
    const dx = x < left ? x - left : x > right ? x - right : 0;
    const dy = y < top ? y - top : y > bottom ? y - bottom : 0;
    const distance = Math.hypot(dx, dy);
    if (distance <= NEAR_MISS_MAX_DISTANCE_PX) nearMisses.push({ miss, retry, target, dx, dy, distance });
  }
  return { nearMisses, unmatchedRetries };
}

