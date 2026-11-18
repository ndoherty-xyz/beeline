// Content script: collects targets, tracks the cursor, draws the overlay and records traces.

import { FORESIGHT_VELOCITY_WINDOW_MS, predictForesightPoint, segmentIntersectsRect, type TimedPoint } from "./baselines.ts";
import { predictTargetProbabilities } from "./model.ts";
import modelWeights from "./model-weights.json";

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

// The visible targets and their viewport rectangles, at the same indexes.
let targetElements: Element[] = [];
let targetRects: DOMRect[] = [];
let targetRectsStale = true;

/**
 * Function to re-measure the visible targets' viewport rectangles, if they've been marked stale.
 * @returns Nothing; updates `targetElements` and `targetRects`.
 */
function refreshTargetRects(): void {
  if (!targetRectsStale) return;
  targetRectsStale = false;
  targetElements = [];
  targetRects = [];
  for (const element of document.querySelectorAll(TARGET_SELECTOR)) {
    const rect = element.getBoundingClientRect();
    const onScreen = rect.right > 0 && rect.bottom > 0 && rect.left < innerWidth && rect.top < innerHeight;
    if (onScreen && rect.width > 0 && rect.height > 0) {
      targetElements.push(element);
      targetRects.push(rect);
    }
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

// Set from the popup. Foresight fires yes or no, so the threshold only applies to the model.
const overlaySettings = { predictor: "model", showAllTargets: false, thresholdPercent: 80 };
// Below this, a target isn't tinted in all-targets mode.
const MIN_TINTED_PROBABILITY = 0.03;

/**
 * Function to outline the targets that are firing, and in all-targets mode every other target faintly.
 * @param canvas The overlay canvas.
 * @param targetProbabilities A probability for each target in `targetRects`; 1 or 0 for Foresight.
 * @param minFiringProbability The probability at which a target counts as firing.
 * @param foresightLine Foresight's predicted line, drawn when it's the predictor; model targets get a percentage instead.
 * @returns Nothing.
 */
function drawOverlay(
  canvas: HTMLCanvasElement,
  targetProbabilities: number[],
  minFiringProbability: number,
  foresightLine?: { from: TimedPoint; to: { x: number; y: number } },
): void {
  const context = canvas.getContext("2d")!;
  context.setTransform(devicePixelRatio, 0, 0, devicePixelRatio, 0, 0);
  context.clearRect(0, 0, innerWidth, innerHeight);
  context.strokeStyle = context.fillStyle = "#f59e0b";

  if (overlaySettings.showAllTargets) {
    targetRects.forEach((rect, index) => {
      const probability = targetProbabilities[index];
      if (probability >= minFiringProbability) return;
      // Grey, or amber that strengthens with the probability.
      const tinted = probability >= MIN_TINTED_PROBABILITY;
      context.globalAlpha = tinted ? 0.3 + 0.7 * probability : 1;
      context.lineWidth = tinted ? 1 + 2 * probability : 1;
      context.strokeStyle = tinted ? "#f59e0b" : "rgba(128, 128, 128, 0.5)";
      context.strokeRect(rect.left, rect.top, rect.width, rect.height);
    });
    context.globalAlpha = 1;
    context.strokeStyle = "#f59e0b";
  }

  context.font = "600 11px ui-monospace, Menlo, monospace";
  context.textBaseline = "middle";
  targetProbabilities.forEach((probability, index) => {
    if (probability < minFiringProbability) return;
    const rect = targetRects[index];
    context.lineWidth = 2;
    context.strokeRect(rect.left, rect.top, rect.width, rect.height);
    if (foresightLine) return;
    // A pill above the target's top-right corner, kept inside the viewport.
    const label = `${Math.round(probability * 100)}%`;
    const labelWidth = context.measureText(label).width + 8;
    const labelLeft = Math.max(0, Math.min(rect.right - labelWidth, innerWidth - labelWidth));
    const labelTop = Math.max(0, rect.top - 18);
    context.beginPath();
    context.roundRect(labelLeft, labelTop, labelWidth, 16, 4);
    context.fill();
    context.fillStyle = "#1c1917";
    context.fillText(label, labelLeft + 4, labelTop + 8.5);
    context.fillStyle = "#f59e0b";
  });

  if (!foresightLine) return;
  context.lineWidth = 2;
  context.beginPath();
  context.moveTo(foresightLine.from.x, foresightLine.from.y);
  context.lineTo(foresightLine.to.x, foresightLine.to.y);
  context.stroke();
  context.beginPath();
  context.arc(foresightLine.to.x, foresightLine.to.y, 3, 0, 2 * Math.PI);
  context.fill();
}

// Pointer ----------

const SAMPLE_WINDOW_MS = 1000;

// A full-rate cursor sample. `predictedX/Y` is Chrome's farthest predicted point (the sample itself when it
// has none), and `foresightFrame` marks the one sample per animation frame that Foresight processes.
type PointerSample = TimedPoint & { predictedX: number; predictedY: number; foresightFrame: boolean };

// Cursor samples from the last second, for recording and the model.
const pointerSamples: PointerSample[] = [];
// The frames Foresight has seen within its velocity window, for the Foresight overlay.
const foresightFrameHistory: TimedPoint[] = [];
let pointerFrameRequested = false;

addEventListener(
  "pointermove",
  (event) => {
    if (!event.isTrusted || event.pointerType !== "mouse") return;
    // getCoalescedEvents and getPredictedEvents are only exposed in secure contexts.
    for (const sample of isSecureContext ? event.getCoalescedEvents() : [event]) {
      const { timeStamp: t, clientX: x, clientY: y } = sample;
      pointerSamples.push({ t, x, y, predictedX: x, predictedY: y, foresightFrame: false });
    }
    const farthestPrediction = isSecureContext ? event.getPredictedEvents().at(-1) : undefined;
    if (farthestPrediction) {
      pointerSamples.at(-1)!.predictedX = farthestPrediction.clientX;
      pointerSamples.at(-1)!.predictedY = farthestPrediction.clientY;
    }
    pointerSamples.splice(0, pointerSamples.findIndex((sample) => sample.t >= event.timeStamp - SAMPLE_WINDOW_MS));

    // Like Foresight, take the latest sample once per frame, and only on frames with movement.
    if (pointerFrameRequested) return;
    pointerFrameRequested = true;
    requestAnimationFrame(() => {
      pointerFrameRequested = false;
      const latestSample = pointerSamples.at(-1);
      if (!latestSample) return; // cleared by a scroll
      latestSample.foresightFrame = true;
      if (!overlayCanvas) return;
      refreshTargetRects();
      if (targetRects.length === 0) return;
      if (overlaySettings.predictor === "foresight") {
        const cursor = { t: latestSample.t, x: latestSample.x, y: latestSample.y };
        foresightFrameHistory.push(cursor);
        while (cursor.t - foresightFrameHistory[0].t > FORESIGHT_VELOCITY_WINDOW_MS) foresightFrameHistory.shift();
        const predicted = predictForesightPoint(foresightFrameHistory);
        const crossed = targetRects.map((rect) => (segmentIntersectsRect(cursor, predicted, rect) ? 1 : 0));
        drawOverlay(overlayCanvas, crossed, 1, { from: cursor, to: predicted });
      } else {
        // Same frames and full-rate history as eval/replay.ts replayModel.
        const probabilities = predictTargetProbabilities(modelWeights, pointerSamples, targetRects);
        drawOverlay(overlayCanvas, probabilities, overlaySettings.thresholdPercent / 100);
      }
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
    foresightFrameHistory.length = 0;
    overlayCanvas?.getContext("2d")!.clearRect(0, 0, innerWidth, innerHeight);
  },
  { capture: true, passive: true },
);

addEventListener("resize", () => {
  targetRectsStale = true;
  if (overlayCanvas) sizeOverlayCanvas(overlayCanvas);
});

// Recording ----------

let recordingEnabled = true;
let device = "mouse";

/**
 * Function to round a number to one decimal place, to keep stored traces small.
 * @param value The number to round.
 * @returns The rounded number.
 */
function roundToTenth(value: number): number {
  return Math.round(value * 10) / 10;
}

addEventListener(
  "pointerdown",
  (event) => {
    if (!recordingEnabled || !event.isTrusted || event.pointerType !== "mouse" || event.button !== 0) return;
    refreshTargetRects();
    // -1 when the click hit no target, e.g. a near miss.
    const clicked = targetElements.indexOf((event.target as Element).closest(TARGET_SELECTOR)!);

    const time = Date.now();
    const trace = {
      time,
      device,
      viewport: [innerWidth, innerHeight],
      samples: pointerSamples.map((sample) =>
        [sample.t - event.timeStamp, sample.x, sample.y, sample.predictedX, sample.predictedY]
          .map(roundToTenth)
          .concat(sample.foresightFrame ? 1 : 0),
      ),
      targets: targetRects.map((rect) => [rect.left, rect.top, rect.width, rect.height].map(roundToTenth)),
      clicked,
      // Separates clicks on clickable elements the selector misses from real misses, when `clicked` is -1.
      pointerCursor: getComputedStyle(event.target as Element).cursor === "pointer",
    };
    chrome.storage.local.set({ [`trace:${time}:${Math.random().toString(36).slice(2, 8)}`]: trace });
  },
  { capture: true, passive: true },
);

// Settings ----------

chrome.storage.local.get(["overlay", "overlayPredictor", "overlayTargets", "overlayThreshold", "recording", "device"]).then((settings) => {
  setOverlayEnabled(settings.overlay === true);
  overlaySettings.predictor = (settings.overlayPredictor as string | undefined) ?? "model";
  overlaySettings.showAllTargets = settings.overlayTargets === "all";
  overlaySettings.thresholdPercent = (settings.overlayThreshold as number | undefined) ?? 80;
  recordingEnabled = settings.recording !== false;
  device = (settings.device as string | undefined) ?? "mouse";
});
chrome.storage.onChanged.addListener((changes, areaName) => {
  if (areaName !== "local") return;
  if (changes.overlay) setOverlayEnabled(changes.overlay.newValue === true);
  if (changes.overlayPredictor) overlaySettings.predictor = changes.overlayPredictor.newValue as string;
  if (changes.overlayTargets) overlaySettings.showAllTargets = changes.overlayTargets.newValue === "all";
  if (changes.overlayThreshold) overlaySettings.thresholdPercent = changes.overlayThreshold.newValue as number;
  if (changes.recording) recordingEnabled = changes.recording.newValue !== false;
  if (changes.device) device = changes.device.newValue as string;
});
