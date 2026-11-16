// Content script: collects targets, tracks the cursor and draws the overlay.
// Recording traces is milestone 3 (docs/prd.md).

import { FORESIGHT_VELOCITY_WINDOW_MS, predictForesightPoint, segmentIntersectsRect, type TimedPoint } from "./baselines.ts";

// Targets ----------

const TARGET_SELECTOR = [
  "a[href]",
  "button",
  "input:not([type=hidden])",
  "select",
  "textarea",
  "summary",
  "label[for]",
  ...["button", "link", "checkbox", "radio", "switch", "tab", "menuitem", "menuitemcheckbox", "menuitemradio", "option", "treeitem"].map(
    (role) => `[role=${role}]`,
  ),
  "[onclick]",
  "[tabindex]:not([tabindex='-1'])",
].join(",");

let targetRects: DOMRect[] = [];
let targetRectsStale = true;

/**
 * Function to re-measure the visible targets' viewport rectangles, if they've been marked stale.
 * @returns Nothing; updates `targetRects`.
 */
function refreshTargetRects(): void {
  if (!targetRectsStale) return;
  targetRectsStale = false;
  targetRects = [];
  for (const element of document.querySelectorAll(TARGET_SELECTOR)) {
    const rect = element.getBoundingClientRect();
    const onScreen = rect.right > 0 && rect.bottom > 0 && rect.left < innerWidth && rect.top < innerHeight;
    if (onScreen && rect.width > 0 && rect.height > 0) targetRects.push(rect);
  }
}

new MutationObserver(() => (targetRectsStale = true)).observe(document.documentElement, {
  childList: true,
  subtree: true,
  attributes: true,
});

// Overlay ----------

let overlayCanvas: HTMLCanvasElement | undefined;

/**
 * Function to match the overlay canvas to the viewport size and device pixel ratio.
 * @param canvas The overlay canvas.
 * @returns Nothing.
 */
function sizeOverlayCanvas(canvas: HTMLCanvasElement): void {
  canvas.style.width = `${innerWidth}px`;
  canvas.style.height = `${innerHeight}px`;
  canvas.width = innerWidth * devicePixelRatio;
  canvas.height = innerHeight * devicePixelRatio;
}

/**
 * Function to add or remove the overlay canvas.
 * @param enabled Whether the overlay should show.
 * @returns Nothing.
 */
function setOverlayEnabled(enabled: boolean): void {
  if (enabled && !overlayCanvas) {
    overlayCanvas = document.createElement("canvas");
    overlayCanvas.style.cssText = "position:fixed;left:0;top:0;pointer-events:none;z-index:2147483647";
    sizeOverlayCanvas(overlayCanvas);
    document.documentElement.append(overlayCanvas);
  } else if (!enabled && overlayCanvas) {
    overlayCanvas.remove();
    overlayCanvas = undefined;
  }
}

/**
 * Function to draw every target faintly, and Foresight's predicted line and the targets it crosses strongly.
 * @param canvas The overlay canvas.
 * @param cursor The current cursor position.
 * @param predicted Foresight's predicted cursor position.
 * @returns Nothing.
 */
function drawOverlay(canvas: HTMLCanvasElement, cursor: TimedPoint, predicted: { x: number; y: number }): void {
  const context = canvas.getContext("2d")!;
  context.setTransform(devicePixelRatio, 0, 0, devicePixelRatio, 0, 0);
  context.clearRect(0, 0, innerWidth, innerHeight);

  context.lineWidth = 1;
  context.strokeStyle = "rgba(128, 128, 128, 0.5)";
  for (const rect of targetRects) context.strokeRect(rect.left, rect.top, rect.width, rect.height);

  context.lineWidth = 2;
  context.strokeStyle = context.fillStyle = "#f59e0b";
  for (const rect of targetRects) {
    if (segmentIntersectsRect(cursor, predicted, rect)) context.strokeRect(rect.left, rect.top, rect.width, rect.height);
  }
  context.beginPath();
  context.moveTo(cursor.x, cursor.y);
  context.lineTo(predicted.x, predicted.y);
  context.stroke();
  context.beginPath();
  context.arc(predicted.x, predicted.y, 3, 0, 2 * Math.PI);
  context.fill();
}

chrome.storage.local.get("overlay").then(({ overlay }) => setOverlayEnabled(overlay === true));
chrome.storage.onChanged.addListener((changes, areaName) => {
  if (areaName === "local" && changes.overlay) setOverlayEnabled(changes.overlay.newValue === true);
});

// Pointer ----------

const SAMPLE_WINDOW_MS = 1000;

// Full-rate cursor samples from the last second, for recording.
const pointerSamples: TimedPoint[] = [];
// The latest pointermove, and one of those per animation frame that had movement, as Foresight sees them.
let latestPointerMove: TimedPoint | undefined;
const foresightFrameHistory: TimedPoint[] = [];
let overlayFrameRequested = false;

addEventListener(
  "pointermove",
  (event) => {
    if (!event.isTrusted || event.pointerType !== "mouse") return;
    // getCoalescedEvents is only exposed in secure contexts.
    for (const sample of isSecureContext ? event.getCoalescedEvents() : [event]) {
      pointerSamples.push({ t: sample.timeStamp, x: sample.clientX, y: sample.clientY });
    }
    pointerSamples.splice(0, pointerSamples.findIndex((sample) => sample.t >= event.timeStamp - SAMPLE_WINDOW_MS));
    latestPointerMove = { t: event.timeStamp, x: event.clientX, y: event.clientY };

    // Like Foresight, process at most once per frame, and only on frames with movement.
    if (!overlayCanvas || overlayFrameRequested) return;
    overlayFrameRequested = true;
    requestAnimationFrame(() => {
      overlayFrameRequested = false;
      const cursor = latestPointerMove!;
      if (!overlayCanvas) return;
      foresightFrameHistory.push(cursor);
      while (cursor.t - foresightFrameHistory[0].t > FORESIGHT_VELOCITY_WINDOW_MS) foresightFrameHistory.shift();
      refreshTargetRects();
      drawOverlay(overlayCanvas, cursor, predictForesightPoint(foresightFrameHistory));
    });
  },
  { capture: true, passive: true },
);

// The trajectory no longer lines up with the targets once the page moves.
addEventListener(
  "scroll",
  () => {
    targetRectsStale = true;
    pointerSamples.length = 0;
    overlayCanvas?.getContext("2d")!.clearRect(0, 0, innerWidth, innerHeight);
  },
  { capture: true, passive: true },
);

addEventListener("resize", () => {
  targetRectsStale = true;
  if (overlayCanvas) sizeOverlayCanvas(overlayCanvas);
});
