'use strict';

// Static game data + spatial constants. The server is the single source of
// truth. The client sends intents (destinations, "buy X", "engage Y"); every
// movement, quantity, range, yield and reward is computed here.

// Combat stats are a real-time simulation: each ship has a shield pool (front
// damage buffer), a hull pool (last resort) and a damage-per-second figure. A
// fight lasts until one side's hull is destroyed, so the outcome is visible in
// real time rather than a hidden coin-flip.
//
// `slots` is the number of fitting slots per module type a ship has. Bigger
// ships carry more slots, so there's more to fit. A slot holds one module of
// its type (see MODULES); the ship's effective stat is its base (scaled by
// level) plus the flat bonus of every module fitted in that type.
const SHIPS = {
  rifter:    { key: 'rifter',    name: 'Rifter',    mining: 6,   combat: 5,   cargo: 60,   shield: 50,  hull: 100,  dps: 10, slots: { weapon: 1, shield: 1, armor: 0, mining: 1, cargo: 1, range: 1, miningDrone: 1, combatDrone: 1 } },
  falcon:    { key: 'falcon',    name: 'Falcon',    mining: 14,  combat: 12,  cargo: 200,  shield: 120, hull: 200,  dps: 25, slots: { weapon: 2, shield: 2, armor: 1, mining: 1, cargo: 1, range: 1, miningDrone: 1, combatDrone: 1 } },
  raptor:    { key: 'raptor',    name: 'Raptor',    mining: 8,   combat: 30,  cargo: 120,  shield: 80,  hull: 250,  dps: 40, slots: { weapon: 3, shield: 1, armor: 1, mining: 0, cargo: 1, range: 1, miningDrone: 1, combatDrone: 1 } },
  vexor:     { key: 'vexor',     name: 'Vexor',     mining: 30,  combat: 25,  cargo: 500,  shield: 150, hull: 300, dps: 35, slots: { weapon: 2, shield: 2, armor: 1, mining: 3, cargo: 2, range: 1, miningDrone: 1, combatDrone: 1 } },
  gnosis:    { key: 'gnosis',    name: 'Gnosis',    mining: 70,  combat: 40,  cargo: 1200, shield: 300, hull: 500, dps: 60, slots: { weapon: 2, shield: 2, armor: 2, mining: 4, cargo: 4, range: 1, miningDrone: 1, combatDrone: 1 } },
  manticore: { key: 'manticore', name: 'Manticore', mining: 12,  combat: 80,  cargo: 250,  shield: 200, hull: 600, dps: 90, slots: { weapon: 4, shield: 2, armor: 2, mining: 0, cargo: 1, range: 1, miningDrone: 1, combatDrone: 1 } },
  brutix:    { key: 'brutix',    name: 'Brutix',    mining: 170, combat: 60,  cargo: 3000, shield: 400, hull: 800, dps: 70, slots: { weapon: 2, shield: 3, armor: 3, mining: 5, cargo: 5, range: 1, miningDrone: 1, combatDrone: 1 } },
};

const SHIP_PROGRESSION = [
  { tier: 1, ships: [{ type: 'rifter', skills: [] }] },
  { tier: 2, ships: [
    { type: 'falcon', skills: [{ skill: 'miningYield', level: 1 }] },
    { type: 'raptor', skills: [{ skill: 'gunnery', level: 1 }] },
  ] },
  { tier: 3, ships: [
    { type: 'vexor', skills: [{ skill: 'miningYield', level: 2 }] },
    { type: 'gnosis', skills: [{ skill: 'cargoManagement', level: 2 }] },
    { type: 'manticore', skills: [{ skill: 'gunnery', level: 3 }] },
  ] },
  { tier: 4, ships: [{ type: 'brutix', skills: [{ skill: 'miningYield', level: 4 }] }] },
];

// Fitting modules. Each module type boosts one stat by a flat bonus. Modules
// are inventory items; fitting consumes one and un-fitting returns one.
const MODULES = {
  weapon: { key: 'weapon', name: 'Weapon', stat: 'dps', tiers: [ { tier: 1, bonus: 6 }, { tier: 2, bonus: 18 }, { tier: 3, bonus: 45 }, { tier: 4, bonus: 110 } ] },
  shield: { key: 'shield', name: 'Shield Extender', stat: 'shield', tiers: [ { tier: 1, bonus: 25 }, { tier: 2, bonus: 75 }, { tier: 3, bonus: 180 }, { tier: 4, bonus: 420 } ] },
  armor:  { key: 'armor', name: 'Armor Plate', stat: 'hull', tiers: [ { tier: 1, bonus: 35 }, { tier: 2, bonus: 100 }, { tier: 3, bonus: 240 }, { tier: 4, bonus: 560 } ] },
  mining: { key: 'mining', name: 'Mining Augmenter', stat: 'mining', tiers: [ { tier: 1, bonus: 4 }, { tier: 2, bonus: 12 }, { tier: 3, bonus: 35 }, { tier: 4, bonus: 85 } ] },
  cargo:  { key: 'cargo', name: 'Cargo Expander', stat: 'cargo', tiers: [ { tier: 1, bonus: 60 }, { tier: 2, bonus: 160 }, { tier: 3, bonus: 450 }, { tier: 4, bonus: 1100 } ] },
  range:  { key: 'range', name: 'Range Amplifier', stat: 'range', tiers: [ { tier: 1, bonus: 3 }, { tier: 2, bonus: 8 }, { tier: 3, bonus: 20 }, { tier: 4, bonus: 50 } ] },
  miningDrone: { key: 'miningDrone', name: 'Mining Drone Control', stat: 'mining', tiers: [ { tier: 1, bonus: 5 }, { tier: 2, bonus: 14 }, { tier: 3, bonus: 40 }, { tier: 4, bonus: 200 } ] },
  combatDrone: { key: 'combatDrone', name: 'Combat Drone Control', stat: 'dps', tiers: [ { tier: 1, bonus: 8 }, { tier: 2, bonus: 22 }, { tier: 3, bonus: 60 }, { tier: 4, bonus: 300 } ] },
};

// Ore grades are ordered for the NPC 3:1 exchange ladder.
const MINERALS = {
  iron:       { key: 'iron',       name: 'Iron Ore',       tier: 1, color: '#c9d1d9' },
  bauxite:    { key: 'bauxite',    name: 'Bauxite Ore',    tier: 2, color: '#e0a458' },
  gadolinium: { key: 'gadolinium', name: 'Gadolinium Ore', tier: 3, color: '#b07ce0' },
  megacyte:   { key: 'megacyte',   name: 'Megacyte Ore',   tier: 4, color: '#5ce0c8' },
};

const COMPONENTS = {
  scrap: { key: 'scrap', name: 'Scrap', tier: 1 },
  alloy: { key: 'alloy', name: 'Alloy', tier: 2 },
  circuits: { key: 'circuits', name: 'Circuits', tier: 3 },
  quantumCores: { key: 'quantumCores', name: 'Quantum Cores', tier: 4 },
};
const ORE_EXCHANGE = Object.keys(MINERALS);
const COMPONENT_EXCHANGE = Object.keys(COMPONENTS);

// Enemy classes you can fly to and engage. They drop materials and modules.
// Every number lives in server/data/enemies.json (types, tiers, spawn rules).
const ENEMY_DATA = require('./data/enemies.json');

function loadEnemyData(data) {
  const tiers = {};
  for (const [key, t] of Object.entries(data.tiers || {})) {
    if (!(t.multiplier > 0)) throw new Error(`enemies.json: tier "${key}" needs a positive multiplier`);
    tiers[key] = { key, name: t.name || key, multiplier: t.multiplier };
  }
  if (!Object.keys(tiers).length) throw new Error('enemies.json: no tiers defined');
  const types = {};
  for (const [key, t] of Object.entries(data.types || {})) {
    for (const f of ['shield', 'hull', 'dps']) {
      if (!(t[f] >= 0)) throw new Error(`enemies.json: type "${key}" has an invalid ${f}`);
    }
    const spawn = (t.spawn || []).map((r) => {
      if (!tiers[r.tier]) throw new Error(`enemies.json: type "${key}" spawns unknown tier "${r.tier}"`);
      if (!(r.weight > 0)) throw new Error(`enemies.json: type "${key}" spawn rule needs a positive weight`);
      return { tier: r.tier, minSecurity: r.minSecurity, maxSecurity: r.maxSecurity, weight: r.weight };
    });
    types[key] = { key, name: t.name || key, shield: t.shield, hull: t.hull, dps: t.dps, spawn };
  }
  return { tiers, types };
}

const { tiers: ENEMY_TIERS, types: ENEMIES } = loadEnemyData(ENEMY_DATA);

// The spawn rules (type + tier + weight) allowed at a given system security.
function spawnTable(security) {
  const out = [];
  for (const def of Object.values(ENEMIES)) {
    for (const r of def.spawn) {
      if (security >= r.minSecurity - 1e-9 && security <= r.maxSecurity + 1e-9) {
        out.push({ type: def.key, tier: r.tier, weight: r.weight });
      }
    }
  }
  return out;
}

const MODES = ['demo', 'story'];
const MAX_OFFLINE_SECONDS = 8 * 3600;

// ---- in-fight actions (interactive combat) ----
// During a real-time fight you can spend scrap to change the odds, or disengage
// to bail out and keep the ship (no reward, the rat escapes).
const SHIELD_BOOST_ITEM = 'scrap';
const SHIELD_BOOST_COOLDOWN = 6;    // seconds of fight time before you can boost again
const OVERLOAD_ITEM = 'scrap';
const OVERLOAD_DPS_MULT = 1.6;      // DPS multiplier while overloaded
const OVERLOAD_DURATION = 5;        // seconds the overload lasts
const OVERLOAD_COOLDOWN = 9;        // seconds of fight time before you can overload again

// ---- skill tree ----
// Skills are player-level (apply to every ship). Skill points accrue over time,
// including while offline, and are spent to train a skill up a level.
// Each skill multiplies one stat by (1 + pctPerLevel * level). Training is
// instant — the gate is the skill points you have to spend.
const SKILLS = {
  miningYield:     { key: 'miningYield',     name: 'Mining Yield',      category: 'Mining', maxLevel: 4, baseCost: 20, costGrowth: 1.8, effect: { stat: 'mining', pctPerLevel: 0.10 } },
  cargoManagement: { key: 'cargoManagement', name: 'Cargo Management',  category: 'Mining', maxLevel: 3, baseCost: 15, costGrowth: 1.8, effect: { stat: 'cargo',  pctPerLevel: 0.15 } },
  gunnery:         { key: 'gunnery',         name: 'Gunnery',           category: 'Combat', maxLevel: 4, baseCost: 20, costGrowth: 1.8, effect: { stat: 'dps',    pctPerLevel: 0.10 } },
  shieldUpgrades:  { key: 'shieldUpgrades',  name: 'Shield Upgrades',   category: 'Combat', maxLevel: 4, baseCost: 20, costGrowth: 1.8, effect: { stat: 'shield', pctPerLevel: 0.10 } },
  hullUpgrades:    { key: 'hullUpgrades',    name: 'Hull Upgrades',     category: 'Combat', maxLevel: 3, baseCost: 15, costGrowth: 1.8, effect: { stat: 'hull',   pctPerLevel: 0.08 } },
};
const SP_RATE_PER_SEC = 0.25;  // Skill points accrue continuously, including offline.
const ACHIEVEMENTS = {
  miner: { key: 'miner', name: 'Prospector', description: 'Mine 1,000 units of ore', stat: 'totalMineralsMined', target: 1000 },
  veteran: { key: 'veteran', name: 'Veteran', description: 'Win 10 battles', stat: 'combatsWon', target: 10 },
  industrialist: { key: 'industrialist', name: 'Industrialist', description: 'Craft 5 modules', stat: 'modulesCrafted', target: 5 },
  salvager: { key: 'salvager', name: 'Salvager', description: 'Salvage 100 modules', stat: 'modulesSalvaged', target: 100 },
  certified: { key: 'certified', name: 'Certified Pilot', description: 'Complete pilot training', stat: 'missionsCompleted', target: 8 },
};

// ---- gate ambush risk ----
// Jumping a gate can draw a predator from the other side. The base chance is
// fixed and does not depend on reputation.
const AMBUSH_BASE_CHANCE = 0.15;
const AMBUSH_MIN_CHANCE = 0.03;
const AMBUSH_MAX_CHANCE = 0.40;

// Legacy drone definitions are retained to migrate old saves and validate
// historical server actions; current drone control uses ordinary fitting slots.
const DRONES = {
  mining: { key: 'mining', name: 'Mining Drone', stat: 'mining', tiers: [
    { tier: 1, bonus: 5 },
    { tier: 2, bonus: 14 },
    { tier: 3, bonus: 40 },
  ] },
  combat: { key: 'combat', name: 'Combat Drone', stat: 'dps', tiers: [
    { tier: 1, bonus: 8 },
    { tier: 2, bonus: 22 },
    { tier: 3, bonus: 60 },
  ] },
};
const DRONE_MAX_PER_TYPE = 5; // max drones of each type in the bay

// ---- loot drops ----
// Destroying a rat can drop a module (matching the fitting MODULES, tier I/II/III)
// into your loot inventory. It is equipped into an empty fitting slot on the
// active ship (see game.equipLoot).
// Bigger rats drop better modules, more reliably.
const LOOT_DROP_CHANCE = {
  pirate: 0.35,
  gang: 0.55,
  faction: 0.75,
  dread: 1.0,
};
const LOOT_TIERS = {
  pirate: [1],
  gang: [1, 2],
  faction: [2, 3],
  dread: [3],
};

// Ore and components are spent together in industry; NPCs sell consumed
// blueprints for materials as well.
function tierRecipe(tier, multiplier = 1) {
  return {
    [ORE_EXCHANGE[tier - 1]]: 3 * multiplier,
    [COMPONENT_EXCHANGE[tier - 1]]: 2 * multiplier,
  };
}
const BLUEPRINTS = (() => {
  const out = {};
  const ROMAN = ['', 'I', 'II', 'III'];
  for (const slotType of Object.keys(MODULES)) {
    const mod = MODULES[slotType];
    out[slotType] = {};
    for (const t of mod.tiers) {
      const recipe = tierRecipe(t.tier);
      out[slotType][t.tier] = {
        slotType,
        tier: t.tier,
        name: t.tier === 4 ? `${mod.name} Faction` : `${mod.name} ${ROMAN[t.tier]}`,
        recipe,
      };
    }
  }
  return out;
})();
const SHIP_BLUEPRINTS = (() => {
  const out = {};
  const recipes = {
    falcon: tierRecipe(1, 3),
    raptor: tierRecipe(2, 3),
    vexor: tierRecipe(2, 5),
    gnosis: tierRecipe(3, 6),
    manticore: tierRecipe(3, 6),
    brutix: tierRecipe(4, 8),
  };
  for (const [key, recipe] of Object.entries(recipes)) {
    const ship = SHIPS[key];
    out[key] = { type: key, name: ship.name, recipe };
  }
  return out;
})();
const BLUEPRINT_COSTS = (() => {
  const out = {};
  for (const slotType of Object.keys(MODULES)) {
    for (const moduleTier of MODULES[slotType].tiers) {
      out[`module:${slotType}:${moduleTier.tier}`] = tierRecipe(moduleTier.tier);
    }
  }
  for (const shipType of Object.keys(SHIP_BLUEPRINTS)) out[`ship:${shipType}`] = tierRecipe(1, 2);
  return out;
})();
const NPC_BLUEPRINTS = Object.keys(MODULES).map((slotType) => `module:${slotType}:1`);
const BLUEPRINT_DROP_CHANCE = {
  pirate: 0.08,
  gang: 0.12,
  faction: 0.2,
  dread: 0.3,
};
const BLUEPRINT_DROP_POOLS = {
  novice: {
    moduleTiers: [2],
    ships: ['falcon', 'raptor'],
  },
  standard: {
    moduleTiers: [2, 3],
    ships: ['falcon', 'raptor', 'vexor', 'manticore'],
  },
  elite: {
    moduleTiers: [3, 4],
    ships: ['vexor', 'gnosis', 'manticore', 'brutix'],
  },
};

// ---- missions (story mode pilot training) ----
// The storyline is a linear chain of missions that each teach one mechanic.
// Missions run in the starting system (Jita); the jump gates stay locked until
// the player is certified (m8). `grant` is handed out up-front (what the NPC
// gives you); rewards are granted on completion. `spawn` lists mission enemies
// placed near the home station when the mission starts.
const MISSION_ORDER = ['m1', 'm2', 'm3', 'm4', 'm5', 'm6', 'm7', 'm8', 'm9'];

// Mission spawns pick a type and tier from enemies.json. `tag` is the objective
// tag used to track the kill; `rangeDelay` is the seconds the enemy's guns stay silent.

const MISSIONS = {
  m1: {
    id: 'm1', title: 'Under Attack', npc: 'Station A',
    brief: '"We\'re under attack. Please help. Take out this frigate — fly to it and fire your guns."',
    grant: { modules: [{ slot: 'weapon', tier: 1 }] },
    spawn: [{ type: 'pirate', tier: 'standard', tag: 'attacker', count: 1 }],
    objective: { type: 'kill', enemyTag: 'attacker', count: 1, label: 'Destroy the attacker frigate' },
    completion: { items: { scrap: 3 }, text: '"Good shooting, pilot. We\'re in your debt."' },
  },
  m2: {
    id: 'm2', title: 'Help the Buddies', npc: 'Station A',
    brief: '"Our buddies need help too. Kill three frigates. These frigates carry short-range guns — fit your Range Amplifier to hit them before they can hit you. Stay at range and take them down."',
    grant: { modules: [{ slot: 'range', tier: 1 }] },
    spawn: [{ type: 'pirate', tier: 'standard', tag: 'shortrange', count: 3, rangeDelay: 2 }],
    objective: { type: 'kill', enemyTag: 'shortrange', count: 3, label: 'Destroy short-range frigates' },
    completion: { items: { scrap: 3 }, text: '"They never knew what hit them. Range is everything out here."' },
  },
  m3: {
    id: 'm3', title: 'Last Stand', npc: 'Station A',
    brief: '"It doesn\'t seem like there\'s any way out of this alive. Too many ships are warping in and our warp drive is down. Let\'s go down fighting. After all, a good fight is what it\'s all about."',
    grant: {},
    spawn: [{ type: 'faction', tier: 'elite', tag: 'waveship', count: 5 }],
    objective: { type: 'death', label: 'Survive as long as you can' },
    completion: { items: {}, text: '"They got you... but you fought well."' },
  },
  m4: {
    id: 'm4', title: 'A New Clone', npc: 'Station A',
    brief: '"Welcome back, pilot. You have awoken in another clone. Here\'s how a station works. You have been given a replacement frigate — dock and take stock."',
    grant: { ships: ['rifter'], modules: [{ slot: 'weapon', tier: 1 }] },
    objective: { type: 'dock', label: 'Dock at the station' },
    completion: { items: {}, text: '"Everything you own survives in your clone\'s records. Ships come and go — the pilot endures."' },
  },
  m5: {
    id: 'm5', title: 'Mining 101', npc: 'Station A',
    brief: '"All ships and modules are made from refined ore. Let\'s get you started on mining. Fly to an asteroid and mine it into your hold."',
    grant: { modules: [{ slot: 'mining', tier: 1 }] },
    objective: { type: 'mine', target: 40, label: 'Mine 40 ore' },
    completion: { items: { scrap: 3 }, text: '"Good. That ore will become hulls and guns."' },
  },
  m6: {
    id: 'm6', title: 'Rogue Drones', npc: 'Station A',
    brief: '"We are having some trouble with rogue drones harassing our miners. Go deal with the drone hub — and if you handle it, a drone control module is yours."',
    grant: {},
    spawn: [{ type: 'dronehub', tier: 'standard', tag: 'dronhub', count: 1, rangeDelay: 2 }],
    objective: { type: 'kill', enemyTag: 'dronhub', count: 1, label: 'Destroy the rogue drone hub' },
    completion: { items: { alloy: 2 }, drones: [{ type: 'mining', tier: 1 }], text: '"The hub is gone. Your Mining Drone Control module is ready to fit."' },
  },
  m7: {
    id: 'm7', title: 'The Forge', npc: 'Station A',
    brief: '"Every module you fly is refined and built. Craft a Weapon I, then a Shield Extender II — haul the ore home and use the Industry tab."',
    // A cargo expander so a fresh hold can fit the recipe ore for both crafts.
    grant: {
      modules: [{ slot: 'cargo', tier: 3 }],
      items: { iron: 3, bauxite: 3, scrap: 5, alloy: 2 },
      blueprints: [{ kind: 'module', type: 'weapon', tier: 1 }, { kind: 'module', type: 'shield', tier: 2 }],
    },
    objective: {
      type: 'craft',
      label: 'Craft a Weapon I and a Shield Extender II',
      targets: [
        { slot: 'weapon', tier: 1, count: 1, label: 'Craft Weapon I' },
        { slot: 'shield', tier: 2, count: 1, label: 'Craft Shield Extender II' },
      ],
    },
    completion: { items: { scrap: 6 }, text: '"That\'s how industry works. Now you can build what you fly."' },
  },
  m8: {
    id: 'm8', title: 'Certification', npc: 'Station A',
    brief: '"Congratulations on finishing our new pilot course and receiving your pilot certification. You are now authorized for all jump gates, which allow you access to other systems."',
    grant: {},
    objective: { type: 'dialogue', label: 'Accept your certification' },
    completion: { items: {}, text: '"The gates are open, pilot. Fly safe."' },
  },
  m9: {
    id: 'm9', title: 'Beyond the Gates', npc: 'Concord Liaison',
    brief: '"Your certification is only the beginning. Travel to Placid and clear two raider ships threatening local miners."',
    systemId: 'sys_1',
    spawn: [{ type: 'pirate', tier: 'elite', tag: 'placidraider', count: 2 }],
    objective: { type: 'kill', enemyTag: 'placidraider', count: 2, label: 'Clear two raiders in Placid' },
    completion: { items: { alloy: 3 }, text: '"The route is secure. More contracts await across the region."' },
  },
};

const AGENT_MISSIONS = [
  { key: 'pirate-hunt', name: 'Pirate Hunt', objective: 'Destroy 3 pirate ships', type: 'kill', enemyType: 'pirate', target: 3, rewardItems: { scrap: 9 } },
  { key: 'ore-haul', name: 'Ore Haul', objective: 'Mine 100 units of ore', type: 'mine', target: 100, rewardItems: { alloy: 3 } },
  { key: 'field-survey', name: 'Field Survey', objective: 'Mine 200 units of ore', type: 'mine', target: 200, rewardItems: { scrap: 6 } },
];
const AGENT_MISSION_COOLDOWN_MS = 24 * 60 * 60 * 1000;

// ---- spatial world ----
const WORLD_SIZE = 8000;        // world is WORLD_SIZE x WORLD_SIZE units
const ASTEROID_FIELDS = 2;      // number of asteroid belts (clusters)
const ASTEROIDS_PER_FIELD = [18, 24]; // min..max asteroids per belt
const ASTEROID_AMOUNT = [400, 1200]; // min..max units per asteroid
const MINING_RATE_MULTIPLIER = 0.5;
const PLANET_COUNT = 3;         // landmark planets
const MINING_RANGE = 160;       // must be this close to an asteroid to mine it
const ENGAGE_RANGE = 240;       // must be this close to an enemy to engage it
const DOCK_RANGE = 260;         // must be this close to a station to dock/trade
const GATE_RANGE = 320;         // must be this close to a gate to jump systems
const MAX_SPEED = 600;          // units/sec
const MAX_THRUST = 260;         // legacy constant retained for catalog compatibility
const DAMPING = 0.985;          // per-frame velocity damping
const ARRIVE_RADIUS = 24;       // click-to-move arrival radius
const STATE_VERSION = 16;

module.exports = {
  SHIPS,
  MODULES,
  MINERALS,
  COMPONENTS,
  ORE_EXCHANGE,
  COMPONENT_EXCHANGE,
  BLUEPRINT_COSTS,
  NPC_BLUEPRINTS,
  BLUEPRINT_DROP_CHANCE,
  BLUEPRINT_DROP_POOLS,
  SHIP_PROGRESSION,
  ENEMIES,
  ENEMY_TIERS,
  loadEnemyData,
  spawnTable,
  MODES,
  MAX_OFFLINE_SECONDS,
  SHIELD_BOOST_ITEM,
  SHIELD_BOOST_COOLDOWN,
  OVERLOAD_ITEM,
  OVERLOAD_DPS_MULT,
  OVERLOAD_DURATION,
  OVERLOAD_COOLDOWN,
  SKILLS,
  SP_RATE_PER_SEC,
  ACHIEVEMENTS,
  AMBUSH_BASE_CHANCE,
  AMBUSH_MIN_CHANCE,
  AMBUSH_MAX_CHANCE,
  DRONES,
  DRONE_MAX_PER_TYPE,
  LOOT_DROP_CHANCE,
  LOOT_TIERS,
  BLUEPRINTS,
  SHIP_BLUEPRINTS,
  MISSION_ORDER,
  MISSIONS,
  AGENT_MISSIONS,
  AGENT_MISSION_COOLDOWN_MS,
  WORLD_SIZE,
  ASTEROID_FIELDS,
  ASTEROIDS_PER_FIELD,
  ASTEROID_AMOUNT,
  MINING_RATE_MULTIPLIER,
  PLANET_COUNT,
  MINING_RANGE,
  ENGAGE_RANGE,
  DOCK_RANGE,
  GATE_RANGE,
  MAX_SPEED,
  MAX_THRUST,
  DAMPING,
  ARRIVE_RADIUS,
  STATE_VERSION,
};
