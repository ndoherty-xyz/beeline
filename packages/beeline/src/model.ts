// The learned target predictor: one small MLP scores every target from cursor-motion and target features, and a
// softmax over the targets plus a "no click within `withinMs`" option, scored from the motion alone, gives each
// target's chance of being clicked within that time. Pure, so traces can be replayed through it in Node.
// Trained in train/ (Python); train/beeline_model.py mirrors the features and scoring here exactly.

/** A cursor position in client coordinates, with a `performance.now()` timestamp in ms. */
export type TimedPoint = { t: number; x: number; y: number };

/** A viewport rectangle. A `DOMRect` satisfies it. */
export type Rect = { left: number; top: number; right: number; bottom: number };

/** Trained weights, as exported by train/train.py. Feature standardisation is folded into the hidden layer. */
export type ModelWeights = {
  /** People in other datasets (a trace's `person`) whose traces were all held out. */
  heldOutPeople: string[];
  /** One row of input weights per hidden unit. */
  hiddenWeights: number[][];
  hiddenBiases: number[];
  outputWeights: number[];
  /** Probabilities are each target's chance of a click within this many ms. */
  withinMs: number;
  /** The none option's score: a linear function of the motion features. */
  noneWeights: number[];
  noneBias: number;
  /** The feature standardisation the weights were trained with (already folded in above), for fine-tuning. */
  inputMean: number[];
  inputStd: number[];
};

// Features ----------

/** Pointer events stop while the cursor is still, so a gap this long between samples means it stopped. */
const STILL_GAP_MS = 40;

/**
 * Function to find the newest sample that is at least `ageMs` older than the current one.
 * @param history Cursor samples, oldest first; the last is the current one.
 * @param ageMs How far back to look.
 * @returns That sample, or the oldest one when the history is shorter.
 */
function findSampleAgo(history: TimedPoint[], ageMs: number): TimedPoint {
  const current = history[history.length - 1];
  for (let index = history.length - 1; index >= 0; index--) {
    if (history[index].t <= current.t - ageMs) return history[index];
  }
  return history[0];
}

/**
 * Function to describe the cursor's recent motion, and the heading that the target features are measured along.
 * @param history Cursor samples, oldest first; the last is the current one.
 * @returns The motion features and the unit heading.
 */
export function computeMotionFeatures(history: TimedPoint[]): { motionFeatures: number[]; heading: { x: number; y: number } } {
  const current = history[history.length - 1];
  const at50 = findSampleAgo(history, 50);
  const at150 = findSampleAgo(history, 150);
  const at400 = findSampleAgo(history, 400);
  const recentX = current.x - at50.x;
  const recentY = current.y - at50.y;
  const earlierX = at50.x - at150.x;
  const earlierY = at50.y - at150.y;
  const recentLength = Math.hypot(recentX, recentY);
  const earlierLength = Math.hypot(earlierX, earlierY);
  const longerLength = Math.hypot(current.x - at400.x, current.y - at400.y);

  // Heading: the last 50 ms of movement, else the last 400 ms, else arbitrary (the speed features say it's still).
  let heading = { x: 1, y: 0 };
  if (recentLength > 0) heading = { x: recentX / recentLength, y: recentY / recentLength };
  else if (longerLength > 0) heading = { x: (current.x - at400.x) / longerLength, y: (current.y - at400.y) / longerLength };

  // Turn from the earlier 100 ms to the last 50 ms, as cos and signed sin.
  let turnCos = 1;
  let turnSin = 0;
  if (recentLength > 0 && earlierLength > 0) {
    turnCos = (earlierX * recentX + earlierY * recentY) / (earlierLength * recentLength);
    turnSin = (earlierX * recentY - earlierY * recentX) / (earlierLength * recentLength);
  }

  // The movement started after the last pause, or before the history begins.
  let onsetIndex = history.length - 1;
  while (onsetIndex > 0 && history[onsetIndex].t - history[onsetIndex - 1].t <= STILL_GAP_MS) onsetIndex--;

  const motionFeatures = [
    Math.log1p(recentLength / 50),
    Math.log1p(earlierLength / 100),
    turnCos,
    turnSin,
    Math.log1p(longerLength),
    Math.log1p(current.t - history[onsetIndex].t),
  ];
  return { motionFeatures, heading };
}

/**
 * Function to describe one target relative to the cursor, in the frame of the cursor's heading.
 * @param cursor The current cursor position.
 * @param heading The unit heading from `computeMotionFeatures`.
 * @param rect The target's rectangle.
 * @returns The target features.
 */
export function computeTargetFeatures(cursor: { x: number; y: number }, heading: { x: number; y: number }, rect: Rect): number[] {
  const nearestDistance = Math.hypot(
    Math.min(Math.max(cursor.x, rect.left), rect.right) - cursor.x,
    Math.min(Math.max(cursor.y, rect.top), rect.bottom) - cursor.y,
  );
  const centerX = (rect.left + rect.right) / 2 - cursor.x;
  const centerY = (rect.top + rect.bottom) / 2 - cursor.y;
  const centerDistance = Math.hypot(centerX, centerY);
  const centerAlong = centerX * heading.x + centerY * heading.y;
  const centerAcross = centerY * heading.x - centerX * heading.y;

  // Project the corners onto the heading line and across it.
  let minAcross = Infinity;
  let maxAcross = -Infinity;
  let maxAlong = -Infinity;
  for (const cornerX of [rect.left - cursor.x, rect.right - cursor.x]) {
    for (const cornerY of [rect.top - cursor.y, rect.bottom - cursor.y]) {
      const across = cornerY * heading.x - cornerX * heading.y;
      minAcross = Math.min(minAcross, across);
      maxAcross = Math.max(maxAcross, across);
      maxAlong = Math.max(maxAlong, cornerX * heading.x + cornerY * heading.y);
    }
  }
  // How far the heading line passes beside the target, and how far the target lies behind the cursor.
  const lateralGap = Math.max(0, minAcross, -maxAcross);
  const behindGap = Math.max(0, -maxAlong);

  return [
    Math.log1p(nearestDistance),
    nearestDistance === 0 ? 1 : 0,
    centerAlong / (centerDistance + 1),
    centerAcross / (centerDistance + 1),
    Math.log1p(centerDistance),
    Math.log1p(lateralGap),
    Math.log1p(behindGap),
    Math.log1p(rect.right - rect.left),
    Math.log1p(rect.bottom - rect.top),
  ];
}

// Scoring ----------

/**
 * Function to score every target; higher means more likely to be clicked.
 * @param weights The trained weights.
 * @param history Cursor samples, oldest first; the last is the current one.
 * @param targetRects The visible targets.
 * @returns One score (a logit) per target.
 */
export function scoreTargets(weights: ModelWeights, history: TimedPoint[], targetRects: Rect[]): number[] {
  const { motionFeatures, heading } = computeMotionFeatures(history);
  const cursor = history[history.length - 1];
  return targetRects.map((rect) => {
    const features = motionFeatures.concat(computeTargetFeatures(cursor, heading, rect));
    let score = 0;
    weights.hiddenWeights.forEach((unitWeights, unit) => {
      let activation = weights.hiddenBiases[unit];
      for (let index = 0; index < features.length; index++) activation += unitWeights[index] * features[index];
      if (activation > 0) score += weights.outputWeights[unit] * activation;
    });
    return score;
  });
}

/**
 * Function to predict each target's chance of being clicked within `weights.withinMs`.
 * @param weights The trained weights.
 * @param history Cursor samples, oldest first; the last is the current one.
 * @param targetRects The visible targets.
 * @returns One probability per target; they sum to less than 1, the rest being no click by then.
 */
export function predictTargetProbabilities(weights: ModelWeights, history: TimedPoint[], targetRects: Rect[]): number[] {
  const scores = scoreTargets(weights, history, targetRects);
  const { motionFeatures } = computeMotionFeatures(history);
  scores.push(motionFeatures.reduce((sum, feature, index) => sum + weights.noneWeights[index] * feature, weights.noneBias));
  const maxScore = Math.max(...scores);
  const exponentials = scores.map((score) => Math.exp(score - maxScore));
  const total = exponentials.reduce((sum, value) => sum + value, 0);
  return exponentials.slice(0, targetRects.length).map((value) => value / total);
}
