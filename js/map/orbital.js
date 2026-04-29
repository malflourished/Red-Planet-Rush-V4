/**
 * Orbital math — pure helpers used to position nodes on the map.
 * No DOM, no canvas, no gameState.
 */

import { EARTH_ORBITAL_PERIOD, MARS_ORBITAL_PERIOD } from "./route.js";

/**
 * Angular position at a given day for a given orbital period and starting angle.
 * @param {number} day
 * @param {number} orbitalPeriod days per full revolution
 * @param {number} [initialAngle=0] radians
 * @returns {number} radians
 */
export function calculateOrbitalAngle(day, orbitalPeriod, initialAngle = 0) {
  return ((day / orbitalPeriod) * 2 * Math.PI) + initialAngle;
}

/**
 * Base (un-randomized) orbital period for a given location type.
 * @param {string} locationType
 * @returns {number} days
 */
export function getBaseOrbitalPeriod(locationType) {
  if (locationType === "mars") return MARS_ORBITAL_PERIOD;
  // Asteroids and ships use Earth's period as a base; everything else does too.
  return EARTH_ORBITAL_PERIOD;
}

/**
 * Sample a randomized orbital period for a location, mirroring the
 * distributions used in the original prototype:
 *   - ships:      tri-modal Fast/Average/Slow (75–600 days)
 *   - asteroids:  weighted Really Fast → Really Slow (100–500 days)
 *   - stations / outposts (ring known): ring-based period * (1±0.15)
 *   - other:      base period * (1±0.15)
 *
 * @param {string} locationType
 * @param {number|null} [ring=null]
 * @returns {number} days
 */
export function generateRandomOrbitalPeriod(locationType, ring = null) {
  const basePeriod = getBaseOrbitalPeriod(locationType);

  if (locationType === "ship") {
    const r = Math.random();
    if (r < 0.33) return Math.round(75 + Math.random() * 75);   // Fast
    if (r < 0.67) return Math.round(200 + Math.random() * 200); // Average
    return Math.round(400 + Math.random() * 200);               // Slow
  }

  if (locationType === "asteroid") {
    const r = Math.random();
    if (r < 0.05) return Math.round(100 + Math.random() * 19);  // Really Fast
    if (r < 0.40) return Math.round(120 + Math.random() * 79);  // Fast
    if (r < 0.70) return Math.round(200 + Math.random() * 199); // Average
    if (r < 0.95) return Math.round(400 + Math.random() * 50);  // Slow
    return Math.round(451 + Math.random() * 49);                // Really Slow
  }

  if ((locationType === "station" || locationType === "outpost") && ring !== null) {
    // Ring-based: 25% slower per ring (1.25^(ring-1)) ± 15%
    const ringBasedPeriod = EARTH_ORBITAL_PERIOD * Math.pow(1.25, ring - 1);
    const variation = Math.random() * 0.3 - 0.15;
    return Math.round(ringBasedPeriod * (1 + variation));
  }

  const variation = Math.random() * 0.3 - 0.15;
  return Math.round(basePeriod * (1 + variation));
}

/**
 * Random angle constrained to the forward arc (-π/2 .. +π/2). Used for
 * locations on the Moon→Mars route so they start between the two ends.
 * @returns {number} radians
 */
export function generateRandomInitialAngle() {
  return (Math.random() * Math.PI) - (Math.PI / 2);
}

/**
 * Full 360° random angle, used for asteroids and ships.
 * @returns {number} radians
 */
export function generateRandomFullAngle() {
  return Math.random() * Math.PI * 2;
}
