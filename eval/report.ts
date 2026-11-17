// Prints the baseline metrics for a JSONL export of traces, as markdown tables.
// Usage: npm run eval -- <traces.jsonl>

import { readFileSync } from "node:fs";
import { BASELINES, isAcquisition, scorePredictor, type Trace } from "./replay.ts";

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

/**
 * Function to print one markdown table of baseline metrics.
 * @param title What the clicks are.
 * @param traces The clicks.
 * @returns Nothing.
 */
function printBaselineTable(title: string, traces: Trace[]): void {
  console.log(`\n### ${title} (${traces.length} clicks)\n`);
  console.log("| predictor | hit rate | lead ms, median (p25-p75) | precision | wasted fires per click |");
  console.log("|---|---|---|---|---|");
  for (const [name, replay] of Object.entries(BASELINES)) {
    const { clicks, hits, fires, leadTimesMs } = scorePredictor(traces, replay);
    const lead = `${Math.round(pickQuantile(leadTimesMs, 0.5))} (${Math.round(pickQuantile(leadTimesMs, 0.25))}-${Math.round(pickQuantile(leadTimesMs, 0.75))})`;
    const percent = (fraction: number) => `${Math.round(fraction * 100)}%`;
    console.log(`| ${name} | ${percent(hits / clicks)} | ${lead} | ${percent(hits / fires)} | ${((fires - hits) / clicks).toFixed(1)} |`);
  }
}

const allTraces: Trace[] = readFileSync(process.argv[2], "utf8")
  .trim()
  .split("\n")
  .map((line) => JSON.parse(line));
// Coalesced samples occasionally arrive a few ms out of order.
for (const trace of allTraces) trace.samples.sort((a, b) => a[0] - b[0]);
const acquisitions = allTraces.filter(isAcquisition);

console.log(`${allTraces.length} traces; ${acquisitions.length} where the cursor moved onto the clicked target.`);
console.log("Lead time is how long before the click the clicked target first fired; it can't exceed the ~1 s of history.");
printBaselineTable("All", acquisitions);

// Size of the clicked target, as a share of the viewport.
const clickedShare = (trace: Trace) => (trace.targets[trace.clicked][2] * trace.targets[trace.clicked][3]) / (trace.viewport[0] * trace.viewport[1]);
printBaselineTable("Small targets (under 0.5% of the viewport, about 80x80 px)", acquisitions.filter((trace) => clickedShare(trace) < 0.005));
printBaselineTable("Medium targets (0.5-5%)", acquisitions.filter((trace) => clickedShare(trace) >= 0.005 && clickedShare(trace) < 0.05));
printBaselineTable("Large targets (5% or more)", acquisitions.filter((trace) => clickedShare(trace) >= 0.05));
