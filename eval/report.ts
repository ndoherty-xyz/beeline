// Prints the baseline metrics for a JSONL export of traces, as markdown tables.
// Usage: npm run eval -- <traces.jsonl>

import { readFileSync } from "node:fs";
import type { ModelWeights } from "../src/model.ts";
import {
  BASELINES,
  isAcquisition,
  replayForesight,
  replayModel,
  samplesSinceLastScroll,
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
 * @returns Nothing.
 */
function printBaselineTable(title: string, traces: Trace[]): void {
  console.log(`\n### ${title} (${traces.length} clicks)\n`);
  console.log(TABLE_HEADER);
  for (const [name, replay] of Object.entries(BASELINES)) console.log(formatScoreRow(name, scorePredictor(traces, replay)));
}

/**
 * Function to print the baselines and the model on held-out clicks: the model at Foresight's precision and at
 * Foresight's median lead time, and its top-1 accuracy at fixed times before the click.
 * @param title What the clicks are.
 * @param replays The clicks with the model's frames.
 * @returns Nothing.
 */
function printModelTable(title: string, replays: { trace: Trace; frames: ModelFrame[] }[]): void {
  const traces = replays.map(({ trace }) => trace);
  printBaselineTable(title, traces);
  const foresight = scorePredictor(traces, replayForesight);
  const modelScores = Array.from({ length: 99 }, (_, index) => (index + 1) / 100).map((threshold) => ({
    threshold,
    score: scoreModelAtThreshold(replays, threshold),
  }));
  const atPrecision = modelScores.find(({ score }) => score.hits / score.fires >= foresight.hits / foresight.fires);
  const atLead = modelScores.findLast(({ score }) => pickQuantile(score.leadTimesMs, 0.5) >= pickQuantile(foresight.leadTimesMs, 0.5));
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
 * @param replays The clicks with the model's frames.
 * @returns Nothing.
 */
function printModelThresholdSweep(replays: { trace: Trace; frames: ModelFrame[] }[]): void {
  console.log(`\n### Model by threshold, all held out (${replays.length} clicks)\n`);
  console.log(TABLE_HEADER);
  for (const threshold of [0.1, 0.2, 0.3, 0.4, 0.5, 0.6, 0.7, 0.8]) {
    console.log(formatScoreRow(`model, p ≥ ${threshold}`, scoreModelAtThreshold(replays, threshold)));
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

const weights: ModelWeights = JSON.parse(readFileSync(new URL("../src/model-weights.json", import.meta.url), "utf8"));
const heldOutReplays = acquisitions
  .filter((trace) => trace.time > weights.trainedUntil)
  .map((trace) => ({ trace, frames: replayModel(trace, weights) }));
console.log(`\n## Model on clicks held out from training (after ${new Date(weights.trainedUntil).toISOString()})`);
printModelTable("All held out", heldOutReplays);
printModelThresholdSweep(heldOutReplays);
printModelTable("Small held out", heldOutReplays.filter(({ trace }) => clickedShare(trace) < 0.005));
printModelTable("Medium held out", heldOutReplays.filter(({ trace }) => clickedShare(trace) >= 0.005 && clickedShare(trace) < 0.05));
printModelTable("Large held out", heldOutReplays.filter(({ trace }) => clickedShare(trace) >= 0.05));
