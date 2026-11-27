// Usage: npm run eval -- <export.jsonl> [fitted-weights.json]
import { readFileSync } from "node:fs";
import defaultWeights from "../packages/beeline/src/default-weights.json" with { type: "json" };
import { fineTune } from "../packages/beeline/src/finetune.ts";
import type { ModelWeights } from "../packages/beeline/src/model.ts";
import { selectTrainingClicks, samplesSinceLastScroll, type Trace } from "../packages/beeline/src/traces.ts";
import { CLICKS_PER_UPDATE } from "../packages/extension/src/personal-model.ts";
import { scorePolicy, type Policy } from "./helpers/replay.ts";

const [tracePath, weightsPath] = process.argv.slice(2);
if (!tracePath) throw new Error("Usage: npm run eval -- <export.jsonl> [fitted-weights.json]");
const traces: Trace[] = readFileSync(tracePath, "utf8").trim().split(/\r?\n/).filter(Boolean).map(line => JSON.parse(line));
const usable = selectTrainingClicks(traces);
const acquisitions = usable.filter(trace => trace.clicked !== -1);
const split = Math.round(acquisitions.length * 0.8);
const cutoff = acquisitions[split - 1]?.time;
const training = usable.filter(trace => trace.time <= cutoff).slice(0, CLICKS_PER_UPDATE);
if (training.length < CLICKS_PER_UPDATE) throw new Error("Need 100 usable clicks before the held-out split.");
const trainingPages = new Set(training.map(trace => trace.page));
const holdout = traces.filter(trace => trace.version === 2 && trace.time > cutoff && !trainingPages.has(trace.page))
  .sort((a, b) => a.time - b.time);
for (const trace of holdout) trace.samples = samplesSinceLastScroll(trace).sort((a, b) => a[0] - b[0]);

const weights: ModelWeights = weightsPath ? JSON.parse(readFileSync(weightsPath, "utf8")) : fineTune(defaultWeights, training);
const policies: Policy[] = ["Hover", "Beeline + hover", "Foresight + hover"];
const results = policies.map(policy => ({ policy, ...scorePolicy(holdout, policy, weights) }));
const foresightUnused = results.find(row => row.policy === "Foresight + hover")!.unused;
console.log("| Policy | Estimated wait saved per navigation | Unused prefetches (% of Foresight) |");
console.log("|---|---:|---:|");
for (const { policy, savedMsPerNavigation, unused } of results) {
  const share = foresightUnused ? `${Math.round(100 * unused / foresightUnused)}%` : "n/a";
  console.log(`| ${policy} | ${Math.round(savedMsPerNavigation)} ms | ${unused} (${share}) |`);
}
