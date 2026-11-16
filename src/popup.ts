// Popup: overlay and recording toggles, trace count, export and clear.
// Only the overlay toggle is wired up so far; the rest is milestone 3 (docs/prd.md).

const overlayCheckbox = document.getElementById("overlay") as HTMLInputElement;
chrome.storage.local.get("overlay").then(({ overlay }) => (overlayCheckbox.checked = overlay === true));
overlayCheckbox.addEventListener("change", () => chrome.storage.local.set({ overlay: overlayCheckbox.checked }));
