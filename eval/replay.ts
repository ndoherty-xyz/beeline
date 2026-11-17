// Offline replay: runs recorded traces through the baselines and scores them. Pure, so it runs in Node.

import { predictForesightPoint, segmentIntersectsRect, type Rect, type TimedPoint } from "../src/baselines.ts";

/** One recorded click, as stored by the content script (see docs/prd.md, Recording traces). */
export type Trace = {
  time: number;
  device: "mouse" | "trackpad";
  viewport: [number, number];
  /** [ms before click, x, y, predictedX, predictedY, foresightFrame], oldest first. */
  samples: [number, number, number, number, number, 0 | 1][];
  /** [x, y, width, height] of every visible target. */
  targets: [number, number, number, number][];
  /** Index of the clicked target, or -1 when the click hit none. */
  clicked: number;
  /** Whether the clicked element showed a pointer cursor. */
  pointerCursor: boolean;
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
