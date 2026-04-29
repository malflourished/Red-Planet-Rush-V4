/**
 * Route — Moon→Mars travel route generation and cumulative travel time.
 *
 * Pure data + helpers; no DOM, no canvas, no gameState reads.
 * Behavior preserved 1:1 from the previous inline implementation in main.js.
 */

// Total Moon-to-Mars journey is 300 days. The base structure totals 20 days
// (2+3+2+3+2+3+5), so we scale by 300/20 = 15 to land on 300.
export const ROUTE_SCALE_FACTOR = 15;
export const TOTAL_MOON_TO_MARS_DAYS = 300;

// Orbital constants (days)
export const EARTH_ORBITAL_PERIOD = 365;
export const MARS_ORBITAL_PERIOD = 687;

// Ship travel constants (ring units / day)
export const SHIP_SPEED = 0.04;
export const GAME_DEADLINE = 300;
export const MARS_ORBITAL_PROGRESS = GAME_DEADLINE / MARS_ORBITAL_PERIOD;

// Ring system: Earth at ring 1, Mars at ring 5.
export const EARTH_START_RING = 1;
export const MOON_START_RING = 1;
export const MARS_END_RING = 5;
export const TRAVELABLE_RING_RANGE = MARS_END_RING - MOON_START_RING;

/** Canonical route order for the Moon→Mars trip. */
export const ROUTE_ORDER = Object.freeze([
  "earth",
  "outpost-0",
  "station-01",
  "outpost-1",
  "station-02",
  "outpost-2",
  "station-03",
  "mars",
]);

/** Base segment template (unscaled). */
export const baseRouteStructure = {
  segments: [
    { from: "earth",      to: "outpost-0",  days: 2 * ROUTE_SCALE_FACTOR, intermediate: [] },
    { from: "outpost-0",  to: "station-01", days: 3 * ROUTE_SCALE_FACTOR, intermediate: [] },
    { from: "station-01", to: "outpost-1",  days: 2 * ROUTE_SCALE_FACTOR, intermediate: [] },
    { from: "outpost-1",  to: "station-02", days: 3 * ROUTE_SCALE_FACTOR, intermediate: [] },
    { from: "station-02", to: "outpost-2",  days: 2 * ROUTE_SCALE_FACTOR, intermediate: [] },
    { from: "outpost-2",  to: "station-03", days: 3 * ROUTE_SCALE_FACTOR, intermediate: [] },
    { from: "station-03", to: "mars",       days: 5 * ROUTE_SCALE_FACTOR, intermediate: [] },
  ],
};

/**
 * Generate randomized route segments with ±5 day variation per segment,
 * scaled proportionally so the total still equals TOTAL_MOON_TO_MARS_DAYS.
 *
 * @returns {Array<{from:string,to:string,days:number,intermediate:Array}>}
 */
export function generateRandomizedRoute() {
  const VARIATION_RANGE = 5; // ± days

  const randomized = baseRouteStructure.segments.map((segment) => {
    const variation = (Math.random() * 2 - 1) * VARIATION_RANGE;
    const days = Math.max(1, segment.days + variation);
    return {
      from: segment.from,
      to: segment.to,
      days,
      intermediate: [...segment.intermediate],
    };
  });

  const total = randomized.reduce((s, seg) => s + seg.days, 0);
  const scale = TOTAL_MOON_TO_MARS_DAYS / total;
  const scaled = randomized.map((seg) => ({
    ...seg,
    days: Math.round(seg.days * scale),
  }));

  // Adjust last segment to absorb rounding so the total is exactly 300.
  const finalTotal = scaled.reduce((s, seg) => s + seg.days, 0);
  const diff = TOTAL_MOON_TO_MARS_DAYS - finalTotal;
  if (diff !== 0 && scaled.length > 0) {
    scaled[scaled.length - 1].days += diff;
  }

  return scaled;
}

/**
 * Build a `{ locationId: cumulativeDaysFromEarth }` lookup for a given
 * randomized route segment list.
 *
 * @param {Array<{days:number}>} segments
 * @returns {Record<string, number>}
 */
export function calculateCumulativeTravelTimes(segments) {
  const cumulative = { earth: 0 };
  let total = 0;
  for (let i = 0; i < segments.length; i++) {
    total += segments[i].days;
    cumulative[ROUTE_ORDER[i + 1]] = total;
  }
  return cumulative;
}

/**
 * Calculate ring position based on cumulative travel time from Moon.
 * Ring = MOON_START_RING + (cumulativeDays / TOTAL_MOON_TO_MARS_DAYS) * TRAVELABLE_RING_RANGE
 *
 * @param {number} cumulativeDays
 * @returns {number}
 */
export function calculateRingFromTravelTime(cumulativeDays) {
  return MOON_START_RING + (cumulativeDays / TOTAL_MOON_TO_MARS_DAYS) * TRAVELABLE_RING_RANGE;
}

/**
 * Normalize an instance node id to its base route id.
 * "station-01-a" → "station-01", "earth" → "earth", "asteroid-12" → "asteroid-12".
 *
 * @param {string|null|undefined} nodeId
 * @returns {string|null}
 */
export function normalizeNodeIdForRoute(nodeId) {
  if (!nodeId) return null;
  if (ROUTE_ORDER.includes(nodeId)) return nodeId;
  for (const baseId of ROUTE_ORDER) {
    if (nodeId.startsWith(baseId + "-")) return baseId;
  }
  return nodeId;
}

/**
 * Get all four station instance ids for a base id.
 * @param {string} baseId
 * @returns {string[]}
 */
export function getStationInstances(baseId) {
  return ["a", "b", "c", "d"].map((s) => `${baseId}-${s}`);
}
