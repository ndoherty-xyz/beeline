// Popup: prefetch switch for the current site, overlay and recording toggles, overlay options, device switch, which
// weights are running, trace count, export and clear.

import type { PersonalModel } from "./background.ts";

const prefetchCheckbox = document.getElementById("prefetch") as HTMLInputElement;
const prefetchSiteText = document.getElementById("prefetch-site")!;
const overlayCheckbox = document.getElementById("overlay") as HTMLInputElement;
const overlayOptions = document.getElementById("overlay-options") as HTMLFieldSetElement;
const overlayPredictorSelect = document.getElementById("overlay-predictor") as HTMLSelectElement;
const overlayTargetsSelect = document.getElementById("overlay-targets") as HTMLSelectElement;
const overlayThresholdInput = document.getElementById("overlay-threshold") as HTMLInputElement;
const recordingCheckbox = document.getElementById("recording") as HTMLInputElement;
const deviceSelect = document.getElementById("device") as HTMLSelectElement;
const modelStatusText = document.getElementById("model-status")!;
const traceCountText = document.getElementById("trace-count")!;
const exportButton = document.getElementById("export")!;
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

chrome.storage.local.get(["overlay", "overlayPredictor", "overlayTargets", "overlayThreshold", "recording", "device"]).then((settings) => {
  overlayCheckbox.checked = settings.overlay === true;
  overlayPredictorSelect.value = (settings.overlayPredictor as string | undefined) ?? "model";
  overlayTargetsSelect.value = (settings.overlayTargets as string | undefined) ?? "firing";
  overlayThresholdInput.value = String((settings.overlayThreshold as number | undefined) ?? 80);
  recordingCheckbox.checked = settings.recording !== false;
  deviceSelect.value = (settings.device as string | undefined) ?? "mouse";
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
recordingCheckbox.addEventListener("change", () => chrome.storage.local.set({ recording: recordingCheckbox.checked }));
deviceSelect.addEventListener("change", () => chrome.storage.local.set({ device: deviceSelect.value }));

// Prefetch ----------

// The active tab's hostname, readable through activeTab while the popup is open. Pages like chrome:// have none.
let activeHostname: string | undefined;

Promise.all([chrome.tabs.query({ active: true, currentWindow: true }), chrome.storage.local.get("prefetchOffSites")]).then(
  ([[activeTab], { prefetchOffSites = [] }]) => {
    const activeTabUrl = URL.parse(activeTab?.url ?? "");
    activeHostname = activeTabUrl && /^https?:$/.test(activeTabUrl.protocol) ? activeTabUrl.hostname : undefined;
    prefetchSiteText.textContent = activeHostname ?? "this page";
    prefetchCheckbox.disabled = !activeHostname;
    prefetchCheckbox.checked = !!activeHostname && !(prefetchOffSites as string[]).includes(activeHostname);
  },
);
prefetchCheckbox.addEventListener("change", async () => {
  const { prefetchOffSites = [] } = await chrome.storage.local.get("prefetchOffSites");
  const otherSites = (prefetchOffSites as string[]).filter((hostname) => hostname !== activeHostname);
  chrome.storage.local.set({ prefetchOffSites: prefetchCheckbox.checked ? otherSites : [...otherSites, activeHostname] });
});

// Model ----------

/**
 * Function to show whether the default or the personal weights are running, and how many clicks they learned from.
 * @returns Nothing.
 */
async function showModelStatus(): Promise<void> {
  const { personalModel } = (await chrome.storage.local.get("personalModel")) as { personalModel?: PersonalModel };
  modelStatusText.textContent = personalModel
    ? `Running personal weights, learned from ${personalModel.clickCount} clicks`
    : "Running default weights; learns from your clicks after 100";
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

/**
 * Function to show how many traces are stored and how many have an outcome, so lost outcomes are visible.
 * @returns Nothing.
 */
async function showTraceCount(): Promise<void> {
  const { traceKeys, outcomeKeys } = await getRecordKeys();
  // Trace keys end in the trace id (v2); an outcome written after its trace was cleared doesn't count.
  const traceKeySuffixes = new Set(traceKeys.map((key) => key.split(":")[2]));
  const joinedOutcomeCount = outcomeKeys.filter((key) => traceKeySuffixes.has(key.slice("outcome:".length))).length;
  traceCountText.textContent = `${traceKeys.length} ${traceKeys.length === 1 ? "trace" : "traces"} recorded, ${joinedOutcomeCount} with outcomes`;
}

showTraceCount();
chrome.storage.onChanged.addListener(showTraceCount);

// Each outcome is joined into its trace as `outcome`; outcomes whose trace is gone are dropped.
exportButton.addEventListener("click", async () => {
  const { traceKeys, outcomeKeys } = await getRecordKeys();
  const records = await chrome.storage.local.get([...traceKeys, ...outcomeKeys]);
  const jsonl = traceKeys
    .map((key) => {
      const trace = records[key] as { id?: string };
      const outcome = trace.id === undefined ? undefined : records[`outcome:${trace.id}`];
      return `${JSON.stringify(outcome ? { ...trace, outcome } : trace)}\n`;
    })
    .join("");
  const link = document.createElement("a");
  link.href = URL.createObjectURL(new Blob([jsonl], { type: "application/jsonl" }));
  link.download = `beeline-traces-${new Date().toISOString().slice(0, 10)}.jsonl`;
  link.click();
});

// Clearing takes a second click to confirm.
clearButton.addEventListener("click", async () => {
  if (clearButton.textContent === "Clear") {
    clearButton.textContent = "Click again to clear";
    return;
  }
  const { traceKeys, outcomeKeys } = await getRecordKeys();
  await chrome.storage.local.remove([...traceKeys, ...outcomeKeys]);
  clearButton.textContent = "Clear";
});
