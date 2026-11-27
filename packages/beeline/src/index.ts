// beeline: each element's chance of being clicked within the next moment (the weights' `withinMs`), from how the
// cursor is moving. While a frame callback is added, it collects every visible target, keeps the last second of cursor
// samples, and runs the model once per animation frame while the cursor moves.

import { predictTargetProbabilities, type ModelWeights, type Rect, type TimedPoint } from "./model.ts";
import { TARGET_SELECTOR } from "./targets.ts";

export type { ModelWeights, Rect, TimedPoint };
export { TARGET_SELECTOR };
export { prefetchLinks } from "./prefetch.ts";
export { fineTune } from "./finetune.ts";
export { selectTrainingClicks, type Trace } from "./traces.ts";

export type BeelineOptions = {
  /** Weights to run instead of the bundled default, which is trained on other people (AdSERP), such as weights fitted to this user. */
  weights?: ModelWeights;
};

/** One frame of predictions: every visible target, its rectangle and its probability, at the same indexes. */
export type BeelineFrame = { targetElements: Element[]; targetRects: DOMRect[]; probabilities: number[]; history: TimedPoint[] };

const SAMPLE_WINDOW_MS = 1000;

/**
 * Function to set up beeline. Nothing is tracked, and the model isn't loaded, until a frame callback is added, and
 * nothing ever is during server-side rendering or on touch-only devices, where there's no cursor to follow.
 * @param options The weights to run.
 * @returns Functions to follow frames, read the targets, and stop.
 */
export function createBeeline({ weights }: BeelineOptions = {}) {
  const canTrack = typeof window !== "undefined" && matchMedia("(any-pointer: fine)").matches;

  // Targets ----------

  // The visible targets and their viewport rectangles, at the same indexes.
  let targetElements: Element[] = [];
  let targetRects: DOMRect[] = [];
  // Only kept up to date while tracking; otherwise every call re-measures.
  let targetRectsStale = true;

  /**
   * Function to re-measure the visible targets, if they may have moved.
   * @returns The visible targets and their rectangles.
   */
  function measureTargets(): { targetElements: Element[]; targetRects: DOMRect[] } {
    if (targetRectsStale || !listening) {
      targetRectsStale = false;
      targetElements = [];
      targetRects = [];
      // While a modal dialog is open, the page behind it can't be clicked.
      const clickableRoot = document.querySelector("dialog:modal") ?? document.documentElement;
      for (const element of clickableRoot.querySelectorAll(TARGET_SELECTOR)) {
        const rect = element.getBoundingClientRect();
        const onScreen = rect.right > 0 && rect.bottom > 0 && rect.left < innerWidth && rect.top < innerHeight;
        if (onScreen && rect.width > 0 && rect.height > 0) {
          targetElements.push(element);
          targetRects.push(rect);
        }
      }
    }
    return { targetElements, targetRects };
  }

  // Frames ----------

  const frameCallbacks = new Set<(frame: BeelineFrame) => void>();

  /**
   * Function to call `callback` with every target's probability on each frame the model runs.
   * @param callback Called with the frame.
   * @returns A function that stops the calls.
   */
  function onFrame(callback: (frame: BeelineFrame) => void): () => void {
    frameCallbacks.add(callback);
    startTracking();
    return () => {
      frameCallbacks.delete(callback);
      stopTrackingIfIdle();
    };
  }

  // Tracking ----------

  // Cursor samples from the last second.
  const pointerSamples: TimedPoint[] = [];
  // When the page or any element last scrolled. Only later samples are used, since the trajectory no longer lines up
  // with the targets once they move.
  let lastScrollTime = -Infinity;
  let frameRequest: number | undefined;
  let listening: AbortController | undefined;
  let mutationObserver: MutationObserver | undefined;

  /**
   * Function to run the model on the samples since the last scroll, and pass the result to the frame callbacks.
   * @returns Nothing.
   */
  function runModelFrame(): void {
    frameRequest = undefined;
    if (!weights) return;
    const history = pointerSamples.filter((sample) => sample.t > lastScrollTime);
    if (history.length === 0) return;
    const { targetElements, targetRects } = measureTargets();
    if (targetRects.length === 0) return;
    const probabilities = predictTargetProbabilities(weights, history, targetRects);
    for (const callback of frameCallbacks) callback({ targetElements, targetRects, probabilities, history });
  }

  /**
   * Function to start listening to the cursor, scrolling and DOM changes, if it isn't already.
   * @returns Nothing.
   */
  function startTracking(): void {
    if (listening || !canTrack) return;
    listening = new AbortController();
    const listenerOptions = { capture: true, passive: true, signal: listening.signal };
    // Loaded the first time tracking starts, so pages that never add a frame callback don't download it.
    if (!weights) import("./default-weights.json").then((module) => (weights = module.default as ModelWeights));
    targetRectsStale = true;
    mutationObserver = new MutationObserver(() => (targetRectsStale = true));
    mutationObserver.observe(document.documentElement, { childList: true, subtree: true, attributes: true });
    addEventListener("resize", () => (targetRectsStale = true), listenerOptions);

    addEventListener(
      "pointermove",
      (event) => {
        if (!event.isTrusted || event.pointerType !== "mouse") return;
        // getCoalescedEvents is only exposed in secure contexts.
        for (const { timeStamp: t, clientX: x, clientY: y } of isSecureContext ? event.getCoalescedEvents() : [event]) pointerSamples.push({ t, x, y });
        pointerSamples.splice(0, pointerSamples.findIndex((sample) => sample.t >= event.timeStamp - SAMPLE_WINDOW_MS));
        // At most once per frame, and only on frames with movement.
        frameRequest ??= requestAnimationFrame(runModelFrame);
      },
      listenerOptions,
    );

    addEventListener(
      "scroll",
      (event) => {
        lastScrollTime = event.timeStamp;
        targetRectsStale = true;
      },
      listenerOptions,
    );
  }

  /**
   * Function to stop listening once no frame callback is left.
   * @returns Nothing.
   */
  function stopTrackingIfIdle(): void {
    if (!listening || frameCallbacks.size > 0) return;
    listening.abort();
    listening = undefined;
    mutationObserver!.disconnect();
    if (frameRequest !== undefined) cancelAnimationFrame(frameRequest);
    frameRequest = undefined;
    pointerSamples.length = 0;
  }

  return {
    onFrame,
    measureTargets,
    /**
     * Function to stop tracking and drop every frame callback.
     * @returns Nothing.
     */
    destroy(): void {
      frameCallbacks.clear();
      stopTrackingIfIdle();
    },
  };
}
