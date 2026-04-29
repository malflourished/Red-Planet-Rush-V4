/**
 * Time — advanceDays() and per-day hooks.
 *
 * The single writer for `gameState.stats.day` and life support drain.
 * All time-consuming actions in the game must funnel through advanceDays().
 *
 * A factory pattern is used so main.js can inject the per-day hooks it
 * already owns (artifact carry risk, crew degradation) without us having
 * to drag those systems into this module yet.
 */

import { debugLog } from "./debug.js";

const LIFE_SUPPORT_DRAIN_PER_DAY = 100 / 30; // 30 days = full drain

/**
 * @param {object} deps
 * @param {object} deps.gameState
 * @param {(days: number) => void} [deps.processArtifactCarryRisks]
 * @param {(days: number) => void} [deps.processCrewDegradation]
 * @param {() => number} [deps.getLifeSupportDrainMultiplier]
 * @param {() => void} [deps.onAfterAdvance]
 * @returns {(days: number, lifeSupportMultiplier?: number) => void}
 */
export function createAdvanceDays(deps) {
  const { gameState } = deps;
  const processArtifactCarryRisks = deps.processArtifactCarryRisks || (() => {});
  const processCrewDegradation = deps.processCrewDegradation || (() => {});
  const getLifeSupportDrainMultiplier = deps.getLifeSupportDrainMultiplier || (() => 1);
  const onAfterAdvance = deps.onAfterAdvance || (() => {});

  return function advanceDays(days, lifeSupportMultiplier = 1) {
    const d = Math.max(0, Math.floor(days));
    if (d === 0) return;

    gameState.stats.day += d;

    const shipLeakMultiplier = Math.max(0, Number(getLifeSupportDrainMultiplier()) || 0);
    const drainMultiplier = Math.max(0, Number(lifeSupportMultiplier) || 0) * shipLeakMultiplier;
    const lifeSupportDrain = d * LIFE_SUPPORT_DRAIN_PER_DAY * drainMultiplier;
    const before = gameState.stats.lifeSupport;
    gameState.stats.lifeSupport = Math.max(0, before - lifeSupportDrain);

    if (gameState.stats.lifeSupport <= 0) {
      console.warn(`[advanceDays] Life support depleted! Day ${gameState.stats.day}`);
      // TODO: trigger game over state
    }

    processArtifactCarryRisks(d);
    processCrewDegradation(d);
    onAfterAdvance();

    if (before !== gameState.stats.lifeSupport) {
      debugLog(
        `[advanceDays] +${d}d  life ${before.toFixed(1)}% → ${gameState.stats.lifeSupport.toFixed(1)}%`,
      );
    }
  };
}
