// Fine-tunes every weight of the model on the user's clicks, keeping the input standardisation fixed. Mirrors
// train/train.py's train(start=..., steps=...): the same snapshots, loss, Adam and weight decay. Pure, so it runs in
// Node.

import { computeMotionFeatures, computeTargetFeatures, type ModelWeights } from "./model.ts";
import { targetToRect, type Trace } from "./traces.ts";

const SNAPSHOT_WINDOW_MS = 1000;
const SNAPSHOT_STRIDE = 2;
const TARGET_FEATURE_COUNT = 9;
const TRACES_PER_BATCH = 32;
const WEIGHT_DECAY = 1e-4;
// Standardised features kept between batches, about 45 KB per click; clicks past it are re-measured each time they're
// drawn.
const FEATURE_CACHE_BYTES = 64 * 2 ** 20;

export type FineTuneOptions = {
  /** Adam steps, one batch of clicks each. */
  steps?: number;
  learningRate?: number;
  /** Returns an order of the click indexes, drawn once per pass over the clicks. By default a fixed-seed shuffle, so the
   * same clicks always give the same weights. */
  shuffleIndices?: (count: number) => number[];
};

// Snapshots ----------

/** One snapshot of a click, standardised and rounded to float32 as train.py's inputs are. */
type Snapshot = { motionFeatures: Float32Array; targetFeatures: Float32Array; label: number };

/**
 * Function to measure every snapshot of one click (train.py's build_snapshots), standardised.
 * @param weights The weights, for their standardisation and `withinMs`.
 * @param trace The click, with its samples since the last scroll, oldest first.
 * @returns Its snapshots, newest first; a label of the target count means the none option.
 */
function measureSnapshots(weights: ModelWeights, trace: Trace): Snapshot[] {
  const motionCount = weights.noneWeights.length;
  const standardise = (feature: number, index: number) => (Math.fround(feature) - weights.inputMean[index]) / weights.inputStd[index];
  const history = trace.samples.map(([t, x, y]) => ({ t, x, y }));
  const targetRects = trace.targets.map(targetToRect);
  const firstTime = Math.min(-SNAPSHOT_WINDOW_MS, history.at(-1)!.t);
  const snapshots: Snapshot[] = [];
  for (let index = history.length - 1; index >= 0 && history[index].t >= firstTime; index -= SNAPSHOT_STRIDE) {
    const { motionFeatures, heading } = computeMotionFeatures(history.slice(0, index + 1));
    const targetFeatures = new Float32Array(targetRects.length * TARGET_FEATURE_COUNT);
    targetRects.forEach((rect, target) => {
      computeTargetFeatures(history[index], heading, rect).forEach((feature, featureIndex) => {
        targetFeatures[target * TARGET_FEATURE_COUNT + featureIndex] = standardise(feature, motionCount + featureIndex);
      });
    });
    const label = history[index].t >= -weights.withinMs && trace.clicked !== -1 ? trace.clicked : targetRects.length;
    snapshots.push({ motionFeatures: Float32Array.from(motionFeatures, standardise), targetFeatures, label });
  }
  return snapshots;
}

/**
 * Function to make a shuffle with a fixed seed (mulberry32), so a retried update gives the same weights.
 * @returns A function that returns the indexes 0 to count - 1 in a pseudo-random order, a new one each call.
 */
function createSeededShuffle(): (count: number) => number[] {
  let state = 0;
  return (count) => {
    const indexes = Array.from({ length: count }, (_, index) => index);
    for (let index = count - 1; index > 0; index--) {
      state = (state + 0x6d2b79f5) | 0;
      let mixed = Math.imul(state ^ (state >>> 15), 1 | state);
      mixed = (mixed + Math.imul(mixed ^ (mixed >>> 7), 61 | mixed)) ^ mixed;
      const other = Math.floor((((mixed ^ (mixed >>> 14)) >>> 0) / 2 ** 32) * (index + 1));
      [indexes[index], indexes[other]] = [indexes[other], indexes[index]];
    }
    return indexes;
  };
}

// Training ----------

/** Where each group of standardised parameters starts in one array: each unit's input weights, then the hidden biases,
 * the output weights, the none weights and the none bias. */
type ParamLayout = {
  hiddenUnits: number;
  motionCount: number;
  featureCount: number;
  biasStart: number;
  outputStart: number;
  noneStart: number;
  noneBiasIndex: number;
};

/**
 * Function to add one snapshot's cross-entropy gradient to `gradient`.
 * @param params The standardised parameters, laid out as `ParamLayout` says.
 * @param layout Where each group of parameters starts.
 * @param snapshot The snapshot.
 * @param gradient Where the gradient is summed.
 * @returns Nothing.
 */
function addSnapshotGradient(params: Float64Array, layout: ParamLayout, snapshot: Snapshot, gradient: Float64Array): void {
  const { hiddenUnits, motionCount, featureCount, biasStart, outputStart, noneStart, noneBiasIndex } = layout;
  const { motionFeatures, targetFeatures, label } = snapshot;
  const motionActivations = new Float64Array(hiddenUnits);
  const motionGradients = new Float64Array(hiddenUnits);
  const targetCount = targetFeatures.length / TARGET_FEATURE_COUNT;
  const activations = new Float64Array(targetCount * hiddenUnits);
  const scores = new Float64Array(targetCount + 1);

  // Forward: the motion part of each unit's activation is the same for every target.
  for (let unit = 0; unit < hiddenUnits; unit++) {
    let activation = params[biasStart + unit];
    for (let feature = 0; feature < motionCount; feature++) activation += params[unit * featureCount + feature] * motionFeatures[feature];
    motionActivations[unit] = activation;
  }
  let noneScore = params[noneBiasIndex];
  for (let feature = 0; feature < motionCount; feature++) noneScore += params[noneStart + feature] * motionFeatures[feature];
  scores[targetCount] = noneScore;
  let maxScore = noneScore;
  for (let target = 0; target < targetCount; target++) {
    let score = 0;
    for (let unit = 0; unit < hiddenUnits; unit++) {
      let activation = motionActivations[unit];
      const weightStart = unit * featureCount + motionCount;
      for (let feature = 0; feature < TARGET_FEATURE_COUNT; feature++) {
        activation += params[weightStart + feature] * targetFeatures[target * TARGET_FEATURE_COUNT + feature];
      }
      activations[target * hiddenUnits + unit] = activation > 0 ? activation : 0;
      score += activations[target * hiddenUnits + unit] * params[outputStart + unit];
    }
    scores[target] = score;
    if (score > maxScore) maxScore = score;
  }
  let total = 0;
  for (let index = 0; index <= targetCount; index++) total += scores[index] = Math.exp(scores[index] - maxScore);

  // Backward: each score's gradient is its probability minus the label.
  const noneGradient = scores[targetCount] / total - (label === targetCount ? 1 : 0);
  gradient[noneBiasIndex] += noneGradient;
  for (let feature = 0; feature < motionCount; feature++) gradient[noneStart + feature] += noneGradient * motionFeatures[feature];
  for (let target = 0; target < targetCount; target++) {
    const scoreGradient = scores[target] / total - (target === label ? 1 : 0);
    for (let unit = 0; unit < hiddenUnits; unit++) {
      const activation = activations[target * hiddenUnits + unit];
      if (activation <= 0) continue;
      gradient[outputStart + unit] += scoreGradient * activation;
      const unitGradient = scoreGradient * params[outputStart + unit];
      motionGradients[unit] += unitGradient;
      const weightStart = unit * featureCount + motionCount;
      for (let feature = 0; feature < TARGET_FEATURE_COUNT; feature++) {
        gradient[weightStart + feature] += unitGradient * targetFeatures[target * TARGET_FEATURE_COUNT + feature];
      }
    }
  }
  for (let unit = 0; unit < hiddenUnits; unit++) {
    gradient[biasStart + unit] += motionGradients[unit];
    for (let feature = 0; feature < motionCount; feature++) gradient[unit * featureCount + feature] += motionGradients[unit] * motionFeatures[feature];
  }
}

/**
 * Function to fine-tune every weight on the user's clicks with Adam, from a fresh optimizer, keeping the input
 * standardisation the weights were trained with. Works for any number of hidden units.
 * @param weights The weights to start from.
 * @param traces The clicks to train on (see `selectTrainingClicks`).
 * @param options Steps, learning rate and shuffle.
 * @returns New weights.
 */
export function fineTune(weights: ModelWeights, traces: Trace[], options: FineTuneOptions = {}): ModelWeights {
  if (!traces.length) return weights;
  const hiddenUnits = weights.hiddenBiases.length;
  const motionCount = weights.noneWeights.length;
  const featureCount = motionCount + TARGET_FEATURE_COUNT;
  const { inputMean, inputStd } = weights;

  // Unfold the standardisation, as train.py trains on standardised inputs.
  const biasStart = hiddenUnits * featureCount;
  const outputStart = biasStart + hiddenUnits;
  const noneStart = outputStart + hiddenUnits;
  const noneBiasIndex = noneStart + motionCount;
  const params = new Float64Array(noneBiasIndex + 1);
  const layout = { hiddenUnits, motionCount, featureCount, biasStart, outputStart, noneStart, noneBiasIndex };
  weights.hiddenWeights.forEach((unitWeights, unit) => {
    params[biasStart + unit] = weights.hiddenBiases[unit];
    unitWeights.forEach((weight, feature) => {
      params[unit * featureCount + feature] = weight * inputStd[feature];
      params[biasStart + unit] += weight * inputMean[feature];
    });
    params[outputStart + unit] = weights.outputWeights[unit];
  });
  params[noneBiasIndex] = weights.noneBias;
  weights.noneWeights.forEach((weight, feature) => {
    params[noneStart + feature] = weight * inputStd[feature];
    params[noneBiasIndex] += weight * inputMean[feature];
  });

  // Snapshots of the first clicks drawn, up to the cache size; the rest are measured each time they're drawn.
  const cachedSnapshots = new Map<number, Snapshot[]>();
  let cachedBytes = 0;

  // Adam on the mean gradient plus weight decay, as train.py's train(steps=...) does.
  const { steps = 300, learningRate = 1e-3, shuffleIndices = createSeededShuffle() } = options;
  const firstMoments = new Float64Array(params.length);
  const secondMoments = new Float64Array(params.length);
  const gradient = new Float64Array(params.length);
  let step = 0;
  while (step < steps) {
    const order = shuffleIndices(traces.length);
    if (order.length !== traces.length) throw new Error("Expected one shuffle index per training click.");
    for (let batchStart = 0; batchStart < order.length && step < steps; batchStart += TRACES_PER_BATCH) {
      gradient.fill(0);
      let snapshotCount = 0;
      for (const clickIndex of order.slice(batchStart, batchStart + TRACES_PER_BATCH)) {
        let snapshots = cachedSnapshots.get(clickIndex);
        if (!snapshots) {
          snapshots = measureSnapshots(weights, traces[clickIndex]);
          const bytes = snapshots.reduce((sum, { targetFeatures }) => sum + 4 * (motionCount + targetFeatures.length), 0);
          if (cachedBytes + bytes <= FEATURE_CACHE_BYTES) {
            cachedSnapshots.set(clickIndex, snapshots);
            cachedBytes += bytes;
          }
        }
        for (const snapshot of snapshots) addSnapshotGradient(params, layout, snapshot, gradient);
        snapshotCount += snapshots.length;
      }
      step++;
      for (let index = 0; index < params.length; index++) {
        const decayedGradient = gradient[index] / snapshotCount + WEIGHT_DECAY * params[index];
        firstMoments[index] = 0.9 * firstMoments[index] + 0.1 * decayedGradient;
        secondMoments[index] = 0.999 * secondMoments[index] + 0.001 * decayedGradient ** 2;
        const correctedFirst = firstMoments[index] / (1 - 0.9 ** step);
        const correctedSecond = secondMoments[index] / (1 - 0.999 ** step);
        params[index] -= (learningRate * correctedFirst) / (Math.sqrt(correctedSecond) + 1e-8);
      }
    }
  }

  // Fold the standardisation back in, as train.py's export_weights does.
  const hiddenWeights = weights.hiddenWeights.map((unitWeights, unit) => unitWeights.map((_, feature) => params[unit * featureCount + feature] / inputStd[feature]));
  const noneWeights = weights.noneWeights.map((_, feature) => params[noneStart + feature] / inputStd[feature]);
  return {
    ...weights,
    hiddenWeights,
    hiddenBiases: hiddenWeights.map((unitWeights, unit) => unitWeights.reduce((bias, weight, feature) => bias - weight * inputMean[feature], params[biasStart + unit])),
    outputWeights: [...params.subarray(outputStart, noneStart)],
    noneWeights,
    noneBias: noneWeights.reduce((bias, weight, feature) => bias - weight * inputMean[feature], params[noneBiasIndex]),
  };
}
