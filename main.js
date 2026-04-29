import { initDebugFromUrl, debugLog } from "./js/debug.js";
import { syncHullIntegrity, addShipIntegrity, setShipIntegrity } from "./js/hull.js";
import { shouldSuppressTravelMapFallback } from "./js/travelViewMode.js";
import { createDispatchAction } from "./js/dispatchAction.js";
import {
  now as perfNow,
  scheduleRender,
  flushRender,
  setRenderFunction,
  ZOOM_SCALES,
  MIN_CONTINUOUS_ZOOM,
  MAX_CONTINUOUS_ZOOM,
  resolveDiscreteZoom,
} from "./js/scheduler.js";
import { createAdvanceDays } from "./js/time.js";
import {
  ROUTE_SCALE_FACTOR,
  TOTAL_MOON_TO_MARS_DAYS,
  EARTH_ORBITAL_PERIOD,
  MARS_ORBITAL_PERIOD,
  SHIP_SPEED,
  GAME_DEADLINE,
  MARS_ORBITAL_PROGRESS,
  EARTH_START_RING,
  MOON_START_RING,
  MARS_END_RING,
  TRAVELABLE_RING_RANGE,
  ROUTE_ORDER,
  baseRouteStructure,
  generateRandomizedRoute,
  calculateCumulativeTravelTimes as routeCumulativeTravelTimes,
  calculateRingFromTravelTime as routeCalculateRingFromTravelTime,
  normalizeNodeIdForRoute as routeNormalizeNodeIdForRoute,
  getStationInstances as routeGetStationInstances,
} from "./js/map/route.js";
import {
  supplyImage,
  asteroidSurfaceImage,
  asteroidSurfaceNumbers,
  asteroidArrivalImage,
  outpostImage,
  stationImage,
  shipImage,
  planetImage,
} from "./js/assets/manifest.js";
import { createInitialState } from "./js/state/initialState.js";
import {
  calculateOrbitalAngle,
  getBaseOrbitalPeriod,
  generateRandomOrbitalPeriod,
  generateRandomInitialAngle,
  generateRandomFullAngle,
} from "./js/map/orbital.js";

/*
Red Planet Rush – Prototype

Constraints:
- Browser-based game
- HTML/CSS for UI, Canvas only for map
- Single global gameState object
- Travel is a state machine:
  MAP → ARRIVAL → INTERACTION → RESOLUTION → MAP
- No probabilities yet
- No balancing yet
- Stub logic is preferred over “complete” systems
*/

/**
 * @typedef {"TRAVEL"|"SHIP"|"CREW"|"INVENTORY"|"LOG"|"SETTINGS"} Tab
 * @typedef {"MAP"|"ARRIVAL"|"EXTERIOR"|"MERCHANT"|"REPAIR"|"CLINIC"|"RESOLUTION"|"HUB"} TravelView
 * @typedef {"earth"|"moon"|"outpost"|"station"|"mars"|"asteroid"|"ship"} LocationType
 */

/**
 * @typedef {{
 *   id: string,
 *   name: string,
 *   type: LocationType,
 *   ring: number, // which ring this belongs to (0 = center, 1-4 = outer rings) - for ships, this is current calculated ring
 *   angle: number, // initial angle in radians for positioning on ring (randomized per playthrough)
 *   orbitalPeriod: number, // orbital period in days (randomized per playthrough)
 *   daysToTravel: number, // days to reach from previous node
 *   zoomLevel: number, // which zoom level this node is visible at (1-4)
 *   initialRing?: number, // for ships: starting ring position
 *   radialVelocity?: number, // for ships: movement speed towards/away from sun (rings per day, can be negative)
 *   sizeMultiplier?: number, // for asteroids: size variation multiplier (0.5 to 1.0)
 *   inhabited?: "likely"|"unlikely"|"unknown", // whether location is inhabited (uncertainty-based)
 *   landingRisk?: "Safe"|"Moderately Safe"|"Moderately Dangerous"|"Dangerous", // landing risk level
 *   dockingRisk?: "Safe"|"Uncertain"|"Dangerous", // docking risk for ships
 *   resources?: "likely"|"unlikely"|"unknown", // resource availability (uncertainty-based)
 *   // (reserved for future encounter metadata)
 *   shipType?: "Cargo"|"Passenger"|"Pirate"|"Research"|"Cruise", // ship type for ships
 * }}
 */
// @typedef Node

// Route, orbital, and ring constants now live in js/map/route.js.
// The named imports above re-introduce them into this scope for the rest
// of main.js while we incrementally extract systems.

// Dev flags
const DEV_SEED_STARTING_ITEMS = true; // Enable/disable starter artifacts and items for testing

// Generate randomized route at initialization
const routeStructure = {
  segments: generateRandomizedRoute(),
};

// Calculate cumulative travel times from randomized route
const cumulativeTravelTimes = routeCumulativeTravelTimes(routeStructure.segments);

/** Get all station instances for a given base id (e.g. "station-01"). */
function getStationInstances(baseId) {
  return routeGetStationInstances(baseId);
}

/**
 * Choose the nearest station instance from a base ID
 * @param {string} baseId Station base ID (e.g., "station-01")
 * @param {string} playerLocationId Current player location ID
 * @param {number} day Current game day
 * @returns {string|null} Instance ID of nearest station, or null if not found
 */
/**
 * Get Mars position at day 300 (game deadline)
 * @param {number} currentDay Current game day (unused, kept for consistency)
 * @returns {{x: number, y: number, ring: number, angle: number}|null}
 */
function getMarsAtDeadline(currentDay = null) {
  const marsNode = mapNodes.find(n => n.id === "mars");
  if (!marsNode) return null;
  
  const targetDay = GAME_DEADLINE; // Day 300
  return getNodePosition(marsNode, targetDay);
}

function chooseNearestStationInstance(baseId, playerLocationId, day) {
  const instances = getStationInstances(baseId);
  const playerNode = mapNodes.find(n => n.id === playerLocationId);
  if (!playerNode) return null;
  
  // Get player position
  const playerPos = getNodePosition(playerNode, day);
  
  // Get Mars position at day 300 (deadline)
  const marsAtDeadline = getMarsAtDeadline(day);
  
  // Determine if we should use Mars-relative guidance
  // Use it when we're past station-01 (to avoid early game weirdness)
  const routeOrder = ["earth", "outpost-0", "station-01", "outpost-1", "station-02", "outpost-2", "station-03", "mars"];
  function normalizeNodeIdForRoute(nodeId) {
    if (!nodeId) return null;
    if (routeOrder.includes(nodeId)) return nodeId;
    for (const baseId of routeOrder) {
      if (nodeId.startsWith(baseId + "-")) {
        return baseId;
      }
    }
    return nodeId;
  }
  
  const normalizedLocationId = normalizeNodeIdForRoute(playerLocationId);
  const currentIndex = routeOrder.indexOf(normalizedLocationId);
  const useMarsGuidance = currentIndex >= 2 && marsAtDeadline !== null; // Past station-01
  
  let bestInstance = null;
  let bestScore = Infinity;
  
  for (const instanceId of instances) {
    const instanceNode = mapNodes.find(n => n.id === instanceId);
    if (!instanceNode) continue;
    
    // Get instance position
    const instancePos = getNodePosition(instanceNode, day);
    
    let score;
    
    if (useMarsGuidance) {
      // Mars-relative guidance: 70% weight toward Mars, 30% toward player
      const dxToPlayer = instancePos.x - playerPos.x;
      const dyToPlayer = instancePos.y - playerPos.y;
      const distanceToPlayer = Math.sqrt(dxToPlayer * dxToPlayer + dyToPlayer * dyToPlayer);
      
      const dxToMars = instancePos.x - marsAtDeadline.x;
      const dyToMars = instancePos.y - marsAtDeadline.y;
      const distanceToMars = Math.sqrt(dxToMars * dxToMars + dyToMars * dyToMars);
      
      // Weighted score: 30% player distance, 70% Mars distance
      score = (distanceToPlayer * 0.3) + (distanceToMars * 0.7);
    } else {
      // Early game: just use distance to player
      const dx = instancePos.x - playerPos.x;
      const dy = instancePos.y - playerPos.y;
      score = Math.sqrt(dx * dx + dy * dy);
    }
    
    if (score < bestScore) {
      bestScore = score;
      bestInstance = instanceId;
    }
  }
  
  return bestInstance;
}

/**
 * Initialize revealed nodes and broadcast station
 * Sets up the next station base ID and chooses the nearest instance
 */
function initializeRevealedNodes() {
  // Ensure Sets exist
  if (!gameState.travel.revealedNodes) {
    gameState.travel.revealedNodes = new Set();
  }
  if (!gameState.travel.discoveredNodes) {
    gameState.travel.discoveredNodes = new Set();
  }
  
  const routeOrder = ["earth", "outpost-0", "station-01", "outpost-1", "station-02", "outpost-2", "station-03", "mars"];
  const stationOrder = ["station-01", "station-02", "station-03"];
  const currentLocationId = gameState.travel.currentLocationId;
  
  function normalizeNodeIdForRoute(nodeId) {
    if (!nodeId) return null;
    if (routeOrder.includes(nodeId)) return nodeId;
    for (const baseId of routeOrder) {
      if (nodeId.startsWith(baseId + "-")) {
        return baseId;
      }
    }
    return nodeId;
  }
  
  // Outposts are now discovered via scan, not revealed on initialization
  // Removed the logic that automatically reveals the nearest outpost
  
  // Initialize next station base ID and broadcast instance
  if (!gameState.travel.nextStationBaseId) {
    const normalizedLocationId = normalizeNodeIdForRoute(currentLocationId);
    const locationIndex = routeOrder.indexOf(normalizedLocationId);
    
    // Find the next station in the route
    for (let i = locationIndex + 1; i < routeOrder.length; i++) {
      const nextId = routeOrder[i];
      if (nextId.startsWith("station-")) {
        gameState.travel.nextStationBaseId = nextId;
        // Choose and lock the nearest instance
        const nearestInstance = chooseNearestStationInstance(nextId, currentLocationId, gameState.stats.day);
        if (nearestInstance) {
          gameState.travel.broadcastStationInstanceId = nearestInstance;
        }
        break;
      }
    }
  }
}

// Ring position helper now lives in js/map/route.js. Re-export under the
// original name so the rest of main.js can keep using it unchanged.
const calculateRingFromTravelTime = routeCalculateRingFromTravelTime;

// Orbital helpers (calculateOrbitalAngle, getBaseOrbitalPeriod,
// generateRandomOrbitalPeriod, generateRandomInitialAngle,
// generateRandomFullAngle) now live in js/map/orbital.js and are imported
// at the top of this file.

/**
 * List of Greek mythological names for asteroid naming
 */
const GREEK_NAMES = [
  "Achilles", "Adonis", "Aeolus", "Aether", "Aphrodite", "Apollo", "Ares", "Artemis", "Athena", "Atlas",
  "Boreas", "Chaos", "Charon", "Cronus", "Demeter", "Dionysus", "Eos", "Erebus", "Eros", "Gaia",
  "Hades", "Hecate", "Helios", "Hephaestus", "Hera", "Hermes", "Hestia", "Hyperion", "Iapetus", "Iris",
  "Kronos", "Leto", "Maia", "Metis", "Mnemosyne", "Nike", "Nyx", "Oceanus", "Pan", "Persephone",
  "Poseidon", "Prometheus", "Rhea", "Selene", "Thanatos", "Themis", "Titan", "Uranus", "Zeus", "Zephyrus",
  "Asteria", "Astraeus", "Atropos", "Clotho", "Echo", "Enyo", "Eris", "Eurybia", "Eurynome", "Hecatoncheires",
  "Hypnos", "Lachesis", "Morpheus", "Nemesis", "Notus", "Phobos", "Pontus", "Tartarus", "Tyche", "Zelus"
];

/**
 * Generate a random asteroid name in the format "000 GreekName" (e.g., "873 Ceres")
 * @param {number} index Index of the asteroid (for unique numbering)
 * @returns {string} Formatted asteroid name
 */
function generateAsteroidName(index) {
  // Generate a random number between 1 and 9999 (similar to real asteroid numbering)
  const number = Math.floor(Math.random() * 9999) + 1;
  // Pick a random Greek name
  const greekName = GREEK_NAMES[Math.floor(Math.random() * GREEK_NAMES.length)];
  // Format as "000 GreekName"
  return `${String(number).padStart(3, '0')} ${greekName}`;
}

/**
 * Generate a random crew member name
 * @returns {string} Random name
 */
function generateCrewName() {
  const firstNames = [
    "Alex", "Blake", "Casey", "Drew", "Eli", "Finley", "Gray", "Harper", "Ivy", "Jade",
    "Kai", "Logan", "Morgan", "Noah", "Owen", "Parker", "Quinn", "Riley", "Sam", "Taylor",
    "Ava", "Ben", "Cora", "Dean", "Eve", "Finn", "Gwen", "Hank", "Iris", "Jack",
    "Kate", "Luke", "Maya", "Nate", "Omar", "Paige", "Quinn", "Rose", "Sage", "Tess",
    "Uma", "Vera", "Wade", "Xara", "Yuki", "Zane",
    "Captain", "Sly", "Steve", "Gork", "Cricut", "Sue"
  ];
  const lastNames = [
    "Smith", "Johnson", "Williams", "Brown", "Jones", "Garcia", "Miller", "Davis",
    "Rodriguez", "Martinez", "Hernandez", "Lopez", "Wilson", "Anderson", "Thomas", "Taylor",
    "Moore", "Jackson", "Martin", "Lee", "Thompson", "White", "Harris", "Sanchez",
    "Clark", "Ramirez", "Lewis", "Robinson", "Walker", "Young", "Allen", "King",
    "Wright", "Scott", "Torres", "Nguyen", "Hill", "Flores", "Green", "Adams",
    "Nelson", "Baker", "Hall", "Rivera", "Campbell", "Mitchell", "Carter", "Roberts"
  ];
  
  const firstName = firstNames[Math.floor(Math.random() * firstNames.length)];
  const lastName = lastNames[Math.floor(Math.random() * lastNames.length)];
  return `${firstName} ${lastName}`;
}

/**
 * Initialize crew members at game start
 */
function initializeCrew() {
  const backgrounds = [
    "Captain", "Navigator", "Military", "Technician", "Medic", "Stowaway",
    "Sheriff", "Researcher", "Prospector", "Negotiator", "Mechanic", "Droid"
  ];
  
  // Start runs with manageable problems, not immediate death spirals.
  // Severe statuses are reserved for events and difficulty tuning.
  const statuses = [
    "Healthy", "Healthy", "Healthy", "Recovering", "Stressed",
    "Tired", "Confused", "Resilient"
  ];
  
  // Available crew portrait numbers (01-012)
  // Note: Files are named crew_01 through crew_012 (with 3 digits for 10+)
  const availablePortraits = [];
  for (let i = 1; i <= 12; i++) {
    // Pad to 3 digits for numbers 10+ (crew_010, crew_011, crew_012)
    // Pad to 2 digits for numbers 1-9 (crew_01, crew_02, etc.)
    const num = i < 10 ? String(i).padStart(2, '0') : String(i).padStart(3, '0');
    availablePortraits.push(`crew_${num}`);
  }
  
  // Shuffle portraits
  const shuffledPortraits = [...availablePortraits];
  for (let i = shuffledPortraits.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [shuffledPortraits[i], shuffledPortraits[j]] = [shuffledPortraits[j], shuffledPortraits[i]];
  }
  
  // Create 4 initial crew members
  gameState.crew.members = [];
  for (let i = 0; i < 4; i++) {
    const portrait = shuffledPortraits[i];
    const name = generateCrewName();
    const background = backgrounds[Math.floor(Math.random() * backgrounds.length)];
    const status = statuses[Math.floor(Math.random() * statuses.length)];
    
    gameState.crew.members.push({
      id: `crew-${i}`,
      name: name,
      portrait: portrait,
      background: background,
      status: status
    });
  }
}

function hasCrewBackground(background) {
  return (gameState.crew.members || []).some(member =>
    member.background === background && member.status !== "Deceased"
  );
}

function getCrewBonus(kind) {
  switch (kind) {
    case "repairDiscount":
      return hasCrewBackground("Mechanic") || hasCrewBackground("Technician") ? 0.10 : 0;
    case "medicalDiscount":
      return hasCrewBackground("Medic") ? 0.10 : 0;
    case "travelSpeed":
      return hasCrewBackground("Navigator") ? 0.05 : 0;
    case "scanRange":
      return hasCrewBackground("Researcher") ? 0.10 : 0;
    case "tradeDiscount":
      return hasCrewBackground("Negotiator") ? 0.10 : 0;
    case "prospecting":
      return hasCrewBackground("Prospector") ? 0.15 : 0;
    default:
      return 0;
  }
}

/**
 * Build mapNodes array using randomized route cumulative travel times
 * Each location gets a random initial angle and orbital period for variability
 * @returns {Node[]} Array of map node definitions
 */
function buildMapNodes() {
  const nodes = [];
  
  // Sun at center (not a travel location, just visual)
  nodes.push({ 
    id: "sun", 
    name: "SUN", 
    type: "earth", // Type doesn't matter for sun, just needs to be a valid type
    ring: 0, 
    angle: 0, 
    orbitalPeriod: 0, 
    daysToTravel: 0, 
    zoomLevel: 1 
  });
  
  // Helper to create a node with random orbital properties
  function createNode(id, name, type, cumulativeTime, zoomLevel, inhabited = "unknown", landingRisk = "average") {
    return {
      id,
      name,
      type,
      ring: calculateRingFromTravelTime(cumulativeTime),
      angle: generateRandomInitialAngle(), // Random initial position along orbit
      orbitalPeriod: generateRandomOrbitalPeriod(type), // Variable orbital speed
      daysToTravel: 0,
      zoomLevel,
      inhabited,
      landingRisk
    };
  }
  
  // Zoom Level 1: Major waypoints - positioned based on cumulative travel time
  // Earth: starting location
  nodes.push(createNode("earth", "EARTH", "earth", cumulativeTravelTimes.earth, 1, "yes", "low"));
  
  // Moon: orbits around Earth, 25% the size of Earth
  // Moon orbital period around Earth: ~28 days (realistic)
  const MOON_ORBITAL_PERIOD = 28;
  const MOON_ORBITAL_RADIUS = 0.1; // Small radius around Earth (in ring units)
  nodes.push({
    id: "moon",
    name: "MOON",
    type: "moon",
    ring: EARTH_START_RING, // Base ring (same as Earth)
    angle: generateRandomInitialAngle(), // Random initial angle
    orbitalPeriod: MOON_ORBITAL_PERIOD, // Orbits Earth in 28 days
    daysToTravel: 0,
    zoomLevel: 1,
    inhabited: "no",
    landingRisk: "low",
    // Moon-specific properties for orbital calculation
    orbitsAround: "earth", // Moon orbits around Earth
    orbitalRadius: MOON_ORBITAL_RADIUS, // Distance from Earth
    initialAngle: generateRandomInitialAngle() // Initial angle around Earth
  });
  
  // Create 4 instances of each station at 90-degree intervals with ±30° variation
  // Base angles: 0°, 90°, 180°, 270° with ±30° random offset to avoid perfect alignment
  const stationBaseAngles = [0, Math.PI / 2, Math.PI, 3 * Math.PI / 2]; // 0°, 90°, 180°, 270°
  const stationNames = ["STATION 01", "STATION 02", "STATION 03"];
  const stationIds = ["station-01", "station-02", "station-03"];
  const angleVariation = (60 * Math.PI / 180) / 2; // ±30° in radians (half of 60°)
  
  stationIds.forEach((stationId, stationIndex) => {
    const cumulativeTime = cumulativeTravelTimes[stationId];
    const ring = calculateRingFromTravelTime(cumulativeTime);
    
    stationBaseAngles.forEach((baseAngle, angleIndex) => {
      const suffix = String.fromCharCode(97 + angleIndex); // 'a', 'b', 'c', 'd'
      const id = `${stationId}-${suffix}`;
      const name = `${stationNames[stationIndex]} ${suffix.toUpperCase()}`;
      // Add random variation: ±30° around the base angle
      const angle = baseAngle + (Math.random() * 2 - 1) * angleVariation;
      
      nodes.push({
        id,
        name,
        type: "station",
        ring: ring,
        angle: angle, // Base angle with ±30° variation
        orbitalPeriod: generateRandomOrbitalPeriod("station", ring), // Ring-based orbital speed (25% slower per ring)
        daysToTravel: 0,
        zoomLevel: 1,
        inhabited: "yes",
        landingRisk: "low"
      });
    });
  });
  
  nodes.push(createNode("mars", "MARS", "mars", cumulativeTravelTimes.mars, 1, "unknown", "average"));
  
  // Zoom Level 2: Outposts between stations - positioned based on cumulative travel time
  // Create 4 instances of each outpost at 90-degree intervals with ±30° variation
  const outpostBaseAngles = [0, Math.PI / 2, Math.PI, 3 * Math.PI / 2]; // 0°, 90°, 180°, 270°
  const outpostNames = ["OUTPOST 0", "OUTPOST 1", "OUTPOST 2"];
  const outpostIds = ["outpost-0", "outpost-1", "outpost-2"];
  
  outpostIds.forEach((outpostId, outpostIndex) => {
    const cumulativeTime = cumulativeTravelTimes[outpostId];
    const ring = calculateRingFromTravelTime(cumulativeTime);
    
    outpostBaseAngles.forEach((baseAngle, angleIndex) => {
      const suffix = String.fromCharCode(97 + angleIndex); // 'a', 'b', 'c', 'd'
      const id = `${outpostId}-${suffix}`;
      const name = `${outpostNames[outpostIndex]} ${suffix.toUpperCase()}`;
      // Add random variation: ±30° around the base angle
      const angle = baseAngle + (Math.random() * 2 - 1) * angleVariation;
      
      nodes.push({
        id,
        name,
        type: "outpost",
        ring: ring,
        angle: angle, // Base angle with ±30° variation
        orbitalPeriod: generateRandomOrbitalPeriod("outpost", ring), // Ring-based orbital speed (intermediate between stations)
        daysToTravel: 0,
        zoomLevel: 2,
        inhabited: "yes",
        landingRisk: "low"
      });
    });
  });
  
  // Generate asteroids and ships (350 asteroids, 15 ships)
  const numAsteroids = 350;
  const numShips = 15;
  
  // Generate asteroids
  for (let i = 0; i < numAsteroids; i++) {
    // Random ring between Moon and Mars (ring 1 to 5)
    const randomRing = MOON_START_RING + Math.random() * TRAVELABLE_RING_RANGE;
    // Size variation: 50% to 100% of base size (current size is max)
    const sizeMultiplier = 0.5 + Math.random() * 0.5; // 0.5 to 1.0
    nodes.push({
      id: `asteroid-${i}`,
      name: generateAsteroidName(i), // Random Greek name format: "873 Ceres"
      type: "asteroid",
      ring: randomRing,
      angle: generateRandomFullAngle(), // Full 360 degrees
      orbitalPeriod: generateRandomOrbitalPeriod("asteroid"), // ±80% variation
      daysToTravel: 0,
      zoomLevel: 2, // Same as outposts
      sizeMultiplier: sizeMultiplier, // 0.5 to 1.0 for size variation
      inhabited: "unknown", // Default for asteroids - will show as UNKNOWN until deep scanned
      landingRisk: "Moderately Safe", // Default for asteroids - will show as UNKNOWN until deep scanned
      resources: "unknown" // Default for asteroids - will show as UNKNOWN until deep scanned
    });
  }
  
  // Generate ships
  for (let i = 0; i < numShips; i++) {
    // Random starting ring between Moon and Mars (ring 1 to 5)
    const initialRing = MOON_START_RING + Math.random() * TRAVELABLE_RING_RANGE;
    // Random radial velocity: -0.01 to +0.01 rings per day (towards or away from sun)
    // This allows ships to move inward or outward over time
    const radialVelocity = (Math.random() * 0.02 - 0.01); // -0.01 to +0.01 rings/day
    nodes.push({
      id: `ship-${i}`,
      name: `SHIP ${String(i + 1).padStart(3, '0')}`,
      type: "ship",
      ring: initialRing, // Will be recalculated based on movement
      angle: generateRandomFullAngle(), // Full 360 degrees
      orbitalPeriod: generateRandomOrbitalPeriod("ship"), // ±80% variation
      daysToTravel: 0,
      zoomLevel: 2, // Same as outposts
      initialRing: initialRing, // Store starting position
      radialVelocity: radialVelocity, // Movement speed towards/away from sun
      shipType: null, // Will be generated on deep scan: "Cargo", "Passenger", "Pirate", "Research", "Cruise"
      inhabited: "unknown", // Default for ships - will show as UNKNOWN until deep scanned
      dockingRisk: "Uncertain", // Default for ships - will show as UNKNOWN until deep scanned
      resources: "unknown" // Default for ships - will show as UNKNOWN until deep scanned
    });
  }
  
  // Stops removed - will be added back later
  
  return nodes;
}

/** @type {Node[]} */
const mapNodes = buildMapNodes();

// ---------------------------
// Location Scene Data
// ---------------------------

/**
 * @typedef {{
 *   id: string,
 *   name: string,
 *   type: LocationType,
 *   scenes: { [sceneId: string]: Scene }
 * }}
 */
// @typedef Location

/**
 * @typedef {{
 *   image: string, // asset path
 *   hotspots: Hotspot[]
 * }}
 */
// @typedef Scene

/**
 * @typedef {{
 *   shape: "rect",
 *   x: number, // normalized 0..1
 *   y: number, // normalized 0..1
 *   w: number, // normalized 0..1
 *   h: number, // normalized 0..1
 *   label: string, // for debugging/hover
 *   action: Action
 * }}
 */
// @typedef Hotspot

/**
 * @typedef {{
 *   type: "NAVIGATE" | "LEAVE_LOCATION" | "REPAIR" | "SHOP_BUY" | "SHOP_SELL" | "HEAL" | "INFO" | "TURN_PANEL" | "ENTER_SERVICE" | "OUTPOST_EXPLORE" | "OPEN_DOCKYARD" | "OPEN_CLINIC" | "OPEN_CANTINA" | "OPEN_ADMIN" | "ASTEROID_EXPLORE_SCENE" | "ASTEROID_VISTA" | "ASTEROID_HUNT" | "ASTEROID_APPROACH" | "ASTEROID_RETURN_EXTERIOR" | "ASTEROID_LEAVE",
 *   to?: string, // sceneId for NAVIGATE / ENTER_SERVICE
 *   toPanelId?: string, // panelId for TURN_PANEL
 *   days?: number, // for REPAIR, HEAL
 *   shipIntegrityDelta?: number, // for REPAIR
 *   cost?: number, // for REPAIR, SHOP_BUY, HEAL
 *   [key: string]: any // allow other payload fields
 * }}
 */
// @typedef Action

/**
 * Initialize random outpost image mapping for this playthrough
 * Randomly assigns each outpost base ID to an available image set
 * Only uses image sets that actually have images (checks for arrival.png)
 * @returns {Object<string, string>} Mapping of outpost base ID to image set ID
 */
function initializeOutpostImageMapping() {
  const outpostBaseIds = ["outpost-0", "outpost-1", "outpost-2"];
  const possibleImageSets = ["outpost-01", "outpost-02", "outpost-03"];
  
  // Filter to only image sets that actually have images
  // For now, we'll check if the folder exists and has at least arrival.png
  // In a real implementation, you might want to do an async check, but for now
  // we'll use a simple approach: only use outpost-01 if others don't have images
  // This can be expanded later to dynamically detect available image sets
  const availableImageSets = ["outpost-01"]; // Start with only outpost-01
  
  // TODO: In the future, you could add logic here to check which folders actually have images
  // For now, we'll use outpost-01 for all outposts until more image sets are added
  
  // Shuffle available image sets
  const shuffled = [...availableImageSets];
  for (let i = shuffled.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]];
  }
  
  // Map each outpost to a random image set (will all be outpost-01 for now)
  const mapping = {};
  outpostBaseIds.forEach((baseId, index) => {
    mapping[baseId] = shuffled[index % shuffled.length];
  });
  
  return mapping;
}

/**
 * Initialize random asteroid image mapping for this playthrough
 * Randomly assigns each asteroid ID to an available image number
 * @param {Node[]} asteroidNodes Array of asteroid nodes from mapNodes
 * @returns {Object<string, string>} Mapping of asteroid ID to image number (e.g., {"asteroid-0": "01", "asteroid-1": "03"})
 */
function initializeAsteroidImageMapping(asteroidNodes) {
  // Available asteroid images: asteroid-01 through asteroid-05
  const availableImageNumbers = ["01", "02", "03", "04", "05"];
  
  // Shuffle available image numbers
  const shuffled = [...availableImageNumbers];
  for (let i = shuffled.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]];
  }
  
  // Map each asteroid to a random image number (with repetition if needed)
  const mapping = {};
  asteroidNodes.forEach((node, index) => {
    mapping[node.id] = shuffled[index % shuffled.length];
  });
  
  return mapping;
}

/**
 * Initialize random ship image mapping for this playthrough
 * Randomly assigns each ship ID to an available image number
 * @param {Node[]} shipNodes Array of ship nodes from mapNodes
 * @returns {Object<string, string>} Mapping of ship ID to image number (e.g., {"ship-0": "010", "ship-1": "015"})
 */
function initializeShipImageMapping(shipNodes) {
  // Available ship images: ships-010 through ships-029 (20 images)
  const availableImageNumbers = [];
  for (let i = 10; i <= 29; i++) {
    availableImageNumbers.push(String(i).padStart(3, '0')); // "010", "011", ..., "029"
  }
  
  // Shuffle available image numbers
  const shuffled = [...availableImageNumbers];
  for (let i = shuffled.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]];
  }
  
  // Map each ship to a random image number (with repetition if needed)
  const mapping = {};
  shipNodes.forEach((node, index) => {
    mapping[node.id] = shuffled[index % shuffled.length];
  });
  
  return mapping;
}

/**
 * Generate image path for a location scene
 * Scene backgrounds are organized by location type:
 * - Outposts: assets/scenes/outposts/outpost-{id}/{sceneId}.png (e.g., outpost-01/arrival.png)
 *   Uses randomized mapping from gameState.travel.outpostImageMapping
 * - Stations: assets/scenes/stations/{sceneId}-{locationId}.jpg (legacy format)
 * - Asteroids: assets/scenes/asteroids/{sceneId}-{locationId}.jpg
 * - Ships: assets/scenes/ships/{sceneId}-{locationId}.jpg
 * 
 * Examples:
 * - assets/scenes/outposts/outpost-01/arrival.png
 * - assets/scenes/outposts/outpost-01/interior.png
 * - assets/scenes/stations/exterior-station-01-a.jpg
 * - assets/scenes/asteroids/arrival-asteroid-001.jpg
 * 
 * Note: Other asset types (crew, pirates, ship sprites, etc.) should be stored in:
 * - assets/crew/
 * - assets/pirates/
 * - assets/ships/ (for ship sprites/models, separate from scene backgrounds)
 * - assets/items/
 * - assets/ui/
 * - etc.
 * 
 * @param {string} sceneId Scene ID (e.g., "ARRIVAL", "INTERIOR", "EXTERIOR")
 * @param {string} locationId Location ID (e.g., "outpost-0-a", "outpost-0", "station-01-a")
 * @param {string} locationType Location type (e.g., "outpost", "station", "asteroid", "ship")
 * @returns {string} Image path
 */
function getSceneImagePath(sceneId, locationId, locationType) {
  let sceneName = sceneId.toLowerCase();
  if (locationType === "station" && sceneId === "GENERAL_STORE_ROOM") {
    sceneName = "interior_market";
  }
  if (locationType === "station" && sceneId === "HANGAR_ROOM") {
    sceneName = "interior_dockyard";
  }
  if (locationType === "station" && sceneId === "MEDBAY_ROOM") {
    sceneName = "interior_clinic";
  }
  if (locationType === "station" && sceneId === "CANTINA_ROOM") {
    sceneName = "interior_cantina";
  }
  if (locationType === "station" && sceneId === "ADMIN_ROOM") {
    sceneName = "interior_admin";
  }
  
  // Outposts: subfolder structure with randomized image set mapping.
  if (locationType === "outpost") {
    const outpostSceneMap = {
      OUTPOST_EXTERIOR: "arrival",
      OUTPOST_INTERIOR: "interior",
      OUTPOST_MECHANIC: "interior",
      OUTPOST_RUMOR: "interior",
      INTERIOR_MARKET: "interior",
    };
    if (outpostSceneMap[sceneId]) {
      sceneName = outpostSceneMap[sceneId];
    }
    const baseId = locationId.replace(/-[a-d]$/, "");
    const imageSetId =
      (gameState.travel.outpostImageMapping && gameState.travel.outpostImageMapping[baseId]) ||
      "outpost-01";
    return outpostImage(imageSetId, sceneName);
  }

  // Asteroids: randomized arrival image, shared surface pool.
  if (locationType === "asteroid") {
    const imageNumber =
      (gameState.travel.asteroidImageMapping && gameState.travel.asteroidImageMapping[locationId]) ||
      "01";
    if (sceneName === "arrival") {
      return asteroidArrivalImage(imageNumber);
    }
    if (sceneName === "explore" || sceneName === "exterior") {
      return getAsteroidSurfaceImage(locationId);
    }
    // Other scenes (rare) use the legacy per-asteroid pattern.
    return `assets/scenes/asteroids/asteroid-${imageNumber}_${sceneName}.png`;
  }

  // Ships: randomized image set per ship.
  if (locationType === "ship") {
    const imageNumber =
      (gameState.travel.shipImageMapping && gameState.travel.shipImageMapping[locationId]) || null;
    if (imageNumber !== null) {
      return shipImage(imageNumber, sceneName);
    }
    return `assets/scenes/ships/${sceneName}-${locationId}.jpg`;
  }

  // Stations and any other location type: <type>s/<scene>-<id>.jpg.
  if (locationType === "station") {
    return stationImage(sceneName, locationId);
  }
  const folderName = `${locationType}s`;
  return `assets/scenes/${folderName}/${sceneName}-${locationId}.jpg`;
}

/**
 * Get asteroid surface image (cached per asteroid).
 * Path generation lives in the asset manifest; we just memoize the
 * random index per asteroid id so the same asteroid always shows the
 * same surface during a playthrough.
 * @param {string} asteroidId
 * @returns {string}
 */
function getAsteroidSurfaceImage(asteroidId) {
  if (gameState.travel.asteroidSurfaceImageCache && gameState.travel.asteroidSurfaceImageCache[asteroidId]) {
    return gameState.travel.asteroidSurfaceImageCache[asteroidId];
  }

  const numbers = asteroidSurfaceNumbers();
  const imageNumber = numbers[Math.floor(Math.random() * numbers.length)];
  const imagePath = asteroidSurfaceImage(imageNumber);

  if (!gameState.travel.asteroidSurfaceImageCache) {
    gameState.travel.asteroidSurfaceImageCache = {};
  }
  gameState.travel.asteroidSurfaceImageCache[asteroidId] = imagePath;
  return imagePath;
}

/**
 * Get preview image path for a location
 * The preview image is the same as the ARRIVAL scene image - what you see in preview
 * is what you'll see when you land at that location
 * For asteroids, when arrived (LAND button showing), show random surface image
 * @param {string} locationId Location ID (e.g., "asteroid-001", "outpost-0-a", "ship-001")
 * @param {string} locationType Location type (e.g., "asteroid", "outpost", "station", "ship")
 * @returns {string} Image path (same as ARRIVAL scene, or surface for arrived asteroids)
 */
function getPreviewImagePath(locationId, locationType) {
  // Planets: route through the asset manifest for one source of truth.
  if (locationId === "earth" || locationType === "earth") return planetImage("earth");
  if (locationId === "moon" || locationType === "moon") return planetImage("moon");
  if (locationId === "mars" || locationType === "mars") return planetImage("mars");
  
  // Special case: Asteroids
  if (locationType === "asteroid") {
    // Simple rule: If we're on MAP, show ARRIVAL image
    // If we're NOT on MAP (in a scene) AND at this specific asteroid, show SURFACE/EXTERIOR image
    if (gameState.travel.currentSceneId === "MAP") {
      // On MAP: show arrival image
      return getSceneImagePath("ARRIVAL", locationId, locationType);
    }
    // Not on MAP (in a scene) and at this asteroid: show surface/exterior image
    if (gameState.travel.currentLocationId === locationId) {
      // Use EXTERIOR scene image (which uses surface images)
      return getSceneImagePath("EXTERIOR", locationId, locationType);
    }
    // Not at this asteroid (previewing a different one): show arrival image
    return getSceneImagePath("ARRIVAL", locationId, locationType);
  }
  
  // Preview uses the same image as the ARRIVAL scene
  return getSceneImagePath("ARRIVAL", locationId, locationType);
}

/**
 * Create a station location definition with standardized scenes and hotspots
 * @param {string} baseId Station base ID (e.g., "station-01")
 * @param {string} displayName Display name (e.g., "STATION 01")
 * @param {Object} services Service flags: { market, dockyard, clinic, admin, cantina }
 * @returns {Location} Location object with scenes
 */
function createStationLocation(baseId, displayName, services) {
  const scenes = {};
  
  // EXTERIOR scene - always present
  const exteriorHotspots = [];
  
  // Add district navigation hotspots - 5 buttons horizontally in middle-lower area
  // Order: Dockyard, Clinic, General Store, Admin, Cantina
  const exteriorButtons = [];
  if (services.dockyard) {
    exteriorButtons.push({ label: "Dockyard", action: { type: "NAVIGATE", to: "HANGAR_ROOM" } });
  }
  if (services.clinic) {
    exteriorButtons.push({ label: "Clinic", action: { type: "NAVIGATE", to: "MEDBAY_ROOM" } });
  }
  if (services.market) {
    exteriorButtons.push({ label: "General Store", action: { type: "NAVIGATE", to: "GENERAL_STORE_ROOM" } });
  }
  if (services.admin) {
    exteriorButtons.push({ label: "Admin", action: { type: "NAVIGATE", to: "ADMIN_ROOM" } });
  }
  if (services.cantina) {
    exteriorButtons.push({ label: "Cantina", action: { type: "NAVIGATE", to: "CANTINA_ROOM" } });
  }
  
  // Position buttons evenly across the width, centered vertically in middle-lower area
  const buttonCount = exteriorButtons.length;
  const totalButtonWidth = 0.15 * buttonCount; // Each button is 15% wide
  const startX = (1 - totalButtonWidth) / 2; // Center the group
  const buttonSpacing = 0.15;
  
  exteriorButtons.forEach((button, index) => {
    exteriorHotspots.push({
      shape: "rect",
      x: startX + (index * buttonSpacing),
      y: 0.60, // Middle-lower area
      w: 0.14,
      h: 0.12,
      label: button.label,
      action: button.action
    });
  });
  
  // Add Return button at the bottom to go back to map
  exteriorHotspots.push({
    shape: "rect",
    x: 0.40,
    y: 0.85,
    w: 0.20,
    h: 0.10,
    label: "Return",
    action: { type: "LEAVE_LOCATION" }
  });
  
  scenes.EXTERIOR = {
    image: null, // Will be generated dynamically when assets are ready
    hotspots: exteriorHotspots
  };
  
  // GENERAL_STORE_ROOM scene (station shop room)
  if (services.market) {
    scenes.GENERAL_STORE_ROOM = {
      image: null,
      title: "General Store",
      hotspots: [
        {
          shape: "rect",
          x: 0.36,
          y: 0.20,
          w: 0.22,
          h: 0.08,
          label: "Browse Goods",
          action: { type: "SHOP_BUY" }
        },
        {
          shape: "rect",
          x: 0.61,
          y: 0.20,
          w: 0.15,
          h: 0.08,
          label: "Leave",
          action: { type: "NAVIGATE", to: "HUB" }
        }
      ]
    };
  }
  
  // HANGAR_ROOM scene (station dockyard room)
  if (services.dockyard) {
    scenes.HANGAR_ROOM = {
      image: null,
      title: "Ship Hangar",
      hotspots: [
        {
          shape: "rect",
          x: 0.33,
          y: 0.20,
          w: 0.26,
          h: 0.08,
          label: "Talk to Mechanic",
          action: { type: "OPEN_DOCKYARD" }
        },
        {
          shape: "rect",
          x: 0.61,
          y: 0.20,
          w: 0.15,
          h: 0.08,
          label: "Leave",
          action: { type: "NAVIGATE", to: "HUB" }
        }
      ]
    };
  }
  
  // MEDBAY_ROOM scene (station clinic room)
  if (services.clinic) {
    scenes.MEDBAY_ROOM = {
      image: null,
      title: "Med-bay",
      hotspots: [
        {
          shape: "rect",
          x: 0.36,
          y: 0.20,
          w: 0.22,
          h: 0.08,
          label: "Check In",
          action: { type: "OPEN_CLINIC" }
        },
        {
          shape: "rect",
          x: 0.61,
          y: 0.20,
          w: 0.15,
          h: 0.08,
          label: "Leave",
          action: { type: "NAVIGATE", to: "HUB" }
        }
      ]
    };
  }
  
  // CANTINA_ROOM scene (station cantina room)
  if (services.cantina) {
    scenes.CANTINA_ROOM = {
      image: null,
      title: "Cantina",
      hotspots: [
        {
          shape: "rect",
          x: 0.34,
          y: 0.20,
          w: 0.25,
          h: 0.08,
          label: "Order at Bar",
          action: { type: "OPEN_CANTINA" }
        },
        {
          shape: "rect",
          x: 0.61,
          y: 0.20,
          w: 0.15,
          h: 0.08,
          label: "Leave",
          action: { type: "NAVIGATE", to: "HUB" }
        }
      ]
    };
  }
  
  // ADMIN_ROOM scene (station admin room)
  if (services.admin) {
    scenes.ADMIN_ROOM = {
      image: null,
      title: "Admin",
      hotspots: [
        {
          shape: "rect",
          x: 0.36,
          y: 0.20,
          w: 0.22,
          h: 0.08,
          label: "Access Terminal",
          action: { type: "OPEN_ADMIN" }
        },
        {
          shape: "rect",
          x: 0.61,
          y: 0.20,
          w: 0.15,
          h: 0.08,
          label: "Leave",
          action: { type: "NAVIGATE", to: "HUB" }
        }
      ]
    };
  }
  
  // INTERIOR_MARKET scene
  if (services.market) {
    scenes.INTERIOR_MARKET = {
      image: null,
      title: "General Store",
      hotspots: [
        // Bottom bar: Title at top, then actions separated by "|"
        // "Purchase | Sale | Return"
        {
          shape: "rect",
          x: 0.30,
          y: 0.20,
          w: 0.15,
          h: 0.08,
          label: "Purchase",
          action: { type: "SHOP_BUY" }
        },
        {
          shape: "rect",
          x: 0.47,
          y: 0.20,
          w: 0.12,
          h: 0.08,
          label: "Sale",
          action: { type: "SHOP_SELL" }
        },
        {
          shape: "rect",
          x: 0.61,
          y: 0.20,
          w: 0.15,
          h: 0.08,
          label: "Return",
          action: { type: "NAVIGATE", to: "HUB" }
        }
      ]
    };
  }
  
  // INTERIOR_DOCKYARD scene
  if (services.dockyard) {
    scenes.INTERIOR_DOCKYARD = {
      image: null,
      title: "Dockyard",
      hotspots: [
        // Bottom bar: "Make Repairs | Purchase Parts | Return"
        {
          shape: "rect",
          x: 0.30,
          y: 0.20,
          w: 0.15,
          h: 0.08,
          label: "Make Repairs",
          action: { type: "REPAIR", days: 1, shipIntegrityDelta: 20, cost: 50 }
        },
        {
          shape: "rect",
          x: 0.47,
          y: 0.20,
          w: 0.12,
          h: 0.08,
          label: "Purchase Parts",
          action: { type: "NAVIGATE", to: "INTERIOR_MARKET" }
        },
        {
          shape: "rect",
          x: 0.61,
          y: 0.20,
          w: 0.15,
          h: 0.08,
          label: "Return",
          action: { type: "NAVIGATE", to: "HUB" }
        }
      ]
    };
  }
  
  // INTERIOR_CLINIC scene
  if (services.clinic) {
    scenes.INTERIOR_CLINIC = {
      image: null,
      title: "Clinic",
      hotspots: [
        // Bottom bar: "Heal Crew | Purchase Meds | Return"
        {
          shape: "rect",
          x: 0.30,
          y: 0.20,
          w: 0.15,
          h: 0.08,
          label: "Heal Crew",
          action: { type: "HEAL", days: 1, cost: 50 }
        },
        {
          shape: "rect",
          x: 0.47,
          y: 0.20,
          w: 0.12,
          h: 0.08,
          label: "Purchase Meds",
          action: { type: "NAVIGATE", to: "INTERIOR_MARKET" }
        },
        {
          shape: "rect",
          x: 0.61,
          y: 0.20,
          w: 0.15,
          h: 0.08,
          label: "Return",
          action: { type: "NAVIGATE", to: "HUB" }
        }
      ]
    };
  }
  
  // INTERIOR_ADMIN scene
  if (services.admin) {
    scenes.INTERIOR_ADMIN = {
      image: null,
      title: "Admin",
      hotspots: [
        // Bottom bar: "News | Requests | Return"
        {
          shape: "rect",
          x: 0.30,
          y: 0.20,
          w: 0.15,
          h: 0.08,
          label: "News",
          action: { type: "INFO" } // Stub for now
        },
        {
          shape: "rect",
          x: 0.47,
          y: 0.20,
          w: 0.12,
          h: 0.08,
          label: "Requests",
          action: { type: "INFO" } // Stub for now
        },
        {
          shape: "rect",
          x: 0.61,
          y: 0.20,
          w: 0.15,
          h: 0.08,
          label: "Return",
          action: { type: "NAVIGATE", to: "HUB" }
        }
      ]
    };
  }
  
  // INTERIOR_CANTINA scene (optional)
  if (services.cantina) {
    scenes.INTERIOR_CANTINA = {
      image: null,
      title: "Cantina",
      hotspots: [
        // Bottom bar: "Order | Chat | Return"
        {
          shape: "rect",
          x: 0.30,
          y: 0.20,
          w: 0.15,
          h: 0.08,
          label: "Order",
          action: { type: "INFO" } // Stub for now
        },
        {
          shape: "rect",
          x: 0.47,
          y: 0.20,
          w: 0.12,
          h: 0.08,
          label: "Chat",
          action: { type: "INFO" } // Stub for now
        },
        {
          shape: "rect",
          x: 0.61,
          y: 0.20,
          w: 0.15,
          h: 0.08,
          label: "Return",
          action: { type: "NAVIGATE", to: "HUB" }
        }
      ]
    };
  }
  
  return {
    id: baseId,
    name: displayName,
    type: "station",
    scenes: scenes
  };
}

/**
 * Location definitions with scenes and hotspots
 * Images are generated dynamically using getSceneImagePath()
 * @type {Object<string, Location>}
 */
const LOCATIONS = {
  earth: {
    id: "earth",
    name: "EARTH LAUNCHPORT",
    type: "earth",
    scenes: {
      ARRIVAL: {
        image: null,
        title: "Earth Launchport",
        hotspots: [
          {
            shape: "rect",
            x: 0.32,
            y: 0.62,
            w: 0.36,
            h: 0.12,
            label: "Begin Mars Run",
            action: { type: "LEAVE_LOCATION" }
          }
        ]
      }
    }
  },
  mars: {
    id: "mars",
    name: "MARS APPROACH",
    type: "mars",
    scenes: {
      ARRIVAL: {
        image: null,
        title: "Mars Approach",
        hotspots: []
      }
    }
  },
  "outpost-0": {
    id: "outpost-0",
    name: "OUTPOST 0",
    type: "outpost",
    scenes: {
      OUTPOST_EXTERIOR: {
        image: null, // Will be generated dynamically: assets/scenes/outposts/outpost-01/arrival.png
        hotspots: [
          {
            shape: "rect",
            x: 0.4,
            y: 0.62,
            w: 0.2,
            h: 0.1,
            label: "Enter Outpost",
            action: { type: "NAVIGATE", to: "OUTPOST_INTERIOR" }
          },
          {
            shape: "rect",
            x: 0.4,
            y: 0.75,
            w: 0.2,
            h: 0.1,
            label: "Explore Area",
            action: { type: "OUTPOST_EXPLORE" }
          },
          {
            shape: "rect",
            x: 0.4,
            y: 0.88,
            w: 0.2,
            h: 0.1,
            label: "Leave",
            action: { type: "LEAVE_LOCATION" }
          }
        ]
      },
      OUTPOST_INTERIOR: {
        image: null, // Will be generated dynamically: assets/scenes/outposts/outpost-01/interior.png
        hotspots: [
          {
            shape: "rect",
            x: 0.2,
            y: 0.48,
            w: 0.18,
            h: 0.2,
            label: "Merchant",
            action: { type: "SHOP_BUY" }
          },
          {
            shape: "rect",
            x: 0.41,
            y: 0.48,
            w: 0.18,
            h: 0.2,
            label: "Mechanic",
            action: { type: "NAVIGATE", to: "OUTPOST_MECHANIC" }
          },
          {
            shape: "rect",
            x: 0.62,
            y: 0.48,
            w: 0.18,
            h: 0.2,
            label: "Rumor Kiosk",
            action: { type: "NAVIGATE", to: "OUTPOST_RUMOR" }
          },
          {
            shape: "rect",
            x: 0.4,
            y: 0.85,
            w: 0.2,
            h: 0.1,
            label: "Return",
            action: { type: "NAVIGATE", to: "OUTPOST_EXTERIOR" }
          }
        ]
      },
      INTERIOR_MARKET: {
        image: null, // Store overlay renders here
        hotspots: []
      },
      OUTPOST_MECHANIC: {
        image: null, // Mechanic overlay renders here
        hotspots: []
      },
      OUTPOST_RUMOR: {
        image: null, // Rumor kiosk overlay renders here
        hotspots: []
      }
    }
  },
  "asteroid-0": {
    id: "asteroid-0",
    name: "ASTEROID 0", // Will use actual generated name from map
    type: "asteroid",
    scenes: {
      ARRIVAL: {
        image: null, // Will be generated dynamically: assets/scenes/asteroids/arrival-asteroid-0.jpg
        hotspots: []
      },
      EXTERIOR: {
        image: null, // Will be generated dynamically: assets/scenes/asteroids/exterior-asteroid-0.jpg
        hotspots: []
      },
      EXPLORE: {
        image: null, // Will be generated dynamically (surface image)
        hotspots: []
      },
      TRADE: {
        image: null, // Will be generated dynamically
        hotspots: [
          {
            shape: "rect",
            x: 0.4,
            y: 0.85,
            w: 0.2,
            h: 0.1,
            label: "Back",
            action: { type: "NAVIGATE", to: "EXTERIOR" }
          }
        ]
      },
      COMBAT: {
        image: null, // Will be generated dynamically
        hotspots: [
          {
            shape: "rect",
            x: 0.4,
            y: 0.85,
            w: 0.2,
            h: 0.1,
            label: "Continue",
            action: { type: "NAVIGATE", to: "EXTERIOR" }
          }
        ]
      },
      INTERIOR: {
        image: null, // Will be generated dynamically: assets/scenes/asteroids/interior-asteroid-0.jpg
        hotspots: [
          {
            shape: "rect",
            x: 0.4,
            y: 0.85,
            w: 0.2,
            h: 0.1,
            label: "Back to Exterior",
            action: { type: "NAVIGATE", to: "EXTERIOR" }
          }
        ]
      }
    }
  },
  // Station location definitions - generated from template
  "station-01": createStationLocation("station-01", "STATION 01", {
    market: true,
    dockyard: true,
    clinic: true,
    admin: true,
    cantina: true  // Enable Cantina for station-01 for testing
  }),
  "station-02": createStationLocation("station-02", "STATION 02", {
    market: true,
    dockyard: true,
    clinic: true,
    admin: true,
    cantina: false
  }),
  "station-03": createStationLocation("station-03", "STATION 03", {
    market: true,
    dockyard: true,
    clinic: true,
    admin: true,
    cantina: false
  })
  // Add more locations as needed - images will be auto-generated using naming convention
};

// ---------------------------
// Station Hub Definitions (Panorama Panels)
// ---------------------------
const STATION_HUB_DEFS = {
  "station-01": {
    stationBaseId: "station-01",
    defaultPanelId: "PANEL-DOCK",
    panels: {
      "PANEL-DOCK": {
        panelId: "PANEL-DOCK",
        imagePath: "assets/scenes/stations/station-01/hub-01.jpg",
        turnLeft: "PANEL-MARKET",
        turnRight: "PANEL-MED",
        enterActions: [
          {
            label: "Enter Dockyard",
            toSceneId: "HANGAR_ROOM",
            hotspotRect: { x: 0.35, y: 0.68, w: 0.30, h: 0.12 }
          }
        ],
        uiActions: [
          {
            label: "Leave Station",
            actionType: "LEAVE_LOCATION",
            hotspotRect: { x: 0.40, y: 0.85, w: 0.20, h: 0.10 }
          }
        ]
      },
      "PANEL-MED": {
        panelId: "PANEL-MED",
        imagePath: "assets/scenes/stations/station-01/hub-02.jpg",
        turnLeft: "PANEL-DOCK",
        turnRight: "PANEL-CANTINA",
        enterActions: [
          {
            label: "Enter Med-bay",
            toSceneId: "MEDBAY_ROOM",
            hotspotRect: { x: 0.35, y: 0.68, w: 0.30, h: 0.12 }
          }
        ],
        uiActions: []
      },
      "PANEL-CANTINA": {
        panelId: "PANEL-CANTINA",
        imagePath: "assets/scenes/stations/station-01/hub-03.jpg",
        turnLeft: "PANEL-MED",
        turnRight: "PANEL-MARKET",
        enterActions: [
          {
            label: "Enter Cantina",
            toSceneId: "CANTINA_ROOM",
            hotspotRect: { x: 0.35, y: 0.68, w: 0.30, h: 0.12 }
          }
        ],
        uiActions: []
      },
      "PANEL-MARKET": {
        panelId: "PANEL-MARKET",
        imagePath: "assets/scenes/stations/station-01/hub-04.jpg",
        turnLeft: "PANEL-CANTINA",
        turnRight: "PANEL-DOCK",
        enterActions: [
          {
            label: "Enter General Store",
            toSceneId: "GENERAL_STORE_ROOM",
            hotspotRect: { x: 0.35, y: 0.68, w: 0.30, h: 0.12 }
          },
          {
            label: "Enter Admin",
            toSceneId: "ADMIN_ROOM",
            hotspotRect: { x: 0.35, y: 0.52, w: 0.30, h: 0.12 }
          }
        ],
        uiActions: []
      }
    }
  }
};

/** @type {{
 *  meta: { tab: Tab, travelView: TravelView },
 *  stats: { lifeSupport: number, shipIntegrity: number, credits: number, day: number, deadline: number },
 *  travel: { 
 *    currentLocationId: string,
 *    selectedDestinationId: string|null,
 *    hoveredNodeId: string|null,
 *    lastResolutionText: string|null,
 *    mapZoom: number,
 *    mapPanX: number,
 *    mapPanY: number
 *  }
 * }}
 */
// Initial gameState shape lives in js/state/initialState.js. That file
// also documents the conceptual slices inside `gameState.travel`
// (navigation, mapCamera, timeFlow, discovery, commerce, services,
// rumors, events).
const gameState = createInitialState();

// ---------------------------
// Supply Definitions
// ---------------------------

/**
 * @typedef {{
 *   id: string,
 *   name: string,
 *   subtype: "LIFE_SUPPORT" | "MEDICAL",
 *   tier: "OUTPOST" | "STATION" | "BOTH",
 *   rarity?: "COMMON" | "UNCOMMON" | "RARE",
 *   basePrice: number,
 *   effect: {
 *     type: "ADD_LIFE_DAYS" | "SET_LIFE_FULL" | "TREAT_CONDITION",
 *     days?: number, // for ADD_LIFE_DAYS
 *     treats?: string[], // for TREAT_CONDITION
 *     result?: string // for TREAT_CONDITION
 *   },
 *   tags?: string[]
 * }}
 */
// @typedef SupplyDef

/**
 * Supply definitions - all available supply items
 * @type {Object<string, SupplyDef>}
 */
const SUPPLY_DEFS = {
  // Life Support - Outpost tier
  "air_canister_s": {
    id: "air_canister_s",
    name: "Small Air Canister",
    subtype: "LIFE_SUPPORT",
    tier: "OUTPOST",
    rarity: "COMMON",
    basePrice: 10,
    effect: { type: "ADD_LIFE_DAYS", days: 1 },
    tags: ["life_support", "outpost"]
  },
  "air_canister_m": {
    id: "air_canister_m",
    name: "Medium Air Canister",
    subtype: "LIFE_SUPPORT",
    tier: "OUTPOST",
    rarity: "COMMON",
    basePrice: 18,
    effect: { type: "ADD_LIFE_DAYS", days: 2 },
    tags: ["life_support", "outpost"]
  },
  "air_canister_l": {
    id: "air_canister_l",
    name: "Large Air Canister",
    subtype: "LIFE_SUPPORT",
    tier: "OUTPOST",
    rarity: "COMMON",
    basePrice: 25,
    effect: { type: "ADD_LIFE_DAYS", days: 3 },
    tags: ["life_support", "outpost"]
  },
  
  // Life Support - Station tier
  "life_refill_5": {
    id: "life_refill_5",
    name: "Life Support Refill (Partial)",
    subtype: "LIFE_SUPPORT",
    tier: "STATION",
    rarity: "COMMON",
    basePrice: 40,
    effect: { type: "ADD_LIFE_DAYS", days: 5 },
    tags: ["life_support", "station"]
  },
  "life_refill_10": {
    id: "life_refill_10",
    name: "Life Support Refill (Standard)",
    subtype: "LIFE_SUPPORT",
    tier: "STATION",
    rarity: "COMMON",
    basePrice: 70,
    effect: { type: "ADD_LIFE_DAYS", days: 10 },
    tags: ["life_support", "station"]
  },
  "life_refill_full": {
    id: "life_refill_full",
    name: "Life Support Refill (Full)",
    subtype: "LIFE_SUPPORT",
    tier: "STATION",
    rarity: "UNCOMMON",
    basePrice: 150,
    effect: { type: "SET_LIFE_FULL" },
    tags: ["life_support", "station"]
  },
  
  // Medical - General (BOTH)
  "med_gel": {
    id: "med_gel",
    name: "Med-Gel Pack",
    subtype: "MEDICAL",
    tier: "BOTH",
    rarity: "COMMON",
    basePrice: 25,
    effect: { 
      type: "TREAT_CONDITION",
      treats: ["Injured", "Wounded"],
      result: "Recovering"
    },
    tags: ["medical", "general"]
  },
  "stimulant_kit": {
    id: "stimulant_kit",
    name: "Stimulant Kit",
    subtype: "MEDICAL",
    tier: "BOTH",
    rarity: "COMMON",
    basePrice: 30,
    effect: {
      type: "TREAT_CONDITION",
      treats: ["Exhausted", "Stressed"],
      result: "Healthy"
    },
    tags: ["medical", "general"]
  },
  "nutrient_rations": {
    id: "nutrient_rations",
    name: "Nutrient Rations",
    subtype: "MEDICAL",
    tier: "BOTH",
    rarity: "COMMON",
    basePrice: 20,
    effect: {
      type: "TREAT_CONDITION",
      treats: ["Malnourished"],
      result: "Recovering"
    },
    tags: ["medical", "general"]
  },
  
  // Medical - Station-only
  "antibiotics": {
    id: "antibiotics",
    name: "Antibiotic Course",
    subtype: "MEDICAL",
    tier: "STATION",
    rarity: "UNCOMMON",
    basePrice: 60,
    effect: {
      type: "TREAT_CONDITION",
      treats: ["Sick", "Infected"],
      result: "Recovering"
    },
    tags: ["medical", "station"]
  },
  "trauma_kit": {
    id: "trauma_kit",
    name: "Trauma Kit",
    subtype: "MEDICAL",
    tier: "STATION",
    rarity: "RARE",
    basePrice: 120,
    effect: {
      type: "TREAT_CONDITION",
      treats: ["Critical"],
      result: "Wounded"
    },
    tags: ["medical", "station"]
  },
  "sedative": {
    id: "sedative",
    name: "Sedative Dose",
    subtype: "MEDICAL",
    tier: "STATION",
    rarity: "UNCOMMON",
    basePrice: 45,
    effect: {
      type: "TREAT_CONDITION",
      treats: ["Panicked", "Rebelling"],
      result: "Stressed"
    },
    tags: ["medical", "station"]
  }
};

// Initialize inventory supplies (all start at 0 quantity)
Object.keys(SUPPLY_DEFS).forEach(supplyId => {
  gameState.inventory.supplies[supplyId] = { id: supplyId, qty: 0 };
});

// ---------------------------
// Ship Parts Definitions
// ---------------------------

/**
 * @typedef {{
 *   id: string,
 *   name: string,
 *   type: "REPAIR" | "UPGRADE",
 *   subtype?: "STRUCTURAL" | "ELECTRICAL" | "LIFE_SUPPORT" | "ANY", // For repair items
 *   upgradeType?: "SCANNER" | "ENGINE", // For upgrade items
 *   upgradeLevel?: number, // For upgrade items (1 or 2)
 *   repairAmount?: number, // For repair items (amount of integrity restored)
 *   basePrice: number,
 *   shopTier: "OUTPOST" | "STATION" | "BOTH", // Where this item can be purchased
 *   rarity?: "COMMON" | "UNCOMMON" | "RARE",
 *   tags?: string[]
 * }}
 */
// @typedef ShipPartDef

/**
 * Ship parts definitions - repair items and upgrades
 * @type {Object<string, ShipPartDef>}
 */
const SHIP_PART_DEFS = {
  // Repair Items - Structural
  "repair_welding_kit": {
    id: "repair_welding_kit",
    name: "Welding Kit",
    type: "REPAIR",
    subtype: "STRUCTURAL",
    repairAmount: 20,
    basePrice: 50,
    shopTier: "OUTPOST",
    rarity: "COMMON",
    tags: ["repair", "structural"]
  },
  "repair_structural_patch": {
    id: "repair_structural_patch",
    name: "Structural Patch",
    type: "REPAIR",
    subtype: "STRUCTURAL",
    repairAmount: 40,
    basePrice: 100,
    shopTier: "STATION",
    rarity: "COMMON",
    tags: ["repair", "structural"]
  },
  
  // Repair Items - Electrical
  "repair_wiring_kit": {
    id: "repair_wiring_kit",
    name: "Wiring Kit",
    type: "REPAIR",
    subtype: "ELECTRICAL",
    repairAmount: 20,
    basePrice: 50,
    shopTier: "OUTPOST",
    rarity: "COMMON",
    tags: ["repair", "electrical"]
  },
  "repair_circuit_board": {
    id: "repair_circuit_board",
    name: "Circuit Board",
    type: "REPAIR",
    subtype: "ELECTRICAL",
    repairAmount: 40,
    basePrice: 100,
    shopTier: "STATION",
    rarity: "COMMON",
    tags: ["repair", "electrical"]
  },
  
  // Repair Items - Life Support
  "repair_air_filter": {
    id: "repair_air_filter",
    name: "Air Filter",
    type: "REPAIR",
    subtype: "LIFE_SUPPORT",
    repairAmount: 20,
    basePrice: 50,
    shopTier: "OUTPOST",
    rarity: "COMMON",
    tags: ["repair", "life_support"]
  },
  "repair_life_support_module": {
    id: "repair_life_support_module",
    name: "Life Support Module",
    type: "REPAIR",
    subtype: "LIFE_SUPPORT",
    repairAmount: 40,
    basePrice: 100,
    shopTier: "STATION",
    rarity: "COMMON",
    tags: ["repair", "life_support"]
  },
  
  // Repair Items - Universal (ANY)
  "repair_emergency_kit": {
    id: "repair_emergency_kit",
    name: "Emergency Repair Kit",
    type: "REPAIR",
    subtype: "ANY",
    repairAmount: 15,
    basePrice: 75,
    shopTier: "BOTH",
    rarity: "COMMON",
    tags: ["repair", "universal"]
  },
  "repair_comprehensive_kit": {
    id: "repair_comprehensive_kit",
    name: "Comprehensive Repair Kit",
    type: "REPAIR",
    subtype: "ANY",
    repairAmount: 30,
    basePrice: 150,
    shopTier: "STATION",
    rarity: "UNCOMMON",
    tags: ["repair", "universal"]
  },
  
  // Upgrades - Scanner
  "upgrade_scanner_t1": {
    id: "upgrade_scanner_t1",
    name: "Scanner Upgrade Tier 1",
    type: "UPGRADE",
    upgradeType: "SCANNER",
    upgradeLevel: 1,
    basePrice: 200,
    shopTier: "STATION",
    rarity: "UNCOMMON",
    tags: ["upgrade", "scanner"]
  },
  "upgrade_scanner_t2": {
    id: "upgrade_scanner_t2",
    name: "Scanner Upgrade Tier 2",
    type: "UPGRADE",
    upgradeType: "SCANNER",
    upgradeLevel: 2,
    basePrice: 400,
    shopTier: "STATION",
    rarity: "RARE",
    tags: ["upgrade", "scanner"]
  },
  
  // Upgrades - Engine
  "upgrade_engine_t1": {
    id: "upgrade_engine_t1",
    name: "Engine Upgrade Tier 1",
    type: "UPGRADE",
    upgradeType: "ENGINE",
    upgradeLevel: 1,
    basePrice: 250,
    shopTier: "STATION",
    rarity: "UNCOMMON",
    tags: ["upgrade", "engine"]
  },
  "upgrade_engine_t2": {
    id: "upgrade_engine_t2",
    name: "Engine Upgrade Tier 2",
    type: "UPGRADE",
    upgradeType: "ENGINE",
    upgradeLevel: 2,
    basePrice: 500,
    shopTier: "STATION",
    rarity: "RARE",
    tags: ["upgrade", "engine"]
  }
};

// Initialize inventory parts (all start at 0 quantity)
Object.keys(SHIP_PART_DEFS).forEach(partId => {
  gameState.inventory.parts[partId] = 0;
});

// ---------------------------
// Artifact Catalog
// ---------------------------

/**
 * @typedef {{
 *   id: string,
 *   name: string,
 *   rarity: "COMMON" | "UNCOMMON" | "RARE" | "LEGENDARY",
 *   size: "SMALL" | "MEDIUM" | "LARGE",
 *   baseValue: number,
 *   riskTier: "NONE" | "LOW" | "MED" | "HIGH",
 *   riskFlags: string[],
 *   origin: "ASTEROID" | "DERELICT" | "SHIP" | "ANOMALY" | "OUTPOST",
 *   description: string,
 *   icon?: string | null
 * }}
 */
// @typedef ArtifactDef

/**
 * Artifact catalog - all available artifacts
 * @type {Array<ArtifactDef>}
 */
const ARTIFACT_CATALOG = [
  {
    id: "survey-tag-cache",
    name: "Survey Tag Cache",
    rarity: "COMMON",
    size: "SMALL",
    baseValue: 35,
    riskTier: "NONE",
    riskFlags: [],
    origin: "ASTEROID",
    description: "Stamped metal tags from a forgotten survey crew."
  },
  {
    id: "cryo-glass-shard",
    name: "Cryo-Glass Shard",
    rarity: "COMMON",
    size: "SMALL",
    baseValue: 45,
    riskTier: "LOW",
    riskFlags: ["CREW_SICKNESS"],
    origin: "DERELICT",
    description: "Frosted glass that stays cold to the touch."
  },
  {
    id: "ion-etched-coin",
    name: "Ion Etched Coin",
    rarity: "COMMON",
    size: "SMALL",
    baseValue: 55,
    riskTier: "LOW",
    riskFlags: ["CREDITS_THEFT"],
    origin: "SHIP",
    description: "A currency nobody recognizes, cut with ion grooves."
  },
  {
    id: "vacuum-charms",
    name: "Vacuum Charms",
    rarity: "COMMON",
    size: "SMALL",
    baseValue: 60,
    riskTier: "LOW",
    riskFlags: ["ATTRACTS_ATTENTION"],
    origin: "OUTPOST",
    description: "Lucky trinkets sold to travelers who don't ask questions."
  },
  {
    id: "rust-bloom-relic",
    name: "Rust Bloom Relic",
    rarity: "COMMON",
    size: "MEDIUM",
    baseValue: 70,
    riskTier: "LOW",
    riskFlags: ["HULL_CORROSION"],
    origin: "ASTEROID",
    description: "A porous metal 'flower' that oxidizes anything nearby."
  },
  {
    id: "blackbox-fragment",
    name: "Blackbox Fragment",
    rarity: "UNCOMMON",
    size: "SMALL",
    baseValue: 90,
    riskTier: "LOW",
    riskFlags: ["SCANNER_GLITCH"],
    origin: "DERELICT",
    description: "A recorder core that jitters when scanned."
  },
  {
    id: "amber-circuit-strand",
    name: "Amber Circuit Strand",
    rarity: "UNCOMMON",
    size: "SMALL",
    baseValue: 110,
    riskTier: "MED",
    riskFlags: ["SCANNER_GLITCH", "LIFE_SUPPORT_LEAK"],
    origin: "SHIP",
    description: "Looks like resin… behaves like circuitry."
  },
  {
    id: "hull-plating-fossil",
    name: "Hull-Plating Fossil",
    rarity: "UNCOMMON",
    size: "MEDIUM",
    baseValue: 120,
    riskTier: "LOW",
    riskFlags: ["HULL_CORROSION"],
    origin: "ASTEROID",
    description: "Compressed layers of ancient ship plating."
  },
  {
    id: "synthetic-choir-spool",
    name: "Synthetic Choir Spool",
    rarity: "UNCOMMON",
    size: "SMALL",
    baseValue: 135,
    riskTier: "MED",
    riskFlags: ["CREW_SICKNESS", "ATTRACTS_ATTENTION"],
    origin: "ANOMALY",
    description: "Plays a harmony that makes people uneasy."
  },
  {
    id: "polymer-stasis-quilt",
    name: "Polymer Stasis Quilt",
    rarity: "UNCOMMON",
    size: "LARGE",
    baseValue: 150,
    riskTier: "MED",
    riskFlags: ["LIFE_SUPPORT_LEAK"],
    origin: "DERELICT",
    description: "A folded sheet that 'steals' warmth from air."
  },
  {
    id: "pilgrims-compass",
    name: "Pilgrim's Compass",
    rarity: "RARE",
    size: "SMALL",
    baseValue: 220,
    riskTier: "MED",
    riskFlags: ["SCANNER_GLITCH", "ATTRACTS_ATTENTION"],
    origin: "ANOMALY",
    description: "Points somewhere you can't plot."
  },
  {
    id: "mercury-wet-idol",
    name: "Mercury-Wet Idol",
    rarity: "RARE",
    size: "SMALL",
    baseValue: 260,
    riskTier: "HIGH",
    riskFlags: ["CREW_SICKNESS", "CREDITS_THEFT"],
    origin: "OUTPOST",
    description: "A figurine that seems to 'move' when you're tired."
  },
  {
    id: "soot-library-cylinder",
    name: "Soot-Library Cylinder",
    rarity: "RARE",
    size: "MEDIUM",
    baseValue: 280,
    riskTier: "MED",
    riskFlags: ["ATTRACTS_ATTENTION"],
    origin: "DERELICT",
    description: "A data cylinder sealed in soot and wax."
  },
  {
    id: "radiant-pollen-jar",
    name: "Radiant Pollen Jar",
    rarity: "RARE",
    size: "SMALL",
    baseValue: 300,
    riskTier: "HIGH",
    riskFlags: ["LIFE_SUPPORT_LEAK", "CREW_SICKNESS"],
    origin: "ANOMALY",
    description: "Glowing dust that fogs helmet seals."
  },
  {
    id: "mirror-moss-frame",
    name: "Mirror-Moss Frame",
    rarity: "RARE",
    size: "LARGE",
    baseValue: 320,
    riskTier: "HIGH",
    riskFlags: ["SCANNER_GLITCH", "HULL_CORROSION"],
    origin: "ASTEROID",
    description: "Reflective growth that eats at metal edges."
  },
  {
    id: "lagrange-locket",
    name: "Lagrange Locket",
    rarity: "LEGENDARY",
    size: "SMALL",
    baseValue: 500,
    riskTier: "HIGH",
    riskFlags: ["ATTRACTS_ATTENTION", "CREDITS_THEFT"],
    origin: "SHIP",
    description: "A locket that 'belongs' to someone important."
  },
  {
    id: "gravitic-pearl",
    name: "Gravitic Pearl",
    rarity: "LEGENDARY",
    size: "SMALL",
    baseValue: 650,
    riskTier: "HIGH",
    riskFlags: ["SCANNER_GLITCH", "LIFE_SUPPORT_LEAK"],
    origin: "ANOMALY",
    description: "Makes instruments lie by a few degrees."
  },
  {
    id: "saint-engine-tooth",
    name: "Saint Engine Tooth",
    rarity: "LEGENDARY",
    size: "MEDIUM",
    baseValue: 750,
    riskTier: "HIGH",
    riskFlags: ["HULL_CORROSION", "ATTRACTS_ATTENTION"],
    origin: "DERELICT",
    description: "A turbine blade from a mythic drive system."
  },
  {
    id: "the-red-thread",
    name: "The Red Thread",
    rarity: "LEGENDARY",
    size: "SMALL",
    baseValue: 900,
    riskTier: "HIGH",
    riskFlags: ["CREW_SICKNESS", "SCANNER_GLITCH"],
    origin: "ANOMALY",
    description: "A fiber that never breaks; nobody agrees on its color."
  },
  {
    id: "cathedral-seed",
    name: "Cathedral Seed",
    rarity: "LEGENDARY",
    size: "LARGE",
    baseValue: 1200,
    riskTier: "HIGH",
    riskFlags: ["LIFE_SUPPORT_LEAK", "HULL_CORROSION", "ATTRACTS_ATTENTION"],
    origin: "ANOMALY",
    description: "A dormant 'seed' that hums like distant machinery."
  }
];

// ---------------------------
// Artifact Functions
// ---------------------------

/**
 * Roll for an artifact based on origin
 * @param {string} origin Origin type ("ASTEROID" | "DERELICT" | "SHIP" | "ANOMALY" | "OUTPOST")
 * @returns {string|null} Artifact ID or null if no match
 */
function rollArtifact(origin) {
  // Rarity weights by origin
  const rarityWeights = {
    ASTEROID: { COMMON: 0.70, UNCOMMON: 0.25, RARE: 0.05, LEGENDARY: 0.00 },
    DERELICT: { COMMON: 0.55, UNCOMMON: 0.30, RARE: 0.13, LEGENDARY: 0.02 },
    SHIP: { COMMON: 0.60, UNCOMMON: 0.25, RARE: 0.13, LEGENDARY: 0.02 },
    ANOMALY: { COMMON: 0.35, UNCOMMON: 0.30, RARE: 0.25, LEGENDARY: 0.10 },
    OUTPOST: { COMMON: 0.65, UNCOMMON: 0.25, RARE: 0.10, LEGENDARY: 0.00 }
  };
  
  const weights = rarityWeights[origin] || rarityWeights.ASTEROID;
  
  // Roll for rarity
  const roll = Math.random();
  let selectedRarity = "COMMON";
  if (roll < weights.COMMON) {
    selectedRarity = "COMMON";
  } else if (roll < weights.COMMON + weights.UNCOMMON) {
    selectedRarity = "UNCOMMON";
  } else if (roll < weights.COMMON + weights.UNCOMMON + weights.RARE) {
    selectedRarity = "RARE";
  } else {
    selectedRarity = "LEGENDARY";
  }
  
  // Filter catalog by rarity
  let candidates = ARTIFACT_CATALOG.filter(a => a.rarity === selectedRarity);
  
  // Prefer artifacts matching origin, but fall back to any of that rarity
  const originMatches = candidates.filter(a => a.origin === origin);
  if (originMatches.length > 0) {
    candidates = originMatches;
  }
  
  // Choose uniformly among candidates
  if (candidates.length === 0) {
    return null;
  }
  
  const selected = candidates[Math.floor(Math.random() * candidates.length)];
  return selected.id;
}

/**
 * Grant a random artifact to the player
 * @param {string} origin Origin type
 * @param {string|null} sourceNodeId Source node ID (optional)
 * @returns {Object|null} Artifact instance or null
 */
function grantRandomArtifact(origin, sourceNodeId = null) {
  const artifactId = rollArtifact(origin);
  if (!artifactId) {
    return null;
  }
  return grantArtifactById(artifactId, sourceNodeId);
}

/**
 * Grant a specific artifact by ID
 * @param {string} artifactId Artifact ID
 * @param {string|null} sourceNodeId Source node ID (optional)
 * @returns {Object|null} Artifact instance or null
 */
function grantArtifactById(artifactId, sourceNodeId = null) {
  const artifactDef = ARTIFACT_CATALOG.find(a => a.id === artifactId);
  if (!artifactDef) {
    console.warn(`Unknown artifact: ${artifactId}`);
    return null;
  }
  
  // Create artifact instance
  const instance = {
    instanceId: `artifact_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`,
    artifactId: artifactId,
    acquiredDay: gameState.stats.day,
    sourceNodeId: sourceNodeId,
    identified: false, // Default to unidentified
    condition: 100 // Default condition
  };
  
  // Add to inventory
  gameState.inventory.artifacts.push(instance);
  
  // Log artifact acquisition (ALWAYS its own entry)
  const artifactName = artifactDef.name;
  const riskNote = artifactDef.riskTier !== "NONE" ? ` (${artifactDef.riskTier.toLowerCase()} risk)` : "";
  logAdd("ARTIFACT_ACQUIRED", `Acquired artifact — "${artifactName}"${riskNote}.`, {
    artifactId: artifactId,
    locationId: sourceNodeId
  });
  
  // Update UI
  render();
  
  return instance;
}

/**
 * Seed starting inventory with dev items for testing
 * Only runs if DEV_SEED_STARTING_ITEMS is true and devSeedApplied is false
 */
function seedDevStartingInventory() {
  // Check dev flag and guard
  if (!DEV_SEED_STARTING_ITEMS || gameState.meta.devSeedApplied) {
    return;
  }
  
  // Seed artifacts (directly push to avoid logging/render overhead)
  const artifactIds = [
    "survey-tag-cache",      // COMMON, 35 credits
    "cryo-glass-shard",     // COMMON, 45 credits
    "blackbox-fragment",    // UNCOMMON, 90 credits
    "amber-circuit-strand"  // UNCOMMON, 110 credits
  ];
  
  artifactIds.forEach((artifactId, index) => {
    // Verify artifact exists in catalog
    const artifactDef = ARTIFACT_CATALOG.find(a => a.id === artifactId);
    if (!artifactDef) {
      console.warn(`[DEV SEED] Artifact not found in catalog: ${artifactId}`);
      return;
    }
    
    // Create artifact instance directly (matching grantArtifactById structure)
    const instance = {
      instanceId: `artifact_dev_seed_${Date.now()}_${index}_${Math.random().toString(36).substr(2, 9)}`,
      artifactId: artifactId,
      acquiredDay: gameState.stats.day,
      sourceNodeId: "DEV_SEED",
      identified: false,
      condition: 100
    };
    
    // Push directly to inventory (no logging, no render)
    gameState.inventory.artifacts.push(instance);
  });
  
  // Seed a few supplies (optional, for broader testing)
  if (gameState.inventory.supplies["air_canister_s"]) {
    gameState.inventory.supplies["air_canister_s"].qty = 2;
  }
  if (gameState.inventory.supplies["med_gel"]) {
    gameState.inventory.supplies["med_gel"].qty = 1;
  }
  
  // Seed a couple parts (optional, for broader testing)
  if (gameState.inventory.parts["repair_welding_kit"]) {
    gameState.inventory.parts["repair_welding_kit"] = 1;
  }
  if (gameState.inventory.parts["repair_emergency_kit"]) {
    gameState.inventory.parts["repair_emergency_kit"] = 1;
  }
  
  // Set guard flag
  gameState.meta.devSeedApplied = true;
  
  // Single console message
  debugLog("DEV: Seeded starting inventory");
}

/**
 * Get sell price for an artifact
 * @param {Object} artifactInstance Artifact instance
 * @param {string} locationType Location type ("station" | "outpost")
 * @returns {number} Sell price in credits
 */
function getArtifactSellPrice(artifactInstance, locationType) {
  const artifactDef = ARTIFACT_CATALOG.find(a => a.id === artifactInstance.artifactId);
  if (!artifactDef) {
    return 0;
  }
  
  let price = artifactDef.baseValue;
  
  // Location modifier
  if (locationType === "station") {
    price *= 1.0;
  } else if (locationType === "outpost") {
    price *= 0.75;
  }
  
  // TODO: Add condition modifier, appraisal bonuses, etc.
  
  return Math.floor(price);
}

/**
 * Sell an artifact
 * @param {string} instanceId Artifact instance ID
 * @param {string} locationType Location type ("station" | "outpost")
 * @returns {boolean} True if successfully sold
 */
function sellArtifact(instanceId, locationType) {
  const instanceIndex = gameState.inventory.artifacts.findIndex(a => a.instanceId === instanceId);
  if (instanceIndex === -1) {
    console.warn(`Artifact instance not found: ${instanceId}`);
    return false;
  }
  
  const instance = gameState.inventory.artifacts[instanceIndex];
  const price = getArtifactSellPrice(instance, locationType);
  
  // Add credits
  gameState.stats.credits += price;
  
  // Remove from inventory
  gameState.inventory.artifacts.splice(instanceIndex, 1);
  
  // Update UI
  render();
  
  return true;
}

/**
 * Process artifact carry risks for days advanced
 * @param {number} daysAdvanced Number of days to process
 */
function processArtifactCarryRisks(daysAdvanced) {
  if (daysAdvanced <= 0 || gameState.inventory.artifacts.length === 0) {
    return;
  }
  
  // Risk tier probabilities per day
  const riskProbabilities = {
    NONE: 0.00,
    LOW: 0.01,
    MED: 0.025,
    HIGH: 0.05
  };
  
  // Process each day
  for (let day = 0; day < daysAdvanced; day++) {
    const triggeredArtifacts = [];
    
    // Check each artifact
    gameState.inventory.artifacts.forEach(instance => {
      const artifactDef = ARTIFACT_CATALOG.find(a => a.id === instance.artifactId);
      if (!artifactDef || artifactDef.riskFlags.length === 0) {
        return;
      }
      
      const riskTier = artifactDef.riskTier;
      const probability = riskProbabilities[riskTier] || 0;
      
      if (Math.random() < probability) {
        triggeredArtifacts.push({
          instance: instance,
          artifactDef: artifactDef
        });
      }
    });
    
    // Only allow one artifact-triggered event per day
    if (triggeredArtifacts.length > 0) {
      // Sort by risk tier (HIGH > MED > LOW > NONE)
      const tierOrder = { HIGH: 3, MED: 2, LOW: 1, NONE: 0 };
      triggeredArtifacts.sort((a, b) => {
        const orderA = tierOrder[a.artifactDef.riskTier] || 0;
        const orderB = tierOrder[b.artifactDef.riskTier] || 0;
        if (orderA !== orderB) {
          return orderB - orderA; // Higher risk first
        }
        return Math.random() - 0.5; // Tie-break random
      });
      
      // Apply the highest risk artifact's effect
      const selected = triggeredArtifacts[0];
      applyArtifactRiskEffect(selected.artifactDef);
      
      // Log artifact risk
      const artifactDef = selected.artifactDef;
      const riskText = `Artifact interference. ${getArtifactRiskDescription(artifactDef)}`;
      logUpsertDaily("ARTIFACT_RISK", gameState.stats.day, riskText, {
        artifactId: selected.instance.artifactId
      });
    }
  }
}

/**
 * Apply Vista relief effect (morale/ailment improvement)
 * Checks for ailment system capability, uses fallback if not available
 * @param {string} locationId Location ID where vista was found
 * @returns {Object} Result object with { message: string, crewId: string|null }
 */
function applyVistaRelief(locationId) {
  // Step 1: Capability check for ailment system
  // Check if crew members have an ailments array, conditionSeverity field, or gameState.crew.ailments map
  const hasAilmentSystem = 
    (gameState.crew.members.length > 0 && 
     (Array.isArray(gameState.crew.members[0].ailments) || 
      typeof gameState.crew.members[0].conditionSeverity !== 'undefined')) ||
    (gameState.crew.ailments && typeof gameState.crew.ailments === 'object');
  
  if (hasAilmentSystem) {
    // Step 3: Real ailment reduction (reserved for future implementation)
    // TODO: When ailment system is implemented, add logic here:
    // - Reduce ailment severity by 1 for one crew member
    // - Or reduce one ailment by 1 step
    // - Or remove the lowest severity ailment
    
    // For now, fall through to fallback
  }
  
  // Step 2: Fallback effect (works today)
  // Ordered list of bad statuses (worst → better)
  const badStatuses = [
    "Dying",
    "Deceased", // Note: Deceased might not be recoverable, but we'll handle it
    "Critical",
    "Unconscious",
    "Infected",
    "Sick",
    "Wounded",
    "Injured",
    "Panicked",
    "Exhausted",
    "Stressed",
    "Malnourished",
    "Exposed",
    "Tired",
    "Confused",
    "Rebelling"
  ];
  
  // Find crew members with bad statuses
  const crewWithBadStatus = gameState.crew.members
    .map((member, index) => ({ member, index, statusIndex: badStatuses.indexOf(member.status) }))
    .filter(item => item.statusIndex !== -1 && item.member.status !== "Deceased"); // Exclude deceased
  
  if (crewWithBadStatus.length > 0) {
    // Select the worst one (earliest in the list = lowest statusIndex)
    crewWithBadStatus.sort((a, b) => a.statusIndex - b.statusIndex);
    const worstCrew = crewWithBadStatus[0].member;
    
    // Set them to "Recovering" (not directly Healthy — keeps some grit)
    worstCrew.status = "Recovering";
    
    return {
      message: `The vista steadies the crew. ${worstCrew.name} looks better.`,
      crewId: worstCrew.id
    };
  } else {
    // No one in a bad state
    return {
      message: "The crew feels steadier.",
      crewId: null
    };
  }
}

/**
 * Get human-readable description of artifact risk effect
 * @param {ArtifactDef} artifactDef Artifact definition
 * @returns {string} Description text
 */
function getArtifactRiskDescription(artifactDef) {
  // This will be called after the effect is applied, so we can describe what happened
  // For now, return a generic description based on risk flags
  if (artifactDef.riskFlags.includes("SCANNER_GLITCH")) {
    return "Scanner range reduced.";
  } else if (artifactDef.riskFlags.includes("LIFE_SUPPORT_LEAK")) {
    return "Life support leak detected.";
  } else if (artifactDef.riskFlags.includes("CREW_SICKNESS")) {
    return "Crew member fell ill.";
  } else if (artifactDef.riskFlags.includes("HULL_CORROSION")) {
    return "Hull corrosion detected.";
  } else if (artifactDef.riskFlags.includes("ATTRACTS_ATTENTION")) {
    return "Drew unwanted attention.";
  } else if (artifactDef.riskFlags.includes("CREDITS_THEFT")) {
    return "Credits went missing.";
  }
  return "Unknown interference occurred.";
}

// ---------------------------
// Log System
// ---------------------------

/**
 * Add a log entry
 * @param {string} type Log entry type
 * @param {string} text Log entry text
 * @param {Object} context Optional context object
 */
function logAdd(type, text, context = {}) {
  const entry = {
    id: `${gameState.stats.day}_${type}_${Date.now()}`,
    day: gameState.stats.day,
    type: type,
    text: text,
    context: context,
    ts: Date.now()
  };
  
  gameState.log.entries.push(entry);
  
  // Enforce maxEntries (remove oldest if over cap)
  if (gameState.log.entries.length > gameState.log.maxEntries) {
    gameState.log.entries.shift();
  }
  
  // Update UI if on LOG tab
  if (gameState.meta.tab === "LOG") {
    render();
  }
}

/**
 * Upsert a daily log entry (append to existing or create new)
 * @param {string} type Log entry type
 * @param {number} day Day number
 * @param {string} patchText Text to append or set
 * @param {Object} context Optional context object
 */
function logUpsertDaily(type, day, patchText, context = {}) {
  // Find first entry with matching day and type
  const existingIndex = gameState.log.entries.findIndex(
    e => e.day === day && e.type === type
  );
  
  if (existingIndex !== -1) {
    // Append to existing entry
    const existing = gameState.log.entries[existingIndex];
    existing.text = existing.text ? `${existing.text}. ${patchText}` : patchText;
    // Merge context
    existing.context = { ...existing.context, ...context };
  } else {
    // Create new entry
    const entry = {
      id: `${day}_${type}_${Date.now()}`,
      day: day,
      type: type,
      text: patchText,
      context: context,
      ts: Date.now()
    };
    
    gameState.log.entries.push(entry);
    
    // Enforce maxEntries
    if (gameState.log.entries.length > gameState.log.maxEntries) {
      gameState.log.entries.shift();
    }
  }
  
  // Update UI if on LOG tab
  if (gameState.meta.tab === "LOG") {
    render();
  }
}

/**
 * Append text to best daily entry (prefers LANDING_SUMMARY, then RANDOM_EVENT)
 * @param {number} day Day number
 * @param {string} patchText Text to append
 * @param {Array<string>} preferredTypes Preferred types in order
 */
function logAppendToBestDaily(day, patchText, preferredTypes = ["LANDING_SUMMARY", "RANDOM_EVENT"]) {
  // Try to find preferred types in order
  for (const preferredType of preferredTypes) {
    const existingIndex = gameState.log.entries.findIndex(
      e => e.day === day && e.type === preferredType
    );
    
    if (existingIndex !== -1) {
      const existing = gameState.log.entries[existingIndex];
      existing.text = existing.text ? `${existing.text}. ${patchText}` : patchText;
      
      // Update UI if on LOG tab
      if (gameState.meta.tab === "LOG") {
        render();
      }
      return;
    }
  }
  
  // Fallback: create CREW_UPDATE entry
  logAdd("CREW_UPDATE", patchText, {});
}

/**
 * Start a landing draft
 * @param {string} locationId Location ID
 * @param {string} locationName Location name
 * @param {string} locationType Location type
 */
function logStartLandingDraft(locationId, locationName, locationType) {
  gameState.log.landingDraft = {
    day: gameState.stats.day,
    locationId: locationId,
    locationName: locationName,
    locationType: locationType,
    lines: []
  };
}

/**
 * Add a line to the current landing draft
 * @param {string} line Line to add
 */
function landingDraftAdd(line) {
  if (!gameState.log.landingDraft) {
    return;
  }
  
  // Prevent duplicates
  if (!gameState.log.landingDraft.lines.includes(line)) {
    gameState.log.landingDraft.lines.push(line);
  }
}

/**
 * Finalize the landing summary and create log entry
 */
function logFinalizeLandingSummary() {
  if (!gameState.log.landingDraft) {
    return;
  }
  
  const draft = gameState.log.landingDraft;
  const day = draft.day;
  const locationName = draft.locationName;
  
  // Build final text
  let text = `Landed at ${locationName}.`;
  if (draft.lines.length > 0) {
    text += ` ${draft.lines.join(". ")}.`;
  }
  
  // Create or update entry
  logUpsertDaily("LANDING_SUMMARY", day, text, {
    locationId: draft.locationId,
    locationName: draft.locationName,
    locationType: draft.locationType
  });
  
  // Clear draft
  gameState.log.landingDraft = null;
}

/**
 * Apply an artifact risk effect
 * @param {ArtifactDef} artifactDef Artifact definition
 */
function applyArtifactRiskEffect(artifactDef) {
  if (artifactDef.riskFlags.length === 0) {
    return;
  }
  
  // Pick one flag uniformly
  const selectedFlag = artifactDef.riskFlags[Math.floor(Math.random() * artifactDef.riskFlags.length)];
  
  switch (selectedFlag) {
    case "SCANNER_GLITCH":
      gameState.travel.scannerGlitchDays = Math.max(gameState.travel.scannerGlitchDays, 2);
      debugLog(`[Artifact Risk] Scanner glitch activated for ${gameState.travel.scannerGlitchDays} days`);
      break;
      
    case "LIFE_SUPPORT_LEAK":
      gameState.stats.lifeSupport = Math.max(0, gameState.stats.lifeSupport - 1);
      debugLog("[Artifact Risk] Life support leak detected");
      break;
      
    case "CREW_SICKNESS":
      if (gameState.crew.members.length > 0) {
        const randomCrew = gameState.crew.members[Math.floor(Math.random() * gameState.crew.members.length)];
        // Only set to "Sick" if not already worse
        const worseStatuses = ["Critical", "Dying", "Deceased", "Unconscious"];
        if (!worseStatuses.includes(randomCrew.status)) {
          randomCrew.status = "Sick";
          debugLog(`[Artifact Risk] ${randomCrew.name} became sick`);
        }
      }
      break;
      
    case "HULL_CORROSION":
      addShipIntegrity(gameState, -1);
      debugLog("[Artifact Risk] Hull corrosion detected");
      break;
      
    case "ATTRACTS_ATTENTION":
      gameState.travel.attention += 1;
      debugLog(`[Artifact Risk] Attention increased to ${gameState.travel.attention}`);
      break;
      
    case "CREDITS_THEFT":
      const theftAmount = Math.floor(Math.random() * 16) + 5; // 5-20 credits
      if (gameState.stats.credits >= theftAmount) {
        gameState.stats.credits -= theftAmount;
        debugLog(`[Artifact Risk] Lost ${theftAmount} credits to theft`);
      } else if (gameState.stats.credits >= 5) {
        gameState.stats.credits = 0;
        debugLog(`[Artifact Risk] Lost all remaining credits to theft`);
      }
      // If credits < 5, ignore as per spec
      break;
      
    default:
      console.warn(`Unknown risk flag: ${selectedFlag}`);
  }
  
  // Update UI
  render();
}

// Debug hooks (exposed to window for console access)
if (typeof window !== 'undefined') {
  window.DEBUG_GRANT_ARTIFACT = (origin) => {
    return grantRandomArtifact(origin || "ASTEROID");
  };
  
  window.DEBUG_GRANT_ARTIFACT_BY_ID = (id) => {
    return grantArtifactById(id);
  };
  
  window.DEBUG_START_EVENT = () => {
    startEvent({
      title: "Test Event",
      body: "This is a test event. Choose an option to see the outcome.",
      options: ["Option 01", "Option 02", "Option 03"],
      image: null
    });
  };
  
  /**
   * Debug function to test asteroid landing and friendly trader encounter
   * Usage: DEBUG_TEST_FRIENDLY_TRADER()
   * This will:
   * 1. Find or use the first asteroid
   * 2. Set it to inhabited
   * 3. Set current location to that asteroid
   * 4. Trigger the landing flow
   * 5. Force friendly trader outcome
   */
  window.DEBUG_TEST_FRIENDLY_TRADER = () => {
    // Find first asteroid
    const asteroid = mapNodes.find(n => n.type === "asteroid");
    if (!asteroid) {
      console.error("[DEBUG] No asteroid found in mapNodes");
      return;
    }
    
    debugLog("[DEBUG] Testing friendly trader on asteroid:", asteroid.id);
    
    // Set asteroid to inhabited
    generateAsteroidTruthValues(asteroid);
    asteroid.inhabitedTruth = true;
    asteroid.inhabited = "likely";
    
    // Set current location to this asteroid
    gameState.travel.currentLocationId = asteroid.id;
    gameState.travel.currentSceneId = "ARRIVAL";
    
    // Ensure asteroid is scanned so it's visible
    if (gameState.travel.scannedNodes) {
      gameState.travel.scannedNodes.add(asteroid.id);
    }
    if (gameState.travel.deepScannedNodes) {
      gameState.travel.deepScannedNodes.add(asteroid.id);
    }
    
    // Trigger landing event
    showAsteroidArrivalEvent(asteroid.id);
    
    debugLog("[DEBUG] Landing event triggered. Click 'Explore' then 'Make Contact' to test trader.");
  };
  
  /**
   * Debug helper: jump to an inhabited asteroid exterior
   * Usage: DEBUG_FORCE_INHABITED_ASTEROID()
   */
  window.DEBUG_FORCE_INHABITED_ASTEROID = () => {
    const asteroid = mapNodes.find(n => n.type === "asteroid");
    if (!asteroid) {
      console.error("[DEBUG] No asteroid found in mapNodes");
      return;
    }
    
    generateAsteroidTruthValues(asteroid);
    asteroid.inhabitedTruth = true;
    asteroid.inhabited = "likely";
    
    if (gameState.travel.scannedNodes) {
      gameState.travel.scannedNodes.add(asteroid.id);
    }
    if (gameState.travel.deepScannedNodes) {
      gameState.travel.deepScannedNodes.add(asteroid.id);
    }
    
    if (gameState.travel.isEventActive) {
      endEvent();
    }
    closeAllOverlays();
    gameState.travel.currentLocationId = asteroid.id;
    gameState.travel.currentSceneId = "EXTERIOR";
    gameState.travel.selectedLocationId = asteroid.id;
    gameState.travel.selectedDestinationId = null;
    render();
    
    debugLog("[DEBUG] Jumped to inhabited asteroid exterior:", asteroid.id);
  };
  
  /**
   * Debug function to directly trigger friendly trader encounter
   * Usage: DEBUG_FORCE_FRIENDLY_TRADER()
   * This bypasses the landing/exploration flow and goes straight to the trader
   */
  window.DEBUG_FORCE_FRIENDLY_TRADER = () => {
    // Find first asteroid
    const asteroid = mapNodes.find(n => n.type === "asteroid");
    if (!asteroid) {
      console.error("[DEBUG] No asteroid found in mapNodes");
      return;
    }
    
    debugLog("[DEBUG] Forcing friendly trader encounter on asteroid:", asteroid.id);
    
    // Set asteroid to inhabited and force friendly contact outcome
    generateAsteroidTruthValues(asteroid);
    asteroid.inhabitedTruth = true;
    asteroid.contactOutcome = "friendly"; // Force friendly outcome
    
    // Set current location
    gameState.travel.currentLocationId = asteroid.id;
    
    // Directly trigger friendly trader event (bypassing landing/exploration)
    const markClearedAndContinue = () => {
      if (!gameState.travel.clearedAsteroids) {
        gameState.travel.clearedAsteroids = new Set();
      }
      gameState.travel.clearedAsteroids.add(asteroid.id);
      // Set scene to MAP BEFORE ending event to prevent render() from re-triggering arrival event
      gameState.travel.currentSceneId = "MAP";
      endEvent();
      // handleAsteroidLeave also sets currentSceneId = "MAP" and calls render(), but that's fine
      handleAsteroidLeave(asteroid.id);
    };
    
    const eventData = {
      phase: "PROMPT",
      title: "OPEN CHANNEL",
      body: "A wary but open trader emerges from the cabin. They offer limited goods at inflated prices, but they're willing to trade.",
      options: ["TRADE", "LEAVE", ""],
      outcomeText: null,
      image: null,
      optionHandlers: [
        (optionText, index) => {
          // TRADE button - open trader merchant
          debugLog("[TRADER] TRADE button clicked, asteroidId:", asteroid.id);
          endEvent();
          openTraderMerchant(asteroid.id);
        },
        () => {
          // LEAVE button - exit and return to map
          endEvent();
          markClearedAndContinue();
        },
        null
      ]
    };
    
    startEvent(eventData);
    debugLog("[DEBUG] Friendly trader event started. Click 'TRADE' to test merchant.");
  };
}

// ---------------------------
// DOM refs (match index.html)
// ---------------------------

const el = {
  // Header
  uiLocation: /** @type {HTMLElement|null} */ (document.getElementById("ui-location")),
  uiSpeed: /** @type {HTMLElement|null} */ (document.getElementById("ui-speed")),
  uiType: /** @type {HTMLElement|null} */ (document.getElementById("ui-type")),
  uiResources: /** @type {HTMLElement|null} */ (document.getElementById("ui-resources")),
  uiInhabited: /** @type {HTMLElement|null} */ (document.getElementById("ui-inhabited")),
  uiLandingRisk: /** @type {HTMLElement|null} */ (document.getElementById("ui-landing-risk")),
  uiLandingRiskRow: /** @type {HTMLElement|null} */ (document.getElementById("ui-landing-risk-row")),
  uiDockingRisk: /** @type {HTMLElement|null} */ (document.getElementById("ui-docking-risk")),
  uiDockingRiskRow: /** @type {HTMLElement|null} */ (document.getElementById("ui-docking-risk-row")),
  uiDay: /** @type {HTMLElement|null} */ (document.getElementById("ui-day")),
  uiDeadline: /** @type {HTMLElement|null} */ (document.getElementById("ui-deadline")),
  uiCredits: /** @type {HTMLElement|null} */ (document.getElementById("ui-credits")),

  // Nav
  navButtons: /** @type {NodeListOf<HTMLButtonElement>} */ (
    document.querySelectorAll("#hub-nav .nav-btn[data-tab]")
  ),

  // Stats
  lifePct: /** @type {HTMLElement|null} */ (document.getElementById("stat-life-support-pct")),
  hullPct: /** @type {HTMLElement|null} */ (document.getElementById("stat-hull-pct")),
  lifeBar: /** @type {HTMLElement|null} */ (document.getElementById("stat-life-support-bar")),
  hullBar: /** @type {HTMLElement|null} */ (document.getElementById("stat-hull-bar")),

  // Actions
  actionTravel: /** @type {HTMLButtonElement|null} */ (document.getElementById("action-travel")),
  actionWait: /** @type {HTMLButtonElement|null} */ (document.getElementById("action-wait")),
  actionScan: /** @type {HTMLButtonElement|null} */ (document.getElementById("action-scan")),

  // Canvas
  canvas: /** @type {HTMLCanvasElement|null} */ (document.getElementById("map-canvas")),
  
  // Scene system
  sceneContainer: /** @type {HTMLElement|null} */ (document.getElementById("scene-container")),
  sceneImage: /** @type {HTMLImageElement|null} */ (document.getElementById("scene-image")),
  sceneHotspots: /** @type {HTMLElement|null} */ (document.getElementById("scene-hotspots")),
  sceneOverlayLayer: /** @type {HTMLElement|null} */ (document.getElementById("scene-overlay-layer")),
  
  // Event overlay
  eventOverlay: /** @type {HTMLElement|null} */ (document.getElementById("event-overlay")),
  
  // Zoom controls
  zoomInBtn: /** @type {HTMLButtonElement|null} */ (document.getElementById("zoom-in-btn")),
  zoomOutBtn: /** @type {HTMLButtonElement|null} */ (document.getElementById("zoom-out-btn")),
  
  // Preview window
  previewFrame: /** @type {HTMLElement|null} */ (document.getElementById("preview-frame")),
  previewPlaceholder: /** @type {HTMLElement|null} */ (document.querySelector(".preview-placeholder")),
  
  // Modal
  modalLayer: /** @type {HTMLElement|null} */ (document.getElementById("modal-layer")),
};

// ---------------------------
// Helpers
// ---------------------------

/** @param {number} n */
function clampPct(n) {
  return Math.max(0, Math.min(100, Math.round(n)));
}

/** Pads number to 3 digits (e.g., 1 -> 001) */
function pad3(n) {
  const s = String(Math.max(0, Math.floor(n)));
  return s.length >= 3 ? s : "0".repeat(3 - s.length) + s;
}

/**
 * Render a segmented 20-block bar.
 * @param {HTMLElement|null} container
 * @param {number} pct
 */
function renderSegmentBar(container, pct) {
  if (!container) return;
  const p = clampPct(pct);
  const total = 20;
  const filled = Math.round((p / 100) * total);
  const low = p <= 25;

  container.innerHTML = "";
  for (let i = 0; i < total; i++) {
    const seg = document.createElement("div");
    seg.className = "seg";

    if (i >= filled) seg.classList.add("is-empty");
    else if (low) seg.classList.add("is-low");

    container.appendChild(seg);
  }
}

/** @param {Tab} tab */
function setTab(tab) {
  // Stop waiting if switching tabs
  if (gameState.travel.isWaiting && gameState.travel.waitIntervalId !== null) {
    clearInterval(gameState.travel.waitIntervalId);
    gameState.travel.waitIntervalId = null;
    gameState.travel.isWaiting = false;
    if (el.actionWait) {
      el.actionWait.textContent = "WAIT";
      el.actionWait.classList.remove("is-active");
    }
  }

  // If we're leaving the TRAVEL tab while a journey is in progress, pause
  // the travel animation so time doesn't advance silently in the background.
  // The animation resumes naturally next time TRAVEL is selected via render()
  // → animation loop logic; we just stop the rAF chain here.
  if (
    tab !== "TRAVEL" &&
    gameState.travel.isTraveling &&
    gameState.travel.travelAnimationId !== null
  ) {
    cancelAnimationFrame(gameState.travel.travelAnimationId);
    gameState.travel.travelAnimationId = null;
  }

  gameState.meta.tab = tab;
  render();
}

/**
 * Advance time by the specified number of days.
 *
 * Single writer for `gameState.stats.day` and life support drain. Forwards
 * to the implementation in js/time.js once it has been wired up; until
 * then it falls back to a minimal in-place implementation so module-init
 * code (dev seeding, etc.) keeps working.
 *
 * @param {number} days
 * @param {number} [lifeSupportMultiplier=1]
 */
function advanceDays(days, lifeSupportMultiplier = 1) {
  if (isRunOver()) return;
  if (typeof _advanceDaysImpl === "function") {
    _advanceDaysImpl(days, lifeSupportMultiplier);
    return;
  }
  const d = Math.max(0, Math.floor(days));
  if (d === 0) return;
  gameState.stats.day += d;
  const drain = (100 / 30) * Math.max(0, Number(lifeSupportMultiplier) || 0) * d;
  gameState.stats.lifeSupport = Math.max(0, gameState.stats.lifeSupport - drain);
}

/** Wired up at boot via createAdvanceDays(...) — see initGame(). */
let _advanceDaysImpl = null;

function isRunOver() {
  return gameState.meta.runStatus === "WON" || gameState.meta.runStatus === "LOST";
}

function stopContinuousActions() {
  if (gameState.travel.waitIntervalId !== null) {
    clearInterval(gameState.travel.waitIntervalId);
    gameState.travel.waitIntervalId = null;
  }
  gameState.travel.isWaiting = false;
  if (gameState.travel.travelAnimationId !== null) {
    cancelAnimationFrame(gameState.travel.travelAnimationId);
    gameState.travel.travelAnimationId = null;
  }
  gameState.travel.isTraveling = false;
  stopAnimationLoop();
}

function buildRunSummary(status, reason) {
  const livingCrew = (gameState.crew.members || []).filter(m => m.status !== "Deceased").length;
  const artifacts = gameState.inventory.artifacts.length;
  const integrity = Math.round(gameState.stats.shipIntegrity ?? gameState.stats.hull ?? 0);
  return `${status === "WON" ? "MISSION COMPLETE" : "MISSION FAILED"} — ${reason}
Day ${gameState.stats.day}/${gameState.stats.deadline}. Ship integrity ${integrity}%. Life support ${Math.round(gameState.stats.lifeSupport)}%. Crew alive ${livingCrew}/${gameState.crew.members.length}. Artifacts aboard ${artifacts}. Credits ${gameState.stats.credits}c.`;
}

function finishRun(status, reason) {
  if (isRunOver()) return;
  gameState.meta.runStatus = status;
  gameState.meta.endReason = reason;
  gameState.meta.endSummary = buildRunSummary(status, reason);
  stopContinuousActions();
  logAdd(status === "WON" ? "VICTORY" : "GAME_OVER", gameState.meta.endSummary, { reason });
  startEvent({
    phase: "OUTCOME",
    title: status === "WON" ? "MARS ORBIT ACHIEVED" : "RUN ENDED",
    outcomeText: gameState.meta.endSummary,
    options: ["", "", ""],
    onContinue: () => {
      // Keep the run ended and leave the summary visible in the log.
      endEvent();
      gameState.meta.tab = "LOG";
      render();
    }
  });
}

function checkEndConditions() {
  if (isRunOver()) return;
  if (gameState.stats.lifeSupport <= 0) {
    finishRun("LOST", "Life support collapsed before Mars.");
    return;
  }
  if ((gameState.stats.shipIntegrity ?? gameState.stats.hull ?? 0) <= 0) {
    finishRun("LOST", "The ship broke apart under accumulated damage.");
    return;
  }
  if (gameState.stats.day > gameState.stats.deadline && gameState.travel.currentLocationId !== "mars") {
    finishRun("LOST", "The Mars window closed before you arrived.");
  }
}

function getLifeSupportDrainMultiplier() {
  const damage = gameState.ship.subsystems?.LIFE_SUPPORT?.damage || 0;
  // A fully damaged life-support subsystem drains 75% faster.
  return 1 + (damage / 100) * 0.75;
}

/**
 * Process daily crew/system degradation.
 * @param {number} days Number of days to process
 */
function processCrewDegradation(days) {
  if (gameState.travel.scannerGlitchDays > 0) {
    gameState.travel.scannerGlitchDays = Math.max(0, gameState.travel.scannerGlitchDays - days);
  }

  // Lightweight recurring travel events: low-frequency pressure that uses
  // existing systems without interrupting the player every few days.
  if (gameState.meta.tab === "TRAVEL" && gameState.travel.currentSceneId === "MAP" && Math.random() < Math.min(0.18, days * 0.025)) {
    const roll = Math.random();
    if (roll < 0.34) {
      const damage = rollInt(2, 6);
      applyShipDamage(damage, "Micrometeor shower");
      logAdd("TRAVEL_EVENT", `Day ${gameState.stats.day}: Micrometeor grit scored the hull (-${damage}% integrity).`, {});
    } else if (roll < 0.67) {
      gameState.travel.scannerGlitchDays = Math.max(gameState.travel.scannerGlitchDays, 1);
      logAdd("TRAVEL_EVENT", `Day ${gameState.stats.day}: Solar interference will make the next scan unreliable.`, {});
    } else if (gameState.crew.members.length > 0) {
      const member = gameState.crew.members[Math.floor(Math.random() * gameState.crew.members.length)];
      if (member.status !== "Deceased" && member.status !== "Resilient") {
        member.status = "Stressed";
        logAdd("CREW", `Day ${gameState.stats.day}: A cabin argument left ${member.name} stressed.`, { crewId: member.id });
      }
    }
  }

  const pressure = Math.max(0, days);
  const lifeCritical = gameState.stats.lifeSupport <= 20;
  const hullCritical = (gameState.stats.shipIntegrity ?? gameState.stats.hull ?? 100) <= 30;
  if (!lifeCritical && !hullCritical) return;

  const vulnerable = (gameState.crew.members || []).filter(m =>
    !["Deceased", "Recovering", "Resilient"].includes(m.status)
  );
  if (vulnerable.length === 0) return;

  const chance = Math.min(0.35, pressure * (lifeCritical ? 0.04 : 0.02) + (hullCritical ? 0.03 : 0));
  if (Math.random() < chance) {
    const member = vulnerable[Math.floor(Math.random() * vulnerable.length)];
    const nextStatus = lifeCritical ? "Exposed" : "Stressed";
    member.status = nextStatus;
    logAdd("CREW", `Day ${gameState.stats.day}: ${member.name} became ${nextStatus.toLowerCase()} under shipboard pressure.`, {
      crewId: member.id
    });
  }
}

/**
 * Calculate travel time using interception fixed-point solver
 * Iterates to find when ship can intercept moving target
 * @param {string} fromId Starting location ID
 * @param {string} toId Destination location ID
 * @returns {number} Total days to travel, or 0 if route not found
 */
function calculateTravelTimeOrbital(fromId, toId) {
  const fromNode = mapNodes.find(n => n.id === fromId);
  const toNode = mapNodes.find(n => n.id === toId);
  
  if (!fromNode || !toNode) return 0;
  
  const startDay = gameState.stats.day;
  const fromPeriod = fromNode.orbitalPeriod || getBaseOrbitalPeriod(fromNode.type);
  const toPeriod = toNode.orbitalPeriod || getBaseOrbitalPeriod(toNode.type);
  
  // Fixed-point solver: iterate t = ceil(distance(startPos(day0), targetPos(day0+t))/SHIP_SPEED)
  // Start with initial guess based on current distance for faster convergence
  const currentFromPos = getNodePosition(fromNode, startDay);
  const currentToPos = getNodePosition(toNode, startDay);
  
  const dx = currentToPos.x - currentFromPos.x;
  const dy = currentToPos.y - currentFromPos.y;
  const initialDistance = Math.sqrt(dx * dx + dy * dy);
  
  // Strategy: Systematically search for the MINIMUM travel time
  // ALWAYS do a full search - no fast paths that can miss optimal solutions
  // This ensures consistent results regardless of starting position
  const maxIterations = 20; // Reduced iterations per sample for performance
  const maxDays = 100; // Maximum reasonable travel time (stations should be closer)
  const effectiveShipSpeed = SHIP_SPEED * getShipSpeedMultiplier();
  
  let bestTime = Infinity;
  let bestDistance = Infinity;
  
  // Search range: up to 1.5x the longer orbital period, but cap at reasonable max
  const searchRange = Math.min(maxDays, Math.max(toPeriod, fromPeriod) * 1.5);
  const stepSize = 2; // Check every 2 days for comprehensive coverage
  
  // Search through ALL possible travel times to find the absolute minimum
  for (let sampleTime = 1; sampleTime <= searchRange; sampleTime += stepSize) {
    // For each sample time, do a quick fixed-point iteration to find convergence
    let t = sampleTime;
    
    for (let iteration = 0; iteration < maxIterations; iteration++) {
      const fromPos = getNodePosition(fromNode, startDay);
      const arrivalDay = startDay + t;
      const toPos = getNodePosition(toNode, arrivalDay);
      const dx = toPos.x - fromPos.x;
      const dy = toPos.y - fromPos.y;
      const distance = Math.sqrt(dx * dx + dy * dy);
      const requiredTime = Math.ceil(distance / effectiveShipSpeed);
      
      // If converged (within 1 day), check if this is the best solution
      if (Math.abs(requiredTime - t) <= 1) {
        if (requiredTime <= maxDays && distance < bestDistance) {
          bestTime = requiredTime;
          bestDistance = distance;
        }
        break;
      }
      
      // Update t for next iteration
      t = requiredTime;
      if (t > maxDays || t < 1) break;
    }
  }
  
  // If we found a valid solution, return it
  if (bestTime !== Infinity && bestTime <= maxDays) {
    return Math.max(1, bestTime);
  }
  
  // Fallback: use current distance calculation (should rarely happen)
  const fallbackTime = Math.ceil(initialDistance / effectiveShipSpeed);
  return Math.max(1, Math.min(fallbackTime, maxDays));
}

/**
 * Calculate travel time from one location to another
 * Uses unified interception solver for ALL destinations (route nodes, stations, outposts, asteroids, ships)
 * Travel time is based solely on ship speed and spatial distance, not route segments or the 400-day deadline
 * @param {string} fromId Starting location ID
 * @param {string} toId Destination location ID
 * @returns {number} Total days to travel, or 0 if invalid
 */
function calculateTravelTime(fromId, toId) {
  if (fromId === toId) return 0;
  
  // All destinations use the same orbital interception solver
  // This includes: route nodes, stations, outposts, asteroids, ships
  return calculateTravelTimeOrbital(fromId, toId);
}

// ---------------------------
// Canvas (interactive map)
// ---------------------------

/**
 * Get canvas coordinates from mouse event
 * @param {MouseEvent} e
 * @returns {{x: number, y: number}|null}
 */
function getCanvasCoords(e) {
  if (!el.canvas) return null;
  const rect = el.canvas.getBoundingClientRect();
  const dpr = window.devicePixelRatio || 1;
  return {
    x: (e.clientX - rect.left) * dpr,
    y: (e.clientY - rect.top) * dpr,
  };
}

/**
 * Convert ring + angle to canvas coordinates
 * @param {number} ring Ring number (0 = center, higher = outer)
 * @param {number} angle Angle in radians
 * @param {number} minSize Minimum canvas dimension
 * @returns {{x: number, y: number}}
 */
function ringToCoords(ring, angle, minSize) {
  // Scale rings to fit nicely - 5 rings total (0-5), so divide by 5
  const radius = (ring / 5) * minSize * 0.4;
  return {
    x: Math.cos(angle) * radius,
    y: Math.sin(angle) * radius
  };
}

/**
 * Get current ring position for a node (handles ship radial movement and moon orbiting earth)
 * @param {Node} node
 * @param {number} day Optional day to calculate position at (defaults to current day)
 * @returns {number}
 */
function getNodeCurrentRingGlobal(node, day = null) {
  const currentDay = day !== null ? day : gameState.stats.day;
  if (node.type === "ship" && node.initialRing !== undefined && node.radialVelocity !== undefined) {
    const currentRing = node.initialRing + (node.radialVelocity * currentDay);
    return Math.max(0.5, Math.min(6, currentRing));
  }
  // Moon orbits around Earth, so its ring is Earth's ring
  if (node.type === "moon" && node.orbitsAround) {
    const parentNode = mapNodes.find(n => n.id === node.orbitsAround);
    if (parentNode) {
      return getNodeCurrentRingGlobal(parentNode, day);
    }
  }
  return node.ring;
}

/**
 * Get node's position (ring and angle) accounting for moon orbiting earth
 * @param {Node} node
 * @param {number} day Day to calculate position at
 * @returns {{ring: number, angle: number, x: number, y: number}} Position in world coordinates
 */
function getNodePosition(node, day) {
  const ring = getNodeCurrentRingGlobal(node, day);
  const period = node.orbitalPeriod || getBaseOrbitalPeriod(node.type);
  let angle = calculateOrbitalAngle(day, period, node.angle);
  
  // If moon, calculate position relative to Earth
  if (node.type === "moon" && node.orbitsAround && node.orbitalRadius !== undefined) {
    const parentNode = mapNodes.find(n => n.id === node.orbitsAround);
    if (parentNode) {
      const parentRing = getNodeCurrentRingGlobal(parentNode, day);
      const parentPeriod = parentNode.orbitalPeriod || getBaseOrbitalPeriod(parentNode.type);
      const parentAngle = calculateOrbitalAngle(day, parentPeriod, parentNode.angle);
      
      // Moon's angle around Earth
      const moonPeriod = node.orbitalPeriod || 28;
      const moonAngleAroundEarth = calculateOrbitalAngle(day, moonPeriod, node.initialAngle || 0);
      
      // Calculate moon's position relative to Earth
      // Earth's position in world coords
      const earthX = Math.cos(parentAngle) * parentRing;
      const earthY = Math.sin(parentAngle) * parentRing;
      
      // Moon's offset from Earth
      const moonOffsetX = Math.cos(moonAngleAroundEarth) * node.orbitalRadius;
      const moonOffsetY = Math.sin(moonAngleAroundEarth) * node.orbitalRadius;
      
      // Moon's absolute position
      const moonX = earthX + moonOffsetX;
      const moonY = earthY + moonOffsetY;
      
      // Convert back to ring and angle
      const moonDistance = Math.sqrt(moonX * moonX + moonY * moonY);
      const moonAngle = Math.atan2(moonY, moonX);
      
      return {
        ring: moonDistance,
        angle: moonAngle,
        x: moonX,
        y: moonY
      };
    }
  }
  
  // For other nodes, use standard calculation
  return {
    ring: ring,
    angle: angle,
    x: Math.cos(angle) * ring,
    y: Math.sin(angle) * ring
  };
}

/**
 * Find node at canvas coordinates (accounting for zoom/pan)
 * @param {number} screenX Screen X coordinate (in canvas pixels)
 * @param {number} screenY Screen Y coordinate (in canvas pixels)
 * @returns {Node|null}
 */
function getNodeAt(screenX, screenY) {
  if (!el.canvas) return null;
  
  // Ensure revealed nodes are initialized
  initializeRevealedNodes();
  
  const dpr = window.devicePixelRatio || 1;
  const w = el.canvas.width;
  const h = el.canvas.height;
  const cx = w * 0.5;
  const cy = h * 0.5;
  const minSize = Math.min(w, h);
  const zoomLevel = gameState.travel.mapZoomLevel;
  const panX = gameState.travel.mapPanX;
  const panY = gameState.travel.mapPanY;
  
  // Use continuous zoom if active (from pinch), otherwise use discrete levels
  let zoom;
  if (gameState.travel.useContinuousZoom) {
    zoom = gameState.travel.mapZoomContinuous;
  } else {
    // Zoom scale factors for each level (1-7) - Level 1 starts at previous level 3
    const zoomScales = ZOOM_SCALES;
    const baseZoom = zoomScales[zoomLevel] || 1.2;
    zoom = baseZoom * gameState.travel.mapZoomFine; // Apply fine-tuning
  }
  
  // Convert screen coords to world coords
  // The transform is: translate(cx,cy) -> scale(zoom) -> translate(panX*minSize, panY*minSize)
  // So: screen = cx + (world + pan*minSize) * zoom
  // Reverse: world = (screen - cx) / zoom - pan*minSize
  const worldX = (screenX - cx) / zoom - panX * minSize;
  const worldY = (screenY - cy) / zoom - panY * minSize;
  
  // Clickable radius in world space (convert from screen pixels)
  const nodeRadius = (20 * dpr) / zoom; // Increased from 12 to 20 for easier clicking

  // Helper to normalize node IDs (handle multiple instances like "station-01-a" -> "station-01")
  function normalizeNodeIdForRoute(nodeId) {
    if (!nodeId) return null;
    const routeOrder = ["earth", "outpost-0", "station-01", "outpost-1", "station-02", "outpost-2", "station-03", "mars"];
    // If it's already a base route location, return it
    if (routeOrder.includes(nodeId)) return nodeId;
    // Check if it's an instance (e.g., "station-01-a" -> "station-01")
    for (const baseId of routeOrder) {
      if (nodeId.startsWith(baseId + "-")) {
        return baseId;
      }
    }
    return nodeId;
  }

  // Ensure revealedNodes exists and is initialized
  if (!gameState.travel.revealedNodes) {
    gameState.travel.revealedNodes = new Set();
  }
  initializeRevealedNodes();

  // For clickability: only include nodes that are actually clickable
  // Asteroids and outposts are only clickable if scanned
  // Ships are only clickable if scanned
  // All other nodes are clickable
  const clickableNodes = mapNodes.filter(n => {
    // Always hide sun
    if (n.id === "sun") return false;
    
    // Always show earth, moon, and mars (clickable)
    if (n.id === "earth" || n.id === "moon" || n.id === "mars") return true;
    
    // Ships need to be scanned to be clickable
    if (n.type === "ship") {
      return gameState.travel.scannedNodes && gameState.travel.scannedNodes.has(n.id);
    }
    
    // Asteroids need to be scanned to be clickable unless they're an active rumor target
    if (n.type === "asteroid") {
      return (gameState.travel.scannedNodes && gameState.travel.scannedNodes.has(n.id)) ||
        (gameState.travel.hintTargetAsteroidId === n.id) ||
        (gameState.travel.activeRumorAsteroidIds && gameState.travel.activeRumorAsteroidIds.has(n.id));
    }
    
    // Outposts need to be discovered to be clickable
    if (n.type === "outpost") {
      return gameState.travel.discoveredNodes && gameState.travel.discoveredNodes.has(n.id);
    }
    
    // Stations: clickable if broadcast or discovered
    if (n.type === "station") {
      if (gameState.travel.broadcastStationInstanceId && n.id === gameState.travel.broadcastStationInstanceId) {
        return true;
      }
      return gameState.travel.discoveredNodes && gameState.travel.discoveredNodes.has(n.id);
    }
    
    // Default: clickable
    return true;
  });

  // Show all nodes regardless of zoom level (only filter out sun)
  // Asteroids are always visible (darker grey if not scanned)
  // Outposts are only visible when discovered/scanned
  // Ships are only visible when scanned
  // Earth, moon, and mars are ALWAYS visible
  const visibleNodes = mapNodes.filter(n => {
    // Always hide sun
    if (n.id === "sun") return false;
    
    // Always show earth, moon, and mars
    if (n.id === "earth" || n.id === "moon" || n.id === "mars") {
      return true;
    }
    
    // Ships need to be scanned to be visible
    if (n.type === "ship") {
      return gameState.travel.scannedNodes && gameState.travel.scannedNodes.has(n.id);
    }
    
    // Asteroids are always visible (darker grey if not scanned, lighter if scanned)
    if (n.type === "asteroid") {
      return true; // Always return true - asteroids should always be visible
    }
    
    // Outposts are only visible when discovered/scanned
    if (n.type === "outpost") {
      return gameState.travel.discoveredNodes && gameState.travel.discoveredNodes.has(n.id);
    }
    
    // Stations: visible if broadcast (guidance) OR discovered (scan)
    if (n.type === "station") {
      // Broadcast station (guidance) - always visible
      if (gameState.travel.broadcastStationInstanceId && n.id === gameState.travel.broadcastStationInstanceId) {
        return true;
      }
      // Discovered stations (found via scan) - also visible
      if (gameState.travel.discoveredNodes && gameState.travel.discoveredNodes.has(n.id)) {
        return true;
      }
      // All other station instances are hidden
      return false;
    }
    
    // Default: show everything else
    return true;
  });
  
  // Helper to get current ring position for a node
  function getNodeCurrentRing(node) {
    if (node.type === "ship" && node.initialRing !== undefined && node.radialVelocity !== undefined) {
      const currentRing = node.initialRing + (node.radialVelocity * gameState.stats.day);
      return Math.max(0.5, Math.min(6, currentRing));
    }
    // Moon orbits around Earth, so its ring is Earth's ring
    if (node.type === "moon" && node.orbitsAround) {
      const parentNode = mapNodes.find(n => n.id === node.orbitsAround);
      if (parentNode) {
        return getNodeCurrentRing(parentNode); // Use parent's ring
      }
    }
    return node.ring;
  }

  // Helper to get orbital angle for a node
  function getNodeOrbitalAngle(node) {
    if (node.id === "sun") return 0;
    
    // Moon orbits around Earth
    if (node.type === "moon" && node.orbitsAround && node.orbitalRadius !== undefined) {
      const parentNode = mapNodes.find(n => n.id === node.orbitsAround);
      if (parentNode) {
        // Get parent's (Earth's) position
        const parentOrbitalPeriod = parentNode.orbitalPeriod || getBaseOrbitalPeriod(parentNode.type);
        const parentAngle = calculateOrbitalAngle(gameState.stats.day, parentOrbitalPeriod, parentNode.angle);
        
        // Calculate moon's angle around Earth
        const moonOrbitalPeriod = node.orbitalPeriod || 28; // 28 days
        const moonAngleAroundEarth = calculateOrbitalAngle(gameState.stats.day, moonOrbitalPeriod, node.initialAngle || 0);
        
        // Store moon-specific data for position calculation
        node._moonParentAngle = parentAngle;
        node._moonAngleAroundEarth = moonAngleAroundEarth;
        node._moonOrbitalRadius = node.orbitalRadius;
        
        return parentAngle; // Return parent's angle, actual position calculated below
      }
    }
    
    // Use node's individual orbital period (randomized per playthrough)
    const orbitalPeriod = node.orbitalPeriod || getBaseOrbitalPeriod(node.type);
    return calculateOrbitalAngle(gameState.stats.day, orbitalPeriod, node.angle);
  }

  for (const node of clickableNodes) {
    const orbitalAngle = getNodeOrbitalAngle(node);
    const currentRing = getNodeCurrentRing(node);
    
    // Special handling for moon orbiting Earth
    let coords;
    if (node.type === "moon" && node.orbitsAround && node._moonParentAngle !== undefined) {
      // Calculate moon's position relative to Earth
      const parentNode = mapNodes.find(n => n.id === node.orbitsAround);
      if (parentNode) {
        const parentRing = getNodeCurrentRing(parentNode);
        const parentCoords = ringToCoords(parentRing, node._moonParentAngle, minSize);
        
        // Moon's offset from Earth
        const moonOffsetRadius = (node._moonOrbitalRadius / 5) * minSize * 0.4; // Convert orbital radius to screen units
        const moonOffsetX = Math.cos(node._moonAngleAroundEarth) * moonOffsetRadius;
        const moonOffsetY = Math.sin(node._moonAngleAroundEarth) * moonOffsetRadius;
        
        coords = {
          x: parentCoords.x + moonOffsetX,
          y: parentCoords.y + moonOffsetY
        };
      } else {
        coords = ringToCoords(currentRing, orbitalAngle, minSize);
      }
    } else {
      coords = ringToCoords(currentRing, orbitalAngle, minSize);
    }
    
    const dx = worldX - coords.x;
    const dy = worldY - coords.y;
    const dist = Math.sqrt(dx * dx + dy * dy);
    if (dist <= nodeRadius) {
      return node;
    }
  }
  return null;
}

/**
 * Convert screen coordinates to world coordinates (ring and angle)
 * @param {number} screenX Screen X coordinate (in canvas pixels)
 * @param {number} screenY Screen Y coordinate (in canvas pixels)
 * @returns {{ring: number, angle: number}|null}
 */
function screenToWorldCoords(screenX, screenY) {
  if (!el.canvas) return null;
  
  const dpr = window.devicePixelRatio || 1;
  const w = el.canvas.width;
  const h = el.canvas.height;
  const cx = w * 0.5;
  const cy = h * 0.5;
  const minSize = Math.min(w, h);
  const zoomLevel = gameState.travel.mapZoomLevel;
  const panX = gameState.travel.mapPanX;
  const panY = gameState.travel.mapPanY;
  
  // Use continuous zoom if active (from pinch), otherwise use discrete levels
  let zoom;
  if (gameState.travel.useContinuousZoom) {
    zoom = gameState.travel.mapZoomContinuous;
  } else {
    const zoomScales = ZOOM_SCALES;
    const baseZoom = zoomScales[zoomLevel] || 1.2;
    zoom = baseZoom * gameState.travel.mapZoomFine;
  }
  
  // Convert screen coords to world coords
  const worldX = (screenX - cx) / zoom - panX * minSize;
  const worldY = (screenY - cy) / zoom - panY * minSize;
  
  // Convert world coordinates to ring and angle
  const ring = Math.sqrt(worldX * worldX + worldY * worldY) / (minSize * 0.4) * 5; // Reverse of ringToCoords
  const angle = Math.atan2(worldY, worldX);
  
  return { ring, angle };
}

function drawMap() {
  if (!el.canvas) {
    console.warn("drawMap: canvas element not found");
    return;
  }
  
  // Only draw map if we're actually on the MAP view
  // This prevents conflicts when in ARRIVAL or other scenes
  if (gameState.travel.currentSceneId !== "MAP" || gameState.meta.tab !== "TRAVEL") {
    return;
  }
  
  // Ensure canvas is visible first (in case it was just made visible)
  if (el.canvas.hidden || el.canvas.style.display === "none") {
    el.canvas.hidden = false;
    el.canvas.removeAttribute("hidden");
    el.canvas.style.display = "block";
    el.canvas.style.visibility = "visible";
  }
  
  // After making canvas visible, check if it has valid dimensions
  // Give it a moment to update by checking both offset and getBoundingClientRect
  const hasValidDimensions = (el.canvas.offsetWidth > 0 && el.canvas.offsetHeight > 0) ||
                             (el.canvas.getBoundingClientRect().width > 0 && el.canvas.getBoundingClientRect().height > 0);
  
  if (!hasValidDimensions) {
    // Canvas doesn't have valid dimensions yet, skip this frame
    // The next frame should have valid dimensions
    return;
  }
  
  // Ensure revealed nodes are initialized
  initializeRevealedNodes();
  
  const ctx = el.canvas.getContext("2d");
  if (!ctx) {
    console.warn("drawMap: could not get 2d context");
    return;
  }

  // Fit to element size (CSS scales it; keep drawing in backing pixels)
  // Get the actual displayed size of the canvas element
  const dpr = window.devicePixelRatio || 1;
  let w, h;
  
  // Try getBoundingClientRect first (most accurate when visible)
  const rect = el.canvas.getBoundingClientRect();
  if (rect.width > 0 && rect.height > 0) {
    w = Math.max(1, Math.floor(rect.width * dpr));
    h = Math.max(1, Math.floor(rect.height * dpr));
  } else {
    // Fallback: use offsetWidth/offsetHeight (works even when hidden)
    const offsetW = el.canvas.offsetWidth || el.canvas.clientWidth;
    const offsetH = el.canvas.offsetHeight || el.canvas.clientHeight;
    if (offsetW > 0 && offsetH > 0) {
      w = Math.max(1, Math.floor(offsetW * dpr));
      h = Math.max(1, Math.floor(offsetH * dpr));
    } else {
      // Last resort: use parent container dimensions
      const parent = el.canvas.parentElement;
      if (parent) {
        const parentRect = parent.getBoundingClientRect();
        w = Math.max(1, Math.floor(parentRect.width * dpr));
        h = Math.max(1, Math.floor(parentRect.height * dpr));
      } else {
        // Absolute fallback: use default dimensions
        w = 1200 * dpr;
        h = 800 * dpr;
      }
    }
  }
  
  // Always update canvas dimensions to match container size
  // This ensures the canvas resizes properly when the window is resized
  if (el.canvas.width !== w || el.canvas.height !== h) {
    el.canvas.width = w;
    el.canvas.height = h;
  }
  
  // If dimensions are still invalid, skip drawing
  if (w <= 1 || h <= 1) {
    console.warn("drawMap: canvas dimensions invalid", { w, h, rect: el.canvas.getBoundingClientRect() });
    return;
  }

  ctx.clearRect(0, 0, w, h);

  // Background
  ctx.fillStyle = "#0b0b0b";
  ctx.fillRect(0, 0, w, h);

  // Set up transform for zoom and pan
  const cx = w * 0.5;
  const cy = h * 0.5;
  const minSize = Math.min(w, h);
  const zoomLevel = gameState.travel.mapZoomLevel;
  const panX = gameState.travel.mapPanX;
  const panY = gameState.travel.mapPanY;

  // Use continuous zoom if active (from pinch), otherwise use discrete levels
  let zoom;
  if (gameState.travel.useContinuousZoom) {
    zoom = gameState.travel.mapZoomContinuous;
  } else {
    // Zoom scale factors for each level (1-7) - Level 1 starts at previous level 3
    const zoomScales = ZOOM_SCALES;
    const baseZoom = zoomScales[zoomLevel] || 1.2;
    zoom = baseZoom * gameState.travel.mapZoomFine; // Apply fine-tuning
  }

  // Define routeOrder at the top to avoid temporal dead zone issues
  const routeOrder = ["earth", "outpost-0", "station-01", "outpost-1", "station-02", "outpost-2", "station-03", "mars"];

  // Save context and apply transform
  ctx.save();
  ctx.translate(cx, cy);
  ctx.scale(zoom, zoom);
  ctx.translate(panX * minSize, panY * minSize);

  // Draw sun at center (yellow circle) - always visible
  ctx.fillStyle = "#ffd700"; // Gold/yellow for sun
  ctx.beginPath();
  ctx.arc(0, 0, (minSize * 0.4) / 15 * 0.25, 0, Math.PI * 2); // 25% of original size
  ctx.fill();

  // Helper to normalize node IDs (handle multiple instances like "station-01-a" -> "station-01")
  function normalizeNodeIdForRoute(nodeId) {
    if (!nodeId) return null;
    // If it's already a base route location, return it
    if (routeOrder.includes(nodeId)) return nodeId;
    // Check if it's an instance (e.g., "station-01-a" -> "station-01")
    for (const baseId of routeOrder) {
      if (nodeId.startsWith(baseId + "-")) {
        return baseId;
      }
    }
    return nodeId;
  }

  // Ensure revealedNodes exists and is initialized
  if (!gameState.travel.revealedNodes) {
    gameState.travel.revealedNodes = new Set();
  }
  initializeRevealedNodes();

  // Show all nodes regardless of zoom level (only filter out sun)
  // Asteroids are always visible (darker grey if not scanned)
  // Outposts are only visible when discovered/scanned
  // Ships are only visible when scanned
  // Earth, moon, and mars are ALWAYS visible
  const visibleNodes = mapNodes.filter(n => {
    // Always hide sun
    if (n.id === "sun") return false;
    
    // Always show earth, moon, and mars
    if (n.id === "earth" || n.id === "moon" || n.id === "mars") {
      return true;
    }
    
    // Ships need to be scanned to be visible
    if (n.type === "ship") {
      return gameState.travel.scannedNodes && gameState.travel.scannedNodes.has(n.id);
    }
    
    // Asteroids are always visible (darker grey if not scanned, lighter if scanned)
    if (n.type === "asteroid") {
      return true; // Always return true - asteroids should always be visible
    }
    
    // Outposts are only visible when discovered/scanned
    if (n.type === "outpost") {
      return gameState.travel.discoveredNodes && gameState.travel.discoveredNodes.has(n.id);
    }
    
    // Stations: visible if broadcast (guidance) OR discovered (scan)
    if (n.type === "station") {
      // Broadcast station (guidance) - always visible
      if (gameState.travel.broadcastStationInstanceId && n.id === gameState.travel.broadcastStationInstanceId) {
        return true;
      }
      // Discovered stations (found via scan) - also visible
      if (gameState.travel.discoveredNodes && gameState.travel.discoveredNodes.has(n.id)) {
        return true;
      }
      // All other station instances are hidden
      return false;
    }
    
    // Default: show everything else
    return true;
  });
  const currentLocation = visibleNodes.find(n => n.id === gameState.travel.currentLocationId);

  // Draw scan pulse animation (sonar effect)
  if (gameState.travel.scanPulse.isActive && gameState.travel.scanPulse.startTime !== null) {
    const now = perfNow();
    const elapsed = now - gameState.travel.scanPulse.startTime;
    const progress = Math.min(1, elapsed / gameState.travel.scanPulse.duration);
    
    if (progress < 1) {
      // Pulse is still animating
      const currentRadius = progress * gameState.travel.scanPulse.maxRadius;
      const opacity = 1 - progress; // Fade from 100% to 0% as it expands
      
      // Get scan center coordinates
      const centerCoords = ringToCoords(
        gameState.travel.scanPulse.centerRing,
        gameState.travel.scanPulse.centerAngle,
        minSize
      );
      
      // Draw pulse ring
      ctx.strokeStyle = `rgba(10, 168, 22, ${opacity})`; // Ship green (#0AA816) for scan
      ctx.lineWidth = (3 * dpr) / zoom;
      ctx.setLineDash([]);
      
      // Convert ring distance to screen radius
      // The scan radius is a distance in ring units (not a ring position)
      // We need to convert this distance to screen pixels
      // Since ring positions are at (ring / 5) * minSize * 0.4 from center,
      // a distance of 1.0 ring units corresponds to (1.0 / 5) * minSize * 0.4 in screen space
      const screenRadius = (currentRadius / 5) * minSize * 0.4;
      
      ctx.beginPath();
      ctx.arc(centerCoords.x, centerCoords.y, screenRadius, 0, Math.PI * 2);
      ctx.stroke();
      
      // Also reveal objects as the pulse reaches them (asteroids, ships, stations, and outposts)
      const scannableNodes = mapNodes.filter(n => n.type === "asteroid" || n.type === "ship" || n.type === "station" || n.type === "outpost");
      scannableNodes.forEach(node => {
        // Get node's current position
        const nodeRing = getNodeCurrentRingGlobal(node);
        const nodePeriod = node.orbitalPeriod || getBaseOrbitalPeriod(node.type);
        const nodeAngle = calculateOrbitalAngle(gameState.stats.day, nodePeriod, node.angle);
        
        // Calculate 2D distance from scan center
        let angleDiff = Math.abs(nodeAngle - gameState.travel.scanPulse.centerAngle);
        if (angleDiff > Math.PI) angleDiff = 2 * Math.PI - angleDiff;
        
        const distance = Math.sqrt(
          gameState.travel.scanPulse.centerRing * gameState.travel.scanPulse.centerRing + 
          nodeRing * nodeRing - 
          2 * gameState.travel.scanPulse.centerRing * nodeRing * Math.cos(angleDiff)
        );
        
        // If pulse has reached this object
        if (distance <= currentRadius) {
          // Basic scan: mark as scanned/discovered
          if (!gameState.travel.scanPulse.isDeepScan) {
            if (node.type === "asteroid" || node.type === "ship") {
              if (!gameState.travel.scannedNodes) {
                gameState.travel.scannedNodes = new Set();
              }
              gameState.travel.scannedNodes.add(node.id);
              debugLog("[SCAN] Added", node.type, node.id, "to scannedNodes");
            }
            // Stations and outposts are discovered (not scanned like asteroids/ships)
            if (node.type === "station" || node.type === "outpost") {
              if (!gameState.travel.discoveredNodes) {
                gameState.travel.discoveredNodes = new Set();
              }
              gameState.travel.discoveredNodes.add(node.id);
            }
          } else {
            // Deep scan: only deep scan nodes that are already basic scanned/discovered
            // Asteroids and ships must be in scannedNodes
            // Stations and outposts must be in discoveredNodes
            const isBasicScanned = (node.type === "asteroid" || node.type === "ship")
              ? (gameState.travel.scannedNodes && gameState.travel.scannedNodes.has(node.id))
              : (node.type === "station" || node.type === "outpost")
                ? (gameState.travel.discoveredNodes && gameState.travel.discoveredNodes.has(node.id))
                : false;
            
            if (isBasicScanned) {
              // Mark as deep scanned (but don't generate data yet - wait for final pass)
              // This prevents multiple generations during animation
              if (!gameState.travel.deepScannedNodes) {
                gameState.travel.deepScannedNodes = new Set();
              }
              gameState.travel.deepScannedNodes.add(node.id);
              debugLog("[DEEP SCAN] Marked", node.id, "for deep scan (will process in final pass)");
              // Stations and outposts can also be deep scanned (though they don't have deep scan data yet)
              // They're already in discoveredNodes from basic scan
            } else {
              debugLog("[DEEP SCAN] Skipped", node.id, "type:", node.type, "isBasicScanned:", isBasicScanned, "scannedNodes:", gameState.travel.scannedNodes ? Array.from(gameState.travel.scannedNodes) : "null");
            }
          }
        }
      });
    } else {
      // Animation complete - finalize scan
      // Save scan pulse values before clearing them
      const wasDeepScan = gameState.travel.scanPulse.isDeepScan;
      const scanCenterRing = gameState.travel.scanPulse.centerRing;
      const scanCenterAngle = gameState.travel.scanPulse.centerAngle;
      const scanMaxRadius = gameState.travel.scanPulse.maxRadius;
      
      // Clear scan pulse state
      gameState.travel.scanPulse.isActive = false;
      gameState.travel.scanPulse.startTime = null;
      gameState.travel.scanPulse.centerRing = null;
      gameState.travel.scanPulse.centerAngle = null;
      gameState.travel.scanPulse.isDeepScan = false;
      
      // After deep scan completes, reset scan mode back to basic scan
      if (wasDeepScan) {
        gameState.travel.scanMode = "scan";
        // Update button text directly
        if (el.actionScan) {
          el.actionScan.textContent = "SCAN";
        }
      }
      
      // Re-render once after scan completes to update UI with any new scan data.
      // Use the scheduler so the canvas draw path doesn't trigger a synchronous DOM pass.
      scheduleRender();
      
      // Final pass to ensure all objects within max radius are scanned/discovered
      // Include asteroids, ships, stations, and outposts
      // Use saved values since we cleared the scan pulse state
      if (scanCenterRing !== null && scanCenterAngle !== null) {
        const scannableNodes = mapNodes.filter(n => n.type === "asteroid" || n.type === "ship" || n.type === "station" || n.type === "outpost");
        scannableNodes.forEach(node => {
          const nodeRing = getNodeCurrentRingGlobal(node);
          const nodePeriod = node.orbitalPeriod || getBaseOrbitalPeriod(node.type);
          const nodeAngle = calculateOrbitalAngle(gameState.stats.day, nodePeriod, node.angle);
          
          let angleDiff = Math.abs(nodeAngle - scanCenterAngle);
          if (angleDiff > Math.PI) angleDiff = 2 * Math.PI - angleDiff;
          
          const distance = Math.sqrt(
            scanCenterRing * scanCenterRing + 
            nodeRing * nodeRing - 
            2 * scanCenterRing * nodeRing * Math.cos(angleDiff)
          );
          
          if (distance <= scanMaxRadius) {
            // Basic scan: mark as scanned/discovered
            if (!wasDeepScan) {
              if (node.type === "asteroid" || node.type === "ship") {
                gameState.travel.scannedNodes.add(node.id);
              }
              // Stations and outposts are discovered (not scanned like asteroids/ships)
              if (node.type === "station" || node.type === "outpost") {
                if (!gameState.travel.discoveredNodes) {
                  gameState.travel.discoveredNodes = new Set();
                }
                gameState.travel.discoveredNodes.add(node.id);
              }
            } else {
              // Deep scan: only deep scan nodes that are already basic scanned/discovered
              // Asteroids and ships must be in scannedNodes
              // Stations and outposts must be in discoveredNodes
              const isBasicScanned = (node.type === "asteroid" || node.type === "ship")
                ? (gameState.travel.scannedNodes && gameState.travel.scannedNodes.has(node.id))
                : (node.type === "station" || node.type === "outpost")
                  ? (gameState.travel.discoveredNodes && gameState.travel.discoveredNodes.has(node.id))
                  : false;
              
              if (isBasicScanned) {
                // Ensure it's marked as deep scanned
                if (!gameState.travel.deepScannedNodes) {
                  gameState.travel.deepScannedNodes = new Set();
                }
                gameState.travel.deepScannedNodes.add(node.id);
                debugLog("[DEEP SCAN] Final pass: Processing", node.id);
                // Generate deep scan data based on node type
                if (node.type === "asteroid") {
                  generateAsteroidDeepScanData(node);
                } else if (node.type === "ship") {
                  generateShipDeepScanData(node);
                }
                // Stations and outposts can also be deep scanned (though they don't have deep scan data yet)
                // They're already in discoveredNodes from basic scan
              } else {
                debugLog("[DEEP SCAN] Final pass: Skipped", node.id, "type:", node.type, "isBasicScanned:", isBasicScanned, "scannedNodes:", gameState.travel.scannedNodes ? Array.from(gameState.travel.scannedNodes) : "null");
              }
            }
          }
        });
        
        // After deep scan completes, call render() to update the header with new deep scan data
        if (wasDeepScan) {
          render();
        }
      }
    }
  }

  // Draw orbital rings for main locations (moon, mars, stations) - always visible
  ctx.strokeStyle = "rgba(255,255,255,0.45)";
  // Half the stroke width again (round to nearest whole point)
  ctx.lineWidth = Math.round((2 * dpr) / zoom / 4);
  
  // Get unique rings from main locations (earth, mars, stations)
  const mainLocationRings = new Set();
  visibleNodes.forEach(node => {
    if ((node.type === "earth" || node.type === "mars" || node.type === "station") && node.ring > 0) {
      mainLocationRings.add(node.ring);
    }
  });
  
  // Draw rings for main locations
  mainLocationRings.forEach(ring => {
    const radius = (ring / 5) * minSize * 0.4;
    ctx.beginPath();
    ctx.ellipse(0, 0, radius, radius, 0, 0, Math.PI * 2);
    ctx.stroke();
  });

  // Also draw ring/path for selected/hovered objects (if not already drawn)
  const selectedOrHoveredNode = visibleNodes.find(n => 
    n.id === gameState.travel.selectedDestinationId || 
    n.id === gameState.travel.selectedLocationId || 
    n.id === gameState.travel.hoveredNodeId
  );
  
  if (selectedOrHoveredNode && selectedOrHoveredNode.ring > 0 && !mainLocationRings.has(selectedOrHoveredNode.ring)) {
    // Non-main rings: 10% opacity
    ctx.strokeStyle = "rgba(255,255,255,0.1)";
    
    // For ships, draw a spiral path showing radial drift + orbital movement
    if (selectedOrHoveredNode.type === "ship" && 
        selectedOrHoveredNode.initialRing !== undefined && 
        selectedOrHoveredNode.radialVelocity !== undefined) {
      
      // Draw spiral path showing ship's trajectory over time
      const orbitalPeriod = selectedOrHoveredNode.orbitalPeriod || getBaseOrbitalPeriod("ship");
      const initialAngle = selectedOrHoveredNode.angle;
      const radialVel = selectedOrHoveredNode.radialVelocity;
      const startRing = selectedOrHoveredNode.initialRing;
      
      // Project path forward for up to 400 days or until hitting boundaries
      const maxDays = 400;
      const minRing = 0.5;
      const maxRing = 6;
      
    ctx.beginPath();
      let firstPoint = true;
      
      // Sample points along the spiral path
      for (let day = 0; day <= maxDays; day += 5) { // Sample every 5 days for performance
        const currentRing = startRing + (radialVel * (gameState.stats.day + day));
        
        // Stop if we hit boundaries
        if (currentRing < minRing || currentRing > maxRing) {
          break;
        }
        
        // Calculate orbital angle at this day
        const angle = calculateOrbitalAngle(gameState.stats.day + day, orbitalPeriod, initialAngle);
        
        // Convert to screen coordinates
        const coords = ringToCoords(currentRing, angle, minSize);
        
        if (firstPoint) {
          ctx.moveTo(coords.x, coords.y);
          firstPoint = false;
        } else {
          ctx.lineTo(coords.x, coords.y);
        }
      }
      
      ctx.stroke();
    } else {
      // For non-ships, draw a simple circular ring
      const selectedRing = getNodeCurrentRing(selectedOrHoveredNode);
      const radius = (selectedRing / 5) * minSize * 0.4;
      ctx.beginPath();
      ctx.ellipse(0, 0, radius, radius, 0, 0, Math.PI * 2);
      ctx.stroke();
    }
  }

  // Helper function to get current ring position for a node
  // Ships move radially (towards/away from sun) based on radialVelocity
  // Moon orbits around Earth
  function getNodeCurrentRing(node) {
    if (node.type === "ship" && node.initialRing !== undefined && node.radialVelocity !== undefined) {
      // Calculate current ring based on radial movement
      const currentRing = node.initialRing + (node.radialVelocity * gameState.stats.day);
      // Clamp to reasonable bounds (0.5 to 6 rings)
      return Math.max(0.5, Math.min(6, currentRing));
    }
    // Moon orbits around Earth, so its ring is Earth's ring (they're at the same distance from sun)
    if (node.type === "moon" && node.orbitsAround) {
      const parentNode = mapNodes.find(n => n.id === node.orbitsAround);
      if (parentNode) {
        return getNodeCurrentRing(parentNode); // Use parent's ring
      }
    }
    // For other nodes, ring is fixed
    return node.ring;
  }

  // Helper function to get current orbital angle for a node
  // Moon orbits around Earth, so its position is relative to Earth
  function getNodeOrbitalAngle(node) {
    if (node.id === "sun") return 0; // Sun doesn't orbit
    
    // Moon orbits around Earth
    if (node.type === "moon" && node.orbitsAround && node.orbitalRadius !== undefined) {
      const parentNode = mapNodes.find(n => n.id === node.orbitsAround);
      if (parentNode) {
        // Get parent's (Earth's) position
        const parentOrbitalPeriod = parentNode.orbitalPeriod || getBaseOrbitalPeriod(parentNode.type);
        const parentAngle = calculateOrbitalAngle(gameState.stats.day, parentOrbitalPeriod, parentNode.angle);
        
        // Calculate moon's angle around Earth
        const moonOrbitalPeriod = node.orbitalPeriod || 28; // 28 days
        const moonAngleAroundEarth = calculateOrbitalAngle(gameState.stats.day, moonOrbitalPeriod, node.initialAngle || 0);
        
        // Store moon-specific data for position calculation
        node._moonParentAngle = parentAngle;
        node._moonAngleAroundEarth = moonAngleAroundEarth;
        node._moonOrbitalRadius = node.orbitalRadius;
        
        return parentAngle; // Return parent's angle, actual position calculated in ringToCoords
      }
    }
    
    // Use node's individual orbital period (randomized per playthrough)
    const orbitalPeriod = node.orbitalPeriod || getBaseOrbitalPeriod(node.type);
    return calculateOrbitalAngle(gameState.stats.day, orbitalPeriod, node.angle);
  }

  // Helper function to calculate future orbital angle after travel time
  function getFutureOrbitalAngle(node, travelDays) {
    if (node.id === "sun") return 0;
    const orbitalPeriod = node.orbitalPeriod || getBaseOrbitalPeriod(node.type);
    const futureDay = gameState.stats.day + travelDays;
    return calculateOrbitalAngle(futureDay, orbitalPeriod, node.angle);
  }

  // Draw route connections following the route structure
  // Only show paths up to the next station from current location
  ctx.strokeStyle = "rgba(183, 58, 45, 0.3)";
  ctx.lineWidth = (1.5 * dpr) / zoom;
  ctx.setLineDash([(4 * dpr) / zoom, (4 * dpr) / zoom]);
  
  // Find current location and determine which segments to show
  const currentLocationId = gameState.travel.currentLocationId;
  // routeOrder is already defined above, reuse it
  
  // Helper to find any instance of a base location ID
  function findNodeInstance(baseId, nodeList) {
    // First try exact match
    let node = nodeList.find(n => n.id === baseId);
    if (node) return node;
    // Then try any instance (e.g., "station-01-a", "station-01-b", etc.)
    return nodeList.find(n => n.id.startsWith(baseId + "-"));
  }
  
  // Find the next station after current location
  let nextStationIndex = routeOrder.length; // Default: show nothing if we can't find current location
  let nextStationNode = null; // Store the next station node for distance calculations
  if (currentLocationId) {
    const normalizedCurrentId = normalizeNodeIdForRoute(currentLocationId);
    const currentIndex = routeOrder.indexOf(normalizedCurrentId);
    if (currentIndex >= 0) {
      // Find the next station (or mars if we're past the last station)
      for (let i = currentIndex + 1; i < routeOrder.length; i++) {
        const locationId = routeOrder[i];
        const locationNode = findNodeInstance(locationId, mapNodes);
        if (locationNode && (locationNode.type === "station" || locationNode.type === "mars")) {
          nextStationIndex = i;
          nextStationNode = locationNode;
          break;
        }
      }
    }
  }
  
  // Enhanced helper to find the best instance, optimizing for outposts closest to next station
  function findBestNodeInstance(baseId, nodeList) {
    // First try exact match
    let node = nodeList.find(n => n.id === baseId);
    if (node) return node;
    
    // Find all matching instances
    const instances = nodeList.filter(n => n.id.startsWith(baseId + "-"));
    if (instances.length === 0) return null;
    if (instances.length === 1) return instances[0];
    
    // For outposts: if multiple discovered instances exist, choose the one closest to next station
    // But also consider Mars position at day 300 to avoid long final leg
    const firstInstance = instances[0];
    if (firstInstance.type === "outpost" && nextStationNode) {
      // Only consider discovered outposts
      const discoveredInstances = instances.filter(n => 
        gameState.travel.discoveredNodes && gameState.travel.discoveredNodes.has(n.id)
      );
      
      if (discoveredInstances.length === 0) {
        // No discovered instances, return first one (shouldn't happen if visibility is correct)
        return instances[0];
      }
      if (discoveredInstances.length === 1) {
        return discoveredInstances[0];
      }
      
      // Get Mars position at day 300
      const marsAtDeadline = getMarsAtDeadline(gameState.stats.day);
      
      // Determine if we should use Mars-relative guidance
      // Use it when we're past station-01
      const routeOrder = ["earth", "outpost-0", "station-01", "outpost-1", "station-02", "outpost-2", "station-03", "mars"];
      function normalizeNodeIdForRoute(nodeId) {
        if (!nodeId) return null;
        if (routeOrder.includes(nodeId)) return nodeId;
        for (const baseId of routeOrder) {
          if (nodeId.startsWith(baseId + "-")) {
            return baseId;
          }
        }
        return nodeId;
      }
      
      const currentLocationId = gameState.travel.currentLocationId;
      const normalizedLocationId = normalizeNodeIdForRoute(currentLocationId);
      const currentIndex = routeOrder.indexOf(normalizedLocationId);
      const useMarsGuidance = currentIndex >= 2 && marsAtDeadline !== null; // Past station-01
      
      const nextStationPos = getNodePosition(nextStationNode, gameState.stats.day);
      let bestInstance = null;
      let bestScore = Infinity;
      
      for (const instance of discoveredInstances) {
        const instancePos = getNodePosition(instance, gameState.stats.day);
        
        let score;
        
        if (useMarsGuidance) {
          // Mars-relative guidance: 70% weight toward Mars, 30% toward next station
          const dxToStation = instancePos.x - nextStationPos.x;
          const dyToStation = instancePos.y - nextStationPos.y;
          const distanceToStation = Math.sqrt(dxToStation * dxToStation + dyToStation * dyToStation);
          
          const dxToMars = instancePos.x - marsAtDeadline.x;
          const dyToMars = instancePos.y - marsAtDeadline.y;
          const distanceToMars = Math.sqrt(dxToMars * dxToMars + dyToMars * dyToMars);
          
          // Weighted score: 30% station distance, 70% Mars distance
          score = (distanceToStation * 0.3) + (distanceToMars * 0.7);
        } else {
          // Early game: just use distance to next station
          const dx = instancePos.x - nextStationPos.x;
          const dy = instancePos.y - nextStationPos.y;
          score = Math.sqrt(dx * dx + dy * dy);
        }
        
        if (score < bestScore) {
          bestScore = score;
          bestInstance = instance;
        }
      }
      
      return bestInstance || discoveredInstances[0];
    }
    
    // For other types (stations, etc.), return first instance
    return instances[0];
  }
  
  // Draw connections based on route segments, but only up to the next station
  routeStructure.segments.forEach((segment => {
    // Only draw segments that start from current location or after, and end at or before next station
    const segmentFromIndex = routeOrder.indexOf(segment.from);
    const segmentToIndex = routeOrder.indexOf(segment.to);
    
    // Skip segments that start before current location
    if (currentLocationId) {
      const normalizedCurrentId = normalizeNodeIdForRoute(currentLocationId);
      const currentIndex = routeOrder.indexOf(normalizedCurrentId);
      if (currentIndex >= 0 && segmentFromIndex < currentIndex) {
        return; // Skip segments before current location
      }
    }
    
    // Skip segments beyond the next station
    if (segmentToIndex > nextStationIndex) {
      return; // Skip segments beyond the next station
    }
    
    // Find any instance of the from/to nodes (handles multiple instances)
    // For outposts, optimize to choose the one closest to the next station
    const fromNode = findBestNodeInstance(segment.from, visibleNodes);
    const toNode = findBestNodeInstance(segment.to, visibleNodes);
    
    if (fromNode && toNode) {
      const fromAngle = getNodeOrbitalAngle(fromNode);
      const toAngle = getNodeOrbitalAngle(toNode);
      const fromRing = getNodeCurrentRing(fromNode);
      const toRing = getNodeCurrentRing(toNode);
      const coords1 = ringToCoords(fromRing, fromAngle, minSize);
      const coords2 = ringToCoords(toRing, toAngle, minSize);
      
      ctx.beginPath();
      ctx.moveTo(coords1.x, coords1.y);
      ctx.lineTo(coords2.x, coords2.y);
      ctx.stroke();
    }
    
    // Intermediate stops removed - will be added back later
  }));
  
  ctx.setLineDash([]);

  // Draw nodes
  visibleNodes.forEach((node) => {
    const orbitalAngle = getNodeOrbitalAngle(node);
    const currentRing = getNodeCurrentRing(node);
    
    // Special handling for moon orbiting Earth
    let coords;
    if (node.type === "moon" && node.orbitsAround && node._moonParentAngle !== undefined) {
      // Calculate moon's position relative to Earth
      const parentNode = mapNodes.find(n => n.id === node.orbitsAround);
      if (parentNode) {
        const parentRing = getNodeCurrentRing(parentNode);
        const parentCoords = ringToCoords(parentRing, node._moonParentAngle, minSize);
        
        // Moon's offset from Earth
        const moonOffsetRadius = (node._moonOrbitalRadius / 5) * minSize * 0.4; // Convert orbital radius to screen units
        const moonOffsetX = Math.cos(node._moonAngleAroundEarth) * moonOffsetRadius;
        const moonOffsetY = Math.sin(node._moonAngleAroundEarth) * moonOffsetRadius;
        
        coords = {
          x: parentCoords.x + moonOffsetX,
          y: parentCoords.y + moonOffsetY
        };
      } else {
        coords = ringToCoords(currentRing, orbitalAngle, minSize);
      }
    } else {
      coords = ringToCoords(currentRing, orbitalAngle, minSize);
    }
    
    const nodeX = coords.x;
    const nodeY = coords.y;
    const isCurrent = node.id === gameState.travel.currentLocationId;
    const isRumorTarget = node.id === gameState.travel.hintTargetAsteroidId ||
      (gameState.travel.activeRumorAsteroidIds && gameState.travel.activeRumorAsteroidIds.has(node.id));
    const isSelected = node.id === gameState.travel.selectedDestinationId || node.id === gameState.travel.selectedLocationId;
    const isHovered = node.id === gameState.travel.hoveredNodeId;
    const isReachable = !isCurrent;

    // Node appearance (size and color scale with zoom)
    // Size hierarchy: Stations (largest) > Outposts (medium) > Asteroids (smallest, variable)
    let nodeColor = "#ffffff";
    let nodeSize = (6 * dpr) / zoom; // Default size
    const isAsteroid = node.type === "asteroid";
    const isShip = node.type === "ship";
    
    // Color by node type and set size hierarchy
    if (node.type === "earth") {
      nodeColor = isCurrent ? "#b73a2d" : "#115FD1"; // Ship blue for earth
      nodeSize = (8 * dpr) / zoom; // Medium-large
    } else if (node.type === "moon") {
      nodeColor = isCurrent ? "#b73a2d" : "#cccccc"; // Light grey for moon
      nodeSize = (2 * dpr) / zoom; // 25% of earth's size (8 * 0.25 = 2)
    } else if (node.type === "mars") {
      nodeColor = isCurrent ? "#b73a2d" : "#ff4444"; // Red for mars
      nodeSize = (8 * dpr) / zoom; // Medium-large
    } else if (node.type === "station") {
      nodeColor = isCurrent ? "#b73a2d" : "#9b59b6"; // Purple for stations
      nodeSize = (10 * dpr) / zoom; // Largest
    } else if (node.type === "outpost") {
      // Outposts look like asteroids - 15% grey if not scanned, yellow when scanned
      const isScanned = gameState.travel.discoveredNodes && gameState.travel.discoveredNodes.has(node.id);
      nodeColor = isCurrent ? "#b73a2d" : (isScanned ? "#ffd700" : "#262626"); // Yellow if scanned, 15% grey if not
      // Match asteroid size with zoom-based scaling
      const baseAsteroidSize = (4 * dpr) / zoom; // Base size (same as asteroids)
      const sizeMultiplier = node.sizeMultiplier || 1.0; // 0.5 to 1.0
      // Apply zoom-based scale reduction when zoomed out (makes them smaller at low zoom levels)
      // At zoom 1.2 (level 1): scale = 0.25, at zoom 3.6 (level 3): scale = 0.5, at zoom 6.0+ (level 5+): scale = 1.0
      const zoomScaleFactor = Math.min(1.0, Math.max(0.25, (zoom - 1.2) / (6.0 - 1.2)));
      nodeSize = baseAsteroidSize * sizeMultiplier * zoomScaleFactor; // Variable size with zoom scaling
    } else if (isAsteroid) {
      // Asteroids: 95% grey if not scanned, color based on speed if scanned
      const isScanned = gameState.travel.scannedNodes && gameState.travel.scannedNodes.has(node.id);
      if (isScanned) {
        // Color based on orbital speed: Slow (20% grey), Average (50% grey), Fast (80% grey)
        const orbitalPeriod = node.orbitalPeriod || getBaseOrbitalPeriod("asteroid");
        const speedCategory = getSpeedCategory(orbitalPeriod);
        if (speedCategory === "Slow" || speedCategory === "Really Slow") {
          nodeColor = "#333333"; // 20% grey
        } else if (speedCategory === "Average") {
          nodeColor = "#808080"; // 50% grey
        } else {
          // Fast or Really Fast
          nodeColor = "#e6e6e6"; // 90% grey
        }
      } else {
        nodeColor = "#262626"; // 15% grey if not scanned
      }
      const baseAsteroidSize = (4 * dpr) / zoom; // Base size (smallest)
      const sizeMultiplier = node.sizeMultiplier || 1.0; // 0.5 to 1.0
      // Apply zoom-based scale reduction when zoomed out (makes them smaller at low zoom levels)
      // At zoom 1.2 (level 1): scale = 0.25, at zoom 3.6 (level 3): scale = 0.5, at zoom 6.0+ (level 5+): scale = 1.0
      const zoomScaleFactor = Math.min(1.0, Math.max(0.25, (zoom - 1.2) / (6.0 - 1.2)));
      nodeSize = baseAsteroidSize * sizeMultiplier * zoomScaleFactor; // Variable size with zoom scaling
    } else if (isShip) {
      nodeColor = "#0AA816"; // Ship green for ships
      nodeSize = (5 * dpr) / zoom; // Between outposts and asteroids
    }
    
    if (isRumorTarget) {
      nodeColor = "#ED11A4";
    }
    
    // Store base node size before any pulse scaling (for ring calculation)
    const baseNodeSize = nodeSize;
    
    if (isCurrent) {
      nodeColor = "#115FD1"; // Ship blue for current location
      // Keep the node's normal size (already calculated above)
      
      // Always pulse scale animation for current location (10% scale up and down)
      // This makes it easy to find your current location even when clicking around
        const pulseTime = perfNow() / 1000; // Time in seconds
        const pulseScale = 1.0 + Math.sin(pulseTime * Math.PI * 2) * 0.1; // ±10% variation
        nodeSize = nodeSize * pulseScale;
    }
    
    // Check if asteroid or outpost is scanned (for opacity and clickability)
    const isAsteroidScanned = isAsteroid && gameState.travel.scannedNodes && gameState.travel.scannedNodes.has(node.id);
    const isOutpostScanned = node.type === "outpost" && gameState.travel.discoveredNodes && gameState.travel.discoveredNodes.has(node.id);
    const isScanned = isAsteroidScanned || isOutpostScanned;
    
    if (isSelected) {
      if (!isAsteroid && !isShip && node.type !== "outpost") {
        nodeColor = "#ffaa44";
        // Maintain size hierarchy when selected: stations largest
        if (node.type === "station") {
          nodeSize = (12 * dpr) / zoom; // Largest when selected
        } else {
          nodeSize = (10 * dpr) / zoom; // Earth/Mars when selected
        }
      }
    } else if (isHovered && isReachable) {
      if (!isAsteroid && !isShip && node.type !== "outpost") {
        nodeColor = "#ffffaa";
        // Maintain size hierarchy when hovered: stations largest
        if (node.type === "station") {
          nodeSize = (11 * dpr) / zoom; // Largest when hovered
        } else {
          nodeSize = (9 * dpr) / zoom; // Earth/Mars when hovered
        }
      }
    } else if (!isReachable && node.type !== "earth" && node.type !== "moon" && node.type !== "mars") {
      // Don't make Earth, Moon, or Mars transparent - they should always be visible
      nodeColor = "rgba(255,255,255,0.4)";
    }
    
    // No opacity changes needed - using color brightness instead
    // Asteroids and outposts are already set to darker grey if not scanned
    // They change to lighter grey/yellow when scanned
    // Use the nodeColor directly (already set based on scan status)
    const finalNodeColor = nodeColor;

    // Hover/selected glow (for non-asteroid/ship nodes)
    if ((isHovered || isSelected) && !isAsteroid && !isShip) {
      ctx.fillStyle = nodeColor + "33";
      ctx.beginPath();
      ctx.arc(nodeX, nodeY, nodeSize + (4 * dpr) / zoom, 0, Math.PI * 2);
    ctx.fill();
    }

    // Draw node shape
    if (isShip) {
      // Draw triangle for ships (pointing up)
      ctx.fillStyle = finalNodeColor;
      ctx.beginPath();
      ctx.moveTo(nodeX, nodeY - nodeSize); // Top point
      ctx.lineTo(nodeX - nodeSize * 0.866, nodeY + nodeSize * 0.5); // Bottom left
      ctx.lineTo(nodeX + nodeSize * 0.866, nodeY + nodeSize * 0.5); // Bottom right
      ctx.closePath();
      ctx.fill();
    } else {
      // Draw circle for all other nodes (including asteroids and outposts)
      ctx.fillStyle = finalNodeColor;
      ctx.beginPath();
      ctx.arc(nodeX, nodeY, nodeSize, 0, Math.PI * 2);
      ctx.fill();
    }

    // Rumored marker (outpost kiosk rumors)
    if (gameState.travel.rumoredNodes && gameState.travel.rumoredNodes.has(node.id)) {
      ctx.strokeStyle = "rgba(255, 215, 0, 0.9)";
      ctx.lineWidth = (1.5 * dpr) / zoom;
      ctx.beginPath();
      ctx.arc(nodeX, nodeY, nodeSize + (3 * dpr) / zoom, 0, Math.PI * 2);
      ctx.stroke();
    }

    // Draw pulsing ring around current location (always visible)
    if (isCurrent) {
      const pulseTime = perfNow() / 1000; // Time in seconds
      // Use the base node size (before pulse scale) for consistent ring calculation
      const pulseRadius = baseNodeSize * (1.5 + Math.sin(pulseTime * Math.PI * 2) * 0.3); // Pulse between 1.2x and 1.8x base size
      const pulseOpacity = 0.4 + Math.sin(pulseTime * Math.PI * 2) * 0.3; // Pulse opacity between 0.1 and 0.7
      
      ctx.strokeStyle = `rgba(17, 95, 209, ${pulseOpacity})`; // Ship blue (#115FD1) for current location ring
      ctx.lineWidth = (2 * dpr) / zoom;
      ctx.beginPath();
      ctx.arc(nodeX, nodeY, pulseRadius, 0, Math.PI * 2);
      ctx.stroke();
    }
    
    // Draw pulsing ring around selected location (if different from current)
    if (isSelected && !isCurrent) {
      const pulseTime = perfNow() / 1000; // Time in seconds
      const pulseRadius = nodeSize * (1.5 + Math.sin(pulseTime * Math.PI * 2) * 0.3); // Pulse between 1.2x and 1.8x node size
      const pulseOpacity = 0.3 + Math.sin(pulseTime * Math.PI * 2) * 0.2; // Pulse opacity between 0.1 and 0.5
      
      ctx.strokeStyle = `rgba(255, 255, 255, ${pulseOpacity})`;
      ctx.lineWidth = (2 * dpr) / zoom;
      ctx.beginPath();
      ctx.arc(nodeX, nodeY, pulseRadius, 0, Math.PI * 2);
      ctx.stroke();
    }
    
    // Draw pulsing ring around rumor target
    if (isRumorTarget) {
      const pulseTime = perfNow() / 1000;
      const pulseRadius = baseNodeSize * (1.4 + Math.sin(pulseTime * Math.PI * 2) * 0.15);
      const pulseOpacity = 0.25 + Math.sin(pulseTime * Math.PI * 2) * 0.15;
      ctx.strokeStyle = `rgba(237, 17, 164, ${pulseOpacity})`;
      ctx.lineWidth = (2 * dpr) / zoom;
      ctx.beginPath();
      ctx.arc(nodeX, nodeY, pulseRadius, 0, Math.PI * 2);
      ctx.stroke();
    }
    
    // Node label (only show for main locations, or when asteroids/ships are selected/hovered)
    const shouldShowLabel = (!isAsteroid && !isShip) || isSelected || isHovered || isRumorTarget;
    
    if (shouldShowLabel) {
      ctx.font = `${12 * dpr / zoom}px 'Inter', -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif`;
      ctx.fillStyle = isRumorTarget
        ? "rgba(237,17,164,1)"
        : (isCurrent || isSelected || isHovered 
        ? "rgba(255,255,255,1)" 
            : "rgba(255,255,255,0.7)");
      ctx.textAlign = "left";
      ctx.textBaseline = "bottom";
      
      const labelX = nodeX + (12 * dpr) / zoom;
      const labelY = nodeY - (8 * dpr) / zoom;
      
      // Label background for readability (skip for rumor targets)
      if (isCurrent || isSelected || isHovered) {
        const metrics = ctx.measureText(node.name);
        ctx.fillStyle = "rgba(0,0,0,0.6)";
        ctx.fillRect(
          labelX - (4 * dpr) / zoom,
          labelY - (14 * dpr) / zoom,
          metrics.width + (8 * dpr) / zoom,
          (16 * dpr) / zoom
        );
      }
      
      ctx.fillStyle = isCurrent || isSelected || isHovered 
        ? "#ffffff" 
        : "rgba(255,255,255,0.8)";
      ctx.fillText(node.name, labelX, labelY);
    }

    // Days to travel hint removed from regular nodes - will show on ghost instead
  });

  // Draw ghost position and intercept path when destination is selected (but not when traveling)
  if (gameState.travel.selectedDestinationId && !gameState.travel.isTraveling) {
    // Find destination node (may not be in visibleNodes if zoomed out)
    const destinationNode = mapNodes.find(n => n.id === gameState.travel.selectedDestinationId);
    // Find current location node in mapNodes (not just visibleNodes) so ghost works at any zoom level
    const currentLocationNode = mapNodes.find(n => n.id === gameState.travel.currentLocationId);
    
    if (destinationNode && currentLocationNode && destinationNode.id !== currentLocationNode.id) {
      // Calculate travel time
      let travelDays = calculateTravelTime(currentLocationNode.id, destinationNode.id);
      
      // Travel time is now always calculated by the unified interception solver
      // No fallback calculations needed - if it's 0, the destination is invalid
      
      if (travelDays > 0) {
        // Calculate future orbital position of destination at arrival time
        const arrivalDay = gameState.stats.day + travelDays;
        const futurePos = getNodePosition(destinationNode, arrivalDay);
        
        const ghostCoords = ringToCoords(futurePos.ring, futurePos.angle, minSize);
        const ghostX = ghostCoords.x;
        const ghostY = ghostCoords.y;
        
        // Get current location position using getNodePosition for consistency
        const currentPos = getNodePosition(currentLocationNode, gameState.stats.day);
        const currentCoords = ringToCoords(currentPos.ring, currentPos.angle, minSize);
        
        // Draw dotted intercept path from current location to ghost position
        ctx.strokeStyle = "rgba(0, 255, 255, 0.6)"; // Cyan color
        ctx.lineWidth = (2 * dpr) / zoom;
        ctx.setLineDash([(6 * dpr) / zoom, (4 * dpr) / zoom]);
        ctx.beginPath();
        ctx.moveTo(currentCoords.x, currentCoords.y);
        ctx.lineTo(ghostX, ghostY);
        ctx.stroke();
        ctx.setLineDash([]);
        
        // Draw ghost node (outline style, semi-transparent, cyan)
        // Size depends on node type
        let ghostSize;
        if (destinationNode.type === "asteroid") {
          const baseAsteroidSize = (4 * dpr) / zoom;
          const sizeMultiplier = destinationNode.sizeMultiplier || 1.0;
          // Apply same zoom-based scale reduction as regular asteroids
          const zoomScaleFactor = Math.min(1.0, Math.max(0.25, (zoom - 1.2) / (6.0 - 1.2)));
          ghostSize = baseAsteroidSize * sizeMultiplier * zoomScaleFactor;
        } else if (destinationNode.type === "ship") {
          ghostSize = (5 * dpr) / zoom;
        } else {
          ghostSize = (8 * dpr) / zoom;
        }
        
        // Ghost pulse animation: pulse once per second and fade out
        const pulseTime = perfNow() / 1000; // Time in seconds
        const pulsePhase = (pulseTime % 1.0); // 0 to 1 over 1 second
        // Fade out: opacity goes from 1.0 to 0.3 over the pulse cycle
        const pulseOpacity = 0.3 + (1.0 - pulsePhase) * 0.7; // Fade from 1.0 to 0.3
        
        // Ghost glow with pulsing opacity
        ctx.fillStyle = `rgba(0, 255, 255, ${0.2 * pulseOpacity})`;
        if (destinationNode.type === "ship") {
          // Triangle glow for ships
          ctx.beginPath();
          ctx.moveTo(ghostX, ghostY - ghostSize - (4 * dpr) / zoom);
          ctx.lineTo(ghostX - (ghostSize + (4 * dpr) / zoom) * 0.866, ghostY + (ghostSize + (4 * dpr) / zoom) * 0.5);
          ctx.lineTo(ghostX + (ghostSize + (4 * dpr) / zoom) * 0.866, ghostY + (ghostSize + (4 * dpr) / zoom) * 0.5);
          ctx.closePath();
          ctx.fill();
        } else {
          // Circle glow for other nodes
          ctx.beginPath();
          ctx.arc(ghostX, ghostY, ghostSize + (4 * dpr) / zoom, 0, Math.PI * 2);
          ctx.fill();
        }
        
        // Ghost outline with pulsing opacity
        ctx.strokeStyle = `rgba(0, 255, 255, ${0.8 * pulseOpacity})`; // Cyan outline
        ctx.lineWidth = (2 * dpr) / zoom;
        if (destinationNode.type === "ship") {
          // Triangle outline for ships
          ctx.beginPath();
          ctx.moveTo(ghostX, ghostY - ghostSize);
          ctx.lineTo(ghostX - ghostSize * 0.866, ghostY + ghostSize * 0.5);
          ctx.lineTo(ghostX + ghostSize * 0.866, ghostY + ghostSize * 0.5);
          ctx.closePath();
          ctx.stroke();
        } else {
          // Circle outline for other nodes
          ctx.beginPath();
          ctx.arc(ghostX, ghostY, ghostSize, 0, Math.PI * 2);
          ctx.stroke();
        }
        
        // Ghost label with travel time
        ctx.font = `${12 * dpr / zoom}px 'Inter', -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif`;
        ctx.textAlign = "left";
        ctx.textBaseline = "bottom";
        
        const ghostLabelX = ghostX + (12 * dpr) / zoom;
        const ghostLabelY = ghostY - (8 * dpr) / zoom;
        const daysText = `${travelDays} days`;
        
        // Label background
        const labelMetrics = ctx.measureText(destinationNode.name);
        const daysMetrics = ctx.measureText(daysText);
        const labelWidth = Math.max(labelMetrics.width, daysMetrics.width);
        ctx.fillStyle = "rgba(0, 0, 0, 0.7)";
        ctx.fillRect(
          ghostLabelX - (4 * dpr) / zoom,
          ghostLabelY - (28 * dpr) / zoom,
          labelWidth + (8 * dpr) / zoom,
          (30 * dpr) / zoom
        );
        
        // Location name (no pulsing - text stays fully visible)
        ctx.fillStyle = "rgba(0, 255, 255, 0.9)"; // Cyan text
        ctx.fillText(destinationNode.name, ghostLabelX, ghostLabelY);
        
        // Travel time
        ctx.font = `${10 * dpr / zoom}px 'Inter', -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif`;
        ctx.fillText(daysText, ghostLabelX, ghostLabelY + (12 * dpr) / zoom);
      }
    }
  }

  // Draw locked ghost position when traveling (stays in place)
  if (gameState.travel.isTraveling && gameState.travel.lockedGhostPosition && gameState.travel.travelDestinationId) {
    const destNode = mapNodes.find(n => n.id === gameState.travel.travelDestinationId);
    
    if (destNode) {
      // Calculate locked ghost position based on arrival day (stays fixed)
      const arrivalDay = gameState.travel.lockedGhostPosition.arrivalDay;
      const orbitalPeriod = destNode.orbitalPeriod || getBaseOrbitalPeriod(destNode.type);
      const futureAngle = calculateOrbitalAngle(arrivalDay, orbitalPeriod, destNode.angle);
      let futureRing;
      if (destNode.type === "ship" && destNode.initialRing !== undefined && destNode.radialVelocity !== undefined) {
        futureRing = destNode.initialRing + (destNode.radialVelocity * arrivalDay);
        futureRing = Math.max(0.5, Math.min(6, futureRing));
      } else {
        futureRing = getNodeCurrentRing(destNode);
      }
      const ghostCoords = ringToCoords(futureRing, futureAngle, minSize);
      const lockedX = ghostCoords.x;
      const lockedY = ghostCoords.y;
      // Draw locked ghost node (same style as before, but position is locked)
      let ghostSize;
      if (destNode.type === "asteroid") {
        const baseAsteroidSize = (4 * dpr) / zoom;
        const sizeMultiplier = destNode.sizeMultiplier || 1.0;
        // Apply same zoom-based scale reduction as regular asteroids
        const zoomScaleFactor = Math.min(1.0, Math.max(0.25, (zoom - 1.2) / (6.0 - 1.2)));
        ghostSize = baseAsteroidSize * sizeMultiplier * zoomScaleFactor;
      } else if (destNode.type === "ship") {
        ghostSize = (5 * dpr) / zoom;
      } else {
        ghostSize = (8 * dpr) / zoom;
      }
      
      // Ghost pulse animation: pulse once per second and fade out
      const pulseTime = perfNow() / 1000; // Time in seconds
      const pulsePhase = (pulseTime % 1.0); // 0 to 1 over 1 second
      // Fade out: opacity goes from 1.0 to 0.3 over the pulse cycle
      const pulseOpacity = 0.3 + (1.0 - pulsePhase) * 0.7; // Fade from 1.0 to 0.3
      
      // Glow effect with pulsing opacity
      ctx.fillStyle = `rgba(0, 255, 255, ${0.2 * pulseOpacity})`;
      if (destNode.type === "ship") {
        ctx.beginPath();
        ctx.moveTo(lockedX, lockedY - ghostSize - (4 * dpr) / zoom);
        ctx.lineTo(lockedX - (ghostSize + (4 * dpr) / zoom) * 0.866, lockedY + (ghostSize + (4 * dpr) / zoom) * 0.5);
        ctx.lineTo(lockedX + (ghostSize + (4 * dpr) / zoom) * 0.866, lockedY + (ghostSize + (4 * dpr) / zoom) * 0.5);
        ctx.closePath();
        ctx.fill();
      } else {
        ctx.beginPath();
        ctx.arc(lockedX, lockedY, ghostSize + (4 * dpr) / zoom, 0, Math.PI * 2);
        ctx.fill();
      }
      
      // Outline with pulsing opacity
      ctx.strokeStyle = `rgba(0, 255, 255, ${0.8 * pulseOpacity})`;
      ctx.lineWidth = (2 * dpr) / zoom;
      if (destNode.type === "ship") {
        ctx.beginPath();
        ctx.moveTo(lockedX, lockedY - ghostSize);
        ctx.lineTo(lockedX - ghostSize * 0.866, lockedY + ghostSize * 0.5);
        ctx.lineTo(lockedX + ghostSize * 0.866, lockedY + ghostSize * 0.5);
        ctx.closePath();
        ctx.stroke();
      } else {
        ctx.beginPath();
        ctx.arc(lockedX, lockedY, ghostSize, 0, Math.PI * 2);
        ctx.stroke();
      }
      
      // Label (no pulsing - text stays fully visible)
      ctx.font = `${12 * dpr / zoom}px 'Inter', -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif`;
      ctx.fillStyle = "rgba(0, 255, 255, 0.9)";
      const ghostLabelX = lockedX + (12 * dpr) / zoom;
      const ghostLabelY = lockedY - (8 * dpr) / zoom;
      const daysText = `${gameState.travel.travelTotalDays} days`;
      
      // Label background
      const labelMetrics = ctx.measureText(destNode.name);
      const daysMetrics = ctx.measureText(daysText);
      const labelWidth = Math.max(labelMetrics.width, daysMetrics.width);
      ctx.fillStyle = "rgba(0, 0, 0, 0.7)";
      ctx.fillRect(
        ghostLabelX - (4 * dpr) / zoom,
        ghostLabelY - (28 * dpr) / zoom,
        labelWidth + (8 * dpr) / zoom,
        (30 * dpr) / zoom
      );
      
      // Location name
      ctx.fillStyle = "rgba(0, 255, 255, 0.9)";
      ctx.fillText(destNode.name, ghostLabelX, ghostLabelY);
      
      // Travel time
      ctx.font = `${10 * dpr / zoom}px 'Inter', -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif`;
      ctx.fillText(daysText, ghostLabelX, ghostLabelY + (12 * dpr) / zoom);
    }
  }

  // Draw travel indicator (blue triangle) when traveling - moves per-day
  if (gameState.travel.isTraveling && gameState.travel.travelStartLocationId && gameState.travel.travelDestinationId) {
    const startNode = mapNodes.find(n => n.id === gameState.travel.travelStartLocationId);
    const destNode = mapNodes.find(n => n.id === gameState.travel.travelDestinationId);
    
    if (startNode && destNode && gameState.travel.lockedGhostPosition) {
      const travelStartDay = gameState.travel.travelStartDay;
      const travelDays = gameState.travel.travelTotalDays;
      const currentDay = gameState.stats.day;
      
      // Calculate how many days have elapsed since travel started
      const daysElapsed = Math.max(0, Math.min(travelDays, currentDay - travelStartDay));
      
      // Calculate start position (where we started from at travelStartDay)
      const startOrbitalPeriod = startNode.orbitalPeriod || getBaseOrbitalPeriod(startNode.type);
      const startAngle = calculateOrbitalAngle(travelStartDay, startOrbitalPeriod, startNode.angle);
      let startRing;
      if (startNode.type === "ship" && startNode.initialRing !== undefined && startNode.radialVelocity !== undefined) {
        startRing = startNode.initialRing + (startNode.radialVelocity * travelStartDay);
        startRing = Math.max(0.5, Math.min(6, startRing));
      } else {
        startRing = startNode.ring;
      }
      const startCoords = ringToCoords(startRing, startAngle, minSize);
      
      // Calculate locked ghost position (same calculation as above)
      const arrivalDay = gameState.travel.lockedGhostPosition.arrivalDay;
      const orbitalPeriod = destNode.orbitalPeriod || getBaseOrbitalPeriod(destNode.type);
      const futureAngle = calculateOrbitalAngle(arrivalDay, orbitalPeriod, destNode.angle);
      let futureRing;
      if (destNode.type === "ship" && destNode.initialRing !== undefined && destNode.radialVelocity !== undefined) {
        futureRing = destNode.initialRing + (destNode.radialVelocity * arrivalDay);
        futureRing = Math.max(0.5, Math.min(6, futureRing));
      } else {
        futureRing = getNodeCurrentRing(destNode);
      }
      const destCoords = ringToCoords(futureRing, futureAngle, minSize);
      
      // Calculate ship position based on days elapsed (per-day movement, not smooth)
      const progress = travelDays > 0 ? daysElapsed / travelDays : 0;
      const shipX = startCoords.x + (destCoords.x - startCoords.x) * progress;
      const shipY = startCoords.y + (destCoords.y - startCoords.y) * progress;
      
      // Calculate angle for triangle direction (pointing towards destination)
      const dx = destCoords.x - startCoords.x;
      const dy = destCoords.y - startCoords.y;
      const travelAngle = Math.atan2(dy, dx);
      
      // Draw blue triangle (ship indicator) - equilateral triangle, 25% larger
      const shipSize = (10 * dpr) / zoom; // 8 * 1.25 = 10
      ctx.fillStyle = "#115FD1"; // Ship blue color
      ctx.beginPath();
      // Equilateral triangle: all sides equal, pointing in direction of travel
      // For equilateral triangle: height from point to base = side * sqrt(3) / 2
      // If shipSize is the distance from center to point, then:
      // - Point is at shipSize from center in travel direction
      // - Base is at shipSize/3 from center (centroid is 1/3 of height from base)
      // - Base width = (shipSize * 4/3) * 2 / sqrt(3) = (shipSize * 8) / (3 * sqrt(3))
      const triangleHeight = shipSize * 4 / 3; // Full height from point to base
      const baseWidth = (shipSize * 8) / (3 * Math.sqrt(3));
      const halfBase = baseWidth / 2;
      
      // Point at front (direction of travel)
      const pointX = shipX + Math.cos(travelAngle) * shipSize;
      const pointY = shipY + Math.sin(travelAngle) * shipSize;
      
      // Base points (perpendicular to travel direction, at shipSize/3 from center)
      const perpAngle = travelAngle + Math.PI / 2;
      const baseCenterX = shipX - Math.cos(travelAngle) * (shipSize / 3);
      const baseCenterY = shipY - Math.sin(travelAngle) * (shipSize / 3);
      const baseLeftX = baseCenterX + Math.cos(perpAngle) * halfBase;
      const baseLeftY = baseCenterY + Math.sin(perpAngle) * halfBase;
      const baseRightX = baseCenterX - Math.cos(perpAngle) * halfBase;
      const baseRightY = baseCenterY - Math.sin(perpAngle) * halfBase;
      
      ctx.moveTo(pointX, pointY); // Front point
      ctx.lineTo(baseLeftX, baseLeftY); // Back left
      ctx.lineTo(baseRightX, baseRightY); // Back right
      ctx.closePath();
      ctx.fill();
    }
  }
  
  // Restore context (removes transform)
  ctx.restore();
  
  // Draw red arrow indicator at edge pointing toward Mars
  const marsNode = mapNodes.find(n => n.type === "mars");
  if (marsNode) {
    // Get Mars position in world coordinates
    const marsRing = getNodeCurrentRingGlobal(marsNode);
    const marsPeriod = marsNode.orbitalPeriod || getBaseOrbitalPeriod(marsNode.type);
    const marsAngle = calculateOrbitalAngle(gameState.stats.day, marsPeriod, marsNode.angle);
    const marsCoords = ringToCoords(marsRing, marsAngle, minSize);
    
    // Convert Mars world coordinates to screen coordinates
    // Transform: world -> translate(pan) -> scale(zoom) -> translate(cx, cy) -> screen
    const marsWorldX = marsCoords.x + panX * minSize;
    const marsWorldY = marsCoords.y + panY * minSize;
    const marsScreenX = cx + marsWorldX * zoom;
    const marsScreenY = cy + marsWorldY * zoom;
    
    // Calculate direction from center of viewport to Mars
    const centerX = cx;
    const centerY = cy;
    const dx = marsScreenX - centerX;
    const dy = marsScreenY - centerY;
    const distance = Math.sqrt(dx * dx + dy * dy);
    
    // Only show indicator if Mars is off-screen (outside visible area)
    const margin = 50; // Margin from edge
    const isOffScreen = marsScreenX < margin || marsScreenX > w - margin || 
                        marsScreenY < margin || marsScreenY > h - margin;
    
    if (isOffScreen && distance > 0) {
      // Calculate angle to Mars
      const angleToMars = Math.atan2(dy, dx);
      
      // Find intersection point with canvas edge
      // Use a large distance to ensure we hit the edge
      const maxDist = Math.max(w, h) * 2;
      let edgeX = centerX + Math.cos(angleToMars) * maxDist;
      let edgeY = centerY + Math.sin(angleToMars) * maxDist;
      
      // Clamp to canvas edges with margin
      const edgeMargin = 30; // Distance from edge
      if (edgeX < edgeMargin) {
        const t = (edgeMargin - centerX) / (edgeX - centerX);
        edgeY = centerY + (edgeY - centerY) * t;
        edgeX = edgeMargin;
      } else if (edgeX > w - edgeMargin) {
        const t = (w - edgeMargin - centerX) / (edgeX - centerX);
        edgeY = centerY + (edgeY - centerY) * t;
        edgeX = w - edgeMargin;
      }
      if (edgeY < edgeMargin) {
        const t = (edgeMargin - centerY) / (edgeY - centerY);
        edgeX = centerX + (edgeX - centerX) * t;
        edgeY = edgeMargin;
      } else if (edgeY > h - edgeMargin) {
        const t = (h - edgeMargin - centerY) / (edgeY - centerY);
        edgeX = centerX + (edgeX - centerX) * t;
        edgeY = h - edgeMargin;
      }
      
      // Draw red triangle pointing toward Mars (same shape as ship)
      const arrowSize = 15 * dpr; // Size of the arrow
      ctx.fillStyle = "#ff4444"; // Red color
      ctx.beginPath();
      
      // Equilateral triangle pointing toward Mars
      const triangleHeight = arrowSize * 4 / 3;
      const baseWidth = (arrowSize * 8) / (3 * Math.sqrt(3));
      const halfBase = baseWidth / 2;
      
      // Point at front (direction toward Mars)
      const pointX = edgeX + Math.cos(angleToMars) * arrowSize;
      const pointY = edgeY + Math.sin(angleToMars) * arrowSize;
      
      // Base points (perpendicular to direction)
      const perpAngle = angleToMars + Math.PI / 2;
      const baseCenterX = edgeX - Math.cos(angleToMars) * (arrowSize / 3);
      const baseCenterY = edgeY - Math.sin(angleToMars) * (arrowSize / 3);
      const baseLeftX = baseCenterX + Math.cos(perpAngle) * halfBase;
      const baseLeftY = baseCenterY + Math.sin(perpAngle) * halfBase;
      const baseRightX = baseCenterX - Math.cos(perpAngle) * halfBase;
      const baseRightY = baseCenterY - Math.sin(perpAngle) * halfBase;
      
      ctx.moveTo(pointX, pointY); // Front point
      ctx.lineTo(baseLeftX, baseLeftY);
      ctx.lineTo(baseRightX, baseRightY);
      ctx.closePath();
      ctx.fill();
    }
  }
}

// ---------------------------
// Render
// ---------------------------

/**
 * Calculate speed category from orbital period
 * Shorter period = faster speed
 * @param {number} orbitalPeriod - orbital period in days
 * @returns {"Really Slow"|"Slow"|"Average"|"Fast"|"Really Fast"}
 */
function getSpeedCategory(orbitalPeriod) {
  // Lower orbital period = faster speed
  // Thresholds based on typical orbital periods:
  // Really Fast: 100-119 days (treat <120 as Really Fast)
  // Fast: 120-199 days
  // Average: 200-399 days
  // Slow: 400-450 days (treat <451 as Slow)
  // Really Slow: 451-500 days (and above)
  if (orbitalPeriod < 120) return "Really Fast";
  if (orbitalPeriod < 200) return "Fast";
  if (orbitalPeriod < 400) return "Average";
  if (orbitalPeriod < 451) return "Slow";
  return "Really Slow";
}

/**
 * Get size category for asteroids and ships based on sizeMultiplier
 * @param {number} sizeMultiplier Size multiplier (0.5 to 1.0)
 * @returns {string} Size category: "Small", "Average", or "Large"
 */
function getSizeCategory(sizeMultiplier) {
  if (sizeMultiplier < 0.67) return "Small";
  if (sizeMultiplier < 0.84) return "Average";
  return "Large";
}

/**
 * Generate uncertainty value (Likely/Unlikely/Unknown) with weighted probability
 * @param {number} likelyWeight Probability of "likely" (0-1)
 * @param {number} unlikelyWeight Probability of "unlikely" (0-1)
 * @returns {string} "likely", "unlikely", or "unknown"
 */
function generateUncertainty(likelyWeight = 0.3, unlikelyWeight = 0.3) {
  const rand = Math.random();
  if (rand < likelyWeight) return "likely";
  if (rand < likelyWeight + unlikelyWeight) return "unlikely";
  return "unknown";
}

/**
 * Generate and cache truth values for an asteroid (called once per asteroid)
 * @param {Node} node Asteroid node
 */
function generateAsteroidTruthValues(node) {
  // Only generate if not already cached
  if (node.inhabitedTruth === undefined) {
    // Inhabited: 25% chance
    const rand = Math.random();
    node.inhabitedTruth = rand < 0.25;
    debugLog("[ASTEROID TRUTH] Generated inhabitedTruth for", node.id, ":", node.inhabitedTruth, "(random:", rand.toFixed(4), ", threshold: 0.25)");
  } else {
    debugLog("[ASTEROID TRUTH] Using cached inhabitedTruth for", node.id, ":", node.inhabitedTruth);
  }
  
  if (node.resourcesTruth === undefined) {
    // Resources: 35% chance
    const rand = Math.random();
    node.resourcesTruth = rand < 0.35;
    debugLog("[ASTEROID TRUTH] Generated resourcesTruth for", node.id, ":", node.resourcesTruth, "(random:", rand.toFixed(4), ", threshold: 0.35)");
  }
  
  if (node.artifactTruth === undefined) {
    // Artifact: 10% chance (rare, but real)
    const rand = Math.random();
    node.artifactTruth = rand < 0.10;
    debugLog("[ASTEROID TRUTH] Generated artifactTruth for", node.id, ":", node.artifactTruth, "(random:", rand.toFixed(4), ", threshold: 0.10)");
  }
}

/**
 * Generate and cache contact outcome for an inhabited asteroid
 * @param {Node} node Asteroid node
 * @returns {"friendly"|"hostile"} Contact outcome type
 */
function generateAsteroidContactOutcome(node) {
  // Only generate if not already cached
  if (node.contactOutcome === undefined) {
    // Roll contact outcome: Friendly (65%), Hostile (35%)
    const rand = Math.random();
    node.contactOutcome = rand < 0.65 ? "friendly" : "hostile";
    debugLog("[ASTEROID CONTACT] Generated contactOutcome for", node.id, ":", node.contactOutcome, "(random:", rand.toFixed(4), ", threshold: 0.65)");
  } else {
    debugLog("[ASTEROID CONTACT] Using cached contactOutcome for", node.id, ":", node.contactOutcome);
  }
  return node.contactOutcome;
}

/**
 * Generate deep scan display data for an asteroid (85% accuracy)
 * @param {Node} node Asteroid node
 */
function generateAsteroidDeepScanData(node) {
  debugLog("[DEEP SCAN] Generating data for asteroid", node.id);
  
  // First, ensure truth values are generated and cached
  generateAsteroidTruthValues(node);
  
  // Deep scan has 85% accuracy - generate display values based on truth
  const scanAccuracy = 0.85;
  const isAccurate = Math.random() < scanAccuracy;
  
  // Inhabited: Convert truth to likelihood display
  // Always update display values when deep scanning (regardless of current state)
  if (isAccurate) {
    // Accurate scan: show truth
    node.inhabited = node.inhabitedTruth ? "likely" : "unlikely";
  } else {
    // Inaccurate scan: show wrong or unknown
    const rand = Math.random();
    if (rand < 0.5) {
      // Show opposite of truth
      node.inhabited = node.inhabitedTruth ? "unlikely" : "likely";
    } else {
      // Show unknown
      node.inhabited = "unknown";
    }
  }
  debugLog("[DEEP SCAN] Set inhabited to", node.inhabited, "(truth:", node.inhabitedTruth, ", accurate:", isAccurate, ")");
  
  // Resources: Convert truth to likelihood display
  // Always update display values when deep scanning
  if (isAccurate) {
    node.resources = node.resourcesTruth ? "likely" : "unlikely";
  } else {
      const rand = Math.random();
    if (rand < 0.5) {
      node.resources = node.resourcesTruth ? "unlikely" : "likely";
    } else {
      node.resources = "unknown";
    }
  }
  debugLog("[DEEP SCAN] Set resources to", node.resources, "(truth:", node.resourcesTruth, ", accurate:", isAccurate, ")");
  
  // Anomalies: Based on artifactTruth (never shows "likely", only "Detected" or "None")
  // Always update when deep scanning
  if (isAccurate && node.artifactTruth) {
    // Accurate scan and artifact exists: show "Detected"
    node.anomalies = "Detected";
  } else if (isAccurate && !node.artifactTruth) {
    // Accurate scan and no artifact: show "None"
    node.anomalies = "None";
  } else {
    // Inaccurate scan: random
    node.anomalies = Math.random() < 0.5 ? "Detected" : "None";
  }
  debugLog("[DEEP SCAN] Set anomalies to", node.anomalies, "(truth:", node.artifactTruth, ", accurate:", isAccurate, ")");
  
  // Landing Risk: Safe/Moderately Safe/Moderately Dangerous/Dangerous
  if (!node.landingRisk || node.landingRisk === "Moderately Safe") {
    const risks = ["Safe", "Moderately Safe", "Moderately Dangerous", "Dangerous"];
    const weights = [0.2, 0.4, 0.3, 0.1];
    const rand = Math.random();
    let cumulative = 0;
    for (let i = 0; i < risks.length; i++) {
      cumulative += weights[i];
      if (rand < cumulative) {
        node.landingRisk = risks[i];
        debugLog("[DEEP SCAN] Set landingRisk to", node.landingRisk);
        break;
      }
    }
  } else {
    debugLog("[DEEP SCAN] LandingRisk already set to", node.landingRisk);
  }
  
  debugLog("[DEEP SCAN] Final values for", node.id, ":", {
    resources: node.resources,
    inhabited: node.inhabited,
    anomalies: node.anomalies,
    landingRisk: node.landingRisk,
    truth: {
      inhabitedTruth: node.inhabitedTruth,
      resourcesTruth: node.resourcesTruth,
      artifactTruth: node.artifactTruth
    }
  });
}

/**
 * Generate deep scan data for a ship
 * @param {Node} node Ship node
 */
function generateShipDeepScanData(node) {
  // Ship Type: Cargo/Passenger/Pirate/Research/Cruise
  if (!node.shipType) {
    const types = ["Cargo", "Passenger", "Pirate", "Research", "Cruise"];
    const weights = [0.3, 0.25, 0.2, 0.15, 0.1];
    const rand = Math.random();
    let cumulative = 0;
    for (let i = 0; i < types.length; i++) {
      cumulative += weights[i];
      if (rand < cumulative) {
        node.shipType = types[i];
        break;
      }
    }
  }
  
  // Inhabited: Likely/Unlikely/Unknown
  if (!node.inhabited || node.inhabited === "unknown") {
    node.inhabited = generateUncertainty(0.4, 0.2); // Ships more likely to be inhabited
  }
  
  // Docking Risk: Safe/Uncertain/Dangerous
  if (!node.dockingRisk || node.dockingRisk === "Uncertain") {
    const risks = ["Safe", "Uncertain", "Dangerous"];
    const weights = [0.3, 0.5, 0.2];
    const rand = Math.random();
    let cumulative = 0;
    for (let i = 0; i < risks.length; i++) {
      cumulative += weights[i];
      if (rand < cumulative) {
        node.dockingRisk = risks[i];
        break;
      }
    }
  }
  
  // Resources: Likely/Unlikely/Unknown
  if (!node.resources || node.resources === "unknown") {
    node.resources = generateUncertainty(0.35, 0.25);
  }
}

/**
 * Start an event (shows overlay and terminal UI)
 * @param {Object} eventData Event data: { phase: "PROMPT", title, body, options: [3 strings], image?, optionHandlers?: [functions] }
 */
function startEvent(eventData) {
  // Set event state
  gameState.travel.activeEvent = {
    phase: eventData.phase || "PROMPT",
    title: eventData.title || "Event",
    body: eventData.body || "",
    options: eventData.options || ["Option 01", "Option 02", "Option 03"],
    outcomeText: eventData.outcomeText || null,
    image: eventData.image || null,
    optionHandlers: eventData.optionHandlers || null, // Custom handlers for each option
    onContinue: eventData.onContinue || null // Custom continue handler
  };
  gameState.travel.isEventActive = true;
  
  // Ensure modal layer is hidden (prevent any modal flash)
  if (el.modalLayer) {
    el.modalLayer.hidden = true;
    el.modalLayer.setAttribute("hidden", "");
    el.modalLayer.innerHTML = "";
  }
  
  // Show event overlay
  if (el.eventOverlay) {
    el.eventOverlay.hidden = false;
    el.eventOverlay.removeAttribute("hidden");
    
    // Set image if provided, otherwise show placeholder
    const placeholder = el.eventOverlay.querySelector(".event-overlay-placeholder");
    if (eventData.image && placeholder) {
      // Future: replace placeholder with <img> element
      placeholder.textContent = "IMAGE_PLACEHOLDER";
    }
  }
  
  // Render to update header and UI
  render();
}

/**
 * End the current event (hides overlay and returns to normal)
 */
function endEvent() {
  // Clear event state
  gameState.travel.activeEvent = null;
  gameState.travel.isEventActive = false;
  
  // Hide event overlay
  if (el.eventOverlay) {
    el.eventOverlay.hidden = true;
    el.eventOverlay.setAttribute("hidden", "");
  }
  
  // Render to restore normal header and UI
  render();
}

function renderHeader() {
  const header = document.getElementById("viewport-header");
  if (!header) return;

  // Hide terminal/header when landed in a scene (hub or interior), unless an event is active
  if (gameState.meta.tab === "TRAVEL" &&
      gameState.travel.currentSceneId !== "MAP" &&
      !gameState.travel.activeEvent) {
    header.style.display = "none";
    return;
  }

  // Ensure header is visible when on map or when event terminal is active
  header.style.display = "flex";

  // Check if event is active - if so, render event terminal instead
  if (gameState.travel.activeEvent) {
    renderEventTerminal();
    return;
  } else {
    // Event not active - restore normal header
    restoreNormalHeader();
  }
  
  const currentLocation = mapNodes.find(n => n.id === gameState.travel.currentLocationId);
  const locationName = currentLocation ? currentLocation.name : "Unknown";
  
  // Determine which node to display info for
  // Priority: selected location > selected destination > current location
  let displayNode = null;
  if (gameState.travel.selectedLocationId) {
    displayNode = mapNodes.find(n => n.id === gameState.travel.selectedLocationId);
    } else if (gameState.travel.selectedDestinationId && gameState.travel.currentSceneId === "MAP") {
      displayNode = mapNodes.find(n => n.id === gameState.travel.selectedDestinationId);
  } else {
    displayNode = currentLocation;
  }
  
  // Helper to check if node is basic scanned
  const isBasicScanned = (node) => {
    if (!node) return false;
    if (node.type === "moon" || node.type === "mars" || node.type === "station" || node.type === "outpost") {
      return true;
    }
    if (gameState.travel.scannedNodes.has(node.id)) return true;
    return (gameState.travel.hintTargetAsteroidId === node.id) ||
      (gameState.travel.activeRumorAsteroidIds && gameState.travel.activeRumorAsteroidIds.has(node.id));
  };
  
  // Helper to check if node is deep scanned
  const isDeepScanned = (node) => {
    if (!node) return false;
    return node.type === "moon" || node.type === "mars" || 
           node.type === "station" || node.type === "outpost" ||
           gameState.travel.deepScannedNodes.has(node.id);
  };
  
  // Location (always shown)
  if (el.uiLocation) {
    if (gameState.travel.selectedLocationId) {
      const selected = mapNodes.find(n => n.id === gameState.travel.selectedLocationId);
      el.uiLocation.textContent = selected ? selected.name : locationName;
    } else if (gameState.travel.selectedDestinationId && gameState.travel.currentSceneId === "MAP") {
      const dest = mapNodes.find(n => n.id === gameState.travel.selectedDestinationId);
      el.uiLocation.textContent = dest ? dest.name : "In Transit";
    } else {
      el.uiLocation.textContent = locationName;
    }
  }
  
  // Hide conditional deep scan rows initially (use visibility to maintain layout)
  // Note: Landing Risk and Docking Risk will be shown conditionally based on node type
  // Landing Risk and Docking Risk will be shown/hidden based on node type below
  
  if (!displayNode) {
    // Reset all to Unknown/UNKNOWN when no node selected
    if (el.uiSpeed) el.uiSpeed.textContent = "Unknown";
    if (el.uiType) el.uiType.textContent = "Unknown";
    if (el.uiResources) el.uiResources.textContent = "UNKNOWN";
    if (el.uiInhabited) el.uiInhabited.textContent = "UNKNOWN";
    
    if (el.uiDay) el.uiDay.textContent = pad3(gameState.stats.day);
    if (el.uiDeadline) el.uiDeadline.textContent = String(gameState.stats.deadline);
    return;
  }
  
  // Display based on node type
  if (displayNode.type === "asteroid") {
    // Asteroids: Location, Orbital Speed, Type (Size), Resources, Inhabited, Hostility (conditional), Landing Risk
    
    // 1. Location (already shown above)
    
    // 2. Orbital Speed (basic scan)
    if (el.uiSpeed) {
      if (isBasicScanned(displayNode)) {
        const orbitalPeriod = displayNode.orbitalPeriod || getBaseOrbitalPeriod(displayNode.type);
        el.uiSpeed.textContent = getSpeedCategory(orbitalPeriod);
      } else {
        el.uiSpeed.textContent = "Unknown";
      }
    }
    
    // 3. Type (Size for asteroids - basic scan)
    if (el.uiType) {
      if (isBasicScanned(displayNode)) {
        const sizeMultiplier = displayNode.sizeMultiplier || 1.0;
        el.uiType.textContent = getSizeCategory(sizeMultiplier) + " Asteroid";
      } else {
        el.uiType.textContent = "Unknown";
      }
    }
    
    // 4. Resources (deep scan)
    if (el.uiResources) {
      if (isDeepScanned(displayNode)) {
        const resources = displayNode.resources || "unknown";
        el.uiResources.textContent = resources.charAt(0).toUpperCase() + resources.slice(1);
      } else {
        el.uiResources.textContent = "UNKNOWN";
      }
    }
    
    // 5. Inhabited (deep scan)
    if (el.uiInhabited) {
      if (isDeepScanned(displayNode)) {
        const inhabited = displayNode.inhabited || "unknown";
        el.uiInhabited.textContent = inhabited.charAt(0).toUpperCase() + inhabited.slice(1);
      } else {
        el.uiInhabited.textContent = "UNKNOWN";
      }
    }
    
    // 7. Landing Risk (deep scan - only for asteroids, always show for asteroids)
    if (el.uiLandingRiskRow && el.uiLandingRisk) {
      el.uiLandingRiskRow.style.display = "block";
      el.uiLandingRiskRow.style.visibility = "visible";
      if (isDeepScanned(displayNode)) {
        const landingRisk = displayNode.landingRisk || "Moderately Safe";
        el.uiLandingRisk.textContent = landingRisk;
      } else {
        el.uiLandingRisk.textContent = "UNKNOWN";
      }
    }
    
    // Hide Docking Risk for asteroids
    if (el.uiDockingRiskRow) {
      el.uiDockingRiskRow.style.display = "none";
      el.uiDockingRiskRow.style.visibility = "hidden";
    }
    
  } else if (displayNode.type === "ship") {
    // Ships: Location, Orbital Speed, Type (Ship Type), Inhabited, Docking Risk, Resources
    
    // 1. Location (already shown above)
    
    // 2. Orbital Speed (basic scan)
    if (el.uiSpeed) {
      if (isBasicScanned(displayNode)) {
        const orbitalPeriod = displayNode.orbitalPeriod || getBaseOrbitalPeriod(displayNode.type);
        el.uiSpeed.textContent = getSpeedCategory(orbitalPeriod);
      } else {
        el.uiSpeed.textContent = "Unknown";
      }
    }
    
    // 3. Type (Ship Type for ships - deep scan)
    if (el.uiType) {
      if (isDeepScanned(displayNode)) {
        const shipType = displayNode.shipType || "Cargo";
        el.uiType.textContent = shipType;
      } else {
        el.uiType.textContent = "Unknown";
      }
    }
    
    // 4. Resources (deep scan)
    if (el.uiResources) {
      if (isDeepScanned(displayNode)) {
        const resources = displayNode.resources || "unknown";
        el.uiResources.textContent = resources.charAt(0).toUpperCase() + resources.slice(1);
      } else {
        el.uiResources.textContent = "UNKNOWN";
      }
    }
    
    // 5. Inhabited (deep scan)
    if (el.uiInhabited) {
      if (isDeepScanned(displayNode)) {
        const inhabited = displayNode.inhabited || "unknown";
        el.uiInhabited.textContent = inhabited.charAt(0).toUpperCase() + inhabited.slice(1);
      } else {
        el.uiInhabited.textContent = "UNKNOWN";
      }
    }
    
    // 7. Docking Risk (deep scan - only for ships, always show for ships)
    if (el.uiDockingRiskRow && el.uiDockingRisk) {
      el.uiDockingRiskRow.style.display = "block";
      el.uiDockingRiskRow.style.visibility = "visible";
      if (isDeepScanned(displayNode)) {
        const dockingRisk = displayNode.dockingRisk || "Uncertain";
        el.uiDockingRisk.textContent = dockingRisk;
      } else {
        el.uiDockingRisk.textContent = "UNKNOWN";
      }
    }
    
    // Hide Landing Risk for ships
    if (el.uiLandingRiskRow) {
      el.uiLandingRiskRow.style.display = "none";
      el.uiLandingRiskRow.style.visibility = "hidden";
    }
    
  } else if (displayNode.type === "earth" || displayNode.type === "moon" || displayNode.type === "mars") {
    // Planets: Location, Orbit (period in days), Type (Planet/Moon), Resources (Yes), Inhabited (Yes)
    
    // 1. Location (already shown above)
    
    // 2. Orbit (orbital period in days)
    if (el.uiSpeed) {
      let orbitalPeriod;
      if (displayNode.type === "earth") {
        orbitalPeriod = EARTH_ORBITAL_PERIOD; // 365 days
      } else if (displayNode.type === "moon") {
        orbitalPeriod = displayNode.orbitalPeriod || 28; // Moon orbits Earth in 28 days
      } else if (displayNode.type === "mars") {
        orbitalPeriod = MARS_ORBITAL_PERIOD; // 687 days
      } else {
        orbitalPeriod = displayNode.orbitalPeriod || getBaseOrbitalPeriod(displayNode.type);
      }
      el.uiSpeed.textContent = `${orbitalPeriod} days`;
    }
    
    // 3. Type (Planet or Moon)
    if (el.uiType) {
      if (displayNode.type === "moon") {
        el.uiType.textContent = "Moon";
      } else {
        el.uiType.textContent = "Planet";
      }
    }
    
    // 4. Resources (always Yes for planets)
    if (el.uiResources) {
      el.uiResources.textContent = "Yes";
    }
    
    // 5. Inhabited (always Yes for planets)
    if (el.uiInhabited) {
      el.uiInhabited.textContent = "Yes";
    }
    
    // Hide risk rows for planets
    if (el.uiLandingRiskRow) {
      el.uiLandingRiskRow.style.display = "none";
      el.uiLandingRiskRow.style.visibility = "hidden";
    }
    if (el.uiDockingRiskRow) {
      el.uiDockingRiskRow.style.display = "none";
      el.uiDockingRiskRow.style.visibility = "hidden";
    }
    
  } else {
    // Other node types (station, outpost) - show basic info
    if (el.uiSpeed) {
      const orbitalPeriod = displayNode.orbitalPeriod || getBaseOrbitalPeriod(displayNode.type);
      el.uiSpeed.textContent = getSpeedCategory(orbitalPeriod);
    }
    
    if (el.uiType) el.uiType.textContent = "Unknown";
    
    if (el.uiInhabited) {
      const inhabited = displayNode.inhabited || "yes";
      el.uiInhabited.textContent = inhabited === "yes" ? "Yes" : "No";
    }
    
    // Deep scan fields show UNKNOWN for main locations (unless they have been deep scanned)
    if (el.uiResources) {
      if (isDeepScanned(displayNode)) {
        const resources = displayNode.resources || "unknown";
        el.uiResources.textContent = resources.charAt(0).toUpperCase() + resources.slice(1);
      } else {
        el.uiResources.textContent = "UNKNOWN";
      }
    }
  }
  
  if (el.uiDay) el.uiDay.textContent = pad3(gameState.stats.day);
  if (el.uiDeadline) el.uiDeadline.textContent = String(gameState.stats.deadline);
  if (el.uiCredits) el.uiCredits.textContent = String(gameState.stats.credits);
}

/**
 * Render event terminal UI in the header
 */
function renderEventTerminal() {
  const event = gameState.travel.activeEvent;
  if (!event) return;
  
  const header = document.getElementById("viewport-header");
  if (!header) return;
  
  // Hide normal header content
  const headerLeft = header.querySelector(".header-left");
  const headerCenter = header.querySelector(".header-center");
  const headerRight = header.querySelector(".header-right");
  
  if (headerLeft) headerLeft.style.display = "none";
  if (headerCenter) headerCenter.style.display = "none";
  if (headerRight) headerRight.style.display = "none";
  
  // Check if event terminal already exists, if not create it
  let eventTerminal = header.querySelector(".event-terminal");
  if (!eventTerminal) {
    eventTerminal = document.createElement("div");
    eventTerminal.className = "event-terminal";
    eventTerminal.style.cssText = `
      width: 100%;
      display: flex;
      flex-direction: column;
      gap: 12px;
      padding: 8px;
    `;
    header.appendChild(eventTerminal);
  }
  
  // Clear existing content
  eventTerminal.innerHTML = "";
  eventTerminal.style.display = "flex";
  
  if (event.phase === "PROMPT") {
    // PROMPT phase: Title, body, 3 option buttons
    const title = document.createElement("div");
    title.className = "event-title";
    title.textContent = event.title;
    title.style.cssText = `
      font-weight: 900;
      font-size: 18px;
      color: var(--paper);
      margin-bottom: 4px;
    `;
    eventTerminal.appendChild(title);
    
    const body = document.createElement("div");
    body.className = "event-body";
    body.textContent = event.body;
    body.style.cssText = `
      font-weight: 400;
      font-size: 14px;
      color: var(--paper);
      margin-bottom: 12px;
      line-height: 1.4;
    `;
    eventTerminal.appendChild(body);
    
    // Option buttons
    const optionsContainer = document.createElement("div");
    optionsContainer.className = "event-options";
    optionsContainer.style.cssText = `
      display: flex;
      flex-direction: column;
      gap: 8px;
    `;
    
    event.options.forEach((optionText, index) => {
      // Skip empty options
      if (!optionText || optionText.trim() === "") {
        return;
      }
      
      const optionBtn = document.createElement("button");
      optionBtn.className = "event-option-btn";
      optionBtn.textContent = optionText;
      optionBtn.dataset.optionIndex = String(index);
      optionBtn.style.cssText = `
        font-family: 'Inter', sans-serif;
        font-weight: 700;
        font-size: 14px;
        padding: 10px 16px;
        background: transparent;
        color: var(--paper);
        border: 2px solid var(--paper);
        border-radius: 6px;
        cursor: pointer;
        text-align: left;
        transition: background 0.1s, color 0.1s;
      `;
      
      optionBtn.addEventListener("mouseenter", () => {
        optionBtn.style.background = "var(--paper)";
        optionBtn.style.color = "var(--ink)";
      });
      
      optionBtn.addEventListener("mouseleave", () => {
        optionBtn.style.background = "transparent";
        optionBtn.style.color = "var(--paper)";
      });
      
      optionBtn.addEventListener("click", () => {
        // Check for custom option handler
        if (event.optionHandlers && event.optionHandlers[index]) {
          try {
            event.optionHandlers[index](optionText, index);
          } catch (error) {
            console.error("[EVENT] Error in option handler:", error);
            console.error("[EVENT] Option index:", index, "Option text:", optionText);
          }
        } else {
          // Default handler: Record choice and switch to OUTCOME phase
          const choice = index;
          event.phase = "OUTCOME";
          event.outcomeText = `You chose: ${optionText}. (Outcome text - coming soon)`;
          render();
        }
      });
      
      optionsContainer.appendChild(optionBtn);
    });
    
    eventTerminal.appendChild(optionsContainer);
    
  } else if (event.phase === "OUTCOME") {
    // OUTCOME phase: Title, outcome text, Continue button
    const title = document.createElement("div");
    title.className = "event-title";
    title.textContent = event.title;
    title.style.cssText = `
      font-weight: 900;
      font-size: 18px;
      color: var(--paper);
      margin-bottom: 4px;
    `;
    eventTerminal.appendChild(title);
    
    const outcome = document.createElement("div");
    outcome.className = "event-outcome";
    outcome.textContent = event.outcomeText || "";
    outcome.style.cssText = `
      font-weight: 400;
      font-size: 14px;
      color: var(--paper);
      margin-bottom: 12px;
      line-height: 1.4;
    `;
    eventTerminal.appendChild(outcome);
    
    // Continue button
    const continueBtn = document.createElement("button");
    continueBtn.className = "event-continue-btn";
    continueBtn.textContent = "Continue";
    continueBtn.style.cssText = `
      font-family: 'Inter', sans-serif;
      font-weight: 700;
      font-size: 14px;
      padding: 10px 24px;
      background: var(--paper);
      color: var(--ink);
      border: 2px solid var(--paper);
      border-radius: 6px;
      cursor: pointer;
      align-self: flex-start;
      transition: background 0.1s, color 0.1s;
    `;
    
    continueBtn.addEventListener("mouseenter", () => {
      continueBtn.style.background = "transparent";
      continueBtn.style.color = "var(--paper)";
    });
    
    continueBtn.addEventListener("mouseleave", () => {
      continueBtn.style.background = "var(--paper)";
      continueBtn.style.color = "var(--ink)";
    });
    
    continueBtn.addEventListener("click", () => {
      // Check for custom continue handler
      if (event.onContinue) {
        event.onContinue();
      } else {
        // Default: just end event
        endEvent();
      }
    });
    
    eventTerminal.appendChild(continueBtn);
  }
}

/**
 * Restore normal header view (called when event ends)
 */
function restoreNormalHeader() {
  const header = document.getElementById("viewport-header");
  if (!header) return;
  
  // Show normal header content
  const headerLeft = header.querySelector(".header-left");
  const headerCenter = header.querySelector(".header-center");
  const headerRight = header.querySelector(".header-right");
  
  if (headerLeft) headerLeft.style.display = "flex";
  if (headerCenter) headerCenter.style.display = "flex";
  if (headerRight) headerRight.style.display = "block";
  
  // Hide event terminal
  const eventTerminal = header.querySelector(".event-terminal");
  if (eventTerminal) {
    eventTerminal.style.display = "none";
  }
}

function renderNav() {
  el.navButtons.forEach((btn) => {
    const tab = /** @type {Tab} */ (btn.getAttribute("data-tab"));
    btn.classList.toggle("is-active", tab === gameState.meta.tab);
  });
}

function renderStats() {
  const life = clampPct(gameState.stats.lifeSupport);
  const shipIntegrity = clampPct(gameState.stats.shipIntegrity);

  // Calculate days remaining for life support (depletes at 3.333% per day, 30 days total)
  const lifeSupportDays = Math.floor(gameState.stats.lifeSupport / (100 / 30));
  if (el.lifePct) el.lifePct.textContent = String(lifeSupportDays);
  if (el.hullPct) el.hullPct.textContent = String(shipIntegrity);

  renderSegmentBar(el.lifeBar, life);
  renderSegmentBar(el.hullBar, shipIntegrity);
  
  // Disable travel buttons when event is active
  if (el.actionTravel) {
    el.actionTravel.disabled = gameState.travel.isEventActive;
    if (gameState.travel.isEventActive) {
      el.actionTravel.style.opacity = "0.5";
      el.actionTravel.style.cursor = "not-allowed";
    } else {
      el.actionTravel.style.opacity = "1";
      el.actionTravel.style.cursor = "pointer";
    }
  }
  
  if (el.actionWait) {
    el.actionWait.disabled = gameState.travel.isEventActive;
    if (gameState.travel.isEventActive) {
      el.actionWait.style.opacity = "0.5";
      el.actionWait.style.cursor = "not-allowed";
    } else {
      el.actionWait.style.opacity = "1";
      el.actionWait.style.cursor = "pointer";
    }
  }
  
  if (el.actionScan) {
    el.actionScan.disabled = gameState.travel.isEventActive;
    if (gameState.travel.isEventActive) {
      el.actionScan.style.opacity = "0.5";
      el.actionScan.style.cursor = "not-allowed";
    } else {
      el.actionScan.style.opacity = "1";
      el.actionScan.style.cursor = "pointer";
    }
  }
}

/**
 * Start continuous animation loop for smooth pulsing animations
 */
function startAnimationLoop() {
  // Stop existing loop if any
  if (gameState.travel.animationLoopId !== null) {
    cancelAnimationFrame(gameState.travel.animationLoopId);
    gameState.travel.animationLoopId = null;
  }
  
  // Only start loop if on TRAVEL tab and MAP view (not in scenes)
  if (gameState.meta.tab === "TRAVEL" && gameState.travel.currentSceneId === "MAP") {
    function animate() {
      // Double-check we're still on MAP view before rendering
      if (gameState.meta.tab === "TRAVEL" && gameState.travel.currentSceneId === "MAP") {
        // Only call drawMap in the animation loop - don't call render() here
        // render() is called separately and will start/stop the loop as needed
        drawMap();
        gameState.travel.animationLoopId = requestAnimationFrame(animate);
      } else {
        // Stop loop if we're no longer on MAP view
        gameState.travel.animationLoopId = null;
      }
    }
    gameState.travel.animationLoopId = requestAnimationFrame(animate);
  }
}

/**
 * Stop continuous animation loop
 */
function stopAnimationLoop() {
  if (gameState.travel.animationLoopId !== null) {
    cancelAnimationFrame(gameState.travel.animationLoopId);
    gameState.travel.animationLoopId = null;
  }
}

/**
 * Get supply image path for a supply ID.
 * Delegates to the centralized asset manifest.
 * @param {string} supplyId
 * @returns {string|null}
 */
function getSupplyImagePath(supplyId) {
  return supplyImage(supplyId);
}

/**
 * Show supply image in preview window
 * @param {string} supplyId Supply ID to show
 */
function showSupplyPreview(supplyId) {
  if (!el.previewFrame) return;
  
  const imagePath = getSupplyImagePath(supplyId);
  
  // Check if image already exists in the frame
  let previewImg = el.previewFrame.querySelector("img");
  if (!previewImg) {
    // Create image element
    previewImg = document.createElement("img");
    previewImg.style.width = "100%";
    previewImg.style.height = "100%";
    previewImg.style.objectFit = "cover";
    previewImg.style.borderRadius = "10px";
    el.previewFrame.appendChild(previewImg);
  }
  
  // Hide placeholder
  if (el.previewPlaceholder) {
    el.previewPlaceholder.style.display = "none";
  }
  
  if (imagePath) {
    // Set up error handler for missing images
    previewImg.onerror = () => {
      // Image failed to load - show placeholder
      if (el.previewPlaceholder) {
        el.previewPlaceholder.style.display = "flex";
        el.previewPlaceholder.textContent = "NO IMAGE";
      }
      previewImg.style.display = "none";
    };
    
    previewImg.onload = () => {
      // Image loaded successfully
      previewImg.style.display = "block";
      if (el.previewPlaceholder) {
        el.previewPlaceholder.style.display = "none";
      }
    };
    
    // Update image source
    previewImg.src = imagePath;
    const supplyDef = SUPPLY_DEFS[supplyId];
    previewImg.alt = supplyDef ? `Preview: ${supplyDef.name}` : `Preview: ${supplyId}`;
    previewImg.style.display = "block";
  } else {
    // No image available - show placeholder
    if (el.previewPlaceholder) {
      el.previewPlaceholder.style.display = "flex";
      el.previewPlaceholder.textContent = "NO IMAGE";
    }
    previewImg.style.display = "none";
  }
}

/**
 * Restore normal preview (location preview)
 * Only restores if on TRAVEL tab, otherwise clears preview
 */
function restoreNormalPreview() {
  // Only show location preview if we're on the TRAVEL tab
  if (gameState.meta.tab === "TRAVEL") {
    renderPreview();
  } else {
    // On other tabs (like INVENTORY), just clear the preview
    if (!el.previewFrame) return;
    const previewImg = el.previewFrame.querySelector("img");
    if (previewImg) {
      previewImg.style.display = "none";
    }
    if (el.previewPlaceholder) {
      el.previewPlaceholder.style.display = "flex";
      el.previewPlaceholder.textContent = "PREVIEW";
    }
  }
}

/**
 * Render preview image in the HUD preview window
 * Shows the selected location's preview image, or clears it if nothing is selected
 */
function renderPreview() {
  if (!el.previewFrame) return;
  
  // Determine which location to show in preview
  // Priority: current location (if in scene) > selected location > selected destination > current location (if on MAP)
  let previewNode = null;
  let previewLocationId = null;
  
  // If we're in a scene (not on MAP), always use current location for preview
  if (gameState.travel.currentSceneId !== "MAP" && gameState.travel.currentLocationId) {
    previewNode = mapNodes.find(n => n.id === gameState.travel.currentLocationId);
    previewLocationId = gameState.travel.currentLocationId;
  } else if (gameState.travel.selectedLocationId) {
    previewNode = mapNodes.find(n => n.id === gameState.travel.selectedLocationId);
    previewLocationId = gameState.travel.selectedLocationId;
  } else if (gameState.travel.selectedDestinationId && gameState.travel.currentSceneId === "MAP") {
    previewNode = mapNodes.find(n => n.id === gameState.travel.selectedDestinationId);
    previewLocationId = gameState.travel.selectedDestinationId;
  } else if (gameState.travel.currentLocationId) {
    previewNode = mapNodes.find(n => n.id === gameState.travel.currentLocationId);
    previewLocationId = gameState.travel.currentLocationId;
  }
  
  // Clear preview if no node to display
  if (!previewNode) {
    // Hide any existing image and show placeholder
    const existingImg = el.previewFrame.querySelector("img");
    if (existingImg) {
      existingImg.remove();
    }
    if (el.previewPlaceholder) {
      el.previewPlaceholder.style.display = "flex";
    }
    return;
  }
  
  // Get preview image path
  // Special handling for stations: use outpost-0 image as fallback
  let imagePath;
  if (previewNode.type === "station") {
    imagePath = getPreviewImagePath("outpost-0", "outpost");
  } else {
    // Pass the previewLocationId and current scene state to getPreviewImagePath
    // This allows it to check if we're actually landed (in ARRIVAL scene)
    imagePath = getPreviewImagePath(previewLocationId, previewNode.type);
  }
  
  // Check if image already exists in the frame
  let previewImg = el.previewFrame.querySelector("img");
  if (!previewImg) {
    // Create image element
    previewImg = document.createElement("img");
    previewImg.style.width = "100%";
    previewImg.style.height = "100%";
    previewImg.style.objectFit = "cover";
    previewImg.style.borderRadius = "10px";
    el.previewFrame.appendChild(previewImg);
  }
  
  // Hide placeholder
  if (el.previewPlaceholder) {
    el.previewPlaceholder.style.display = "none";
  }
  
  // Set up error handler for missing images
  previewImg.onerror = () => {
    // Image failed to load - show placeholder
    if (el.previewPlaceholder) {
      el.previewPlaceholder.style.display = "flex";
    }
    previewImg.style.display = "none";
  };
  
  previewImg.onload = () => {
    // Image loaded successfully
    previewImg.style.display = "block";
    if (el.previewPlaceholder) {
      el.previewPlaceholder.style.display = "none";
    }
  };
  
  // For asteroids, add cache-busting based on scene state to force image reload
  let imagePathToUse = imagePath;
  if (previewNode.type === "asteroid") {
    // Add cache buster based on whether we're on MAP or in a scene
    const isOnMap = gameState.travel.currentSceneId === "MAP";
    imagePathToUse = imagePath + (isOnMap ? "?scene=map" : "?scene=landed");
  }
  
  // Always update the image src - this ensures the preview reflects current state
  previewImg.src = imagePathToUse;
  previewImg.alt = `Preview: ${previewNode.name}`;
}

/**
 * Get base location ID by stripping instance suffix (-a, -b, -c, -d)
 * @param {string} id Location ID (may include instance suffix)
 * @returns {string} Base location ID without instance suffix
 * @example getBaseLocationId("station-01-a") => "station-01"
 * @example getBaseLocationId("outpost-1-c") => "outpost-1"
 * @example getBaseLocationId("station-01") => "station-01"
 */
function getBaseLocationId(id) {
  if (!id) return id;
  // Strip instance suffix: -a, -b, -c, or -d
  return id.replace(/-[a-d]$/, "");
}

/**
 * Find location scene data, handling instances (e.g., "outpost-0-a" -> try "outpost-0-a", then "outpost-0", then base type)
 * @param {string} locationId Location ID
 * @returns {Location|null} Location data or null
 */
function findLocationData(locationId) {
  // Try exact match first
  if (LOCATIONS[locationId]) {
    return LOCATIONS[locationId];
  }
  
  // Try base location (e.g., "outpost-0-a" -> "outpost-0")
  const baseId = getBaseLocationId(locationId);
  if (LOCATIONS[baseId]) {
    return LOCATIONS[baseId];
  }
  
  // Try finding by node type
  const node = mapNodes.find(n => n.id === locationId);
  if (node) {
    // For outposts, use base ID (e.g., "outpost-0-a" -> "outpost-0")
    if (node.type === "outpost") {
      const baseId = getBaseLocationId(locationId);
      if (LOCATIONS[baseId]) {
        return LOCATIONS[baseId];
      }
      // Fallback to outpost-0 if specific outpost not found
      return LOCATIONS["outpost-0"];
    }
    // For stations, try to find station definition by base ID
    if (node.type === "station") {
      const baseId = getBaseLocationId(locationId);
      if (LOCATIONS[baseId]) {
        return LOCATIONS[baseId];
      }
      // Fallback: try station-01, station-02, station-03 in order
      for (const stationId of ["station-01", "station-02", "station-03"]) {
        if (LOCATIONS[stationId]) {
          return LOCATIONS[stationId];
        }
      }
    }
    // For asteroids, use asteroid-0 as template
    if (node.type === "asteroid") {
      return LOCATIONS["asteroid-0"];
    }
    // For ships, use ship-0 as template if it exists, otherwise return null
    if (node.type === "ship") {
      return LOCATIONS["ship-0"] || null;
    }
    if (node.type === "earth" || node.type === "moon" || node.type === "mars") {
      return LOCATIONS[node.type] || null;
    }
  }
  
  return null;
}

/**
 * Get trader inventory (fixed 6-item set: 2 life support, 2 medical, 2 repair parts)
 * @returns {Array} Array of item objects with id, name, price, category, traderPrice
 */
function getTraderInventory() {
  // Fixed 6-item set
  const traderItems = [
    // 2 life support supplies (small/medium)
    { id: "air_canister_s", category: "supply" },
    { id: "air_canister_m", category: "supply" },
    // 2 medical supplies (common)
    { id: "med_gel", category: "supply" },
    { id: "nutrient_rations", category: "supply" },
    // 2 repair parts (outpost-tier / universal)
    { id: "repair_welding_kit", category: "part" },
    { id: "repair_emergency_kit", category: "part" }
  ];
  
  // Build item list with trader pricing (basePrice × 1.35, rounded)
  return traderItems.map(item => {
    let def, name, basePrice;
    
    if (item.category === "supply") {
      def = SUPPLY_DEFS[item.id];
      if (!def) return null;
      name = def.name;
      basePrice = def.basePrice;
    } else {
      def = SHIP_PART_DEFS[item.id];
      if (!def) return null;
      name = def.name;
      basePrice = def.basePrice;
    }
    
    const traderMarkup = 1.35 - getCrewBonus("tradeDiscount");
    const traderPrice = Math.round(basePrice * traderMarkup);
    
    return {
      id: item.id,
      name: name,
      price: traderPrice,
      basePrice: basePrice,
      category: item.category
    };
  }).filter(item => item !== null);
}

/**
 * Get available items for a general store based on location type
 * @param {string} locationType Location type ("outpost" or "station")
 * @returns {Array<{id: string, name: string, price: number, kind: "supply"|"part"}>} Array of available items
 */
function getAvailableStoreItems(locationType) {
  const items = [];
  
  // Determine shop tier
  const shopTier = locationType === "outpost" ? "OUTPOST" : "STATION";
  
  // Add supplies where tier matches
  Object.values(SUPPLY_DEFS).forEach(supply => {
    if (supply.tier === shopTier || supply.tier === "BOTH") {
      items.push({
        id: supply.id,
        name: supply.name,
        price: supply.basePrice,
        kind: "supply"
      });
    }
  });
  
  // Add parts where shopTier matches
  Object.values(SHIP_PART_DEFS).forEach(part => {
    if (part.shopTier === shopTier || part.shopTier === "BOTH") {
      items.push({
        id: part.id,
        name: part.name,
        price: part.basePrice,
        kind: "part"
      });
    }
  });
  
  // Sort by name for consistent display
  items.sort((a, b) => a.name.localeCompare(b.name));
  
  return items;
}

/**
 * Calculate cart total
 * @returns {number} Total cost of all items in cart
 */
function calculateCartTotal() {
  let total = 0;
  const cart = gameState.travel.generalStoreCart || {};
  
  // Check supplies
  Object.entries(cart).forEach(([itemId, quantity]) => {
    if (quantity > 0) {
      const supplyDef = SUPPLY_DEFS[itemId];
      if (supplyDef) {
        total += supplyDef.basePrice * quantity;
      } else {
        const partDef = SHIP_PART_DEFS[itemId];
        if (partDef) {
          total += partDef.basePrice * quantity;
        }
      }
    }
  });
  
  return total;
}

/**
 * Add items to inventory (centralized function for all purchase paths)
 * Creates inventory entries if they don't exist
 * @param {string} itemId Item ID (supply or part)
 * @param {number} quantity Quantity to add
 * @param {string} itemType Type of item: "supply" or "part"
 * @returns {boolean} True if successfully added, false otherwise
 */
function addItemToInventory(itemId, quantity, itemType) {
  if (!itemId || quantity <= 0) {
    console.warn(`[INVENTORY] Invalid addItemToInventory call: itemId=${itemId}, quantity=${quantity}`);
    return false;
  }
  
  if (itemType === "supply") {
    // Initialize supply entry if it doesn't exist
    if (!gameState.inventory.supplies[itemId]) {
      gameState.inventory.supplies[itemId] = { id: itemId, qty: 0 };
    }
    gameState.inventory.supplies[itemId].qty += quantity;
    debugLog(`[INVENTORY] Added ${quantity}x ${itemId} to supplies (total: ${gameState.inventory.supplies[itemId].qty})`);
    return true;
  } else if (itemType === "part") {
    // Initialize part entry if it doesn't exist
    if (!gameState.inventory.parts[itemId]) {
      gameState.inventory.parts[itemId] = 0;
    }
    gameState.inventory.parts[itemId] += quantity;
    debugLog(`[INVENTORY] Added ${quantity}x ${itemId} to parts (total: ${gameState.inventory.parts[itemId]})`);
    return true;
  } else {
    console.warn(`[INVENTORY] Unknown itemType: ${itemType}`);
    return false;
  }
}

/**
 * Handle checkout for general store BUY mode
 * @param {string} locationId Location ID
 * @param {Location} location Location definition
 */
function handleCheckout(locationId, location) {
  const cart = gameState.travel.generalStoreCart || {};
  
  // 1. Validate
  const cartTotal = calculateCartTotal();
  const availableCredits = gameState.stats.credits || 0;
  
  // Check if cart has items
  const hasItems = Object.values(cart).some(qty => qty > 0);
  if (!hasItems) {
    debugLog("[CHECKOUT] Cart is empty");
    return;
  }
  
  // Check if player can afford
  if (cartTotal > availableCredits) {
    console.warn(`[CHECKOUT] Insufficient credits. Need ${cartTotal}, have ${availableCredits}`);
    // Show feedback in terminal (could be enhanced with UI message)
    return;
  }
  
  // Validate all cart quantities are valid
  const locationType = location?.type || "outpost";
  const availableItems = getAvailableStoreItems(locationType);
  const availableItemIds = new Set(availableItems.map(item => item.id));
  
  for (const [itemId, quantity] of Object.entries(cart)) {
    if (quantity <= 0) continue;
    
    // Check if item exists and is available
    if (!availableItemIds.has(itemId)) {
      console.error(`[CHECKOUT] Invalid item in cart: ${itemId}`);
      return; // Fail checkout - invalid item
    }
    
    // Validate quantity is a positive integer
    if (!Number.isInteger(quantity) || quantity < 1) {
      console.error(`[CHECKOUT] Invalid quantity for ${itemId}: ${quantity}`);
      return; // Fail checkout - invalid quantity
    }
  }
  
  // 2. Commit (all validation passed)
  // Deduct credits
  gameState.stats.credits -= cartTotal;
  
  // Add items to inventory
  for (const [itemId, quantity] of Object.entries(cart)) {
    if (quantity <= 0) continue;
    
    // Determine item type
    const supplyDef = SUPPLY_DEFS[itemId];
    const partDef = SHIP_PART_DEFS[itemId];
    
    if (supplyDef) {
      addItemToInventory(itemId, quantity, "supply");
    } else if (partDef) {
      addItemToInventory(itemId, quantity, "part");
    } else {
      console.warn(`[CHECKOUT] Unknown item type for ${itemId}`);
    }
  }
  
  // Clear cart
  gameState.travel.generalStoreCart = {};
  gameState.travel.generalStoreCartTotal = 0;
  
  // 3. Feedback
  debugLog(`[CHECKOUT] Purchase complete. Total: ${cartTotal} credits`);
  
  // Re-render to update UI (stays in BUY mode)
  renderGeneralStore(locationId, location);
  render(); // Update stats display (credits)
}

/**
 * Render general store interface for outposts
 * @param {string} locationId Location ID (e.g., "outpost-0-a")
 * @param {Location} location Location definition
 */
function renderGeneralStore(locationId, location) {
  debugLog("[GENERAL STORE] renderGeneralStore called with locationId:", locationId, "location.type:", location?.type);
  if (!el.sceneContainer) {
    console.error("[GENERAL STORE] sceneContainer not found!");
    return;
  }
  
  // Get the outpost node to get the actual name
  const node = mapNodes.find(n => n.id === locationId);
  const outpostName = node?.name || location.name || "OUTPOST";
  debugLog("[GENERAL STORE] Rendering for:", outpostName);
  
  // Return scene should already be stored when navigating to merchant
  // (set in NAVIGATE handler, SHOP_BUY/SHOP_SELL handlers, or landAtCurrentLocation)
  // This is just a safety check - return scene should be set before renderGeneralStore is called
  if (gameState.travel.returnSceneId === null) {
    // Fallback: infer from current scene (shouldn't happen, but safe)
    const currentScene = gameState.travel.currentSceneId;
    if (currentScene === "GENERAL_STORE_ROOM") {
      gameState.travel.returnSceneId = "GENERAL_STORE_ROOM";
    } else if (currentScene === "INTERIOR_MARKET" && location?.type === "outpost") {
      gameState.travel.returnSceneId = "OUTPOST_INTERIOR";
    } else if (currentScene === "INTERIOR_MARKET") {
      gameState.travel.returnSceneId = "EXTERIOR";
    } else if (currentScene === "MERCHANT") {
      gameState.travel.returnSceneId = "MAP";
    } else {
      gameState.travel.returnSceneId = "MAP";
    }
    console.warn("[GENERAL STORE] Return scene was not set, inferred:", gameState.travel.returnSceneId);
  }
  
  // Initialize cart if first time entering store
  if (gameState.travel.generalStoreCart === undefined) {
    gameState.travel.generalStoreCart = {};
    gameState.travel.generalStoreCartTotal = 0;
  }
  
  // Hide scene elements and show overlay layer for merchant UI
  hideSceneElements();
  if (!showOverlayLayer()) {
    return; // showOverlayLayer already logged the error
  }
  
  // Show scene container (overlay layer is inside it)
  el.sceneContainer.hidden = false;
  el.sceneContainer.removeAttribute("hidden");
  el.sceneContainer.style.display = "flex";
  el.sceneContainer.style.visibility = "visible";
  
  // Hide canvas
  if (el.canvas) {
    el.canvas.hidden = true;
    el.canvas.style.display = "none";
  }
  
  // Create general store container
  const storeContainer = document.createElement("div");
  storeContainer.className = "merchant-container";
  storeContainer.style.cssText = `
    width: 100%;
    height: 100%;
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: flex-start;
    border: 2px solid #ffffff;
    border-radius: 12px;
    padding: 30px;
    box-sizing: border-box;
  `;
  
  // Header: GENERAL STORE label
  const headerEl = document.createElement("div");
  headerEl.className = "merchant-header";
  headerEl.textContent = "GENERAL STORE";
  headerEl.style.cssText = `
    font-family: 'Inter', sans-serif;
    font-weight: 900;
    font-size: 24px;
    color: #ffffff;
    text-align: center;
    margin-bottom: 20px;
    letter-spacing: 2px;
  `;
  storeContainer.appendChild(headerEl);
  
  // Navigation buttons: BUY | SELL | LEAVE
  const navContainer = document.createElement("div");
  navContainer.className = "merchant-tabs";
  navContainer.style.cssText = `
    display: flex;
    align-items: center;
    justify-content: center;
    gap: 0;
    margin-bottom: 30px;
  `;
  
  // Get current mode (initialize if needed)
  const currentMode = gameState.travel.generalStoreMode || null;
  
  // Buy button
  const buyButton = document.createElement("button");
  buyButton.textContent = "BUY";
  buyButton.className = "merchant-tab";
  const isBuyActive = currentMode === "buy";
  if (isBuyActive) buyButton.classList.add("is-active");
  buyButton.style.cssText = `
    font-family: 'Inter', sans-serif;
    font-weight: 900;
    font-size: 18px;
    padding: 12px 24px;
    background: ${isBuyActive ? "#ffffff" : "transparent"};
    color: ${isBuyActive ? "#000000" : "#ffffff"};
    border: 2px solid #ffffff;
    border-right: none;
    border-radius: 6px 0 0 6px;
    cursor: pointer;
    transition: background 0.1s, color 0.1s;
  `;
  buyButton.addEventListener("click", () => {
    debugLog("[GENERAL STORE] BUY button clicked, currentMode:", currentMode);
    // Toggle buy mode: if already active, deactivate; otherwise activate and deactivate sell
    gameState.travel.generalStoreMode = currentMode === "buy" ? null : "buy";
    debugLog("[GENERAL STORE] New mode:", gameState.travel.generalStoreMode);
    // Re-render the general store to show the updated UI
    renderGeneralStore(locationId, location);
  });
  navContainer.appendChild(buyButton);
  
  // Vertical separator
  const separator1 = document.createElement("div");
  separator1.style.cssText = `
    width: 2px;
    height: 40px;
    background: #ffffff;
  `;
  navContainer.appendChild(separator1);
  
  // Sell button
  const sellButton = document.createElement("button");
  sellButton.textContent = "SELL";
  sellButton.className = "merchant-tab";
  const isSellActive = currentMode === "sell";
  if (isSellActive) sellButton.classList.add("is-active");
  sellButton.style.cssText = `
    font-family: 'Inter', sans-serif;
    font-weight: 900;
    font-size: 18px;
    padding: 12px 24px;
    background: ${isSellActive ? "#ffffff" : "transparent"};
    color: ${isSellActive ? "#000000" : "#ffffff"};
    border: 2px solid #ffffff;
    border-right: none;
    border-left: none;
    border-radius: 0;
    cursor: pointer;
    transition: background 0.1s, color 0.1s;
  `;
  sellButton.addEventListener("click", () => {
    debugLog("[GENERAL STORE] SELL button clicked, currentMode:", currentMode);
    // Toggle sell mode: if already active, deactivate; otherwise activate and deactivate buy
    const newMode = currentMode === "sell" ? null : "sell";
    gameState.travel.generalStoreMode = newMode;
    debugLog("[GENERAL STORE] New mode:", gameState.travel.generalStoreMode);
    // Initialize sell selection when entering SELL mode
    if (newMode === "sell") {
      gameState.travel.generalStoreSellSelected = {};
      gameState.travel.generalStoreSellPayout = 0;
    }
    // Re-render the general store to show the updated UI
    renderGeneralStore(locationId, location);
  });
  navContainer.appendChild(sellButton);
  
  // Vertical separator
  const separator2 = document.createElement("div");
  separator2.style.cssText = `
    width: 2px;
    height: 40px;
    background: #ffffff;
  `;
  navContainer.appendChild(separator2);
  
  // Leave button
  const leaveButton = document.createElement("button");
  leaveButton.textContent = "LEAVE";
  leaveButton.className = "merchant-tab";
  leaveButton.style.cssText = `
    font-family: 'Inter', sans-serif;
    font-weight: 900;
    font-size: 18px;
    padding: 12px 24px;
    background: transparent;
    color: #ffffff;
    border: 2px solid #ffffff;
    border-left: none;
    border-radius: 0 6px 6px 0;
    cursor: pointer;
    transition: background 0.1s, color 0.1s;
  `;
  leaveButton.addEventListener("click", () => {
    // Finalize landing summary before leaving
    logFinalizeLandingSummary();
    // Clear cart, sell selection, and mode
    gameState.travel.generalStoreCart = {};
    gameState.travel.generalStoreCartTotal = 0;
    gameState.travel.generalStoreSellSelected = {};
    gameState.travel.generalStoreSellPayout = 0;
    gameState.travel.generalStoreMode = null;
    closeAllOverlays();
    
    // Return to stored parent scene if present, otherwise fall back
    if (gameState.travel.returnSceneId) {
      gameState.travel.currentSceneId = gameState.travel.returnSceneId;
      gameState.travel.returnSceneId = null;
    } else {
      const node = mapNodes.find(n => n.id === locationId);
      const locationType = node?.type || location?.type;
      gameState.travel.currentSceneId = locationType === "outpost"
        ? "OUTPOST_INTERIOR"
        : "GENERAL_STORE_ROOM";
    }
    
    render();
  });
  navContainer.appendChild(leaveButton);
  
  storeContainer.appendChild(navContainer);
  
  // Content area - BUY grid or placeholder
  const contentArea = document.createElement("div");
  contentArea.className = "merchant-content-area";
  contentArea.style.cssText = `
    width: 100%;
    flex: 1;
    overflow: visible;
    min-height: 0;
  `;
  
  if (currentMode === "buy") {
    // Render BUY grid
    const locationType = location?.type || "outpost";
    const availableItems = getAvailableStoreItems(locationType);
    
    // Calculate cart total and check budget
    const cartTotal = calculateCartTotal();
    gameState.travel.generalStoreCartTotal = cartTotal;
    const availableCredits = gameState.stats.credits || 0;
    const isOverBudget = cartTotal > availableCredits;
    
    // Create 3-column grid that wraps to new rows
    const gridContainer = document.createElement("div");
    gridContainer.className = "merchant-grid";
    gridContainer.style.cssText = `
      display: grid;
      grid-template-columns: repeat(3, 1fr);
      grid-auto-flow: row;
      gap: 12px;
      padding: 10px;
    `;
    
    // Render each item as a row
    availableItems.forEach(item => {
      const row = document.createElement("div");
      row.className = "buy-item-row";
      row.dataset.itemId = item.id;
      row.style.cssText = `
        display: flex;
        align-items: center;
        gap: 12px;
        cursor: pointer;
        padding: 4px;
        border-radius: 4px;
        transition: background 0.1s;
      `;
      
      // Counter box (left)
      const qtyBox = document.createElement("div");
      qtyBox.className = "qty-box";
      const cartQty = gameState.travel.generalStoreCart[item.id] || 0;
      const qtyDisplay = String(cartQty).padStart(2, "0");
      
      if (isOverBudget && cartQty > 0) {
        qtyBox.classList.add("is-overbudget");
      }
      
      qtyBox.textContent = qtyDisplay;
      qtyBox.dataset.itemId = item.id;
      qtyBox.style.cssText = `
        font-family: 'Inter', sans-serif;
        font-weight: 700;
        font-size: 14px;
        min-width: 32px;
        height: 32px;
        display: flex;
        align-items: center;
        justify-content: center;
        border: 2px solid #ffffff;
        border-radius: 6px;
        color: ${isOverBudget && cartQty > 0 ? "#ff4444" : "#ffffff"};
        background: transparent;
        cursor: text;
        user-select: none;
      `;
      
      // Item capsule (right)
      const itemCapsule = document.createElement("div");
      itemCapsule.className = "item-capsule";
      itemCapsule.style.cssText = `
        flex: 1;
        display: flex;
        align-items: center;
        gap: 12px;
        padding: 8px 12px;
        border: 2px solid #ffffff;
        border-radius: 20px;
        font-family: 'Inter', sans-serif;
      `;
      
      // Item name (left side of capsule)
      const itemName = document.createElement("span");
      itemName.textContent = item.name;
      itemName.style.cssText = `
        font-weight: 600;
        font-size: 14px;
        color: #ffffff;
        flex: 1;
      `;
      itemCapsule.appendChild(itemName);
      
      // Divider
      const divider = document.createElement("div");
      divider.className = "divider";
      divider.style.cssText = `
        width: 2px;
        height: 20px;
        background: #ffffff;
      `;
      itemCapsule.appendChild(divider);
      
      // Price (right side of capsule)
      const priceEl = document.createElement("span");
      priceEl.textContent = `${item.price}c`;
      priceEl.style.cssText = `
        font-weight: 700;
        font-size: 14px;
        color: #ffffff;
        min-width: 50px;
        text-align: right;
      `;
      itemCapsule.appendChild(priceEl);
      
      row.appendChild(qtyBox);
      row.appendChild(itemCapsule);
      gridContainer.appendChild(row);
    });
    
    contentArea.appendChild(gridContainer);
    
    // Add event delegation for clicks
    gridContainer.addEventListener("click", (e) => {
      const row = e.target.closest(".buy-item-row");
      if (!row) return;
      
      const itemId = row.dataset.itemId;
      if (!itemId) return;
      
      // Check if clicking directly on counter (for manual input)
      if (e.target.classList.contains("qty-box")) {
        // Start manual input mode
        const qtyBox = e.target;
        const currentQty = gameState.travel.generalStoreCart[itemId] || 0;
        
        const input = document.createElement("input");
        input.type = "number";
        input.min = "0";
        input.value = currentQty;
        input.className = "qty-input";
        input.style.cssText = `
          width: 32px;
          height: 32px;
          border: 2px solid #ffffff;
          border-radius: 6px;
          background: #000000;
          color: #ffffff;
          font-family: 'Inter', sans-serif;
          font-weight: 700;
          font-size: 14px;
          text-align: center;
          padding: 0;
          -moz-appearance: textfield;
        `;
        
        const commitValue = () => {
          let value = parseInt(input.value, 10);
          if (isNaN(value) || value < 0) value = 0;
          value = Math.floor(value);
          
          if (value === 0) {
            delete gameState.travel.generalStoreCart[itemId];
          } else {
            gameState.travel.generalStoreCart[itemId] = value;
          }
          
          render(); // Re-render to update display
        };
        
        input.addEventListener("blur", commitValue);
        input.addEventListener("keydown", (ke) => {
          if (ke.key === "Enter") {
            ke.preventDefault();
            commitValue();
          } else if (ke.key === "Escape") {
            ke.preventDefault();
            render(); // Cancel edit
          }
        });
        
        qtyBox.replaceWith(input);
        input.focus();
        input.select();
        return;
      }
      
      // Normal click: increment
      // Alt/Option click: clear
      if (e.altKey || e.metaKey) {
        // Clear (set to 0)
        delete gameState.travel.generalStoreCart[itemId];
      } else {
        // Increment
        const currentQty = gameState.travel.generalStoreCart[itemId] || 0;
        gameState.travel.generalStoreCart[itemId] = currentQty + 1;
      }
      
      render(); // Re-render to update display
    });
    
    // Credits display (similar to payout display in sell mode)
    const creditsDisplay = document.createElement("div");
    creditsDisplay.className = "merchant-credits-display";
    
    // Show cart total if there are items, otherwise show available credits
    const hasCartItems = Object.values(gameState.travel.generalStoreCart).some(qty => qty > 0);
    const canAfford = cartTotal <= availableCredits;
    
    if (hasCartItems) {
      // Show total cost and available credits
      creditsDisplay.textContent = `TOTAL: ${cartTotal}c | CREDITS: ${availableCredits}c`;
      // Change color if over budget
      creditsDisplay.style.color = canAfford ? "#ffffff" : "#ff4444";
    } else {
      // Show just available credits when cart is empty
      creditsDisplay.textContent = `CREDITS: ${availableCredits}c`;
      creditsDisplay.style.color = "#ffffff";
    }
    
    creditsDisplay.style.cssText = `
      font-family: 'Inter', sans-serif;
      font-weight: 900;
      font-size: 20px;
      color: ${hasCartItems && !canAfford ? "#ff4444" : "#ffffff"};
      text-align: center;
      margin-bottom: 20px;
      padding: 12px;
      border: 2px solid #ffffff;
      border-radius: 8px;
    `;
    contentArea.appendChild(creditsDisplay);
    
    // Add checkout button (only visible when cart has items and can afford)
    if (hasCartItems && canAfford) {
      const checkoutButton = document.createElement("button");
      checkoutButton.textContent = "CHECKOUT";
      checkoutButton.className = "merchant-checkout-button";
      
      checkoutButton.style.cssText = `
        width: 100%;
        padding: 16px;
        margin-top: 10px;
        font-family: 'Inter', sans-serif;
        font-weight: 700;
        font-size: 16px;
        border: 2px solid #ffffff;
        border-radius: 8px;
        background: #ffffff;
        color: #000000;
        cursor: pointer;
        transition: all 0.2s;
      `;
      
      checkoutButton.addEventListener("mouseenter", () => {
        checkoutButton.style.background = "#e0e0e0";
      });
      checkoutButton.addEventListener("mouseleave", () => {
        checkoutButton.style.background = "#ffffff";
      });
      
      checkoutButton.addEventListener("click", () => {
        handleCheckout(locationId, location);
      });
      
      contentArea.appendChild(checkoutButton);
    }
    
  } else if (currentMode === "sell") {
    // Render SELL artifacts grid
    const locationType = location?.type || "outpost";
    const artifacts = gameState.inventory.artifacts || [];
    
    // Initialize sell selection if needed
    if (gameState.travel.generalStoreSellSelected === undefined) {
      gameState.travel.generalStoreSellSelected = {};
      gameState.travel.generalStoreSellPayout = 0;
    }
    
    // Group artifacts by artifactId and count inventory
    const artifactGroups = {};
    artifacts.forEach(instance => {
      if (!artifactGroups[instance.artifactId]) {
        artifactGroups[instance.artifactId] = {
          artifactId: instance.artifactId,
          instances: [],
          count: 0
        };
      }
      artifactGroups[instance.artifactId].instances.push(instance);
      artifactGroups[instance.artifactId].count++;
    });
    
    // Calculate payout from selected artifacts
    let payoutTotal = 0;
    Object.keys(gameState.travel.generalStoreSellSelected).forEach(artifactId => {
      const selectedCount = gameState.travel.generalStoreSellSelected[artifactId] || 0;
      if (selectedCount > 0 && artifactGroups[artifactId]) {
        // Use first instance for price calculation (all instances of same type have same price)
        const firstInstance = artifactGroups[artifactId].instances[0];
        const price = getArtifactSellPrice(firstInstance, locationType);
        payoutTotal += price * selectedCount;
      }
    });
    gameState.travel.generalStoreSellPayout = payoutTotal;
    
    // Payout display (centered under header)
    const payoutDisplay = document.createElement("div");
    payoutDisplay.className = "merchant-payout-display";
    payoutDisplay.textContent = `PAYOUT: ${payoutTotal}c`;
    payoutDisplay.style.cssText = `
      font-family: 'Inter', sans-serif;
      font-weight: 900;
      font-size: 20px;
      color: #ffffff;
      text-align: center;
      margin-bottom: 20px;
      padding: 12px;
      border: 2px solid #ffffff;
      border-radius: 8px;
    `;
    contentArea.appendChild(payoutDisplay);
    
    if (artifacts.length === 0) {
      // No artifacts message
      const emptyMessage = document.createElement("div");
      emptyMessage.textContent = "No artifacts to sell";
      emptyMessage.style.cssText = `
        font-family: 'Inter', sans-serif;
        font-weight: 400;
        font-size: 16px;
        color: #ffffff;
        text-align: center;
        padding: 40px;
      `;
      contentArea.appendChild(emptyMessage);
    } else {
      // Create 3-column grid for artifacts
      const gridContainer = document.createElement("div");
      gridContainer.className = "merchant-grid";
      gridContainer.style.cssText = `
        display: grid;
        grid-template-columns: repeat(3, 1fr);
        grid-auto-flow: row;
        gap: 12px;
        padding: 10px;
        width: 100%;
      `;
      
      // Render each artifact type as a row (grouped by artifactId)
      Object.values(artifactGroups).forEach(group => {
        const artifactDef = ARTIFACT_CATALOG.find(a => a.id === group.artifactId);
        if (!artifactDef) return;
        
        // Use first instance for price (all same type have same price)
        const sellPrice = getArtifactSellPrice(group.instances[0], locationType);
        const selectedCount = gameState.travel.generalStoreSellSelected[group.artifactId] || 0;
        const remainingCount = group.count - selectedCount;
        
        const row = document.createElement("div");
        row.className = "sell-item-row";
        row.dataset.artifactId = group.artifactId;
        row.style.cssText = `
          display: flex;
          align-items: center;
          gap: 12px;
          cursor: pointer;
          padding: 8px;
          border: 1px solid #ffffff;
          border-radius: 6px;
          transition: background 0.1s;
          width: 100%;
          min-width: 0;
        `;
        
        // Counter box (left) - shows remaining inventory count
        const qtyBox = document.createElement("div");
        qtyBox.className = "qty-box";
        qtyBox.textContent = String(remainingCount).padStart(2, "0");
        qtyBox.dataset.artifactId = group.artifactId;
        qtyBox.style.cssText = `
          font-family: 'Inter', sans-serif;
          font-weight: 700;
          font-size: 14px;
          min-width: 40px;
          height: 32px;
          display: flex;
          align-items: center;
          justify-content: center;
          border: 1px solid #ffffff;
          border-radius: 4px;
          color: #ffffff;
          background: transparent;
          cursor: pointer;
          user-select: none;
          padding: 4px 8px;
          text-align: center;
        `;
        
        // Item capsule (right)
        const itemCapsule = document.createElement("div");
        itemCapsule.className = "item-capsule";
        itemCapsule.style.cssText = `
          flex: 1;
          display: flex;
          align-items: center;
          justify-content: space-between;
          padding: 8px 12px;
          border: 1px solid #ffffff;
          border-radius: 20px;
          font-family: 'Inter', sans-serif;
          min-width: 0;
          overflow: hidden;
        `;
        
        // Artifact name (left side of capsule)
        const itemName = document.createElement("span");
        itemName.textContent = artifactDef.name;
        itemName.style.cssText = `
          font-weight: 500;
          font-size: 14px;
          color: #ffffff;
          white-space: nowrap;
          overflow: hidden;
          text-overflow: ellipsis;
          flex: 1;
          min-width: 0;
        `;
        
        // Divider
        const divider = document.createElement("span");
        divider.className = "divider";
        divider.textContent = "|";
        divider.style.cssText = `
          margin: 0 8px;
          color: #ffffff;
          flex-shrink: 0;
        `;
        
        // Price (right side of capsule)
        const priceEl = document.createElement("span");
        priceEl.textContent = `${sellPrice}c`;
        priceEl.style.cssText = `
          font-weight: 700;
          font-size: 14px;
          color: #ffffff;
          white-space: nowrap;
          flex-shrink: 0;
        `;
        
        itemCapsule.appendChild(itemName);
        itemCapsule.appendChild(divider);
        itemCapsule.appendChild(priceEl);
        
        row.appendChild(qtyBox);
        row.appendChild(itemCapsule);
        gridContainer.appendChild(row);
      });
      
      contentArea.appendChild(gridContainer);
      
      // Add event delegation for clicks
      gridContainer.addEventListener("click", (e) => {
        const row = e.target.closest(".sell-item-row");
        if (!row) return;
        
        const artifactId = row.dataset.artifactId;
        if (!artifactId) return;
        
        // Recalculate current inventory count for this artifact type
        const currentInventoryCount = artifacts.filter(a => a.artifactId === artifactId).length;
        const selectedCount = gameState.travel.generalStoreSellSelected[artifactId] || 0;
        const remainingCount = currentInventoryCount - selectedCount;
        
        if (e.altKey || e.metaKey) {
          // Alt/Option-click: deselect one (if any selected)
          if (selectedCount > 0) {
            gameState.travel.generalStoreSellSelected[artifactId] = selectedCount - 1;
            if (gameState.travel.generalStoreSellSelected[artifactId] === 0) {
              delete gameState.travel.generalStoreSellSelected[artifactId];
            }
          }
        } else {
          // Normal click: select one more (if any remaining)
          if (remainingCount > 0) {
            gameState.travel.generalStoreSellSelected[artifactId] = (selectedCount || 0) + 1;
          }
        }
        
        render(); // Re-render to update display
      });
      
      // CONFIRM SALE button
      const confirmButton = document.createElement("button");
      confirmButton.textContent = "CONFIRM SALE";
      confirmButton.className = "merchant-confirm-button";
      const hasSelection = Object.keys(gameState.travel.generalStoreSellSelected).length > 0;
      confirmButton.disabled = !hasSelection;
      confirmButton.style.cssText = `
        font-family: 'Inter', sans-serif;
        font-weight: 900;
        font-size: 18px;
        padding: 14px 32px;
        margin: 20px auto 0;
        display: block;
        background: ${hasSelection ? "#ffffff" : "#666666"};
        color: ${hasSelection ? "#000000" : "#aaaaaa"};
        border: 2px solid #ffffff;
        border-radius: 8px;
        cursor: ${hasSelection ? "pointer" : "not-allowed"};
        transition: background 0.1s, color 0.1s;
      `;
      
      if (hasSelection) {
        confirmButton.addEventListener("click", () => {
          // Sell selected artifacts (count-based)
          // Use current artifacts array (not snapshot)
          const currentArtifacts = gameState.inventory.artifacts || [];
          
          Object.keys(gameState.travel.generalStoreSellSelected).forEach(artifactId => {
            const countToSell = gameState.travel.generalStoreSellSelected[artifactId] || 0;
            if (countToSell <= 0) return;
            
            // Get all instances of this artifact type from current inventory
            const instancesToSell = currentArtifacts
              .filter(a => a.artifactId === artifactId)
              .slice(0, countToSell); // Take first N instances
            
            // Sell each instance
            instancesToSell.forEach(instance => {
              sellArtifact(instance.instanceId, locationType);
            });
          });
          
          // Clear selection
          gameState.travel.generalStoreSellSelected = {};
          gameState.travel.generalStoreSellPayout = 0;
          
          // Re-render to update list (artifacts will be removed)
          render();
        });
      }
      
      contentArea.appendChild(confirmButton);
    }
  } else {
    // No mode selected
    const placeholder = document.createElement("div");
    placeholder.textContent = "Choose BUY or SELL";
    placeholder.style.cssText = `
      font-family: 'Inter', sans-serif;
      font-weight: 400;
      font-size: 16px;
      color: #ffffff;
      text-align: center;
      padding: 40px;
    `;
    contentArea.appendChild(placeholder);
  }
  
  storeContainer.appendChild(contentArea);
  
  // Append to overlay layer, not scene container directly (preserves scene-image and scene-hotspots)
  el.sceneOverlayLayer.appendChild(storeContainer);
}

/**
 * Render dockyard (ship hangar) UI overlay
 * @param {string} locationId Location ID
 */
function renderDockyard(locationId) {
  if (!el.sceneContainer) {
    console.error("[DOCKYARD] sceneContainer not found!");
    return;
  }
  
  // Default mode
  if (!gameState.travel.dockyardMode) {
    gameState.travel.dockyardMode = "repair";
  }
  
  // Hide scene elements and show overlay layer for dockyard UI
  hideSceneElements();
  if (!showOverlayLayer()) {
    return;
  }
  
  // Show scene container (overlay layer is inside it)
  el.sceneContainer.hidden = false;
  el.sceneContainer.removeAttribute("hidden");
  el.sceneContainer.style.display = "flex";
  el.sceneContainer.style.visibility = "visible";
  
  // Hide canvas
  if (el.canvas) {
    el.canvas.hidden = true;
    el.canvas.style.display = "none";
  }
  
  const dockyardContainer = document.createElement("div");
  dockyardContainer.className = "merchant-container";
  dockyardContainer.style.cssText = `
    width: 100%;
    height: 100%;
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: flex-start;
    border: 2px solid #ffffff;
    border-radius: 12px;
    padding: 30px;
    box-sizing: border-box;
  `;
  
  // Header
  const headerEl = document.createElement("div");
  headerEl.className = "merchant-header";
  headerEl.textContent = "SHIP HANGAR";
  dockyardContainer.appendChild(headerEl);
  
  // Tabs
  const tabs = document.createElement("div");
  tabs.className = "merchant-tabs";
  const tabsConfig = [
    { id: "repair", label: "REPAIR" },
    { id: "parts", label: "PARTS" },
    { id: "leave", label: "LEAVE" }
  ];
  tabsConfig.forEach((tab, index) => {
    const btn = document.createElement("button");
    btn.textContent = tab.label;
    btn.className = "merchant-tab";
    if (gameState.travel.dockyardMode === tab.id) {
      btn.classList.add("is-active");
    }
    btn.style.borderRadius = index === 0
      ? "6px 0 0 6px"
      : index === tabsConfig.length - 1
        ? "0 6px 6px 0"
        : "0";
    btn.style.borderLeft = index === 0 ? "2px solid var(--paper)" : "none";
    btn.addEventListener("click", () => {
      if (tab.id === "leave") {
        const returnScene = gameState.travel.returnSceneId || "HUB";
        closeAllOverlays();
        gameState.travel.returnSceneId = null;
        gameState.travel.currentSceneId = returnScene;
        render();
        return;
      }
      gameState.travel.dockyardMode = tab.id;
      renderDockyard(locationId);
    });
    tabs.appendChild(btn);
  });
  dockyardContainer.appendChild(tabs);
  
  // Info strip
  const infoStrip = document.createElement("div");
  infoStrip.className = "merchant-payout-display";
  const integrity = Math.round(gameState.stats.hull);
  const credits = gameState.stats.credits || 0;
  const selectedId = gameState.travel.dockyardSelectionId;
  const repairDiscount = getCrewBonus("repairDiscount");
  const priceWithRepairDiscount = (price) => Math.max(1, Math.round(price * (1 - repairDiscount)));
  const repairOptions = [
    { id: "patch", label: "Patch Hull", hull: 10, days: 1, cost: priceWithRepairDiscount(40) },
    { id: "weld", label: "Full Weld", hull: 25, days: 2, cost: priceWithRepairDiscount(90) },
    { id: "overhaul", label: "Overhaul", hull: 50, days: 3, cost: priceWithRepairDiscount(170) }
  ];
  const selected = repairOptions.find(opt => opt.id === selectedId);
  const partOptions = Object.values(SHIP_PART_DEFS).filter(part =>
    part.shopTier === "STATION" || part.shopTier === "BOTH"
  );
  const selectedPart = partOptions.find(part => part.id === selectedId);
  const timeCostText = selected ? `${selected.days}d` : selectedPart ? "0d" : "--";
  infoStrip.textContent = `SHIP INTEGRITY: ${integrity}%   CREDITS: ${credits}c   TIME COST: ${timeCostText}`;
  dockyardContainer.appendChild(infoStrip);
  
  const contentArea = document.createElement("div");
  contentArea.className = "merchant-content-area";
  
  const message = document.createElement("div");
  message.style.cssText = `
    font-family: 'Inter', sans-serif;
    font-weight: 600;
    font-size: 14px;
    color: #ff4444;
    margin-top: 10px;
    min-height: 18px;
  `;
  
  if (gameState.travel.dockyardMode === "repair") {
    const list = document.createElement("div");
    list.style.cssText = `
      width: 100%;
      display: flex;
      flex-direction: column;
      gap: 12px;
      margin-top: 10px;
    `;
    repairOptions.forEach(option => {
      const row = document.createElement("div");
      row.style.cssText = `
        display: flex;
        align-items: center;
        justify-content: space-between;
        padding: 16px 20px;
        border: 2px solid #ffffff;
        border-radius: 10px;
        cursor: pointer;
        background: ${selectedId === option.id ? "rgba(255,255,255,0.1)" : "transparent"};
      `;
      const left = document.createElement("div");
      left.textContent = option.label;
      left.style.cssText = "font-weight: 700; font-size: 16px; color: #ffffff;";
      const right = document.createElement("div");
      right.textContent = `+${option.hull}  ${option.days} day  ${option.cost}c`;
      right.style.cssText = "font-weight: 700; font-size: 14px; color: #ffffff;";
      row.appendChild(left);
      row.appendChild(right);
      row.addEventListener("click", () => {
        gameState.travel.dockyardSelectionId = option.id;
        renderDockyard(locationId);
      });
      list.appendChild(row);
    });
    contentArea.appendChild(list);
  } else {
    const list = document.createElement("div");
    list.style.cssText = `
      width: 100%;
      display: flex;
      flex-direction: column;
      gap: 12px;
      margin-top: 10px;
    `;
    partOptions.forEach(part => {
      const row = document.createElement("div");
      row.style.cssText = `
        display: flex;
        align-items: center;
        justify-content: space-between;
        padding: 16px 20px;
        border: 2px solid #ffffff;
        border-radius: 10px;
        cursor: pointer;
        background: ${selectedId === part.id ? "rgba(255,255,255,0.1)" : "transparent"};
      `;
      const owned = gameState.inventory.parts[part.id] || 0;
      const left = document.createElement("div");
      left.textContent = `${part.name} (owned ${owned})`;
      left.style.cssText = "font-weight: 700; font-size: 16px; color: #ffffff;";
      const right = document.createElement("div");
      const partPrice = priceWithRepairDiscount(part.basePrice);
      right.textContent = `${part.type === "UPGRADE" ? "Upgrade" : "+" + part.repairAmount}  ${partPrice}c`;
      right.style.cssText = "font-weight: 700; font-size: 14px; color: #ffffff;";
      row.appendChild(left);
      row.appendChild(right);
      row.addEventListener("click", () => {
        gameState.travel.dockyardSelectionId = part.id;
        renderDockyard(locationId);
      });
      list.appendChild(row);
    });
    contentArea.appendChild(list);
  }
  
  dockyardContainer.appendChild(contentArea);
  
  // Confirm button
  const confirm = document.createElement("button");
  confirm.textContent = gameState.travel.dockyardMode === "parts" ? "BUY PART / UPGRADE" : "CONFIRM REPAIR";
  confirm.className = "merchant-confirm-button";
  const canConfirm = gameState.travel.dockyardMode === "parts" ? !!selectedPart : !!selected;
  confirm.disabled = !canConfirm;
  confirm.style.opacity = canConfirm ? "1" : "0.5";
  confirm.style.cursor = canConfirm ? "pointer" : "not-allowed";
  confirm.addEventListener("click", () => {
    if (!canConfirm) return;
    if (selectedPart) {
      const selectedPartPrice = priceWithRepairDiscount(selectedPart.basePrice);
      if (credits < selectedPartPrice) {
        message.textContent = "Insufficient credits.";
        return;
      }
      gameState.stats.credits -= selectedPartPrice;
      gameState.inventory.parts[selectedPart.id] = (gameState.inventory.parts[selectedPart.id] || 0) + 1;
      logAdd("DOCKYARD", `Day ${gameState.stats.day}: Bought ${selectedPart.name}.`, { partId: selectedPart.id });
      gameState.travel.dockyardSelectionId = null;
      renderDockyard(locationId);
      render();
      return;
    }
    if (!selected) return;
    if (credits < selected.cost) {
      message.textContent = "Insufficient credits.";
      return;
    }
    gameState.stats.credits -= selected.cost;
    advanceDays(selected.days);
    addShipIntegrity(gameState, selected.hull);
    gameState.travel.dockyardSelectionId = null;
    renderDockyard(locationId);
    render();
  });
  
  dockyardContainer.appendChild(confirm);
  dockyardContainer.appendChild(message);
  
  el.sceneOverlayLayer.appendChild(dockyardContainer);
}

/**
 * Render outpost repair UI overlay
 * @param {string} locationId Location ID
 */
function renderOutpostDockyard(locationId) {
  if (!el.sceneContainer) {
    console.error("[OUTPOST DOCKYARD] sceneContainer not found!");
    return;
  }
  
  if (!gameState.travel.outpostDockyardMode) {
    gameState.travel.outpostDockyardMode = "repair";
  }
  
  hideSceneElements();
  if (!showOverlayLayer()) {
    return;
  }
  
  el.sceneContainer.hidden = false;
  el.sceneContainer.removeAttribute("hidden");
  el.sceneContainer.style.display = "flex";
  el.sceneContainer.style.visibility = "visible";
  
  if (el.canvas) {
    el.canvas.hidden = true;
    el.canvas.style.display = "none";
  }
  
  const dockyardContainer = document.createElement("div");
  dockyardContainer.className = "merchant-container";
  dockyardContainer.style.cssText = `
    width: 100%;
    height: 100%;
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: flex-start;
    border: 2px solid #ffffff;
    border-radius: 12px;
    padding: 30px;
    box-sizing: border-box;
  `;
  
  const headerEl = document.createElement("div");
  headerEl.className = "merchant-header";
  headerEl.textContent = "SHIP HANGAR";
  dockyardContainer.appendChild(headerEl);
  
  const tabs = document.createElement("div");
  tabs.className = "merchant-tabs";
  const tabsConfig = [
    { id: "repair", label: "REPAIR" },
    { id: "parts", label: "PARTS" },
    { id: "leave", label: "LEAVE" }
  ];
  tabsConfig.forEach((tab, index) => {
    const btn = document.createElement("button");
    btn.textContent = tab.label;
    btn.className = "merchant-tab";
    if (gameState.travel.outpostDockyardMode === tab.id) {
      btn.classList.add("is-active");
    }
    btn.style.borderRadius = index === 0
      ? "6px 0 0 6px"
      : index === tabsConfig.length - 1
        ? "0 6px 6px 0"
        : "0";
    btn.style.borderLeft = index === 0 ? "2px solid var(--paper)" : "none";
    btn.addEventListener("click", () => {
      if (tab.id === "leave") {
        closeAllOverlays();
        gameState.travel.currentSceneId = "OUTPOST_INTERIOR";
        render();
        return;
      }
      gameState.travel.outpostDockyardMode = tab.id;
      gameState.travel.outpostDockyardMessage = null;
      if (tab.id === "parts") {
        gameState.travel.outpostDockyardSelectionId = null;
      }
      renderOutpostDockyard(locationId);
    });
    tabs.appendChild(btn);
  });
  dockyardContainer.appendChild(tabs);
  
  const infoStrip = document.createElement("div");
  infoStrip.className = "merchant-payout-display";
  const integrity = Math.round(gameState.stats.hull);
  const credits = gameState.stats.credits || 0;
  const selectedId = gameState.travel.outpostDockyardSelectionId;
  const repairOptions = [
    { id: "patch", label: "Patch Hull", hull: 10, days: 1, cost: 50 },
    { id: "weld", label: "Full Weld", hull: 25, days: 2, cost: 120 }
  ];
  const selected = repairOptions.find(opt => opt.id === selectedId);
  const timeCostText = selected ? `${selected.days}d` : "--";
  infoStrip.textContent = gameState.travel.outpostDockyardMode === "repair"
    ? `SHIP INTEGRITY: ${integrity}%   CREDITS: ${credits}c   TIME COST: ${timeCostText}`
    : `SHIP INTEGRITY: ${integrity}%   CREDITS: ${credits}c`;
  dockyardContainer.appendChild(infoStrip);
  
  const contentArea = document.createElement("div");
  contentArea.className = "merchant-content-area";
  
  const message = document.createElement("div");
  message.style.cssText = `
    font-family: 'Inter', sans-serif;
    font-weight: 600;
    font-size: 14px;
    color: #ff4444;
    margin-top: 10px;
    min-height: 18px;
  `;
  message.textContent = gameState.travel.outpostDockyardMessage || "";
  
  const list = document.createElement("div");
  list.style.cssText = `
    width: 100%;
    display: flex;
    flex-direction: column;
    gap: 12px;
    margin-top: 10px;
  `;
  if (gameState.travel.outpostDockyardMode === "repair") {
    repairOptions.forEach(option => {
      const row = document.createElement("div");
      row.style.cssText = `
        display: flex;
        align-items: center;
        justify-content: space-between;
        padding: 16px 20px;
        border: 2px solid #ffffff;
        border-radius: 10px;
        cursor: pointer;
        background: ${selectedId === option.id ? "rgba(255,255,255,0.1)" : "transparent"};
      `;
      const left = document.createElement("div");
      left.textContent = option.label;
      left.style.cssText = "font-weight: 700; font-size: 16px; color: #ffffff;";
      const right = document.createElement("div");
      right.textContent = `+${option.hull}  ${option.days} day  ${option.cost}c`;
      right.style.cssText = "font-weight: 700; font-size: 14px; color: #ffffff;";
      row.appendChild(left);
      row.appendChild(right);
      row.addEventListener("click", () => {
        gameState.travel.outpostDockyardSelectionId = option.id;
        renderOutpostDockyard(locationId);
      });
      list.appendChild(row);
    });
    contentArea.appendChild(list);
    dockyardContainer.appendChild(contentArea);
    
    const confirm = document.createElement("button");
    confirm.textContent = "CONFIRM REPAIR";
    confirm.className = "merchant-confirm-button";
    confirm.disabled = !selected;
    confirm.style.opacity = selected ? "1" : "0.5";
    confirm.style.cursor = selected ? "pointer" : "not-allowed";
    confirm.addEventListener("click", () => {
      if (!selected) return;
      if (credits < selected.cost) {
        gameState.travel.outpostDockyardMessage = "Insufficient credits.";
        message.textContent = gameState.travel.outpostDockyardMessage;
        return;
      }
      gameState.stats.credits -= selected.cost;
      advanceDays(selected.days);
      addShipIntegrity(gameState, selected.hull);
      gameState.travel.outpostDockyardMessage = "Repair complete.";
      gameState.travel.outpostDockyardSelectionId = null;
      renderOutpostDockyard(locationId);
      render();
    });
    
    dockyardContainer.appendChild(confirm);
    dockyardContainer.appendChild(message);
  } else {
    const partOptions = Object.values(SHIP_PART_DEFS).filter(def =>
      def.type === "REPAIR" && (def.shopTier === "OUTPOST" || def.shopTier === "BOTH")
    );
    if (partOptions.length === 0) {
      const empty = document.createElement("div");
      empty.style.cssText = "color: #ffffff; font-weight: 600; padding: 20px;";
      empty.textContent = "No parts available right now.";
      list.appendChild(empty);
    } else {
      partOptions.forEach(part => {
        const row = document.createElement("div");
        row.style.cssText = `
          display: flex;
          align-items: center;
          justify-content: space-between;
          padding: 16px 20px;
          border: 2px solid #ffffff;
          border-radius: 10px;
          cursor: pointer;
          background: transparent;
        `;
        const left = document.createElement("div");
        left.textContent = part.name;
        left.style.cssText = "font-weight: 700; font-size: 16px; color: #ffffff;";
        const right = document.createElement("div");
        const repairText = part.repairAmount ? `+${part.repairAmount}` : "+0";
        right.textContent = `${repairText}  ${part.basePrice}c`;
        right.style.cssText = "font-weight: 700; font-size: 14px; color: #ffffff;";
        row.appendChild(left);
        row.appendChild(right);
        row.addEventListener("click", () => {
          if (gameState.stats.credits < part.basePrice) {
            gameState.travel.outpostDockyardMessage = "Insufficient credits.";
            renderOutpostDockyard(locationId);
            return;
          }
          gameState.stats.credits -= part.basePrice;
          const repairAmount = part.repairAmount || 0;
          const subtype = part.subtype || "ANY";
          let actualRepair = repairAmount;
          if (subtype !== "ANY") {
            const subsystemDamage = gameState.ship.subsystems[subtype].damage;
            if (subsystemDamage > 0) {
              gameState.ship.subsystems[subtype].damage = 0;
              gameState.ship.subsystems[subtype].flavorText = "";
              actualRepair = repairAmount;
            } else {
              actualRepair = repairAmount * 0.5;
            }
          } else {
            const totalDamage = gameState.ship.subsystems.STRUCTURAL.damage +
                               gameState.ship.subsystems.ELECTRICAL.damage +
                               gameState.ship.subsystems.LIFE_SUPPORT.damage;
            if (totalDamage > 0) {
              const repairPerSubsystem = repairAmount / 3;
              Object.keys(gameState.ship.subsystems).forEach(sub => {
                if (gameState.ship.subsystems[sub].damage > 0) {
                  gameState.ship.subsystems[sub].damage = Math.max(0,
                    gameState.ship.subsystems[sub].damage - repairPerSubsystem
                  );
                  if (gameState.ship.subsystems[sub].damage === 0) {
                    gameState.ship.subsystems[sub].flavorText = "";
                  }
                }
              });
              actualRepair = repairAmount;
            } else {
              actualRepair = repairAmount * 0.5;
            }
          }
          addShipIntegrity(gameState, actualRepair);
          gameState.travel.outpostDockyardMessage = `${part.name} applied.`;
          renderOutpostDockyard(locationId);
          render();
        });
        list.appendChild(row);
      });
    }
    contentArea.appendChild(list);
    dockyardContainer.appendChild(contentArea);
    dockyardContainer.appendChild(message);
  }
  
  el.sceneOverlayLayer.appendChild(dockyardContainer);
}

/**
 * Build or fetch rumor list for an outpost
 * @param {string} locationId Outpost location ID
 * @returns {Array<{id: string, text: string, targetId: string|null, isTrue: boolean}>}
 */
function getOutpostRumors(locationId) {
  const baseId = getBaseLocationId(locationId);
  if (!gameState.travel.outpostRumors) {
    gameState.travel.outpostRumors = {};
  }
  if (gameState.travel.outpostRumors[baseId]) {
    return gameState.travel.outpostRumors[baseId];
  }
  const rumorCount = rollInt(2, 4);
  const rumors = [];
  const rumorCosts = [150, 200, 250, 300];
  const rewardWeightsByCost = {
    150: { artifact: 15, credits: 35, resource: 50 },
    200: { artifact: 25, credits: 35, resource: 40 },
    250: { artifact: 40, credits: 30, resource: 30 },
    300: { artifact: 55, credits: 25, resource: 20 }
  };
  const falseChanceByCost = {
    150: 1 / 3,
    200: 1 / 4,
    250: 0,
    300: 0
  };
  const rollWeighted = (weights) => {
    const entries = Object.entries(weights);
    const total = entries.reduce((sum, [, weight]) => sum + weight, 0);
    let roll = Math.random() * total;
    for (const [key, weight] of entries) {
      roll -= weight;
      if (roll <= 0) return key;
    }
    return entries[entries.length - 1][0];
  };
  for (let i = 0; i < rumorCount; i++) {
    const cost = rumorCosts[Math.floor(Math.random() * rumorCosts.length)];
    const isFalse = Math.random() < (falseChanceByCost[cost] || 0);
    const kind = isFalse ? "false" : rollWeighted(rewardWeightsByCost[cost] || rewardWeightsByCost[150]);
    const isTrue = !isFalse;
    let text = "A drifter points toward the inner rings, but the story doesn't add up.";
    if (kind === "artifact") {
      text = "A salvage crew whispers about something strange on a nearby rock.";
    } else if (kind === "credits") {
      text = "Someone swears there's a credit cache hidden out here.";
    } else if (kind === "resource") {
      text = "A scavenger points to a rock with usable resources.";
    } else {
      text = "A rumor circulates about a drifting rock, but no one agrees on the details.";
    }
    rumors.push({
      id: `rumor_${baseId}_${i}_${Date.now()}`,
      text,
      kind,
      isTrue,
      cost
    });
  }
  gameState.travel.outpostRumors[baseId] = rumors;
  return rumors;
}

/**
 * Render outpost rumor kiosk UI overlay
 * @param {string} locationId Location ID
 */
function renderOutpostRumorKiosk(locationId) {
  if (!el.sceneContainer) {
    console.error("[OUTPOST RUMOR] sceneContainer not found!");
    return;
  }
  hideSceneElements();
  if (!showOverlayLayer()) {
    return;
  }
  el.sceneContainer.hidden = false;
  el.sceneContainer.removeAttribute("hidden");
  el.sceneContainer.style.display = "flex";
  el.sceneContainer.style.visibility = "visible";
  if (el.canvas) {
    el.canvas.hidden = true;
    el.canvas.style.display = "none";
  }
  const kioskContainer = document.createElement("div");
  kioskContainer.className = "merchant-container";
  kioskContainer.style.cssText = `
    width: 100%;
    height: 100%;
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: flex-start;
    border: 2px solid #ffffff;
    border-radius: 12px;
    padding: 30px;
    box-sizing: border-box;
  `;
  const headerEl = document.createElement("div");
  headerEl.className = "merchant-header";
  headerEl.textContent = "RUMOR KIOSK";
  kioskContainer.appendChild(headerEl);
  
  const navContainer = document.createElement("div");
  navContainer.className = "merchant-tabs";
  const leaveButton = document.createElement("button");
  leaveButton.textContent = "LEAVE";
  leaveButton.className = "merchant-tab is-active";
  leaveButton.style.cssText = `
    font-family: 'Inter', sans-serif;
    font-weight: 900;
    font-size: 18px;
    padding: 12px 24px;
    background: transparent;
    color: #ffffff;
    border: 2px solid #ffffff;
    border-radius: 6px;
    cursor: pointer;
  `;
  leaveButton.addEventListener("click", () => {
    closeAllOverlays();
    gameState.travel.outpostRumorMessage = null;
    gameState.travel.outpostRumorSelectedId = null;
    gameState.travel.outpostRumorPendingId = null;
    gameState.travel.outpostRumorPendingIds.clear();
    gameState.travel.currentSceneId = "OUTPOST_INTERIOR";
    render();
  });
  navContainer.appendChild(leaveButton);
  kioskContainer.appendChild(navContainer);
  const rumors = getOutpostRumors(locationId);
  const list = document.createElement("div");
  list.style.cssText = `
    width: 100%;
    display: flex;
    flex-direction: column;
    gap: 12px;
    margin-top: 10px;
    margin-bottom: 20px;
  `;
  rumors.forEach(rumor => {
    const row = document.createElement("div");
    const isSelected = gameState.travel.outpostRumorPendingIds.has(rumor.id);
    row.style.cssText = `
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 12px;
      padding: 14px 18px;
      border: 2px solid #ffffff;
      border-radius: 10px;
      cursor: pointer;
      background: ${isSelected ? "#ffffff" : "transparent"};
      color: ${isSelected ? "#000000" : "#ffffff"};
      font-weight: 600;
      line-height: 1.4;
    `;
    const rowText = document.createElement("div");
    rowText.textContent = rumor.text;
    rowText.style.flex = "1";
    rowText.style.fontWeight = "600";
    rowText.style.fontSize = "14px";
    rowText.style.color = isSelected ? "#000000" : "#ffffff";
    const rowCost = document.createElement("div");
    rowCost.textContent = `${rumor.cost}c`;
    rowCost.style.fontWeight = "800";
    rowCost.style.fontSize = "14px";
    rowCost.style.color = isSelected ? "#000000" : "#ffffff";
    row.appendChild(rowText);
    row.appendChild(rowCost);
    row.addEventListener("click", () => {
      if (gameState.travel.outpostRumorPendingIds.has(rumor.id)) {
        gameState.travel.outpostRumorPendingIds.delete(rumor.id);
      } else {
        gameState.travel.outpostRumorPendingIds.add(rumor.id);
      }
      const count = gameState.travel.outpostRumorPendingIds.size;
      gameState.travel.outpostRumorMessage = count > 0
        ? `${count} rumor${count === 1 ? "" : "s"} selected. Proceed to checkout.`
        : "";
      renderOutpostRumorKiosk(locationId);
    });
    list.appendChild(row);
  });
  kioskContainer.appendChild(list);
  const message = document.createElement("div");
  message.style.cssText = `
    font-family: 'Inter', sans-serif;
    font-weight: 600;
    font-size: 14px;
    color: #ffcf33;
    min-height: 18px;
    margin-bottom: 16px;
  `;
  message.textContent = gameState.travel.outpostRumorMessage || "";
  kioskContainer.appendChild(message);
  const selectedTotal = rumors
    .filter((entry) => gameState.travel.outpostRumorPendingIds.has(entry.id))
    .reduce((sum, entry) => sum + (entry.cost || 0), 0);
  const infoStrip = document.createElement("div");
  infoStrip.className = "merchant-info-strip";
  infoStrip.style.justifyContent = "center";
  infoStrip.style.marginBottom = "20px";
  infoStrip.textContent = `TOTAL: ${selectedTotal}c | CREDITS: ${gameState.stats.credits}c`;
  kioskContainer.appendChild(infoStrip);
  const checkoutButton = document.createElement("button");
  checkoutButton.className = "merchant-confirm-button";
  checkoutButton.textContent = "CHECKOUT";
  checkoutButton.addEventListener("click", () => {
    const pendingIds = Array.from(gameState.travel.outpostRumorPendingIds);
    if (pendingIds.length === 0) {
      gameState.travel.outpostRumorMessage = "Select at least one rumor.";
      renderOutpostRumorKiosk(locationId);
      return;
    }
    const totalCost = pendingIds.reduce((sum, pendingId) => {
      const rumor = rumors.find((entry) => entry.id === pendingId);
      return sum + (rumor ? rumor.cost : 0);
    }, 0);
    if (gameState.stats.credits < totalCost) {
      gameState.travel.outpostRumorMessage = "Insufficient credits.";
      renderOutpostRumorKiosk(locationId);
      return;
    }
    gameState.stats.credits -= totalCost;
    const usedTargetIds = new Set();
    const assignments = [];
    for (const pendingId of pendingIds) {
      const rumor = rumors.find((entry) => entry.id === pendingId);
      if (!rumor) {
        continue;
      }
      const target = selectRumorTargetFromCurrentLocation(usedTargetIds);
      if (!target) {
        gameState.travel.outpostRumorMessage = "Not enough unique targets for all selected rumors.";
        renderOutpostRumorKiosk(locationId);
        return;
      }
      usedTargetIds.add(target.id);
      assignments.push({ rumor, target });
    }
    const baseId = getBaseLocationId(locationId);
    assignments.forEach(({ rumor, target }) => {
      gameState.travel.outpostRumorSelectedId = rumor.id;
      const targetName = target.name || "a nearby rock";
      let rumorText = rumor.text;
      if (rumor.kind === "artifact") {
        rumorText = `A salvage crew whispers about something strange near ${targetName}.`;
      } else if (rumor.kind === "credits") {
        rumorText = `Someone swears there's a credit cache near ${targetName}.`;
      } else if (rumor.kind === "resource") {
        rumorText = `A scavenger claims resources near ${targetName}.`;
      }
      setRumorTarget(target.id, rumorText, "OUTPOST_RUMOR", {
        id: rumor.id,
        kind: rumor.kind,
        isTrue: rumor.isTrue,
        cost: rumor.cost,
        source: baseId,
      });
    });
    if (gameState.travel.outpostRumors && gameState.travel.outpostRumors[baseId]) {
      gameState.travel.outpostRumors[baseId] = gameState.travel.outpostRumors[baseId]
        .filter((entry) => !gameState.travel.outpostRumorPendingIds.has(entry.id));
    }
    gameState.travel.outpostRumorPendingId = null;
    gameState.travel.outpostRumorPendingIds.clear();
    gameState.travel.outpostRumorMessage = pendingIds.length === 1
      ? "Rumor marked on your map."
      : "Rumors marked on your map.";
    renderOutpostRumorKiosk(locationId);
  });
  kioskContainer.appendChild(checkoutButton);
  // Return handled via LEAVE tab above
  el.sceneOverlayLayer.appendChild(kioskContainer);
}

function getRumorCurrentRing(currentNode) {
  if (!currentNode) return 0;
  if (currentNode.type === "ship" && currentNode.initialRing !== undefined && currentNode.radialVelocity !== undefined) {
    const currentRing = currentNode.initialRing + (currentNode.radialVelocity * gameState.stats.day);
    return Math.max(0.5, Math.min(6, currentRing));
  }
  if (currentNode.type === "moon" && currentNode.orbitsAround) {
    const parentNode = mapNodes.find(n => n.id === currentNode.orbitsAround);
    if (parentNode) {
      return getRumorCurrentRing(parentNode);
    }
  }
  return currentNode.ring || 0;
}

function selectRumorTargetFromCurrentLocation(excludeIds = new Set()) {
  const currentId = gameState.travel.currentLocationId;
  const currentNode = mapNodes.find(n => n.id === currentId);
  if (!currentId || !currentNode) return null;
  
  let candidates = mapNodes.filter(n =>
    n.type === "asteroid" &&
    n.id !== currentId &&
    !excludeIds.has(n.id) &&
    (!gameState.travel.clearedAsteroids || !gameState.travel.clearedAsteroids.has(n.id))
  );
  
  if (gameState.travel.deepScannedNodes && gameState.travel.deepScannedNodes.size > 0) {
    const deepScannedCandidates = candidates.filter(n => gameState.travel.deepScannedNodes.has(n.id));
    if (deepScannedCandidates.length > 0) {
      candidates = deepScannedCandidates;
    }
  }
  
  const currentRing = getRumorCurrentRing(currentNode);
  const currentPos = getNodePosition(currentNode, gameState.stats.day);
  const marsNode = mapNodes.find(n => n.id === "mars");
  const marsPos = marsNode ? getNodePosition(marsNode, gameState.stats.day) : null;
  if (!marsPos) return null;
  
  const twoPi = Math.PI * 2;
  const cwDist = (a, b) => {
    const raw = (a - b) % twoPi;
    return raw < 0 ? raw + twoPi : raw;
  };
  const cwToMars = cwDist(currentPos.angle, marsPos.angle);
  const maxDays = 45;
  const withTravel = [];
  candidates.forEach(node => {
    const travelDays = calculateTravelTime(currentId, node.id);
    if (travelDays > 0 && travelDays <= maxDays) {
      const candidatePos = getNodePosition(node, gameState.stats.day);
      const cwToCandidate = cwDist(currentPos.angle, candidatePos.angle);
      withTravel.push({
        node,
        travelDays,
        ring: getRumorCurrentRing(node),
        cwToCandidate
      });
    }
  });
  if (withTravel.length === 0) return null;
  
  const directionalCandidates = withTravel.filter(c => c.cwToCandidate <= cwToMars);
  if (directionalCandidates.length === 0) return null;
  
  let preferred = directionalCandidates.filter(c => c.ring >= currentRing);
  if (preferred.length === 0) {
    preferred = directionalCandidates.filter(c => c.ring >= currentRing - 0.5);
  }
  if (preferred.length === 0) {
    preferred = directionalCandidates;
  }
  
  const weighted = preferred.map(c => {
    let weight = 1;
    if (c.travelDays <= 15) {
      weight = 3;
    } else if (c.travelDays <= 30) {
      weight = 2;
    }
    return { ...c, weight };
  });
  
  const totalWeight = weighted.reduce((sum, c) => sum + c.weight, 0);
  let roll = Math.random() * totalWeight;
  for (const entry of weighted) {
    roll -= entry.weight;
    if (roll <= 0) {
      return entry.node;
    }
  }
  return weighted[weighted.length - 1].node;
}

function setRumorTarget(targetId, rumorText, logType = "RUMOR", rumorMeta = null) {
  gameState.travel.hintTargetAsteroidId = targetId;
  gameState.travel.lastRumorText = rumorText;
  if (!gameState.travel.rumoredNodes) gameState.travel.rumoredNodes = new Set();
  if (!gameState.travel.activeRumorAsteroidIds) gameState.travel.activeRumorAsteroidIds = new Set();
  if (!gameState.travel.purchasedRumors) gameState.travel.purchasedRumors = {};
  gameState.travel.rumoredNodes.add(targetId);
  gameState.travel.activeRumorAsteroidIds.add(targetId);
  const targetNode = mapNodes.find(n => n.id === targetId);
  const targetName = targetNode ? targetNode.name : "a nearby rock";
  if (rumorMeta) {
    gameState.travel.purchasedRumors[targetId] = {
      targetId,
      targetName,
      text: rumorText,
      kind: rumorMeta.kind,
      isTrue: rumorMeta.isTrue,
      cost: rumorMeta.cost,
      source: rumorMeta.source,
      purchasedDay: gameState.stats.day,
    };

    // Make true rumors consequential by biasing the hidden asteroid truth.
    // False rumors remain useful as map leads but do not change outcomes.
    if (targetNode && rumorMeta.isTrue) {
      generateAsteroidTruthValues(targetNode);
      if (rumorMeta.kind === "artifact") targetNode.artifactTruth = true;
      if (rumorMeta.kind === "resource") targetNode.resourcesTruth = true;
      if (rumorMeta.kind === "credits") targetNode.creditCacheTruth = true;
    }
  }
  logAdd(logType, `Day ${gameState.stats.day}: ${rumorText}`, {
    targetId: targetId,
    hintTargetAsteroidId: targetId,
    rumor: rumorMeta || null,
  });
  return {
    targetId,
    message: `Marked ${targetName} on your map.`
  };
}

function clearRumorTarget(logType = "RUMOR") {
  gameState.travel.hintTargetAsteroidId = null;
  const flavor = "Nothing solid—just stories.";
  gameState.travel.lastRumorText = flavor;
  logAdd(logType, `Day ${gameState.stats.day}: ${flavor}`, {});
  return { targetId: null, message: flavor };
}

/**
 * Render clinic (med-bay) UI overlay
 * @param {string} locationId Location ID
 */
function renderClinic(locationId) {
  if (!el.sceneContainer) {
    console.error("[CLINIC] sceneContainer not found!");
    return;
  }
  
  if (!gameState.travel.clinicMode) {
    gameState.travel.clinicMode = "treat";
  }
  
  // Hide scene elements and show overlay layer
  hideSceneElements();
  if (!showOverlayLayer()) {
    return;
  }
  
  el.sceneContainer.hidden = false;
  el.sceneContainer.removeAttribute("hidden");
  el.sceneContainer.style.display = "flex";
  el.sceneContainer.style.visibility = "visible";
  
  if (el.canvas) {
    el.canvas.hidden = true;
    el.canvas.style.display = "none";
  }
  
  const clinicContainer = document.createElement("div");
  clinicContainer.className = "merchant-container";
  clinicContainer.style.cssText = `
    width: 100%;
    height: 100%;
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: flex-start;
    border: 2px solid #ffffff;
    border-radius: 12px;
    padding: 30px;
    box-sizing: border-box;
  `;
  
  const headerEl = document.createElement("div");
  headerEl.className = "merchant-header";
  headerEl.textContent = "MED-BAY";
  clinicContainer.appendChild(headerEl);
  
  const tabs = document.createElement("div");
  tabs.className = "merchant-tabs";
  const tabConfig = [
    { id: "treat", label: "TREAT" },
    { id: "pharmacy", label: "PHARMACY" },
    { id: "leave", label: "LEAVE" }
  ];
  tabConfig.forEach((tab, index) => {
    const btn = document.createElement("button");
    btn.textContent = tab.label;
    btn.className = "merchant-tab";
    if (gameState.travel.clinicMode === tab.id) {
      btn.classList.add("is-active");
    }
    btn.style.borderRadius = index === 0
      ? "6px 0 0 6px"
      : index === tabConfig.length - 1
        ? "0 6px 6px 0"
        : "0";
    btn.style.borderLeft = index === 0 ? "2px solid var(--paper)" : "none";
    btn.addEventListener("click", () => {
      if (tab.id === "leave") {
        const returnScene = gameState.travel.returnSceneId || "HUB";
        closeAllOverlays();
        gameState.travel.returnSceneId = null;
        gameState.travel.currentSceneId = returnScene;
        render();
        return;
      }
      if (tab.id === "pharmacy") {
        gameState.travel.clinicMode = "pharmacy";
        renderClinic(locationId);
        return;
      }
      gameState.travel.clinicMode = "treat";
      renderClinic(locationId);
    });
    tabs.appendChild(btn);
  });
  clinicContainer.appendChild(tabs);
  
  const credits = gameState.stats.credits || 0;
  const members = gameState.crew.members || [];
  const selectedMemberId = gameState.travel.clinicSelectedMemberId;
  const selectedMember = members.find(m => m.id === selectedMemberId) || null;
  
  const treatmentOptions = [
    { id: "basic", label: "Basic Treatment", days: 1, cost: 50, result: "Recovering" },
    { id: "extended", label: "Extended Care", days: 2, cost: 100, result: "Healthy" },
    { id: "stabilize", label: "Stabilize Only", days: 1, cost: 25, result: null }
  ];
  const medicalDiscount = getCrewBonus("medicalDiscount");
  const medicalPrice = (price) => Math.max(1, Math.round(price * (1 - medicalDiscount)));
  const selectedTreatmentId = gameState.travel.clinicSelectedTreatmentId;
  const selectedTreatment = treatmentOptions.find(t => t.id === selectedTreatmentId) || null;
  
  const infoStrip = document.createElement("div");
  infoStrip.className = "merchant-payout-display";
  const timeCostText = selectedTreatment ? `${selectedTreatment.days}d` : "--";
  const patientText = selectedMember ? selectedMember.name : "--";
  infoStrip.textContent = `CREDITS: ${credits}c   TIME COST: ${timeCostText}   PATIENT: ${patientText}`;
  clinicContainer.appendChild(infoStrip);
  
  const contentArea = document.createElement("div");
  contentArea.className = "merchant-content-area";
  
  const message = document.createElement("div");
  message.style.cssText = `
    font-family: 'Inter', sans-serif;
    font-weight: 600;
    font-size: 14px;
    color: #ff4444;
    margin-top: 10px;
    min-height: 18px;
  `;
  
  if (gameState.travel.clinicMode === "pharmacy") {
    const pharmacyItems = Object.values(SUPPLY_DEFS).filter(item =>
      item.subtype === "MEDICAL" && (item.tier === "STATION" || item.tier === "BOTH")
    );
    const list = document.createElement("div");
    list.style.cssText = `
      width: 100%;
      display: flex;
      flex-direction: column;
      gap: 10px;
      margin-top: 10px;
    `;
    pharmacyItems.forEach(item => {
      const row = document.createElement("div");
      const selected = selectedTreatmentId === item.id;
      row.style.cssText = `
        display: flex;
        align-items: center;
        justify-content: space-between;
        padding: 14px 18px;
        border: 2px solid #ffffff;
        border-radius: 10px;
        cursor: pointer;
        background: ${selected ? "rgba(255,255,255,0.1)" : "transparent"};
      `;
      const owned = gameState.inventory.supplies[item.id]?.qty || 0;
      const left = document.createElement("div");
      left.textContent = `${item.name} (owned ${owned})`;
      left.style.cssText = "font-weight: 700; color: #ffffff;";
      const right = document.createElement("div");
      right.textContent = `${medicalPrice(item.basePrice)}c`;
      right.style.cssText = "font-weight: 700; color: #ffffff;";
      row.appendChild(left);
      row.appendChild(right);
      row.addEventListener("click", () => {
        gameState.travel.clinicSelectedTreatmentId = item.id;
        renderClinic(locationId);
      });
      list.appendChild(row);
    });
    contentArea.appendChild(list);
  } else {
    const list = document.createElement("div");
    list.style.cssText = `
      width: 100%;
      display: flex;
      flex-direction: column;
      gap: 10px;
      margin-top: 10px;
    `;
    members.forEach(member => {
      const row = document.createElement("div");
      row.style.cssText = `
        display: grid;
        grid-template-columns: 1fr 1fr 120px;
        align-items: center;
        gap: 12px;
        padding: 12px 16px;
        border: 2px solid #ffffff;
        border-radius: 10px;
        cursor: pointer;
        background: ${selectedMemberId === member.id ? "rgba(255,255,255,0.1)" : "transparent"};
      `;
      const name = document.createElement("div");
      name.textContent = member.name || "Crew";
      name.style.cssText = "font-weight: 700; color: #ffffff;";
      const status = document.createElement("div");
      status.textContent = member.status || "Unknown";
      status.style.cssText = "font-weight: 600; color: #ffffff; opacity: 0.8;";
      const select = document.createElement("div");
      select.textContent = selectedMemberId === member.id ? "Selected" : "Select";
      select.style.cssText = "font-weight: 700; color: #ffffff; text-align: right;";
      row.appendChild(name);
      row.appendChild(status);
      row.appendChild(select);
      row.addEventListener("click", () => {
        gameState.travel.clinicSelectedMemberId = member.id;
        renderClinic(locationId);
      });
      list.appendChild(row);
    });
    contentArea.appendChild(list);
    
    const treatments = document.createElement("div");
    treatments.style.cssText = `
      width: 100%;
      display: flex;
      flex-direction: column;
      gap: 10px;
      margin-top: 16px;
    `;
    treatmentOptions.forEach(option => {
      const btn = document.createElement("div");
      btn.style.cssText = `
        display: flex;
        align-items: center;
        justify-content: space-between;
        padding: 14px 18px;
        border: 2px solid #ffffff;
        border-radius: 10px;
        cursor: pointer;
        background: ${selectedTreatmentId === option.id ? "rgba(255,255,255,0.1)" : "transparent"};
      `;
      const left = document.createElement("div");
      left.textContent = option.label;
      left.style.cssText = "font-weight: 700; color: #ffffff;";
      const right = document.createElement("div");
      right.textContent = `${option.days} day  ${medicalPrice(option.cost)}c`;
      right.style.cssText = "font-weight: 700; color: #ffffff;";
      btn.appendChild(left);
      btn.appendChild(right);
      btn.addEventListener("click", () => {
        gameState.travel.clinicSelectedTreatmentId = option.id;
        renderClinic(locationId);
      });
      treatments.appendChild(btn);
    });
    contentArea.appendChild(treatments);
  }
  
  clinicContainer.appendChild(contentArea);
  
  const confirm = document.createElement("button");
  confirm.textContent = gameState.travel.clinicMode === "pharmacy" ? "BUY MEDICAL SUPPLY" : "CONFIRM TREATMENT";
  confirm.className = "merchant-confirm-button";
  const selectedPharmacyItem = SUPPLY_DEFS[selectedTreatmentId];
  const canConfirm = gameState.travel.clinicMode === "pharmacy"
    ? !!selectedPharmacyItem
    : selectedMember && selectedTreatment && gameState.travel.clinicMode === "treat";
  confirm.disabled = !canConfirm;
  confirm.style.opacity = canConfirm ? "1" : "0.5";
  confirm.style.cursor = canConfirm ? "pointer" : "not-allowed";
  confirm.addEventListener("click", () => {
    if (!canConfirm) return;
    if (gameState.travel.clinicMode === "pharmacy") {
      const itemPrice = medicalPrice(selectedPharmacyItem.basePrice);
      if (credits < itemPrice) {
        message.textContent = "Insufficient credits.";
        return;
      }
      gameState.stats.credits -= itemPrice;
      gameState.inventory.supplies[selectedPharmacyItem.id] = gameState.inventory.supplies[selectedPharmacyItem.id] || { id: selectedPharmacyItem.id, qty: 0 };
      gameState.inventory.supplies[selectedPharmacyItem.id].qty += 1;
      logAdd("CLINIC", `Day ${gameState.stats.day}: Bought ${selectedPharmacyItem.name}.`, { supplyId: selectedPharmacyItem.id });
      gameState.travel.clinicSelectedTreatmentId = null;
      renderClinic(locationId);
      render();
      return;
    }
    const treatmentCost = medicalPrice(selectedTreatment.cost);
    if (credits < treatmentCost) {
      message.textContent = "Insufficient credits.";
      return;
    }
    gameState.stats.credits -= treatmentCost;
    advanceDays(selectedTreatment.days);
    if (selectedTreatment.result) {
      selectedMember.status = selectedTreatment.result;
    }
    logAdd("CLINIC", `Day ${gameState.stats.day}: Treated ${selectedMember.name} (${selectedTreatment.label}).`, {
      crewMemberId: selectedMember.id
    });
    gameState.travel.clinicSelectedTreatmentId = null;
    renderClinic(locationId);
    render();
  });
  
  clinicContainer.appendChild(confirm);
  clinicContainer.appendChild(message);
  
  el.sceneOverlayLayer.appendChild(clinicContainer);
}

/**
 * Render cantina UI overlay
 * @param {string} locationId Location ID
 */
function renderCantina(locationId) {
  if (!el.sceneContainer) {
    console.error("[CANTINA] sceneContainer not found!");
    return;
  }
  
  if (!gameState.travel.cantinaUI) {
    gameState.travel.cantinaUI = { tab: "order", selectedOrderId: null, activeRumor: null };
  }
  
  // Hide scene elements and show overlay layer
  hideSceneElements();
  if (!showOverlayLayer()) {
    return;
  }
  
  el.sceneContainer.hidden = false;
  el.sceneContainer.removeAttribute("hidden");
  el.sceneContainer.style.display = "flex";
  el.sceneContainer.style.visibility = "visible";
  
  if (el.canvas) {
    el.canvas.hidden = true;
    el.canvas.style.display = "none";
  }
  
  const cantinaContainer = document.createElement("div");
  cantinaContainer.className = "merchant-container";
  cantinaContainer.style.cssText = `
    width: 100%;
    height: 100%;
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: flex-start;
    border: 2px solid #ffffff;
    border-radius: 12px;
    padding: 30px;
    box-sizing: border-box;
  `;
  
  const headerEl = document.createElement("div");
  headerEl.className = "merchant-header";
  headerEl.textContent = "CANTINA";
  cantinaContainer.appendChild(headerEl);
  
  const tabs = document.createElement("div");
  tabs.className = "merchant-tabs";
  const tabConfig = [
    { id: "order", label: "ORDER" },
    { id: "chat", label: "CHAT" },
    { id: "leave", label: "LEAVE" }
  ];
  tabConfig.forEach((tab, index) => {
    const btn = document.createElement("button");
    btn.textContent = tab.label;
    btn.className = "merchant-tab";
    if (gameState.travel.cantinaUI.tab === tab.id) {
      btn.classList.add("is-active");
    }
    btn.style.borderRadius = index === 0
      ? "6px 0 0 6px"
      : index === tabConfig.length - 1
        ? "0 6px 6px 0"
        : "0";
    btn.style.borderLeft = index === 0 ? "2px solid var(--paper)" : "none";
    btn.addEventListener("click", () => {
      if (tab.id === "leave") {
        const returnScene = gameState.travel.returnSceneId || "HUB";
        closeAllOverlays();
        gameState.travel.returnSceneId = null;
        gameState.travel.currentSceneId = returnScene;
        render();
        return;
      }
      gameState.travel.cantinaUI.tab = tab.id;
      gameState.travel.cantinaUI.activeRumor = null;
      renderCantina(locationId);
    });
    tabs.appendChild(btn);
  });
  cantinaContainer.appendChild(tabs);
  
  const credits = gameState.stats.credits || 0;
  const lifeSupportPerDay = 100 / 30;
  const lifeSupportDays = Math.floor(gameState.stats.lifeSupport / lifeSupportPerDay);
  
  const infoStrip = document.createElement("div");
  infoStrip.className = "merchant-payout-display";
  infoStrip.textContent = `CREDITS: ${credits}c   LIFE SUPPORT: ${lifeSupportDays}d`;
  cantinaContainer.appendChild(infoStrip);
  
  const contentArea = document.createElement("div");
  contentArea.className = "merchant-content-area";
  
  const message = document.createElement("div");
  message.style.cssText = `
    font-family: 'Inter', sans-serif;
    font-weight: 600;
    font-size: 14px;
    color: #ff4444;
    margin-top: 10px;
    min-height: 18px;
  `;
  
  const orderOptions = [
    { id: "hot-meal", label: "Hot Meal", cost: 25, days: 1 },
    { id: "clean-kit", label: "Shower and Clean Kit", cost: 20, days: 1 },
    { id: "coffee", label: "Coffee and Quiet Corner", cost: 15, days: 1 },
    { id: "bunk", label: "Bunk Rental", cost: 40, days: 2 }
  ];
  
  const applyLifeSupportDays = (daysToAdd) => {
    const percentToAdd = daysToAdd * lifeSupportPerDay;
    gameState.stats.lifeSupport = Math.min(100, gameState.stats.lifeSupport + percentToAdd);
  };
  
  const applyRecoveringToNonHealthy = () => {
    const members = gameState.crew.members || [];
    const eligible = members.filter(m => m.status && m.status !== "Healthy");
    if (eligible.length === 0) {
      return null;
    }
    const member = eligible[0];
    member.status = "Recovering";
    return member;
  };
  
  const applyHealthyToRecovering = () => {
    const members = gameState.crew.members || [];
    const eligible = members.filter(m => m.status === "Recovering");
    if (eligible.length === 0) {
      return null;
    }
    const member = eligible[0];
    member.status = "Healthy";
    return member;
  };
  
  if (gameState.travel.cantinaUI.tab === "chat") {
    if (gameState.travel.cantinaUI.activeRumor) {
      const rumorBlock = document.createElement("div");
      rumorBlock.style.cssText = `
        width: 100%;
        padding: 16px 18px;
        border: 2px solid #ffffff;
        border-radius: 10px;
        color: #ffffff;
        font-weight: 600;
        line-height: 1.4;
      `;
      rumorBlock.textContent = gameState.travel.cantinaUI.activeRumor;
      const contBtn = document.createElement("button");
      contBtn.textContent = "CONTINUE";
      contBtn.className = "merchant-confirm-button";
      contBtn.addEventListener("click", () => {
        gameState.travel.cantinaUI.activeRumor = null;
        renderCantina(locationId);
      });
      contentArea.appendChild(rumorBlock);
      contentArea.appendChild(contBtn);
    } else {
      const chatOptions = [
        { id: "routes", label: "Ask about nearby routes" },
        { id: "trouble", label: "Ask about trouble" },
        { id: "strange", label: "Ask about strange finds" }
      ];
      const list = document.createElement("div");
      list.style.cssText = `
        width: 100%;
        display: flex;
        flex-direction: column;
        gap: 10px;
        margin-top: 10px;
      `;
      chatOptions.forEach(option => {
        const row = document.createElement("div");
        row.style.cssText = `
          display: flex;
          align-items: center;
          justify-content: space-between;
          padding: 14px 18px;
          border: 2px solid #ffffff;
          border-radius: 10px;
          cursor: pointer;
          background: transparent;
        `;
        const label = document.createElement("div");
        label.textContent = option.label;
        label.style.cssText = "font-weight: 700; color: #ffffff;";
        row.appendChild(label);
        row.addEventListener("click", () => {
          const outcomes = ["hint", "false", "warning"];
          const outcome = outcomes[Math.floor(Math.random() * outcomes.length)];
          let rumorText = "";
          if (outcome === "hint") {
            const target = selectRumorTargetFromCurrentLocation();
            if (target) {
              rumorText = `A spacer whispers about strange signals near ${target.name}. Might be worth a look.`;
              setRumorTarget(target.id, rumorText, "CANTINA_RUMOR");
            } else {
              rumorText = "Nothing solid—just stories.";
              clearRumorTarget("CANTINA_RUMOR");
            }
          } else if (outcome === "false") {
            rumorText = "Someone swears there's a rich find nearby, but the story keeps changing.";
            gameState.travel.lastRumorText = rumorText;
            logAdd("CANTINA_RUMOR", `Day ${gameState.stats.day}: ${rumorText}`, {});
          } else {
            rumorText = "A crew warns of trouble on the outer rings. Keep your scanners sharp.";
            gameState.travel.lastRumorText = rumorText;
            logAdd("CANTINA_RUMOR", `Day ${gameState.stats.day}: ${rumorText}`, {});
          }
          gameState.travel.cantinaUI.activeRumor = rumorText;
          renderCantina(locationId);
        });
        list.appendChild(row);
      });
      contentArea.appendChild(list);
    }
  } else {
    const list = document.createElement("div");
    list.style.cssText = `
      width: 100%;
      display: flex;
      flex-direction: column;
      gap: 12px;
      margin-top: 10px;
    `;
    orderOptions.forEach(option => {
      const row = document.createElement("div");
      row.style.cssText = `
        display: flex;
        align-items: center;
        justify-content: space-between;
        padding: 16px 20px;
        border: 2px solid #ffffff;
        border-radius: 10px;
        cursor: pointer;
        background: ${gameState.travel.cantinaUI.selectedOrderId === option.id ? "rgba(255,255,255,0.1)" : "transparent"};
      `;
      const left = document.createElement("div");
      left.textContent = option.label;
      left.style.cssText = "font-weight: 700; font-size: 16px; color: #ffffff;";
      const right = document.createElement("div");
      right.textContent = `${option.days} day  ${option.cost}c`;
      right.style.cssText = "font-weight: 700; font-size: 14px; color: #ffffff;";
      row.appendChild(left);
      row.appendChild(right);
      row.addEventListener("click", () => {
        gameState.travel.cantinaUI.selectedOrderId = option.id;
        renderCantina(locationId);
      });
      list.appendChild(row);
    });
    contentArea.appendChild(list);
  }
  
  cantinaContainer.appendChild(contentArea);
  
  const confirm = document.createElement("button");
  confirm.textContent = "CONFIRM ORDER";
  confirm.className = "merchant-confirm-button";
  const selectedOrder = orderOptions.find(opt => opt.id === gameState.travel.cantinaUI.selectedOrderId);
  const canConfirm = gameState.travel.cantinaUI.tab === "order" && !!selectedOrder;
  confirm.disabled = !canConfirm;
  confirm.style.opacity = canConfirm ? "1" : "0.5";
  confirm.style.cursor = canConfirm ? "pointer" : "not-allowed";
  confirm.addEventListener("click", () => {
    if (!canConfirm) return;
    if (credits < selectedOrder.cost) {
      message.textContent = "Insufficient credits.";
      return;
    }
    gameState.stats.credits -= selectedOrder.cost;
    advanceDays(selectedOrder.days);
    
    let effectText = "";
    if (selectedOrder.id === "hot-meal" || selectedOrder.id === "clean-kit") {
      const member = applyRecoveringToNonHealthy();
      effectText = member ? `${member.name} is now Recovering.` : "No crew needed care.";
    } else if (selectedOrder.id === "coffee") {
      applyLifeSupportDays(1);
      effectText = "Life support extended by 1 day.";
    } else if (selectedOrder.id === "bunk") {
      applyLifeSupportDays(2);
      const member = applyHealthyToRecovering();
      effectText = member ? `${member.name} is now Healthy.` : "Life support extended by 2 days.";
    }
    
    logAdd("CANTINA_ORDER", `Day ${gameState.stats.day}: ${selectedOrder.label}. ${effectText}`, {});
    gameState.travel.cantinaUI.selectedOrderId = null;
    renderCantina(locationId);
    render();
  });
  
  if (gameState.travel.cantinaUI.tab === "order") {
    cantinaContainer.appendChild(confirm);
  }
  cantinaContainer.appendChild(message);
  
  el.sceneOverlayLayer.appendChild(cantinaContainer);
}

/**
 * Render admin UI overlay (placeholder)
 * @param {string} locationId Location ID
 */
function renderAdminOverlay(locationId) {
  if (!el.sceneContainer) {
    console.error("[ADMIN] sceneContainer not found!");
    return;
  }
  
  // Hide scene elements and show overlay layer
  hideSceneElements();
  if (!showOverlayLayer()) {
    return;
  }
  
  el.sceneContainer.hidden = false;
  el.sceneContainer.removeAttribute("hidden");
  el.sceneContainer.style.display = "flex";
  el.sceneContainer.style.visibility = "visible";
  
  if (el.canvas) {
    el.canvas.hidden = true;
    el.canvas.style.display = "none";
  }
  
  const adminContainer = document.createElement("div");
  adminContainer.className = "merchant-container";
  adminContainer.style.cssText = `
    width: 100%;
    height: 100%;
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: flex-start;
    border: 2px solid #ffffff;
    border-radius: 12px;
    padding: 30px;
    box-sizing: border-box;
  `;
  
  const headerEl = document.createElement("div");
  headerEl.className = "merchant-header";
  headerEl.textContent = "ADMIN";
  adminContainer.appendChild(headerEl);
  
  const tabs = document.createElement("div");
  tabs.className = "merchant-tabs";
  const leaveBtn = document.createElement("button");
  leaveBtn.textContent = "LEAVE";
  leaveBtn.className = "merchant-tab is-active";
  leaveBtn.style.borderRadius = "6px";
  leaveBtn.addEventListener("click", () => {
    const returnScene = gameState.travel.returnSceneId || "HUB";
    closeAllOverlays();
    gameState.travel.returnSceneId = null;
    gameState.travel.currentSceneId = returnScene;
    render();
  });
  tabs.appendChild(leaveBtn);
  adminContainer.appendChild(tabs);
  
  const terminal = document.createElement("div");
  terminal.style.cssText = `
    width: 100%;
    padding: 20px;
    margin-top: 20px;
    border: 2px solid #ffffff;
    border-radius: 10px;
    color: #ffffff;
    font-weight: 600;
    display: flex;
    flex-direction: column;
    gap: 14px;
  `;
  const status = document.createElement("div");
  status.textContent = `CREDITS: ${gameState.stats.credits}c | DAY ${gameState.stats.day}/${gameState.stats.deadline}`;
  terminal.appendChild(status);

  const services = [
    {
      label: "Buy Route Intel (75c)",
      run: () => {
        if (gameState.stats.credits < 75) return "Insufficient credits.";
        gameState.stats.credits -= 75;
        initializeRevealedNodes();
        if (gameState.travel.broadcastStationInstanceId) {
          gameState.travel.discoveredNodes.add(gameState.travel.broadcastStationInstanceId);
          logAdd("ADMIN", `Day ${gameState.stats.day}: Purchased station route intel: ${gameState.travel.broadcastStationInstanceId}.`, {});
          return `Broadcast station marked: ${gameState.travel.broadcastStationInstanceId}.`;
        }
        return "No new station intel available.";
      }
    },
    {
      label: "File Extension Request (+10 days, 120c)",
      run: () => {
        if (gameState.stats.credits < 120) return "Insufficient credits.";
        gameState.stats.credits -= 120;
        gameState.stats.deadline += 10;
        logAdd("ADMIN", `Day ${gameState.stats.day}: Filed mission extension. Deadline now day ${gameState.stats.deadline}.`, {});
        return `Deadline extended to day ${gameState.stats.deadline}.`;
      }
    },
    {
      label: "Sell Survey Data (+60c)",
      run: () => {
        const count = (gameState.travel.deepScannedNodes?.size || 0) + (gameState.travel.discoveredNodes?.size || 0);
        if (count < 3) return "Need at least 3 scan records.";
        gameState.stats.credits += 60;
        logAdd("ADMIN", `Day ${gameState.stats.day}: Sold survey data for 60 credits.`, {});
        return "Survey packet accepted. +60 credits.";
      }
    }
  ];

  services.forEach(service => {
    const btn = document.createElement("button");
    btn.className = "merchant-confirm-button";
    btn.textContent = service.label;
    btn.addEventListener("click", () => {
      status.textContent = service.run();
      renderHeader();
      renderStats();
    });
    terminal.appendChild(btn);
  });

  adminContainer.appendChild(terminal);
  
  el.sceneOverlayLayer.appendChild(adminContainer);
}

/**
 * Open trader merchant interface
 * @param {string} asteroidId Asteroid node ID where trader was encountered
 */
function openTraderMerchant(asteroidId) {
  debugLog("[TRADER MERCHANT] openTraderMerchant called with asteroidId:", asteroidId);
  
  if (!asteroidId) {
    console.error("[TRADER MERCHANT] No asteroidId provided!");
    // Try to get current location as fallback
    asteroidId = gameState.travel.currentLocationId;
    debugLog("[TRADER MERCHANT] Using currentLocationId as fallback:", asteroidId);
    if (!asteroidId) {
      console.error("[TRADER MERCHANT] No currentLocationId either, cannot open trader merchant");
      return;
    }
  }
  
  // Store return scene when entering trader merchant (if not already set)
  // Trader merchant is opened from an event prompt, so we store the scene we came from
  if (gameState.travel.returnSceneId === null) {
    // Store current scene as return target (typically will be handled by event system, but store for consistency)
    gameState.travel.returnSceneId = gameState.travel.currentSceneId || "MAP";
    debugLog("[TRADER MERCHANT] Stored return scene:", gameState.travel.returnSceneId);
  }
  
  // Initialize per-asteroid caps and purchased counts (1-3 per item)
  if (!gameState.travel.traderMerchantCapsByAsteroid) {
    gameState.travel.traderMerchantCapsByAsteroid = {};
  }
  if (!gameState.travel.traderMerchantPurchasedByAsteroid) {
    gameState.travel.traderMerchantPurchasedByAsteroid = {};
  }
  
  if (!gameState.travel.traderMerchantCapsByAsteroid[asteroidId]) {
    gameState.travel.traderMerchantCapsByAsteroid[asteroidId] = {};
  }
  if (!gameState.travel.traderMerchantPurchasedByAsteroid[asteroidId]) {
    gameState.travel.traderMerchantPurchasedByAsteroid[asteroidId] = {};
  }
  
  const traderItems = getTraderInventory();
  traderItems.forEach(item => {
    const caps = gameState.travel.traderMerchantCapsByAsteroid[asteroidId];
    const purchased = gameState.travel.traderMerchantPurchasedByAsteroid[asteroidId];
    if (caps[item.id] === undefined) {
      caps[item.id] = Math.floor(Math.random() * 3) + 1; // 1-3
    }
    if (purchased[item.id] === undefined) {
      purchased[item.id] = 0;
    }
  });
  
  // Set trader merchant state (may already be set by TRADE handler, but ensure it's set)
  gameState.travel.traderMerchantActive = true;
  gameState.travel.traderMerchantCart = {};
  gameState.travel.traderMerchantCartTotal = 0;
  
  // Hide event overlay
  if (el.eventOverlay) {
    el.eventOverlay.hidden = true;
    el.eventOverlay.setAttribute("hidden", "");
  }
  
  // Render trader merchant
  // Note: Do NOT call render() here - it can trigger scene rendering that overwrites the merchant UI
  // The merchant UI is self-contained and doesn't need a full render cycle
  renderTraderMerchant(asteroidId);
}

/**
 * Close trader merchant and return to exterior scene
 * @param {string} asteroidId Asteroid node ID
 */
function closeTraderMerchant(asteroidId) {
  const resolvedAsteroidId = asteroidId ||
    gameState.travel.currentLocationId ||
    gameState.travel.selectedLocationId ||
    (gameState.travel.activeContact ? gameState.travel.activeContact.asteroidId : null);
  // Clear trader merchant state
  gameState.travel.traderMerchantActive = false;
  gameState.travel.traderMerchantCart = {};
  gameState.travel.traderMerchantCartTotal = 0;
  
  // Hide overlay layer (merchant UI)
  hideOverlayLayer();
  
  if (gameState.travel.activeContact && gameState.travel.activeContact.asteroidId === resolvedAsteroidId) {
    showAsteroidContactMenu(resolvedAsteroidId);
    return;
  }
  const returnScene = gameState.travel.returnSceneId || "EXTERIOR";
  gameState.travel.returnSceneId = null;
  if (resolvedAsteroidId) {
    gameState.travel.currentLocationId = resolvedAsteroidId;
    gameState.travel.selectedLocationId = resolvedAsteroidId;
  }
  gameState.travel.selectedDestinationId = null;
  gameState.travel.currentSceneId = returnScene;
  render();
}

/**
 * Render trader merchant interface (mini-merchant with limited inventory)
 * @param {string} asteroidId Asteroid node ID
 */
function renderTraderMerchant(asteroidId) {
  if (!el.sceneContainer) {
    console.error("[TRADER MERCHANT] sceneContainer element not found!");
    return;
  }
  
  debugLog("[TRADER MERCHANT] Rendering trader merchant for asteroid:", asteroidId);
  
  // Initialize cart if first time
  if (gameState.travel.traderMerchantCart === undefined) {
    gameState.travel.traderMerchantCart = {};
    gameState.travel.traderMerchantCartTotal = 0;
  }
  
  // Hide scene elements and show overlay layer for merchant UI
  hideSceneElements();
  if (!showOverlayLayer()) {
    return; // showOverlayLayer already logged the error
  }
  
  // Show scene container (overlay layer is inside it)
  el.sceneContainer.hidden = false;
  el.sceneContainer.removeAttribute("hidden");
  el.sceneContainer.style.display = "flex";
  el.sceneContainer.style.visibility = "visible";
  
  // Hide canvas
  if (el.canvas) {
    el.canvas.hidden = true;
    el.canvas.style.display = "none";
  }
  
  // Create trader merchant container
  const storeContainer = document.createElement("div");
  storeContainer.className = "merchant-container";
  storeContainer.style.cssText = `
    width: 100%;
    height: 100%;
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: flex-start;
    border: 2px solid #ffffff;
    border-radius: 12px;
    padding: 30px;
    box-sizing: border-box;
  `;
  
  // Header: TRADER label
  const headerEl = document.createElement("div");
  headerEl.className = "merchant-header";
  headerEl.textContent = "TRADER";
  headerEl.style.cssText = `
    font-family: 'Inter', sans-serif;
    font-weight: 900;
    font-size: 24px;
    color: #ffffff;
    text-align: center;
    margin-bottom: 20px;
    letter-spacing: 2px;
  `;
  storeContainer.appendChild(headerEl);
  
  // Content area for items
  const contentArea = document.createElement("div");
  contentArea.className = "merchant-content-area";
  contentArea.style.cssText = `
    width: 100%;
    flex: 1;
    overflow: visible;
    min-height: 0;
  `;
  
  // Get trader inventory
  const traderItems = getTraderInventory();
  
  // Ensure caps/purchased maps exist for this asteroid (safety)
  if (!gameState.travel.traderMerchantCapsByAsteroid) {
    gameState.travel.traderMerchantCapsByAsteroid = {};
  }
  if (!gameState.travel.traderMerchantPurchasedByAsteroid) {
    gameState.travel.traderMerchantPurchasedByAsteroid = {};
  }
  if (!gameState.travel.traderMerchantCapsByAsteroid[asteroidId]) {
    gameState.travel.traderMerchantCapsByAsteroid[asteroidId] = {};
  }
  if (!gameState.travel.traderMerchantPurchasedByAsteroid[asteroidId]) {
    gameState.travel.traderMerchantPurchasedByAsteroid[asteroidId] = {};
  }
  
  const caps = gameState.travel.traderMerchantCapsByAsteroid[asteroidId];
  const purchased = gameState.travel.traderMerchantPurchasedByAsteroid[asteroidId];
  
  // Ensure caps/purchased are initialized for all items
  traderItems.forEach(item => {
    if (caps[item.id] === undefined) {
      caps[item.id] = Math.floor(Math.random() * 3) + 1; // 1-3
    }
    if (purchased[item.id] === undefined) {
      purchased[item.id] = 0;
    }
  });
  
  const getRemaining = (itemId) => Math.max(0, (caps[itemId] || 0) - (purchased[itemId] || 0));
  const flashLimit = (row) => {
    row.classList.remove("merchant-limit-flash");
    // Force reflow to restart animation
    void row.offsetWidth;
    row.classList.add("merchant-limit-flash");
  };
  
  // Calculate cart total and check budget
  const cartTotal = Object.entries(gameState.travel.traderMerchantCart).reduce((total, [itemId, quantity]) => {
    const item = traderItems.find(i => i.id === itemId);
    if (item && quantity > 0) {
      return total + (item.price * quantity);
    }
    return total;
  }, 0);
  gameState.travel.traderMerchantCartTotal = cartTotal;
  const availableCredits = gameState.stats.credits || 0;
  const isOverBudget = cartTotal > availableCredits;
  
  // Create 3-column grid that wraps to new rows
  const gridContainer = document.createElement("div");
  gridContainer.className = "merchant-grid";
  gridContainer.style.cssText = `
    display: grid;
    grid-template-columns: repeat(3, 1fr);
    grid-auto-flow: row;
    gap: 12px;
    padding: 10px;
    width: 100%;
  `;
  
  // Render each item as a row
  traderItems.forEach(item => {
    const row = document.createElement("div");
    row.className = "buy-item-row";
    row.style.cssText = `
      display: flex;
      align-items: center;
      gap: 12px;
      padding: 8px;
      border: 1px solid #ffffff;
      border-radius: 6px;
      cursor: pointer;
      transition: background 0.1s;
      width: 100%;
      min-width: 0;
    `;
    row.dataset.itemId = item.id;
    
    // Counter box (left)
    const qtyBox = document.createElement("div");
    qtyBox.className = "qty-box";
    let qty = gameState.travel.traderMerchantCart[item.id] || 0;
    const maxAllowed = getRemaining(item.id);
    if (qty > maxAllowed) {
      qty = maxAllowed;
      gameState.travel.traderMerchantCart[item.id] = qty;
    }
    const remainingAfterCart = Math.max(0, maxAllowed - qty);
    if (isOverBudget && qty > 0) {
      qtyBox.classList.add("is-overbudget");
    }
    qtyBox.textContent = String(qty).padStart(2, '0');
    qtyBox.style.cssText = `
      font-family: 'Inter', sans-serif;
      font-weight: 700;
      font-size: 14px;
      color: ${isOverBudget && qty > 0 ? '#ff0000' : '#ffffff'};
      border: 1px solid ${isOverBudget && qty > 0 ? '#ff0000' : '#ffffff'};
      border-radius: 4px;
      padding: 4px 8px;
      min-width: 40px;
      text-align: center;
      user-select: none;
    `;
    
    // Item capsule (right)
    const capsule = document.createElement("div");
    capsule.className = "item-capsule";
    capsule.style.cssText = `
      flex: 1;
      display: flex;
      align-items: center;
      justify-content: space-between;
      padding: 8px 12px;
      border: 1px solid #ffffff;
      border-radius: 20px;
      font-family: 'Inter', sans-serif;
      min-width: 0;
      overflow: hidden;
    `;
    
    const itemName = document.createElement("span");
    itemName.textContent = item.name;
    itemName.style.cssText = `
      font-weight: 500;
      font-size: 14px;
      color: #ffffff;
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
      flex: 1;
      min-width: 0;
    `;
    
    const divider = document.createElement("span");
    divider.className = "divider";
    divider.textContent = "|";
    divider.style.cssText = `
      margin: 0 8px;
      color: #ffffff;
      flex-shrink: 0;
    `;
    
    const price = document.createElement("span");
    price.textContent = `${item.price}c`;
    price.style.cssText = `
      font-weight: 700;
      font-size: 14px;
      color: #ffffff;
      white-space: nowrap;
      flex-shrink: 0;
    `;
    
    const remainingEl = document.createElement("span");
    const selectedText = String(qty).padStart(2, "0");
    const remainingText = String(remainingAfterCart).padStart(2, "0");
    remainingEl.textContent = `${selectedText}/${remainingText}`;
    remainingEl.style.cssText = `
      font-weight: 600;
      font-size: 12px;
      color: #ffffff;
      opacity: 0.7;
      white-space: nowrap;
      flex-shrink: 0;
    `;
    
    capsule.appendChild(itemName);
    capsule.appendChild(divider);
    capsule.appendChild(price);
    capsule.appendChild(remainingEl);
    
    row.appendChild(qtyBox);
    row.appendChild(capsule);
    
    // Click handler for row (increment)
    row.addEventListener("click", (e) => {
      // Don't increment if clicking on the counter box (that's for manual input)
      if (e.target === qtyBox) return;
      
      const currentQty = gameState.travel.traderMerchantCart[item.id] || 0;
      if (currentQty >= maxAllowed) {
        flashLimit(row);
        return;
      }
      gameState.travel.traderMerchantCart[item.id] = currentQty + 1;
      renderTraderMerchant(asteroidId); // Re-render
    });
    
    // Alt/Option-click handler (clear)
    row.addEventListener("contextmenu", (e) => {
      e.preventDefault();
      gameState.travel.traderMerchantCart[item.id] = 0;
      renderTraderMerchant(asteroidId); // Re-render
    });
    
    // Click handler for counter box (manual input)
    qtyBox.addEventListener("click", (e) => {
      e.stopPropagation();
      
      const input = document.createElement("input");
      input.type = "number";
      input.min = "0";
      input.value = String(qty);
      input.inputMode = "numeric";
      input.className = "merchant-qty-input";
      input.style.cssText = `
        font-family: 'Inter', sans-serif;
        font-weight: 700;
        font-size: 14px;
        color: #000000;
        border: 1px solid #ffffff;
        border-radius: 4px;
        padding: 4px 8px;
        min-width: 40px;
        text-align: center;
        width: 40px;
      `;
      
      qtyBox.replaceWith(input);
      input.focus();
      input.select();
      
      const commitValue = () => {
        let newValue = Math.max(0, Math.floor(parseFloat(input.value) || 0));
        if (newValue > maxAllowed) {
          newValue = maxAllowed;
          flashLimit(row);
        }
        gameState.travel.traderMerchantCart[item.id] = newValue;
        renderTraderMerchant(asteroidId); // Re-render
      };
      
      input.addEventListener("blur", commitValue);
      input.addEventListener("keydown", (e) => {
        if (e.key === "Enter") {
          e.preventDefault();
          commitValue();
        } else if (e.key === "Escape") {
          e.preventDefault();
          renderTraderMerchant(asteroidId); // Re-render without changes
        }
      });
    });
    
    gridContainer.appendChild(row);
  });
  
  contentArea.appendChild(gridContainer);
  storeContainer.appendChild(contentArea);
  
  // LEAVE button
  const leaveButton = document.createElement("button");
  leaveButton.textContent = "LEAVE";
  leaveButton.className = "merchant-tab";
  leaveButton.style.cssText = `
    font-family: 'Inter', sans-serif;
    font-weight: 700;
    font-size: 14px;
    padding: 10px 24px;
    background: transparent;
    color: #ffffff;
    border: 2px solid #ffffff;
    border-radius: 6px;
    cursor: pointer;
    margin-top: 20px;
    transition: background 0.1s, color 0.1s;
  `;
  leaveButton.addEventListener("mouseenter", () => {
    leaveButton.style.background = "#ffffff";
    leaveButton.style.color = "#000000";
  });
  leaveButton.addEventListener("mouseleave", () => {
    leaveButton.style.background = "transparent";
    leaveButton.style.color = "#ffffff";
  });
  leaveButton.addEventListener("click", () => {
    closeTraderMerchant(asteroidId);
  });
  storeContainer.appendChild(leaveButton);
  
  // Handle purchase (when cart has items and user wants to buy)
  // Add a "PURCHASE" button that appears when cart has items
  if (cartTotal > 0 && !isOverBudget) {
    const purchaseButton = document.createElement("button");
    purchaseButton.textContent = `PURCHASE (${cartTotal}c)`;
    purchaseButton.className = "merchant-confirm-button";
    purchaseButton.style.cssText = `
      font-family: 'Inter', sans-serif;
      font-weight: 700;
      font-size: 14px;
      padding: 10px 24px;
      background: #ffffff;
      color: #000000;
      border: 2px solid #ffffff;
      border-radius: 6px;
      cursor: pointer;
      margin-top: 10px;
      transition: background 0.1s, color 0.1s;
    `;
    purchaseButton.addEventListener("mouseenter", () => {
      purchaseButton.style.background = "transparent";
      purchaseButton.style.color = "#ffffff";
    });
    purchaseButton.addEventListener("mouseleave", () => {
      purchaseButton.style.background = "#ffffff";
      purchaseButton.style.color = "#000000";
    });
    purchaseButton.addEventListener("click", () => {
      // Process purchase
      if (gameState.stats.credits >= cartTotal) {
        // Deduct credits
        gameState.stats.credits -= cartTotal;
        
        // Add items to inventory (using centralized function)
        Object.entries(gameState.travel.traderMerchantCart).forEach(([itemId, quantity]) => {
          if (quantity > 0) {
            const item = traderItems.find(i => i.id === itemId);
            if (item) {
              addItemToInventory(itemId, quantity, item.category);
              if (gameState.travel.traderMerchantPurchasedByAsteroid &&
                  gameState.travel.traderMerchantPurchasedByAsteroid[asteroidId]) {
                const purchased = gameState.travel.traderMerchantPurchasedByAsteroid[asteroidId];
                purchased[itemId] = (purchased[itemId] || 0) + quantity;
              }
            }
          }
        });
        
        // Clear cart
        gameState.travel.traderMerchantCart = {};
        gameState.travel.traderMerchantCartTotal = 0;
        
        // Re-render merchant and keep asteroid scene context for render()
        if (gameState.travel.returnSceneId) {
          gameState.travel.currentSceneId = gameState.travel.returnSceneId;
        } else {
          gameState.travel.currentSceneId = "EXTERIOR";
        }
        gameState.travel.currentLocationId = asteroidId || gameState.travel.currentLocationId;
        gameState.travel.selectedLocationId = gameState.travel.currentLocationId;
        renderTraderMerchant(asteroidId);
        render(); // Update stats display without dropping to map
      }
    });
    storeContainer.appendChild(purchaseButton);
  }
  
  // Append to overlay layer, not scene container directly (preserves scene-image and scene-hotspots)
  el.sceneOverlayLayer.appendChild(storeContainer);
}

/**
 * Show and prepare the overlay layer for merchant UIs
 * Clears any existing content, applies merchant styling, and makes it visible
 */
function showOverlayLayer() {
  if (!el.sceneOverlayLayer) {
    console.error("[OVERLAY] sceneOverlayLayer not found!");
    return false;
  }
  
  // Clear any existing content
  el.sceneOverlayLayer.innerHTML = "";
  
  // Hide any scene title when showing merchant overlays
  const sceneTitleEl = el.sceneContainer?.querySelector(".scene-title");
  if (sceneTitleEl) {
    sceneTitleEl.style.display = "none";
  }
  
  // Apply merchant UI styling
  el.sceneOverlayLayer.style.cssText = `
    position: absolute;
    inset: 0;
    background-color: #000000;
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: flex-start;
    padding: 40px;
    box-sizing: border-box;
    z-index: 10;
  `;
  
  // Make visible
  el.sceneOverlayLayer.hidden = false;
  el.sceneOverlayLayer.removeAttribute("hidden");
  
  return true;
}

/**
 * Hide and clear the overlay layer
 * Use this when closing merchant UIs or returning to normal scene rendering
 */
function hideOverlayLayer() {
  if (!el.sceneOverlayLayer) {
    return; // Silently fail if overlay doesn't exist
  }
  
  // Clear content
  el.sceneOverlayLayer.innerHTML = "";
  
  // Hide
  el.sceneOverlayLayer.hidden = true;
  el.sceneOverlayLayer.setAttribute("hidden", "");
}

/**
 * Hide scene elements (image and hotspots) to make room for overlay UI
 */
function hideSceneElements() {
  if (el.sceneImage) {
    el.sceneImage.style.display = "none";
  }
  if (el.sceneHotspots) {
    el.sceneHotspots.style.display = "none";
  }
  const sceneTitleEl = el.sceneContainer?.querySelector(".scene-title");
  if (sceneTitleEl) {
    sceneTitleEl.style.display = "none";
  }
}

/**
 * Show scene elements (image and hotspots) for normal scene rendering
 */
function showSceneElements() {
  if (el.sceneImage) {
    el.sceneImage.style.display = "block";
  }
  if (el.sceneHotspots) {
    el.sceneHotspots.style.display = "block";
  }
}

/**
 * Close and clear any active overlay UIs (merchants, general store overlays).
 */
function closeAllOverlays() {
  gameState.travel.generalStoreMode = null;
  gameState.travel.traderMerchantActive = false;
  gameState.travel.serviceOverlay = null;
  gameState.travel.dockyardMode = null;
  gameState.travel.dockyardSelectionId = null;
  gameState.travel.outpostDockyardMode = null;
  gameState.travel.outpostDockyardSelectionId = null;
  gameState.travel.clinicMode = null;
  gameState.travel.clinicSelectedMemberId = null;
  gameState.travel.clinicSelectedTreatmentId = null;
  gameState.travel.cantinaUI = { tab: "order", selectedOrderId: null, activeRumor: null };
  if (el.sceneOverlayLayer) {
    el.sceneOverlayLayer.innerHTML = "";
    el.sceneOverlayLayer.hidden = true;
    el.sceneOverlayLayer.setAttribute("hidden", "");
  }
}

/**
 * Render station HUB panorama (data-driven panels)
 * @param {string} instanceId Station instance ID (e.g., "station-01-a")
 */
function renderStationHub(instanceId) {
  if (!el.sceneContainer || !el.sceneImage || !el.sceneHotspots) return;
  
  // HUB is a top-level room: always clear merchant overlays/state
  closeAllOverlays();
  
  const baseId = getBaseLocationId(instanceId);
  const hubDef = STATION_HUB_DEFS[baseId];
  if (!hubDef) {
    console.warn(`[HUB] No hub definition found for ${baseId}, falling back to EXTERIOR`);
    gameState.travel.currentSceneId = "EXTERIOR";
    renderScene(instanceId, "EXTERIOR");
    return;
  }
  
  // Initialize panel if needed
  if (!gameState.travel.stationHubPanelId) {
    gameState.travel.stationHubPanelId = hubDef.defaultPanelId;
  }
  
  const panel = hubDef.panels[gameState.travel.stationHubPanelId] || hubDef.panels[hubDef.defaultPanelId];
  if (!panel) {
    console.warn(`[HUB] Panel not found for ${baseId}. PanelId: ${gameState.travel.stationHubPanelId}`);
    return;
  }
  
  // Set background image
  const imagePath = panel.imagePath;
  el.sceneImage.onerror = () => {
    console.warn(`[HUB] Failed to load panel image: ${imagePath}`);
    el.sceneImage.removeAttribute("src");
    el.sceneImage.style.display = "none";
    el.sceneContainer.style.backgroundColor = "#1a1a1a";
  };
  el.sceneImage.onload = () => {
    el.sceneImage.style.display = "block";
    el.sceneContainer.style.backgroundColor = "transparent";
  };
  
  if (!imagePath) {
    el.sceneImage.style.display = "none";
    el.sceneContainer.style.backgroundColor = "#1a1a1a";
  } else {
    el.sceneImage.src = imagePath;
  }
  
  // Build hotspots
  const hotspots = [];
  
  // Turn left/right strips
  hotspots.push({
    shape: "rect",
    x: 0.0,
    y: 0.15,
    w: 0.12,
    h: 0.70,
    label: "TURN LEFT",
    action: { type: "TURN_PANEL", toPanelId: panel.turnLeft }
  });
  hotspots.push({
    shape: "rect",
    x: 0.88,
    y: 0.15,
    w: 0.12,
    h: 0.70,
    label: "TURN RIGHT",
    action: { type: "TURN_PANEL", toPanelId: panel.turnRight }
  });
  
  // Enter service hotspots
  (panel.enterActions || []).forEach(action => {
    hotspots.push({
      shape: "rect",
      x: action.hotspotRect.x,
      y: action.hotspotRect.y,
      w: action.hotspotRect.w,
      h: action.hotspotRect.h,
      label: action.label,
      action: { type: "ENTER_SERVICE", to: action.toSceneId }
    });
  });
  
  // UI actions (e.g., Leave Station)
  (panel.uiActions || []).forEach(action => {
    hotspots.push({
      shape: "rect",
      x: action.hotspotRect.x,
      y: action.hotspotRect.y,
      w: action.hotspotRect.w,
      h: action.hotspotRect.h,
      label: action.label,
      action: { type: action.actionType }
    });
  });
  
  // Clear old hotspots
  el.sceneHotspots.innerHTML = "";
  
  hotspots.forEach((hotspot, index) => {
    if (hotspot.shape === "rect") {
      const hotspotEl = document.createElement("div");
      hotspotEl.className = "scene-hotspot";
      hotspotEl.style.position = "absolute";
      hotspotEl.style.left = `${hotspot.x * 100}%`;
      hotspotEl.style.top = `${hotspot.y * 100}%`;
      hotspotEl.style.width = `${hotspot.w * 100}%`;
      hotspotEl.style.height = `${hotspot.h * 100}%`;
      hotspotEl.style.cursor = "pointer";
      hotspotEl.title = hotspot.label;
      hotspotEl.textContent = hotspot.label;
      hotspotEl.setAttribute("data-hotspot-index", String(index));
      
      hotspotEl.addEventListener("click", () => {
        dispatchAction(hotspot.action, instanceId);
      });
      
      el.sceneHotspots.appendChild(hotspotEl);
    }
  });
  
  // Hide overlay layer (merchant UIs) and show scene elements
  hideOverlayLayer();
  showSceneElements();
  
  // Show scene container, hide canvas
  if (el.canvas) {
    el.canvas.hidden = true;
    el.canvas.style.display = "none";
  }
  if (el.sceneContainer) {
    el.sceneContainer.hidden = false;
    el.sceneContainer.removeAttribute("hidden");
    el.sceneContainer.style.display = "flex";
    el.sceneContainer.style.visibility = "visible";
  }
}

/**
 * Render a scene (location view with hotspots)
 * @param {string} locationId Location ID
 * @param {string} sceneId Scene ID (e.g., "ARRIVAL", "EXTERIOR")
 */
function renderScene(locationId, sceneId) {
  if (!el.sceneContainer || !el.sceneImage || !el.sceneHotspots) return;
  
  // SAFETY GUARD: Check location definition exists before proceeding
  // Get instance ID from current location
  const instanceId = gameState.travel.currentLocationId || locationId;
  
  // Calculate baseId for logging and image path generation
  const baseId = getBaseLocationId(instanceId);
  
  // Use findLocationData which has proper fallback logic for asteroids, ships, etc.
  const locationDef = findLocationData(instanceId);
  
  // If location definition is missing, immediately fall back to MAP
  if (!locationDef) {
    const node = mapNodes.find(n => n.id === instanceId);
    const nodeType = node?.type || "unknown";
    console.warn(`[renderScene] Missing location definition, fallback to MAP. instanceId: ${instanceId}, nodeType: ${nodeType}`);
    gameState.travel.currentSceneId = "MAP";
    if (el.sceneContainer) {
      el.sceneContainer.hidden = true;
      el.sceneContainer.setAttribute("hidden", "");
      el.sceneContainer.style.display = "none";
    }
    if (el.canvas) {
      el.canvas.hidden = false;
      el.canvas.removeAttribute("hidden");
      el.canvas.style.display = "block";
      el.canvas.style.visibility = "visible";
    }
    drawMap();
    return;
  }
  
  // Use the location definition we found
  const location = locationDef;
  
  // EARLY CHECK: Special handling for station HUB scene
  if (location.type === "station" && sceneId === "HUB") {
    renderStationHub(instanceId);
    return;
  }
  
  // Asteroid scenes now render directly; event overlays are triggered by hotspots.
  
  // Check the scene exists
  const scene = locationDef.scenes?.[sceneId];
  if (!scene) {
    console.warn(`[renderScene] Scene ${sceneId} not found for location ${baseId} - returning to MAP`);
    gameState.travel.currentSceneId = "MAP";
    if (el.sceneContainer) {
      el.sceneContainer.hidden = true;
      el.sceneContainer.setAttribute("hidden", "");
      el.sceneContainer.style.display = "none";
    }
    if (el.canvas) {
      el.canvas.hidden = false;
      el.canvas.removeAttribute("hidden");
      el.canvas.style.display = "block";
      el.canvas.style.visibility = "visible";
    }
    drawMap();
    return;
  }
  
  const node = mapNodes.find(n => n.id === instanceId);
  const sceneHotspots = (location.type === "asteroid" && (sceneId === "EXTERIOR" || sceneId === "EXPLORE"))
    ? (sceneId === "EXTERIOR" ? buildAsteroidExteriorHotspots(node) : buildAsteroidExploreHotspots(node))
    : scene.hotspots;
  
  // Get image path - use scene.image if provided, otherwise generate from naming convention
  let imagePath;
  if (scene.image) {
    imagePath = scene.image;
  } else {
    // Generate image path using the instance ID and type (getSceneImagePath handles base ID conversion internally)
    imagePath = getSceneImagePath(sceneId, instanceId, location.type);
  }
  
  // Debug logging
  debugLog(`[renderScene] instanceId: ${instanceId}, baseId: ${baseId}, sceneId: ${sceneId}, location.type: ${location.type}`);
  debugLog(`[renderScene] Generated image path: ${imagePath}`);
  debugLog(`[renderScene] Scene has ${sceneHotspots.length} hotspots`);
  
  // Set background image (or placeholder if image doesn't exist)
  // Remove previous error handlers to prevent multiple bindings
  el.sceneImage.onerror = null;
  el.sceneImage.onload = null;
  
  el.sceneImage.style.backgroundColor = "#1a1a1a"; // Dark background as fallback
  el.sceneImage.alt = `Scene: ${sceneId} at ${location.name}`;
  
  // Set up robust error handler BEFORE setting src to catch immediate failures
  el.sceneImage.onerror = () => {
    // Image failed to load - show placeholder background
    // Only log once per unique path to prevent spam
    if (!el.sceneImage.dataset.errorLogged || el.sceneImage.dataset.errorPath !== imagePath) {
      console.warn(`[renderScene] Scene image missing: ${imagePath}`);
      el.sceneImage.dataset.errorLogged = "true";
      el.sceneImage.dataset.errorPath = imagePath;
    }
    // Remove src attribute to prevent repeated failed loads
    el.sceneImage.removeAttribute("src");
    el.sceneImage.style.display = "none";
    el.sceneContainer.style.backgroundColor = "#1a1a1a";
  };
  
  el.sceneImage.onload = () => {
    // Image loaded successfully
    el.sceneImage.style.display = "block";
    el.sceneContainer.style.backgroundColor = "transparent";
    // Clear error flag on successful load
    delete el.sceneImage.dataset.errorLogged;
    delete el.sceneImage.dataset.errorPath;
  };
  
  // Set src AFTER handlers are attached
  // If scene.image is null, still render hotspots (don't early return)
  // Show placeholder background if no image
  if (scene.image === null || !imagePath) {
    // No image - show placeholder but still render hotspots
    el.sceneImage.style.display = "none";
    el.sceneContainer.style.backgroundColor = "#1a1a1a";
  } else {
    el.sceneImage.src = imagePath;
  }
  
  // Clear old hotspots
  el.sceneHotspots.innerHTML = "";
  
  // Create or update scene title if it exists
  let sceneTitleEl = el.sceneContainer?.querySelector(".scene-title");
  if (scene.title) {
    if (!sceneTitleEl) {
      sceneTitleEl = document.createElement("div");
      sceneTitleEl.className = "scene-title";
      el.sceneContainer.appendChild(sceneTitleEl);
    }
    sceneTitleEl.textContent = scene.title;
    sceneTitleEl.style.display = "block";
  } else if (sceneTitleEl) {
    sceneTitleEl.style.display = "none";
  }
  
  debugLog(`[renderScene] Creating ${sceneHotspots.length} hotspots`);
  
  // Create hotspot elements
  sceneHotspots.forEach((hotspot, index) => {
    if (hotspot.shape === "rect") {
      const hotspotEl = document.createElement("div");
      hotspotEl.className = "scene-hotspot";
      hotspotEl.style.position = "absolute";
      hotspotEl.style.left = `${hotspot.x * 100}%`;
      hotspotEl.style.top = `${hotspot.y * 100}%`;
      hotspotEl.style.width = `${hotspot.w * 100}%`;
      hotspotEl.style.height = `${hotspot.h * 100}%`;
      hotspotEl.style.cursor = "pointer";
      hotspotEl.title = hotspot.label; // Tooltip
      hotspotEl.textContent = hotspot.label; // Display label text
      hotspotEl.setAttribute("data-hotspot-index", String(index));
      
      // Click handler with logging
      hotspotEl.addEventListener("click", () => {
        debugLog(`[Hotspot Click] baseId: ${baseId}, sceneId: ${sceneId}, label: ${hotspot.label}, action.type: ${hotspot.action.type}`);
        dispatchAction(hotspot.action, instanceId);
      });
      
      // Hover effect is handled by CSS, no need for JavaScript handlers
      
      el.sceneHotspots.appendChild(hotspotEl);
      debugLog(`[renderScene] Created hotspot: ${hotspot.label} at (${hotspot.x * 100}%, ${hotspot.y * 100}%) size (${hotspot.w * 100}%, ${hotspot.h * 100}%)`);
    }
  });
  
  debugLog(`[renderScene] Total hotspots in DOM: ${el.sceneHotspots.children.length}`);
  
        // Note: Outpost MERCHANT and station INTERIOR_MARKET are handled earlier (before scene rendering)
  // TRADE and COMBAT events are now shown directly from resolveAsteroidContact
  
  // Hide overlay layer (merchant UIs) and show scene elements for normal scenes
  hideOverlayLayer();
  showSceneElements();
  
  // Show scene container, hide canvas (for normal scenes)
  if (el.canvas) {
    el.canvas.hidden = true;
    el.canvas.style.display = "none";
  }
  if (el.sceneContainer) {
    el.sceneContainer.hidden = false;
    el.sceneContainer.removeAttribute("hidden");
    el.sceneContainer.style.display = "flex";
    el.sceneContainer.style.visibility = "visible";
    debugLog(`[renderScene] Scene container displayed. Container dimensions: ${el.sceneContainer.offsetWidth}x${el.sceneContainer.offsetHeight}`);
    debugLog(`[renderScene] Scene hotspots container dimensions: ${el.sceneHotspots.offsetWidth}x${el.sceneHotspots.offsetHeight}`);
  }
}

/**
 * Show station landing confirmation modal
 * @param {Node} stationNode The station node that was clicked
 */
function showStationLandingModal(stationNode) {
  if (!el.modalLayer) return;
  
  // Create modal content
  const modalContent = document.createElement("div");
  modalContent.className = "modal-content";
  modalContent.style.cssText = "max-width: 400px;";
  
  const title = document.createElement("h2");
  title.textContent = stationNode.name || "STATION";
  
  const message = document.createElement("p");
  message.textContent = "What would you like to do?";
  
  const buttonContainer = document.createElement("div");
  buttonContainer.style.cssText = "display: flex; gap: 15px; justify-content: center;";
  
  const landButton = document.createElement("button");
  landButton.textContent = "LAND";
  landButton.className = "modal-button";
  landButton.style.cssText = "flex: 1;";
  
  const stayButton = document.createElement("button");
  stayButton.textContent = "STAY IN ORBIT";
  stayButton.className = "modal-button";
  stayButton.style.cssText = "flex: 1;";
  
  // Land button: navigate to HUB
  landButton.addEventListener("click", () => {
    // Set current location to the station
    gameState.travel.currentLocationId = stationNode.id;
    gameState.travel.selectedLocationId = stationNode.id;
    gameState.travel.selectedDestinationId = null;
    // Navigate to HUB scene (station panorama)
    const baseId = getBaseLocationId(stationNode.id);
    const hubDef = STATION_HUB_DEFS[baseId];
    if (hubDef) {
      gameState.travel.stationHubPanelId = hubDef.defaultPanelId;
      gameState.travel.currentSceneId = "HUB";
    } else {
    gameState.travel.currentSceneId = "EXTERIOR";
    }
    hideModal();
    render();
  });
  
  // Stay in orbit button: close modal and stay on map
  stayButton.addEventListener("click", () => {
    // Don't set currentLocationId - we're staying in orbit, not landing
    // Just select the station for HUD display and stay on map
    gameState.travel.selectedLocationId = stationNode.id;
    gameState.travel.selectedDestinationId = stationNode.id;
    // Ensure we're on MAP view
    gameState.travel.currentSceneId = "MAP";
    hideModal();
    // Restart animation loop to keep map rendering
    startAnimationLoop();
    render();
  });
  
  buttonContainer.appendChild(landButton);
  buttonContainer.appendChild(stayButton);
  
  modalContent.appendChild(title);
  modalContent.appendChild(message);
  modalContent.appendChild(buttonContainer);
  
  // Clear and show modal
  el.modalLayer.innerHTML = "";
  el.modalLayer.appendChild(modalContent);
  el.modalLayer.hidden = false;
}

/**
 * Build asteroid exterior hotspots based on truth values
 * @param {Node|null} node Asteroid node
 * @returns {Array<Object>} Hotspot list
 */
function buildAsteroidExteriorHotspots(node) {
  const hotspots = [];
  if (node && node.inhabitedTruth === undefined) {
    generateAsteroidTruthValues(node);
  }
  hotspots.push({
    shape: "rect",
    x: 0.35,
    y: 0.62,
    w: 0.30,
    h: 0.10,
    label: "Explore",
    action: { type: "ASTEROID_EXPLORE_SCENE" }
  });
  if (node && node.inhabitedTruth) {
    hotspots.push({
      shape: "rect",
      x: 0.35,
      y: 0.75,
      w: 0.30,
      h: 0.10,
      label: "Approach Structure",
      action: { type: "ASTEROID_APPROACH" }
    });
    hotspots.push({
      shape: "rect",
      x: 0.35,
      y: 0.88,
      w: 0.30,
      h: 0.10,
      label: "Leave",
      action: { type: "ASTEROID_LEAVE" }
    });
    return hotspots;
  }
  hotspots.push({
    shape: "rect",
    x: 0.35,
    y: 0.75,
    w: 0.30,
    h: 0.10,
    label: "Leave",
    action: { type: "ASTEROID_LEAVE" }
  });
  return hotspots;
}

/**
 * Build asteroid explore-area hotspots
 * @param {Node|null} node Asteroid node
 * @returns {Array<Object>} Hotspot list
 */
function buildAsteroidExploreHotspots(node) {
  return [
    {
      shape: "rect",
      x: 0.30,
      y: 0.62,
      w: 0.20,
      h: 0.10,
      label: "Vista Point",
      action: { type: "ASTEROID_VISTA" }
    },
    {
      shape: "rect",
      x: 0.52,
      y: 0.62,
      w: 0.20,
      h: 0.10,
      label: "Hunt / Scavenge",
      action: { type: "ASTEROID_HUNT" }
    },
    {
      shape: "rect",
      x: 0.35,
      y: 0.85,
      w: 0.30,
      h: 0.10,
      label: "Leave",
      action: { type: "ASTEROID_RETURN_EXTERIOR" }
    }
  ];
}

function startAsteroidOutcome(asteroidId, title, body, outcomeText) {
  startEvent({
    phase: "OUTCOME",
    title,
    body: body || "",
    options: ["", "", ""],
    outcomeText,
    image: null,
    onContinue: () => {
      gameState.travel.currentSceneId = "EXTERIOR";
      endEvent();
      render();
    }
  });
}

function startAsteroidContactOutcome(asteroidId, title, body, outcomeText) {
  startEvent({
    phase: "OUTCOME",
    title,
    body: body || "",
    options: ["", "", ""],
    outcomeText,
    image: null,
    onContinue: () => {
      showAsteroidContactMenu(asteroidId);
    }
  });
}

function handleAsteroidExploreScene(asteroidId) {
  gameState.travel.currentSceneId = "EXPLORE";
  render();
}

function handleAsteroidVista(asteroidId) {
  advanceDays(1);
  const vistaResult = applyVistaRelief(asteroidId);
  const node = mapNodes.find(n => n.id === asteroidId);
  startAsteroidOutcome(
    asteroidId,
    "VISTA POINT",
    "",
    vistaResult.message || "You find a quiet overlook and catch your breath."
  );
  if (node) {
    logAdd("ASTEROID_EXPLORE", `Day ${gameState.stats.day}: Found a vista on ${node.name}.`, {
      locationId: asteroidId
    });
  }
}

function handleAsteroidHunt(asteroidId) {
  advanceDays(1);
  const node = mapNodes.find(n => n.id === asteroidId);
  let outcomeText = "You scour the area, but come up empty-handed.";
  const roll = Math.random();
  if (roll < 0.45) {
    const creditsFound = rollInt(20, 80);
    gameState.stats.credits += creditsFound;
    outcomeText = `You recover a small cache of credits (${creditsFound}c).`;
    if (node) {
      logAdd("ASTEROID_EXPLORE", `Day ${gameState.stats.day}: Found ${creditsFound}c on ${node.name}.`, {
        locationId: asteroidId
      });
    }
  } else if (roll < 0.80) {
    const supplies = Object.values(SUPPLY_DEFS).filter(def => def.tier === "OUTPOST");
    if (supplies.length > 0) {
      const supply = supplies[Math.floor(Math.random() * supplies.length)];
      addItemToInventory(supply.id, 1, "supply");
      outcomeText = `You salvage a ${supply.name}.`;
      if (node) {
        logAdd("ASTEROID_EXPLORE", `Day ${gameState.stats.day}: Salvaged ${supply.name} on ${node.name}.`, {
          locationId: asteroidId,
          itemId: supply.id
        });
      }
    }
  } else if (roll < 0.90) {
    const damage = rollInt(1, 3);
    addShipIntegrity(gameState, -damage);
    outcomeText = `A sharp outcrop scrapes the hull (-${damage}%).`;
    if (node) {
      logAdd("ASTEROID_EXPLORE", `Day ${gameState.stats.day}: Minor hull damage on ${node.name}.`, {
        locationId: asteroidId
      });
    }
  }
  startAsteroidOutcome(asteroidId, "HUNT / SCAVENGE", "", outcomeText);
}

function handleAsteroidApproachStructure(asteroidId) {
  const node = mapNodes.find(n => n.id === asteroidId);
  if (!node || node.type !== "asteroid") {
    return;
  }
  const abandoned = Math.random() < 0.2;
  if (abandoned) {
    handleAsteroidAbandonedStructure(asteroidId);
    return;
  }
  startEvent({
    phase: "PROMPT",
    title: "MAKE CONTACT?",
    body: "A structure sits half-buried in regolith. The airlock lights respond to your scan.",
    options: ["YES", "NO", ""],
    optionHandlers: [
      () => {
        endEvent();
        handleAsteroidContactOutcome(asteroidId);
      },
      () => {
        startAsteroidOutcome(asteroidId, "RETREAT", "", "You back away from the structure and return to your ship.");
      },
      null
    ]
  });
}

function handleAsteroidAbandonedStructure(asteroidId) {
  const abandonedFlavors = [
    {
      title: "ABANDONED OUTPOST",
      body: "The structure is real, but dead. A thin film of dust coats the airlock. Your comm pings once—then goes silent. Whatever kept this place alive is long gone."
    },
    {
      title: "NO ONE HOME",
      body: "You approach the cabin and find the door half-sealed with tape and old weld marks. Inside: empty bunks, stripped wiring, and a stale smell that never belongs in vacuum."
    },
    {
      title: "STRIPPED CLEAN",
      body: "The exterior looks inhabited from a distance. Up close it’s all scavenged metal and missing panels. Someone took anything valuable—and left in a hurry."
    },
    {
      title: "DEAD SIGNAL",
      body: "Your scanner registers a faint power source… then nothing. The lights are out. The walls are cold. Only old boot prints remain, half-erased by drifting grit."
    },
    {
      title: "LEFT BEHIND",
      body: "A cracked helmet sits by the hatch like a warning. The interior is quiet and orderly, almost too orderly—like the occupants expected to return and never did."
    },
    {
      title: "EMPTY SHELL",
      body: "The cabin is intact, but the comm array is snapped and the storage lockers hang open. Whoever lived here either moved on—or got pulled off the rock."
    },
    {
      title: "OLD CAMP",
      body: "A makeshift shelter clings to the rock with anchor bolts. The cookware is still there. The bedrolls are still there. The people aren’t."
    },
    {
      title: "SILENCE",
      body: "You knock on the hatch out of habit. No response. No vibration through the suit. Just your own breathing and the slow realization that this place is abandoned."
    }
  ];
  const node = mapNodes.find(n => n.id === asteroidId);
  const flavor = abandonedFlavors[Math.floor(Math.random() * abandonedFlavors.length)];
  const lootRoll = Math.random();
  const lootLines = {
    credits: [
      "You find a sealed credit chit wedged behind a loose panel.",
      "A small stash of credits sits inside a taped emergency pouch."
    ],
    items: [
      "You recover a few supplies left in a rusted locker.",
      "A maintenance kit is still strapped to the wall, unopened."
    ],
    none: [
      "You find nothing worth hauling back."
    ]
  };
  let outcomeText = flavor.body;
  if (lootRoll < 0.5) {
    const creditsFound = rollInt(20, 80);
    gameState.stats.credits += creditsFound;
    const line = lootLines.credits[Math.floor(Math.random() * lootLines.credits.length)];
    outcomeText = `${flavor.body}\n\n${line} (+${creditsFound}c)`;
    if (node) {
      logAdd("ASTEROID_STRUCTURE", `Day ${gameState.stats.day}: Found ${creditsFound}c at abandoned structure on ${node.name}.`, {
        locationId: asteroidId
      });
    }
  } else if (lootRoll < 0.85) {
    const lootPool = [
      { id: "air_canister_s", type: "supply" },
      { id: "air_canister_m", type: "supply" },
      { id: "med_gel", type: "supply" },
      { id: "repair_emergency_kit", type: "part" },
      { id: "repair_welding_kit", type: "part" },
      { id: "repair_wiring_kit", type: "part" },
      { id: "repair_air_filter", type: "part" }
    ];
    const item = lootPool[Math.floor(Math.random() * lootPool.length)];
    addItemToInventory(item.id, 1, item.type);
    const line = lootLines.items[Math.floor(Math.random() * lootLines.items.length)];
    const itemName = SUPPLY_DEFS[item.id]?.name || SHIP_PART_DEFS[item.id]?.name || "supplies";
    outcomeText = `${flavor.body}\n\n${line} (+${itemName})`;
    if (node) {
      logAdd("ASTEROID_STRUCTURE", `Day ${gameState.stats.day}: Recovered ${itemName} at abandoned structure on ${node.name}.`, {
        locationId: asteroidId,
        itemId: item.id
      });
    }
  } else if (lootRoll < 0.95) {
    const lootPool = [
      { id: "air_canister_s", type: "supply" },
      { id: "air_canister_m", type: "supply" },
      { id: "med_gel", type: "supply" },
      { id: "repair_emergency_kit", type: "part" },
      { id: "repair_welding_kit", type: "part" },
      { id: "repair_wiring_kit", type: "part" },
      { id: "repair_air_filter", type: "part" }
    ];
    const first = lootPool[Math.floor(Math.random() * lootPool.length)];
    let second = lootPool[Math.floor(Math.random() * lootPool.length)];
    addItemToInventory(first.id, 1, first.type);
    addItemToInventory(second.id, 1, second.type);
    const line = lootLines.items[Math.floor(Math.random() * lootLines.items.length)];
    const firstName = SUPPLY_DEFS[first.id]?.name || SHIP_PART_DEFS[first.id]?.name || "supplies";
    const secondName = SUPPLY_DEFS[second.id]?.name || SHIP_PART_DEFS[second.id]?.name || "supplies";
    outcomeText = `${flavor.body}\n\n${line} (+${firstName}, ${secondName})`;
    if (node) {
      logAdd("ASTEROID_STRUCTURE", `Day ${gameState.stats.day}: Recovered ${firstName} and ${secondName} at abandoned structure on ${node.name}.`, {
        locationId: asteroidId
      });
    }
  } else {
    const line = lootLines.none[0];
    outcomeText = `${flavor.body}\n\n${line}`;
    if (node) {
      logAdd("ASTEROID_STRUCTURE", `Day ${gameState.stats.day}: Abandoned structure empty on ${node.name}.`, {
        locationId: asteroidId
      });
    }
  }
  startAsteroidOutcome(asteroidId, flavor.title, "", outcomeText);
}

function handleAsteroidContactOutcome(asteroidId) {
  const node = mapNodes.find(n => n.id === asteroidId);
  if (!node) return;
  const roll = Math.random();
  let contactType = "hostile";
  if (roll < 0.4) {
    contactType = "trader";
  } else if (roll < 0.75) {
    contactType = "talk";
  }
  gameState.travel.activeContact = {
    asteroidId,
    contactType
  };
  if (contactType === "hostile") {
    const damage = rollInt(2, 6);
    addShipIntegrity(gameState, -damage);
    gameState.travel.activeContact = null;
    startAsteroidOutcome(
      asteroidId,
      "HOSTILE CONTACT",
      "",
      `A burst of fire cracks the air. You retreat fast, but the hull takes ${damage}% damage.`
    );
    logAdd("ASTEROID_CONTACT", `Day ${gameState.stats.day}: Hostile contact on ${node.name}.`, {
      locationId: asteroidId
    });
    return;
  }
  showAsteroidContactMenu(asteroidId);
}

function getAsteroidContactFlavor(contactType) {
  if (contactType === "trader") {
    return {
      title: "CONTACT",
      body: "An airlock hisses. A figure steps out—patched suit, calm posture.\nThey keep one hand near a tool belt, not a weapon.\n“You’re far off-lane,” they say. “If you’ve got credits, I’ve got goods.”"
    };
  }
  return {
    title: "CONTACT",
    body: "A voice answers your hail—dry, amused.\nYou don’t see their face, only movement behind a scratched viewport.\n“Didn’t think anyone still landed out here on purpose.”"
  };
}

function getAsteroidGoodbyeText() {
  const options = [
    "You exchange a final nod and step back toward your ship.",
    "The channel goes quiet as you end the transmission.",
    "The figure retreats into the structure, leaving the asteroid silent once more."
  ];
  return options[Math.floor(Math.random() * options.length)];
}

function showAsteroidContactMenu(asteroidId) {
  const activeContact = gameState.travel.activeContact;
  if (!activeContact || activeContact.asteroidId !== asteroidId) {
    return;
  }
  const contactType = activeContact.contactType;
  const flavor = getAsteroidContactFlavor(contactType);
  const canTrade = contactType === "trader";
  const canTalk = contactType === "trader" || contactType === "talk";
  const tradeLabel = canTrade ? "TRADE" : "NOT INTERESTED IN TRADE";
  const talkLabel = canTalk ? "TALK" : "NOT INTERESTED IN TALK";
  activeContact.state = "menu";
  startEvent({
    phase: "PROMPT",
    title: flavor.title,
    body: flavor.body,
    options: [tradeLabel, talkLabel, "LEAVE"],
    optionHandlers: [
      canTrade
        ? () => {
            endEvent();
            gameState.travel.returnSceneId = "EXTERIOR";
            openTraderMerchant(asteroidId);
          }
        : () => {},
      canTalk
        ? () => {
            endEvent();
            handleAsteroidTalk(asteroidId);
          }
        : () => {},
      () => {
        const goodbye = getAsteroidGoodbyeText();
        gameState.travel.activeContact = null;
        startAsteroidOutcome(asteroidId, "GOODBYE", "", goodbye);
      }
    ]
  });
}

function handleAsteroidTalk(asteroidId) {
  const node = mapNodes.find(n => n.id === asteroidId);
  let rumorText = "They share a few wary words, then fall silent.";
  const candidates = mapNodes.filter(n => n.type === "asteroid" && n.id !== asteroidId);
  if (candidates.length > 0 && Math.random() < 0.6) {
    const target = selectRumorTargetFromCurrentLocation();
    if (target) {
      rumorText = `They mention strange signals near ${target.name}.`;
      setRumorTarget(target.id, rumorText, "ASTEROID_RUMOR");
    } else {
      rumorText = "Nothing solid—just stories.";
      clearRumorTarget("ASTEROID_RUMOR");
    }
  } else {
    rumorText = "They share a few wary words, then fall silent.";
    gameState.travel.lastRumorText = rumorText;
    logAdd("ASTEROID_RUMOR", `Day ${gameState.stats.day}: ${rumorText}`, {
      locationId: asteroidId
    });
  }
  startAsteroidContactOutcome(asteroidId, "QUIET EXCHANGE", "", rumorText);
}

/**
 * Handle leaving asteroid (common cleanup logic)
 * @param {string} asteroidId Asteroid node ID
 */
function handleAsteroidLeave(asteroidId) {
  if (gameState.travel.activeRumorAsteroidIds && gameState.travel.activeRumorAsteroidIds.has(asteroidId)) {
    gameState.travel.activeRumorAsteroidIds.delete(asteroidId);
  }
  if (!gameState.travel.completedRumorAsteroidIds) {
    gameState.travel.completedRumorAsteroidIds = new Set();
  }
  gameState.travel.completedRumorAsteroidIds.add(asteroidId);
  closeAllOverlays();
  gameState.travel.returnSceneId = null;
  // Finalize landing summary before leaving
  logFinalizeLandingSummary();
  // Return to MAP - keep currentLocationId (player is still at this location)
  // Only clear selected/destination IDs so player can select new destinations
  gameState.travel.currentSceneId = "MAP";
  // Keep currentLocationId - player is still at the asteroid, just viewing from map
  // gameState.travel.currentLocationId stays as asteroidId
  gameState.travel.selectedLocationId = null;
  gameState.travel.selectedDestinationId = null;
  // Ensure we're not in a traveling or waiting state
  gameState.travel.isTraveling = false;
  gameState.travel.isWaiting = false;
  if (gameState.travel.waitIntervalId !== null) {
    clearInterval(gameState.travel.waitIntervalId);
    gameState.travel.waitIntervalId = null;
  }
  // Clear any active scan pulse
  if (gameState.travel.scanPulse.isActive) {
    gameState.travel.scanPulse.isActive = false;
    gameState.travel.scanPulse.startTime = null;
  }
  // Ensure canvas is visible and scene container is hidden BEFORE render
  if (el.canvas) {
    el.canvas.hidden = false;
    el.canvas.removeAttribute("hidden");
    el.canvas.style.display = "block";
    el.canvas.style.visibility = "visible";
  }
  if (el.sceneContainer) {
    el.sceneContainer.hidden = true;
    el.sceneContainer.setAttribute("hidden", "");
    el.sceneContainer.style.display = "none";
    el.sceneContainer.style.visibility = "hidden";
    // Ensure scene container can't block interactions
    el.sceneContainer.style.pointerEvents = "none";
  }
  // Ensure we're on TRAVEL tab (use setTab to update UI - this calls render())
  setTab("TRAVEL");
  // Explicitly draw the map immediately (don't wait for animation loop)
  drawMap();
  startAnimationLoop(); // Restart animation loop when returning to map
}

/**
 * Show asteroid ARRIVAL event (new landing flow)
 * @param {string} asteroidId Asteroid node ID
 */
function showAsteroidArrivalEvent(asteroidId) {
  const node = mapNodes.find(n => n.id === asteroidId);
  if (!node || node.type !== "asteroid") {
    console.warn("[ASTEROID ARRIVAL] Node not found or not an asteroid:", asteroidId);
    return;
  }
  
  // Ensure truth values are generated
  generateAsteroidTruthValues(node);
  
  const landingFlavorText = gameState.travel.landingFlavorText;
  gameState.travel.landingFlavorText = null;
  
  // Log landing
  logAdd("LANDING_SUMMARY", `Day ${gameState.stats.day}: Landed on ${node.name}.`, {
    locationId: asteroidId,
    locationName: node.name,
    locationType: "asteroid"
  });
  
  // ARRIVAL event: Simple Explore/Leave options
  const baseBody = "You've successfully landed on the asteroid. The surface stretches out before you, silent and still.";
  const body = landingFlavorText ? `${landingFlavorText}\n\n${baseBody}` : baseBody;
  
  const eventData = {
    title: node.name,
    body,
    options: ["Explore", "Leave", ""],
    image: null,
    optionHandlers: [
      () => {
        // Explore option
        // Set scene to MAP BEFORE ending event to prevent render() from re-triggering arrival event
        gameState.travel.currentSceneId = "MAP";
        endEvent();
        handleAsteroidExplore(asteroidId);
      },
      () => {
        // Leave option
        // Set scene to MAP BEFORE ending event to prevent render() from re-triggering arrival event
        gameState.travel.currentSceneId = "MAP";
        endEvent();
        handleAsteroidLeave(asteroidId);
      },
      null // Empty third option
    ]
  };
  
  startEvent(eventData);
}

/**
 * Show asteroid exterior event (converted from modal to event system)
 * @param {string} asteroidId Asteroid node ID
 * @deprecated - Replaced by showAsteroidArrivalEvent
 */
function showAsteroidExteriorModal(asteroidId) {
  const node = mapNodes.find(n => n.id === asteroidId);
  if (!node || node.type !== "asteroid") {
    console.warn("[ASTEROID MODAL] Node not found or not an asteroid:", asteroidId);
    return;
  }
  
  // Check if deep scanned
  const isDeepScanned = gameState.travel.deepScannedNodes && gameState.travel.deepScannedNodes.has(asteroidId);
  const inhabited = node.inhabited || "unknown";
  
  // Determine modal case
  let modalText = "";
  let showContactButton = false;
  
  if (!isDeepScanned) {
    // Case C: No deep scan performed
    modalText = "Insufficient scan data. Proceed with caution.";
    showContactButton = true;
  } else if (inhabited === "unlikely") {
    // Case A: Inhabited: Unlikely
    modalText = "The surface appears barren. No signs of life or activity.";
    showContactButton = false;
  } else {
    // Case B: Inhabited: Likely or Unknown
    modalText = "Signs of life detected beneath the surface. Attempt contact?";
    showContactButton = true;
  }
  
  // Log landing
  logAdd("LANDING_SUMMARY", `Day ${gameState.stats.day}: Landed on ${node.name}.`, {
    locationId: asteroidId,
    locationName: node.name,
    locationType: "asteroid"
  });
  
  // Build options array
  const options = [];
  const optionHandlers = [];
  
  if (showContactButton) {
    options.push("Make Contact");
    optionHandlers.push(() => {
      endEvent();
      resolveAsteroidContact(asteroidId);
    });
  }
  
  options.push("Leave");
  optionHandlers.push(() => {
    endEvent();
    handleAsteroidLeave(asteroidId);
  });
  
  // Pad to 3 options if needed (event system expects 3)
  while (options.length < 3) {
    options.push(""); // Empty option (will be hidden)
    optionHandlers.push(null);
  }
  
  // Store asteroidId in event data for later use
  const eventData = {
    title: node.name,
    body: modalText,
    options: options,
    image: null,
    optionHandlers: optionHandlers
  };
  
  // Start event with custom option handlers
  startEvent(eventData);
}

/**
 * Handle asteroid exploration (branches based on inhabitedTruth)
 * @param {string} asteroidId Asteroid node ID
 */
function handleAsteroidExplore(asteroidId) {
  const node = mapNodes.find(n => n.id === asteroidId);
  if (!node || node.type !== "asteroid") {
    console.warn("[ASTEROID EXPLORE] Node not found or not an asteroid:", asteroidId);
    return;
  }
  
  // Check if asteroid is already cleared
  if (gameState.travel.clearedAsteroids && gameState.travel.clearedAsteroids.has(asteroidId)) {
    // Already searched - show "ALREADY SEARCHED" outcome
    const eventData = {
      phase: "OUTCOME",
      title: "ALREADY SEARCHED",
      body: "",
      options: ["", "", ""],
      outcomeText: "You cover familiar ground. Nothing new turns up.",
      image: null,
      onContinue: () => {
        gameState.travel.currentSceneId = "MAP";
        endEvent();
        handleAsteroidLeave(asteroidId);
      }
    };
    startEvent(eventData);
    return;
  }
  
  // Ensure truth values exist
  generateAsteroidTruthValues(node);
  
  // Debug logging
  debugLog("[ASTEROID EXPLORE] Asteroid", asteroidId, "truth values:", {
    inhabitedTruth: node.inhabitedTruth,
    resourcesTruth: node.resourcesTruth,
    artifactTruth: node.artifactTruth
  });
  
  // Check inhabited truth
  if (node.inhabitedTruth === true) {
    // INHABITED TRACK: Show "SIGNS OF LIFE" prompt
    const eventData = {
      title: "SIGNS OF LIFE",
      body: "After surveying the immediate area, you notice signs of habitation.\nA crude cabin sits half-buried in regolith.\nA skull-and-crossbones flag flaps weakly in the distance.",
      options: ["Make Contact", "Back Away", ""],
      image: null,
      optionHandlers: [
        () => {
          // Make Contact
          // Set scene to MAP BEFORE ending event to prevent render() from re-triggering arrival event
          gameState.travel.currentSceneId = "MAP";
          endEvent();
          handleAsteroidMakeContact(asteroidId);
        },
        () => {
          // Back Away
          // Set scene to MAP BEFORE ending event to prevent render() from re-triggering arrival event
          gameState.travel.currentSceneId = "MAP";
          endEvent();
          handleAsteroidBackAway(asteroidId);
        },
        null
      ]
    };
    startEvent(eventData);
  } else {
    showAsteroidSurveyChoices(asteroidId);
  }
}

function getActiveRumorForAsteroid(asteroidId) {
  return gameState.travel.purchasedRumors?.[asteroidId] || null;
}

function markRumorResolved(asteroidId, resultText) {
  const rumor = getActiveRumorForAsteroid(asteroidId);
  if (!rumor) return;
  gameState.travel.completedRumors[asteroidId] = {
    ...rumor,
    completedDay: gameState.stats.day,
    resultText,
  };
  delete gameState.travel.purchasedRumors[asteroidId];
  gameState.travel.activeRumorAsteroidIds?.delete(asteroidId);
  gameState.travel.rumoredNodes?.delete(asteroidId);
  gameState.travel.completedRumorAsteroidIds?.add(asteroidId);
  logAdd("RUMOR_RESOLVED", `Day ${gameState.stats.day}: ${resultText}`, {
    targetId: asteroidId,
    rumorKind: rumor.kind,
    isTrue: rumor.isTrue,
  });
}

function grantAsteroidResources(asteroidId, mode = "quick") {
  const node = mapNodes.find(n => n.id === asteroidId);
  const rumor = getActiveRumorForAsteroid(asteroidId);
  const hasResourceLead = rumor && rumor.isTrue && rumor.kind === "resource";
  const hasCreditLead = rumor && rumor.isTrue && rumor.kind === "credits";
  const resourcesLikely = node?.resourcesTruth === true || hasResourceLead || Math.random() < getCrewBonus("prospecting");
  const rewards = [];

  if (resourcesLikely) {
    const airQty = mode === "drill" ? 2 : 1;
    gameState.inventory.supplies.air_canister_m = gameState.inventory.supplies.air_canister_m || { id: "air_canister_m", qty: 0 };
    gameState.inventory.supplies.air_canister_m.qty += airQty;
    rewards.push(`${airQty} medium air canister${airQty > 1 ? "s" : ""}`);

    if (mode !== "quick") {
      const partId = mode === "drill" ? "repair_welding_kit" : "repair_emergency_kit";
      gameState.inventory.parts[partId] = (gameState.inventory.parts[partId] || 0) + 1;
      rewards.push(SHIP_PART_DEFS[partId].name);
    }
  }

  if (hasCreditLead || (!resourcesLikely && Math.random() < 0.35)) {
    const credits = hasCreditLead ? rollInt(120, 220) : rollInt(35, 85);
    gameState.stats.credits += credits;
    rewards.push(`${credits} credits`);
  }

  return rewards;
}

function makeAsteroidClearedContinue(asteroidId, resultText = null) {
  return () => {
    if (!gameState.travel.clearedAsteroids) {
      gameState.travel.clearedAsteroids = new Set();
    }
    gameState.travel.clearedAsteroids.add(asteroidId);
    if (resultText) {
      markRumorResolved(asteroidId, resultText);
    }
    gameState.travel.currentSceneId = "MAP";
    endEvent();
    handleAsteroidLeave(asteroidId);
  };
}

function showAsteroidSurveyChoices(asteroidId) {
  const node = mapNodes.find(n => n.id === asteroidId);
  if (!node) return;
  const rumor = getActiveRumorForAsteroid(asteroidId);
  const rumorLine = rumor
    ? `\nRumor lead: ${rumor.isTrue ? "credible" : "questionable"} ${rumor.kind}.`
    : "";
  startEvent({
    title: "SURFACE SURVEY",
    body: `The rock is quiet. You can make a fast pass, spend time surveying carefully, or drill into promising seams.${rumorLine}`,
    options: ["Quick Sweep", "Careful Survey (+1 day)", "Drill / Extract (+1 day, risk)"],
    optionHandlers: [
      () => runAsteroidSurvey(asteroidId, "quick"),
      () => runAsteroidSurvey(asteroidId, "careful"),
      () => runAsteroidSurvey(asteroidId, "drill"),
    ]
  });
}

function runAsteroidSurvey(asteroidId, mode) {
  const node = mapNodes.find(n => n.id === asteroidId);
  if (!node) return;
  if (mode !== "quick") {
    advanceDays(1);
    if (isRunOver()) return;
  }

  const hazardChance = mode === "drill" ? 0.28 : mode === "careful" ? 0.08 : 0.14;
  if (Math.random() < hazardChance) {
    const damage = mode === "drill" ? rollInt(4, 10) : rollInt(2, 6);
    applyShipDamage(damage, `${mode} asteroid survey on ${node.name}`);
    if (isRunOver()) return;
  }

  if (node.artifactTruth === true && (mode !== "quick" || Math.random() < 0.55)) {
    grantRandomArtifact("ASTEROID", asteroidId);
    startEvent({
      phase: "OUTCOME",
      title: "ANOMALOUS FIND",
      outcomeText: "A careful pass catches an impossible glint below the dust. You recover an artifact.",
      options: ["", "", ""],
      onContinue: makeAsteroidClearedContinue(asteroidId, "The rumor paid off with an artifact find.")
    });
    return;
  }

  const rewards = grantAsteroidResources(asteroidId, mode);
  if (rewards.length > 0) {
    const result = `Surveyed ${node.name} and recovered ${rewards.join(", ")}.`;
    startEvent({
      phase: "OUTCOME",
      title: "USEFUL SALVAGE",
      outcomeText: result,
      options: ["", "", ""],
      onContinue: makeAsteroidClearedContinue(asteroidId, result)
    });
    logAdd("RESOURCE", `Day ${gameState.stats.day}: ${result}`, { locationId: asteroidId });
    return;
  }

  const eventData = rollUninhabitedOutcome(asteroidId, false);
  const rumor = getActiveRumorForAsteroid(asteroidId);
  if (rumor) {
    const originalContinue = eventData.onContinue;
    const resultText = rumor.isTrue
      ? `The lead at ${node.name} resolved with a minor find.`
      : `The rumor about ${node.name} proved false.`;
    eventData.onContinue = () => {
      markRumorResolved(asteroidId, resultText);
      if (originalContinue) originalContinue();
    };
  }
  startEvent(eventData);
}

/**
 * Handle uninhabited asteroid exploration (with artifact integration)
 * @param {string} asteroidId Asteroid node ID
 */
function handleAsteroidUninhabitedExplore(asteroidId) {
  const node = mapNodes.find(n => n.id === asteroidId);
  if (!node || node.type !== "asteroid") return;
  
  let eventData;
  
  if (node.artifactTruth === true) {
    // Artifact exists: 60% artifact find, 40% normal outcomes
    const rand = Math.random();
    if (rand < 0.6) {
      // Artifact find outcome
      const artifact = grantRandomArtifact("ASTEROID", asteroidId);
      eventData = {
        phase: "OUTCOME",
        title: "ANOMALOUS FIND",
        body: "",
        options: ["", "", ""],
        outcomeText: "Something glints in the regolith. You dig it free—an artifact, strange and intact.",
        image: null,
        onContinue: () => {
          // Mark asteroid as cleared
          if (!gameState.travel.clearedAsteroids) {
            gameState.travel.clearedAsteroids = new Set();
          }
          gameState.travel.clearedAsteroids.add(asteroidId);
          // Set scene to MAP BEFORE ending event to prevent render() from re-triggering arrival event
    gameState.travel.currentSceneId = "MAP";
          endEvent();
          // handleAsteroidLeave also sets currentSceneId = "MAP" and calls render(), but that's fine
          handleAsteroidLeave(asteroidId);
        }
      };
    } else {
      // 40%: Normal uninhabited outcomes
      eventData = rollUninhabitedOutcome(asteroidId, false); // false = no artifact (already rolled)
    }
  } else {
    // No artifact: roll normal uninhabited outcomes
    eventData = rollUninhabitedOutcome(asteroidId, false);
  }
  
  startEvent(eventData);
}

/**
 * Roll uninhabited asteroid outcomes (Dead Astronaut, Vista, Nothing)
 * @param {string} asteroidId Asteroid node ID
 * @param {boolean} artifactAvailable Whether artifact is available (for future use)
 * @returns {Object} Event data object
 */
function rollUninhabitedOutcome(asteroidId, artifactAvailable) {
  const node = mapNodes.find(n => n.id === asteroidId);
  if (!node) return null;
  
  const rand = Math.random();
  let eventData;
  
  // Helper to mark asteroid as cleared and return to map
  const markClearedAndContinue = () => {
    if (!gameState.travel.clearedAsteroids) {
      gameState.travel.clearedAsteroids = new Set();
    }
    gameState.travel.clearedAsteroids.add(asteroidId);
    // Set scene to MAP BEFORE ending event to prevent render() from re-triggering arrival event
    gameState.travel.currentSceneId = "MAP";
    endEvent();
    // handleAsteroidLeave also sets currentSceneId = "MAP" and calls render(), but that's fine
    handleAsteroidLeave(asteroidId);
  };
  
  if (rand < 0.33) {
    // Outcome 1: Dead astronaut (+50 credits)
    const creditsGained = 50;
    gameState.stats.credits += creditsGained;
    eventData = {
      phase: "OUTCOME",
      title: "BODY IN THE DUST",
      body: "",
      options: ["", "", ""],
      outcomeText: "You discover the remains of a long-dead astronaut. Their suit's emergency beacon still functions, and you recover 50 credits worth of salvage.",
      image: null,
      onContinue: markClearedAndContinue
    };
    logAdd("RANDOM_EVENT", `Day ${gameState.stats.day}: Found dead astronaut on ${node.name}. Gained ${creditsGained} credits.`, {
      locationId: asteroidId
    });
  } else if (rand < 0.66) {
    // Outcome 2: Vista (morale benefit)
    const vistaResult = applyVistaRelief(asteroidId);
    eventData = {
      phase: "OUTCOME",
      title: "QUIET VISTA",
      body: "",
      options: ["", "", ""],
      outcomeText: vistaResult.message,
      image: null,
      onContinue: markClearedAndContinue
    };
    logAdd("RANDOM_EVENT", `Day ${gameState.stats.day}: Found peaceful vista on ${node.name}. ${vistaResult.message}`, {
      locationId: asteroidId,
      crewId: vistaResult.crewId
    });
  } else {
    // Outcome 3: Nothing
    eventData = {
      phase: "OUTCOME",
      title: "DEAD ROCK",
      body: "",
      options: ["", "", ""],
      outcomeText: "You explore the surface for hours, but find nothing of interest. The asteroid is barren and empty.",
      image: null,
      onContinue: markClearedAndContinue
    };
    logAdd("RANDOM_EVENT", `Day ${gameState.stats.day}: Explored ${node.name} but found nothing.`, {
      locationId: asteroidId
    });
  }
  
  return eventData;
}

/**
 * Handle "Back Away" from inhabited asteroid (with artifact integration)
 * @param {string} asteroidId Asteroid node ID
 */
function handleAsteroidBackAway(asteroidId) {
  const node = mapNodes.find(n => n.id === asteroidId);
  if (!node || node.type !== "asteroid") return;
  
  // Helper to mark asteroid as cleared and return to map
  const markClearedAndContinue = () => {
    if (!gameState.travel.clearedAsteroids) {
      gameState.travel.clearedAsteroids = new Set();
    }
    gameState.travel.clearedAsteroids.add(asteroidId);
    // Set scene to MAP BEFORE ending event to prevent render() from re-triggering arrival event
    gameState.travel.currentSceneId = "MAP";
    endEvent();
    // handleAsteroidLeave also sets currentSceneId = "MAP" and calls render(), but that's fine
    handleAsteroidLeave(asteroidId);
  };
  
  let eventData;
  
  if (node.artifactTruth === true) {
    // Artifact exists: 40% artifact find, 60% no artifact
    const rand = Math.random();
    if (rand < 0.4) {
      // Artifact find outcome
      const artifact = grantRandomArtifact("ASTEROID", asteroidId);
      eventData = {
        phase: "OUTCOME",
        title: "SOMETHING LEFT BEHIND",
        body: "",
        options: ["", "", ""],
        outcomeText: "You retreat carefully, leaving the area undisturbed. As you pull away, something catches your eye—an artifact, half-buried near the cabin.",
        image: null,
        onContinue: markClearedAndContinue
      };
    } else {
      // No artifact
      eventData = {
        phase: "OUTCOME",
        title: "BACK AWAY",
        body: "",
        options: ["", "", ""],
        outcomeText: "You retreat carefully, leaving the area undisturbed.",
        image: null,
        onContinue: markClearedAndContinue
      };
    }
  } else {
    // No artifact: always "Back Away (no artifact)"
    eventData = {
      phase: "OUTCOME",
      title: "BACK AWAY",
      body: "",
      options: ["", "", ""],
      outcomeText: "You retreat carefully, leaving the area undisturbed.",
      image: null,
      onContinue: markClearedAndContinue
    };
  }
  
  startEvent(eventData);
}

/**
 * Handle making contact with inhabited asteroid (rolls outcome)
 * @param {string} asteroidId Asteroid node ID
 */
function handleAsteroidMakeContact(asteroidId) {
  const node = mapNodes.find(n => n.id === asteroidId);
  if (!node || node.type !== "asteroid") {
    console.warn("[ASTEROID CONTACT] Node not found or not an asteroid:", asteroidId);
    return;
  }
  
  // Helper to mark asteroid as cleared and return to map
  const markClearedAndContinue = () => {
    if (!gameState.travel.clearedAsteroids) {
      gameState.travel.clearedAsteroids = new Set();
    }
    gameState.travel.clearedAsteroids.add(asteroidId);
    // Set scene to MAP BEFORE ending event to prevent render() from re-triggering arrival event
    gameState.travel.currentSceneId = "MAP";
    endEvent();
    // handleAsteroidLeave also sets currentSceneId = "MAP" and calls render(), but that's fine
    handleAsteroidLeave(asteroidId);
  };
  
  // Get cached contact outcome (generates and caches if not exists)
  const contactOutcome = generateAsteroidContactOutcome(node);
  let eventData;
  
  if (contactOutcome === "friendly") {
    // Friendly Trader (65%)
    eventData = {
      phase: "PROMPT",
      title: "OPEN CHANNEL",
      body: "A wary but open trader emerges from the cabin. They offer limited goods at inflated prices, but they're willing to trade.",
      options: ["TRADE", "LEAVE", ""],
      outcomeText: null,
      image: null,
      optionHandlers: [
        (optionText, index) => {
          // TRADE button - open trader merchant
          debugLog("[TRADER] TRADE button clicked, asteroidId:", asteroidId);
          // Set scene to MAP BEFORE ending event to prevent render() from re-triggering arrival event
          gameState.travel.currentSceneId = "MAP";
          gameState.travel.returnSceneId = "EXTERIOR";
          // Set trader merchant active BEFORE ending event so render() knows to skip scene rendering
          gameState.travel.traderMerchantActive = true;
          endEvent();
          openTraderMerchant(asteroidId);
        },
        () => {
          // LEAVE button - exit and return to map
          endEvent();
          markClearedAndContinue();
        },
        null
      ]
    };
    logAdd("RANDOM_EVENT", `Day ${gameState.stats.day}: Made friendly contact with trader on ${node.name}.`, {
      locationId: asteroidId
    });
  } else {
    // Hostile (35%)
    const damage = Math.floor(Math.random() * 8) + 3; // 3-10 damage
    applyShipDamage(damage, "Asteroid encounter");
    eventData = {
      phase: "OUTCOME",
      title: "WRONG DOOR",
      body: "",
      options: ["", "", ""],
      outcomeText: `The inhabitants open fire! You retreat quickly, but your ship takes ${damage}% damage.`,
      image: null,
      onContinue: markClearedAndContinue
    };
    logAdd("RANDOM_EVENT", `Day ${gameState.stats.day}: Hostile encounter on ${node.name}. Ship took ${damage}% damage.`, {
      locationId: asteroidId
    });
  }
  
  startEvent(eventData);
}

/**
 * Resolve asteroid contact (determine TRADE vs COMBAT)
 * @param {string} asteroidId Asteroid node ID
 * @deprecated - Replaced by handleAsteroidMakeContact
 */
function resolveAsteroidContact(asteroidId) {
  const node = mapNodes.find(n => n.id === asteroidId);
  if (!node || node.type !== "asteroid") {
    console.warn("[ASTEROID CONTACT] Node not found or not an asteroid:", asteroidId);
    return;
  }
  
  const landingRisk = node.landingRisk || "Moderately Safe";
  
  // Determine outcome using cached contact outcome
  const contactOutcome = generateAsteroidContactOutcome(node);
  const outcome = contactOutcome === "friendly" ? "TRADE" : "COMBAT";
  
  // Log contact attempt
  logAdd("RANDOM_EVENT", `Day ${gameState.stats.day}: Attempted contact with inhabitants of ${node.name}.`, {
    locationId: asteroidId,
    locationName: node.name
  });
  
  // Show appropriate event (don't change scene ID - keep it as EXTERIOR)
  if (outcome === "TRADE") {
    logAdd("RANDOM_EVENT", `Day ${gameState.stats.day}: Peaceful contact established. Trade opportunity available.`, {
      locationId: asteroidId
    });
    // Show trade event directly
    showAsteroidTradeModal(asteroidId);
  } else {
    // Resolve combat first (this may change scene to MAP if lost)
    const combatResult = resolveAsteroidCombat(asteroidId);
    // Show combat result event
    showAsteroidCombatResult(asteroidId, combatResult);
  }
}

/**
 * Resolve asteroid combat encounter
 * @param {string} asteroidId Asteroid node ID
 * @returns {Object} Combat result: { won: boolean, outcomeText: string }
 */
function resolveAsteroidCombat(asteroidId) {
  const node = mapNodes.find(n => n.id === asteroidId);
  if (!node || node.type !== "asteroid") {
    return { won: false, outcomeText: "Combat encounter failed." };
  }
  
  const landingRisk = node.landingRisk || "Moderately Safe";
  
  // Determine win/loss (simplified for now - can be expanded)
  const winChance = 0.6; // 60% base win chance
  const riskModifier = {
    "Safe": 0.1,
    "Moderately Safe": 0.05,
    "Moderately Dangerous": -0.05,
    "Dangerous": -0.15
  };
  const adjustedWinChance = winChance + (riskModifier[landingRisk] || 0);
  const won = Math.random() < adjustedWinChance;
  
  let outcomeText = "";
  
  if (won) {
    // Win: gain credits and possibly item/artifact
    const creditsGained = Math.floor(Math.random() * 100) + 50;
    gameState.stats.credits += creditsGained;
    
    const artifactGained = Math.random() < 0.3;
    if (artifactGained) {
      grantRandomArtifact("ASTEROID", asteroidId);
      outcomeText = `Combat won! Gained ${creditsGained} credits and recovered an artifact.`;
    } else {
      outcomeText = `Combat won! Gained ${creditsGained} credits.`;
    }
    
    logAdd("RANDOM_EVENT", `Day ${gameState.stats.day}: Combat won. Gained ${creditsGained} credits.`, {
      locationId: asteroidId
    });
  } else {
    // Lose: take damage or lose credits
    const riskSeverity = {
      "Safe": 0.5,
      "Moderately Safe": 0.75,
      "Moderately Dangerous": 1.0,
      "Dangerous": 1.5
    };
    const severity = riskSeverity[landingRisk] || 1.0;
    
    // Randomly choose damage type
    const damageType = Math.random();
    if (damageType < 0.4) {
      // Ship damage
      const damage = Math.floor(10 * severity);
      applyShipDamage(damage, "Asteroid encounter");
      outcomeText = `Combat lost. Ship took ${damage}% damage.`;
      logAdd("RANDOM_EVENT", `Day ${gameState.stats.day}: Combat lost. Ship took ${damage}% damage.`, {
        locationId: asteroidId
      });
    } else if (damageType < 0.7) {
      // Credit loss
      const creditsLost = Math.floor(50 * severity);
      gameState.stats.credits = Math.max(0, gameState.stats.credits - creditsLost);
      outcomeText = `Combat lost. Lost ${creditsLost} credits.`;
      logAdd("RANDOM_EVENT", `Day ${gameState.stats.day}: Combat lost. Lost ${creditsLost} credits.`, {
        locationId: asteroidId
      });
    } else {
      // Crew injury
      if (gameState.crew.members.length > 0) {
        const randomCrew = gameState.crew.members[Math.floor(Math.random() * gameState.crew.members.length)];
        randomCrew.status = "Injured";
        outcomeText = `Combat lost. ${randomCrew.name} was injured.`;
        logAdd("CREW_UPDATE", `Day ${gameState.stats.day}: ${randomCrew.name} was injured in combat.`, {
          crewId: randomCrew.id,
          locationId: asteroidId
        });
      } else {
        outcomeText = "Combat lost. Check your log for details.";
      }
    }
    
    // Return to MAP after loss (forced retreat)
    // Set currentLocationId to a safe default (earth) so scanning still works
    gameState.travel.currentSceneId = "MAP";
    gameState.travel.currentLocationId = "earth"; // Default to earth after forced retreat
  }
  
  return { won, outcomeText };
}

/**
 * Show asteroid trade event (converted from modal to event system)
 * @param {string} asteroidId Asteroid node ID
 */
function showAsteroidTradeModal(asteroidId) {
  const node = mapNodes.find(n => n.id === asteroidId);
  if (!node || node.type !== "asteroid") return;
  
  const eventData = {
    phase: "OUTCOME",
    title: "Trade Opportunity",
    body: "",
    options: ["", "", ""],
    outcomeText: "The inhabitants offer limited trade goods from pressure-sealed crates.",
    image: null,
    onContinue: () => {
      endEvent();
      openTraderMerchant(asteroidId);
    }
  };

  startEvent(eventData);
}

/**
 * Show asteroid combat result event (converted from modal to event system)
 * @param {string} asteroidId Asteroid node ID
 * @param {Object} combatResult Result from resolveAsteroidCombat: { won: boolean, outcomeText: string }
 */
function showAsteroidCombatResult(asteroidId, combatResult) {
  const node = mapNodes.find(n => n.id === asteroidId);
  if (!node || node.type !== "asteroid") return;
  
  // Combat result is already logged in resolveAsteroidCombat
  // Show outcome event
  
  // Start event in OUTCOME phase
  const eventData = {
    phase: "OUTCOME",
    title: "Combat Resolved",
    body: "",
    options: ["", "", ""], // Not used in OUTCOME phase
    outcomeText: combatResult ? combatResult.outcomeText : "The encounter has concluded. Check your log for details.",
    image: null,
    onContinue: () => {
      // Set scene to MAP BEFORE ending event to prevent re-triggering
      // (Note: combat loss already sets this in resolveAsteroidCombat, but set it here too for safety)
      gameState.travel.currentSceneId = "MAP";
      endEvent();
      // If combat was lost, we're already back at MAP with currentLocationId set to earth
      // If combat was won, we're still at the asteroid
      if (combatResult && combatResult.won) {
        handleAsteroidLeave(asteroidId);
    } else {
        // Already at MAP, just ensure state is clean
        handleAsteroidLeave(asteroidId);
      }
    }
  };
  
  // Start event in OUTCOME phase
  startEvent(eventData);
}

/**
 * Hide the modal
 */
function hideModal() {
  if (!el.modalLayer) return;
  el.modalLayer.hidden = true;
  el.modalLayer.innerHTML = "";
}

function rollInt(min, max) {
  return Math.floor(Math.random() * (max - min + 1)) + min;
}

function getLandingDamageRoll(landingRisk) {
  switch (landingRisk) {
    case "Safe": {
      const roll = Math.random();
      if (roll < 0.6) return 0;
      return Math.random() < 0.5 ? 1 : 2;
    }
    case "Moderately Safe":
      return rollInt(1, 3);
    case "Moderately Dangerous":
      return rollInt(2, 7);
    case "Dangerous": {
      const roll = Math.random();
      if (roll < 0.85) return rollInt(5, 12);
      return rollInt(13, 15);
    }
    default:
      return rollInt(1, 3);
  }
}

function getLandingDamageReduction() {
  let reduction = 0;
  if (gameState.ship?.upgrades?.landingAssist1) {
    reduction += 1;
  }
  if (gameState.ship?.upgrades?.landingAssist2) {
    reduction += 2;
  }
  return reduction;
}

function getLandingFlavorText(landingRisk, finalDamage, rolledDamage) {
  const tookDamage = finalDamage > 0;
  if (landingRisk === "Safe" && !tookDamage) {
    return "A smooth touchdown. The surface barely stirs beneath your landing gear.";
  }
  if (landingRisk === "Safe" && tookDamage) {
    return "A gentle jolt on landing—minor scrapes, nothing serious.";
  }
  if (landingRisk === "Moderately Safe" && !tookDamage) {
    return "A steady landing with minimal fuss.";
  }
  if (landingRisk === "Moderately Safe" && tookDamage) {
    return "A few rough bumps on the way down. The hull takes a light scrape.";
  }
  if (landingRisk === "Moderately Dangerous" && !tookDamage) {
    return "A tense descent, but you set down without damage.";
  }
  if (landingRisk === "Moderately Dangerous" && tookDamage) {
    return "A rough descent rattles the ship and leaves the hull scuffed.";
  }
  if (landingRisk === "Dangerous" && rolledDamage >= 13) {
    return "A brutal impact. The landing gear screams as the hull takes a heavy hit.";
  }
  if (landingRisk === "Dangerous" && tookDamage) {
    return "A hard landing shakes the ship and dents the hull.";
  }
  return "You settle onto the surface and power down for landing checks.";
}

/**
 * Handle outpost exploration (from OUTPOST_EXTERIOR)
 * @param {string} locationId Outpost location ID
 */
function handleOutpostExplore(locationId) {
  const node = mapNodes.find(n => n.id === locationId);
  if (!node || node.type !== "outpost") {
    console.warn("[OUTPOST EXPLORE] Invalid location:", locationId);
    return;
  }
  advanceDays(1);
  const roll = Math.random();
  let eventData;
  if (roll < 0.34) {
    const vistaResult = applyVistaRelief(locationId);
    eventData = {
      phase: "OUTCOME",
      title: "VISTA POINT",
      body: "",
      options: ["", "", ""],
      outcomeText: vistaResult.message || "You find a quiet overlook and catch your breath.",
      image: null,
      onContinue: () => {
        gameState.travel.currentSceneId = "OUTPOST_EXTERIOR";
        endEvent();
        render();
      }
    };
    logAdd("OUTPOST_EXPLORE", `Day ${gameState.stats.day}: Found a vista near ${node.name}.`, { locationId });
  } else if (roll < 0.67) {
    let outcomeText = "The hunt turns up little, and you return empty-handed.";
    const huntRoll = Math.random();
    if (huntRoll < 0.5) {
      const supplies = Object.values(SUPPLY_DEFS).filter(def => def.tier === "OUTPOST");
      if (supplies.length > 0) {
        const supply = supplies[Math.floor(Math.random() * supplies.length)];
        addItemToInventory(supply.id, 1, "supply");
        outcomeText = `You trade for a small bundle and return with ${supply.name}.`;
        logAdd("OUTPOST_EXPLORE", `Day ${gameState.stats.day}: Gained ${supply.name} near ${node.name}.`, { locationId, itemId: supply.id });
      }
    } else if (huntRoll < 0.7 && gameState.crew.members.length > 0) {
      const member = gameState.crew.members[Math.floor(Math.random() * gameState.crew.members.length)];
      member.status = "Injured";
      outcomeText = `${member.name} slips on a broken catwalk. Minor injury, but they walk it off.`;
      logAdd("OUTPOST_EXPLORE", `Day ${gameState.stats.day}: ${member.name} injured near ${node.name}.`, {
        locationId,
        crewId: member.id
      });
    }
    eventData = {
      phase: "OUTCOME",
      title: "HUNTING ENCOUNTER",
      body: "",
      options: ["", "", ""],
      outcomeText,
      image: null,
      onContinue: () => {
        gameState.travel.currentSceneId = "OUTPOST_EXTERIOR";
        endEvent();
        render();
      }
    };
  } else {
    eventData = {
      phase: "OUTCOME",
      title: "NOTHING OF INTEREST",
      body: "",
      options: ["", "", ""],
      outcomeText: "You circle the perimeter and find nothing of note.",
      image: null,
      onContinue: () => {
        gameState.travel.currentSceneId = "OUTPOST_EXTERIOR";
        endEvent();
        render();
      }
    };
    logAdd("OUTPOST_EXPLORE", `Day ${gameState.stats.day}: Found nothing near ${node.name}.`, { locationId });
  }
  startEvent(eventData);
}

/**
 * Land at the current location
 * Determines the correct starting scene based on location type and transitions to it
 */
function landAtCurrentLocation() {
  const instanceId = gameState.travel.currentLocationId;
  if (!instanceId) {
    console.warn("[LAND] No current location to land at");
    return;
  }

  const node = mapNodes.find(n => n.id === instanceId);
  if (!node) {
    console.warn("[LAND] Node not found for", instanceId);
    return;
  }

  const type = node.type;
  let startSceneId;

  // Determine starting scene based on location type
  if (type === "mars") {
    finishRun("WON", "You reached Mars before the mission collapsed.");
    return;
  }

  if (type === "station") {
    // Enter station HUB panorama
    const baseId = getBaseLocationId(instanceId);
    const hubDef = STATION_HUB_DEFS[baseId];
    if (hubDef) {
      gameState.travel.stationHubPanelId = hubDef.defaultPanelId;
      startSceneId = "HUB";
    } else {
      // Fallback if hub definition missing
    startSceneId = "EXTERIOR";
    }
  } else if (type === "outpost") {
    // Outposts land into exterior scene, then enter interior for services
    startSceneId = "OUTPOST_EXTERIOR";
    // Apply landing cost
    advanceDays(1);
  } else if (type === "asteroid") {
    // Asteroids land into exterior scene (scene-first flow)
    startSceneId = "EXTERIOR";
    
    // Ensure truth values are generated (if not already from deep scan)
    generateAsteroidTruthValues(node);
    
    // Clear any lingering overlays
    closeAllOverlays();
    
    if (gameState.travel.hintTargetAsteroidId === instanceId) {
      gameState.travel.hintTargetAsteroidId = null;
    }
    
    // Apply landing costs: +1 day (which automatically drains life support)
    advanceDays(1);
    
    // Apply landing damage based on landing risk
    const landingRisk = node.landingRisk || "Moderately Safe";
    const rolledDamage = getLandingDamageRoll(landingRisk);
    const reduction = getLandingDamageReduction();
    const finalDamage = Math.max(0, rolledDamage - reduction);
    const hullBefore = (typeof gameState.stats.hull === "number")
      ? gameState.stats.hull
      : (typeof gameState.stats.shipIntegrity === "number" ? gameState.stats.shipIntegrity : 100);
    const hullAfter = Math.max(0, Math.min(100, hullBefore - finalDamage));
    
    setShipIntegrity(gameState, hullAfter);
    if (finalDamage > 0) {
      const subsystems = ["STRUCTURAL", "ELECTRICAL", "LIFE_SUPPORT"];
      const hit = subsystems[Math.floor(Math.random() * subsystems.length)];
      gameState.ship.subsystems[hit].damage = Math.min(100, gameState.ship.subsystems[hit].damage + Math.ceil(finalDamage * 0.5));
      gameState.ship.subsystems[hit].flavorText = `Rough landing on ${node.name}`;
    }
    checkEndConditions();
    if (isRunOver()) return;
    
    gameState.travel.landingFlavorText = getLandingFlavorText(landingRisk, finalDamage, rolledDamage);
    if (finalDamage > 0) {
      logAdd("LANDING_DAMAGE", `Day ${gameState.stats.day}: Rough landing damaged the hull (-${finalDamage}%).`, {
        locationId: instanceId,
        locationName: node.name,
        landingRisk
      });
    }
    
    debugLog("[ASTEROID LANDING] Applied costs: +1 day. New day:", gameState.stats.day, "life support:", gameState.stats.lifeSupport.toFixed(1) + "%", "landing damage:", finalDamage);
  } else if (type === "ship") {
    startSceneId = "ARRIVAL";
  } else if (type === "earth" || type === "moon" || type === "mars") {
    startSceneId = "ARRIVAL"; // Or block LAND if desired
  } else {
    console.warn("[LAND] Unknown location type:", type);
    return;
  }

  // Start landing draft for logging
  logStartLandingDraft(instanceId, node.name, type);
  
  // Set scene and render
  gameState.travel.currentSceneId = startSceneId;
  debugLog("[LAND]", instanceId, "→", startSceneId);
  render();
}

/**
 * Update the travel button text and state based on whether player is arrived
 */
function updateTravelButton() {
  if (!el.actionTravel) return;
  if (isRunOver()) {
    el.actionTravel.textContent = gameState.meta.runStatus === "WON" ? "MISSION COMPLETE" : "RUN ENDED";
    el.actionTravel.disabled = true;
    return;
  }
  el.actionTravel.disabled = false;

  // If there's a selected destination different from current location, show TRAVEL
  // (Player is planning to travel to a new location)
  if (gameState.travel.selectedDestinationId && 
      gameState.travel.selectedDestinationId !== gameState.travel.currentLocationId) {
    el.actionTravel.textContent = "TRAVEL";
    return;
  }

  // Check if player is "arrived" at a location
  // Arrived = not traveling, on MAP, and has a current location that can be landed at
  const isArrived = !gameState.travel.isTraveling &&
                    gameState.travel.currentSceneId === "MAP" &&
                    gameState.travel.currentLocationId !== null;

  if (isArrived) {
    // Check if current location is landable
    const currentLocationNode = mapNodes.find(n => n.id === gameState.travel.currentLocationId);
    if (currentLocationNode) {
      const landableTypes = ["station", "outpost", "asteroid", "ship", "earth", "moon", "mars"];
      const isLandable = landableTypes.includes(currentLocationNode.type);
      
      if (isLandable) {
        el.actionTravel.textContent = "LAND";
        return;
      }
    }
  }

  // Default: show TRAVEL button
  el.actionTravel.textContent = "TRAVEL";
}

// dispatchAction is created after all handlers exist — see createDispatchAction() below.

function renderCrew() {
  const viewportContent = document.getElementById("viewport-content");
  if (!viewportContent) return;
  
  // Preserve canvas and scene container elements before clearing
  const canvas = viewportContent.querySelector("#map-canvas");
  const sceneContainer = viewportContent.querySelector("#scene-container");
  
  // Clear existing content (this removes canvas and scene container)
  viewportContent.innerHTML = "";
  
  // Create crew container
  const crewContainer = document.createElement("div");
  crewContainer.className = "crew-container";
  crewContainer.id = "crew-container";
  
  // Create grid for crew cards
  const crewGrid = document.createElement("div");
  crewGrid.className = "crew-grid";
  
  // Render existing crew members
  gameState.crew.members.forEach((member) => {
    const card = document.createElement("div");
    card.className = "crew-card";
    card.dataset.crewId = member.id;
    
    // Portrait image
    const portrait = document.createElement("img");
    portrait.className = "crew-portrait";
    portrait.src = `assets/crew/portraits/${member.portrait}.png`;
    portrait.alt = member.name;
    
    // Name
    const name = document.createElement("div");
    name.className = "crew-name";
    name.textContent = member.name;
    
    // Background
    const background = document.createElement("div");
    background.className = "crew-background";
    background.textContent = `Background: ${member.background}`;
    
    // Status
    const status = document.createElement("div");
    status.className = "crew-status";
    status.textContent = `Status: ${member.status}`;
    
    // Treatment options (hidden by default, shown on hover)
    const treatmentOptions = document.createElement("div");
    treatmentOptions.className = "crew-treatment-options";
    treatmentOptions.hidden = true;
    
    // Get applicable medical supplies for this crew member's status
    const applicableSupplies = getApplicableMedicalSupplies(member.status);
    
    if (applicableSupplies.length > 0) {
      applicableSupplies.forEach(supplyDef => {
        const treatButton = document.createElement("button");
        treatButton.className = "crew-treat-button";
        treatButton.textContent = `Treat with ${supplyDef.name}`;
        treatButton.addEventListener("click", (e) => {
          e.stopPropagation();
          if (useMedicalSupply(supplyDef.id, member.id)) {
            // Success - treatment applied, UI will update via render()
            debugLog(`Treated ${member.name} with ${supplyDef.name}`);
          }
        });
        treatmentOptions.appendChild(treatButton);
      });
    } else {
      const noSupplies = document.createElement("div");
      noSupplies.className = "crew-no-supplies";
      noSupplies.textContent = "No applicable supplies";
      treatmentOptions.appendChild(noSupplies);
    }
    
    // Hover behavior: show/hide treatment options
    card.addEventListener("mouseenter", () => {
      treatmentOptions.hidden = false;
    });
    card.addEventListener("mouseleave", () => {
      treatmentOptions.hidden = true;
    });
    
    card.appendChild(portrait);
    card.appendChild(name);
    card.appendChild(background);
    card.appendChild(status);
    card.appendChild(treatmentOptions);
    
    crewGrid.appendChild(card);
  });
  
  // Add empty slots (up to 10 total slots, 2 rows of 4)
  const totalSlots = 8;
  const emptySlots = totalSlots - gameState.crew.members.length;
  for (let i = 0; i < emptySlots; i++) {
    const emptyCard = document.createElement("div");
    emptyCard.className = "crew-card crew-card-empty";
    crewGrid.appendChild(emptyCard);
  }
  
  crewContainer.appendChild(crewGrid);
  
  // Re-add canvas and scene container to DOM first (hidden) so they remain available
  // This ensures they remain in the DOM for when we switch back to TRAVEL
  if (canvas) {
    canvas.hidden = true;
    canvas.style.display = "none";
    canvas.style.visibility = "hidden";
    viewportContent.appendChild(canvas);
    // Update el.canvas reference in case it was lost
    el.canvas = canvas;
  }
  if (sceneContainer) {
    sceneContainer.hidden = true;
    sceneContainer.setAttribute("hidden", "");
    sceneContainer.style.display = "none";
    sceneContainer.style.visibility = "hidden";
    viewportContent.appendChild(sceneContainer);
    // Update el.sceneContainer reference
    el.sceneContainer = sceneContainer;
  }
  
  // Add crew container last so it appears on top
  viewportContent.appendChild(crewContainer);
}

function renderInventory() {
  const viewportContent = document.getElementById("viewport-content");
  if (!viewportContent) return;
  
  // Preserve canvas and scene container elements before clearing
  const canvas = viewportContent.querySelector("#map-canvas");
  const sceneContainer = viewportContent.querySelector("#scene-container");
  
  // Clear existing content (this removes canvas and scene container)
  viewportContent.innerHTML = "";
  
  // Create inventory container
  const inventoryContainer = document.createElement("div");
  inventoryContainer.className = "inventory-container";
  inventoryContainer.id = "inventory-container";
  
  // Credits header (center-aligned)
  const creditsHeader = document.createElement("div");
  creditsHeader.className = "inventory-credits";
  creditsHeader.textContent = `CREDITS: ${gameState.stats.credits}`;
  inventoryContainer.appendChild(creditsHeader);
  
  // Three-column layout
  const columnsContainer = document.createElement("div");
  columnsContainer.className = "inventory-columns";
  
  // SUPPLIES column
  const suppliesColumn = document.createElement("div");
  suppliesColumn.className = "inventory-column";
  const suppliesHeader = document.createElement("div");
  suppliesHeader.className = "inventory-column-header";
  suppliesHeader.textContent = "SUPPLIES";
  suppliesColumn.appendChild(suppliesHeader);
  
  const suppliesList = document.createElement("div");
  suppliesList.className = "inventory-list";
  
  // Get all supplies sorted by subtype (LIFE_SUPPORT first, then MEDICAL), then by name
  // Only show supplies that are actually in inventory (qty > 0)
  const allSupplies = Object.values(SUPPLY_DEFS)
    .filter(supplyDef => {
      const supplyStack = gameState.inventory.supplies[supplyDef.id];
      return supplyStack && supplyStack.qty > 0;
    })
    .sort((a, b) => {
    if (a.subtype !== b.subtype) {
      return a.subtype === "LIFE_SUPPORT" ? -1 : 1;
    }
    return a.name.localeCompare(b.name);
  });
  
  allSupplies.forEach(supplyDef => {
    const supplyStack = gameState.inventory.supplies[supplyDef.id];
    const quantity = supplyStack.qty;
    const supplyEntry = document.createElement("div");
    supplyEntry.className = "inventory-entry";
    supplyEntry.dataset.supplyId = supplyDef.id;
    
    // Make life support items clickable to use
    if (supplyDef.subtype === "LIFE_SUPPORT" && quantity > 0) {
      supplyEntry.title = `Click to use ${supplyDef.name}`;
      supplyEntry.addEventListener("click", () => {
        if (useSupply(supplyDef.id)) {
          debugLog(`Used ${supplyDef.name}`);
        }
      });
    }
    
    // Hover behavior: show supply preview
    supplyEntry.addEventListener("mouseenter", () => {
      showSupplyPreview(supplyDef.id);
    });
    supplyEntry.addEventListener("mouseleave", () => {
      restoreNormalPreview();
    });
    
    supplyEntry.textContent = `${supplyDef.name} × ${String(quantity).padStart(2, '0')}`;
    suppliesList.appendChild(supplyEntry);
  });
  
  suppliesColumn.appendChild(suppliesList);
  columnsContainer.appendChild(suppliesColumn);
  
  // PARTS column (ship parts)
  const partsColumn = document.createElement("div");
  partsColumn.className = "inventory-column";
  const partsHeader = document.createElement("div");
  partsHeader.className = "inventory-column-header";
  partsHeader.textContent = "PARTS";
  partsColumn.appendChild(partsHeader);
  
  const partsList = document.createElement("div");
  partsList.className = "inventory-list";
  
  // Get all ship parts sorted by type (REPAIR first, then UPGRADE), then by name
  // Only show parts that are actually in inventory (quantity > 0)
  const allParts = Object.values(SHIP_PART_DEFS)
    .filter(partDef => {
      const quantity = gameState.inventory.parts[partDef.id] || 0;
      return quantity > 0;
    })
    .sort((a, b) => {
    if (a.type !== b.type) {
      return a.type === "REPAIR" ? -1 : 1;
    }
    return a.name.localeCompare(b.name);
  });
  
  allParts.forEach(partDef => {
    const quantity = gameState.inventory.parts[partDef.id];
    const partEntry = document.createElement("div");
    partEntry.className = "inventory-entry";
    partEntry.dataset.partId = partDef.id;
    
    // Make repair items clickable to use
    if (partDef.type === "REPAIR" && quantity > 0) {
      partEntry.title = `Click to use ${partDef.name}`;
      partEntry.style.cursor = "pointer";
      partEntry.addEventListener("click", () => {
        if (useRepairPart(partDef.id)) {
          debugLog(`Used ${partDef.name}`);
        }
      });
    }
    
    // Make upgrade items clickable to apply
    if (partDef.type === "UPGRADE" && quantity > 0) {
      partEntry.title = `Click to apply ${partDef.name}`;
      partEntry.style.cursor = "pointer";
      partEntry.addEventListener("click", () => {
        if (applyUpgrade(partDef.id)) {
          debugLog(`Applied ${partDef.name}`);
        }
      });
    }
    
    // Hover behavior: show placeholder (no images for parts yet)
    partEntry.addEventListener("mouseenter", () => {
      if (!el.previewFrame) return;
      const previewImg = el.previewFrame.querySelector("img");
      if (previewImg) previewImg.style.display = "none";
      if (el.previewPlaceholder) {
        el.previewPlaceholder.style.display = "flex";
        el.previewPlaceholder.textContent = "NO IMAGE";
      }
    });
    partEntry.addEventListener("mouseleave", () => {
      restoreNormalPreview();
    });
    
    partEntry.textContent = `${partDef.name} × ${String(quantity).padStart(2, '0')}`;
    partsList.appendChild(partEntry);
  });
  
  partsColumn.appendChild(partsList);
  columnsContainer.appendChild(partsColumn);
  
  // ARTIFACTS column
  const artifactsColumn = document.createElement("div");
  artifactsColumn.className = "inventory-column";
  const artifactsHeader = document.createElement("div");
  artifactsHeader.className = "inventory-column-header";
  artifactsHeader.textContent = "ARTIFACTS";
  artifactsColumn.appendChild(artifactsHeader);
  
  const artifactsList = document.createElement("div");
  artifactsList.className = "inventory-list";
  
  // Display actual artifacts from inventory
  if (gameState.inventory.artifacts.length === 0) {
    const emptyMessage = document.createElement("div");
    emptyMessage.className = "inventory-entry";
    emptyMessage.style.opacity = "0.5";
    emptyMessage.style.fontStyle = "italic";
    emptyMessage.textContent = "No artifacts";
    artifactsList.appendChild(emptyMessage);
  } else {
    gameState.inventory.artifacts.forEach(instance => {
      const artifactDef = ARTIFACT_CATALOG.find(a => a.id === instance.artifactId);
      if (!artifactDef) return;
      
      const artifactEntry = document.createElement("div");
      artifactEntry.className = "inventory-entry";
      artifactEntry.dataset.instanceId = instance.instanceId;
      artifactEntry.title = artifactDef.description; // Tooltip on hover
      
      // Build display text: Name, Rarity, Value, Risk
      const rarityColor = {
        COMMON: "#AAAAAA",
        UNCOMMON: "#0AA816",
        RARE: "#115FD1",
        LEGENDARY: "#850D1D"
      };
      
      const riskTierLabel = artifactDef.riskTier !== "NONE" ? ` [${artifactDef.riskTier}]` : "";
      const riskFlagsText = artifactDef.riskFlags.length > 0 
        ? ` (${artifactDef.riskFlags.join(", ")})` 
        : "";
      
      artifactEntry.innerHTML = `
        <div style="font-weight: 700; margin-bottom: 4px;">${artifactDef.name}</div>
        <div style="font-size: 11px; color: ${rarityColor[artifactDef.rarity] || "#AAAAAA"}; margin-bottom: 2px;">
          ${artifactDef.rarity} • ${artifactDef.baseValue} credits${riskTierLabel}
        </div>
        ${artifactDef.riskFlags.length > 0 ? `<div style="font-size: 10px; opacity: 0.7;">Risk: ${artifactDef.riskFlags.join(", ")}</div>` : ""}
      `;
      
      // Hover behavior: show placeholder (no images for artifacts yet)
      artifactEntry.addEventListener("mouseenter", () => {
        if (!el.previewFrame) return;
        const previewImg = el.previewFrame.querySelector("img");
        if (previewImg) previewImg.style.display = "none";
        if (el.previewPlaceholder) {
          el.previewPlaceholder.style.display = "flex";
          el.previewPlaceholder.textContent = "NO IMAGE";
        }
      });
      artifactEntry.addEventListener("mouseleave", () => {
        restoreNormalPreview();
      });
      
      artifactsList.appendChild(artifactEntry);
    });
  }
  
  artifactsColumn.appendChild(artifactsList);
  columnsContainer.appendChild(artifactsColumn);
  
  inventoryContainer.appendChild(columnsContainer);
  
  // Re-add canvas and scene container to DOM first (hidden) so they remain available
  if (canvas) {
    canvas.hidden = true;
    canvas.style.display = "none";
    canvas.style.visibility = "hidden";
    viewportContent.appendChild(canvas);
    el.canvas = canvas;
  }
  if (sceneContainer) {
    sceneContainer.hidden = true;
    sceneContainer.setAttribute("hidden", "");
    sceneContainer.style.display = "none";
    sceneContainer.style.visibility = "hidden";
    viewportContent.appendChild(sceneContainer);
    el.sceneContainer = sceneContainer;
  }
  
  // Add inventory container last so it appears on top
  viewportContent.appendChild(inventoryContainer);
}

function renderShip() {
  const viewportContent = document.getElementById("viewport-content");
  if (!viewportContent) return;
  
  // Preserve canvas and scene container elements before clearing
  const canvas = viewportContent.querySelector("#map-canvas");
  const sceneContainer = viewportContent.querySelector("#scene-container");
  
  // Clear existing content (this removes canvas and scene container)
  viewportContent.innerHTML = "";
  
  // Create ship container
  const shipContainer = document.createElement("div");
  shipContainer.className = "ship-container";
  shipContainer.id = "ship-container";
  
  // Ship image (placeholder for now - can be replaced with actual ship image)
  const shipImage = document.createElement("div");
  shipImage.className = "ship-image";
  shipImage.style.width = "100%";
  shipImage.style.height = "60%";
  shipImage.style.backgroundColor = "var(--panel-black)";
  shipImage.style.border = "2px solid var(--paper)";
  shipImage.style.borderRadius = "12px";
  shipImage.style.display = "flex";
  shipImage.style.alignItems = "center";
  shipImage.style.justifyContent = "center";
  shipImage.style.color = "var(--paper)";
  shipImage.style.fontSize = "24px";
  shipImage.style.fontWeight = "900";
  shipImage.textContent = "SHIP";
  shipContainer.appendChild(shipImage);
  
  // Subsystems container
  const subsystemsContainer = document.createElement("div");
  subsystemsContainer.className = "ship-subsystems";
  subsystemsContainer.style.display = "grid";
  subsystemsContainer.style.gridTemplateColumns = "repeat(3, 1fr)";
  subsystemsContainer.style.gap = "18px";
  subsystemsContainer.style.marginTop = "18px";
  
  // Create hotspot for each subsystem
  const subsystemNames = {
    STRUCTURAL: "STRUCTURAL",
    ELECTRICAL: "ELECTRICAL",
    LIFE_SUPPORT: "LIFE SUPPORT"
  };
  
  Object.keys(gameState.ship.subsystems).forEach(subsystemKey => {
    const subsystem = gameState.ship.subsystems[subsystemKey];
    const subsystemName = subsystemNames[subsystemKey] || subsystemKey;
    
    const hotspot = document.createElement("div");
    hotspot.className = "ship-subsystem-hotspot";
    hotspot.dataset.subsystem = subsystemKey;
    
    // Subsystem name
    const name = document.createElement("div");
    name.className = "ship-subsystem-name";
    name.textContent = subsystemName;
    name.style.fontWeight = "900";
    name.style.fontSize = "16px";
    name.style.color = "var(--paper)";
    name.style.marginBottom = "8px";
    hotspot.appendChild(name);
    
    // Damage percentage
    const damage = document.createElement("div");
    damage.className = "ship-subsystem-damage";
    damage.textContent = `Damage: ${Math.round(subsystem.damage)}%`;
    damage.style.fontWeight = "600";
    damage.style.fontSize = "14px";
    damage.style.color = subsystem.damage > 0 ? "var(--mars-red)" : "var(--ship-green)";
    damage.style.marginBottom = "8px";
    hotspot.appendChild(damage);
    
    // Flavor text
    const flavor = document.createElement("div");
    flavor.className = "ship-subsystem-flavor";
    flavor.textContent = subsystem.flavorText || "Operational";
    flavor.style.fontWeight = "400";
    flavor.style.fontSize = "12px";
    flavor.style.color = "var(--paper)";
    flavor.style.fontStyle = subsystem.flavorText ? "normal" : "italic";
    flavor.style.opacity = subsystem.flavorText ? "1" : "0.6";
    hotspot.appendChild(flavor);
    
    // Styling
    hotspot.style.padding = "12px";
    hotspot.style.border = "2px solid var(--paper)";
    hotspot.style.borderRadius = "8px";
    hotspot.style.backgroundColor = "var(--panel-black)";
    hotspot.style.cursor = "pointer";
    hotspot.style.transition = "border-color 0.2s";
    
    // Hover effect
    hotspot.addEventListener("mouseenter", () => {
      hotspot.style.borderColor = "var(--ship-blue)";
    });
    hotspot.addEventListener("mouseleave", () => {
      hotspot.style.borderColor = "var(--paper)";
    });
    
    subsystemsContainer.appendChild(hotspot);
  });
  
  shipContainer.appendChild(subsystemsContainer);
  
  // Upgrades display
  const upgradesContainer = document.createElement("div");
  upgradesContainer.className = "ship-upgrades";
  upgradesContainer.style.marginTop = "18px";
  upgradesContainer.style.padding = "12px";
  upgradesContainer.style.border = "2px solid var(--paper)";
  upgradesContainer.style.borderRadius = "8px";
  upgradesContainer.style.backgroundColor = "var(--panel-black)";
  
  const upgradesTitle = document.createElement("div");
  upgradesTitle.textContent = "UPGRADES";
  upgradesTitle.style.fontWeight = "900";
  upgradesTitle.style.fontSize = "16px";
  upgradesTitle.style.color = "var(--paper)";
  upgradesTitle.style.marginBottom = "12px";
  upgradesContainer.appendChild(upgradesTitle);
  
  const scannerTier = gameState.ship.upgrades.scanner || 0;
  const engineTier = gameState.ship.upgrades.engine || 0;
  
  const scannerUpgrade = document.createElement("div");
  scannerUpgrade.style.marginBottom = "8px";
  scannerUpgrade.innerHTML = `<span style="font-weight: 600; color: var(--paper);">Scanner:</span> <span style="color: var(--ship-green);">Tier ${scannerTier}</span> <span style="font-size: 12px; opacity: 0.7;">(+${scannerTier * 25}% radius)</span>`;
  upgradesContainer.appendChild(scannerUpgrade);
  
  const engineUpgrade = document.createElement("div");
  engineUpgrade.innerHTML = `<span style="font-weight: 600; color: var(--paper);">Engine:</span> <span style="color: var(--ship-green);">Tier ${engineTier}</span> <span style="font-size: 12px; opacity: 0.7;">(+${engineTier * 5}% speed)</span>`;
  upgradesContainer.appendChild(engineUpgrade);
  
  shipContainer.appendChild(upgradesContainer);
  
  // Re-add canvas and scene container to DOM first (hidden) so they remain available
  if (canvas) {
    canvas.hidden = true;
    canvas.style.display = "none";
    canvas.style.visibility = "hidden";
    viewportContent.appendChild(canvas);
    el.canvas = canvas;
  }
  if (sceneContainer) {
    sceneContainer.hidden = true;
    sceneContainer.setAttribute("hidden", "");
    sceneContainer.style.display = "none";
    sceneContainer.style.visibility = "hidden";
    viewportContent.appendChild(sceneContainer);
    el.sceneContainer = sceneContainer;
  }
  
  // Add ship container last so it appears on top
  viewportContent.appendChild(shipContainer);
}

function renderLog() {
  const viewportContent = document.getElementById("viewport-content");
  if (!viewportContent) return;
  
  // Preserve canvas and scene container elements before clearing
  const canvas = viewportContent.querySelector("#map-canvas");
  const sceneContainer = viewportContent.querySelector("#scene-container");
  
  // Clear existing content (this removes canvas and scene container)
  viewportContent.innerHTML = "";
  
  // Create log container
  const logContainer = document.createElement("div");
  logContainer.className = "log-container";
  logContainer.id = "log-container";
  
  const logTabs = document.createElement("div");
  logTabs.className = "log-tabs";
  const currentView = gameState.travel.logView || "LOG";
  const makeTab = (label) => {
    const btn = document.createElement("button");
    btn.textContent = label;
    btn.className = "log-tab";
    if (currentView === label) {
      btn.classList.add("is-active");
    }
    btn.addEventListener("click", (event) => {
      gameState.travel.logView = label;
      renderLog();
    });
    return btn;
  };
  logTabs.appendChild(makeTab("LOG"));
  logTabs.appendChild(makeTab("RUMORS"));
  logContainer.appendChild(logTabs);
  
  // Display entries (newest first)
  const allEntries = [...gameState.log.entries].reverse();
  const entries = currentView === "RUMORS"
    ? allEntries.filter(entry => entry.context && entry.context.hintTargetAsteroidId)
    : allEntries;
  
  if (currentView === "RUMORS") {
    const rumorEntries = document.createElement("div");
    rumorEntries.className = "rumor-entries";
    
    if (entries.length === 0) {
      const emptyMessage = document.createElement("div");
      emptyMessage.className = "rumor-empty";
      emptyMessage.textContent = "No rumors yet.";
      rumorEntries.appendChild(emptyMessage);
    } else {
      entries.forEach((entry) => {
        const entryDiv = document.createElement("div");
        entryDiv.className = "rumor-card";
        
        const dayLabel = document.createElement("div");
        dayLabel.className = "rumor-day";
        dayLabel.textContent = `Day ${String(entry.day).padStart(3, '0')}:`;
        entryDiv.appendChild(dayLabel);
        
        const entryText = document.createElement("div");
        entryText.className = "rumor-text";
        entryText.textContent = entry.text;
        entryDiv.appendChild(entryText);
        
        if (entry.context && entry.context.hintTargetAsteroidId) {
          const targetId = entry.context.hintTargetAsteroidId;
          const isPinned = gameState.travel.activeRumorAsteroidIds &&
            gameState.travel.activeRumorAsteroidIds.has(targetId);
          const isCompleted = gameState.travel.completedRumorAsteroidIds &&
            gameState.travel.completedRumorAsteroidIds.has(targetId);
          const activeRumor = gameState.travel.purchasedRumors?.[targetId];
          const completedRumor = gameState.travel.completedRumors?.[targetId];
          const status = document.createElement("div");
          status.className = "rumor-status";
          status.textContent = completedRumor
            ? (completedRumor.isTrue ? "RESOLVED" : "FALSE LEAD")
            : activeRumor
              ? `ACTIVE ${String(activeRumor.kind || "lead").toUpperCase()}`
              : isPinned
                ? "PINNED"
                : "CLICK TO PIN";
          entryDiv.appendChild(status);
          if (isPinned) {
            entryDiv.classList.add("is-active");
          }
          if (isCompleted) {
            entryDiv.classList.add("is-completed");
          }
          entryDiv.addEventListener("click", () => {
            if (isCompleted) return;
            if (!gameState.travel.activeRumorAsteroidIds) {
              gameState.travel.activeRumorAsteroidIds = new Set();
            }
            if (gameState.travel.activeRumorAsteroidIds.has(targetId)) {
              gameState.travel.activeRumorAsteroidIds.delete(targetId);
            } else {
              gameState.travel.activeRumorAsteroidIds.add(targetId);
            }
            renderLog();
          });
        }
        
        rumorEntries.appendChild(entryDiv);
      });
    }
    
    logContainer.appendChild(rumorEntries);
  } else {
  // Log entries container (scrollable)
  const logEntries = document.createElement("div");
  logEntries.className = "log-entries";
  logEntries.style.width = "100%";
  logEntries.style.height = "calc(100% - 60px)";
  logEntries.style.overflowY = "auto";
  logEntries.style.overflowX = "hidden";
  logEntries.style.padding = "12px";
  logEntries.style.border = "2px solid var(--paper)";
  logEntries.style.borderRadius = "12px";
  logEntries.style.backgroundColor = "var(--panel-black)";
  
  if (entries.length === 0) {
    const emptyMessage = document.createElement("div");
    emptyMessage.style.color = "var(--paper)";
    emptyMessage.style.opacity = "0.5";
    emptyMessage.style.fontStyle = "italic";
    emptyMessage.style.padding = "12px";
    emptyMessage.textContent = "No log entries yet.";
    logEntries.appendChild(emptyMessage);
  } else {
    entries.forEach((entry, index) => {
      const entryDiv = document.createElement("div");
      entryDiv.className = "log-entry";
      entryDiv.style.marginBottom = index < entries.length - 1 ? "18px" : "0";
      entryDiv.style.paddingBottom = index < entries.length - 1 ? "18px" : "0";
      entryDiv.style.borderBottom = index < entries.length - 1 ? "1px dotted var(--ship-blue)" : "none";
      
      // Day number
      const dayLabel = document.createElement("div");
      dayLabel.style.fontWeight = "900";
      dayLabel.style.fontSize = "16px";
      dayLabel.style.color = "var(--paper)";
      dayLabel.style.marginBottom = "8px";
      dayLabel.textContent = `Day ${String(entry.day).padStart(3, '0')}:`;
      entryDiv.appendChild(dayLabel);
      
      // Entry text
      const entryText = document.createElement("div");
      entryText.style.fontWeight = "400";
      entryText.style.fontSize = "14px";
      entryText.style.color = "var(--paper)";
      entryText.style.lineHeight = "1.6";
      entryText.textContent = entry.text;
      entryDiv.appendChild(entryText);
      
      logEntries.appendChild(entryDiv);
    });
  }
  
  logContainer.appendChild(logEntries);
  }
  
  // Re-add canvas and scene container to DOM first (hidden) so they remain available
  if (canvas) {
    canvas.hidden = true;
    canvas.style.display = "none";
    canvas.style.visibility = "hidden";
    viewportContent.appendChild(canvas);
    el.canvas = canvas;
  }
  if (sceneContainer) {
    sceneContainer.hidden = true;
    sceneContainer.setAttribute("hidden", "");
    sceneContainer.style.display = "none";
    sceneContainer.style.visibility = "hidden";
    viewportContent.appendChild(sceneContainer);
    el.sceneContainer = sceneContainer;
  }
  
  // Add log container last so it appears on top
  viewportContent.appendChild(logContainer);
}

/**
 * Use a life support supply item
 * @param {string} supplyId Supply ID to use
 * @returns {boolean} True if successfully used, false otherwise
 */
function useSupply(supplyId) {
  const supplyDef = SUPPLY_DEFS[supplyId];
  if (!supplyDef) {
    console.warn(`Unknown supply: ${supplyId}`);
    return false;
  }
  
  if (supplyDef.subtype !== "LIFE_SUPPORT") {
    console.warn(`Supply ${supplyId} is not a life support item`);
    return false;
  }
  
  const supplyStack = gameState.inventory.supplies[supplyId];
  if (!supplyStack || supplyStack.qty <= 0) {
    console.warn(`No ${supplyDef.name} available`);
    return false;
  }
  
  // Apply effect
  const effect = supplyDef.effect;
  if (effect.type === "ADD_LIFE_DAYS") {
    // Convert days to percentage: 1 day = 3.333% (100% / 30 days)
    const daysToAdd = effect.days || 0;
    const percentToAdd = daysToAdd * (100 / 30);
    gameState.stats.lifeSupport = Math.min(100, gameState.stats.lifeSupport + percentToAdd);
  } else if (effect.type === "SET_LIFE_FULL") {
    gameState.stats.lifeSupport = 100;
  }
  
  // Consume 1 quantity
  supplyStack.qty--;
  
  // Update UI
  render();
  
  return true;
}

/**
 * Use a medical supply item on a crew member
 * @param {string} supplyId Supply ID to use
 * @param {string} crewMemberId Crew member ID to treat
 * @returns {boolean} True if successfully used, false otherwise
 */
function useMedicalSupply(supplyId, crewMemberId) {
  const supplyDef = SUPPLY_DEFS[supplyId];
  if (!supplyDef) {
    console.warn(`Unknown supply: ${supplyId}`);
    return false;
  }
  
  if (supplyDef.subtype !== "MEDICAL") {
    console.warn(`Supply ${supplyId} is not a medical item`);
    return false;
  }
  
  const supplyStack = gameState.inventory.supplies[supplyId];
  if (!supplyStack || supplyStack.qty <= 0) {
    console.warn(`No ${supplyDef.name} available`);
    return false;
  }
  
  // Find crew member
  const crewMember = gameState.crew.members.find(m => m.id === crewMemberId);
  if (!crewMember) {
    console.warn(`Crew member not found: ${crewMemberId}`);
    return false;
  }
  
  // Check if crew member's status is treatable
  const effect = supplyDef.effect;
  if (effect.type !== "TREAT_CONDITION" || !effect.treats || !effect.treats.includes(crewMember.status)) {
    console.warn(`${supplyDef.name} cannot treat status: ${crewMember.status}`);
    return false;
  }
  
  // Apply treatment
  if (effect.result) {
    crewMember.status = effect.result;
  }
  
  // Consume 1 quantity
  supplyStack.qty--;
  
  // Update UI
  render();
  
  return true;
}

/**
 * Get applicable medical supplies for a crew member's current status
 * @param {string} crewStatus Current crew member status
 * @returns {Array<SupplyDef>} Array of applicable supply definitions
 */
function getApplicableMedicalSupplies(crewStatus) {
  return Object.values(SUPPLY_DEFS).filter(supplyDef => {
    if (supplyDef.subtype !== "MEDICAL") return false;
    if (supplyDef.effect.type !== "TREAT_CONDITION") return false;
    if (!supplyDef.effect.treats || !supplyDef.effect.treats.includes(crewStatus)) return false;
    
    // Check if we have any in inventory
    const supplyStack = gameState.inventory.supplies[supplyDef.id];
    return supplyStack && supplyStack.qty > 0;
  });
}

/**
 * Apply damage to the ship
 * @param {number} damageAmount Amount of damage (0-100)
 * @param {string} cause Optional flavor text describing the cause
 */
function applyShipDamage(damageAmount, cause = "") {
  addShipIntegrity(gameState, -damageAmount);
  checkEndConditions();
  if (isRunOver()) return;

  // Randomly assign damage to one subsystem
  const subsystems = ["STRUCTURAL", "ELECTRICAL", "LIFE_SUPPORT"];
  const randomSubsystem = subsystems[Math.floor(Math.random() * subsystems.length)];
  
  // Add damage to the selected subsystem
  gameState.ship.subsystems[randomSubsystem].damage = Math.min(100, 
    gameState.ship.subsystems[randomSubsystem].damage + damageAmount
  );
  
  // Set flavor text if provided
  if (cause) {
    gameState.ship.subsystems[randomSubsystem].flavorText = cause;
  }
  
  // Update UI
  render();
}

/**
 * Use a repair item
 * @param {string} partId Part ID to use
 * @returns {boolean} True if successfully used, false otherwise
 */
function useRepairPart(partId) {
  const partDef = SHIP_PART_DEFS[partId];
  if (!partDef || partDef.type !== "REPAIR") {
    console.warn(`Unknown or invalid repair part: ${partId}`);
    return false;
  }
  
  const quantity = gameState.inventory.parts[partId] || 0;
  if (quantity <= 0) {
    console.warn(`No ${partDef.name} available`);
    return false;
  }
  
  const repairAmount = partDef.repairAmount || 0;
  const subtype = partDef.subtype || "ANY";
  
  // Calculate repair: always improves integrity, but only fully repairs if subtype matches
  let actualRepair = repairAmount;
  
  if (subtype !== "ANY") {
    // Check if this subsystem has damage
    const subsystemDamage = gameState.ship.subsystems[subtype].damage;
    if (subsystemDamage > 0) {
      // Full repair: remove all damage from this subsystem
      gameState.ship.subsystems[subtype].damage = 0;
      gameState.ship.subsystems[subtype].flavorText = "";
      actualRepair = repairAmount; // Full repair amount
    } else {
      // Subsystem not damaged, but still repair integrity
      actualRepair = repairAmount * 0.5; // Half effectiveness if wrong subsystem
    }
  } else {
    // Universal repair: repair all subsystems proportionally
    const totalDamage = gameState.ship.subsystems.STRUCTURAL.damage +
                       gameState.ship.subsystems.ELECTRICAL.damage +
                       gameState.ship.subsystems.LIFE_SUPPORT.damage;
    
    if (totalDamage > 0) {
      // Distribute repair across all damaged subsystems
      const repairPerSubsystem = repairAmount / 3;
      Object.keys(gameState.ship.subsystems).forEach(sub => {
        if (gameState.ship.subsystems[sub].damage > 0) {
          gameState.ship.subsystems[sub].damage = Math.max(0, 
            gameState.ship.subsystems[sub].damage - repairPerSubsystem
          );
          if (gameState.ship.subsystems[sub].damage === 0) {
            gameState.ship.subsystems[sub].flavorText = "";
          }
        }
      });
      actualRepair = repairAmount; // Full repair amount for universal
    } else {
      actualRepair = repairAmount * 0.5; // Half effectiveness if no subsystem damage
    }
  }
  
  addShipIntegrity(gameState, actualRepair);

  // Consume 1 quantity
  gameState.inventory.parts[partId]--;
  
  // Update UI
  render();
  
  return true;
}

/**
 * Apply an upgrade
 * @param {string} partId Part ID of the upgrade
 * @returns {boolean} True if successfully applied, false otherwise
 */
function applyUpgrade(partId) {
  const partDef = SHIP_PART_DEFS[partId];
  if (!partDef || partDef.type !== "UPGRADE") {
    console.warn(`Unknown or invalid upgrade: ${partId}`);
    return false;
  }
  
  const quantity = gameState.inventory.parts[partId] || 0;
  if (quantity <= 0) {
    console.warn(`No ${partDef.name} available`);
    return false;
  }
  
  const upgradeType = partDef.upgradeType;
  const upgradeLevel = partDef.upgradeLevel || 1;
  
  // Check if we can apply this upgrade (must be next tier)
  const currentLevel = gameState.ship.upgrades[upgradeType.toLowerCase()] || 0;
  if (upgradeLevel !== currentLevel + 1) {
    console.warn(`Cannot apply ${partDef.name}: need tier ${currentLevel + 1}, got tier ${upgradeLevel}`);
    return false;
  }
  
  // Apply upgrade
  gameState.ship.upgrades[upgradeType.toLowerCase()] = upgradeLevel;
  
  // Consume 1 quantity
  gameState.inventory.parts[partId]--;
  
  // Update UI
  render();
  
  return true;
}

/**
 * Get current scan radius multiplier (1.0 base + 0.25 per scanner tier)
 * @returns {number} Scan radius multiplier
 */
function getScanRadiusMultiplier() {
  const scannerTier = gameState.ship.upgrades.scanner || 0;
  return 1.0 + (scannerTier * 0.25) + getCrewBonus("scanRange");
}

/**
 * Get current ship speed multiplier (1.0 base + 0.05 per engine tier)
 * @returns {number} Speed multiplier
 */
function getShipSpeedMultiplier() {
  const engineTier = gameState.ship.upgrades.engine || 0;
  return 1.0 + (engineTier * 0.05) + getCrewBonus("travelSpeed");
}

/**
 * Hide the canvas + scene container and stop the map animation loop. Used
 * by all non-TRAVEL tabs so they don't fight the map for the viewport.
 */
function hideMapSurfaces() {
  if (el.canvas) {
    el.canvas.hidden = true;
    el.canvas.style.display = "none";
    el.canvas.style.visibility = "hidden";
  }
  if (el.sceneContainer) {
    el.sceneContainer.hidden = true;
    el.sceneContainer.setAttribute("hidden", "");
    el.sceneContainer.style.display = "none";
    el.sceneContainer.style.visibility = "hidden";
  }
  stopAnimationLoop();
}

/**
 * Reset the right-hand preview frame to its placeholder state. Used by
 * non-TRAVEL tabs (and the SETTINGS placeholder) to clear stale art.
 */
function resetPreviewPlaceholder() {
  if (!el.previewFrame) return;
  const previewImg = el.previewFrame.querySelector("img");
  if (previewImg) previewImg.style.display = "none";
  if (el.previewPlaceholder) {
    el.previewPlaceholder.style.display = "flex";
    el.previewPlaceholder.textContent = "PREVIEW";
  }
}

/**
 * Placeholder for the SETTINGS tab. The SETTINGS button exists in the
 * HTML but no settings UI has been built yet — this keeps the tab
 * navigable without leaving stale CREW/SHIP/INVENTORY DOM in place.
 */
function renderSettings() {
  // No-op for now: hideMapSurfaces() + resetPreviewPlaceholder() handle the
  // visual state. When real settings UI is added, build it here.
}

/**
 * Render registry for non-TRAVEL tabs. Each entry hides the map surfaces
 * and clears the preview, then delegates to the per-tab renderer. The
 * TRAVEL tab is special-cased below because of map/scene/event branching.
 */
const NON_TRAVEL_TAB_RENDERERS = {
  CREW: renderCrew,
  SHIP: renderShip,
  INVENTORY: renderInventory,
  LOG: renderLog,
  SETTINGS: renderSettings,
};

function render() {
  renderHeader();
  renderNav();
  renderStats();
  updateTravelButton();

  syncHullIntegrity(gameState);

  const tab = gameState.meta.tab;
  const tabRenderer = NON_TRAVEL_TAB_RENDERERS[tab];
  if (tabRenderer) {
    hideMapSurfaces();
    resetPreviewPlaceholder();
    tabRenderer();
    return;
  }

  if (tab === "TRAVEL") {
    // Clear any crew, ship, inventory, or log content that might be in viewport-content
    const viewportContent = document.getElementById("viewport-content");
    if (viewportContent) {
      const crewContainer = document.getElementById("crew-container");
      if (crewContainer) {
        crewContainer.remove();
      }
      const shipContainer = document.getElementById("ship-container");
      if (shipContainer) {
        shipContainer.remove();
      }
      const inventoryContainer = document.getElementById("inventory-container");
      if (inventoryContainer) {
        inventoryContainer.remove();
      }
      const logContainer = document.getElementById("log-container");
      if (logContainer) {
        logContainer.remove();
      }
    }
    if (gameState.travel.currentSceneId === "MAP") {
      // Show map - explicitly hide scene container
      // BUT: Don't hide if trader merchant is active (it uses scene container)
      if (el.canvas) {
        el.canvas.hidden = false;
        el.canvas.removeAttribute("hidden");
        el.canvas.style.display = "block";
        el.canvas.style.visibility = "visible";
      }
      if (el.sceneContainer && !gameState.travel.traderMerchantActive) {
        el.sceneContainer.hidden = true;
        el.sceneContainer.setAttribute("hidden", "");
        el.sceneContainer.style.display = "none";
        el.sceneContainer.style.visibility = "hidden";
      }
      // Start animation loop if not already running
      // The loop will call drawMap() continuously
      if (gameState.travel.animationLoopId === null) {
        startAnimationLoop();
      }
      // Render preview for TRAVEL tab on MAP view
      renderPreview();
    } else {
      // Show scene - only if we have valid location and scene data
      // BUT: Skip scene rendering if an event is active (event overlay handles display)
      // OR if trader merchant is active (trader merchant handles its own rendering)
      const locationId = gameState.travel.currentLocationId;
      const sceneId = gameState.travel.currentSceneId;
      
      // Only render scene if we have both location and scene IDs AND no event is active AND trader merchant is not active
      // If trader merchant is active, skip scene rendering (trader merchant handles its own rendering)
      if (locationId && sceneId && sceneId !== "MAP" && !gameState.travel.isEventActive && !gameState.travel.traderMerchantActive) {
        if (el.canvas) {
          el.canvas.hidden = true;
          el.canvas.style.display = "none";
        }
        if (el.sceneContainer) {
          el.sceneContainer.hidden = false;
          el.sceneContainer.removeAttribute("hidden");
          el.sceneContainer.style.display = "flex";
        }
        // Stop animation loop when entering a scene
        stopAnimationLoop();
        // Clear any active scan pulse when leaving MAP view
        if (gameState.travel.scanPulse.isActive) {
          gameState.travel.scanPulse.isActive = false;
          gameState.travel.scanPulse.startTime = null;
        }
        renderScene(locationId, sceneId);
        
        const locationDef = findLocationData(locationId);
        
        // Render dockyard overlay when in dockyard scene or dockyard room
        if (sceneId === "INTERIOR_DOCKYARD" || (sceneId === "HANGAR_ROOM" && gameState.travel.serviceOverlay === "dockyard")) {
          renderDockyard(locationId);
        } else if (sceneId === "INTERIOR_CLINIC" || (sceneId === "MEDBAY_ROOM" && gameState.travel.serviceOverlay === "clinic")) {
          renderClinic(locationId);
        } else if (sceneId === "INTERIOR_CANTINA" || (sceneId === "CANTINA_ROOM" && gameState.travel.serviceOverlay === "cantina")) {
          renderCantina(locationId);
        } else if (sceneId === "OUTPOST_MECHANIC" && locationDef?.type === "outpost") {
          renderOutpostDockyard(locationId);
        } else if (sceneId === "OUTPOST_RUMOR" && locationDef?.type === "outpost") {
          renderOutpostRumorKiosk(locationId);
        } else if (sceneId === "ADMIN_ROOM" && gameState.travel.serviceOverlay === "admin") {
          renderAdminOverlay(locationId);
        } else {
          // Render store overlay only when in buy/sell mode AND on a store scene
          const isStoreScene = sceneId === "INTERIOR_MARKET" || sceneId === "MERCHANT" || sceneId === "GENERAL_STORE_ROOM";
          if ((gameState.travel.generalStoreMode === "buy" || gameState.travel.generalStoreMode === "sell") && isStoreScene) {
            if (locationDef) {
              renderGeneralStore(locationId, locationDef);
            }
          } else {
            hideOverlayLayer();
          }
        }
        
        // Render preview for TRAVEL tab in scene view
        renderPreview();
      } else if (gameState.travel.isEventActive) {
        // Event is active - ensure canvas is visible (event overlay covers it)
        if (el.canvas) {
          el.canvas.hidden = false;
          el.canvas.removeAttribute("hidden");
          el.canvas.style.display = "block";
          el.canvas.style.visibility = "visible";
        }
        if (el.sceneContainer) {
          el.sceneContainer.hidden = true;
          el.sceneContainer.setAttribute("hidden", "");
          el.sceneContainer.style.display = "none";
          el.sceneContainer.style.visibility = "hidden";
        }
        // Keep animation loop running for map background
        if (gameState.travel.animationLoopId === null) {
          startAnimationLoop();
        }
        renderPreview();
      } else if (shouldSuppressTravelMapFallback(gameState)) {
        // Trader / merchant overlay: scene branch was skipped on purpose — do not force MAP.
        if (el.canvas) {
          el.canvas.hidden = false;
          el.canvas.removeAttribute("hidden");
          el.canvas.style.display = "block";
          el.canvas.style.visibility = "visible";
        }
        if (el.sceneContainer) {
          el.sceneContainer.hidden = false;
          el.sceneContainer.removeAttribute("hidden");
          el.sceneContainer.style.display = "flex";
          el.sceneContainer.style.visibility = "visible";
        }
        if (gameState.travel.animationLoopId === null) {
          startAnimationLoop();
        }
        renderPreview();
      } else {
        // Fallback: if scene data is missing, return to map
        if (el.canvas) {
          el.canvas.hidden = false;
          el.canvas.removeAttribute("hidden");
          el.canvas.style.display = "block";
        }
        if (el.sceneContainer) {
          el.sceneContainer.hidden = true;
          el.sceneContainer.setAttribute("hidden", "");
          el.sceneContainer.style.display = "none";
        }
        gameState.travel.currentSceneId = "MAP";
        drawMap();
        renderPreview();
      }
    }
    return;
  }

  // Unknown tab: fall back to a clean state.
  hideMapSurfaces();
  resetPreviewPlaceholder();
}

// ---------------------------
// Wiring
// ---------------------------

function wireUI() {
  // Debug: Check if elements exist
  if (!el.canvas) {
    console.error('ERROR: Canvas element not found! Check if #map-canvas exists in HTML.');
    return;
  }
  if (!el.actionTravel) {
    console.error('ERROR: Travel button not found! Check if #action-travel exists in HTML.');
  }
  if (el.navButtons.length === 0) {
    console.error('ERROR: No nav buttons found! Check if .nav-btn elements exist in HTML.');
  }

  // Nav tabs
  el.navButtons.forEach((btn) => {
    btn.addEventListener("click", () => {
      const tab = /** @type {Tab} */ (btn.getAttribute("data-tab"));
      setTab(tab);
    });
  });

  // Actions
  el.actionTravel?.addEventListener("click", (event) => {
    // Guard: disable travel when event is active
    if (gameState.travel.isEventActive) return;
    
    if (gameState.meta.tab !== "TRAVEL" || gameState.travel.currentSceneId !== "MAP") {
      return;
    }
    
    // If already traveling, don't start new travel
    if (gameState.travel.isTraveling) {
      return;
    }
    
    // If there's a selected destination different from current location, travel to it
    // (This matches the button text logic - button shows "TRAVEL" when destination is selected)
    const selectedId = gameState.travel.selectedDestinationId;
    if (selectedId && selectedId !== gameState.travel.currentLocationId) {
      // Proceed with travel logic (code continues below)
    } else {
      // No destination selected or same as current - check if we should land
      // Check if player is "arrived" at a location (should show LAND button)
      const isArrived = !gameState.travel.isTraveling &&
                        gameState.travel.currentSceneId === "MAP" &&
                        gameState.travel.currentLocationId !== null;
      
      if (isArrived) {
        // Check if current location is landable
        const currentLocationNode = mapNodes.find(n => n.id === gameState.travel.currentLocationId);
        if (currentLocationNode) {
          const landableTypes = ["station", "outpost", "asteroid", "ship", "earth", "moon", "mars"];
          const isLandable = landableTypes.includes(currentLocationNode.type);
          
          if (isLandable) {
            // Land at current location
            landAtCurrentLocation();
            return;
          }
        }
      }
      
      // No destination selected and not arrived - can't do anything
      if (!selectedId) {
        return;
      }
    }
    
    // Proceed with travel logic
    if (!selectedId) {
      // No destination selected - could show a message or do nothing
      return;
    }
    
    // Check for command-click (metaKey on Mac) to double speed
    const isDoubleSpeed = event.metaKey || event.ctrlKey;
    
    // Reset scan mode when travel starts (deep scan resets to regular scan)
    gameState.travel.scanMode = "scan";
    updateScanButtonText();
    
    // Start travel animation
    const currentLocationId = gameState.travel.currentLocationId;
    const travelDays = calculateTravelTime(currentLocationId, selectedId);
    
    // For asteroids/ships not in route, calculate approximate travel time
    // Travel time is now always calculated by the unified interception solver
    // If it's 0, the destination is invalid and we can't travel
    if (travelDays === 0) {
      return; // Can't travel to this destination
    }
    
    const actualTravelDays = travelDays;
    
    // Calculate and lock ghost position before starting travel
    // We'll calculate it in drawMap using the same method, but store the arrival day info
    // The actual screen coordinates will be calculated in drawMap based on current zoom/pan
    
    // Initialize travel state
    gameState.travel.isTraveling = true;
    gameState.travel.travelProgress = 0;
    gameState.travel.travelStartLocationId = currentLocationId;
    gameState.travel.travelDestinationId = selectedId;
    gameState.travel.travelTotalDays = actualTravelDays;
    gameState.travel.travelStartTime = perfNow();
    gameState.travel.travelStartDay = gameState.stats.day;
    // Store arrival day info for locked ghost calculation
    gameState.travel.lockedGhostPosition = { arrivalDay: gameState.stats.day + actualTravelDays };
    
    // Start animation loop
    // Travel speed matches wait button: 2 days per second = 500ms per day
    // Double speed if command-clicked: 4 days per second = 250ms per day
    const msPerDay = isDoubleSpeed ? 250 : 500;
    const travelDurationMs = actualTravelDays * msPerDay; // Total travel time in milliseconds
    
    function animateTravel() {
      if (!gameState.travel.isTraveling || !gameState.travel.travelStartTime) {
        return;
      }
      
      // Calculate progress based on elapsed time
      const elapsed = perfNow() - gameState.travel.travelStartTime;
      gameState.travel.travelProgress = Math.min(1, elapsed / travelDurationMs);
      
      // Advance days as travel progresses (matching wait button speed: 2 days per second, or 4 days per second if double speed)
      const daysElapsed = Math.floor(elapsed / msPerDay);
      const targetDay = gameState.travel.travelStartDay + daysElapsed;
      if (targetDay > gameState.stats.day) {
        advanceDays(targetDay - gameState.stats.day);
        // Update header stats immediately during travel (day + life support)
        if (gameState.meta.tab === "TRAVEL") {
          renderStats();
          renderHeader();
        }
      }
      
      if (gameState.travel.travelProgress >= 1) {
        // Travel complete - ensure all days are advanced and update location
        const finalDay = gameState.travel.travelStartDay + actualTravelDays;
        if (gameState.stats.day < finalDay) {
          advanceDays(finalDay - gameState.stats.day);
          if (gameState.meta.tab === "TRAVEL") {
            renderStats();
            renderHeader();
          }
        }
        gameState.travel.travelProgress = 1;
        gameState.travel.isTraveling = false;
        gameState.travel.travelStartLocationId = null;
        gameState.travel.travelDestinationId = null;
        gameState.travel.travelStartTime = null;
        gameState.travel.travelStartDay = 0;
        gameState.travel.lockedGhostPosition = null;
        gameState.travel.travelAnimationId = null;
        
        // On travel completion, stay on MAP (don't auto-land)
        // Set currentLocationId and selectedLocationId for preview, but keep scene as MAP
        gameState.travel.currentLocationId = selectedId;
        gameState.travel.selectedLocationId = selectedId;
        gameState.travel.selectedDestinationId = null;
        gameState.travel.currentSceneId = "MAP";
        
        debugLog("[ARRIVE]", selectedId, "scene=MAP");
        if (selectedId === "mars") {
          finishRun("WON", "You reached Mars before the mission collapsed.");
          return;
        }
        
        // If landing on the broadcast station, advance to next station
        const routeOrder = ["earth", "outpost-0", "station-01", "outpost-1", "station-02", "outpost-2", "station-03", "mars"];
        const stationOrder = ["station-01", "station-02", "station-03"];
        
        function normalizeNodeIdForRoute(nodeId) {
          if (!nodeId) return null;
          if (routeOrder.includes(nodeId)) return nodeId;
          for (const baseId of routeOrder) {
            if (nodeId.startsWith(baseId + "-")) {
              return baseId;
            }
          }
          return nodeId;
        }
        
        // Add any arrived station to discoveredNodes so it remains visible
        const arrivedNode = mapNodes.find(n => n.id === selectedId);
        if (arrivedNode && arrivedNode.type === "station") {
          if (!gameState.travel.discoveredNodes) {
            gameState.travel.discoveredNodes = new Set();
          }
          gameState.travel.discoveredNodes.add(selectedId);
          
          // If this is the broadcast station, advance to next station
          if (selectedId === gameState.travel.broadcastStationInstanceId) {
            // Find current station base ID
            const currentStationBase = gameState.travel.nextStationBaseId;
            if (currentStationBase) {
              const currentStationIndex = stationOrder.indexOf(currentStationBase);
              
              if (currentStationIndex !== -1 && currentStationIndex < stationOrder.length - 1) {
                // Advance to next station
                const nextStationBase = stationOrder[currentStationIndex + 1];
                gameState.travel.nextStationBaseId = nextStationBase;
                
                // Choose and lock the nearest instance of the next station
                const nearestInstance = chooseNearestStationInstance(nextStationBase, selectedId, gameState.stats.day);
                if (nearestInstance) {
                  gameState.travel.broadcastStationInstanceId = nearestInstance;
                } else {
                  // If no instance found, clear broadcast (shouldn't happen, but handle gracefully)
                  gameState.travel.nextStationBaseId = null;
                  gameState.travel.broadcastStationInstanceId = null;
                }
              } else {
                // No more stations, clear broadcast
                gameState.travel.nextStationBaseId = null;
                gameState.travel.broadcastStationInstanceId = null;
              }
            }
          }
        }
        
        // Outposts are now discovered via scan, not revealed on landing
        // Removed the logic that automatically reveals the next outpost
        
        // Stay on MAP - don't auto-land
        // Ensure animation loop is running for map rendering
        if (gameState.travel.animationLoopId === null) {
          startAnimationLoop();
        }
        render();
        return;
      }
      
      // Continue animation - don't call render() every frame, let the main loop handle it
      gameState.travel.travelAnimationId = requestAnimationFrame(animateTravel);
    }
    
    // Start the travel animation
    gameState.travel.travelAnimationId = requestAnimationFrame(animateTravel);
    render();
  });

  el.actionWait?.addEventListener("click", (event) => {
    if (gameState.travel.isWaiting) {
      // Stop waiting
      if (gameState.travel.waitIntervalId !== null) {
        clearInterval(gameState.travel.waitIntervalId);
        gameState.travel.waitIntervalId = null;
      }
      gameState.travel.isWaiting = false;
      if (el.actionWait) {
        el.actionWait.textContent = "WAIT";
        el.actionWait.classList.remove("is-active");
      }
    } else {
      // Check for command-click (metaKey on Mac) to double speed
      const isDoubleSpeed = event.metaKey || event.ctrlKey;
      
      // Start waiting - advance time at 2 days per second (or 4 days per second if double speed)
      gameState.travel.isWaiting = true;
      if (el.actionWait) {
        el.actionWait.textContent = "STOP";
        el.actionWait.classList.add("is-active");
      }
      
      // Advance 2 days every second (500ms interval for 1 day each = 2 days/second)
      // Or 4 days per second (250ms interval) if command-clicked
      // Wait function advances days at half life support consumption
      const intervalMs = isDoubleSpeed ? 250 : 500;
      gameState.travel.waitIntervalId = setInterval(() => {
        // Check if we've reached the deadline
        if (gameState.stats.day >= gameState.stats.deadline) {
          // Stop at deadline
          if (gameState.travel.waitIntervalId !== null) {
            clearInterval(gameState.travel.waitIntervalId);
            gameState.travel.waitIntervalId = null;
          }
          gameState.travel.isWaiting = false;
          if (el.actionWait) {
            el.actionWait.textContent = "WAIT";
            el.actionWait.classList.remove("is-active");
          }
          return;
        }
        
        // Advance days (life support at half rate while waiting)
        advanceDays(1, 0.5);
        render(); // Re-render to update orbital positions
      }, intervalMs); // 500ms = 1 day (2 days/second), or 250ms = 1 day (4 days/second) if double speed
    }
  });

  /**
   * Perform a scan from a specific position
   * @param {number} scanCenterRing Ring position for scan center
   * @param {number} scanCenterAngle Angle position for scan center
   * @param {boolean} isDeepScan Whether this is a deep scan
   * @param {boolean} isDoubleRadius Whether to double the scan radius
   */
  function performScan(scanCenterRing, scanCenterAngle, isDeepScan, isDoubleRadius) {
    if (isRunOver()) return;
    // Only scan when on the map view
    if (gameState.meta.tab !== "TRAVEL" || gameState.travel.currentSceneId !== "MAP") {
      debugLog("[SCAN] Blocked: not on MAP view");
      // Clear any stale scan pulse state if somehow we're not on MAP
      if (gameState.travel.scanPulse.isActive) {
        gameState.travel.scanPulse.isActive = false;
        gameState.travel.scanPulse.startTime = null;
      }
      return;
    }
    
    // Don't start a new scan if one is already active
    if (gameState.travel.scanPulse.isActive) {
      debugLog("[SCAN] Blocked: scan already active");
      return;
    }
    
    // Deep scan requires a selected target that has been basic scanned
    if (isDeepScan) {
      const selectedId = gameState.travel.selectedLocationId || gameState.travel.selectedDestinationId;
      if (!selectedId) {
        debugLog("[SCAN] Blocked: deep scan requires target selection");
        return;
      }
      const targetNode = mapNodes.find(n => n.id === selectedId);
      if (!targetNode) {
        debugLog("[SCAN] Blocked: target node not found", selectedId);
        return;
      }
      
      // Check if target has been basic scanned/discovered
      // Asteroids and ships must be in scannedNodes
      // Stations and outposts must be in discoveredNodes
      // Moon and Mars are always available
      let isBasicScanned = false;
      if (targetNode.type === "moon" || targetNode.type === "mars") {
        isBasicScanned = true;
      } else if (targetNode.type === "asteroid" || targetNode.type === "ship") {
        isBasicScanned = gameState.travel.scannedNodes && gameState.travel.scannedNodes.has(selectedId);
        debugLog("[SCAN] Deep scan check for", targetNode.type, selectedId, "isBasicScanned:", isBasicScanned, "scannedNodes has:", gameState.travel.scannedNodes ? Array.from(gameState.travel.scannedNodes) : "null");
      } else if (targetNode.type === "station" || targetNode.type === "outpost") {
        isBasicScanned = gameState.travel.discoveredNodes && gameState.travel.discoveredNodes.has(selectedId);
        debugLog("[SCAN] Deep scan check for", targetNode.type, selectedId, "isBasicScanned:", isBasicScanned, "discoveredNodes has:", gameState.travel.discoveredNodes ? Array.from(gameState.travel.discoveredNodes) : "null");
      }
      
      if (!isBasicScanned) {
        debugLog("[SCAN] Blocked: target not basic scanned/discovered", selectedId, "type:", targetNode.type);
        return;
      }
    }
    
    if (gameState.travel.scannerGlitchDays > 0 && Math.random() < 0.35) {
      logAdd("SCAN", `Day ${gameState.stats.day}: Scanner glitch spoiled the scan pulse.`, {});
      gameState.travel.scannerGlitchDays = Math.max(0, gameState.travel.scannerGlitchDays - 1);
      return;
    }

    // Determine scan radius. Scanner upgrades widen both basic and deep scans.
    let scanRadius = (isDeepScan ? 0.5 : 1.0) * getScanRadiusMultiplier();
    
    // Double radius if requested
    if (isDoubleRadius) {
      scanRadius *= 2;
      debugLog("[SCAN] Double radius enabled, new radius:", scanRadius);
    }
    
    // Start scan pulse animation
    gameState.travel.scanPulse.isActive = true;
    gameState.travel.scanPulse.startTime = perfNow();
    gameState.travel.scanPulse.centerRing = scanCenterRing;
    gameState.travel.scanPulse.centerAngle = scanCenterAngle;
    gameState.travel.scanPulse.maxRadius = scanRadius;
    gameState.travel.scanPulse.isDeepScan = isDeepScan;
    
    debugLog("[SCAN] Started", isDeepScan ? "deep" : "basic", "scan at ring", scanCenterRing, "angle", scanCenterAngle, "radius", scanRadius);
    
    // If this is a basic scan, switch to deep scan mode for next time
    if (!isDeepScan) {
      gameState.travel.scanMode = "deepScan";
    }
    
    // Update button text
    updateScanButtonText();
    
    // Ensure animation loop is running to draw the scan pulse
    if (gameState.travel.animationLoopId === null) {
      startAnimationLoop();
    }
  }
  
  el.actionScan?.addEventListener("click", (e) => {
    // Guard: disable scan when event is active
    if (gameState.travel.isEventActive) return;
    
    // Check for command-click (Mac) or Ctrl-click (Windows) to double scan radius
    const isDoubleRadius = e.metaKey || e.ctrlKey;
    
    debugLog("[SCAN] Button clicked", {
      tab: gameState.meta.tab,
      sceneId: gameState.travel.currentSceneId,
      currentLocationId: gameState.travel.currentLocationId,
      scanMode: gameState.travel.scanMode,
      isActive: gameState.travel.scanPulse.isActive,
      lifeSupport: gameState.stats.lifeSupport,
      doubleRadius: isDoubleRadius
    });
    
    // Check scan mode and requirements
    let isDeepScan = gameState.travel.scanMode === "deepScan";
    
    // Determine scan center
    let scanCenterRing, scanCenterAngle;
    
    if (isDeepScan) {
      // Deep scan: centered on selected target
      const selectedId = gameState.travel.selectedLocationId || gameState.travel.selectedDestinationId;
      
      // Validate that we have a target selected
      if (!selectedId) {
        // No target selected - fall back to basic scan
        debugLog("[SCAN] Deep scan requested but no target selected, falling back to basic scan");
        isDeepScan = false;
        gameState.travel.scanMode = "scan";
        if (el.actionScan) {
          el.actionScan.textContent = "SCAN";
        }
      } else {
      const targetNode = mapNodes.find(n => n.id === selectedId);
      if (!targetNode) {
        console.error("[SCAN] Error: target node not found", selectedId);
          // Fall back to basic scan if target node is missing
          isDeepScan = false;
          gameState.travel.scanMode = "scan";
          if (el.actionScan) {
            el.actionScan.textContent = "SCAN";
          }
        } else {
      scanCenterRing = getNodeCurrentRingGlobal(targetNode);
      const targetPeriod = targetNode.orbitalPeriod || getBaseOrbitalPeriod(targetNode.type);
      scanCenterAngle = calculateOrbitalAngle(gameState.stats.day, targetPeriod, targetNode.angle);
          
          // Immediate deep scan reveal: mark deep scanned and generate data now
          if (!gameState.travel.deepScannedNodes) {
            gameState.travel.deepScannedNodes = new Set();
          }
          gameState.travel.deepScannedNodes.add(targetNode.id);
          
          if (targetNode.type === "asteroid") {
            generateAsteroidDeepScanData(targetNode);
          } else if (targetNode.type === "ship") {
            generateShipDeepScanData(targetNode);
          }
          
          // Update header immediately so deep scan info shows before animation ends
          renderHeader();
        }
      }
    }
    
    // If we fell back to basic scan or it was already basic scan
    if (!isDeepScan) {
      // Basic scan: centered on player ship
      const currentLocationId = gameState.travel.currentLocationId;
      debugLog("[SCAN] Looking for current location node:", currentLocationId);
      const currentLocationNode = mapNodes.find(n => n.id === currentLocationId);
      if (!currentLocationNode) {
        console.error("[SCAN] Error: current location node not found", currentLocationId, "Available nodes:", mapNodes.map(n => n.id).filter(id => id.includes("station-03")));
        return;
      }
      
      scanCenterRing = getNodeCurrentRingGlobal(currentLocationNode);
      const currentPeriod = currentLocationNode.orbitalPeriod || getBaseOrbitalPeriod(currentLocationNode.type);
      scanCenterAngle = calculateOrbitalAngle(gameState.stats.day, currentPeriod, currentLocationNode.angle);
    }
    
    // Perform the scan
    performScan(scanCenterRing, scanCenterAngle, isDeepScan, isDoubleRadius);
  });
  
  // Helper function to update scan button text
  function updateScanButtonText() {
    if (el.actionScan) {
      el.actionScan.textContent = gameState.travel.scanMode === "deepScan" ? "DEEP SCAN" : "SCAN";
    }
  }
  
  // Initialize scan button text
  updateScanButtonText();

  // Canvas mouse events
  if (el.canvas) {
    // Pan functionality (click and drag)
    el.canvas.addEventListener("mousedown", (e) => {
      // Guard: freeze map interactions when event is active
      if (gameState.travel.isEventActive) return;
      
      if (gameState.meta.tab !== "TRAVEL" || gameState.travel.currentSceneId !== "MAP") return;
      if (e.button !== 0) return; // Only left mouse button
      
      const coords = getCanvasCoords(e);
      if (!coords) return;
      
      // Check if clicking on a node - if so, handle selection immediately and don't start panning
      const node = getNodeAt(coords.x, coords.y);
      if (node) {
        // Helper to check if node is basic scanned (for deep scan availability)
        const isBasicScanned = (n) => {
          if (!n) return false;
          // Earth, moon, mars are always considered scanned
          if (n.type === "moon" || n.type === "mars" || n.id === "earth") {
            return true;
          }
          // Stations and outposts are scanned if discovered
          if (n.type === "station" || n.type === "outpost") {
            return gameState.travel.discoveredNodes && gameState.travel.discoveredNodes.has(n.id);
          }
          // Asteroids and ships are scanned if in scannedNodes
          if (n.type === "asteroid" || n.type === "ship") {
            return gameState.travel.scannedNodes && gameState.travel.scannedNodes.has(n.id);
          }
          return false;
        };
        
        // Handle location selection immediately (for HUD display)
        if (gameState.travel.selectedLocationId === node.id) {
          // Clicking the same location again deselects it
          gameState.travel.selectedLocationId = null;
          // Reset scan mode when deselecting
          gameState.travel.scanMode = "scan";
        } else {
          gameState.travel.selectedLocationId = node.id;
          // Update scan mode based on whether the selected location is already basic scanned
          if (isBasicScanned(node)) {
            // Location is already scanned - enable deep scan mode
            gameState.travel.scanMode = "deepScan";
          } else {
            // Location is not scanned - use regular scan mode
            gameState.travel.scanMode = "scan";
          }
        }
        
        // Also handle destination selection for travel (if not current location)
        if (node.id !== gameState.travel.currentLocationId) {
          // Toggle destination selection
          if (gameState.travel.selectedDestinationId === node.id) {
            gameState.travel.selectedDestinationId = null;
          } else {
            gameState.travel.selectedDestinationId = node.id;
          }
        } else {
          // If clicking current location, clear destination selection
          gameState.travel.selectedDestinationId = null;
        }
        
        // Update scan button text based on current scan mode
        updateScanButtonText();
        
    render();
        return; // Don't start panning
      }
      
      // Start panning - record initial screen position and current pan values
      gameState.travel.isPanning = true;
      gameState.travel.hasPanned = false; // Reset - will be set to true if mouse moves
      gameState.travel.panStartX = coords.x;
      gameState.travel.panStartY = coords.y;
      gameState.travel.panStartPanX = gameState.travel.mapPanX;
      gameState.travel.panStartPanY = gameState.travel.mapPanY;
      el.canvas.style.cursor = "grabbing";
    });

    el.canvas.addEventListener("mousemove", (e) => {
      // Guard: freeze map interactions when event is active
      if (gameState.travel.isEventActive) return;
      
      if (gameState.meta.tab !== "TRAVEL" || gameState.travel.currentSceneId !== "MAP") return;
      
      const coords = getCanvasCoords(e);
      if (!coords) return;
      
      // Handle panning - keep the clicked point pinned to cursor
      if (gameState.travel.isPanning) {
        const dpr = window.devicePixelRatio || 1;
        const w = el.canvas.width;
        const h = el.canvas.height;
        const cx = w * 0.5;
        const cy = h * 0.5;
        const minSize = Math.min(w, h);
        
        // Use continuous zoom if active, otherwise use discrete
        let zoom;
        if (gameState.travel.useContinuousZoom) {
          zoom = gameState.travel.mapZoomContinuous;
        } else {
          const zoomScales = ZOOM_SCALES;
          const baseZoom = zoomScales[gameState.travel.mapZoomLevel] || 1.2;
          zoom = baseZoom * gameState.travel.mapZoomFine;
        }
        
        // Calculate how much the mouse moved in screen space
        const screenDx = coords.x - gameState.travel.panStartX;
        const screenDy = coords.y - gameState.travel.panStartY;
        
        // Check if there was actual movement (more than a few pixels to account for small jitter)
        const movementThreshold = 3; // pixels
        if (Math.abs(screenDx) > movementThreshold || Math.abs(screenDy) > movementThreshold) {
          gameState.travel.hasPanned = true;
        }
        
        // To keep the clicked point pinned to cursor, we need to move the pan in the same direction
        // as the mouse movement, scaled by zoom. The transform is:
        // screen = center + (world + pan*minSize) * zoom
        // So if screen moves by dx, pan needs to move by dx/(zoom*minSize) to keep world point fixed
        const dx = screenDx / (minSize * zoom);
        const dy = screenDy / (minSize * zoom);
        
        // Update pan from the initial pan position (not accumulating)
        gameState.travel.mapPanX = gameState.travel.panStartPanX + dx;
        gameState.travel.mapPanY = gameState.travel.panStartPanY + dy;
        
        drawMap();
        return;
      }
      
      // Handle hover
      const node = getNodeAt(coords.x, coords.y);
      const newHoveredId = node && node.id !== gameState.travel.currentLocationId ? node.id : null;
      
      if (newHoveredId !== gameState.travel.hoveredNodeId) {
        gameState.travel.hoveredNodeId = newHoveredId;
        el.canvas.style.cursor = newHoveredId ? "pointer" : "default";
        drawMap();
      }
    });

    el.canvas.addEventListener("mouseup", (e) => {
      if (gameState.travel.isPanning) {
        gameState.travel.isPanning = false;
        el.canvas.style.cursor = "default";
        // hasPanned flag will be checked in click handler
      }
    });

    el.canvas.addEventListener("mouseleave", () => {
      if (gameState.travel.isPanning) {
        gameState.travel.isPanning = false;
      }
      if (gameState.travel.hoveredNodeId !== null) {
        gameState.travel.hoveredNodeId = null;
        if (el.canvas) el.canvas.style.cursor = "default";
        drawMap();
      }
    });

    el.canvas.addEventListener("click", (e) => {
      // Guard: freeze map interactions when event is active
      if (gameState.travel.isEventActive) return;
      
      if (gameState.meta.tab !== "TRAVEL" || gameState.travel.currentSceneId !== "MAP") return;
      
      // Command-click (Mac) or Ctrl-click (Windows) on map triggers scan from that position
      if (e.metaKey || e.ctrlKey) {
        const coords = getCanvasCoords(e);
        if (!coords) return;
        
        const worldCoords = screenToWorldCoords(coords.x, coords.y);
        if (worldCoords) {
          // Trigger scan from clicked position
          performScan(worldCoords.ring, worldCoords.angle, false, false);
        }
        return;
      }
      
      // Don't handle clicks if we actually panned (dragged)
      if (gameState.travel.hasPanned) {
        gameState.travel.hasPanned = false; // Reset for next interaction
        return;
      }
      
      // Selection is already handled in mousedown for nodes, but this is a fallback
      // for cases where click fires without mousedown (shouldn't happen, but just in case)
      const coords = getCanvasCoords(e);
      if (!coords) return;
      
      const node = getNodeAt(coords.x, coords.y);
      if (node) {
        // Only handle if not already handled in mousedown (check if location changed)
        // This prevents duplicate handling
        const wasJustSelected = gameState.travel.selectedLocationId === node.id;
        if (!wasJustSelected) {
          // Set selected location to show in HUD
          if (gameState.travel.selectedLocationId === node.id) {
            gameState.travel.selectedLocationId = null;
          } else {
            gameState.travel.selectedLocationId = node.id;
          }
          
          // Also handle destination selection for travel (if not current location)
          if (node.id !== gameState.travel.currentLocationId) {
            if (gameState.travel.selectedDestinationId === node.id) {
              gameState.travel.selectedDestinationId = null;
            } else {
              gameState.travel.selectedDestinationId = node.id;
            }
          } else {
            gameState.travel.selectedDestinationId = null;
          }
          
          render();
        }
      } else {
        // Clicking on empty space deselects both location and destination
        if (gameState.travel.selectedLocationId !== null || gameState.travel.selectedDestinationId !== null) {
          gameState.travel.selectedLocationId = null;
          gameState.travel.selectedDestinationId = null;
          // Reset scan mode when deselecting
          gameState.travel.scanMode = "scan";
          updateScanButtonText();
          render();
        }
      }
    });
  }

  // Zoom controls — discrete snap levels with continuous fine-tuning.
  // MIN/MAX_CONTINUOUS_ZOOM and ZOOM_SCALES are imported from js/scheduler.js
  // so wheel/touch/keyboard handlers all agree.
  if (el.canvas) {
    // Promote the current discrete zoom level to a continuous zoom value
    // the first time a continuous-zoom input is used. Centralized to avoid
    // the same 4-line block being repeated in every input handler.
    function ensureContinuousZoom() {
      if (gameState.travel.useContinuousZoom) return;
      gameState.travel.mapZoomContinuous = resolveDiscreteZoom(gameState.travel);
      gameState.travel.useContinuousZoom = true;
    }

    // Mouse wheel zoom: discrete snap on normal scroll, continuous on pinch (Ctrl/Cmd).
    let wheelAccumulator = 0;
    
    el.canvas.addEventListener("wheel", (e) => {
      if (gameState.meta.tab !== "TRAVEL" || gameState.travel.currentSceneId !== "MAP") return;
      
      e.preventDefault();
      
      // Check if Ctrl or Cmd is held (trackpad pinch gesture)
      if (e.ctrlKey || e.metaKey) {
        // Pinch zoom - smooth continuous zoom
        // Initialize continuous zoom from current state if not already active
        ensureContinuousZoom();
        
        // Calculate zoom change - deltaY is negative when pinching out (zooming in)
        // Use exponential scaling for smooth, natural-feeling zoom
        // Invert deltaY: negative deltaY (pinch out) = zoom in, positive deltaY (pinch in) = zoom out
        const zoomDelta = -e.deltaY * 0.004; // Adjust sensitivity (0.004 = 2x more sensitive than before)
        const zoomFactor = 1.0 + zoomDelta;
        const newZoom = Math.max(MIN_CONTINUOUS_ZOOM, Math.min(MAX_CONTINUOUS_ZOOM, gameState.travel.mapZoomContinuous * zoomFactor));
        
        gameState.travel.mapZoomContinuous = newZoom;
        drawMap();
      } else {
        // Normal mouse wheel - use continuous zoom (no discrete snapping)
        // Initialize continuous zoom from current state if not already active
        ensureContinuousZoom();
        
        // Use continuous zoom with wheel
        const zoomDelta = -e.deltaY * 0.01; // Sensitivity for wheel scroll
        const zoomFactor = 1.0 + zoomDelta;
        const newZoom = Math.max(MIN_CONTINUOUS_ZOOM, Math.min(MAX_CONTINUOUS_ZOOM, gameState.travel.mapZoomContinuous * zoomFactor));
        
        gameState.travel.mapZoomContinuous = newZoom;
        drawMap();
      }
    }, { passive: false });

    // Pinch zoom (touch devices) - fluid continuous zoom
    let lastPinchDistance = null;

    el.canvas.addEventListener("touchstart", (e) => {
      if (gameState.meta.tab !== "TRAVEL" || gameState.travel.currentSceneId !== "MAP") return;
      if (e.touches.length === 2) {
        const touch1 = e.touches[0];
        const touch2 = e.touches[1];
        const dx = touch2.clientX - touch1.clientX;
        const dy = touch2.clientY - touch1.clientY;
        lastPinchDistance = Math.sqrt(dx * dx + dy * dy);
        
        // Initialize continuous zoom from current state
        ensureContinuousZoom();
      }
    });

    el.canvas.addEventListener("touchmove", (e) => {
      if (gameState.meta.tab !== "TRAVEL" || gameState.travel.currentSceneId !== "MAP") return;
      if (e.touches.length === 2 && lastPinchDistance !== null) {
        e.preventDefault();
        const touch1 = e.touches[0];
        const touch2 = e.touches[1];
        const dx = touch2.clientX - touch1.clientX;
        const dy = touch2.clientY - touch1.clientY;
        const currentDistance = Math.sqrt(dx * dx + dy * dy);
        
        // Calculate zoom using ratio for smooth continuous zoom (reversed: pinch out = zoom in, pinch in = zoom out)
        const distanceRatio = lastPinchDistance / currentDistance; // Reversed: larger ratio when pinching out
        const newZoom = Math.max(MIN_CONTINUOUS_ZOOM, Math.min(MAX_CONTINUOUS_ZOOM, gameState.travel.mapZoomContinuous * distanceRatio));
        
        gameState.travel.mapZoomContinuous = newZoom;
        gameState.travel.useContinuousZoom = true;
        lastPinchDistance = currentDistance;
        
        drawMap();
      }
    });

    el.canvas.addEventListener("touchend", () => {
      lastPinchDistance = null;
    });

    // Keyboard zoom (keypad +/- and regular +/-) - uses continuous zoom
    document.addEventListener("keydown", (e) => {
      if (gameState.meta.tab !== "TRAVEL" || gameState.travel.currentSceneId !== "MAP") return;
      if (document.activeElement?.tagName === "INPUT" || document.activeElement?.tagName === "TEXTAREA") return;
      
      // Check for +, -, = (for +), or keypad equivalents
      if (e.key === "+" || e.key === "=" || e.key === "NumpadAdd") {
        e.preventDefault();
        // Initialize continuous zoom if not already active
        ensureContinuousZoom();
        // Zoom in
        const zoomFactor = 1.1; // 10% zoom in per press
        const newZoom = Math.min(MAX_CONTINUOUS_ZOOM, gameState.travel.mapZoomContinuous * zoomFactor);
        gameState.travel.mapZoomContinuous = newZoom;
        drawMap();
      } else if (e.key === "-" || e.key === "_" || e.key === "NumpadSubtract") {
        e.preventDefault();
        // Initialize continuous zoom if not already active
        ensureContinuousZoom();
        // Zoom out
        const zoomFactor = 0.9; // 10% zoom out per press
        const newZoom = Math.max(MIN_CONTINUOUS_ZOOM, gameState.travel.mapZoomContinuous * zoomFactor);
        gameState.travel.mapZoomContinuous = newZoom;
        drawMap();
      } else if (e.key === "0" || e.key === "Numpad0") {
        // Reset to minimum zoom
        e.preventDefault();
        gameState.travel.mapZoomContinuous = MIN_CONTINUOUS_ZOOM;
        gameState.travel.useContinuousZoom = true;
        gameState.travel.mapPanX = 0;
        gameState.travel.mapPanY = 0;
        drawMap();
      }
    });
  }

  // Handle window resize - properly resize canvas and redraw
  let resizeTimeout = null;
  window.addEventListener("resize", () => {
    // Debounce resize to avoid excessive redraws
    if (resizeTimeout) {
      clearTimeout(resizeTimeout);
    }
    resizeTimeout = setTimeout(() => {
      // Force canvas to recalculate its size based on container
      if (el.canvas) {
        // Reset canvas dimensions to force recalculation
        const rect = el.canvas.getBoundingClientRect();
        const dpr = window.devicePixelRatio || 1;
        const w = Math.max(1, Math.floor(rect.width * dpr));
        const h = Math.max(1, Math.floor(rect.height * dpr));
        el.canvas.width = w;
        el.canvas.height = h;
      }
      
      // Redraw if on map view
      if (gameState.meta.tab === "TRAVEL" && gameState.travel.currentSceneId === "MAP") {
        // Use requestAnimationFrame to ensure layout has updated
        requestAnimationFrame(() => {
          drawMap();
        });
      }
    }, 100); // 100ms debounce
  });
}

const dispatchAction = createDispatchAction({
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
});

// Wait for DOM to be fully loaded before initializing
function initGame() {
  initDebugFromUrl();

  // Wire scheduler + time module now that all hooks/render are declared.
  setRenderFunction(render);
  _advanceDaysImpl = createAdvanceDays({
    gameState,
    processArtifactCarryRisks,
    processCrewDegradation,
    getLifeSupportDrainMultiplier,
    onAfterAdvance: checkEndConditions,
  });

  // Initialize random outpost image mapping for this playthrough
  if (!gameState.travel.outpostImageMapping) {
    gameState.travel.outpostImageMapping = initializeOutpostImageMapping();
  }
  
  // Initialize random asteroid and ship image mappings for this playthrough
  if (!gameState.travel.asteroidImageMapping) {
    const asteroidNodes = mapNodes.filter(n => n.type === "asteroid");
    gameState.travel.asteroidImageMapping = initializeAsteroidImageMapping(asteroidNodes);
  }
  
  if (!gameState.travel.shipImageMapping) {
    const shipNodes = mapNodes.filter(n => n.type === "ship");
    gameState.travel.shipImageMapping = initializeShipImageMapping(shipNodes);
  }
  
  // Initialize revealed nodes with the nearest station and outpost
  initializeRevealedNodes();
  
  // Initialize crew members
  if (!gameState.crew.members || gameState.crew.members.length === 0) {
    initializeCrew();
}
  
  // Seed dev starting inventory (if enabled)
  seedDevStartingInventory();

wireUI();
  
  // Ensure scene container is hidden on startup (map should be visible)
  // Force hide using both hidden attribute and display style
  if (el.sceneContainer) {
    el.sceneContainer.hidden = true;
    el.sceneContainer.setAttribute("hidden", "");
    el.sceneContainer.style.display = "none";
  }
  // Clear scene image to prevent it from showing
  if (el.sceneImage) {
    el.sceneImage.src = "";
    el.sceneImage.style.display = "none";
  }
  // Clear hotspots
  if (el.sceneHotspots) {
    el.sceneHotspots.innerHTML = "";
  }
  if (el.canvas) {
    el.canvas.hidden = false;
    el.canvas.removeAttribute("hidden");
    el.canvas.style.display = "block";
  }
  
  // Ensure we start on MAP view
  gameState.travel.currentSceneId = "MAP";
  
render();
  startAnimationLoop(); // Start continuous animation loop for smooth pulsing
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', () => {
    initGame();
  });
} else {
  // DOM is already loaded
  initGame();
}