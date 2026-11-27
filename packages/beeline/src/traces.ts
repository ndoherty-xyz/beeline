// The recorded trace format, and which recorded clicks the model trains on. Pure, so traces can be replayed in Node.

import type { Rect } from "./model.ts";

/** A click on nothing followed this closely by a click on a target counts as a retry. */
export const RETRY_GAP_MS = 1000;

/** One recorded click, as stored by the content script (see docs/prd.md, Recording traces). v2 fields are optional. */
export type Trace = {
  time: number;
  /** Set from a popup switch until v0.1.0; later traces leave it out. */
  device?: "mouse" | "trackpad";
  viewport: [number, number];
  /** [ms before click, x, y, predictedX, predictedY, foresightFrame, scrollX, scrollY], oldest first. v1 has no scroll columns. */
  samples: [number, number, number, number, number, 0 | 1, number?, number?][];
  /** [x, y, width, height] of every visible target. */
  targets: [number, number, number, number][];
  /** Index of the clicked target, or -1 when the click hit none. */
  clicked: number;
  /** Whether the clicked element showed a pointer cursor. */
  pointerCursor: boolean;
  version?: 2;
  id?: string;
  /** Who recorded it, in converted public datasets (e.g. `adserp-p004`), to hold out whole people. */
  person?: string;
  page?: string;
  seq?: number;
  sinceLoad?: number;
  dpr?: number;
  click?: [number, number];
  modifiers?: number;
  detail?: number;
  targetIds?: number[];
  targetParents?: number[];
  /** 0 not a link, 1 same-origin, 2 cross-origin, 3 same document, 4 other. */
  targetLinks?: number[];
  targetDestinations?: number[];
  /** Elements that scrolled in the sample window, the page first: [ms before click, scrollLeft, scrollTop] per event. */
  scrollers?: { page: boolean; events: [number, number, number][] }[];
  targetScrollers?: number[][];
  /** Geometry measured on the wheel event before the latest scroll burst; null where not measured. */
  scrollSnapshot?: { t: number; scrollers: ([number, number] | null)[]; targets: (Trace["targets"][number] | null)[] };
  outcome?: Outcome;
};
/** What followed a click, joined in at export. A missing field means unknown. */
export type Outcome = {
  id: string;
  /** [ms after pointerdown, x, y] from pointerdown until pointerup. */
  press: [number, number, number][];
  up?: [number, number, number];
  cancelled?: boolean;
  clicked?: boolean;
  /** The click event's detail: 1 single, 2 double. */
  clickCount?: number;
  selection?: boolean;
  focusChanged?: boolean;
  /** When the URL first changed or the page was left; missing if no navigation was seen within watchedMs. */
  navigatedMs?: number;
  watchedMs?: number;
  mutationsBefore?: number;
  mutationsAfter?: number;
};

/**
 * Function to convert a trace's [x, y, width, height] target to a rectangle.
 * @param target The recorded target.
 * @returns Its rectangle.
 */
export function targetToRect([x, y, width, height]: Trace["targets"][number]): Rect {
  return { left: x, top: y, right: x + width, bottom: y + height };
}

/**
 * Function to keep only the samples after the last scroll event, which is all v1 recorded. Predictors run on these,
 * since the trajectory no longer lines up with the targets once they move.
 * @param trace The recorded click.
 * @returns Its samples after the last scroll, oldest first.
 */
export function samplesSinceLastScroll(trace: Trace): Trace["samples"] {
  const lastScrollTime = Math.max(...(trace.scrollers ?? []).flatMap((scroller) => scroller.events.map(([t]) => t)));
  return trace.samples.filter(([t]) => t > lastScrollTime);
}

/**
 * Function to tell whether the cursor moved onto the clicked target, rather than clicking where it already was
 * (e.g. moving the caret in a text box). Only these clicks have a movement to predict.
 * @param trace The recorded click.
 * @returns True if a target was clicked and the first sample is outside it.
 */
export function isAcquisition(trace: Trace): boolean {
  if (trace.clicked === -1 || trace.samples.length === 0) return false;
  const [, x, y] = trace.samples[0];
  const { left, top, right, bottom } = targetToRect(trace.targets[trace.clicked]);
  return x < left || x > right || y < top || y > bottom;
}

/**
 * Function to find clicks on empty space with no click on a target in the second after: movement that ended without
 * clicking anything, as close to "nothing about to be clicked" as the traces get.
 * @param traces The recorded clicks.
 * @returns Those clicks.
 */
export function findEmptyClicksWithoutRetry(traces: Trace[]): Trace[] {
  const traceById = new Map(traces.filter((trace) => trace.id).map((trace) => [trace.id!, trace]));
  return traces.filter((trace) => {
    if (trace.version !== 2 || trace.clicked !== -1 || trace.pointerCursor || trace.samples.length === 0) return false;
    const next = traceById.get(`${trace.page}-${trace.seq! + 1}`);
    return !next || next.clicked === -1 || next.time - trace.time > RETRY_GAP_MS;
  });
}

/**
 * Function to select clicks where the cursor moved onto the target or clicked nothing without a retry.
 * @param traces The recorded clicks.
 * @returns Clicks in time order, with samples since the last scroll.
 */
export function selectTrainingClicks(traces: Trace[]): Trace[] {
  const cutTraces = traces.map((trace) => ({ ...trace, samples: samplesSinceLastScroll(trace).sort((a, b) => a[0] - b[0]) }));
  return [...cutTraces.filter(isAcquisition), ...findEmptyClicksWithoutRetry(cutTraces)].sort((a, b) => a.time - b.time);
}
