/**
 * Scheduler — frame timing primitives for Red Planet Rush.
 *
 * Goals:
 *  - One canonical "now" source for animation timing (performance.now()).
 *  - Coalesce render() calls into a single rAF tick so canvas paths can
 *    request a re-render without forcing a synchronous DOM pass.
 *  - Provide a consistent time helper that gameplay loops can use to
 *    accumulate days without drift.
 *
 * This module intentionally has no game logic; consumers wire it up.
 */

/** Monotonic clock in ms; safe in non-DOM contexts (returns 0 there). */
export function now() {
  if (typeof performance !== "undefined" && typeof performance.now === "function") {
    return performance.now();
  }
  return Date.now();
}

let _renderFn = null;
let _pendingFrame = null;
let _dirty = false;

/**
 * Register the canonical render function once at boot.
 * @param {() => void} renderFn
 */
export function setRenderFunction(renderFn) {
  _renderFn = renderFn;
}

/**
 * Request a re-render on the next animation frame.
 * Multiple calls in the same frame are coalesced into one render().
 * Safe to call from canvas draw paths or async callbacks.
 */
export function scheduleRender() {
  if (!_renderFn) return;
  _dirty = true;
  if (_pendingFrame !== null) return;
  _pendingFrame = requestAnimationFrame(() => {
    _pendingFrame = null;
    if (!_dirty) return;
    _dirty = false;
    try {
      _renderFn();
    } catch (err) {
      console.error("[scheduler] render() threw:", err);
    }
  });
}

/**
 * Run render() immediately and clear any pending dirty flag.
 * Use only when callers genuinely need a synchronous DOM pass
 * (e.g. tab switch, modal open).
 */
export function flushRender() {
  if (!_renderFn) return;
  if (_pendingFrame !== null) {
    cancelAnimationFrame(_pendingFrame);
    _pendingFrame = null;
  }
  _dirty = false;
  _renderFn();
}

/**
 * Discrete map zoom scale table. Centralized so wheel/touch/keyboard
 * handlers all agree on the same level → factor mapping.
 */
export const ZOOM_SCALES = Object.freeze({
  1: 1.2,
  2: 2.4,
  3: 3.6,
  4: 4.8,
  5: 6.0,
  6: 8.4,
  7: 12.0,
});

export const MIN_CONTINUOUS_ZOOM = 1.2;
export const MAX_CONTINUOUS_ZOOM = 12.0;

/**
 * Resolve the effective continuous zoom value for the given travel state.
 * Used to seed `mapZoomContinuous` when switching from discrete to
 * continuous zoom across wheel/touch/keyboard inputs.
 * @param {{mapZoomLevel: number, mapZoomFine: number}} travel
 * @returns {number}
 */
export function resolveDiscreteZoom(travel) {
  const base = ZOOM_SCALES[travel.mapZoomLevel] || ZOOM_SCALES[1];
  const fine = Number.isFinite(travel.mapZoomFine) ? travel.mapZoomFine : 1.0;
  return base * fine;
}
