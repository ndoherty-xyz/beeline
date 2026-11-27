// Popup: the prefetch switch for the current site, the time prefetching saved (with the last 10 pages charted) and
// which weights are running; under Advanced, the overlay, export and reset.

import { CLICKS_PER_UPDATE, type PersonalModel } from "./personal-model.ts";
import type { TimeSaved } from "./background.ts";

const timeSavedText = document.getElementById("time-saved")!;

const recentChart = document.getElementById("recent-chart")!;
const chartCaptionText = document.getElementById("chart-caption")!;
const chartAverageText = document.getElementById("chart-average")!;

const prefetchToggle = document.getElementById("prefetch-toggle") as HTMLButtonElement;
const prefetchStateText = document.getElementById("prefetch-state")!;
const prefetchSiteText = document.getElementById("prefetch-site")!;
const overlayCheckbox = document.getElementById("overlay") as HTMLInputElement;
const overlayOptions = document.getElementById("overlay-options") as HTMLFieldSetElement;
const overlayPredictorSelect = document.getElementById("overlay-predictor") as HTMLSelectElement;
const overlayTargetsSelect = document.getElementById("overlay-targets") as HTMLSelectElement;
const overlayThresholdInput = document.getElementById("overlay-threshold") as HTMLInputElement;
const modelCard = document.getElementById("model-card")!;
const modelNameText = document.getElementById("model-name")!;
const modelDetailText = document.getElementById("model-detail")!;
const modelProgress = document.getElementById("model-progress")!;
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

const overlaySettingsShown = chrome.storage.local.get(["overlay", "overlayPredictor", "overlayTargets", "overlayThreshold"]).then((settings) => {
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

/**
 * Function to show whether prefetching is on for the active site on the toggle button.
 * @param prefetchOn Whether prefetching is on.
 * @returns Nothing.
 */
function showPrefetchState(prefetchOn: boolean): void {
  prefetchToggle.setAttribute("aria-checked", String(prefetchOn));
  prefetchStateText.textContent = prefetchOn ? "On" : "Off";
  prefetchToggle.title = activeHostname ? `Prefetching ${prefetchOn ? "on" : "off"} for ${activeHostname}` : "Not available on this page";
}

const prefetchStateShown = Promise.all([chrome.tabs.query({ active: true, currentWindow: true }), chrome.storage.local.get("prefetchOffSites")]).then(
  ([[activeTab], { prefetchOffSites = [] }]) => {
    const activeTabUrl = URL.parse(activeTab?.url ?? "");
    activeHostname = activeTabUrl && /^https?:$/.test(activeTabUrl.protocol) ? activeTabUrl.hostname : undefined;
    prefetchSiteText.textContent = activeHostname ?? "Not available on this page";
    prefetchSiteText.title = activeHostname ?? "";
    prefetchToggle.disabled = !activeHostname;
    showPrefetchState(!!activeHostname && !(prefetchOffSites as string[]).includes(activeHostname));
  },
);
prefetchToggle.addEventListener("click", async () => {
  if (!activeHostname) return;
  const prefetchOn = prefetchToggle.getAttribute("aria-checked") !== "true";
  showPrefetchState(prefetchOn);
  const { prefetchOffSites = [] } = await chrome.storage.local.get("prefetchOffSites");
  const otherSites = (prefetchOffSites as string[]).filter((hostname) => hostname !== activeHostname);
  chrome.storage.local.set({ prefetchOffSites: prefetchOn ? otherSites : [...otherSites, activeHostname] });
});

// Switches and the status dot only animate once the stored state is on screen, not while the popup opens.
Promise.all([overlaySettingsShown, prefetchStateShown]).then(() => requestAnimationFrame(() => document.body.classList.add("ready")));

// Chrome ignores prefetches while its page preloading is off, which some extensions do.
const preloadingNotice = document.getElementById("preloading-notice")!;
const preloadingDetailText = document.getElementById("preloading-detail")!;

/**
 * Function to warn when Chrome's page preloading is off, and say what turned it off.
 * @param setting Chrome's network prediction setting.
 * @returns Nothing.
 */
function showPreloadingNotice({ value, levelOfControl }: chrome.types.ChromeSettingGetResult<boolean>): void {
  preloadingNotice.hidden = value;
  preloadingDetailText.textContent =
    levelOfControl === "controlled_by_other_extensions"
      ? "Another extension turned it off, so nothing gets prefetched. Look for a prefetching option in your other extensions."
      : "Nothing gets prefetched until Preload pages is on in Chrome's settings, under Performance.";
}

chrome.privacy.network.networkPredictionEnabled.get({}, showPreloadingNotice);
chrome.privacy.network.networkPredictionEnabled.onChange.addListener(showPreloadingNotice);

// Model ----------

/**
 * Function to show whether the default or the personal weights are running, and until the first update, how many
 * more usable clicks it needs, as text and a progress bar.
 * @returns Nothing.
 */
async function showModelStatus(): Promise<void> {
  const { personalModel, newUsableClickCount = 0 } = (await chrome.storage.local.get(["personalModel", "newUsableClickCount"])) as {
    personalModel?: PersonalModel;
    newUsableClickCount?: number;
  };
  const remainingClicks = Math.max(0, CLICKS_PER_UPDATE - newUsableClickCount);
  modelNameText.textContent = personalModel ? "Running your weights" : "Running default weights";
  modelDetailText.textContent = personalModel
    ? "Fine-tuned on your clicks, on this device"
    : remainingClicks === 0
      ? "Starts learning how you move shortly"
      : `Starts learning how you move after ${remainingClicks} more ${remainingClicks === 1 ? "click" : "clicks"}`;
  modelProgress.hidden = !!personalModel;
  (modelProgress.firstElementChild as HTMLElement).style.transform = `scaleX(${Math.min(1, newUsableClickCount / CLICKS_PER_UPDATE)})`;
  modelCard.hidden = false;
}

showModelStatus();
chrome.storage.onChanged.addListener((changes) => (changes.personalModel || changes.newUsableClickCount) && showModelStatus());

// Traces ----------

/**
 * Function to list the stored trace keys, oldest first.
 * @returns The trace keys.
 */
async function getTraceKeys(): Promise<string[]> {
  return (await chrome.storage.local.getKeys()).filter((key) => key.startsWith("trace:")).sort();
}

let exporting = false;

/**
 * Function to enable Export traces only when there are traces to export.
 * @returns Nothing.
 */
async function refreshExportButton(): Promise<void> {
  const traceKeys = await getTraceKeys();
  if (!exporting) exportButton.disabled = traceKeys.length === 0;
}

refreshExportButton();
chrome.storage.onChanged.addListener((changes) => {
  if (Object.keys(changes).some((key) => key.startsWith("trace:"))) refreshExportButton();
});

// Each outcome is joined into its trace as `outcome`; outcomes whose trace is gone are dropped. Read 1,000 traces at a
// time so a large export doesn't hold every record in memory at once.
exportButton.addEventListener("click", async () => {
  exporting = true;
  exportButton.disabled = true;
  exportButton.textContent = "Exporting…";
  try {
    const traceKeys = await getTraceKeys();
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
    refreshExportButton();
  }
});

// Time saved ----------

const numberFormat = new Intl.NumberFormat("en");

/**
 * Function to write a duration the way the popup shows it: milliseconds under 1 s, tenths of a second under 10 s,
 * then seconds, minutes and hours.
 * @param durationMs The duration in ms.
 * @returns The formatted duration.
 */
function formatDuration(durationMs: number): string {
  if (durationMs < 1000) return `${Math.floor(durationMs)} ms`;
  const seconds = durationMs / 1000;
  // Round down, so 9,960 ms shows 9.9 s rather than 10.0 s.
  if (seconds < 10) return `${(Math.floor(durationMs / 100) / 10).toFixed(1)} s`;
  if (seconds < 60) return `${Math.floor(seconds)} s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes} min ${Math.floor(seconds % 60)} s`;
  return `${numberFormat.format(Math.floor(minutes / 60))} h ${minutes % 60} min`;
}

/**
 * Function to draw the time saved on each of the last 10 prefetched pages as bars, with a dotted line at the
 * average over every page, labelled below. Slots without a page yet show as empty outlines. Heights follow the square
 * root, so one slow page doesn't flatten the rest.
 * @param recentSavedMs The time saved on each recent page, oldest first.
 * @param averageMs The average time saved per page over every page, or undefined before the first.
 * @returns Nothing.
 */
function drawRecentChart(recentSavedMs: number[], averageMs: number | undefined): void {
  const maxSavedMs = Math.max(1, ...recentSavedMs, averageMs ?? 0);
  // 6px floor, up to 78px of the 80px chart, leaving room for the 2px average line at the top.
  const toChartPx = (savedMs: number) => 6 + Math.sqrt(savedMs / maxSavedMs) * 72;
  const bars = Array.from({ length: 10 }, (_, slot) => {
    const bar = document.createElement("div");
    const savedMs = recentSavedMs[slot - (10 - recentSavedMs.length)];
    bar.className = savedMs === undefined ? "bar empty" : "bar";
    if (savedMs !== undefined) bar.style.height = `${toChartPx(savedMs)}px`;
    return bar;
  });
  recentChart.replaceChildren(...bars);
  chartCaptionText.textContent = recentSavedMs.length === 0 ? "Pages you open show up here" : "Last 10 pages";
  chartAverageText.hidden = averageMs === undefined;
  if (averageMs === undefined) return;
  const averageLine = document.createElement("div");
  averageLine.className = "average";
  averageLine.style.bottom = `${toChartPx(averageMs)}px`;
  chartAverageText.textContent = `Avg ${formatDuration(averageMs)}`;
  chartAverageText.title = "Average over all pages";
  recentChart.append(averageLine);
}

/**
 * Function to show the time prefetching saved, and the chart of the last 10 pages.
 * @returns Nothing.
 */
async function showTimeSaved(): Promise<void> {
  const { timeSaved = { savedMs: 0, pageCount: 0 } } = (await chrome.storage.local.get("timeSaved")) as { timeSaved?: TimeSaved };
  timeSavedText.textContent = formatDuration(timeSaved.savedMs);
  const recentSavedMs = timeSaved.recentSavedMs ?? [];
  // Records from before the chart have a total but no recent pages; an average over empty slots would float.
  drawRecentChart(recentSavedMs, recentSavedMs.length > 0 ? timeSaved.savedMs / timeSaved.pageCount : undefined);
}

showTimeSaved();
chrome.storage.onChanged.addListener((changes) => changes.timeSaved && showTimeSaved());

// Clearing takes a second click between 0.5 s and 4 s later to confirm, so a reflexive double click can't delete. It
// deletes every click, the personal weights learned from them, and the time saved.
let clearConfirmTimer: number | undefined;
let clearArmedAt = 0;

/**
 * Function to put the clear button back to its first click.
 * @returns Nothing.
 */
function resetClearButton(): void {
  clearTimeout(clearConfirmTimer);
  clearButton.classList.remove("confirming");
  clearButton.textContent = "Reset beeline";
}

clearButton.addEventListener("click", async () => {
  if (!clearButton.classList.contains("confirming")) {
    clearButton.classList.add("confirming");
    clearButton.textContent = "Click again to delete all data";
    clearArmedAt = performance.now();
    clearConfirmTimer = window.setTimeout(resetClearButton, 4000);
    return;
  }
  if (performance.now() - clearArmedAt < 500) return;
  resetClearButton();
  const clickKeys = (await chrome.storage.local.getKeys()).filter((key) => /^(trace|outcome|training):/.test(key));
  await chrome.storage.local.remove([...clickKeys, "personalModel", "newUsableClickCount", "timeSaved"]);
});
clearButton.addEventListener("blur", resetClearButton);
