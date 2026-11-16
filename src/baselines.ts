// Pure baseline predictors: no DOM, no chrome.*, so recorded traces can be replayed through them in Node.

/** A cursor position in client coordinates, with a `performance.now()` timestamp in ms. */
export type TimedPoint = { t: number; x: number; y: number };

/** A viewport rectangle. A `DOMRect` satisfies it. */
export type Rect = { left: number; top: number; right: number; bottom: number };

// Foresight.js ----------
// Port of the mouse rule from Foresight.js 4.3.0 (MIT, Bart Spaans, https://foresightjs.com), commit c7d8223,
// with its default settings: trajectoryPredictionTime 120, hitSlop 0.

/** How far back Foresight looks to measure velocity, in ms. */
export const FORESIGHT_VELOCITY_WINDOW_MS = 80;

/**
 * Function to extrapolate the cursor the way Foresight's `predictNextMousePosition` does: velocity is the
 * least-squares slope over the last 80 ms, and the reach grows with the log of the speed.
 * @param frameHistory One cursor position per processed frame, oldest first; the last is the current one.
 * @returns The predicted point, or the current point when the cursor isn't moving.
 */
export function predictForesightPoint(frameHistory: TimedPoint[]): { x: number; y: number } {
  const current = frameHistory[frameHistory.length - 1];
  let weightedDx = 0;
  let weightedDy = 0;
  let weight = 0;
  // Foresight keeps at most 32 past positions.
  for (let age = 1; age <= 32 && age < frameHistory.length; age++) {
    const past = frameHistory[frameHistory.length - 1 - age];
    const dt = current.t - past.t;
    if (dt > FORESIGHT_VELOCITY_WINDOW_MS) break;
    weightedDx += dt * (current.x - past.x);
    weightedDy += dt * (current.y - past.y);
    weight += dt * dt;
  }
  const vx = weight === 0 ? 0 : weightedDx / weight;
  const vy = weight === 0 ? 0 : weightedDy / weight;
  const speed = Math.hypot(vx, vy);
  if (speed === 0) return { x: current.x, y: current.y };
  // Assumes harder braking at higher speed: 200 px * ln(1 + speed * 120 ms / 200 px).
  const reach = 200 * Math.log1p((speed * 120) / 200);
  return { x: current.x + (vx / speed) * reach, y: current.y + (vy / speed) * reach };
}

/**
 * Function to test whether a line segment crosses or lies inside a rectangle (Liang-Barsky clipping).
 * @param from Start of the segment.
 * @param to End of the segment.
 * @param rect The rectangle, edges inclusive.
 * @returns True if any part of the segment is inside the rectangle.
 */
export function segmentIntersectsRect(
  from: { x: number; y: number },
  to: { x: number; y: number },
  rect: Rect,
): boolean {
  let tEnter = 0;
  let tExit = 1;
  const dx = to.x - from.x;
  const dy = to.y - from.y;
  // Each edge as (p, q): the segment is inside that edge where p * t <= q.
  const edges: [number, number][] = [
    [-dx, from.x - rect.left],
    [dx, rect.right - from.x],
    [-dy, from.y - rect.top],
    [dy, rect.bottom - from.y],
  ];
  for (const [p, q] of edges) {
    if (p === 0) {
      if (q < 0) return false;
    } else if (p < 0) {
      const r = q / p;
      if (r > tExit) return false;
      if (r > tEnter) tEnter = r;
    } else {
      const r = q / p;
      if (r < tEnter) return false;
      if (r < tExit) tExit = r;
    }
  }
  return tEnter <= tExit;
}
