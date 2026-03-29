import { debugLog } from "./debug.js";
import { addShipIntegrity } from "./hull.js";

/**
 * @param {object} deps
 * @returns {(action: object, locationId: string) => void}
 */
export function createDispatchAction(deps) {
  const {
    gameState,
    render,
    advanceDays,
    closeAllOverlays,
    findLocationData,
    handleOutpostExplore,
    handleAsteroidExploreScene,
    handleAsteroidVista,
    handleAsteroidHunt,
    handleAsteroidApproachStructure,
    handleAsteroidLeave,
    logFinalizeLandingSummary,
    startAnimationLoop,
  } = deps;

  return function dispatchAction(action, locationId) {
    switch (action.type) {
      case "NAVIGATE":
        if (action.to) {
          closeAllOverlays();
          if (action.to === "INTERIOR_DOCKYARD") {
            gameState.travel.dockyardMode = "repair";
            gameState.travel.dockyardSelectionId = null;
          }
          if (action.to === "INTERIOR_CLINIC") {
            gameState.travel.clinicMode = "treat";
            gameState.travel.clinicSelectedMemberId = null;
            gameState.travel.clinicSelectedTreatmentId = null;
          }
          if (action.to === "INTERIOR_CANTINA") {
            gameState.travel.cantinaUI = { tab: "order", selectedOrderId: null, activeRumor: null };
          }
          if (action.to === "OUTPOST_MECHANIC") {
            const locationDef = findLocationData(locationId);
            if (locationDef?.type === "outpost") {
              gameState.travel.outpostDockyardMode = "repair";
              gameState.travel.outpostDockyardSelectionId = null;
            }
          }
          if (action.to === "OUTPOST_RUMOR") {
            gameState.travel.outpostRumorMessage = null;
            gameState.travel.outpostRumorSelectedId = null;
          }

          if (action.to === "MERCHANT") {
            gameState.travel.returnSceneId = gameState.travel.currentSceneId || "MAP";
            debugLog("[NAVIGATE] Stored return scene for merchant:", gameState.travel.returnSceneId);
          }

          if ((action.to === "HUB" || action.to === "EXTERIOR") && gameState.travel.returnSceneId) {
            gameState.travel.currentSceneId = gameState.travel.returnSceneId;
            gameState.travel.returnSceneId = null;
          } else {
            gameState.travel.currentSceneId = action.to;
          }
          if (gameState.travel.currentSceneId === "HUB") {
            closeAllOverlays();
          }
          render();
        }
        break;

      case "LEAVE_LOCATION":
        logFinalizeLandingSummary();
        closeAllOverlays();
        gameState.travel.stationHubPanelId = null;
        gameState.travel.returnSceneId = null;
        gameState.travel.currentSceneId = "MAP";
        render();
        startAnimationLoop();
        break;

      case "TURN_PANEL":
        if (action.toPanelId) {
          gameState.travel.stationHubPanelId = action.toPanelId;
          render();
        }
        break;

      case "ENTER_SERVICE":
        if (action.to) {
          gameState.travel.returnSceneId = "HUB";
          gameState.travel.currentSceneId = action.to;
          render();
        }
        break;

      case "REPAIR": {
        const repairCost = action.cost || 50;
        const repairDays = action.days || 1;
        const repairAmount = action.shipIntegrityDelta ?? action.hullDelta ?? 20;

        if (gameState.stats.credits < repairCost) {
          console.warn(`[REPAIR] Insufficient credits. Need ${repairCost}, have ${gameState.stats.credits}`);
          break;
        }

        gameState.stats.credits -= repairCost;
        advanceDays(repairDays);
        addShipIntegrity(gameState, repairAmount);

        debugLog(`[REPAIR] Repaired ${repairAmount} ship integrity, cost ${repairCost} credits, took ${repairDays} day(s)`);
        render();
        break;
      }

      case "HEAL": {
        const healCost = action.cost || 50;
        const healDays = action.days || 1;

        if (gameState.stats.credits < healCost) {
          console.warn(`[HEAL] Insufficient credits. Need ${healCost}, have ${gameState.stats.credits}`);
          break;
        }

        gameState.stats.credits -= healCost;
        advanceDays(healDays);

        const worstCrewMember = gameState.crew.members.find((m) => {
          const badStatuses = ["Dying", "Critical", "Unconscious", "Infected", "Sick", "Wounded", "Injured"];
          return badStatuses.includes(m.status);
        });

        if (worstCrewMember) {
          worstCrewMember.status = "Recovering";
          debugLog(`[HEAL] Improved ${worstCrewMember.name}'s status to Recovering`);
        } else {
          debugLog("[HEAL] No crew members in need of healing");
        }

        debugLog(`[HEAL] Healed crew, cost ${healCost} credits, took ${healDays} day(s)`);
        render();
        break;
      }

      case "SHOP_BUY":
        if (gameState.travel.returnSceneId === null) {
          gameState.travel.returnSceneId = gameState.travel.currentSceneId || "EXTERIOR";
          debugLog("[SHOP_BUY] Stored return scene:", gameState.travel.returnSceneId);
        }
        gameState.travel.generalStoreMode = "buy";
        if (gameState.travel.currentSceneId !== "GENERAL_STORE_ROOM") {
          gameState.travel.currentSceneId = "INTERIOR_MARKET";
        }
        render();
        break;

      case "SHOP_SELL":
        if (gameState.travel.returnSceneId === null) {
          gameState.travel.returnSceneId = gameState.travel.currentSceneId || "EXTERIOR";
          debugLog("[SHOP_SELL] Stored return scene:", gameState.travel.returnSceneId);
        }
        gameState.travel.generalStoreMode = "sell";
        if (gameState.travel.currentSceneId !== "GENERAL_STORE_ROOM") {
          gameState.travel.currentSceneId = "INTERIOR_MARKET";
        }
        render();
        break;

      case "INFO":
        debugLog(`[Info Action] ${action.type} clicked`);
        break;

      case "OUTPOST_EXPLORE":
        handleOutpostExplore(locationId);
        break;

      case "OPEN_DOCKYARD":
        gameState.travel.returnSceneId = gameState.travel.currentSceneId || "HUB";
        gameState.travel.serviceOverlay = "dockyard";
        gameState.travel.dockyardMode = "repair";
        gameState.travel.dockyardSelectionId = null;
        render();
        break;

      case "OPEN_CLINIC":
        gameState.travel.returnSceneId = gameState.travel.currentSceneId || "HUB";
        gameState.travel.serviceOverlay = "clinic";
        gameState.travel.clinicMode = "treat";
        gameState.travel.clinicSelectedMemberId = null;
        gameState.travel.clinicSelectedTreatmentId = null;
        render();
        break;

      case "OPEN_CANTINA":
        gameState.travel.returnSceneId = gameState.travel.currentSceneId || "HUB";
        gameState.travel.serviceOverlay = "cantina";
        gameState.travel.cantinaUI = { tab: "order", selectedOrderId: null, activeRumor: null };
        render();
        break;

      case "OPEN_ADMIN":
        gameState.travel.returnSceneId = gameState.travel.currentSceneId || "HUB";
        gameState.travel.serviceOverlay = "admin";
        render();
        break;

      case "ASTEROID_EXPLORE_SCENE":
        handleAsteroidExploreScene(locationId);
        break;

      case "ASTEROID_VISTA":
        handleAsteroidVista(locationId);
        break;

      case "ASTEROID_HUNT":
        handleAsteroidHunt(locationId);
        break;

      case "ASTEROID_APPROACH":
        handleAsteroidApproachStructure(locationId);
        break;

      case "ASTEROID_RETURN_EXTERIOR":
        gameState.travel.currentSceneId = "EXTERIOR";
        render();
        break;

      case "ASTEROID_LEAVE":
        handleAsteroidLeave(locationId);
        break;

      default:
        console.warn(`Unknown action type: ${action.type}`);
    }
  };
}
