// Fine-tunes the output layer (the output weights and the none option) on the user's own clicks, keeping the hidden
// layer and the input standardisation fixed. Mirrors train/train.py's train(start=..., trainable=["output_weights",
// "none_weights", "none_bias"]): the same snapshots, loss, Adam and weight decay. Pure, so it runs in Node.

import { computeMotionFeatures, computeTargetFeatures, type ModelWeights } from "./model.ts";
import { targetToRect, type Trace } from "./traces.ts";

const SNAPSHOT_WINDOW_MS = 1000;
const SNAPSHOT_STRIDE = 2;
const TRACES_PER_BATCH = 32;
const WEIGHT_DECAY = 1e-4;

export type FineTuneOptions = {
  /** Adam steps, one batch of clicks each. */
  steps?: number;
  learningRate?: number;
  /** Returns a random order of the click indexes, drawn once per pass over the clicks. */
  shuffleIndices?: (count: number) => number[];
};

// Gradient ----------

/** Parameters in one array: the output weights, then the none weights (on standardised motion), then the none bias. */
type OutputLayer = { params: Float64Array; hiddenUnits: number; motionCount: number };

/**
 * Function to add one click's cross-entropy gradient to `gradient`, summed over its snapshots as train.py's
 * build_snapshots and label_snapshots make them: every other sample of the last second, counting back from the last.
 * @param weights The weights whose hidden layer stays fixed.
 * @param targetWeights The hidden layer's target-feature weights, flat: [unit * target features + feature].
 * @param layer The output layer being trained.
 * @param trace The click, with its samples since the last scroll, oldest first.
 * @param gradient Where the gradient is summed.
 * @returns The number of snapshots added.
 */
function addClickGradient(weights: ModelWeights, targetWeights: Float64Array, layer: OutputLayer, trace: Trace, gradient: Float64Array): number {
  const { params, hiddenUnits, motionCount } = layer;
  const history = trace.samples.map(([t, x, y]) => ({ t, x, y }));
  const targetRects = trace.targets.map(targetToRect);
  const hidden = new Float64Array(targetRects.length * hiddenUnits);
  const scores = new Float64Array(targetRects.length + 1);
  const firstTime = Math.min(-SNAPSHOT_WINDOW_MS, history.at(-1)!.t);
  let snapshotCount = 0;
  for (let index = history.length - 1; index >= 0 && history[index].t >= firstTime; index -= SNAPSHOT_STRIDE) {
    snapshotCount++;
    const { motionFeatures, heading } = computeMotionFeatures(history.slice(0, index + 1));
    // The motion part of each unit's activation is the same for every target.
    const motionActivations = Float64Array.from(weights.hiddenWeights.map((unitWeights, unit) =>
      motionFeatures.reduce((sum, feature, featureIndex) => sum + unitWeights[featureIndex] * feature, weights.hiddenBiases[unit]),
    ));
    for (let target = 0; target < targetRects.length; target++) {
      const targetFeatures = computeTargetFeatures(history[index], heading, targetRects[target]);
      const row = target * hiddenUnits;
      const [f0, f1, f2, f3, f4, f5, f6, f7, f8] = targetFeatures;
      let score = 0;
      for (let unit = 0; unit < hiddenUnits; unit++) {
        const w = unit * 9;
        const activation = motionActivations[unit] + targetWeights[w] * f0 + targetWeights[w + 1] * f1 + targetWeights[w + 2] * f2 + targetWeights[w + 3] * f3 + targetWeights[w + 4] * f4 + targetWeights[w + 5] * f5 + targetWeights[w + 6] * f6 + targetWeights[w + 7] * f7 + targetWeights[w + 8] * f8;
        hidden[row + unit] = activation > 0 ? activation : 0;
        score += hidden[row + unit] * params[unit];
      }
      scores[target] = score;
    }
    const standardisedMotion = motionFeatures.map((feature, featureIndex) => (feature - weights.inputMean[featureIndex]) / weights.inputStd[featureIndex]);
    scores[targetRects.length] = standardisedMotion.reduce((sum, feature, featureIndex) => sum + params[hiddenUnits + featureIndex] * feature, params[hiddenUnits + motionCount]);

    // Softmax over the targets and the none option; the gradient of each score is its probability minus the label.
    const label = history[index].t >= -weights.withinMs && trace.clicked !== -1 ? trace.clicked : targetRects.length;
    const maxScore = Math.max(...scores);
    const exponentials = scores.map((score) => Math.exp(score - maxScore));
    const total = exponentials.reduce((sum, value) => sum + value, 0);
    targetRects.forEach((_, target) => {
      const scoreGradient = exponentials[target] / total - (target === label ? 1 : 0);
      const row = target * hiddenUnits;
      for (let unit = 0; unit < hiddenUnits; unit++) gradient[unit] += scoreGradient * hidden[row + unit];
    });
    const noneGradient = exponentials[targetRects.length] / total - (label === targetRects.length ? 1 : 0);
    standardisedMotion.forEach((feature, featureIndex) => (gradient[hiddenUnits + featureIndex] += noneGradient * feature));
    gradient[hiddenUnits + motionCount] += noneGradient;
  }
  return snapshotCount;
}

// Training ----------

/**
 * Function to shuffle the indexes 0 to count - 1 with Math.random.
 * @param count How many indexes.
 * @returns them in a random order.
 */
function shuffleIndicesRandomly(count: number): number[] {
  const indexes = Array.from({ length: count }, (_, index) => index);
  for (let index = count - 1; index > 0; index--) {
    const other = Math.floor(Math.random() * (index + 1));
    [indexes[index], indexes[other]] = [indexes[other], indexes[index]];
  }
  return indexes;
}

/**
 * Function to fine-tune the output layer on the user's clicks with Adam, from a fresh optimizer.
 * @param weights The weights to start from.
 * @param traces The clicks to train on (see `selectTrainingClicks`).
 * @param options Steps, learning rate and shuffle.
 * @returns New weights with the output weights and none option updated.
 */
export function fineTuneOutputLayer(
  weights: ModelWeights,
  traces: Trace[],
  { steps = 300, learningRate = 1e-3, shuffleIndices = shuffleIndicesRandomly }: FineTuneOptions = {},
): ModelWeights {
  const hiddenUnits = weights.hiddenBiases.length;
  const motionCount = weights.noneWeights.length;
  const targetWeights = Float64Array.from(weights.hiddenWeights.flatMap((unitWeights) => unitWeights.slice(motionCount)));
  // The none option trains on standardised motion, as in train.py, so unfold the standardisation from it.
  const motionMean = weights.inputMean.slice(0, motionCount);
  const motionStd = weights.inputStd.slice(0, motionCount);
  const params = Float64Array.from([
    ...weights.outputWeights,
    ...weights.noneWeights.map((weight, index) => weight * motionStd[index]),
    weights.noneBias + weights.noneWeights.reduce((sum, weight, index) => sum + weight * motionMean[index], 0),
  ]);
  const layer = { params, hiddenUnits, motionCount };
  const firstMoment = new Float64Array(params.length);
  const secondMoment = new Float64Array(params.length);

  const batchesPerEpoch = Math.ceil(traces.length / TRACES_PER_BATCH);
  const epochs = Math.ceil(steps / batchesPerEpoch);
  let step = 0;
  for (let epoch = 0; epoch < epochs; epoch++) {
    const order = shuffleIndices(traces.length);
    for (let batchStart = 0; batchStart < order.length && step < steps; batchStart += TRACES_PER_BATCH) {
      // The mean gradient over every snapshot in the batch, plus weight decay, then one Adam step.
      const gradient = new Float64Array(params.length);
      let snapshotCount = 0;
      for (const index of order.slice(batchStart, batchStart + TRACES_PER_BATCH)) {
        snapshotCount += addClickGradient(weights, targetWeights, layer, traces[index], gradient);
      }
      step++;
      for (let index = 0; index < params.length; index++) {
        const decayedGradient = gradient[index] / snapshotCount + WEIGHT_DECAY * params[index];
        firstMoment[index] = 0.9 * firstMoment[index] + 0.1 * decayedGradient;
        secondMoment[index] = 0.999 * secondMoment[index] + 0.001 * decayedGradient ** 2;
        const correctedFirst = firstMoment[index] / (1 - 0.9 ** step);
        const correctedSecond = secondMoment[index] / (1 - 0.999 ** step);
        params[index] -= (learningRate * correctedFirst) / (Math.sqrt(correctedSecond) + 1e-8);
      }
    }
  }

  // Fold the standardisation back into the none option, as train.py's export_weights does.
  const noneWeights = motionStd.map((std, index) => params[hiddenUnits + index] / std);
  return {
    ...weights,
    outputWeights: [...params.subarray(0, hiddenUnits)],
    noneWeights,
    noneBias: params[hiddenUnits + motionCount] - noneWeights.reduce((sum, weight, index) => sum + weight * motionMean[index], 0),
  };
}
