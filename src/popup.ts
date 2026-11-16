// Popup: overlay and recording toggles, device switch, trace count, export and clear.

const overlayCheckbox = document.getElementById("overlay") as HTMLInputElement;
const recordingCheckbox = document.getElementById("recording") as HTMLInputElement;
const deviceSelect = document.getElementById("device") as HTMLSelectElement;
const traceCountText = document.getElementById("trace-count")!;
const exportButton = document.getElementById("export")!;
const clearButton = document.getElementById("clear")!;

chrome.storage.local.get(["overlay", "recording", "device"]).then((settings) => {
  overlayCheckbox.checked = settings.overlay === true;
  recordingCheckbox.checked = settings.recording !== false;
  deviceSelect.value = (settings.device as string | undefined) ?? "mouse";
});
overlayCheckbox.addEventListener("change", () => chrome.storage.local.set({ overlay: overlayCheckbox.checked }));
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
