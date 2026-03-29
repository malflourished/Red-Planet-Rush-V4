/** Single writer for ship integrity: stats.shipIntegrity (canonical), stats.hull + ship.integrity mirrors. */

function clampHull(n) {
  return Math.max(0, Math.min(100, n));
}

/** @param {object} gs gameState */
export function setShipIntegrity(gs, value) {
  const v = clampHull(Number(value));
  gs.stats.shipIntegrity = v;
  gs.stats.hull = v;
  gs.ship.integrity = v;
}

/** @param {object} gs gameState */
export function addShipIntegrity(gs, delta) {
  const cur = Number.isFinite(gs.stats.shipIntegrity)
    ? gs.stats.shipIntegrity
    : Number.isFinite(gs.stats.hull)
      ? gs.stats.hull
      : 100;
  setShipIntegrity(gs, cur + delta);
}

/** Reconcile hull mirrors from canonical shipIntegrity (or hull if integrity missing). */
export function syncHullIntegrity(gs) {
  const a = gs.stats.shipIntegrity;
  const b = gs.stats.hull;
  const base = Number.isFinite(a) ? a : Number.isFinite(b) ? b : 100;
  setShipIntegrity(gs, base);
}
