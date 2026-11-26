// Popup: the time prefetching saved, the prefetch switch for the current site and which weights are running; under
// Advanced, the click counts, the overlay and export; and clear.

import type { PersonalModel, TimeSaved } from "./background.ts";

const timeSavedText = document.getElementById("time-saved")!;
const pagesSavedText = document.getElementById("pages-saved")!;

const prefetchCheckbox = document.getElementById("prefetch") as HTMLInputElement;
const prefetchTitleText = document.getElementById("prefetch-title")!;
const prefetchSiteText = document.getElementById("prefetch-site")!;
const prefetchDetailText = document.getElementById("prefetch-detail")!;
const overlayCheckbox = document.getElementById("overlay") as HTMLInputElement;
const overlayOptions = document.getElementById("overlay-options") as HTMLFieldSetElement;
const overlayPredictorSelect = document.getElementById("overlay-predictor") as HTMLSelectElement;
const overlayTargetsSelect = document.getElementById("overlay-targets") as HTMLSelectElement;
const overlayThresholdInput = document.getElementById("overlay-threshold") as HTMLInputElement;
const modelNameText = document.getElementById("model-name")!;
const modelDetailText = document.getElementById("model-detail")!;
const clickCountsText = document.getElementById("click-counts")!;
const exportButton = document.getElementById("export") as HTMLButtonElement;
const clearButton = document.getElementById("clear")!;

/**
 * Function to grey out the overlay options that don't apply: all of them with the overlay off, and the threshold
 * for Foresight, which fires yes or no.
 * @returns Nothing.
 */
function updateOverlayOptionsEnabled(): void {
  overlayOptions.disabled = !overlayCheckbox.checked;
  overlayThresholdInput.disabled = overlayPredictorSelect.value === "foresight";
}

chrome.storage.local.get(["overlay", "overlayPredictor", "overlayTargets", "overlayThreshold"]).then((settings) => {
  overlayCheckbox.checked = settings.overlay === true;
  overlayPredictorSelect.value = (settings.overlayPredictor as string | undefined) ?? "model";
  overlayTargetsSelect.value = (settings.overlayTargets as string | undefined) ?? "firing";
  overlayThresholdInput.value = String((settings.overlayThreshold as number | undefined) ?? 80);
  updateOverlayOptionsEnabled();
});
overlayCheckbox.addEventListener("change", () => {
  chrome.storage.local.set({ overlay: overlayCheckbox.checked });
  updateOverlayOptionsEnabled();
});
overlayPredictorSelect.addEventListener("change", () => {
  chrome.storage.local.set({ overlayPredictor: overlayPredictorSelect.value });
  updateOverlayOptionsEnabled();
});
overlayTargetsSelect.addEventListener("change", () => chrome.storage.local.set({ overlayTargets: overlayTargetsSelect.value }));
overlayThresholdInput.addEventListener("change", () => {
  const thresholdPercent = Math.min(99, Math.max(1, Math.round(overlayThresholdInput.valueAsNumber || 80)));
  overlayThresholdInput.value = String(thresholdPercent);
  chrome.storage.local.set({ overlayThreshold: thresholdPercent });
});

// Prefetch ----------

// The active tab's hostname, readable through activeTab while the popup is open. Pages like chrome:// have none.
let activeHostname: string | undefined;

Promise.all([chrome.tabs.query({ active: true, currentWindow: true }), chrome.storage.local.get("prefetchOffSites")]).then(
  ([[activeTab], { prefetchOffSites = [] }]) => {
    const activeTabUrl = URL.parse(activeTab?.url ?? "");
    activeHostname = activeTabUrl && /^https?:$/.test(activeTabUrl.protocol) ? activeTabUrl.hostname : undefined;
    prefetchTitleText.textContent = activeHostname ? "Prefetch on" : "Prefetch";
    prefetchSiteText.textContent = activeHostname ?? "";
    prefetchSiteText.title = activeHostname ?? "";
    if (!activeHostname) prefetchDetailText.textContent = "Not available on this page";
    prefetchCheckbox.disabled = !activeHostname;
    prefetchCheckbox.checked = !!activeHostname && !(prefetchOffSites as string[]).includes(activeHostname);
  },
);
prefetchCheckbox.addEventListener("change", async () => {
  if (!activeHostname) return;
  const { prefetchOffSites = [] } = await chrome.storage.local.get("prefetchOffSites");
  const otherSites = (prefetchOffSites as string[]).filter((hostname) => hostname !== activeHostname);
  chrome.storage.local.set({ prefetchOffSites: prefetchCheckbox.checked ? otherSites : [...otherSites, activeHostname] });
});

// Model ----------

/**
 * Function to show whether the default or the personal weights are running.
 * @returns Nothing.
 */
async function showModelStatus(): Promise<void> {
  const { personalModel } = (await chrome.storage.local.get("personalModel")) as { personalModel?: PersonalModel };
  modelNameText.textContent = personalModel ? "Running your weights" : "Running default weights";
  modelDetailText.textContent = personalModel ? "Fine-tuned on your clicks, on this device" : "Starts learning how you move after 100 clicks";
}

showModelStatus();
chrome.storage.onChanged.addListener((changes) => changes.personalModel && showModelStatus());

// Traces ----------

/**
 * Function to list the stored trace keys (oldest first) and outcome keys.
 * @returns The trace keys and the outcome keys.
 */
async function getRecordKeys(): Promise<{ traceKeys: string[]; outcomeKeys: string[] }> {
  const keys = await chrome.storage.local.getKeys();
  return { traceKeys: keys.filter((key) => key.startsWith("trace:")).sort(), outcomeKeys: keys.filter((key) => key.startsWith("outcome:")) };
}

const numberFormat = new Intl.NumberFormat("en");
const pluralRules = new Intl.PluralRules("en");

/**
 * Function to write a count with its noun in the singular or plural.
 * @param count The count.
 * @param one The noun for one.
 * @param other The noun for any other count.
 * @returns The formatted count and noun.
 */
function formatCount(count: number, one: string, other: string): string {
  return `${numberFormat.format(count)} ${pluralRules.select(count) === "one" ? one : other}`;
}

let exporting = false;
// Counts the refreshes, so a slow one that finishes after a newer one doesn't overwrite it.
let clickCountsRun = 0;

/**
 * Function to show how many traces are stored, how many have an outcome (so lost outcomes are visible), how many
 * clicks the weights last learned from, and how many usable clicks the next update still needs.
 * @returns Nothing.
 */
async function showClickCounts(): Promise<void> {
  const run = ++clickCountsRun;
  const { traceKeys, outcomeKeys } = await getRecordKeys();
  // Trace keys end in the trace id (v2); an outcome written after its trace was cleared doesn't count.
  const traceKeySuffixes = new Set(traceKeys.map((key) => key.split(":")[2]));
  const joinedOutcomeCount = outcomeKeys.filter((key) => traceKeySuffixes.has(key.slice("outcome:".length))).length;
  const { personalModel, newUsableClickCount = 0 } = (await chrome.storage.local.get(["personalModel", "newUsableClickCount"])) as {
    personalModel?: PersonalModel;
    newUsableClickCount?: number;
  };
  if (run !== clickCountsRun) return;
  const remainingClicks = Math.max(0, 100 - newUsableClickCount);
  clickCountsText.textContent = [
    `${formatCount(traceKeys.length, "trace", "traces")} recorded, ${numberFormat.format(joinedOutcomeCount)} with ${joinedOutcomeCount === 1 ? "an outcome" : "outcomes"}`,
    personalModel && `Last update learned from ${formatCount(personalModel.clickCount, "click", "clicks")}`,
    remainingClicks === 0 ? "Next update is due" : `Next update after ${formatCount(remainingClicks, "more usable click", "more usable clicks")}`,
  ]
    .filter(Boolean)
    .join("\n");
  if (!exporting) exportButton.disabled = traceKeys.length === 0;
}

showClickCounts();
chrome.storage.onChanged.addListener((changes) => {
  if (Object.keys(changes).some((key) => /^(trace|outcome):/.test(key) || key === "personalModel" || key === "newUsableClickCount")) showClickCounts();
});

// Each outcome is joined into its trace as `outcome`; outcomes whose trace is gone are dropped. Read 1,000 traces at a
// time so a large export doesn't hold every record in memory at once.
exportButton.addEventListener("click", async () => {
  exporting = true;
  exportButton.disabled = true;
  exportButton.textContent = "Exporting…";
  try {
    const { traceKeys } = await getRecordKeys();
    const jsonlChunks: string[] = [];
    for (let start = 0; start < traceKeys.length; start += 1000) {
      const chunkKeys = traceKeys.slice(start, start + 1000);
      // Trace keys end in the trace id, which is also the outcome's key.
      const records = await chrome.storage.local.get([...chunkKeys, ...chunkKeys.map((key) => `outcome:${key.split(":")[2]}`)]);
      // A trace can be cleared mid-export.
      const traces = chunkKeys.map((key) => records[key] as { id?: string } | undefined).filter((trace) => trace !== undefined);
      jsonlChunks.push(
        traces
          .map((trace) => {
            const outcome = trace.id === undefined ? undefined : records[`outcome:${trace.id}`];
            return `${JSON.stringify(outcome ? { ...trace, outcome } : trace)}\n`;
          })
          .join(""),
      );
    }
    const link = document.createElement("a");
    link.href = URL.createObjectURL(new Blob(jsonlChunks, { type: "application/jsonl" }));
    link.download = `beeline-traces-${new Date().toISOString().slice(0, 10)}.jsonl`;
    link.click();
    URL.revokeObjectURL(link.href);
  } finally {
    exporting = false;
    exportButton.textContent = "Export traces";
    showClickCounts();
  }
});

// Time saved ----------

/**
 * Function to write a duration the way the popup shows it: milliseconds under 1 s, tenths of a second under 10 s,
 * then seconds, minutes and hours.
 * @param durationMs The duration in ms.
 * @returns The formatted duration.
 */
function formatDuration(durationMs: number): string {
  if (durationMs < 1000) return `${Math.floor(durationMs)} ms`;
  const seconds = durationMs / 1000;
  if (seconds < 10) return `${seconds.toFixed(1)} s`;
  if (seconds < 60) return `${Math.floor(seconds)} s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes} min ${Math.floor(seconds % 60)} s`;
  return `${numberFormat.format(Math.floor(minutes / 60))} h ${minutes % 60} min`;
}

/**
 * Function to show the time prefetching saved and over how many pages.
 * @returns Nothing.
 */
async function showTimeSaved(): Promise<void> {
  const { timeSaved = { savedMs: 0, pageCount: 0 } } = (await chrome.storage.local.get("timeSaved")) as { timeSaved?: TimeSaved };
  timeSavedText.textContent = formatDuration(timeSaved.savedMs);
  pagesSavedText.textContent = formatCount(timeSaved.pageCount, "page", "pages");
}

showTimeSaved();
chrome.storage.onChanged.addListener((changes) => changes.timeSaved && showTimeSaved());

// Clearing takes a second click within 4 s to confirm. It deletes every click, the personal weights learned from them,
// and the time saved.
let clearConfirmTimer: number | undefined;

/**
 * Function to put the clear button back to its first click.
 * @returns Nothing.
 */
function resetClearButton(): void {
  clearTimeout(clearConfirmTimer);
  clearButton.classList.remove("confirming");
  clearButton.textContent = "Clear data";
}

clearButton.addEventListener("click", async () => {
  if (!clearButton.classList.contains("confirming")) {
    clearButton.classList.add("confirming");
    clearButton.textContent = "Click again to delete all data";
    clearConfirmTimer = window.setTimeout(resetClearButton, 4000);
    return;
  }
  resetClearButton();
  const clickKeys = (await chrome.storage.local.getKeys()).filter((key) => /^(trace|outcome|training):/.test(key));
  await chrome.storage.local.remove([...clickKeys, "personalModel", "newUsableClickCount", "timeSaved"]);
});
clearButton.addEventListener("blur", resetClearButton);
