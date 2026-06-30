/** @typedef {{ segments: object[] }} RouteStructure */

const SAVE_STORAGE_KEY = "rpr_run_save_v1";

const TRAVEL_SET_KEYS = [
  "scannedNodes",
  "deepScannedNodes",
  "clearedAsteroids",
  "discoveredNodes",
  "revealedNodes",
  "activeRumorAsteroidIds",
  "completedRumorAsteroidIds",
  "rumoredNodes",
  "outpostRumorPendingIds",
];

/**
 * @param {object} travel
 */
function serializeTravel(travel) {
  const out = { ...travel };
  for (const key of TRAVEL_SET_KEYS) {
    if (travel[key] instanceof Set) {
      out[key] = [...travel[key]];
    }
  }
  return out;
}

/**
 * @param {object} gameState
 */
function serializeGameState(gameState) {
  return {
    meta: { ...gameState.meta },
    stats: { ...gameState.stats },
    travel: serializeTravel(gameState.travel),
    crew: {
      members: (gameState.crew.members || []).map((m) => ({ ...m })),
    },
    inventory: {
      supplies: JSON.parse(JSON.stringify(gameState.inventory.supplies || {})),
      parts: { ...gameState.inventory.parts },
      artifacts: (gameState.inventory.artifacts || []).map((a) => ({ ...a })),
    },
    log: {
      entries: (gameState.log.entries || []).map((e) => ({ ...e })),
      maxEntries: gameState.log.maxEntries,
      landingDraft: gameState.log.landingDraft
        ? { ...gameState.log.landingDraft }
        : null,
    },
    ship: JSON.parse(JSON.stringify(gameState.ship)),
  };
}

/**
 * @param {object} travel
 */
function hydrateTravel(travel) {
  for (const key of TRAVEL_SET_KEYS) {
    if (Array.isArray(travel[key])) {
      travel[key] = new Set(travel[key]);
    } else if (!(travel[key] instanceof Set)) {
      travel[key] = new Set();
    }
  }

  // Timers and overlays cannot survive a reload safely.
  travel.isWaiting = false;
  travel.waitIntervalId = null;
  travel.isTraveling = false;
  travel.travelProgress = 0;
  travel.travelStartLocationId = null;
  travel.travelDestinationId = null;
  travel.travelTotalDays = 0;
  travel.travelStartTime = null;
  travel.travelStartDay = 0;
  travel.travelAnimationId = null;
  travel.lockedGhostPosition = null;
  travel.animationLoopId = null;
  travel.isEventActive = false;
  travel.activeEvent = null;
  travel.activeContact = null;
  travel.isPanning = false;
  travel.hasPanned = false;
  travel.scanPulse = {
    isActive: false,
    startTime: null,
    duration: travel.scanPulse?.duration ?? 1000,
    maxRadius: travel.scanPulse?.maxRadius ?? 1.0,
    centerRing: null,
    centerAngle: null,
    isDeepScan: false,
  };
  travel.serviceOverlay = null;
  travel.generalStoreMode = null;
  travel.generalStoreCart = travel.generalStoreCart || {};
  travel.generalStoreCartTotal = travel.generalStoreCartTotal || 0;
  travel.traderMerchantActive = false;
  travel.traderMerchantCart = travel.traderMerchantCart || {};
  travel.traderMerchantCartTotal = travel.traderMerchantCartTotal || 0;
}

/**
 * @param {object} savedState
 */
function hydrateGameState(savedState) {
  const travel = savedState.travel;
  hydrateTravel(travel);
  return savedState;
}

/**
 * @param {object} gameState
 * @param {RouteStructure} routeStructure
 * @param {object[]} mapNodes
 */
export function saveRunToStorage(gameState, routeStructure, mapNodes) {
  if (gameState.meta.screen !== "PLAYING") {
    return false;
  }

  try {
    const payload = {
      version: 1,
      savedAt: Date.now(),
      routeStructure,
      mapNodes,
      gameState: serializeGameState(gameState),
    };
    localStorage.setItem(SAVE_STORAGE_KEY, JSON.stringify(payload));
    return true;
  } catch (err) {
    console.warn("[SAVE] Failed to persist run:", err);
    return false;
  }
}

/** @returns {object|null} */
export function loadRunFromStorage() {
  try {
    const raw = localStorage.getItem(SAVE_STORAGE_KEY);
    if (!raw) return null;
    const payload = JSON.parse(raw);
    if (!payload || payload.version !== 1) return null;
    if (!payload.gameState || !payload.routeStructure || !Array.isArray(payload.mapNodes)) {
      return null;
    }
    payload.gameState = hydrateGameState(payload.gameState);
    return payload;
  } catch (err) {
    console.warn("[SAVE] Failed to load run:", err);
    return null;
  }
}

export function clearRunSave() {
  try {
    localStorage.removeItem(SAVE_STORAGE_KEY);
  } catch {
    // ignore
  }
}

export function hasSavedRun() {
  return loadRunFromStorage() !== null;
}
