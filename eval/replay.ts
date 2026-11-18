// Offline replay: runs recorded traces through the baselines and scores them. Pure, so it runs in Node.

import { predictForesightPoint, segmentIntersectsRect, type Rect, type TimedPoint } from "../src/baselines.ts";
import { predictTargetProbabilities, type ModelWeights } from "../src/model.ts";

/** One recorded click, as stored by the content script (see docs/prd.md, Recording traces). v2 fields are optional. */
export type Trace = {
  time: number;
  device: "mouse" | "trackpad";
  viewport: [number, number];
  /** [ms before click, x, y, predictedX, predictedY, foresightFrame, scrollX, scrollY], oldest first. v1 has no scroll columns. */
  samples: [number, number, number, number, number, 0 | 1, number?, number?][];
  /** [x, y, width, height] of every visible target. */
  targets: [number, number, number, number][];
  /** Index of the clicked target, or -1 when the click hit none. */
  clicked: number;
  /** Whether the clicked element showed a pointer cursor. */
  pointerCursor: boolean;
  version?: 2;
  id?: string;
  page?: string;
  seq?: number;
  sinceLoad?: number;
  dpr?: number;
  click?: [number, number];
  modifiers?: number;
  detail?: number;
  targetIds?: number[];
  targetParents?: number[];
  /** 0 not a link, 1 same-origin, 2 cross-origin, 3 same document, 4 other. */
  targetLinks?: number[];
  targetDestinations?: number[];
  /** Elements that scrolled in the sample window, the page first: [ms before click, scrollLeft, scrollTop] per event. */
  scrollers?: { page: boolean; events: [number, number, number][] }[];
  targetScrollers?: number[][];
  /** Geometry measured on the wheel event before the latest scroll burst; null where not measured. */
  scrollSnapshot?: { t: number; scrollers: ([number, number] | null)[]; targets: (Trace["targets"][number] | null)[] };
  outcome?: Outcome;
};

/** What followed a click, joined in at export. A missing field means unknown. */
export type Outcome = {
  id: string;
  /** [ms after pointerdown, x, y] from pointerdown until pointerup. */
  press: [number, number, number][];
  up?: [number, number, number];
  cancelled?: boolean;
  clicked?: boolean;
  selection?: boolean;
  focusChanged?: boolean;
  navigated?: boolean;
  mutationsBefore?: number;
  mutationsAfter?: number;
};

/** What a predictor expects at one moment: it fires for every target the segment touches. */
export type PredictionSegment = { t: number; from: { x: number; y: number }; to: { x: number; y: number } };

/**
 * Function to convert a trace's [x, y, width, height] target to a rectangle.
 * @param target The recorded target.
 * @returns Its rectangle.
 */
export function targetToRect([x, y, width, height]: Trace["targets"][number]): Rect {
  return { left: x, top: y, right: x + width, bottom: y + height };
}

/**
 * Function to keep only the samples after the last scroll event, which is all v1 recorded. Predictors run on these,
 * since the trajectory no longer lines up with the targets once they move.
 * @param trace The recorded click.
 * @returns Its samples after the last scroll, oldest first.
 */
export function samplesSinceLastScroll(trace: Trace): Trace["samples"] {
  const lastScrollTime = Math.max(...(trace.scrollers ?? []).flatMap((scroller) => scroller.events.map(([t]) => t)));
  return trace.samples.filter(([t]) => t > lastScrollTime);
}

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
 * Function to tell whether the cursor moved onto the clicked target, rather than clicking where it already was
 * (e.g. moving the caret in a text box). Only these clicks have a movement to predict.
 * @param trace The recorded click.
 * @returns True if a target was clicked and the first sample is outside it.
 */
export function isAcquisition(trace: Trace): boolean {
  if (trace.clicked === -1 || trace.samples.length === 0) return false;
  const [, x, y] = trace.samples[0];
  return !segmentIntersectsRect({ x, y }, { x, y }, targetToRect(trace.targets[trace.clicked]));
}

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

/** A predictor's totals over a set of clicks. */
export type PredictorScore = { clicks: number; hits: number; fires: number; leadTimesMs: number[] };

/**
 * Function to score a predictor over clicks: whether the clicked target fired, how early, and how many fires
 * there were in total.
 * @param traces The clicks to score.
 * @param replay The predictor.
 * @returns Its totals.
 */
export function scorePredictor(traces: Trace[], replay: (trace: Trace) => PredictionSegment[]): PredictorScore {
  const score: PredictorScore = { clicks: traces.length, hits: 0, fires: 0, leadTimesMs: [] };
  for (const trace of traces) {
    const firstFires = findFirstFires(trace, replay(trace));
    score.fires += firstFires.size;
    const clickedFire = firstFires.get(trace.clicked);
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
 * @returns The model's totals at that threshold.
 */
export function scoreModelAtThreshold(replays: { trace: Trace; frames: ModelFrame[] }[], threshold: number): PredictorScore {
  const score: PredictorScore = { clicks: replays.length, hits: 0, fires: 0, leadTimesMs: [] };
  for (const { trace, frames } of replays) {
    const fired = new Set<number>();
    for (const { t, probabilities } of frames) {
      probabilities.forEach((probability, target) => {
        if (probability < threshold || fired.has(target)) return;
        fired.add(target);
        if (target === trace.clicked) score.leadTimesMs.push(-t);
      });
    }
    score.fires += fired.size;
    if (fired.has(trace.clicked)) score.hits++;
  }
  return score;
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

const NEAR_MISS_MAX_GAP_MS = 1000;
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
    if (!retry || retry.clicked === -1 || retry.time - miss.time > NEAR_MISS_MAX_GAP_MS) continue;
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
