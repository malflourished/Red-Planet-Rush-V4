/**
 * Asset Manifest — single source of truth for runtime asset paths.
 *
 * Conventions (Phase 5 cleanup target):
 *   assets/scenes/planets/<name>.png
 *   assets/scenes/outposts/<imageSetId>/<scene>.png
 *   assets/scenes/stations/<scene>-<instanceId>.jpg
 *   assets/scenes/asteroids/arrival/asteroid_arrival_<NN>.png
 *   assets/scenes/asteroids/surface/asteroid_surface_<NN>.png   (target — see Note)
 *   assets/scenes/ships/ships-<NN>_<scene>.png
 *   assets/items/supplies/<itemId>.png
 *
 * Note on asteroid surface paths:
 *   The current shipped path includes a `midjourney_session/` segment, which
 *   is a tool/source artifact and shouldn't appear in runtime URLs. We keep
 *   it here to preserve behavior; once the asteroid surface assets are
 *   moved to `assets/scenes/asteroids/surface/`, flip
 *   `ASTEROID_SURFACE_DIR` to `"assets/scenes/asteroids/surface"`.
 */

// ----- Planets -----------------------------------------------------------

const PLANET_PATHS = {
  earth: "assets/scenes/planets/earth.png",
  moon: "assets/scenes/planets/moon.png",
  mars: "assets/scenes/planets/mars-01.png",
};

/**
 * Path for a top-level planet image.
 * @param {"earth"|"moon"|"mars"} key
 * @returns {string|null}
 */
export function planetImage(key) {
  return PLANET_PATHS[key] || null;
}

// ----- Asteroid surfaces -------------------------------------------------

// TODO: switch to "assets/scenes/asteroids/surface" once content is migrated.
const ASTEROID_SURFACE_DIR = "assets/scenes/asteroids/surface/midjourney_session";

/**
 * @param {string} number 2- or 3-digit asteroid surface index.
 * @returns {string}
 */
export function asteroidSurfaceImage(number) {
  return `${ASTEROID_SURFACE_DIR}/asteroid_surface_${number}.png`;
}

/** Returns the full list of available asteroid surface index strings. */
export function asteroidSurfaceNumbers() {
  const out = [];
  for (let i = 1; i <= 23; i++) {
    out.push(i < 10 ? String(i).padStart(2, "0") : String(i).padStart(3, "0"));
  }
  return out;
}

// ----- Asteroid arrivals -------------------------------------------------

export function asteroidArrivalImage(number) {
  return `assets/scenes/asteroids/arrival/asteroid_arrival_${number}.png`;
}

// ----- Outposts ----------------------------------------------------------

/**
 * @param {string} imageSetId e.g. "outpost-01"
 * @param {string} sceneName lowercase scene name, e.g. "arrival"|"interior"
 */
export function outpostImage(imageSetId, sceneName) {
  return `assets/scenes/outposts/${imageSetId}/${sceneName}.png`;
}

// ----- Stations ----------------------------------------------------------

/**
 * @param {string} sceneName
 * @param {string} instanceId
 */
export function stationImage(sceneName, instanceId) {
  return `assets/scenes/stations/${sceneName}-${instanceId}.jpg`;
}

// ----- Ships -------------------------------------------------------------

export function shipImage(imageNumber, sceneName) {
  return `assets/scenes/ships/ships-${imageNumber}_${sceneName}.png`;
}

// ----- Items / Supplies --------------------------------------------------

const SUPPLY_IMAGE_MAP = Object.freeze({
  // Air canisters
  air_canister_s: "assets/items/supplies/air-canister_small.png",
  air_canister_m: "assets/items/supplies/air-canister_medium.png",
  air_canister_l: "assets/items/supplies/air-canister_large.png",

  // Life support refills
  life_refill_5: "assets/items/supplies/life-support_option-01.png",
  life_refill_10: "assets/items/supplies/life-support_option-01.png",
  life_refill_full: "assets/items/supplies/life-support_option-01.png",

  // Medical (general)
  med_gel: "assets/items/supplies/med-kit_small.png",
  stimulant_kit: "assets/items/supplies/med-kit_medium.png",
  nutrient_rations: "assets/items/supplies/med-kit_small.png",

  // Medical (station-only)
  antibiotics: "assets/items/supplies/antibiotics_option-01.png",
  trauma_kit: "assets/items/supplies/med-kit_medium.png",
  sedative: "assets/items/supplies/syringe_option-01.png",
});

/**
 * @param {string} supplyId
 * @returns {string|null}
 */
export function supplyImage(supplyId) {
  return SUPPLY_IMAGE_MAP[supplyId] || null;
}
