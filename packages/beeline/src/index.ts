// beeline: each element's chance of being clicked within the next moment (the weights' `withinMs`), from how the
// cursor is moving. Collects every visible target, keeps the last second of cursor samples, and runs the model once
// per animation frame while the cursor moves.

import { predictTargetProbabilities, type ModelWeights, type Rect, type TimedPoint } from "./model.ts";
import { TARGET_SELECTOR } from "./targets.ts";

export type { ModelWeights, Rect, TimedPoint };
export { TARGET_SELECTOR };

export type BeelineOptions = {
  weights: ModelWeights;
  /** Which elements count as targets. The model compares every target with the others, so this should cover all clickable elements. */
  targets?: string;
};

/** One frame of predictions: every visible target, its rectangle and its probability, at the same indexes. */
export type BeelineFrame = { targetElements: Element[]; targetRects: DOMRect[]; probabilities: number[]; history: TimedPoint[] };

/** Called with the element's probability whenever it changes. */
export type ProbabilityCallback = (probability: number) => void;

const SAMPLE_WINDOW_MS = 1000;

/**
 * Function to start tracking the cursor and the page's targets.
 * @param options The weights, and optionally which elements count as targets.
 * @returns Functions to watch elements, read the targets, and stop.
 */
export function createBeeline({ weights, targets = TARGET_SELECTOR }: BeelineOptions) {
  const listening = new AbortController();
  const listenerOptions = { capture: true, passive: true, signal: listening.signal };

  // Targets ----------

  // The visible targets and their viewport rectangles, at the same indexes.
  let targetElements: Element[] = [];
  let targetRects: DOMRect[] = [];
  let targetRectsStale = true;

  /**
   * Function to re-measure the visible targets, if they've been marked stale. Watched elements count even when the
   * selector misses them.
   * @returns The visible targets and their rectangles.
   */
  function measureTargets(): { targetElements: Element[]; targetRects: DOMRect[] } {
    if (targetRectsStale) {
      targetRectsStale = false;
      targetElements = [];
      targetRects = [];
      const unmatchedWatched = [...watchersByElement.keys()].filter((element) => !element.matches(targets));
      for (const element of [...document.querySelectorAll(targets), ...unmatchedWatched]) {
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

  const mutationObserver = new MutationObserver(() => (targetRectsStale = true));
  mutationObserver.observe(document.documentElement, { childList: true, subtree: true, attributes: true });
  addEventListener("resize", () => (targetRectsStale = true), listenerOptions);

  // Watchers ----------

  const watchersByElement = new Map<Element, Set<{ callback: ProbabilityCallback; lastProbability: number }>>();
  const frameCallbacks = new Set<(frame: BeelineFrame) => void>();

  /**
   * Function to call each watcher whose element's probability changed.
   * @param probabilityOf The probability of a given element.
   * @returns Nothing.
   */
  function notifyWatchers(probabilityOf: (element: Element) => number): void {
    for (const [element, watchers] of watchersByElement) {
      const probability = probabilityOf(element);
      for (const watcher of watchers) {
        if (watcher.lastProbability === probability) continue;
        watcher.lastProbability = probability;
        watcher.callback(probability);
      }
    }
  }

  /**
   * Function to call `callback` with the element's probability of being clicked whenever it changes.
   * @param element The element to watch.
   * @param callback Called with the probability, between 0 and 1.
   * @returns A function that stops watching.
   */
  function watch(element: Element, callback: ProbabilityCallback): () => void {
    const watcher = { callback, lastProbability: 0 };
    if (!watchersByElement.has(element)) {
      watchersByElement.set(element, new Set());
      targetRectsStale = true;
    }
    watchersByElement.get(element)!.add(watcher);
    return () => {
      const watchers = watchersByElement.get(element);
      watchers?.delete(watcher);
      if (watchers?.size === 0) watchersByElement.delete(element);
    };
  }

  /**
   * Function to run `enter` when the element's probability rises to `above`, and `leave` when it falls below `below`.
   * A lower `below` stops the actions flickering while the probability hovers around one number.
   * @param element The element to watch.
   * @param thresholds `above` to enter, and `below` to leave (default: `above`).
   * @param actions What to run on entering and leaving.
   * @returns A function that stops watching.
   */
  function when(
    element: Element,
    { above, below = above }: { above: number; below?: number },
    { enter, leave }: { enter?: () => void; leave?: () => void },
  ): () => void {
    let entered = false;
    return watch(element, (probability) => {
      if (!entered && probability >= above) {
        entered = true;
        enter?.();
      } else if (entered && probability < below) {
        entered = false;
        leave?.();
      }
    });
  }

  /**
   * Function to call `callback` with every target's probability on each frame the model runs.
   * @param callback Called with the frame.
   * @returns A function that stops the calls.
   */
  function onFrame(callback: (frame: BeelineFrame) => void): () => void {
    frameCallbacks.add(callback);
    return () => frameCallbacks.delete(callback);
  }

  // Pointer ----------

  // Cursor samples from the last second.
  const pointerSamples: TimedPoint[] = [];
  // When the page or any element last scrolled. Only later samples are used, since the trajectory no longer lines up
  // with the targets once they move.
  let lastScrollTime = -Infinity;
  let frameRequest: number | undefined;

  addEventListener(
    "pointermove",
    (event) => {
      if (!event.isTrusted || event.pointerType !== "mouse") return;
      // getCoalescedEvents is only exposed in secure contexts.
      for (const { timeStamp: t, clientX: x, clientY: y } of isSecureContext ? event.getCoalescedEvents() : [event]) pointerSamples.push({ t, x, y });
      pointerSamples.splice(0, pointerSamples.findIndex((sample) => sample.t >= event.timeStamp - SAMPLE_WINDOW_MS));

      // Run the model at most once per frame, and only on frames with movement.
      if (frameRequest !== undefined || (watchersByElement.size === 0 && frameCallbacks.size === 0)) return;
      frameRequest = requestAnimationFrame(() => {
        frameRequest = undefined;
        const history = pointerSamples.filter((sample) => sample.t > lastScrollTime);
        if (history.length === 0) return;
        const { targetElements, targetRects } = measureTargets();
        if (targetRects.length === 0) return;
        const probabilities = predictTargetProbabilities(weights, history, targetRects);
        const indexByElement = new Map(targetElements.map((element, index) => [element, index]));
        notifyWatchers((element) => probabilities[indexByElement.get(element) ?? -1] ?? 0);
        for (const callback of frameCallbacks) callback({ targetElements, targetRects, probabilities, history });
      });
    },
    listenerOptions,
  );

  addEventListener(
    "scroll",
    (event) => {
      lastScrollTime = event.timeStamp;
      targetRectsStale = true;
      notifyWatchers(() => 0);
    },
    listenerOptions,
  );

  return {
    watch,
    when,
    onFrame,
    measureTargets,
    /**
     * Function to stop tracking and drop every watcher.
     * @returns Nothing.
     */
    destroy(): void {
      listening.abort();
      mutationObserver.disconnect();
      if (frameRequest !== undefined) cancelAnimationFrame(frameRequest);
      watchersByElement.clear();
      frameCallbacks.clear();
    },
  };
}
