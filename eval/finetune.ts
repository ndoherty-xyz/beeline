// Compare weights on held-out clicks from the user and AdSERP.
// Usage: node eval/finetune.ts <traces.jsonl> <adserp-traces.jsonl> <weights.json>...

import { readFileSync } from "node:fs";
import { basename } from "node:path";
import type { ModelWeights } from "../packages/beeline/src/model.ts";
import {
  computeTopOneAccuracy,
  fetchKeysByDestination,
  isAcquisition,
  isLinkNavigation,
  replayModel,
  samplesSinceLastScroll,
  scoreModelAtForesight,
  type Trace,
} from "./replay.ts";

/**
 * Function to read an export's clicks where the cursor moved onto the target, with samples since the last scroll.
 * @param path The JSONL export.
 * @returns Those clicks.
 */
function readAcquisitions(path: string): Trace[] {
  const traces: Trace[] = readFileSync(path, "utf8")
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line));
  for (const trace of traces) trace.samples = samplesSinceLastScroll(trace).sort((a, b) => a[0] - b[0]);
  return traces.filter(isAcquisition);
}

const [userPath, adserpPath, ...weightsPaths] = process.argv.slice(2);
const userAcquisitions = readAcquisitions(userPath);
const adserpAcquisitions = readAcquisitions(adserpPath);

console.log("| weights | user: precision, all / link navs | user: top-1 at 300 ms | AdSERP: precision | AdSERP: top-1 at 300 ms |");
console.log("|---|---|---|---|---|");
for (const path of weightsPaths) {
  const weights: ModelWeights = JSON.parse(readFileSync(path, "utf8"));
  const replay = (traces: Trace[]) => traces.map((trace) => ({ trace, frames: replayModel(trace, weights) }));
  const userReplays = replay(userAcquisitions.filter((trace) => trace.time > weights.trainedUntil));
  const adserpReplays = replay(adserpAcquisitions.filter((trace) => weights.heldOutPeople.includes(trace.person!)));
  // Precision at Foresight's median lead time.
  const precision = (replays: typeof userReplays, toFetchKeys?: typeof fetchKeysByDestination) => {
    const { score } = scoreModelAtForesight(replays, toFetchKeys).atLead!;
    return `${Math.round((score.hits / score.fires) * 100)}%`;
  };
  const top1 = (replays: typeof userReplays) => {
    const { correct, frames } = computeTopOneAccuracy(replays, 300);
    return `${Math.round((correct / frames) * 100)}%`;
  };
  const linkReplays = userReplays.filter(({ trace }) => isLinkNavigation(trace));
  console.log(
    `| ${basename(path, ".json")} | ${precision(userReplays)} / ${precision(linkReplays, fetchKeysByDestination)} | ${top1(userReplays)} | ${precision(adserpReplays)} | ${top1(adserpReplays)} |`,
  );
}
