// Background service worker: fine-tunes the model's output layer on the user's own clicks, from 100 clicks on and again
// every 100 new ones, and stores the result for the content script to run. One update takes about 30 s at 2,500 clicks.

import { fineTuneOutputLayer, selectTrainingClicks, type ModelWeights, type Trace } from "beeline";
import defaultWeights from "beeline/default-weights.json";

/** The personal weights, how many clicks they were last fine-tuned on, and the time of the newest of those clicks. */
export type PersonalModel = { weights: ModelWeights; clickCount: number; learnedUntil: number };

const CLICKS_PER_UPDATE = 100;

let updating = false;

/**
 * Function to fine-tune the personal weights (or the default, the first time) on every stored click, once there are
 * 100 clicks they haven't learned from.
 * @returns Nothing.
 */
async function fineTuneIfDue(): Promise<void> {
  if (updating) return;
  updating = true;
  try {
    const { personalModel } = (await chrome.storage.local.get("personalModel")) as { personalModel?: PersonalModel };
    const learnedUntil = personalModel?.learnedUntil ?? -Infinity;
    // Keys are `trace:<time>:<id>`, or `training:<time>:<id>` while recording is off, so new clicks can be counted
    // before loading any.
    const traceKeys = (await chrome.storage.local.getKeys()).filter((key) => /^(trace|training):/.test(key));
    if (traceKeys.filter((key) => Number(key.split(":")[1]) > learnedUntil).length < CLICKS_PER_UPDATE) return;
    const trainingClicks = selectTrainingClicks(Object.values(await chrome.storage.local.get(traceKeys)) as Trace[]);
    const newClickTimes = trainingClicks.map((trace) => trace.time).filter((time) => time > learnedUntil);
    if (newClickTimes.length < CLICKS_PER_UPDATE) return;
    const weights = fineTuneOutputLayer(personalModel?.weights ?? (defaultWeights as ModelWeights), trainingClicks);
    const updatedModel: PersonalModel = { weights, clickCount: trainingClicks.length, learnedUntil: Math.max(...newClickTimes) };
    await chrome.storage.local.set({ personalModel: updatedModel });
  } finally {
    updating = false;
  }
}

fineTuneIfDue();
chrome.storage.onChanged.addListener((changes, areaName) => {
  if (areaName === "local" && Object.keys(changes).some((key) => /^(trace|training):/.test(key))) fineTuneIfDue();
});
