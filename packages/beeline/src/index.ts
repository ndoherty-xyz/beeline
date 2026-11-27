// beeline: each element's chance of being clicked within the next moment (the weights' `withinMs`), from how the
// cursor is moving. While anything is watched, it collects every visible target, keeps the last second of cursor
// samples, and runs the model once per animation frame while the cursor moves.

import { predictTargetProbabilities, type ModelWeights, type Rect, type TimedPoint } from "./model.ts";
import { TARGET_SELECTOR } from "./targets.ts";

export type { ModelWeights, Rect, TimedPoint };
export { TARGET_SELECTOR };
export { prefetchLinks, type PrefetchOptions } from "./prefetch.ts";
export { fineTune, type FineTuneOptions } from "./finetune.ts";
export { selectTrainingClicks, type Trace } from "./traces.ts";

export type BeelineOptions = {
  /** Which elements count as targets. The model compares every target with the others, so this should cover all clickable elements. */
  targets?: string;
  /** The custom property written on watched elements with their probability, or false for none. */
  cssVariable?: string | false;
  /** Weights to run instead of the bundled default, which is trained on other people (AdSERP), such as weights fitted to this user. */
  weights?: ModelWeights;
};

/** One frame of predictions: every visible target, its rectangle and its probability, at the same indexes. */
export type BeelineFrame = { targetElements: Element[]; targetRects: DOMRect[]; probabilities: number[]; history: TimedPoint[] };

/** Called with the element's probability whenever it changes. */
export type ProbabilityCallback = (probability: number) => void;

const SAMPLE_WINDOW_MS = 1000;

/**
 * Function to set up beeline. Nothing is tracked, and the model isn't loaded, until an element is watched, and
 * nothing ever is during server-side rendering or on touch-only devices, where there's no cursor to follow.
 * @param options Which elements count as targets, the CSS variable to write, and the weights to run.
 * @returns Functions to watch elements, read the targets, and stop.
 */
export function createBeeline({ targets = TARGET_SELECTOR, cssVariable = "--beeline-p", weights }: BeelineOptions = {}) {
  const canTrack = typeof window !== "undefined" && matchMedia("(any-pointer: fine)").matches;

  // Targets ----------

  // The visible targets and their viewport rectangles, at the same indexes.
  let targetElements: Element[] = [];
  let targetRects: DOMRect[] = [];
  // Only kept up to date while tracking; otherwise every call re-measures.
  let targetRectsStale = true;

  /**
   * Function to re-measure the visible targets, if they may have moved. Watched elements count even when the
   * selector misses them.
   * @returns The visible targets and their rectangles.
   */
  function measureTargets(): { targetElements: Element[]; targetRects: DOMRect[] } {
    if (targetRectsStale || !listening) {
      targetRectsStale = false;
      targetElements = [];
      targetRects = [];
      // While a modal dialog is open, the page behind it can't be clicked.
      const clickableRoot = document.querySelector("dialog:modal") ?? document.documentElement;
      const unmatchedWatched = [...watchedElements.keys()].filter((element) => !element.matches(targets) && clickableRoot.contains(element));
      for (const element of [...clickableRoot.querySelectorAll(targets), ...unmatchedWatched]) {
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

  // Watchers ----------

  const watchedElements = new Map<Element, { probability: number; watchers: Set<{ callback?: ProbabilityCallback }> }>();
  const frameCallbacks = new Set<(frame: BeelineFrame) => void>();

  /**
   * Function to update each watched element whose probability changed: its CSS variable, then its callbacks.
   * @param probabilityOf The probability of a given element.
   * @returns Nothing.
   */
  function notifyWatchers(probabilityOf: (element: Element) => number): void {
    for (const [element, watched] of watchedElements) {
      const probability = probabilityOf(element);
      if (probability === watched.probability) continue;
      watched.probability = probability;
      if (cssVariable) (element as HTMLElement).style?.setProperty(cssVariable, probability.toFixed(3));
      for (const { callback } of watched.watchers) callback?.(probability);
    }
  }

  /**
   * Function to follow an element's probability of being clicked: written to its CSS variable, and passed to
   * `callback` whenever it changes.
   * @param element The element to watch.
   * @param callback Called with the probability, between 0 and 1. Leave it out to only set the CSS variable.
   * @returns A function that stops watching.
   */
  function watch(element: Element, callback?: ProbabilityCallback): () => void {
    const watcher = { callback };
    if (!watchedElements.has(element)) {
      watchedElements.set(element, { probability: 0, watchers: new Set() });
      targetRectsStale = true;
    }
    watchedElements.get(element)!.watchers.add(watcher);
    startTracking();
    return () => {
      const watched = watchedElements.get(element);
      if (!watched?.watchers.delete(watcher) || watched.watchers.size > 0) return;
      watchedElements.delete(element);
      if (cssVariable) (element as HTMLElement).style?.removeProperty(cssVariable);
      stopTrackingIfIdle();
    };
  }

  /**
   * Function to run `enter` when the element's probability rises to `above`, and `leave` when it falls below `below`.
   * A lower `below` stops the actions flickering while the probability hovers around one number.
   * @param element The element to watch.
   * @param thresholds `above` to enter, and `below` to leave (default: `above`).
   * @param actions What to run on entering and leaving; with `once`, stop watching after the first enter.
   * @returns A function that stops watching.
   */
  function when(
    element: Element,
    { above, below = above }: { above: number; below?: number },
    { enter, leave, once = false }: { enter?: () => void; leave?: () => void; once?: boolean },
  ): () => void {
    let entered = false;
    const stopWatching = watch(element, (probability) => {
      if (!entered && probability >= above) {
        entered = true;
        enter?.();
        if (once) stopWatching();
      } else if (entered && probability < below) {
        entered = false;
        leave?.();
      }
    });
    return stopWatching;
  }

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
   * Function to run the model on the samples since the last scroll, and pass the result to watchers and frame callbacks.
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
    const indexByElement = new Map(targetElements.map((element, index) => [element, index]));
    notifyWatchers((element) => probabilities[indexByElement.get(element) ?? -1] ?? 0);
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
    // Loaded the first time tracking starts, so pages that never watch anything don't download it.
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
        notifyWatchers(() => 0);
      },
      listenerOptions,
    );
  }

  /**
   * Function to stop listening once nothing is watched.
   * @returns Nothing.
   */
  function stopTrackingIfIdle(): void {
    if (!listening || watchedElements.size > 0 || frameCallbacks.size > 0) return;
    listening.abort();
    listening = undefined;
    mutationObserver!.disconnect();
    if (frameRequest !== undefined) cancelAnimationFrame(frameRequest);
    frameRequest = undefined;
    pointerSamples.length = 0;
  }

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
      if (cssVariable) for (const element of watchedElements.keys()) (element as HTMLElement).style?.removeProperty(cssVariable);
      watchedElements.clear();
      frameCallbacks.clear();
      stopTrackingIfIdle();
    },
  };
}
