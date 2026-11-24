// Prints the baseline metrics for a JSONL export of traces, as markdown tables.
// Usage: npm run eval -- <traces.jsonl> [weights.json, default src/model-weights.json]

import { readFileSync } from "node:fs";
import type { ModelWeights } from "../src/model.ts";
import {
  BASELINES,
  fetchKeysByDestination,
  fetchKeysByTarget,
  findEmptyClicksWithoutRetry,
  isAcquisition,
  isLinkNavigation,
  replayForesight,
  replayModel,
  samplesSinceLastScroll,
  targetToRect,
  scoreModelAtThreshold,
  scorePredictor,
  type ModelFrame,
  type PredictorScore,
  type Trace,
} from "./replay.ts";

/**
 * Function to pick a value at a quantile of a list.
 * @param values The values.
 * @param quantile Between 0 and 1.
 * @returns The value at that quantile, or NaN for an empty list.
 */
function pickQuantile(values: number[], quantile: number): number {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * quantile))] ?? NaN;
}

// Assumed costs, to turn lead time and wasted fires into time saved and bandwidth spent.
// How long a page takes to arrive once requested: a fast site, a typical one, a slow one.
const FETCH_TIMES_MS = [150, 400, 1000];
// Rough medians: a page's HTML for a prefetch, the whole page for a prerender.
const PREFETCH_KB = 30;
const PRERENDER_KB = 2000;

const TABLE_HEADER = `| predictor | hit rate | lead ms, median (p25-p75) | precision | wasted fires per click | ms saved per click at ${FETCH_TIMES_MS.join(" / ")} ms fetch | wasted per click, prefetch / prerender |
|---|---|---|---|---|---|---|`;

/**
 * Function to format a size in KB, switching to MB from 1000 KB.
 * @param kilobytes The size.
 * @returns The formatted size.
 */
function formatKilobytes(kilobytes: number): string {
  return kilobytes >= 1000 ? `${(kilobytes / 1000).toFixed(1)} MB` : `${Math.round(kilobytes)} KB`;
}

/**
 * Function to format one predictor's totals as a markdown table row.
 * @param name The predictor.
 * @param score Its totals.
 * @returns The row.
 */
function formatScoreRow(name: string, { clicks, hits, fires, leadTimesMs }: PredictorScore): string {
  const lead = `${Math.round(pickQuantile(leadTimesMs, 0.5))} (${Math.round(pickQuantile(leadTimesMs, 0.25))}-${Math.round(pickQuantile(leadTimesMs, 0.75))})`;
  const percent = (fraction: number) => `${Math.round(fraction * 100)}%`;
  const wastedPerClick = (fires - hits) / clicks;
  // A hit saves its lead time, up to the whole fetch; a click whose target never fired saves nothing.
  const msSaved = FETCH_TIMES_MS.map((fetchMs) => Math.round(leadTimesMs.reduce((sum, lead) => sum + Math.min(lead, fetchMs), 0) / clicks));
  const wasted = `${formatKilobytes(wastedPerClick * PREFETCH_KB)} / ${formatKilobytes(wastedPerClick * PRERENDER_KB)}`;
  return `| ${name} | ${percent(hits / clicks)} | ${lead} | ${percent(hits / fires)} | ${wastedPerClick.toFixed(1)} | ${msSaved.join(" / ")} | ${wasted} |`;
}

/**
 * Function to print one markdown table of baseline metrics.
 * @param title What the clicks are.
 * @param traces The clicks.
 * @param toFetchKeys Which targets share a fetch (-1: never fetched).
 * @returns Nothing.
 */
function printBaselineTable(title: string, traces: Trace[], toFetchKeys = fetchKeysByTarget): void {
  console.log(`\n### ${title} (${traces.length} clicks)\n`);
  console.log(TABLE_HEADER);
  for (const [name, replay] of Object.entries(BASELINES)) console.log(formatScoreRow(name, scorePredictor(traces, replay, toFetchKeys)));
}

/**
 * Function to print the baselines and the model on held-out clicks: the model at Foresight's precision and at
 * Foresight's median lead time, and its top-1 accuracy at fixed times before the click.
 * @param title What the clicks are.
 * @param replays The clicks with the model's frames.
 * @param toFetchKeys Which targets share a fetch (-1: never fetched).
 * @returns Nothing.
 */
function printModelTable(title: string, replays: { trace: Trace; frames: ModelFrame[] }[], toFetchKeys = fetchKeysByTarget): void {
  const traces = replays.map(({ trace }) => trace);
  printBaselineTable(title, traces, toFetchKeys);
  const foresight = scorePredictor(traces, replayForesight, toFetchKeys);
  const modelScores = Array.from({ length: 99 }, (_, index) => (index + 1) / 100).map((threshold) => ({
    threshold,
    score: scoreModelAtThreshold(replays, threshold, toFetchKeys),
  }));
  const atPrecision = modelScores.find(({ score }) => score.hits / score.fires >= foresight.hits / foresight.fires);
  // Lead isn't monotonic at high thresholds, where a few clicks fire, so stop at the first that falls short.
  const firstShortOfLead = modelScores.findIndex(({ score }) => !(pickQuantile(score.leadTimesMs, 0.5) >= pickQuantile(foresight.leadTimesMs, 0.5)));
  const atLead = modelScores[(firstShortOfLead === -1 ? modelScores.length : firstShortOfLead) - 1];
  if (atPrecision) console.log(formatScoreRow(`model, p ≥ ${atPrecision.threshold} (Foresight's precision)`, atPrecision.score));
  if (atLead) console.log(formatScoreRow(`model, p ≥ ${atLead.threshold} (Foresight's lead)`, atLead.score));

  const top1 = [300, 200, 100].map((msBefore) => {
    const frames = replays.flatMap(({ trace, frames }) => {
      const frame = frames.findLast(({ t }) => t <= -msBefore);
      return frame ? [{ trace, probabilities: frame.probabilities }] : [];
    });
    const correct = frames.filter(({ trace, probabilities }) => probabilities.indexOf(Math.max(...probabilities)) === trace.clicked);
    return `${msBefore} ms ${Math.round((correct.length / frames.length) * 100)}% (${frames.length})`;
  });
  console.log(`\nModel top-1 before the click (clicks with a frame by then): ${top1.join(", ")}`);
}

/**
 * Function to print the model at a spread of thresholds, to show what each operating point saves and costs.
 * @param title What the clicks are.
 * @param replays The clicks with the model's frames.
 * @param toFetchKeys Which targets share a fetch (-1: never fetched).
 * @returns Nothing.
 */
function printModelThresholdSweep(title: string, replays: { trace: Trace; frames: ModelFrame[] }[], toFetchKeys = fetchKeysByTarget): void {
  console.log(`\n### Model by threshold, ${title} (${replays.length} clicks)\n`);
  console.log(TABLE_HEADER);
  for (const threshold of [0.1, 0.2, 0.3, 0.4, 0.5, 0.6, 0.7, 0.8]) {
    console.log(formatScoreRow(`model, p ≥ ${threshold}`, scoreModelAtThreshold(replays, threshold, toFetchKeys)));
  }
}

const allTraces: Trace[] = readFileSync(process.argv[2], "utf8")
  .trim()
  .split("\n")
  .map((line) => JSON.parse(line));
// Coalesced samples occasionally arrive a few ms out of order. Predictors only see samples since the last scroll.
for (const trace of allTraces) trace.samples = samplesSinceLastScroll(trace).sort((a, b) => a[0] - b[0]);
const acquisitions = allTraces.filter(isAcquisition);

console.log(`${allTraces.length} traces; ${acquisitions.length} where the cursor moved onto the clicked target.`);
console.log("Lead time is how long before the click the clicked target first fired; it can't exceed the ~1 s of history.");
console.log(`Saved and wasted assume each fire prefetches ${PREFETCH_KB} KB of HTML or prerenders a ${PRERENDER_KB / 1000} MB page.`);
printBaselineTable("All", acquisitions);

// Size of the clicked target, as a share of the viewport.
const clickedShare = (trace: Trace) => (trace.targets[trace.clicked][2] * trace.targets[trace.clicked][3]) / (trace.viewport[0] * trace.viewport[1]);
printBaselineTable("Small targets (under 0.5% of the viewport, about 80x80 px)", acquisitions.filter((trace) => clickedShare(trace) < 0.005));
printBaselineTable("Medium targets (0.5-5%)", acquisitions.filter((trace) => clickedShare(trace) >= 0.005 && clickedShare(trace) < 0.05));
printBaselineTable("Large targets (5% or more)", acquisitions.filter((trace) => clickedShare(trace) >= 0.05));

// Model ----------

const weights: ModelWeights = JSON.parse(readFileSync(process.argv[3] ?? new URL("../src/model-weights.json", import.meta.url), "utf8"));
// The recorder's own clicks after training, or every click by a held-out person from another dataset.
const isHeldOut = (trace: Trace) => trace.time > weights.trainedUntil || weights.heldOutPeople.includes(trace.person!);
const heldOutReplays = acquisitions
  .filter(isHeldOut)
  .map((trace) => ({ trace, frames: replayModel(trace, weights) }));
console.log(`\n## Model on clicks held out from training (after ${new Date(weights.trainedUntil).toISOString()}, and ${weights.heldOutPeople.length} held-out people)`);
printModelTable("All held out", heldOutReplays);
printModelThresholdSweep("all held out", heldOutReplays);
printModelTable("Small held out", heldOutReplays.filter(({ trace }) => clickedShare(trace) < 0.005));
printModelTable("Medium held out", heldOutReplays.filter(({ trace }) => clickedShare(trace) >= 0.005 && clickedShare(trace) < 0.05));
printModelTable("Large held out", heldOutReplays.filter(({ trace }) => clickedShare(trace) >= 0.05));

// Link navigations ----------

// What prefetching would see: only clicks on http links that navigated, and only links fire, with links to the
// same destination sharing one fetch.
const linkNavigationReplays = heldOutReplays.filter(({ trace }) => isLinkNavigation(trace));
console.log("\n## Link navigations held out: only links fire, one fetch per destination");
printModelTable("Link navigations held out", linkNavigationReplays, fetchKeysByDestination);
printModelThresholdSweep("link navigations held out", linkNavigationReplays, fetchKeysByDestination);

// Click within T ms ----------

// What a public `p` should mean: the chance this target is clicked within WITHIN_MS. Every recorded window ends in a
// click, so true rates here are far above everyday use, where most movement clicks nothing.
const WITHIN_MS = weights.withinMs;
const heldOutEmptyReplays = findEmptyClicksWithoutRetry(allTraces)
  .filter(isHeldOut)
  .map((trace) => ({ trace, frames: replayModel(trace, weights) }));
console.log(`\n## Click within ${WITHIN_MS} ms, held out (${heldOutReplays.length} clicks on targets, ${heldOutEmptyReplays.length} on nothing)`);
console.log(`Each frame and target is one prediction; it's right if that target was clicked within ${WITHIN_MS} ms.\n`);

const BIN_EDGES = [0, 0.05, 0.1, 0.2, 0.3, 0.4, 0.5, 0.6, 0.7, 0.8, 0.9, 1.0001];
const bins = BIN_EDGES.slice(1).map(() => ({ predictions: 0, probabilitySum: 0, clicked: 0 }));
let logLoss = 0;
let predictionCount = 0;
for (const { trace, frames } of [...heldOutReplays, ...heldOutEmptyReplays]) {
  for (const { t, probabilities } of frames) {
    probabilities.forEach((probability, target) => {
      const clicked = target === trace.clicked && t >= -WITHIN_MS;
      const bin = bins[BIN_EDGES.findIndex((edge) => probability < edge) - 1];
      bin.predictions++;
      bin.probabilitySum += probability;
      if (clicked) bin.clicked++;
      logLoss -= Math.log(Math.min(1 - 1e-7, Math.max(1e-7, clicked ? probability : 1 - probability)));
      predictionCount++;
    });
  }
}
// Over predictions of 0.05 and up: the near-zero majority would dilute it to nothing.
const confidentBins = bins.slice(1);
const calibrationError =
  confidentBins.reduce((sum, { probabilitySum, clicked }) => sum + Math.abs(probabilitySum - clicked), 0) /
  confidentBins.reduce((sum, { predictions }) => sum + predictions, 0);
console.log(`| p | predictions | mean p | clicked within ${WITHIN_MS} ms |\n|---|---|---|---|`);
bins.forEach(({ predictions, probabilitySum, clicked }, index) => {
  if (predictions === 0) return;
  const range = `${BIN_EDGES[index]}-${Math.min(1, BIN_EDGES[index + 1])}`;
  console.log(`| ${range} | ${predictions} | ${(probabilitySum / predictions).toFixed(3)} | ${(clicked / predictions).toFixed(3)} |`);
});
console.log(`\nLog loss per prediction ${(logLoss / predictionCount).toFixed(4)}; mean gap between p and the true rate for p ≥ 0.05: ${calibrationError.toFixed(3)}.`);

// False alarms: p ≥ 0.5 where nothing is about to be clicked. A lone target is what a page with one button looks like.
const reachesHalf = (frames: { probabilities: number[] }[], target: number) => frames.some(({ probabilities }) => probabilities[target] >= 0.5);
const percentOf = (count: number, total: number) => `${Math.round((count / total) * 100)}%`;
const emptyFalseAlarms = heldOutEmptyReplays.filter(({ trace, frames }) => trace.targets.some((_, target) => reachesHalf(frames, target)));
// The unclicked target nearest the click, alone on the page: the hardest distractor.
const loneDistractorFalseAlarms = heldOutReplays.filter(({ trace }) => {
  const [, x, y] = trace.samples[trace.samples.length - 1];
  const distanceTo = (target: Trace["targets"][number]) => {
    const { left, top, right, bottom } = targetToRect(target);
    return Math.hypot(Math.max(left - x, 0, x - right), Math.max(top - y, 0, y - bottom));
  };
  const distractors = trace.targets.map((target, index) => ({ index, distance: distanceTo(target) })).filter(({ index }) => index !== trace.clicked);
  if (distractors.length === 0) return false;
  const nearest = distractors.reduce((best, candidate) => (candidate.distance < best.distance ? candidate : best));
  return reachesHalf(replayModel({ ...trace, targets: [trace.targets[nearest.index]] }, weights), 0);
});
// The clicked target alone: how high it reads early, and close to the click.
const loneClickedFrames = heldOutReplays.flatMap(({ trace }) => replayModel({ ...trace, targets: [trace.targets[trace.clicked]] }, weights));
const meanP = (frames: ModelFrame[]) => (frames.reduce((sum, { probabilities }) => sum + probabilities[0], 0) / frames.length).toFixed(2);
console.log(`\n| false alarm check | clicks | reached p ≥ 0.5 |\n|---|---|---|`);
console.log(`| click on nothing, any target | ${heldOutEmptyReplays.length} | ${percentOf(emptyFalseAlarms.length, heldOutEmptyReplays.length)} |`);
console.log(`| nearest unclicked target, alone on the page | ${heldOutReplays.length} | ${percentOf(loneDistractorFalseAlarms.length, heldOutReplays.length)} |`);
console.log(`\nClicked target alone on the page, mean p: ${meanP(loneClickedFrames.filter(({ t }) => t < -WITHIN_MS))} more than ${WITHIN_MS} ms before the click, ${meanP(loneClickedFrames.filter(({ t }) => t >= -WITHIN_MS))} within it.`);
