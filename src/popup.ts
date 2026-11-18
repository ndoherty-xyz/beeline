// Popup: overlay and recording toggles, overlay options, device switch, trace count, export and clear.

const overlayCheckbox = document.getElementById("overlay") as HTMLInputElement;
const overlayOptions = document.getElementById("overlay-options") as HTMLFieldSetElement;
const overlayPredictorSelect = document.getElementById("overlay-predictor") as HTMLSelectElement;
const overlayTargetsSelect = document.getElementById("overlay-targets") as HTMLSelectElement;
const overlayThresholdInput = document.getElementById("overlay-threshold") as HTMLInputElement;
const recordingCheckbox = document.getElementById("recording") as HTMLInputElement;
const deviceSelect = document.getElementById("device") as HTMLSelectElement;
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

// Traces ----------

/**
 * Function to list the stored trace keys, oldest first.
 * @returns The trace keys.
 */
async function getTraceKeys(): Promise<string[]> {
  return (await chrome.storage.local.getKeys()).filter((key) => key.startsWith("trace:")).sort();
}

/**
 * Function to show how many traces are stored.
 * @returns Nothing.
 */
async function showTraceCount(): Promise<void> {
  const traceCount = (await getTraceKeys()).length;
  traceCountText.textContent = `${traceCount} ${traceCount === 1 ? "trace" : "traces"} recorded`;
}

showTraceCount();
chrome.storage.onChanged.addListener(showTraceCount);

exportButton.addEventListener("click", async () => {
  const traceKeys = await getTraceKeys();
  const traces = await chrome.storage.local.get(traceKeys);
  const jsonl = traceKeys.map((key) => `${JSON.stringify(traces[key])}\n`).join("");
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
  await chrome.storage.local.remove(await getTraceKeys());
  clearButton.textContent = "Clear";
});
