/**
 * When the trader merchant overlay is open, render() must not use the "missing scene"
 * fallback that forces currentSceneId back to MAP and hides the scene container.
 */
export function shouldSuppressTravelMapFallback(gameState) {
  return !!(gameState.travel.traderMerchantActive && gameState.travel.currentLocationId);
}
