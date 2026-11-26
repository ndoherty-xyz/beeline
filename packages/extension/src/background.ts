// Background service worker: fine-tunes the model's output layer on the user's own clicks, from 100 clicks on and again
// every 100 new ones, and stores the result for the content script to run. One update takes about 30 s at 2,500 clicks.
// Also adds up the time prefetching saved, timing each prefetch request.

import { fineTuneOutputLayer, selectTrainingClicks, type ModelWeights, type Trace } from "beeline";
import defaultWeights from "beeline/default-weights.json";

/** The personal weights, how many clicks they were last fine-tuned on, and the time of the newest of those clicks. */
export type PersonalModel = { weights: ModelWeights; clickCount: number; learnedUntil: number };

/** The time prefetching saved, and over how many pages. */
export type TimeSaved = { savedMs: number; pageCount: number };

/** How long a prefetched page still waited for its server after the click, sent by the content script. */
export type PrefetchedPageWait = { waitMs: number };

// Fine-tuning ----------

const CLICKS_PER_UPDATE = 100;

/**
 * Function to add new clicks to the stored count of usable clicks the weights haven't learned from, and once it
 * reaches 100, fine-tune the personal weights (or the default, the first time) on every stored click.
 * @param newTraces The clicks just stored.
 * @returns Nothing.
 */
async function countClicksAndFineTune(newTraces: Trace[]): Promise<void> {
  const { personalModel, newUsableClickCount } = (await chrome.storage.local.get(["personalModel", "newUsableClickCount"])) as {
    personalModel?: PersonalModel;
    newUsableClickCount?: number;
  };
  const learnedUntil = personalModel?.learnedUntil ?? -Infinity;
  // A click on nothing counts here before the next click shows whether it was retried, so the count can run a little
  // high; loading every click below sets it exactly.
  if (newUsableClickCount !== undefined) {
    const usableClickCount = newUsableClickCount + selectTrainingClicks(newTraces.filter((trace) => trace.time > learnedUntil)).length;
    if (usableClickCount < CLICKS_PER_UPDATE) {
      if (usableClickCount !== newUsableClickCount) await chrome.storage.local.set({ newUsableClickCount: usableClickCount });
      return;
    }
  }
  const traceKeys = (await chrome.storage.local.getKeys()).filter((key) => /^(trace|training):/.test(key));
  const trainingClicks = selectTrainingClicks(Object.values(await chrome.storage.local.get(traceKeys)) as Trace[]);
  const newClickTimes = trainingClicks.map((trace) => trace.time).filter((time) => time > learnedUntil);
  if (newClickTimes.length < CLICKS_PER_UPDATE) {
    await chrome.storage.local.set({ newUsableClickCount: newClickTimes.length });
    return;
  }
  const weights = fineTuneOutputLayer(personalModel?.weights ?? (defaultWeights as ModelWeights), trainingClicks);
  const updatedModel: PersonalModel = { weights, clickCount: trainingClicks.length, learnedUntil: Math.max(...newClickTimes) };
  await chrome.storage.local.set({ personalModel: updatedModel, newUsableClickCount: 0 });
}

// One storage update at a time, in the order they arrive, so the click count and the time saved never lose one.
let storageWork = countClicksAndFineTune([]);
chrome.storage.onChanged.addListener((changes, areaName) => {
  if (areaName !== "local") return;
  const newTraces = Object.entries(changes)
    .filter(([key, change]) => /^(trace|training):/.test(key) && change.newValue)
    .map(([, change]) => change.newValue as Trace);
  if (newTraces.length > 0) storageWork = storageWork.catch(console.error).then(() => countClicksAndFineTune(newTraces));
});

// Time saved ----------

// When each prefetch request started, by request id, until its response starts.
const prefetchStartTimes = new Map<string, number>();
// How long each prefetch took to its first response byte, by tab and URL, until the page is opened. Held in memory
// only, so prefetches the worker forgets after it stops just don't count.
const prefetchDurations = new Map<string, number>();

chrome.webRequest.onSendHeaders.addListener(
  ({ requestId, timeStamp, requestHeaders }) => {
    if (requestHeaders?.some(({ name, value }) => name.toLowerCase() === "sec-purpose" && value?.startsWith("prefetch"))) {
      prefetchStartTimes.set(requestId, timeStamp);
    }
  },
  { urls: ["<all_urls>"], types: ["main_frame"] },
  ["requestHeaders", "extraHeaders"],
);
chrome.webRequest.onResponseStarted.addListener(
  ({ requestId, timeStamp, tabId, url }) => {
    const startTime = prefetchStartTimes.get(requestId);
    if (startTime === undefined) return;
    prefetchStartTimes.delete(requestId);
    prefetchDurations.set(`${tabId} ${url.split("#")[0]}`, timeStamp - startTime);
  },
  { urls: ["<all_urls>"], types: ["main_frame"] },
);

/**
 * Function to add a prefetched page to the time saved: how long its prefetch took, minus what the page still waited.
 * @param pageWait What the page still waited after the click.
 * @param prefetchKey The page's tab and URL.
 * @returns Nothing.
 */
async function addTimeSaved({ waitMs }: PrefetchedPageWait, prefetchKey: string): Promise<void> {
  const prefetchMs = prefetchDurations.get(prefetchKey);
  if (prefetchMs === undefined) return;
  prefetchDurations.delete(prefetchKey);
  const { timeSaved = { savedMs: 0, pageCount: 0 } } = (await chrome.storage.local.get("timeSaved")) as { timeSaved?: TimeSaved };
  const savedMs = timeSaved.savedMs + Math.max(0, prefetchMs - waitMs);
  await chrome.storage.local.set({ timeSaved: { savedMs, pageCount: timeSaved.pageCount + 1 } });
}

chrome.runtime.onMessage.addListener((pageWait: PrefetchedPageWait, sender) => {
  const prefetchKey = `${sender.tab?.id} ${sender.url?.split("#")[0]}`;
  storageWork = storageWork.catch(console.error).then(() => addTimeSaved(pageWait, prefetchKey));
});
