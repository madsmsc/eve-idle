'use strict';

// Static game data + spatial constants. The server is the single source of
// truth. The client only sends intents (positions, "buy X", "engage Y"); every
// quantity, range, yield and reward is computed here.

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
  rifter:    { key: 'rifter',    name: 'Rifter',    cost: 0,      mining: 6,   combat: 5,   sellValue: 0,      cargo: 60,   shield: 50,  hull: 100,  dps: 10, slots: { weapon: 1, shield: 1, armor: 0, mining: 1, cargo: 1, range: 1 } },
  falcon:    { key: 'falcon',    name: 'Falcon',    cost: 5000,   mining: 14,  combat: 12,  sellValue: 2500,   cargo: 200,  shield: 120, hull: 200,  dps: 25, slots: { weapon: 2, shield: 2, armor: 1, mining: 1, cargo: 1, range: 1 } },
  raptor:    { key: 'raptor',    name: 'Raptor',    cost: 15000,  mining: 8,   combat: 30,  sellValue: 7500,   cargo: 120,  shield: 80,  hull: 250,  dps: 40, slots: { weapon: 3, shield: 1, armor: 1, mining: 0, cargo: 1, range: 1 } },
  vexor:     { key: 'vexor',     name: 'Vexor',     cost: 20000,  mining: 30,  combat: 25,  sellValue: 10000,  cargo: 500,  shield: 150, hull: 300,  dps: 35, slots: { weapon: 2, shield: 2, armor: 1, mining: 3, cargo: 2, range: 1 } },
  gnosis:    { key: 'gnosis',    name: 'Gnosis',    cost: 75000,  mining: 70,  combat: 40,  sellValue: 37500,  cargo: 1200, shield: 300, hull: 500,  dps: 60, slots: { weapon: 2, shield: 2, armor: 2, mining: 4, cargo: 4, range: 1 } },
  manticore: { key: 'manticore', name: 'Manticore', cost: 100000, mining: 12,  combat: 80,  sellValue: 50000,  cargo: 250,  shield: 200, hull: 600,  dps: 90, slots: { weapon: 4, shield: 2, armor: 2, mining: 0, cargo: 1, range: 1 } },
  brutix:    { key: 'brutix',    name: 'Brutix',    cost: 250000, mining: 170, combat: 60,  sellValue: 125000, cargo: 3000, shield: 400, hull: 800,  dps: 70, slots: { weapon: 2, shield: 3, armor: 3, mining: 5, cargo: 5, range: 1 } },
};

// Fitting modules. Each module type boosts one stat by a flat bonus. A module
// has four tiers, with faction-grade modules at Tier IV. Fitting a slot to a
// tier costs that tier's price; downgrading refunds the difference, so a slot
// can be re-fitted at any time.
const MODULES = {
  weapon: { key: 'weapon', name: 'Weapon',            stat: 'dps',    tiers: [ { tier: 1, cost: 1000,  bonus: 6 },   { tier: 2, cost: 4000,  bonus: 18 },  { tier: 3, cost: 12000, bonus: 45 }, { tier: 4, cost: 36000, bonus: 110 } ] },
  shield: { key: 'shield', name: 'Shield Extender',   stat: 'shield', tiers: [ { tier: 1, cost: 800,   bonus: 25 },  { tier: 2, cost: 3000,  bonus: 75 },  { tier: 3, cost: 9000,  bonus: 180 }, { tier: 4, cost: 27000, bonus: 420 } ] },
  armor:  { key: 'armor',  name: 'Armor Plate',       stat: 'hull',   tiers: [ { tier: 1, cost: 800,   bonus: 35 },  { tier: 2, cost: 3000,  bonus: 100 }, { tier: 3, cost: 9000,  bonus: 240 }, { tier: 4, cost: 27000, bonus: 560 } ] },
  mining: { key: 'mining', name: 'Mining Augmenter',  stat: 'mining', tiers: [ { tier: 1, cost: 600,  bonus: 4 },   { tier: 2, cost: 2500,  bonus: 12 },  { tier: 3, cost: 8000,  bonus: 35 }, { tier: 4, cost: 24000, bonus: 85 } ] },
  cargo:  { key: 'cargo',  name: 'Cargo Expander',    stat: 'cargo',  tiers: [ { tier: 1, cost: 500,  bonus: 60 },  { tier: 2, cost: 2000,  bonus: 160 }, { tier: 3, cost: 6000,  bonus: 450 }, { tier: 4, cost: 18000, bonus: 1100 } ] },
  range:  { key: 'range',  name: 'Range Amplifier',   stat: 'range',  tiers: [ { tier: 1, cost: 700,  bonus: 3 },   { tier: 2, cost: 2800,  bonus: 8 },   { tier: 3, cost: 8500,  bonus: 20 }, { tier: 4, cost: 25500, bonus: 50 } ] },
};

// Each asteroid holds one mineral. Mining an asteroid yields that mineral.
const MINERALS = {
  iron:       { key: 'iron',       name: 'Iron',       price: 5,  color: '#c9d1d9' },
  bauxite:    { key: 'bauxite',    name: 'Bauxite',    price: 8,  color: '#e0a458' },
  gadolinium: { key: 'gadolinium', name: 'Gadolinium', price: 15, color: '#b07ce0' },
  megacyte:   { key: 'megacyte',   name: 'Megacyte',   price: 40, color: '#5ce0c8' },
};

// Enemy classes you can fly to and engage. Combat pays ISK; minerals come from
// mining asteroids.
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
    for (const f of ['shield', 'hull', 'dps', 'reward']) {
      if (!(t[f] >= 0)) throw new Error(`enemies.json: type "${key}" has an invalid ${f}`);
    }
    const spawn = (t.spawn || []).map((r) => {
      if (!tiers[r.tier]) throw new Error(`enemies.json: type "${key}" spawns unknown tier "${r.tier}"`);
      if (!(r.weight > 0)) throw new Error(`enemies.json: type "${key}" spawn rule needs a positive weight`);
      return { tier: r.tier, minSecurity: r.minSecurity, maxSecurity: r.maxSecurity, weight: r.weight };
    });
    types[key] = { key, name: t.name || key, iskReward: t.reward, shield: t.shield, hull: t.hull, dps: t.dps, spawn };
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

const START_ISK = 10000;
const START_STORY_ISK = 0;  // the storyline pays its own way via mission rewards
const MODES = ['demo', 'story'];
const MAX_OFFLINE_SECONDS = 8 * 3600;

// When a ship is destroyed its cargo hold is lost with it (the core EVE risk).
// Insurance refunds a fraction of the ship's purchase cost — never the cargo.
const INSURANCE_FRACTION = 0.5;

// ---- in-fight actions (interactive combat) ----
// During a real-time fight you can spend ISK to change the odds, or disengage
// to bail out and keep the ship (no reward, the rat escapes).
const SHIELD_BOOST_COST = 500;      // ISK to instantly restore your shield to full
const SHIELD_BOOST_COOLDOWN = 6;    // seconds of fight time before you can boost again
const OVERLOAD_COST = 400;          // ISK to overload your weapons
const OVERLOAD_DPS_MULT = 1.6;      // DPS multiplier while overloaded
const OVERLOAD_DURATION = 5;        // seconds the overload lasts
const OVERLOAD_COOLDOWN = 9;        // seconds of fight time before you can overload again

// ---- skill tree ----
// Skills are player-level (apply to every ship). You earn skill points over
// time (idle) and from kills, then spend them to train a skill up a level.
// Each skill multiplies one stat by (1 + pctPerLevel * level). Training is
// instant — the gate is the skill points you have to spend.
const SKILLS = {
  miningYield:     { key: 'miningYield',     name: 'Mining Yield',      category: 'Mining', maxLevel: 4, baseCost: 20, costGrowth: 1.8, effect: { stat: 'mining', pctPerLevel: 0.10 } },
  cargoManagement: { key: 'cargoManagement', name: 'Cargo Management',  category: 'Mining', maxLevel: 3, baseCost: 15, costGrowth: 1.8, effect: { stat: 'cargo',  pctPerLevel: 0.15 } },
  gunnery:         { key: 'gunnery',         name: 'Gunnery',           category: 'Combat', maxLevel: 4, baseCost: 20, costGrowth: 1.8, effect: { stat: 'dps',    pctPerLevel: 0.10 } },
  shieldUpgrades:  { key: 'shieldUpgrades',  name: 'Shield Upgrades',   category: 'Combat', maxLevel: 4, baseCost: 20, costGrowth: 1.8, effect: { stat: 'shield', pctPerLevel: 0.10 } },
  hullUpgrades:    { key: 'hullUpgrades',    name: 'Hull Upgrades',     category: 'Combat', maxLevel: 3, baseCost: 15, costGrowth: 1.8, effect: { stat: 'hull',   pctPerLevel: 0.08 } },
  bountyHunting:   { key: 'bountyHunting',   name: 'Bounty Hunting',    category: 'Combat', maxLevel: 3, baseCost: 25, costGrowth: 1.8, effect: { stat: 'reward', pctPerLevel: 0.10 } },
};
const SP_RATE_PER_SEC = 0.25;  // skill points earned per second (idle progression)
const SP_PER_KILL = 15;        // skill points earned per rat destroyed
const ACHIEVEMENTS = {
  miner: { key: 'miner', name: 'Prospector', description: 'Mine 1,000 units of ore', stat: 'totalMineralsMined', target: 1000 },
  veteran: { key: 'veteran', name: 'Veteran', description: 'Win 10 battles', stat: 'combatsWon', target: 10 },
  industrialist: { key: 'industrialist', name: 'Industrialist', description: 'Craft 5 modules', stat: 'modulesCrafted', target: 5 },
  tycoon: { key: 'tycoon', name: 'Tycoon', description: 'Earn 100,000 ISK', stat: 'totalIskEarned', target: 100000 },
  certified: { key: 'certified', name: 'Certified Pilot', description: 'Complete pilot training', stat: 'missionsCompleted', target: 8 },
};

// ---- faction standing ----
// Each system is controlled by a faction. Your standing with a faction (from
// -10 to +10, starting at 0) shifts with what you do in their space: clearing
// their rats raises it, losing a ship there lowers it. Standing affects the
// gate-ambush risk when you jump into their system and a small market bonus.
const FACTIONS = {
  serpentis: { key: 'serpentis', name: 'Serpentis',     systemId: 'sys_0' },
  concord:   { key: 'concord',   name: 'The Concord',   systemId: 'sys_1' },
  syndicate: { key: 'syndicate', name: 'The Syndicate', systemId: 'sys_2' },
};
// Reverse lookup: systemId -> faction key.
const SYSTEM_FACTION = { sys_0: 'serpentis', sys_1: 'concord', sys_2: 'syndicate' };
const STANDING_MIN = -10;
const STANDING_MAX = 10;
const STANDING_PER_KILL = 0.2;   // standing gained per rat cleared in a faction's system
const STANDING_PER_DEATH = -0.5; // standing lost when a ship is destroyed in a faction's system
const STANDING_PRICE_MOD = 0.01; // market price multiplier per point of standing (±10%)

// ---- gate ambush risk ----
// Jumping a gate can draw a predator from the other side. The base chance is
// modified by your standing with the destination system's faction: the less you
// are liked there, the more likely the ambush.
const AMBUSH_BASE_CHANCE = 0.15;
const AMBUSH_STANDING_MOD = 0.04; // per point of standing (lower standing -> higher chance)
const AMBUSH_MIN_CHANCE = 0.03;
const AMBUSH_MAX_CHANCE = 0.40;

// ---- drones ----
// Drones live in your drone bay (player-level, so they apply to whichever ship
// you are flying) and assist with mining or combat. They are independent craft,
// so they are NOT lost when a ship is destroyed. You can own up to
// DRONE_MAX_PER_TYPE of each type; every drone adds a flat bonus to the active
// ship's mining yield or combat DPS. Buy more to stack the bonus.
const DRONES = {
  mining: { key: 'mining', name: 'Mining Drone', stat: 'mining', tiers: [
    { tier: 1, cost: 1500,  bonus: 5 },
    { tier: 2, cost: 5000,  bonus: 14 },
    { tier: 3, cost: 16000, bonus: 40 },
  ] },
  combat: { key: 'combat', name: 'Combat Drone', stat: 'dps', tiers: [
    { tier: 1, cost: 2000,  bonus: 8 },
    { tier: 2, cost: 7000,  bonus: 22 },
    { tier: 3, cost: 22000, bonus: 60 },
  ] },
};
const DRONE_MAX_PER_TYPE = 5; // max drones of each type in the bay

// ---- loot drops ----
// Destroying a rat can drop a module (matching the fitting MODULES, tier I/II/III)
// into your loot inventory. It is equipped into an empty fitting slot on the
// active ship (see game.equipLoot), so combat feeds your fitting without ISK.
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

// ---- industry (blueprint crafting) ----
// Every module tier has a blueprint that turns raw minerals into that module
// (crafted modules go straight into your loot inventory, ready to equip).
// A recipe's mineral value is ~CRAFT_DISCOUNT of the module's ISK price, so
// crafting is cheaper than buying *if* you have the ore on hand — it gives
// mining/hauling a second sink beyond selling. Minerals are taken from the
// active ship's cargo hold, so you have to haul the ore to the station first.
const CRAFT_DISCOUNT = 0.75;
// Recipe weight per mineral: iron is the bulk, megacyte is the rare, pricey bit.
const CRAFT_WEIGHTS = { iron: 1, bauxite: 0.55, gadolinium: 0.3, megacyte: 0.12 };
const BLUEPRINTS = (() => {
  const out = {};
  const ROMAN = ['', 'I', 'II', 'III'];
  for (const slotType of Object.keys(MODULES)) {
    const mod = MODULES[slotType];
    out[slotType] = {};
    for (const t of mod.tiers) {
      const target = Math.round(t.cost * CRAFT_DISCOUNT);
      const weights = t.tier === 4
        ? { iron: 0.35, bauxite: 0.35, gadolinium: 0.7, megacyte: 2.5 }
        : CRAFT_WEIGHTS;
      const weightTotal = Object.values(weights).reduce((a, b) => a + b, 0);
      const recipe = {};
      for (const mKey of Object.keys(MINERALS)) {
        recipe[mKey] = Math.max(1, Math.round((target * (weights[mKey] || 0)) / MINERALS[mKey].price / weightTotal));
      }
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
  for (const [key, ship] of Object.entries(SHIPS)) {
    if (!ship.cost) continue;
    const target = Math.round(ship.cost * CRAFT_DISCOUNT);
    const totalW = Object.values(CRAFT_WEIGHTS).reduce((a, b) => a + b, 0);
    const recipe = {};
    for (const mineral of Object.keys(MINERALS)) {
      recipe[mineral] = Math.max(1, Math.round((target * CRAFT_WEIGHTS[mineral]) / MINERALS[mineral].price / totalW));
    }
    out[key] = { type: key, name: ship.name, recipe };
  }
  return out;
})();

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
    grant: { modules: [{ slot: 'weapon', tier: 1 }], isk: 0 },
    spawn: [{ type: 'pirate', tier: 'standard', tag: 'attacker', count: 1 }],
    objective: { type: 'kill', enemyTag: 'attacker', count: 1, label: 'Destroy the attacker frigate' },
    completion: { isk: 500, text: '"Good shooting, pilot. We\'re in your debt."' },
  },
  m2: {
    id: 'm2', title: 'Help the Buddies', npc: 'Station A',
    brief: '"Our buddies need help too. Kill three frigates. These frigates carry short-range guns — fit your Range Amplifier to hit them before they can hit you. Stay at range and take them down."',
    grant: { modules: [{ slot: 'range', tier: 1 }], isk: 0 },
    spawn: [{ type: 'pirate', tier: 'standard', tag: 'shortrange', count: 3, rangeDelay: 2 }],
    objective: { type: 'kill', enemyTag: 'shortrange', count: 3, label: 'Destroy short-range frigates' },
    completion: { isk: 1000, text: '"They never knew what hit them. Range is everything out here."' },
  },
  m3: {
    id: 'm3', title: 'Last Stand', npc: 'Station A',
    brief: '"It doesn\'t seem like there\'s any way out of this alive. Too many ships are warping in and our warp drive is down. Let\'s go down fighting. After all, a good fight is what it\'s all about."',
    grant: { isk: 0 },
    spawn: [{ type: 'faction', tier: 'elite', tag: 'waveship', count: 5 }],
    objective: { type: 'death', label: 'Survive as long as you can' },
    completion: { isk: 0, text: '"They got you... but you fought well."' },
  },
  m4: {
    id: 'm4', title: 'A New Clone', npc: 'Station A',
    brief: '"Welcome back, pilot. You have awoken in another clone. Here\'s how a station works. You have been given a replacement frigate — dock and take stock."',
    grant: { ships: ['rifter'], modules: [{ slot: 'weapon', tier: 1 }], isk: 0 },
    objective: { type: 'dock', label: 'Dock at the station' },
    completion: { isk: 0, text: '"Everything you own survives in your clone\'s records. Ships come and go — the pilot endures."' },
  },
  m5: {
    id: 'm5', title: 'Mining 101', npc: 'Station A',
    brief: '"All ships and modules are made from refined ore. Let\'s get you started on mining. Fly to an asteroid and mine it into your hold."',
    grant: { modules: [{ slot: 'mining', tier: 1 }], isk: 0 },
    objective: { type: 'mine', target: 40, label: 'Mine 40 ore' },
    completion: { isk: 500, text: '"Good. That ore will become hulls and guns."' },
  },
  m6: {
    id: 'm6', title: 'Rogue Drones', npc: 'Station A',
    brief: '"We are having some trouble with rogue drones harassing our miners. Go deal with the drone hub — and if you handle it, drone control is yours."',
    grant: { isk: 0 },
    spawn: [{ type: 'dronehub', tier: 'standard', tag: 'dronhub', count: 1, rangeDelay: 2 }],
    objective: { type: 'kill', enemyTag: 'dronhub', count: 1, label: 'Destroy the rogue drone hub' },
    completion: { isk: 800, drones: [{ type: 'mining', tier: 1 }], text: '"The hub is gone. Your new mining drone is in the bay."' },
  },
  m7: {
    id: 'm7', title: 'The Forge', npc: 'Station A',
    brief: '"Every module you fly is refined and built. Craft a Weapon I, then a Shield Extender II — haul the ore home and use the Industry tab."',
    // A cargo expander so a fresh hold can fit the recipe ore for both crafts.
    grant: { modules: [{ slot: 'cargo', tier: 3 }], isk: 0 },
    objective: {
      type: 'craft',
      label: 'Craft a Weapon I and a Shield Extender II',
      targets: [
        { slot: 'weapon', tier: 1, count: 1, label: 'Craft Weapon I' },
        { slot: 'shield', tier: 2, count: 1, label: 'Craft Shield Extender II' },
      ],
    },
    completion: { isk: 1000, text: '"That\'s how industry works. Now you can build what you fly."' },
  },
  m8: {
    id: 'm8', title: 'Certification', npc: 'Station A',
    brief: '"Congratulations on finishing our new pilot course and receiving your pilot certification. You are now authorized for all jump gates, which allow you access to other systems."',
    grant: { isk: 0 },
    objective: { type: 'dialogue', label: 'Accept your certification' },
    completion: { isk: 0, text: '"The gates are open, pilot. Fly safe."' },
  },
  m9: {
    id: 'm9', title: 'Beyond the Gates', npc: 'Concord Liaison',
    brief: '"Your certification is only the beginning. Travel to Placid and clear two raider ships threatening local miners."',
    systemId: 'sys_1',
    spawn: [{ type: 'pirate', tier: 'elite', tag: 'placidraider', count: 2 }],
    objective: { type: 'kill', enemyTag: 'placidraider', count: 2, label: 'Clear two raiders in Placid' },
    completion: { isk: 3000, text: '"The route is secure. More contracts await across the region."' },
  },
};

const AGENT_MISSIONS = [
  { key: 'pirate-hunt', name: 'Pirate Hunt', objective: 'Destroy 3 pirate ships', type: 'kill', enemyType: 'pirate', target: 3, reward: 2500 },
  { key: 'ore-haul', name: 'Ore Haul', objective: 'Sell 100 units of ore', type: 'haul', target: 100, reward: 1800 },
  { key: 'field-survey', name: 'Field Survey', objective: 'Mine 200 units of ore', type: 'mine', target: 200, reward: 2000 },
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
const MAX_SPEED = 600;          // units/sec (client + server agree on this)
const MAX_THRUST = 260;         // units/sec^2 (client-side)
const DAMPING = 0.985;          // per-frame velocity damping (client-side)
const ARRIVE_RADIUS = 24;       // click-to-move arrival radius
const STATE_VERSION = 15;

module.exports = {
  SHIPS,
  MODULES,
  MINERALS,
  ENEMIES,
  ENEMY_TIERS,
  loadEnemyData,
  spawnTable,
  START_ISK,
  START_STORY_ISK,
  MODES,
  MAX_OFFLINE_SECONDS,
  INSURANCE_FRACTION,
  SHIELD_BOOST_COST,
  SHIELD_BOOST_COOLDOWN,
  OVERLOAD_COST,
  OVERLOAD_DPS_MULT,
  OVERLOAD_DURATION,
  OVERLOAD_COOLDOWN,
  SKILLS,
  SP_RATE_PER_SEC,
  SP_PER_KILL,
  ACHIEVEMENTS,
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
