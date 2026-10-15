'use strict';

// Pure, spatial game logic. Every action takes the current state and returns
// { state } on success or { error } on failure. No I/O here, so it is easy to
// unit test.
//
// The world is a 2D plane. Your active ship has a position; you mine the
// asteroid you are standing next to and you can only engage an enemy you are
// close to. The client only sends intents (its position, "buy X", "engage Y");
// all ranges, yields, rewards and timing are computed here.

const {
  SHIPS,
  MODULES,
  MINERALS,
  ENEMIES,
  START_ISK,
  START_STORY_ISK,
  MODES,
  MAX_OFFLINE_SECONDS,
  UPGRADE_BASE,
  UPGRADE_GROWTH,
  LEVEL_MULT,
  INSURANCE_FRACTION,
  SHIELD_BOOST_COST,
  SHIELD_BOOST_COOLDOWN,
  OVERLOAD_COST,
  OVERLOAD_DPS_MULT,
  OVERLOAD_DURATION,
  OVERLOAD_COOLDOWN,
  LOADOUTS,
  SKILLS,
  SP_RATE_PER_SEC,
  SP_PER_KILL,
  FACTIONS,
  SYSTEM_FACTION,
  STANDING_MIN,
  STANDING_MAX,
  STANDING_PER_KILL,
  STANDING_PER_DEATH,
  STANDING_PRICE_MOD,
  AMBUSH_BASE_CHANCE,
  AMBUSH_STANDING_MOD,
  AMBUSH_MIN_CHANCE,
  AMBUSH_MAX_CHANCE,
  DRONES,
  DRONE_MAX_PER_TYPE,
  LOOT_DROP_CHANCE,
  LOOT_TIERS,
  CRAFT_DISCOUNT,
  BLUEPRINTS,
  MISSION_ORDER,
  MISSION_ENEMIES,
  MISSIONS,
  WORLD_SIZE,
  ASTEROID_FIELDS,
  ASTEROIDS_PER_FIELD,
  ASTEROID_AMOUNT,
  ENEMY_COUNT,
  PLANET_COUNT,
  STATION_COUNT,
  MINING_RANGE,
  ENGAGE_RANGE,
  DOCK_RANGE,
  GATE_RANGE,
  MAX_SPEED,
  STATE_VERSION,
  THREAT_ISK_STEP,
  THREAT_STAT_GROWTH,
  THREAT_REWARD_GROWTH,
  THREAT_MAX,
} = require('./config');

let _counter = 0;
function nextId() {
  _counter += 1;
  return `ship_${_counter.toString(36)}_${Date.now().toString(36)}`;
}
function resetIds() {
  _counter = 0;
}

function clamp(v, lo, hi) {
  return Math.max(lo, Math.min(hi, v));
}
function clone(s) {
  return JSON.parse(JSON.stringify(s));
}
function levelMult(level) {
  return Math.pow(LEVEL_MULT, level - 1);
}
function shipMining(ship, mults, drone = 0) {
  return (SHIPS[ship.type].mining * levelMult(ship.level) + moduleBonus(ship, 'mining') + drone) * (mults ? mults.mining : 1);
}
function shipCombat(ship) {
  return SHIPS[ship.type].combat * levelMult(ship.level);
}
function shipDps(ship, mults, drone = 0) {
  return (SHIPS[ship.type].dps * levelMult(ship.level) + moduleBonus(ship, 'weapon') + drone) * (mults ? mults.dps : 1);
}
function shipShield(ship, mults) {
  return (SHIPS[ship.type].shield * levelMult(ship.level) + moduleBonus(ship, 'shield')) * (mults ? mults.shield : 1);
}
function shipHull(ship, mults) {
  return (SHIPS[ship.type].hull * levelMult(ship.level) + moduleBonus(ship, 'armor')) * (mults ? mults.hull : 1);
}
function shipCargo(ship, mults) {
  return (SHIPS[ship.type].cargo + moduleBonus(ship, 'cargo')) * (mults ? mults.cargo : 1);
}
// The loadout multipliers for a ship (defaults to the stock 'balanced' fit).
function loadoutMult(ship) {
  return LOADOUTS[ship && ship.loadout] || LOADOUTS.balanced;
}

// ---- fitting slots ----
// A ship's `fitting` maps each module type to an array (one entry per slot) of
// the tier fitted in that slot (0 = empty, 1..3 = tier I/II/III). The flat stat
// bonus a ship gets from every module fitted in a given type.
function moduleBonus(ship, slotType) {
  const fit = ship && ship.fitting && ship.fitting[slotType];
  if (!fit) return 0;
  const tiers = MODULES[slotType] && MODULES[slotType].tiers;
  if (!tiers) return 0;
  return fit.reduce((sum, t) => sum + (t > 0 ? tiers[t - 1].bonus : 0), 0);
}
// A fresh, all-empty fitting sized to the ship type's slot counts.
function emptyFitting(type) {
  const slots = SHIPS[type].slots;
  const fitting = {};
  for (const slotType of Object.keys(slots)) {
    fitting[slotType] = new Array(slots[slotType]).fill(0);
  }
  return fitting;
}

// ---- skill tree ----
// The combined multiplier each trained skill applies to a stat. Skills are
// player-level, so the same multipliers apply to every ship.
function skillMults(state) {
  const m = { mining: 1, cargo: 1, dps: 1, shield: 1, hull: 1, reward: 1 };
  const skills = state.skills || {};
  for (const key of Object.keys(SKILLS)) {
    const def = SKILLS[key];
    const lvl = skills[key] || 0;
    if (lvl > 0) m[def.effect.stat] *= 1 + def.effect.pctPerLevel * lvl;
  }
  return m;
}
// Skill points to train from `currentLevel` to `currentLevel + 1`.
function skillCost(def, currentLevel) {
  return Math.round(def.baseCost * Math.pow(def.costGrowth, currentLevel));
}
// Train a skill up one level, spending skill points.
function trainSkill(state, skillKey) {
  const def = SKILLS[skillKey];
  if (!def) return { error: `Unknown skill: ${skillKey}` };
  const s = clone(state);
  if (!s.skills) s.skills = emptySkills();
  const current = s.skills[skillKey] || 0;
  if (current >= def.maxLevel) return { error: 'Skill already at max level' };
  const cost = skillCost(def, current);
  if (s.skillPoints < cost) {
    return { error: `Not enough skill points (need ${cost}, have ${Math.floor(s.skillPoints)})` };
  }
  s.skillPoints -= cost;
  s.skills[skillKey] = current + 1;
  return { state: s };
}
// A fresh, all-level-0 skill set.
function emptySkills() {
  return Object.fromEntries(Object.keys(SKILLS).map((k) => [k, 0]));
}

// ---- drones ----
// A fresh, empty drone bay (one array of owned tiers per drone type).
function emptyDroneBay() {
  return Object.fromEntries(Object.keys(DRONES).map((k) => [k, []]));
}
// The total flat bonus your drone bay grants for a drone type ('mining'/'dps').
function droneBonus(state, droneType) {
  const def = DRONES[droneType];
  const bay = state && state.drones && state.drones[droneType];
  if (!def || !Array.isArray(bay)) return 0;
  return bay.reduce((sum, t) => sum + (t > 0 ? def.tiers[t - 1].bonus : 0), 0);
}
// Buy a drone of the given type and tier and add it to the bay. Drones are
// player-level: they apply to whichever ship you are flying and survive death.
function buyDrone(state, droneType, tier) {
  const def = DRONES[droneType];
  if (!def) return { error: `Unknown drone type: ${droneType}` };
  if (!Number.isInteger(tier) || tier < 1 || tier > def.tiers.length) {
    return { error: `Invalid drone tier: ${tier}` };
  }
  if (!isDocked(state)) return { error: 'Dock at a station to trade' };
  const s = clone(state);
  if (!s.drones) s.drones = emptyDroneBay();
  if (s.drones[droneType].length >= DRONE_MAX_PER_TYPE) {
    return { error: `Drone bay full (max ${DRONE_MAX_PER_TYPE} ${def.name}s)` };
  }
  const cost = def.tiers[tier - 1].cost;
  if (s.isk < cost) {
    return { error: `Not enough ISK (need ${cost}, have ${Math.floor(s.isk)})` };
  }
  s.isk -= cost;
  s.drones[droneType].push(tier);
  return { state: s };
}

// ---- loot drops ----
// Equip a looted module (see resolveCombat for how rats drop them) into the
// first empty slot of its type on the active ship, free of charge.
function equipLoot(state, lootId) {
  const s = clone(state);
  if (!Array.isArray(s.loot)) s.loot = [];
  const idx = s.loot.findIndex((l) => l && l.id === lootId);
  if (idx === -1) return { error: 'Loot not found' };
  const loot = s.loot[idx];
  const mod = MODULES[loot.slotType];
  if (!mod) return { error: `Unknown loot module type: ${loot.slotType}` };
  const ship = s.ships.find((sh) => sh.id === s.activeShipId);
  if (!ship) return { error: 'No active ship' };
  const slots = SHIPS[ship.type].slots;
  if (!slots[loot.slotType] || slots[loot.slotType] <= 0) {
    return { error: `Active ship has no ${mod.name} slots` };
  }
  if (!ship.fitting) ship.fitting = emptyFitting(ship.type);
  const arr = ship.fitting[loot.slotType];
  const free = arr.findIndex((t) => !t);
  if (free === -1) {
    return { error: `All ${mod.name} slots are occupied` };
  }
  arr[free] = loot.tier;
  s.loot.splice(idx, 1);
  return { state: s };
}

// Craft a module from raw minerals (see BLUEPRINTS). The ore is taken from the
// active ship's cargo hold (you must dock and haul the ore there), and the
// finished module goes into your loot inventory ready to equip. Crafting costs
// ~75% of the module's ISK price in mineral value, so it beats buying when you
// have the ore on hand.
function craftModule(state, slotType, tier) {
  const mod = MODULES[slotType];
  if (!mod) return { error: `Unknown module type: ${slotType}` };
  if (!mod.tiers[tier - 1]) return { error: `Invalid tier: ${tier}` };
  if (!isDocked(state)) return { error: 'Dock at a station to craft' };
  const s = clone(state);
  const active = s.ships.find((sh) => sh.id === s.activeShipId);
  if (!active) return { error: 'No active ship' };
  const bp = BLUEPRINTS[slotType][tier];
  for (const mKey of Object.keys(bp.recipe)) {
    if ((active.cargo[mKey] || 0) < bp.recipe[mKey]) {
      return { error: `Need ${bp.recipe[mKey]} ${MINERALS[mKey].name} to craft` };
    }
  }
  for (const mKey of Object.keys(bp.recipe)) {
    active.cargo[mKey] -= bp.recipe[mKey];
  }
  if (!Array.isArray(s.loot)) s.loot = [];
  s.loot.push({ id: nextId(), slotType, tier });
  if (s.mode === 'story' && s.mission && s.mission.active) {
    const mdef = MISSIONS[s.mission.active];
    if (mdef && mdef.objective.type === 'craft') {
      if (!s.mission.flags.crafted) s.mission.flags.crafted = {};
      const key = `${slotType}:${tier}`;
      s.mission.flags.crafted[key] = (s.mission.flags.crafted[key] || 0) + 1;
    }
    evaluateMission(s);
  }
  return { state: s };
}

// ---- faction standing ----
// A fresh, all-neutral standing (one entry per faction).
function emptyStanding() {
  return Object.fromEntries(Object.keys(FACTIONS).map((k) => [k, 0]));
}
// The faction that controls a given system (or null).
function factionForSystem(systemId) {
  return SYSTEM_FACTION[systemId] || null;
}
// Your standing with the faction that controls `systemId` (0 if unknown).
function standingFor(state, systemId) {
  const f = factionForSystem(systemId);
  if (!f || !state.standing) return 0;
  return state.standing[f] || 0;
}
// The market price multiplier for a system, from your standing with its faction.
function priceBonus(standing) {
  return 1 + standing * STANDING_PRICE_MOD;
}
// The effective (standing-adjusted) market prices for a system.
function effectivePrices(systemId, standing) {
  const base = systemPrices(systemId);
  const mult = priceBonus(standing);
  const out = {};
  for (const key of Object.keys(base)) out[key] = Math.max(1, Math.round(base[key] * mult));
  return out;
}
function upgradeCost(ship) {
  const base = UPGRADE_BASE * (SHIPS[ship.type].cost / 5000 + 1);
  return Math.floor(base * Math.pow(UPGRADE_GROWTH, ship.level - 1));
}
function shipInCombat(state, shipId) {
  return !!(state.combat && state.combat.shipId === shipId);
}
// Threat level rises with total ISK earned. Each level makes rats tougher
// (more defense) but also pay more, keeping combat meaningful as you progress.
function threatLevel(state) {
  const earned = (state.stats && state.stats.totalIskEarned) || 0;
  return Math.min(THREAT_MAX, Math.floor(earned / THREAT_ISK_STEP));
}
// A fresh, empty cargo hold (one key per mineral).
function emptyCargo() {
  return Object.fromEntries(Object.keys(MINERALS).map((k) => [k, 0]));
}
// Total minerals carried in the active ship's cargo hold.
function cargoUsed(state) {
  const active = state.ships.find((sh) => sh.id === state.activeShipId);
  return active ? Object.values(active.cargo).reduce((a, b) => a + b, 0) : 0;
}
function cargoCapacity(state) {
  const active = state.ships.find((sh) => sh.id === state.activeShipId);
  return active ? shipCargo(active, skillMults(state)) : 0;
}
function dist(ax, ay, bx, by) {
  return Math.hypot(ax - bx, ay - by);
}

// ---- real-time combat simulation ----
// A fight is a deterministic damage race: both sides deal constant DPS and the
// loser is whoever's hull hits zero first. The live shield/hull pools are kept
// as state and drained each tick, so in-fight actions (shield boost, overload,
// disengage) can change the pools/DPS mid-fight and the outcome follows. The
// winner is decided by each side's time-to-death from the *current* pools, so
// the server can tick by any step size (a 400ms sync or an offline gap) and
// always land on the same result.

// Split `damage` across a shield-then-hull pool. Returns the remaining {shield, hull}.
function applyPool(shieldMax, hullMax, damage) {
  const d = Math.max(0, damage);
  const shield = Math.max(0, shieldMax - Math.min(shieldMax, d));
  const hull = Math.max(0, hullMax - Math.max(0, d - shieldMax));
  return { shield, hull };
}

// The enemy's effective combat stats, scaled up by the current threat level.
function enemyCombatStats(type, threat, fallback = null) {
  const def = ENEMIES[type] || fallback;
  const g = 1 + THREAT_STAT_GROWTH * threat;
  return {
    shield: (def ? def.shield : 0) * g,
    hull: (def ? def.hull : 0) * g,
    dps: (def ? def.dps : 0) * g,
    reward: (def ? def.iskReward : 0) * (1 + THREAT_REWARD_GROWTH * threat),
    rangeDelay: def ? def.rangeDelay || 0 : 0,
  };
}

// The player's effective DPS (boosted while an overload is active).
function effectivePlayerDps(c) {
  return c.playerDps * (c.fightTime < c.overloadUntil ? OVERLOAD_DPS_MULT : 1);
}
// Seconds from now until the player's hull is gone (enemy DPS vs the player's
// remaining shield+hull pool). The enemy's guns are silent for the opening
// volley (`enemyRangeDelay` seconds of fight time), so that window is added on.
function playerTtd(c) {
  const pool = c.shipShield + c.shipHull;
  if (c.enemyDps <= 0) return Infinity;
  const remainingWindow = Math.max(0, c.enemyRangeDelay - c.fightTime);
  return remainingWindow + pool / c.enemyDps;
}
// Seconds from now until the enemy's hull is gone (effective player DPS vs the
// enemy's remaining pool).
function enemyTtd(c) {
  const pool = c.enemyShield + c.enemyHull;
  const pdps = effectivePlayerDps(c);
  return pdps > 0 ? pool / pdps : Infinity;
}
// Apply `dmg` to the player's live shield-then-hull pool (mutates c).
function damagePlayer(c, dmg) {
  const p = applyPool(c.shipShield, c.shipHull, dmg);
  c.shipShield = p.shield;
  c.shipHull = p.hull;
}
// Apply `dmg` to the enemy's live shield-then-hull pool (mutates c).
function damageEnemy(c, dmg) {
  const p = applyPool(c.enemyShield, c.enemyHull, dmg);
  c.enemyShield = p.shield;
  c.enemyHull = p.hull;
}

// The station the active ship is docked at (within DOCK_RANGE), or null.
function dockedStation(state) {
  const ship = state.ships.find((sh) => sh.id === state.activeShipId);
  const sys = activeSystem(state);
  if (!ship || !sys) return null;
  let best = null;
  let bd = Infinity;
  for (const st of sys.stations) {
    const d = dist(ship.x, ship.y, st.x, st.y);
    if (d <= DOCK_RANGE && d < bd) {
      bd = d;
      best = st;
    }
  }
  return best;
}
function isDocked(state) {
  return !!dockedStation(state);
}

// Deterministic PRNG so a world generated from a seed is stable.
function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// The systems the player can travel between. Each is a separate star system
// with its own POIs; gates link them (a triangle: Jita <-> Placid <-> Domain).
// `color` is a persistent, unique tint for the system's background so each
// system is memorable by its hue (the "green system", the "purple system").
const SYSTEM_DEFS = [
  { id: 'sys_0', name: 'Jita',   color: '#ff9f45', stationCount: 2, beltCount: 12, enemyCount: 10 },
  { id: 'sys_1', name: 'Placid', color: '#3fd6a0', stationCount: 2, beltCount: 16, enemyCount: 6 },
  { id: 'sys_2', name: 'Domain', color: '#a970ff', stationCount: 1, beltCount: 8,  enemyCount: 20 },
];
const GATE_LINKS = [
  [0, 1],
  [1, 2],
  [2, 0],
];

function hashStr(s) {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619) >>> 0;
  return h >>> 0;
}

// Each system has its own stable market: a per-mineral price derived from the
// base price and a deterministic multiplier in [0.5, 2.0]. The spread between
// systems is what makes hauling profitable (mine cheap, ship to a dear market).
function systemPrices(systemId) {
  const prices = {};
  for (const key of Object.keys(MINERALS)) {
    const base = MINERALS[key].price;
    const h = hashStr(`${systemId}:${key}`);
    const mult = 0.5 + (h / 4294967295) * 1.5;
    prices[key] = Math.max(1, Math.round(base * mult));
  }
  return prices;
}

// Generate a single star system's POIs. `profile` controls its character.
function generateWorld(seed, profile) {
  const rng = mulberry32(seed);
  const size = WORLD_SIZE;
  const cx = size / 2;
  const cy = size / 2;
  const mineralKeys = Object.keys(MINERALS);
  const planets = [];
  const moons = [];
  const stations = [];
  const belts = [];
  const asteroids = [];
  const enemies = [];
  let aid = 1;

  // The star anchors the system at the centre.
  const star = { id: 'star_1', x: cx, y: cy, size: 130 + rng() * 60, name: 'Sol' };

  // First station just off the star (where ships spawn in this system).
  const home = { id: 'stn_1', x: cx + 520, y: cy, name: 'Station A' };
  stations.push(home);

  // Any additional stations, kept far from the first.
  for (let i = 1; i < profile.stationCount; i++) {
    let x;
    let y;
    let tries = 0;
    do {
      x = 900 + rng() * (size - 1800);
      y = 900 + rng() * (size - 1800);
      tries++;
    } while (dist(x, y, home.x, home.y) < 2600 && tries < 40);
    stations.push({ id: `stn_${i + 1}`, x, y, name: `Station ${String.fromCharCode(66 + i)}` });
  }

  // Landmark planets, kept away from the star.
  const planetColors = ['#e0894c', '#5c9ce0', '#9ce05c', '#c95ce0', '#e05c7a', '#5ce0c8'];
  for (let i = 0; i < PLANET_COUNT; i++) {
    let x;
    let y;
    let tries = 0;
    do {
      x = 1000 + rng() * (size - 2000);
      y = 1000 + rng() * (size - 2000);
      tries++;
    } while (dist(x, y, cx, cy) < 1400 && tries < 40);
    planets.push({
      id: `pl_${i + 1}`,
      x,
      y,
      size: 70 + rng() * 90,
      color: planetColors[i % planetColors.length],
      name: `Planet ${String.fromCharCode(65 + i)}`,
      ring: rng() < 0.45,
    });
  }

  // A moon orbits a subset of the planets.
  for (const p of planets) {
    if (rng() < 0.6) {
      const ang = rng() * Math.PI * 2;
      const rad = p.size + 140 + rng() * 140;
      moons.push({
        id: `mn_${p.id}`,
        x: clamp(p.x + Math.cos(ang) * rad, 60, size - 60),
        y: clamp(p.y + Math.sin(ang) * rad, 60, size - 60),
        size: 18 + rng() * 14,
        name: `${p.name} Moon`,
      });
    }
  }

  // Asteroid belts: named clusters of mineable rocks.
  for (let f = 0; f < profile.beltCount; f++) {
    let fx;
    let fy;
    let tries = 0;
    do {
      fx = 500 + rng() * (size - 1000);
      fy = 500 + rng() * (size - 1000);
      tries++;
    } while (dist(fx, fy, cx, cy) < 900 && tries < 25);
    const fieldMineral = mineralKeys[Math.floor(rng() * mineralKeys.length)];
    belts.push({
      id: `belt_${f + 1}`,
      x: fx,
      y: fy,
      name: `Belt ${String.fromCharCode(65 + f)}`,
      mineral: fieldMineral,
    });
    const count =
      ASTEROIDS_PER_FIELD[0] +
      Math.floor(rng() * (ASTEROIDS_PER_FIELD[1] - ASTEROIDS_PER_FIELD[0] + 1));
    for (let i = 0; i < count; i++) {
      const ang = rng() * Math.PI * 2;
      // The first rock hugs the belt center so a ship parked on the belt is
      // always in mining range; the rest scatter out to the belt's edge.
      const rad = i === 0 ? 40 + rng() * 50 : 60 + rng() * 260;
      const x = clamp(fx + Math.cos(ang) * rad, 60, size - 60);
      const y = clamp(fy + Math.sin(ang) * rad, 60, size - 60);
      const mineral =
        rng() < 0.8 ? fieldMineral : mineralKeys[Math.floor(rng() * mineralKeys.length)];
      const amount =
        ASTEROID_AMOUNT[0] +
        Math.floor(rng() * (ASTEROID_AMOUNT[1] - ASTEROID_AMOUNT[0] + 1));
      asteroids.push({
        id: `ast_${aid++}`,
        x,
        y,
        mineral,
        amount,
        maxAmount: amount,
        seed: Math.floor(rng() * 1e9),
        size: 14 + rng() * 22,
        beltId: `belt_${f + 1}`,
      });
    }
  }

  // Rats roam the system.
  for (let i = 0; i < profile.enemyCount; i++) {
    const x = 400 + rng() * (size - 800);
    const y = 400 + rng() * (size - 800);
    const r = rng();
    const type = r < 0.45 ? 'pirate' : r < 0.75 ? 'gang' : r < 0.92 ? 'faction' : 'dread';
    enemies.push({ id: `en_${i + 1}`, x, y, type, alive: true, seed: Math.floor(rng() * 1e9) });
  }

  return {
    id: profile.id,
    name: profile.name,
    color: profile.color,
    width: size,
    height: size,
    star,
    planets,
    moons,
    stations,
    belts,
    asteroids,
    enemies,
    gates: [],
    prices: systemPrices(profile.id),
    seed,
  };
}

// Fixed gate slots within a system (two per system, on opposite sides of the star).
function gateSlot(idx) {
  const cx = WORLD_SIZE / 2;
  const cy = WORLD_SIZE / 2;
  return idx === 0 ? { x: cx - 1700, y: cy - 500 } : { x: cx + 1700, y: cy + 500 };
}

// Generate all systems and wire up the gates that link them.
function generateSystems(seed) {
  const systems = {};
  for (const def of SYSTEM_DEFS) {
    systems[def.id] = generateWorld((seed + hashStr(def.id)) >>> 0, def);
  }
  for (const [i, j] of GATE_LINKS) {
    const defA = SYSTEM_DEFS[i];
    const defB = SYSTEM_DEFS[j];
    const sysA = systems[defA.id];
    const sysB = systems[defB.id];
    const pA = gateSlot(sysA.gates.length);
    const pB = gateSlot(sysB.gates.length);
    sysA.gates.push({
      id: `gate_${i}_${j}`,
      x: pA.x,
      y: pA.y,
      targetSystemId: defB.id,
      targetGateId: `gate_${j}_${i}`,
      name: `Gate to ${defB.name}`,
    });
    sysB.gates.push({
      id: `gate_${j}_${i}`,
      x: pB.x,
      y: pB.y,
      targetSystemId: defA.id,
      targetGateId: `gate_${i}_${j}`,
      name: `Gate to ${defA.name}`,
    });
  }
  return systems;
}

function createInitialState(now = Date.now(), seed = (Date.now() % 1000000) + 1, mode = 'demo') {
  const systems = generateSystems(seed);
  const homeSystem = systems[SYSTEM_DEFS[0].id];
  const rifter = {
    id: nextId(),
    type: 'rifter',
    level: 1,
    x: homeSystem.stations[0].x,
    y: homeSystem.stations[0].y,
    systemId: homeSystem.id,
    cargo: emptyCargo(),
    loadout: 'balanced',
    fitting: emptyFitting('rifter'),
  };
  const st = {
    version: STATE_VERSION,
    mode: MODES.includes(mode) ? mode : 'demo',
    isk: mode === 'story' ? START_STORY_ISK : START_ISK,
    mission: { active: mode === 'story' ? 'm1' : null, step: 0, flags: {}, completed: [] },
    systems,
    ships: [rifter],
    activeShipId: rifter.id,
    lastTick: now,
    combat: null,
    combatLog: [],
    skillPoints: 0,
    skills: emptySkills(),
    standing: emptyStanding(),
    drones: emptyDroneBay(),
    loot: [],
    stats: {
      totalMineralsMined: 0,
      cargoLost: 0,
      combatsWon: 0,
      combatsLost: 0,
      shipsLost: 0,
      shipsBought: 0,
      totalIskEarned: 0,
      totalSpEarned: 0,
    },
  };
  if (mode === 'story') startMission(st, 'm1');
  return st;
}

// True if a persisted state is usable (right version, has systems).
function isValidState(state) {
  return (
    !!state &&
    state.version === STATE_VERSION &&
    !!state.systems &&
    Object.keys(state.systems).length > 0 &&
    Array.isArray(state.ships) &&
    state.ships.length > 0
  );
}

// The star system the active ship is currently in (or null).
function activeSystem(state) {
  const ship = state.ships.find((sh) => sh.id === state.activeShipId);
  return ship && state.systems ? state.systems[ship.systemId] || null : null;
}

function nearestAsteroidInRange(state, ship) {
  const sys = activeSystem(state);
  if (!sys) return null;
  let best = null;
  let bd = Infinity;
  for (const a of sys.asteroids) {
    if (a.amount <= 0) continue;
    const d = dist(a.x, a.y, ship.x, ship.y);
    if (d <= MINING_RANGE && d < bd) {
      bd = d;
      best = a;
    }
  }
  return best;
}

function mineActive(s, active, seconds) {
  const sys = activeSystem(s);
  if (!sys) return;
  const mults = skillMults(s);
  // Mining stops once the active ship's cargo hold is full.
  const room = shipCargo(active, mults) - cargoUsed(s);
  if (room <= 0) return;
  const budget = Math.min(shipMining(active, mults, droneBonus(s, 'mining')) * seconds, room);
  const inRange = [];
  for (const a of sys.asteroids) {
    if (a.amount <= 0) continue;
    const d = dist(a.x, a.y, active.x, active.y);
    if (d <= MINING_RANGE) inRange.push({ a, d });
  }
  if (!inRange.length) return;
  inRange.sort((p, q) => p.d - q.d);
  let left = budget;
  for (const { a } of inRange) {
    if (left <= 0) break;
    const take = Math.min(left, a.amount);
    a.amount -= take;
    left -= take;
    active.cargo[a.mineral] += take;
    s.stats.totalMineralsMined += take;
  }
}

// Advance the simulation to `now`. `pos` is the client-reported position of the
// active ship (used for spatial mining/combat). Collects idle mining and
// resolves any combat whose timer elapsed.
function tick(state, now = Date.now(), pos = null, rng = Math.random) {
  const s = clone(state);
  let elapsed = (now - s.lastTick) / 1000;
  if (!Number.isFinite(elapsed) || elapsed < 0) elapsed = 0;
  const seconds = Math.min(elapsed, MAX_OFFLINE_SECONDS);

  const active = s.ships.find((sh) => sh.id === s.activeShipId);
  const sys = activeSystem(s);
  if (active && sys && !shipInCombat(s, active.id) && pos && Number.isFinite(pos.x) && Number.isFinite(pos.y)) {
    // Light sanity clamp so a client cannot teleport across the map to a rich
    // field. Generous enough that normal movement is never affected.
    const maxJump = MAX_SPEED * (seconds + 1) * 3 + 200;
    const dx = pos.x - active.x;
    const dy = pos.y - active.y;
    const d = Math.hypot(dx, dy);
    let nx = clamp(pos.x, 0, sys.width);
    let ny = clamp(pos.y, 0, sys.height);
    if (d > maxJump) {
      const scale = maxJump / d;
      nx = clamp(active.x + dx * scale, 0, sys.width);
      ny = clamp(active.y + dy * scale, 0, sys.height);
    }
    active.x = nx;
    active.y = ny;
  }

  if (active && !shipInCombat(s, active.id) && seconds > 0) {
    const beforeMined = s.stats.totalMineralsMined || 0;
    mineActive(s, active, seconds);
    if (s.mode === 'story' && s.mission && s.mission.active) {
      const mdef = MISSIONS[s.mission.active];
      if (mdef && mdef.objective.type === 'mine') {
        s.mission.flags.mined = (s.mission.flags.mined || 0) + ((s.stats.totalMineralsMined || 0) - beforeMined);
      }
    }
  }
  // Skill points accrue over time (idle progression), including offline gaps.
  if (seconds > 0) {
    const sp = SP_RATE_PER_SEC * seconds;
    s.skillPoints += sp;
    s.stats.totalSpEarned += sp;
  }
  s.lastTick = now;

  // Advance the real-time fight (if any) by the elapsed time and resolve it the
  // moment one side's hull is gone.
  if (s.combat && Number.isFinite(s.combat.fightTime)) {
    const c = s.combat;
    const pdps = effectivePlayerDps(c);
    const ttd = Math.min(playerTtd(c), enemyTtd(c));
    if (seconds >= ttd) {
      // The fight ends within this tick. The enemy dies first (or it's a tie)
      // when its time-to-death is the shorter one.
      const won = enemyTtd(c) <= playerTtd(c);
      resolveCombat(s, now, won, rng);
    } else {
      const pdps = effectivePlayerDps(c);
      c.fightTime += seconds;
      // The enemy only deals damage for the portion of this tick that is past
      // its opening-volley window (range advantage); the player always fires.
      const enemyFire = clamp(c.fightTime - c.enemyRangeDelay, 0, seconds);
      damagePlayer(c, c.enemyDps * enemyFire);
      damageEnemy(c, pdps * seconds);
    }
  }
  evaluateMission(s);
  return s;
}

function resolveCombat(s, now, won, rng = Math.random) {
  const c = s.combat;
  const ship = s.ships.find((sh) => sh.id === c.shipId);
  const sys = ship && s.systems ? s.systems[ship.systemId] : null;
  const enemy = sys ? sys.enemies.find((e) => e.id === c.enemyId) : null;
  const shipName = ship ? SHIPS[ship.type].name : 'Unknown';
  const enemyName = enemy ? (ENEMIES[enemy.type] ? ENEMIES[enemy.type].name : enemy.name || enemy.type) : 'Unknown';
  let iskGain = 0;
  let shipLost = false;
  let cargoLost = 0;
  let insurance = 0;
  let lootDropped = null;

  // Snapshot the hold before it's lost, so the killmail can itemize the loot.
  const cargoSnapshot = ship ? { ...ship.cargo } : null;

  if (won) {
    iskGain = Math.floor(c.reward * skillMults(s).reward);
    s.isk += iskGain;
    s.stats.totalIskEarned = (s.stats.totalIskEarned || 0) + iskGain;
    s.skillPoints += SP_PER_KILL;
    s.stats.totalSpEarned = (s.stats.totalSpEarned || 0) + SP_PER_KILL;
    if (enemy) enemy.alive = false;
    s.stats.combatsWon += 1;
    // Loot: the rat can drop a module into your loot inventory. Stronger rats
    // drop better modules, more reliably (see LOOT_DROP_CHANCE / LOOT_TIERS).
    if (enemy && LOOT_DROP_CHANCE[enemy.type] != null) {
      const chance = LOOT_DROP_CHANCE[enemy.type];
      if (rng() < chance) {
        const tierPool = LOOT_TIERS[enemy.type];
        const tier = tierPool[Math.floor(rng() * tierPool.length)];
        const slotTypes = Object.keys(MODULES);
        const slotType = slotTypes[Math.floor(rng() * slotTypes.length)];
        if (!Array.isArray(s.loot)) s.loot = [];
        s.loot.push({ id: nextId(), slotType, tier });
        lootDropped = { slotType, tier };
      }
    }
  } else {
    shipLost = true;
    // The ship is destroyed: its cargo hold is lost with it, and insurance
    // refunds a fraction of the purchase cost (never the cargo).
    cargoLost = ship ? Object.values(ship.cargo).reduce((a, b) => a + b, 0) : 0;
    insurance = ship ? Math.floor(SHIPS[ship.type].cost * INSURANCE_FRACTION) : 0;
    s.stats.combatsLost += 1;
    s.stats.shipsLost += 1;
    s.stats.cargoLost = (s.stats.cargoLost || 0) + cargoLost;
    s.isk += insurance;
    s.ships = s.ships.filter((sh) => sh.id !== ship.id);
    if (s.activeShipId === ship.id) s.activeShipId = s.ships.length ? s.ships[0].id : null;
    // Respawn: if you lost your last ship, a free Rifter arrives at the local
    // station (your pod makes it home with a loaner) so the game can't soft-lock.
    // You still paid the price — the destroyed ship and its cargo are gone.
    // The scripted Last Stand (m3) suppresses the loaner: the clone respawn is
    // the story's job (the next mission hands you a replacement frigate).
    if (s.ships.length === 0 && sys && !(s.mission && s.mission.active === 'm3')) {
      const home = sys.stations[0];
      const pod = {
        id: nextId(),
        type: 'rifter',
        level: 1,
        x: home.x,
        y: home.y,
        systemId: sys.id,
        cargo: emptyCargo(),
        loadout: 'balanced',
        fitting: emptyFitting('rifter'),
      };
      s.ships.push(pod);
      s.activeShipId = pod.id;
    }
  }

  // Standing shifts with the outcome in the faction that controls this system:
  // clearing their rats earns their respect, losing a ship there costs it.
  const faction = sys ? factionForSystem(sys.id) : null;
  if (faction) {
    if (!s.standing) s.standing = emptyStanding();
    const delta = won ? STANDING_PER_KILL : STANDING_PER_DEATH;
    s.standing[faction] = clamp(s.standing[faction] + delta, STANDING_MIN, STANDING_MAX);
  }

  s.combatLog.unshift({
    at: now,
    enemy: enemyName,
    enemyType: enemy ? enemy.type : null,
    ship: shipName,
    shipType: ship ? ship.type : null,
    system: sys ? sys.name : null,
    won,
    isk: iskGain,
    shipLost,
    cargoLost,
    cargo: shipLost ? cargoSnapshot : null,
    insurance,
    loot: lootDropped,
  });
  if (s.combatLog.length > 20) s.combatLog.length = 20;
  s.combat = null;

  // Mission progress hooks: killing a mission target counts towards the current
  // objective; dying in the scripted Last Stand (m3) marks it done.
  if (s.mode === 'story' && s.mission) {
    if (won && enemy && enemy.missionTag) {
      const def = MISSIONS[s.mission.active];
      if (def && def.objective.type === 'kill' && def.objective.enemyTag === enemy.missionTag) {
        s.mission.flags.killed = (s.mission.flags.killed || 0) + 1;
      }
    }
    if (!won && s.mission.active === 'm3') s.mission.flags.died = 1;
  }
}

function buyShip(state, type) {
  const def = SHIPS[type];
  if (!def) return { error: `Unknown ship type: ${type}` };
  if (!isDocked(state)) return { error: 'Dock at a station to trade' };
  const s = clone(state);
  if (s.isk < def.cost) {
    return { error: `Not enough ISK (need ${def.cost}, have ${Math.floor(s.isk)})` };
  }
  const sys = activeSystem(s);
  if (!sys) return { error: 'No active system' };
  s.isk -= def.cost;
  const ship = {
    id: nextId(),
    type,
    level: 1,
    x: sys.stations[0].x,
    y: sys.stations[0].y,
    systemId: sys.id,
    cargo: emptyCargo(),
    loadout: 'balanced',
    fitting: emptyFitting(type),
  };
  s.ships.push(ship);
  s.stats.shipsBought += 1;
  if (!s.activeShipId) s.activeShipId = ship.id;
  return { state: s };
}

function sellShip(state, shipId) {
  const s = clone(state);
  const idx = s.ships.findIndex((sh) => sh.id === shipId);
  if (idx === -1) return { error: 'Ship not found' };
  if (shipInCombat(s, shipId)) return { error: 'Ship is in combat' };
  s.isk += SHIPS[s.ships[idx].type].sellValue;
  s.ships.splice(idx, 1);
  if (s.activeShipId === shipId) s.activeShipId = s.ships.length ? s.ships[0].id : null;
  return { state: s };
}

function upgradeShip(state, shipId) {
  const s = clone(state);
  const ship = s.ships.find((sh) => sh.id === shipId);
  if (!ship) return { error: 'Ship not found' };
  if (shipInCombat(s, shipId)) return { error: 'Ship is in combat' };
  const cost = upgradeCost(ship);
  if (s.isk < cost) {
    return { error: `Not enough ISK (need ${cost}, have ${Math.floor(s.isk)})` };
  }
  s.isk -= cost;
  ship.level += 1;
  return { state: s };
}

function setActive(state, shipId) {
  const s = clone(state);
  const ship = s.ships.find((sh) => sh.id === shipId);
  if (!ship) return { error: 'Ship not found' };
  s.activeShipId = shipId;
  return { state: s };
}

// Fit a ship for a combat role ('balanced' | 'tank' | 'dps'). Applies to that
// ship's next fights.
function setLoadout(state, shipId, loadout) {
  if (!LOADOUTS[loadout]) return { error: `Unknown loadout: ${loadout}` };
  const s = clone(state);
  const ship = s.ships.find((sh) => sh.id === shipId);
  if (!ship) return { error: 'Ship not found' };
  ship.loadout = loadout;
  return { state: s };
}

// Set a single fitting slot to a module tier (0 = empty, 1..3 = tier I/II/III).
// Fitting up costs the tier's price; downgrading (or unfitting) refunds the
// difference, so a slot can be re-fitted at any time. Works in space or docked.
function fitModule(state, shipId, slotType, slotIndex, tier) {
  const mod = MODULES[slotType];
  if (!mod) return { error: `Unknown module type: ${slotType}` };
  if (!Number.isInteger(tier) || tier < 0 || tier > mod.tiers.length) {
    return { error: `Invalid tier: ${tier}` };
  }
  const s = clone(state);
  const ship = s.ships.find((sh) => sh.id === shipId);
  if (!ship) return { error: 'Ship not found' };
  const slots = SHIPS[ship.type].slots;
  if (!slots[slotType]) return { error: `Ship has no ${slotType} slots` };
  if (!Number.isInteger(slotIndex) || slotIndex < 0 || slotIndex >= slots[slotType]) {
    return { error: `Invalid slot index: ${slotIndex}` };
  }
  if (!ship.fitting) ship.fitting = emptyFitting(ship.type);
  const current = ship.fitting[slotType][slotIndex] || 0;
  if (current === tier) return { state: s }; // no-op
  const price = (t) => (t > 0 ? mod.tiers[t - 1].cost : 0);
  const delta = price(tier) - price(current);
  if (delta > 0 && s.isk < delta) {
    return { error: `Not enough ISK (need ${delta}, have ${Math.floor(s.isk)})` };
  }
  s.isk -= delta;
  ship.fitting[slotType][slotIndex] = tier;
  return { state: s };
}

function sellMinerals(state, mineral, amount) {
  const def = MINERALS[mineral];
  if (!def) return { error: `Unknown mineral: ${mineral}` };
  if (!isDocked(state)) return { error: 'Dock at a station to trade' };
  const s = clone(state);
  const active = s.ships.find((sh) => sh.id === s.activeShipId);
  if (!active) return { error: 'No active ship' };
  const sys = activeSystem(s);
  const basePrice = (sys && sys.prices && sys.prices[mineral]) || def.price;
  const price = sys
    ? Math.max(1, Math.round(basePrice * priceBonus(standingFor(s, sys.id))))
    : basePrice;
  const amt = amount === 'all' ? active.cargo[mineral] : Number(amount);
  if (!Number.isFinite(amt) || amt <= 0) return { error: 'Invalid amount' };
  if (amt > active.cargo[mineral] + 1e-9) return { error: `Not enough ${def.name}` };
  const sold = Math.min(amt, active.cargo[mineral]);
  active.cargo[mineral] -= sold;
  const isk = sold * price;
  s.isk += isk;
  s.stats.totalIskEarned = (s.stats.totalIskEarned || 0) + isk;
  return { state: s };
}

// Sell every mineral in the active ship's hold at once (the idle "dump cargo"
// convenience). Prices are the active system's market rates.
function sellAll(state) {
  if (!isDocked(state)) return { error: 'Dock at a station to trade' };
  const s = clone(state);
  const active = s.ships.find((sh) => sh.id === s.activeShipId);
  if (!active) return { error: 'No active ship' };
  const sys = activeSystem(s);
  let isk = 0;
  for (const key of Object.keys(active.cargo)) {
    const amt = active.cargo[key];
    if (amt <= 0) continue;
    const basePrice = (sys && sys.prices && sys.prices[key]) || MINERALS[key].price;
    const price = sys
      ? Math.max(1, Math.round(basePrice * priceBonus(standingFor(s, sys.id))))
      : basePrice;
    isk += amt * price;
    active.cargo[key] = 0;
  }
  if (isk <= 0) return { error: 'Nothing to sell' };
  s.isk += isk;
  s.stats.totalIskEarned = (s.stats.totalIskEarned || 0) + isk;
  return { state: s };
}

// Engage the enemy you are standing next to with your active ship. Starts a
// real-time damage race: both sides' shield/hull/dps are captured here and the
// fight is simulated on subsequent ticks.
// Set up a real-time damage race against `enemyId` on the (already-cloned)
// state `s`. Assumes the enemy is alive, in range, and that s.combat is null.
// Loadout scales the base stats, fitted modules add a flat bonus, and trained
// skills multiply the result.
function startCombat(s, enemyId, now) {
  const ship = s.ships.find((sh) => sh.id === s.activeShipId);
  const sys = activeSystem(s);
  const enemy = sys.enemies.find((e) => e.id === enemyId);
  const threat = threatLevel(s);
  const est = enemyCombatStats(enemy.type, threat, enemy);
  const shipDef = SHIPS[ship.type];
  const lo = loadoutMult(ship);
  const lv = levelMult(ship.level);
  const mults = skillMults(s);
  const shipShieldMax = (shipDef.shield * lv * lo.shield + moduleBonus(ship, 'shield')) * mults.shield;
  const shipHullMax = (shipDef.hull * lv * lo.hull + moduleBonus(ship, 'armor')) * mults.hull;
  const playerDps = (shipDef.dps * lv * lo.dps + moduleBonus(ship, 'weapon') + droneBonus(s, 'combat')) * mults.dps;
  s.combat = {
    shipId: ship.id,
    enemyId,
    startedAt: now,
    fightTime: 0,
    shipShieldMax,
    shipHullMax,
    shipShield: shipShieldMax,
    shipHull: shipHullMax,
    enemyShieldMax: est.shield,
    enemyHullMax: est.hull,
    enemyShield: est.shield,
    enemyHull: est.hull,
    playerDps,
    enemyDps: est.dps,
    reward: est.reward,
    // Range advantage (D2): the enemy's guns are silent for this many seconds of
    // fight time. Mission "short-range" enemies carry a base `rangeDelay`; the
    // player's fitted range modules extend the window even further.
    enemyRangeDelay: est.rangeDelay + moduleBonus(ship, 'range'),
    // In-fight action state (all measured in fight-time seconds).
    overloadUntil: 0,     // overload (DPS boost) is active until this fightTime
    boostReadyAt: 0,      // shield boost usable again at this fightTime
    overloadReadyAt: 0,   // overload usable again at this fightTime
  };
}

function engage(state, enemyId, now = Date.now()) {
  const s = clone(state);
  if (s.combat) return { error: 'Already in combat' };
  const ship = s.ships.find((sh) => sh.id === s.activeShipId);
  if (!ship) return { error: 'No active ship' };
  const sys = activeSystem(s);
  const enemy = sys ? sys.enemies.find((e) => e.id === enemyId) : null;
  if (!enemy || !enemy.alive) return { error: 'Target not found' };
  if (dist(enemy.x, enemy.y, ship.x, ship.y) > ENGAGE_RANGE) {
    return { error: 'Target out of range' };
  }
  startCombat(s, enemyId, now);
  return { state: s };
}

// Perform an in-fight action: 'shieldBoost' (restore shield, ISK + cooldown),
// 'overload' (temp DPS boost, ISK + cooldown) or 'disengage' (bail out, keep
// the ship, no reward, the rat escapes).
function combatAction(state, action, now = Date.now()) {
  const s = clone(state);
  if (!s.combat) return { error: 'Not in combat' };
  const c = s.combat;
  if (action === 'disengage') {
    const ship = s.ships.find((sh) => sh.id === c.shipId);
    const sys = ship && s.systems ? s.systems[ship.systemId] : null;
    const enemy = sys ? sys.enemies.find((e) => e.id === c.enemyId) : null;
    s.combatLog.unshift({
      at: now,
      enemy: enemy ? ENEMIES[enemy.type].name : 'Unknown',
      ship: ship ? SHIPS[ship.type].name : 'Unknown',
      won: false,
      disengaged: true,
      isk: 0,
      shipLost: false,
      cargoLost: 0,
      insurance: 0,
    });
    if (s.combatLog.length > 20) s.combatLog.length = 20;
    s.combat = null;
    return { state: s };
  }
  if (action === 'shieldBoost') {
    if (c.fightTime < c.boostReadyAt) return { error: 'Shield boost is on cooldown' };
    if (s.isk < SHIELD_BOOST_COST) return { error: `Not enough ISK (need ${SHIELD_BOOST_COST})` };
    s.isk -= SHIELD_BOOST_COST;
    c.shipShield = c.shipShieldMax;
    c.boostReadyAt = c.fightTime + SHIELD_BOOST_COOLDOWN;
    return { state: s };
  }
  if (action === 'overload') {
    if (c.fightTime < c.overloadReadyAt) return { error: 'Overload is on cooldown' };
    if (s.isk < OVERLOAD_COST) return { error: `Not enough ISK (need ${OVERLOAD_COST})` };
    s.isk -= OVERLOAD_COST;
    c.overloadUntil = c.fightTime + OVERLOAD_DURATION;
    c.overloadReadyAt = c.fightTime + OVERLOAD_COOLDOWN;
    return { state: s };
  }
  return { error: `Unknown combat action: ${action}` };
}

// Find a POI by id within a system (station, belt, rat, planet, moon, gate, star).
function findPoi(sys, id) {
  if (!sys || !id) return null;
  const inList = (list) => (list || []).find((p) => p.id === id) || null;
  return (
    inList(sys.stations) ||
    inList(sys.belts) ||
    inList(sys.enemies) ||
    inList(sys.planets) ||
    inList(sys.moons) ||
    inList(sys.gates) ||
    (sys.star && sys.star.id === id ? sys.star : null)
  );
}

// Warp the active ship instantly within its own system. `targetId` may be a POI
// id (belt/station/rat/planet/moon/gate/star) or, if omitted, raw {x, y}
// coordinates. This is the single-click navigation: no long flights.
function warp(state, targetId, x, y) {
  const s = clone(state);
  const ship = s.ships.find((sh) => sh.id === s.activeShipId);
  if (!ship) return { error: 'No active ship' };
  if (s.combat) return { error: 'Cannot warp while in combat' };
  const sys = activeSystem(s);
  if (!sys) return { error: 'No active system' };
  let tx;
  let ty;
  if (targetId) {
    const poi = findPoi(sys, targetId);
    if (!poi) return { error: 'Warp target not found in this system' };
    tx = poi.x;
    ty = poi.y;
  } else if (Number.isFinite(x) && Number.isFinite(y)) {
    tx = x;
    ty = y;
  } else {
    return { error: 'Invalid warp target' };
  }
  ship.x = clamp(tx, 0, sys.width);
  ship.y = clamp(ty, 0, sys.height);
  return { state: s };
}

// The chance a gate jump into `systemId` triggers an ambush, modified by your
// standing with that system's faction (lower standing -> higher chance).
function ambushChance(state, systemId) {
  const standing = standingFor(state, systemId);
  const chance = AMBUSH_BASE_CHANCE * (1 - standing * AMBUSH_STANDING_MOD);
  return clamp(chance, AMBUSH_MIN_CHANCE, AMBUSH_MAX_CHANCE);
}
// Spawn a strong predator near the arrival point in `sys` (a gate ambush).
// Weighted toward the tougher classes so the ambush is a real threat. Returns
// the new enemy.
function spawnAmbush(sys, x, y, rng) {
  const r = rng();
  const type = r < 0.5 ? 'faction' : 'dread';
  const ang = rng() * Math.PI * 2;
  const rad = 60 + rng() * 120; // within ENGAGE_RANGE of the arrival point
  const enemy = {
    id: `ambush_${Date.now().toString(36)}_${Math.floor(rng() * 1e6)}`,
    x: clamp(x + Math.cos(ang) * rad, 60, sys.width - 60),
    y: clamp(y + Math.sin(ang) * rad, 60, sys.height - 60),
    type,
    alive: true,
    ambush: true,
    seed: Math.floor(rng() * 1e9),
  };
  sys.enemies.push(enemy);
  return enemy;
}

// Jump to another system through a gate. The ship must be at the gate; it then
// arrives at the paired gate in the connected system (so it can jump back).
// Jumping carries an ambush risk: a predator may drop out of the gate and
// attack you the moment you arrive (see ambushChance / spawnAmbush).
function gateJump(state, gateId, rng = Math.random, now = Date.now()) {
  const s = clone(state);
  const ship = s.ships.find((sh) => sh.id === s.activeShipId);
  if (!ship) return { error: 'No active ship' };
  if (s.combat) return { error: 'Cannot jump while in combat' };
  // Story mode keeps new pilots in Jita until they finish the course (m8).
  if (s.mode === 'story' && !(s.mission && s.mission.completed && s.mission.completed.includes('m8'))) {
    return { error: 'Not authorized — complete pilot training to use jump gates' };
  }
  const sys = activeSystem(s);
  if (!sys) return { error: 'No active system' };
  const gate = (sys.gates || []).find((g) => g.id === gateId);
  if (!gate) return { error: 'Gate not found in this system' };
  if (dist(ship.x, ship.y, gate.x, gate.y) > GATE_RANGE) {
    return { error: 'Too far from the gate to jump' };
  }
  const targetSys = s.systems[gate.targetSystemId];
  if (!targetSys) return { error: 'Target system not found' };
  const targetGate = (targetSys.gates || []).find((g) => g.id === gate.targetGateId);
  const arriveX = targetGate ? targetGate.x : targetSys.stations[0].x;
  const arriveY = targetGate ? targetGate.y : targetSys.stations[0].y;
  ship.systemId = targetSys.id;
  ship.x = clamp(arriveX, 0, targetSys.width);
  ship.y = clamp(arriveY, 0, targetSys.height);
  // Ambush risk: the less you are liked by the destination's faction, the more
  // likely a predator is waiting on the other side of the gate.
  if (rng() < ambushChance(s, targetSys.id)) {
    const ambusher = spawnAmbush(targetSys, ship.x, ship.y, rng);
    startCombat(s, ambusher.id, now);
  }
  return { state: s };
}

function reset(state, now = Date.now(), seed = (Date.now() % 1000000) + 1) {
  return createInitialState(now, seed, state.mode || 'demo');
}

// ---- missions (story mode pilot training) ----

function missionDef(state) {
  const m = state.mission;
  if (!m || !m.active) return null;
  return MISSIONS[m.active] || null;
}

// Fit a module into the first empty slot of its type (used for mission grants).
function fitGrantModule(ship, slotType, tier) {
  if (!ship || !ship.fitting || !MODULES[slotType]) return;
  const slots = SHIPS[ship.type].slots[slotType] || 0;
  for (let i = 0; i < slots; i++) {
    if (!ship.fitting[slotType][i]) {
      ship.fitting[slotType][i] = tier;
      return;
    }
  }
}

// Hand the player what a mission gives them up-front (`def.grant`): ships,
// modules (fitted) and ISK. Grants that don't apply are skipped silently.
// Ships are granted first so modules fit into the newly active replacement.
function grantMissionRewards(state, def) {
  if (!def) return;
  const g = def.grant || {};
  if (g.isk) state.isk += g.isk;
  if (Array.isArray(g.ships)) {
    grantShips(state, g.ships);
  }
  if (Array.isArray(g.modules)) {
    const ship = state.ships.find((sh) => sh.id === state.activeShipId);
    for (const m of g.modules) fitGrantModule(ship, m.slot, m.tier);
  }
}

// Grant one or more ships (replacement/clone respawns), placed just outside the
// station so a "dock at the station" objective still needs a short warp home.
function grantShips(state, types) {
  const ship = state.ships.find((sh) => sh.id === state.activeShipId);
  // After a scripted death there is no active ship, so fall back to the first
  // system (the storyline is confined to Jita until certification).
  let sys = ship && state.systems ? state.systems[ship.systemId] : null;
  if (!sys && state.systems) sys = Object.values(state.systems)[0] || null;
  if (!sys) return;
  const home = sys.stations[0];
  for (let i = 0; i < types.length; i++) {
    const ang = ((i + 1) / (types.length + 1)) * Math.PI;
    const rad = DOCK_RANGE + 120;
    const n = {
      id: nextId(),
      type: types[i],
      level: 1,
      x: clamp(home.x + Math.cos(ang) * rad, 60, sys.width - 60),
      y: clamp(home.y + Math.sin(ang) * rad, 60, sys.height - 60),
      systemId: sys.id,
      cargo: emptyCargo(),
      loadout: 'balanced',
      fitting: emptyFitting(types[i]),
    };
    state.ships.push(n);
    state.activeShipId = n.id;
  }
}

// Rewards paid when a mission completes (`def.completion`): ISK and drones.
function grantCompletionRewards(state, def) {
  if (!def) return;
  const c = def.completion || {};
  if (c.isk) state.isk += c.isk;
  if (Array.isArray(c.drones)) {
    if (!state.drones) state.drones = emptyDroneBay();
    for (const d of c.drones) {
      const dr = DRONES[d.type];
      if (dr && dr.tiers) state.drones[d.type].push({ type: d.type, tier: d.tier });
    }
  }
}

// Start a mission: hand out its up-front grant and place its targets.
function startMission(state, id) {
  const def = MISSIONS[id];
  if (!def) return;
  state.mission.active = id;
  state.mission.flags = {};
  state.mission.step = 0;
  clearMissionEnemies(state);
  grantMissionRewards(state, def);
  spawnMissionEnemies(state, def);
}

// Remove any leftover living scripted targets (e.g. m3's surviving wave ships)
// so only the current mission's spawns remain — "between missions, the space is
// quiet". Dead targets are kept so killmails and ids stay consistent.
function clearMissionEnemies(state) {
  for (const sys of Object.values(state.systems)) {
    sys.enemies = (sys.enemies || []).filter((e) => !e.missionTag || e.alive === false);
  }
}

// True when a story save exists but the pilot-training course has never actually
// started (no active mission and nothing completed) — e.g. a save written by an
// earlier build before missions were wired up. Such a save should be booted into
// m1 rather than resumed in a half-initialized state.
function missionStartNeeded(state) {
  const m = state && state.mission;
  return !m || (!m.active && (!m.completed || m.completed.length === 0));
}

// Place a mission's scripted targets near the home station (combat missions).
function spawnMissionEnemies(state, def) {
  if (!def || !def.spawn) return;
  const ship = state.ships.find((sh) => sh.id === state.activeShipId);
  const sys = ship && state.systems ? state.systems[ship.systemId] : null;
  if (!sys) return;
  const home = sys.stations[0];
  for (const sp of def.spawn) {
    const eDef = MISSION_ENEMIES[sp.type];
    if (!eDef) continue;
    for (let i = 0; i < sp.count; i++) {
      const ang = (i / Math.max(1, sp.count)) * Math.PI * 2;
      const rad = 420 + i * 60;
      sys.enemies.push({
        id: nextId(),
        type: eDef.key,
        name: eDef.name,
        missionTag: sp.type,
        x: clamp(home.x + Math.cos(ang) * rad, 60, sys.width - 60),
        y: clamp(home.y + Math.sin(ang) * rad, 60, sys.height - 60),
        shield: eDef.shield,
        hull: eDef.hull,
        dps: eDef.dps,
        rangeDelay: eDef.rangeDelay || 0,
        alive: true,
        iskReward: eDef.iskReward,
      });
    }
  }
}

// True once the active mission's objective is satisfied.
function missionDone(state) {
  const m = state.mission;
  const def = missionDef(state);
  if (!m || !def) return false;
  const o = def.objective;
  switch (o.type) {
    case 'kill': return (m.flags.killed || 0) >= o.count;
    case 'mine': return (m.flags.mined || 0) >= o.target;
    case 'craft': return o.targets.every((t) => (m.flags.crafted && m.flags.crafted[`${t.slot}:${t.tier}`] || 0) >= t.count);
    case 'dock': return !!m.flags.docked;
    case 'death': return !!m.flags.died;
    case 'dialogue': return !!m.flags.done;
    default: return false;
  }
}

// Advance the mission chain: complete the current mission, hand out rewards and
// start the next one (granting its up-front items and spawning its targets).
// Called after combat/mine/craft ticks so objectives resolve as soon as met.
function evaluateMission(state) {
  const m = state.mission;
  if (!m || state.mode !== 'story' || !m.active) return;
  const def = MISSIONS[m.active];
  if (!def) return;
  if (def.objective.type === 'dock' && dockedStation(state)) m.flags.docked = 1;
  if (!missionDone(state)) return;
  grantCompletionRewards(state, def);
  m.completed.push(m.active);
  const idx = MISSION_ORDER.indexOf(m.active);
  const next = MISSION_ORDER[idx + 1] || null;
  if (next) {
    startMission(state, next);
  } else {
    m.active = null;
    m.flags = {};
    m.step = 0;
  }
}

// Player-triggered mission actions. 'continue' acknowledges a dialogue-only
// mission (e.g. accepting certification), completing it.
function missionAction(state, action) {
  const s = clone(state);
  const m = s.mission;
  if (!m || s.mode !== 'story' || !m.active) return { error: 'No active mission' };
  if (action === 'continue') {
    const def = MISSIONS[m.active];
    if (!def) return { error: 'No active mission' };
    if (def.objective.type === 'dialogue') m.flags.done = 1;
    evaluateMission(s);
    return { state: s };
  }
  return { error: 'Unknown mission action' };
}

// The client-facing mission snapshot (title, brief, objective + progress).
function missionView(state) {
  const m = state.mission;
  if (!m) return null;
  const def = m.active ? MISSIONS[m.active] : null;
  const o = def ? def.objective : null;
  let progress = null;
  let target = null;
  if (o) {
    switch (o.type) {
      case 'kill': progress = Math.min(o.count, m.flags.killed || 0); target = o.count; break;
      case 'mine': progress = Math.min(o.target, m.flags.mined || 0); target = o.target; break;
      case 'craft':
        progress = o.targets.map((t) => Math.min(t.count, (m.flags.crafted && m.flags.crafted[`${t.slot}:${t.tier}`]) || 0));
        target = o.targets.map((t) => t.count);
        break;
      default: break;
    }
  }
  return {
    mode: state.mode,
    active: m.active,
    title: def ? def.title : null,
    npc: def ? def.npc : null,
    brief: def ? def.brief : null,
    objective: o ? o.label : null,
    progress,
    target,
    done: def ? missionDone(state) : false,
    completed: m.completed.slice(),
  };
}

function shipView(ship, mults, drone) {
  const def = SHIPS[ship.type];
  const lo = loadoutMult(ship);
  const lv = levelMult(ship.level);
  const d = drone || { mining: 0, dps: 0 };
  return {
    id: ship.id,
    type: ship.type,
    name: def.name,
    level: ship.level,
    x: ship.x,
    y: ship.y,
    systemId: ship.systemId,
    // Effective stats: base scaled by level, loadout scales the combat base,
    // fitted modules add a flat bonus, drones add a player-level bonus, and
    // trained skills multiply the result.
    mining: shipMining(ship, mults, d.mining),
    combat: def.combat * lv,
    dps: (def.dps * lv * lo.dps + moduleBonus(ship, 'weapon') + d.dps) * (mults ? mults.dps : 1),
    shield: (def.shield * lv * lo.shield + moduleBonus(ship, 'shield')) * (mults ? mults.shield : 1),
    hull: (def.hull * lv * lo.hull + moduleBonus(ship, 'armor')) * (mults ? mults.hull : 1),
    cargo: shipCargo(ship, mults),
    loadout: ship.loadout || 'balanced',
    slots: def.slots,
    fitting: ship.fitting || emptyFitting(ship.type),
    upgradeCost: upgradeCost(ship),
    sellValue: def.sellValue,
    cost: def.cost,
  };
}

// The combat object plus the derived values the client needs to render the
// fight and its in-fight action buttons.
function combatView(c) {
  const ttd = Math.min(playerTtd(c), enemyTtd(c));
  return {
    ...c,
    remaining: Math.max(0, ttd),
    overloaded: c.fightTime < c.overloadUntil,
    boostReady: c.fightTime >= c.boostReadyAt,
    overloadReady: c.fightTime >= c.overloadReadyAt,
    boostCooldown: Math.max(0, c.boostReadyAt - c.fightTime),
    overloadCooldown: Math.max(0, c.overloadReadyAt - c.fightTime),
    boostCost: SHIELD_BOOST_COST,
    overloadCost: OVERLOAD_COST,
  };
}

function view(state) {
  const active = state.ships.find((sh) => sh.id === state.activeShipId);
  const sys = active && state.systems ? state.systems[active.systemId] : null;
  const mults = skillMults(state);
  const drone = { mining: droneBonus(state, 'mining'), dps: droneBonus(state, 'combat') };
  const standing = state.standing || emptyStanding();
  const activeStanding = sys ? standingFor(state, sys.id) : 0;
  const activeFactionKey = sys ? factionForSystem(sys.id) : null;
  const factions = Object.keys(FACTIONS).map((k) => ({
    key: k,
    name: FACTIONS[k].name,
    standing: standing[k] || 0,
  }));
  const v = {
    version: state.version,
    mode: state.mode,
    mission: missionView(state),
    isk: state.isk,
    // The active ship's cargo hold, exposed as `minerals` for client compat.
    minerals: active ? { ...active.cargo } : emptyCargo(),
    ships: state.ships.map((sh) => shipView(sh, mults, drone)),
    activeShipId: state.activeShipId,
    lastTick: state.lastTick,
    skillPoints: state.skillPoints || 0,
    skills: state.skills || emptySkills(),
    skillMults: mults,
    standing,
    factions,
    activeFaction: activeFactionKey
      ? { key: activeFactionKey, name: FACTIONS[activeFactionKey].name, standing: activeStanding }
      : null,
    priceBonus: priceBonus(activeStanding),
    drones: state.drones || emptyDroneBay(),
    droneBonuses: { mining: droneBonus(state, 'mining'), dps: droneBonus(state, 'combat') },
    loot: (state.loot || []).map((l) => ({
      id: l.id,
      slotType: l.slotType,
      tier: l.tier,
      name: MODULES[l.slotType] ? MODULES[l.slotType].name : l.slotType,
    })),
    combat: state.combat
      ? combatView(state.combat)
      : null,
    combatLog: state.combatLog.slice(),
    stats: { ...state.stats },
    // The active ship's system, exposed as `world` for client compatibility.
    world: sys
      ? {
          id: sys.id,
          name: sys.name,
          color: sys.color,
          seed: sys.seed,
          width: sys.width,
          height: sys.height,
          star: sys.star,
          planets: sys.planets,
          moons: sys.moons,
          stations: sys.stations,
          belts: sys.belts,
          asteroids: sys.asteroids,
          enemies: sys.enemies,
          gates: sys.gates,
          prices: effectivePrices(sys.id, activeStanding),
        }
      : null,
    system: sys ? { id: sys.id, name: sys.name, color: sys.color, gates: sys.gates } : null,
    systemNames: Object.values(state.systems).map((s) => ({ id: s.id, name: s.name, color: s.color })),
    // Gate-ambush chance per destination system (standing-modified), for the HUD.
    ambush: Object.fromEntries(
      Object.values(state.systems).map((s) => [s.id, ambushChance(state, s.id)])
    ),
  };
  v.activeShip = active ? shipView(active, mults, drone) : null;
  const ds = dockedStation(state);
  v.docked = !!ds;
  v.dockedStation = ds ? ds.name : null;
  v.threat = threatLevel(state);
  v.cargoUsed = cargoUsed(state);
  v.cargoCapacity = cargoCapacity(state);
  v.cargoFull = v.cargoCapacity > 0 && v.cargoUsed >= v.cargoCapacity;
  v.miningPaused = active ? shipInCombat(state, active.id) : true;
  v.miningRate = 0;
  v.miningTargetId = null;
  if (active && !v.miningPaused) {
    const t = nearestAsteroidInRange(state, active);
    if (t) {
      v.miningRate = shipMining(active, mults, drone.mining);
      v.miningTargetId = t.id;
    }
  }
  return v;
}

module.exports = {
  SHIPS,
  MODULES,
  SKILLS,
  MINERALS,
  ENEMIES,
  LOADOUTS,
  FACTIONS,
  DRONES,
  BLUEPRINTS,
  createInitialState,
  isValidState,
  evaluateMission,
  missionView,
  missionAction,
  spawnMissionEnemies,
  startMission,
  missionStartNeeded,
  MISSIONS,
  MISSION_ORDER,
  tick,
  buyShip,
  sellShip,
  upgradeShip,
  setActive,
  setLoadout,
  fitModule,
  moduleBonus,
  emptyFitting,
  trainSkill,
  skillMults,
  skillCost,
  emptySkills,
  emptyStanding,
  factionForSystem,
  standingFor,
  priceBonus,
  effectivePrices,
  emptyDroneBay,
  droneBonus,
  buyDrone,
  equipLoot,
  craftModule,
  sellMinerals,
  sellAll,
  cargoUsed,
  cargoCapacity,
  engage,
  combatAction,
  warp,
  gateJump,
  ambushChance,
  spawnAmbush,
  findPoi,
  reset,
  shipView,
  view,
  shipMining,
  shipCombat,
  shipDps,
  shipShield,
  shipHull,
  shipCargo,
  upgradeCost,
  levelMult,
  nearestAsteroidInRange,
  isDocked,
  dockedStation,
  threatLevel,
  activeSystem,
  generateSystems,
  resetIds,
};
