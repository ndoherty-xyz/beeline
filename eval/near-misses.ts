// Prints near misses in a JSONL export of v2 traces: how far and which way they missed, what the miss did, and how
// much the cursor moved during the press. Usage: npm run near-misses -- <traces.jsonl>

import { readFileSync } from "node:fs";
import { findNearMisses, type Trace } from "./replay.ts";

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
 * Function to format the median and p90 of a list.
 * @param values The values.
 * @returns "median (p90)", rounded to one decimal place.
 */
function formatMedianAndP90(values: number[]): string {
  return `${pickQuantile(values, 0.5).toFixed(1)} (${pickQuantile(values, 0.9).toFixed(1)})`;
}

/**
 * Function to measure how far the cursor moved between pointerdown and pointerup.
 * @param trace A recorded click with its outcome.
 * @returns The distance in CSS px, or undefined when pointerup wasn't seen.
 */
function measurePressMovement(trace: Trace): number | undefined {
  const up = trace.outcome?.up;
  return up && Math.hypot(up[1] - trace.click![0], up[2] - trace.click![1]);
}

const traces: Trace[] = readFileSync(process.argv[2], "utf8")
  .trim()
  .split("\n")
  .map((line) => JSON.parse(line));
const v2Traces = traces.filter((trace) => trace.version === 2);
const { nearMisses, unmatchedRetries } = findNearMisses(v2Traces);
const nearMissIds = new Set(nearMisses.map(({ miss }) => miss.id));
const otherEmptyClicks = v2Traces.filter((trace) => trace.clicked === -1 && !trace.pointerCursor && !nearMissIds.has(trace.id));
const targetClicks = v2Traces.filter((trace) => trace.clicked !== -1);

console.log(`${v2Traces.length} v2 traces (of ${traces.length}); ${v2Traces.filter((trace) => trace.outcome).length} with outcomes.`);
console.log(`${nearMisses.length} near misses, ${otherEmptyClicks.length} other empty-space clicks, ${unmatchedRetries} retries skipped (target id not in the miss trace).`);
console.log("A near miss is a proxy label: an empty-space click followed within 1 s by a click on a target within 40 px.\n");

console.log("| device | near misses | distance px, median (p90) | above | below | side only | caught by 4 / 8 / 12 px slop |");
console.log("|---|---|---|---|---|---|---|");
for (const device of ["mouse", "trackpad"]) {
  const deviceMisses = nearMisses.filter(({ miss }) => miss.device === device);
  if (deviceMisses.length === 0) continue;
  const distances = deviceMisses.map(({ distance }) => distance);
  const caught = [4, 8, 12].map((slopPx) => distances.filter((distance) => distance <= slopPx).length).join(" / ");
  const above = deviceMisses.filter(({ dy }) => dy < 0).length;
  const below = deviceMisses.filter(({ dy }) => dy > 0).length;
  const sideOnly = deviceMisses.filter(({ dx, dy }) => dx !== 0 && dy === 0).length;
  console.log(`| ${device} | ${deviceMisses.length} | ${formatMedianAndP90(distances)} | ${above} | ${below} | ${sideOnly} | ${caught} |`);
}

console.log("\nWhat followed each click (share of clicks with a complete outcome):\n");
console.log("| clicks | with outcome | click event | selection | focus changed | navigated | mutations after, median |");
console.log("|---|---|---|---|---|---|---|");
for (const [name, group] of [
  ["near misses", nearMisses.map(({ miss }) => miss)],
  ["other empty space", otherEmptyClicks],
  ["on a target", targetClicks],
] as const) {
  const outcomes = group.map((trace) => trace.outcome).filter((outcome) => outcome?.mutationsAfter !== undefined);
  const share = (key: "clicked" | "selection" | "focusChanged" | "navigatedMs") =>
    `${Math.round((outcomes.filter((outcome) => outcome![key] !== undefined && outcome![key] !== false).length / outcomes.length) * 100)}%`;
  const mutationsAfter = outcomes.map((outcome) => outcome!.mutationsAfter!);
  console.log(`| ${name} | ${outcomes.length} of ${group.length} | ${share("clicked")} | ${share("selection")} | ${share("focusChanged")} | ${share("navigatedMs")} | ${pickQuantile(mutationsAfter, 0.5)} |`);
}

console.log("\nCursor movement during the press, pointerdown to pointerup, px median (p90):\n");
console.log("| device | near misses | clicks on a target |");
console.log("|---|---|---|");
for (const device of ["mouse", "trackpad"]) {
  const missMovement = nearMisses.filter(({ miss }) => miss.device === device).flatMap(({ miss }) => measurePressMovement(miss) ?? []);
  const targetMovement = targetClicks.filter((trace) => trace.device === device).flatMap((trace) => measurePressMovement(trace) ?? []);
  if (missMovement.length + targetMovement.length === 0) continue;
  console.log(`| ${device} | ${formatMedianAndP90(missMovement)} | ${formatMedianAndP90(targetMovement)} |`);
}
