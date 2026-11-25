// Content script: prefetches the link you're heading for, draws the overlay from the beeline core (or Foresight), and
// records traces.

import { createBeeline, prefetchLinks, TARGET_SELECTOR, type BeelineFrame } from "beeline";
import { FORESIGHT_VELOCITY_WINDOW_MS, predictForesightPoint, segmentIntersectsRect, type TimedPoint } from "./baselines.ts";

const beeline = createBeeline();
prefetchLinks();

// Mutations ----------

// [performance.now(), mutation record count] over the last second, to tell how busy the page is around a click.
const mutationCounts: number[][] = [];

new MutationObserver((records) => {
  const now = performance.now();
  mutationCounts.push([now, records.length]);
  while (mutationCounts[0][0] < now - 1000) mutationCounts.shift();
}).observe(document.documentElement, {
  childList: true,
  subtree: true,
  attributes: true,
});

/**
 * Function to count DOM mutation records seen in a time range.
 * @param from Start of the range (exclusive), on the `performance.now()` clock.
 * @param to End of the range (inclusive).
 * @returns The number of mutation records.
 */
function countMutations(from: number, to: number): number {
  return mutationCounts.reduce((sum, [t, count]) => (t > from && t <= to ? sum + count : sum), 0);
}

// Overlay ----------

let overlayCanvas: HTMLCanvasElement | undefined;
let stopOverlayFrames: (() => void) | undefined;

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
    stopOverlayFrames = beeline.onFrame(drawOverlayFrame);
  } else if (!enabled && overlayCanvas) {
    stopOverlayFrames!();
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
 * @param targetRects The visible targets.
 * @param targetProbabilities A probability for each target; 1 or 0 for Foresight.
 * @param minFiringProbability The probability at which a target counts as firing.
 * @param foresightLine Foresight's predicted line, drawn when it's the predictor; model targets get a percentage instead.
 * @returns Nothing.
 */
function drawOverlay(
  canvas: HTMLCanvasElement,
  targetRects: DOMRect[],
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
// has none), `foresightFrame` marks the one sample per animation frame that Foresight processes, and
// `scrollX/Y` is the page's scroll offset at the time.
type PointerSample = TimedPoint & { predictedX: number; predictedY: number; foresightFrame: boolean; scrollX: number; scrollY: number };

// Cursor samples from the last second, for recording. Scrolling doesn't clear them.
const pointerSamples: PointerSample[] = [];
// The frames Foresight has seen within its velocity window, for the Foresight overlay.
const foresightFrameHistory: TimedPoint[] = [];
let pointerFrameRequested = false;
// When the page or any element last scrolled.
let lastScrollTime = -Infinity;

/**
 * Function to draw one frame of the overlay: the core's probabilities, or Foresight's line on the same frame.
 * @param frame The core's frame.
 * @returns Nothing.
 */
function drawOverlayFrame({ targetRects, probabilities, history }: BeelineFrame): void {
  if (!overlayCanvas) return;
  if (overlaySettings.predictor !== "foresight") {
    drawOverlay(overlayCanvas, targetRects, probabilities, overlaySettings.thresholdPercent / 100);
    return;
  }
  const cursor = history.at(-1)!;
  foresightFrameHistory.push(cursor);
  while (cursor.t - foresightFrameHistory[0].t > FORESIGHT_VELOCITY_WINDOW_MS) foresightFrameHistory.shift();
  const predicted = predictForesightPoint(foresightFrameHistory);
  const crossed = targetRects.map((rect) => (segmentIntersectsRect(cursor, predicted, rect) ? 1 : 0));
  drawOverlay(overlayCanvas, targetRects, crossed, 1, { from: cursor, to: predicted });
}

addEventListener(
  "pointermove",
  (event) => {
    if (!event.isTrusted || event.pointerType !== "mouse") return;
    // getCoalescedEvents and getPredictedEvents are only exposed in secure contexts.
    for (const sample of isSecureContext ? event.getCoalescedEvents() : [event]) {
      const { timeStamp: t, clientX: x, clientY: y } = sample;
      pointerSamples.push({ t, x, y, predictedX: x, predictedY: y, foresightFrame: false, scrollX, scrollY });
      if (pendingOutcome && pendingOutcome.endTime === undefined) pendingOutcome.press.push([t - pendingOutcome.downTime, x, y]);
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
      if (latestSample && latestSample.t > lastScrollTime) latestSample.foresightFrame = true;
    });
  },
  { capture: true, passive: true },
);

// Scroll ----------

// Scroll events closer together than this belong to one burst.
const SCROLL_BURST_GAP_MS = 200;
// A wheel snapshot is the geometry before a burst only if the burst's first scroll event follows it this closely,
// on one of the wheel target's ancestors.
const WHEEL_SNAPSHOT_MAX_LEAD_MS = 100;

// [timeStamp, scrollLeft, scrollTop] of each element that scrolled in the last second. The page is
// document.scrollingElement.
const scrollEventsByElement = new Map<Element, number[][]>();

// Target rects and the scroll offsets of the wheel target's ancestors, measured on a wheel event before its
// scroll applies.
type WheelSnapshot = { t: number; targetRects: Map<Element, DOMRect>; scrollOffsets: Map<Element, number[]> };
let latestWheelSnapshot: WheelSnapshot | undefined;
// The snapshot taken just before the current burst started; undefined when it had none (keyboard, scrollbar, script).
let burstWheelSnapshot: WheelSnapshot | undefined;

addEventListener(
  "wheel",
  (event) => {
    if (!event.isTrusted || event.timeStamp - lastScrollTime < SCROLL_BURST_GAP_MS) return; // mid-burst
    const { targetElements, targetRects } = beeline.measureTargets();
    const scrollOffsets = new Map<Element, number[]>();
    for (let element = event.target as Element | null; element; element = element.parentElement) {
      scrollOffsets.set(element, [element.scrollLeft, element.scrollTop]);
    }
    latestWheelSnapshot = { t: event.timeStamp, targetRects: new Map(targetElements.map((element, index) => [element, targetRects[index]])), scrollOffsets };
  },
  { capture: true, passive: true },
);

addEventListener(
  "scroll",
  (event) => {
    const scrolledElement = event.target === document ? document.scrollingElement! : (event.target as Element);
    if (event.timeStamp - lastScrollTime >= SCROLL_BURST_GAP_MS) {
      const snapshotLead = latestWheelSnapshot ? event.timeStamp - latestWheelSnapshot.t : Infinity;
      const snapshotMatches = snapshotLead <= WHEEL_SNAPSHOT_MAX_LEAD_MS && latestWheelSnapshot!.scrollOffsets.has(scrolledElement);
      burstWheelSnapshot = snapshotMatches ? latestWheelSnapshot : undefined;
    }
    lastScrollTime = event.timeStamp;
    const scrollEvents = scrollEventsByElement.get(scrolledElement) ?? [];
    scrollEvents.push([event.timeStamp, scrolledElement.scrollLeft, scrolledElement.scrollTop]);
    while (scrollEvents[0][0] < event.timeStamp - SAMPLE_WINDOW_MS) scrollEvents.shift();
    scrollEventsByElement.set(scrolledElement, scrollEvents);

    foresightFrameHistory.length = 0;
    overlayCanvas?.getContext("2d")!.clearRect(0, 0, innerWidth, innerHeight);
  },
  { capture: true, passive: true },
);

addEventListener("resize", () => {
  if (overlayCanvas) sizeOverlayCanvas(overlayCanvas);
});

// Recording ----------

let recordingEnabled = true;
let device = "mouse";

// Random per page load, so a miss and its retry can be paired without storing the URL.
const pageId = Math.random().toString(36).slice(2, 10);
let clickSeq = 0;
// Opaque per-page ids: one per target node, and one per distinct link destination (the href is never stored).
const targetIdByElement = new WeakMap<Element, number>();
let nextTargetId = 0;
const destinationIdByHref = new Map<string, number>();

// How long after pointerup the selection, focus and mutation outcome is measured.
const OUTCOME_WINDOW_MS = 300;
// How long after pointerup the URL is watched, since client-side routes can be slow.
const NAVIGATION_WINDOW_MS = 2000;

// What follows a recorded pointerdown. Measured OUTCOME_WINDOW_MS after pointerup or pointercancel, and written once
// the URL watch ends: on a navigation, NAVIGATION_WINDOW_MS after release, the next pointerdown, or pagehide.
type PendingOutcome = {
  id: string;
  downTime: number;
  // [ms after pointerdown, x, y] from pointerdown until pointerup.
  press: number[][];
  endTime?: number;
  up?: number[];
  cancelled?: boolean;
  clicked?: boolean;
  // The click event's detail: 1 single, 2 double, and so on. Pointerdown's is always 0 in Chrome.
  clickCount?: number;
  navigatedMs?: number;
  // The fields measured OUTCOME_WINDOW_MS after release.
  measured?: Record<string, unknown>;
  activeElementBefore: Element | null;
  hrefBefore: string;
  mutationsBefore: number;
  timer?: ReturnType<typeof setTimeout>;
  urlPoll: ReturnType<typeof setInterval>;
};
let pendingOutcome: PendingOutcome | undefined;

/**
 * Function to round a number to one decimal place, to keep stored traces small.
 * @param value The number to round.
 * @returns The rounded number.
 */
function roundToTenth(value: number): number {
  return Math.round(value * 10) / 10;
}

/**
 * Function to write the pending outcome under its own key and stop observing it. Fields that weren't observed are
 * left out, meaning unknown.
 * @param watchEnd When the URL watch ended, on the `event.timeStamp` clock.
 * @returns Nothing.
 */
function storePendingOutcome(watchEnd: number): void {
  const pending = pendingOutcome!;
  pendingOutcome = undefined;
  clearTimeout(pending.timer);
  clearInterval(pending.urlPoll);
  const outcome: Record<string, unknown> = { id: pending.id, press: pending.press.map((sample) => sample.map(roundToTenth)) };
  if (pending.up) outcome.up = pending.up.map(roundToTenth);
  if (pending.cancelled !== undefined) outcome.cancelled = pending.cancelled;
  if (pending.clicked) outcome.clicked = true;
  if (pending.clickCount !== undefined) outcome.clickCount = pending.clickCount;
  Object.assign(outcome, pending.measured);
  if (pending.navigatedMs !== undefined) outcome.navigatedMs = pending.navigatedMs;
  outcome.watchedMs = roundToTenth(watchEnd - pending.downTime);
  chrome.storage.local.set({ [`outcome:${pending.id}`]: outcome });
}

/**
 * Function to check the pending outcome for a navigation, and write it once the URL watch is over.
 * @param now The current time, on the `event.timeStamp` clock.
 * @param stop Whether the watch ends now: the next pointerdown or pagehide.
 * @param pageHidden Whether the page is being left, which counts as a navigation.
 * @returns Nothing.
 */
function checkPendingNavigation(now: number, stop: boolean, pageHidden = false): void {
  const pending = pendingOutcome;
  if (!pending) return;
  const deadline = pending.endTime === undefined ? Infinity : pending.endTime + NAVIGATION_WINDOW_MS;
  // A change first seen after the deadline (a late timer, the next click) isn't attributed to this click.
  if (now <= deadline && pending.navigatedMs === undefined && (pageHidden || location.href !== pending.hrefBefore)) {
    pending.navigatedMs = roundToTenth(now - pending.downTime);
  }
  if (stop || (pending.measured && (pending.navigatedMs !== undefined || now >= deadline))) storePendingOutcome(Math.min(now, deadline));
}

/**
 * Function to start the OUTCOME_WINDOW_MS timer after pointerup or pointercancel, which measures what the press did.
 * @param pending The pending outcome, with `endTime` set.
 * @returns Nothing.
 */
function scheduleOutcomeMeasurement(pending: PendingOutcome): void {
  pending.timer = setTimeout(() => {
    pending.measured = {
      clicked: pending.clicked ?? false,
      selection: !(getSelection()?.isCollapsed ?? true),
      focusChanged: document.activeElement !== pending.activeElementBefore,
      mutationsBefore: pending.mutationsBefore,
      mutationsAfter: countMutations(pending.endTime!, pending.endTime! + OUTCOME_WINDOW_MS),
    };
    checkPendingNavigation(performance.now(), false);
  }, OUTCOME_WINDOW_MS);
}

addEventListener(
  "pointerdown",
  (event) => {
    if (!recordingEnabled || !event.isTrusted || event.pointerType !== "mouse" || event.button !== 0) return;
    checkPendingNavigation(event.timeStamp, true);
    const { targetElements, targetRects } = beeline.measureTargets();
    // -1 when the click hit no target, e.g. a near miss.
    const clicked = targetElements.indexOf((event.target as Element).closest(TARGET_SELECTOR)!);
    const targetIndexByElement = new Map(targetElements.map((element, index) => [element, index]));
    const msBeforeClick = (t: number) => roundToTenth(t - event.timeStamp);
    const rectToArray = (rect: DOMRect) => [rect.left, rect.top, rect.width, rect.height].map(roundToTenth);

    // Link category: 0 not a link, 1 same-origin, 2 cross-origin, 3 same document (only the hash differs),
    // 4 anything else (download, non-http scheme, unparseable).
    const targetLinks: number[] = [];
    const targetDestinations: number[] = [];
    for (const element of targetElements) {
      const url = element.matches("a[href]") ? URL.parse(element.getAttribute("href")!, document.baseURI) : null;
      if (!url) {
        targetLinks.push(element.matches("a[href]") ? 4 : 0);
        targetDestinations.push(-1);
        continue;
      }
      if (!/^https?:$/.test(url.protocol) || element.hasAttribute("download")) targetLinks.push(4);
      else if (url.hash && url.href.split("#")[0] === location.href.split("#")[0]) targetLinks.push(3);
      else targetLinks.push(url.origin === location.origin ? 1 : 2);
      if (!destinationIdByHref.has(url.href)) destinationIdByHref.set(url.href, destinationIdByHref.size);
      targetDestinations.push(destinationIdByHref.get(url.href)!);
    }

    const time = Date.now();
    const seq = clickSeq++;
    const id = `${pageId}-${seq}`;
    const trace: Record<string, unknown> = {
      time,
      device,
      viewport: [innerWidth, innerHeight],
      samples: pointerSamples.map((sample) =>
        [sample.t - event.timeStamp, sample.x, sample.y, sample.predictedX, sample.predictedY]
          .map(roundToTenth)
          .concat(sample.foresightFrame ? 1 : 0, roundToTenth(sample.scrollX), roundToTenth(sample.scrollY)),
      ),
      targets: targetRects.map(rectToArray),
      clicked,
      // Separates clicks on clickable elements the selector misses from real misses, when `clicked` is -1.
      pointerCursor: getComputedStyle(event.target as Element).cursor === "pointer",
      version: 2,
      id,
      page: pageId,
      seq,
      sinceLoad: Math.round(event.timeStamp),
      dpr: devicePixelRatio,
      click: [event.clientX, event.clientY].map(roundToTenth),
      modifiers: (event.shiftKey ? 1 : 0) | (event.ctrlKey ? 2 : 0) | (event.altKey ? 4 : 0) | (event.metaKey ? 8 : 0),
      targetIds: targetElements.map((element) => {
        if (!targetIdByElement.has(element)) targetIdByElement.set(element, nextTargetId++);
        return targetIdByElement.get(element)!;
      }),
      // The nearest enclosing element that is also a visible target.
      targetParents: targetElements.map((element) => {
        for (let ancestor = element.parentElement?.closest(TARGET_SELECTOR); ancestor; ancestor = ancestor.parentElement?.closest(TARGET_SELECTOR)) {
          if (targetIndexByElement.has(ancestor)) return targetIndexByElement.get(ancestor)!;
        }
        return -1;
      }),
      targetLinks,
      targetDestinations,
    };

    // Scrolling in the sample window: the page first, then inner elements.
    for (const [element, scrollEvents] of scrollEventsByElement) {
      if (scrollEvents.at(-1)![0] < event.timeStamp - SAMPLE_WINDOW_MS) scrollEventsByElement.delete(element);
    }
    const scrolledElements = [...scrollEventsByElement.keys()].sort(
      (a, b) => Number(b === document.scrollingElement) - Number(a === document.scrollingElement),
    );
    if (scrolledElements.length > 0) {
      trace.scrollers = scrolledElements.map((element) => ({
        page: element === document.scrollingElement,
        events: scrollEventsByElement
          .get(element)!
          .filter(([t]) => t >= event.timeStamp - SAMPLE_WINDOW_MS)
          .map(([t, left, top]) => [msBeforeClick(t), roundToTenth(left), roundToTenth(top)]),
      }));
      trace.targetScrollers = targetElements.map((target) => scrolledElements.flatMap((element, index) => (element.contains(target) ? [index] : [])));
      // Geometry just before the latest burst; null where it wasn't measured.
      if (burstWheelSnapshot) {
        const { t, scrollOffsets, targetRects: rectsBeforeScroll } = burstWheelSnapshot;
        trace.scrollSnapshot = {
          t: msBeforeClick(t),
          scrollers: scrolledElements.map((element) => scrollOffsets.get(element)?.map(roundToTenth) ?? null),
          targets: targetElements.map((element) => (rectsBeforeScroll.has(element) ? rectToArray(rectsBeforeScroll.get(element)!) : null)),
        };
      }
    }
    chrome.storage.local.set({ [`trace:${time}:${id}`]: trace });

    pendingOutcome = {
      id,
      downTime: event.timeStamp,
      press: [[0, event.clientX, event.clientY]],
      activeElementBefore: document.activeElement,
      hrefBefore: location.href,
      mutationsBefore: countMutations(event.timeStamp - OUTCOME_WINDOW_MS, event.timeStamp),
      urlPoll: setInterval(() => checkPendingNavigation(performance.now(), false), 50),
    };
  },
  { capture: true, passive: true },
);

addEventListener(
  "pointerup",
  (event) => {
    if (!pendingOutcome || pendingOutcome.endTime !== undefined || !event.isTrusted || event.pointerType !== "mouse" || event.button !== 0) return;
    pendingOutcome.endTime = event.timeStamp;
    pendingOutcome.up = [event.timeStamp - pendingOutcome.downTime, event.clientX, event.clientY];
    pendingOutcome.cancelled = false;
    scheduleOutcomeMeasurement(pendingOutcome);
  },
  { capture: true, passive: true },
);

addEventListener(
  "pointercancel",
  (event) => {
    if (!pendingOutcome || pendingOutcome.endTime !== undefined || event.pointerType !== "mouse") return;
    pendingOutcome.endTime = event.timeStamp;
    pendingOutcome.cancelled = true;
    scheduleOutcomeMeasurement(pendingOutcome);
  },
  { capture: true, passive: true },
);

// A mouse click belongs to the pending press once its pointerup has been seen. Keyboard clicks have no pointerType.
addEventListener(
  "click",
  (event) => {
    if (pendingOutcome?.up && event.isTrusted && event.pointerType === "mouse" && event.button === 0) {
      pendingOutcome.clicked = true;
      pendingOutcome.clickCount = event.detail;
    }
  },
  { capture: true, passive: true },
);

addEventListener("pagehide", () => checkPendingNavigation(performance.now(), true, true));

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
