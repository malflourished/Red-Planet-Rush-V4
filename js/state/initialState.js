/**
 * Initial gameState factory.
 *
 * Documents the conceptual slices inside gameState while preserving the
 * runtime shape that the rest of main.js currently consumes. Once consumers
 * are migrated to slice-aware accessors we can flatten the structure
 * differently without breaking the file at the same time.
 *
 * Conceptual slices of `gameState.travel` (these all currently live on the
 * same flat object so existing `gameState.travel.<field>` access keeps
 * working):
 *
 *   navigation   currentLocationId / selected*Id / hovered / route guidance
 *                  - currentLocationId
 *                  - currentSceneId
 *                  - selectedDestinationId
 *                  - selectedLocationId
 *                  - hoveredNodeId
 *                  - lastResolutionText
 *                  - returnSceneId
 *                  - landingFlavorText
 *                  - nextStationBaseId
 *                  - broadcastStationInstanceId
 *
 *   mapCamera    discrete + continuous zoom + pan + drag state
 *                  - mapZoomLevel / mapZoomFine / mapZoomContinuous / useContinuousZoom
 *                  - mapPanX / mapPanY
 *                  - isPanning / hasPanned / panStart{X,Y,PanX,PanY}
 *
 *   timeFlow     wait + travel animation loops
 *                  - isWaiting / waitIntervalId
 *                  - isTraveling / travelProgress / travelStart* / travelTotalDays
 *                  - travelAnimationId / lockedGhostPosition
 *                  - animationLoopId
 *
 *   discovery    image set assignments + scan results
 *                  - outpostImageMapping / asteroidImageMapping / shipImageMapping
 *                  - asteroidSurfaceImageCache
 *                  - scannedNodes / deepScannedNodes / discoveredNodes / revealedNodes
 *                  - clearedAsteroids / rumoredNodes
 *                  - scanMode / scanPulse / scannerGlitchDays / attention
 *
 *   commerce     trader merchant + general store carts
 *                  - generalStoreMode / generalStoreCart / generalStoreCartTotal
 *                  - generalStoreSellSelected / generalStoreSellPayout
 *                  - traderMerchantActive / traderMerchantCart / traderMerchantCartTotal
 *                  - traderMerchantCapsByAsteroid / traderMerchantPurchasedByAsteroid
 *
 *   services     dockyard, clinic, cantina, admin overlays + hub state
 *                  - stationHubPanelId / serviceOverlay
 *                  - dockyardMode / dockyardSelectionId
 *                  - outpostDockyardMode / outpostDockyardSelectionId / outpostDockyardMessage
 *                  - clinicMode / clinicSelectedMemberId / clinicSelectedTreatmentId
 *                  - cantinaUI
 *
 *   rumors       rumor kiosks + rumor log
 *                  - hintTargetAsteroidId / lastRumorText
 *                  - activeRumorAsteroidIds / completedRumorAsteroidIds
 *                  - logView (LOG | RUMORS)
 *                  - outpostRumors / outpostRumorMessage / outpostRumorSelectedId
 *                  - outpostRumorPendingId / outpostRumorPendingIds
 *
 *   events       active event prompt/outcome and contacts
 *                  - activeEvent / isEventActive / activeContact
 */

/**
 * @returns {object} Fresh gameState
 */
export function createInitialState() {
  return {
    meta: {
      tab: "TRAVEL",
      travelView: "MAP", // Legacy alias for currentSceneId; do not write to.
      devSeedApplied: false,
      runStatus: "RUNNING", // RUNNING | WON | LOST
      endReason: null,
      endSummary: null,
    },

    stats: {
      lifeSupport: 100,    // 30 days at 3.333% drain per day
      hull: 100,           // Mirror of shipIntegrity (sync via js/hull.js)
      shipIntegrity: 100,  // Canonical ship integrity 0–100
      credits: 1000,
      day: 1,
      deadline: 300,
    },

    travel: {
      // navigation -------------------------------------------------------
      currentLocationId: "earth",
      currentSceneId: "MAP",
      selectedDestinationId: null,
      selectedLocationId: null,
      hoveredNodeId: null,
      lastResolutionText: null,
      returnSceneId: null,
      landingFlavorText: null,
      nextStationBaseId: null,
      broadcastStationInstanceId: null,

      // mapCamera --------------------------------------------------------
      mapZoomLevel: 1,
      mapZoomFine: 1.0,
      mapZoomContinuous: 1.2,
      useContinuousZoom: false,
      mapPanX: 0,
      mapPanY: 0,
      isPanning: false,
      hasPanned: false,
      panStartX: 0,
      panStartY: 0,
      panStartPanX: 0,
      panStartPanY: 0,

      // timeFlow ---------------------------------------------------------
      isWaiting: false,
      waitIntervalId: null,
      isTraveling: false,
      travelProgress: 0,
      travelStartLocationId: null,
      travelDestinationId: null,
      travelTotalDays: 0,
      travelStartTime: null,
      travelStartDay: 0,
      travelAnimationId: null,
      lockedGhostPosition: null,
      animationLoopId: null,

      // discovery --------------------------------------------------------
      outpostImageMapping: null,
      asteroidImageMapping: null,
      asteroidSurfaceImageCache: {},
      shipImageMapping: null,
      scannedNodes: new Set(),
      deepScannedNodes: new Set(),
      clearedAsteroids: new Set(),
      discoveredNodes: new Set(),
      revealedNodes: new Set(),
      scanMode: "scan",
      scanPulse: {
        isActive: false,
        startTime: null,
        duration: 1000,
        maxRadius: 1.0,
        centerRing: null,
        centerAngle: null,
        isDeepScan: false,
      },
      scannerGlitchDays: 0,
      attention: 0,

      // commerce ---------------------------------------------------------
      generalStoreMode: null,
      generalStoreCart: {},
      generalStoreCartTotal: 0,
      generalStoreSellSelected: {},
      generalStoreSellPayout: 0,
      traderMerchantActive: false,
      traderMerchantCart: {},
      traderMerchantCartTotal: 0,
      traderMerchantCapsByAsteroid: {},
      traderMerchantPurchasedByAsteroid: {},

      // services ---------------------------------------------------------
      stationHubPanelId: null,
      serviceOverlay: null,
      dockyardMode: null,
      dockyardSelectionId: null,
      outpostDockyardMode: null,
      outpostDockyardSelectionId: null,
      outpostDockyardMessage: null,
      clinicMode: null,
      clinicSelectedMemberId: null,
      clinicSelectedTreatmentId: null,
      cantinaUI: { tab: "order", selectedOrderId: null, activeRumor: null },

      // rumors -----------------------------------------------------------
      hintTargetAsteroidId: null,
      lastRumorText: null,
      activeRumorAsteroidIds: new Set(),
      completedRumorAsteroidIds: new Set(),
      logView: "LOG",
      rumoredNodes: new Set(),
      outpostRumors: {},
      outpostRumorMessage: null,
      outpostRumorSelectedId: null,
      outpostRumorPendingId: null,
      outpostRumorPendingIds: new Set(),
      purchasedRumors: {},
      completedRumors: {},

      // events -----------------------------------------------------------
      activeEvent: null,
      isEventActive: false,
      activeContact: null,
    },

    crew: {
      members: [],
    },

    inventory: {
      supplies: {},
      parts: {},
      artifacts: [],
    },

    log: {
      entries: [],
      maxEntries: 200,
      landingDraft: null,
    },

    ship: {
      integrity: 100, // Mirror of stats.shipIntegrity (see js/hull.js)
      subsystems: {
        STRUCTURAL:   { damage: 0, flavorText: "" },
        ELECTRICAL:   { damage: 0, flavorText: "" },
        LIFE_SUPPORT: { damage: 0, flavorText: "" },
      },
      upgrades: {
        scanner: 0,
        engine: 0,
        landingAssist1: false,
        landingAssist2: false,
      },
    },
  };
}
