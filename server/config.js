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

const SHIP_CLASSES = [
  { key: 'frigate', name: 'Frigate', speed: 1.25, mining: 18, dps: 20, shield: 90, hull: 170, cargo: 90, slots: 1 },
  { key: 'destroyer', name: 'Destroyer', speed: 1.1, mining: 32, dps: 34, shield: 170, hull: 310, cargo: 220, slots: 2 },
  { key: 'cruiser', name: 'Cruiser', speed: 0.95, mining: 55, dps: 58, shield: 330, hull: 600, cargo: 500, slots: 3 },
  { key: 'battlecruiser', name: 'Battlecruiser', speed: 0.8, mining: 95, dps: 92, shield: 640, hull: 1150, cargo: 1100, slots: 4 },
  { key: 'battleship', name: 'Battleship', speed: 0.65, mining: 150, dps: 145, shield: 1200, hull: 2200, cargo: 2500, slots: 5 },
];

const SHIP_FAMILIES = [
  { key: 'miner', name: 'Prospector', role: 'miner', weaponType: null, skill: 'miningYield' },
  { key: 'fast_projectile', name: 'Projectile Scout', role: 'fast', weaponType: 'projectile', skill: 'projectileWeapons' },
  { key: 'fast_missile', name: 'Missile Scout', role: 'fast', weaponType: 'missile', skill: 'missileWeapons' },
  { key: 'fast_laser', name: 'Laser Scout', role: 'fast', weaponType: 'laser', skill: 'laserWeapons' },
  { key: 'fast_drone', name: 'Drone Scout', role: 'fast', weaponType: 'drone', skill: 'droneCommand' },
  { key: 'heavy_projectile', name: 'Projectile Bulwark', role: 'heavy', weaponType: 'projectile', skill: 'projectileWeapons' },
  { key: 'heavy_missile', name: 'Missile Bulwark', role: 'heavy', weaponType: 'missile', skill: 'missileWeapons' },
  { key: 'heavy_laser', name: 'Laser Bulwark', role: 'heavy', weaponType: 'laser', skill: 'laserWeapons' },
  { key: 'heavy_drone', name: 'Drone Bulwark', role: 'heavy', weaponType: 'drone', skill: 'droneCommand' },
];

const WEAPON_SLOT_BY_TYPE = {
  projectile: 'projectileWeapon',
  missile: 'missileWeapon',
  laser: 'laserWeapon',
  drone: 'droneWeapon',
};

const SHIP_PROGRESSION = SHIP_CLASSES.map((shipClass, classIndex) => ({
  tier: classIndex + 1,
  classKey: shipClass.key,
  className: shipClass.name,
  ships: [],
}));

const legacyShipEntries = [
  { type: 'rifter', classIndex: 0, skills: [] },
  { type: 'falcon', classIndex: 1, skills: [{ skill: 'miningYield', level: 1 }] },
  { type: 'raptor', classIndex: 1, skills: [{ skill: 'gunnery', level: 1 }] },
  { type: 'vexor', classIndex: 2, skills: [{ skill: 'miningYield', level: 2 }] },
  { type: 'gnosis', classIndex: 3, skills: [{ skill: 'cargoManagement', level: 2 }] },
  { type: 'manticore', classIndex: 2, skills: [{ skill: 'gunnery', level: 3 }] },
  { type: 'brutix', classIndex: 3, skills: [{ skill: 'miningYield', level: 4 }] },
];

for (const entry of legacyShipEntries) {
  const shipClass = SHIP_CLASSES[entry.classIndex];
  SHIP_PROGRESSION[entry.classIndex].ships.push({
    type: entry.type,
    familyKey: 'legacy',
    classKey: shipClass.key,
    skills: [...entry.skills, ...(entry.classIndex === 0 ? [] : [
      { skill: `${shipClass.key}Command`, level: entry.classIndex + 1 },
    ])],
  });
}

for (const [classIndex, shipClass] of SHIP_CLASSES.entries()) {
  for (const family of SHIP_FAMILIES) {
    const type = `${family.key}_${shipClass.key}`;
    const miner = family.role === 'miner';
    const fast = family.role === 'fast';
    const drone = family.weaponType === 'drone';
    const weaponSlot = family.weaponType ? WEAPON_SLOT_BY_TYPE[family.weaponType] : null;
    const slots = {
      weapon: 0,
      projectileWeapon: 0,
      missileWeapon: 0,
      laserWeapon: 0,
      droneWeapon: 0,
      shield: Math.max(1, Math.ceil(shipClass.slots * 0.6)),
      armor: fast ? Math.max(0, Math.floor(shipClass.slots * 0.4)) : Math.max(1, Math.ceil(shipClass.slots * 0.5)),
      mining: miner ? shipClass.slots : Math.max(0, Math.floor(shipClass.slots * 0.35)),
      cargo: Math.max(1, Math.ceil(shipClass.slots * 0.5)),
      range: 1,
      miningDrone: miner ? 1 : 0,
      combatDrone: family.weaponType ? 0 : 1,
    };
    if (weaponSlot) slots[weaponSlot] = Math.max(1, Math.ceil(shipClass.slots * (fast ? 1 : 0.8)));
    const profile = miner
      ? { mining: 3, dps: 0.35, tank: 0.8, cargo: 1.5, speed: 0.78 }
      : fast
        ? { mining: 0.35, dps: 1.05, tank: 0.65, cargo: 0.75, speed: 1.55 }
        : { mining: 0.7, dps: 1, tank: 1.65, cargo: 1.1, speed: 0.65 };
    const dpsAdjustment = drone ? 0.9 : 1;
    SHIPS[type] = {
      key: type,
      name: `${shipClass.name} ${family.name}`,
      classKey: shipClass.key,
      className: shipClass.name,
      familyKey: family.key,
      role: family.role,
      weaponType: family.weaponType,
      weaponSlot,
      mining: Math.round(shipClass.mining * profile.mining),
      combat: classIndex + 1,
      cargo: Math.round(shipClass.cargo * profile.cargo),
      shield: Math.round(shipClass.shield * profile.tank),
      hull: Math.round(shipClass.hull * profile.tank),
      dps: Math.round(shipClass.dps * profile.dps * dpsAdjustment),
      speedMultiplier: shipClass.speed * profile.speed,
      slots,
    };
    const commandSkill = `${shipClass.key}Command`;
    const skillLevel = classIndex + 1;
    const requirements = [{ skill: commandSkill, level: skillLevel }];
    if (miner) {
      requirements.push(
        { skill: 'miningYield', level: skillLevel },
        { skill: 'miningCycle', level: skillLevel },
      );
    } else {
      requirements.push({ skill: family.skill, level: skillLevel });
      requirements.push(fast
        ? { skill: 'evasiveManeuver', level: Math.min(5, Math.max(1, skillLevel - 1)) }
        : { skill: 'hullUpgrades', level: Math.min(5, skillLevel) });
      if (drone) requirements.push({ skill: 'droneDamage', level: skillLevel });
    }
    SHIP_PROGRESSION[classIndex].ships.push({
      type,
      familyKey: family.key,
      classKey: shipClass.key,
      role: family.role,
      weaponType: family.weaponType,
      skills: requirements,
    });
  }
}

// Fitting modules. Each module type boosts one stat by a flat bonus. Modules
// are inventory items; fitting consumes one and un-fitting returns one.
const MODULES = {
  weapon: { key: 'weapon', name: 'Weapon', stat: 'dps', tiers: [ { tier: 1, bonus: 6 }, { tier: 2, bonus: 18 }, { tier: 3, bonus: 45 }, { tier: 4, bonus: 110 } ] },
  shield: { key: 'shield', name: 'Shield Extender', stat: 'shield', tiers: [ { tier: 1, bonus: 25 }, { tier: 2, bonus: 75 }, { tier: 3, bonus: 180 }, { tier: 4, bonus: 420 } ] },
  armor:  { key: 'armor', name: 'Armor Plate', stat: 'hull', tiers: [ { tier: 1, bonus: 35 }, { tier: 2, bonus: 100 }, { tier: 3, bonus: 240 }, { tier: 4, bonus: 560 } ] },
  mining: { key: 'mining', name: 'Mining Augmenter', stat: 'mining', tiers: [ { tier: 1, bonus: 4 }, { tier: 2, bonus: 12 }, { tier: 3, bonus: 35 }, { tier: 4, bonus: 85 } ] },
  cargo:  { key: 'cargo', name: 'Cargo Expander', stat: 'cargo', tiers: [ { tier: 1, bonus: 60 }, { tier: 2, bonus: 160 }, { tier: 3, bonus: 450 }, { tier: 4, bonus: 1100 } ] },
  range:  { key: 'range', name: 'Range Amplifier', stat: 'range', tiers: [ { tier: 1, bonus: 3 }, { tier: 2, bonus: 8 }, { tier: 3, bonus: 20 }, { tier: 4, bonus: 50 } ] },
  projectileWeapon: { key: 'projectileWeapon', name: 'Projectile Cannon', stat: 'dps', skill: 'projectileWeapons', tiers: [ { tier: 1, bonus: 6 }, { tier: 2, bonus: 18 }, { tier: 3, bonus: 45 }, { tier: 4, bonus: 110 } ] },
  missileWeapon: { key: 'missileWeapon', name: 'Missile Launcher', stat: 'dps', skill: 'missileWeapons', tiers: [ { tier: 1, bonus: 6 }, { tier: 2, bonus: 18 }, { tier: 3, bonus: 45 }, { tier: 4, bonus: 110 } ] },
  laserWeapon: { key: 'laserWeapon', name: 'Laser Array', stat: 'dps', skill: 'laserWeapons', tiers: [ { tier: 1, bonus: 6 }, { tier: 2, bonus: 18 }, { tier: 3, bonus: 45 }, { tier: 4, bonus: 110 } ] },
  droneWeapon: { key: 'droneWeapon', name: 'Combat Drone Control', stat: 'dps', skill: 'droneCommand', tiers: [ { tier: 1, bonus: 8 }, { tier: 2, bonus: 22 }, { tier: 3, bonus: 60 }, { tier: 4, bonus: 150 } ] },
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
// to bail out and keep the ship (no reward, the enemy escapes).
const SHIELD_BOOST_ITEM = 'scrap';
const SHIELD_BOOST_COOLDOWN = 6;    // seconds of fight time before you can boost again
const OVERLOAD_ITEM = 'scrap';
const OVERLOAD_DPS_MULT = 1.6;      // DPS multiplier while overloaded
const OVERLOAD_DURATION = 5;        // seconds the overload lasts
const OVERLOAD_COOLDOWN = 9;        // seconds of fight time before you can overload again

// ---- skill tree ----
// Skill definitions drive training, bonuses, ship requirements, and module gates.
const skillSpecs = [
  ['miningYield', 'Mining Yield', 'Mining', 'Increases ore mined per cycle.', { stat: 'mining', pctPerLevel: 0.08 }],
  ['cargoManagement', 'Cargo Management', 'Mining', 'Increases ship cargo capacity.', { stat: 'cargo', pctPerLevel: 0.08 }],
  ['gunnery', 'Gunnery', 'Gunnery', 'Improves damage from conventional weapons.', { stat: 'dps', pctPerLevel: 0.04 }],
  ['shieldUpgrades', 'Shield Upgrades', 'Defense', 'Increases shield capacity.', { stat: 'shield', pctPerLevel: 0.06 }],
  ['hullUpgrades', 'Hull Upgrades', 'Defense', 'Increases hull capacity.', { stat: 'hull', pctPerLevel: 0.06 }],
  ['miningCycle', 'Mining Cycle Optimization', 'Mining', 'Increases mining cycle speed.', { stat: 'miningCycle', pctPerLevel: 0.08 }, []],
  ['miningSurvey', 'Asteroid Survey', 'Mining', 'Extends mining range.', { stat: 'miningRange', pctPerLevel: 0.05 }, [['miningYield', 1]]],
  ['miningDrones', 'Mining Drone Operation', 'Mining', 'Improves mining drone output.', { stat: 'miningDrone', pctPerLevel: 0.08 }, [['miningCycle', 2]]],
  ['oreProcessing', 'Advanced Mining Yield', 'Mining', 'Further increases ore mined per cycle.', { stat: 'mining', pctPerLevel: 0.04 }, [['miningYield', 2]]],
  ['weaponSystems', 'Weapon Systems', 'Gunnery', 'Improves all weapon systems.', { stat: 'dps', pctPerLevel: 0.04 }, [['gunnery', 1]]],
  ['projectileWeapons', 'Projectile Weapons', 'Gunnery', 'Unlocks projectile hulls and modules; improves projectile damage.', { stat: 'projectileDps', pctPerLevel: 0.08 }, [['weaponSystems', 1]]],
  ['missileWeapons', 'Missile Systems', 'Gunnery', 'Unlocks missile hulls and modules; improves missile damage.', { stat: 'missileDps', pctPerLevel: 0.08 }, [['weaponSystems', 1]]],
  ['laserWeapons', 'Laser Systems', 'Gunnery', 'Unlocks laser hulls and modules; improves laser damage.', { stat: 'laserDps', pctPerLevel: 0.08 }, [['weaponSystems', 1]]],
  ['droneCommand', 'Drone Command', 'Drones', 'Unlocks drone hulls and drone-control modules.', null, [['weaponSystems', 1]]],
  ['droneDamage', 'Drone Damage', 'Drones', 'Increases damage from combat drones.', { stat: 'droneDps', pctPerLevel: 0.1 }, [['droneCommand', 1]]],
  ['targeting', 'Targeting Systems', 'Gunnery', 'Improves weapon damage through target tracking.', { stat: 'dps', pctPerLevel: 0.04 }, [['gunnery', 2]]],
  ['navigation', 'Navigation', 'Navigation', 'Increases maximum ship speed.', { stat: 'speed', pctPerLevel: 0.05 }],
  ['piloting', 'Advanced Piloting', 'Navigation', 'Increases ship acceleration.', { stat: 'acceleration', pctPerLevel: 0.08 }, [['navigation', 1]]],
  ['evasiveManeuver', 'Evasive Maneuvers', 'Navigation', 'Improves speed-based combat damage mitigation.', { stat: 'evasion', pctPerLevel: 0.04 }, [['piloting', 2]]],
  ['warpDrive', 'Warp Drive Operation', 'Navigation', 'Improves navigation speed.', { stat: 'speed', pctPerLevel: 0.04 }, [['navigation', 2]]],
  ['shieldSystems', 'Shield Systems', 'Defense', 'Improves shield modules and capacity.', { stat: 'shield', pctPerLevel: 0.04 }, [['shieldUpgrades', 1]]],
  ['armorSystems', 'Armor Systems', 'Defense', 'Improves armor modules and hull capacity.', { stat: 'hull', pctPerLevel: 0.04 }, [['hullUpgrades', 1]]],
  ['damageControl', 'Damage Control', 'Defense', 'Reduces incoming combat damage.', { stat: 'damageReduction', pctPerLevel: 0.025 }, [['shieldSystems', 2], ['armorSystems', 2]]],
  ['frigateCommand', 'Frigate Command', 'Ship Command', 'Unlocks Frigate hulls.', null],
  ['destroyerCommand', 'Destroyer Command', 'Ship Command', 'Unlocks Destroyer hulls.', null, [['frigateCommand', 2]]],
  ['cruiserCommand', 'Cruiser Command', 'Ship Command', 'Unlocks Cruiser hulls.', null, [['destroyerCommand', 3]]],
  ['battlecruiserCommand', 'Battlecruiser Command', 'Ship Command', 'Unlocks Battlecruiser hulls.', null, [['cruiserCommand', 3]]],
  ['battleshipCommand', 'Battleship Command', 'Ship Command', 'Unlocks Battleship hulls.', null, [['battlecruiserCommand', 4]]],
  ['moduleEngineering', 'Module Engineering', 'Industry', 'Unlocks higher module tiers.', null, [['weaponSystems', 1], ['miningYield', 1]]],
  ['moduleScience', 'Module Science', 'Industry', 'Improves the strength of fitted modules.', { stat: 'moduleEffectiveness', pctPerLevel: 0.04 }, [['moduleEngineering', 2]]],
];
const SKILLS = Object.fromEntries(skillSpecs.map(([key, name, category, description, effect, requirements = []]) => [
  key,
  {
    key,
    name,
    category,
    description,
    maxLevel: 5,
    baseCost: 1500,
    costGrowth: 1.65,
    effect,
    requirements: requirements.map(([skill, level]) => ({ skill, level })),
  },
]));
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
// Destroying an enemy can drop a module (matching the fitting MODULES, tier I/II/III)
// into your loot inventory. It is equipped into an empty fitting slot on the
// active ship (see game.equipLoot).
// Bigger enemies drop better modules, more reliably.
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
  for (const progression of SHIP_PROGRESSION) {
    for (const entry of progression.ships) {
      if (entry.type === 'rifter') continue;
      const ship = SHIPS[entry.type];
      const classIndex = SHIP_CLASSES.findIndex((shipClass) => shipClass.key === entry.classKey);
      const recipeTier = Math.min(4, classIndex + 1);
      out[entry.type] = {
        type: entry.type,
        name: ship.name,
        recipe: tierRecipe(recipeTier, (classIndex + 1) * 3),
      };
    }
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
    ships: ['falcon', 'raptor', ...SHIP_PROGRESSION[0].ships.map((entry) => entry.type).filter((type) => type !== 'rifter')],
  },
  standard: {
    moduleTiers: [2, 3],
    ships: ['falcon', 'raptor', 'vexor', 'manticore', ...SHIP_PROGRESSION[1].ships.map((entry) => entry.type), ...SHIP_PROGRESSION[2].ships.map((entry) => entry.type)],
  },
  elite: {
    moduleTiers: [3, 4],
    ships: ['vexor', 'gnosis', 'manticore', 'brutix', ...SHIP_PROGRESSION[3].ships.map((entry) => entry.type), ...SHIP_PROGRESSION[4].ships.map((entry) => entry.type)],
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
      skillPoints: 7500,
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

const AGENT_ROLES = [
  {
    key: 'security',
    name: 'Security',
    titles: ['Security Agent', 'Combat Liaison', 'Patrol Coordinator'],
    agents: ['Ari Venn', 'Kara Sol', 'Dara Voss', 'Tomas Iren', 'Niko Pell', 'Mira Dane'],
  },
  {
    key: 'mining',
    name: 'Mining',
    titles: ['Mining Agent', 'Field Surveyor', 'Resource Coordinator'],
    agents: ['Sela Orin', 'Rhea Korr', 'Evan Quill', 'Juno Marr', 'Tavi Renn', 'Oren Vale'],
  },
  {
    key: 'industry',
    name: 'Industry',
    titles: ['Industry Agent', 'Production Liaison', 'Supply Coordinator'],
    agents: ['Lio Varda', 'Nara Pell', 'Cato Mire', 'Vera Sorn', 'Ilan Rusk', 'Suri Kade'],
  },
];

const AGENT_MISSIONS = {
  security: [
    { key: 'pirate-patrol', name: 'Pirate Patrol', objective: 'Destroy 3 pirate ships', type: 'kill', enemyType: 'pirate', target: 3, rewardItems: { scrap: 9 } },
    { key: 'gang-suppression', name: 'Gang Suppression', objective: 'Destroy 2 gang ships', type: 'kill', enemyType: 'gang', target: 2, rewardItems: { alloy: 2 } },
    { key: 'security-sweep', name: 'Security Sweep', objective: 'Destroy 4 hostile ships', type: 'kill', target: 4, rewardItems: { scrap: 12 } },
  ],
  mining: [
    { key: 'ore-survey', name: 'Ore Survey', objective: 'Mine 100 units of ore', type: 'mine', target: 100, rewardItems: { alloy: 3 } },
    { key: 'field-sample', name: 'Field Samples', objective: 'Mine 200 units of ore', type: 'mine', target: 200, rewardItems: { scrap: 8 } },
    { key: 'deep-field-haul', name: 'Deep-field Haul', objective: 'Mine 300 units of ore', type: 'mine', target: 300, rewardItems: { alloy: 5 } },
  ],
  industry: [
    { key: 'module-order', name: 'Module Order', objective: 'Craft 1 module or ship', type: 'craft', target: 1, rewardItems: { alloy: 3 } },
    { key: 'production-run', name: 'Production Run', objective: 'Craft 3 modules or ships', type: 'craft', target: 3, rewardItems: { circuits: 2 } },
    { key: 'fabrication-contract', name: 'Fabrication Contract', objective: 'Craft 5 modules or ships', type: 'craft', target: 5, rewardItems: { circuits: 3 } },
  ],
};

// ---- spatial world ----
const WORLD_SIZE = 8000;        // world is WORLD_SIZE x WORLD_SIZE units
const ASTEROID_FIELDS = 2;      // number of asteroid belts (clusters)
const ASTEROIDS_PER_FIELD = [18, 24]; // min..max asteroids per belt
const ASTEROID_AMOUNT = [400, 1200]; // min..max units per asteroid
const MINING_RATE_MULTIPLIER = 0.5;
const AUTOPILOT_EFFICIENCY = 0.25;
const PLANET_COUNT = 3;         // landmark planets
const MINING_RANGE = 160;       // must be this close to an asteroid to mine it
const ENGAGE_RANGE = 240;       // must be this close to an enemy to engage it
const DOCK_RANGE = 260;         // must be this close to a station to dock/trade
const GATE_RANGE = 320;         // must be this close to a gate to jump systems
const MAX_SPEED = 1200;         // units/sec
const MAX_ACCELERATION = 180;   // units/sec^2
const MAX_THRUST = 260;         // legacy constant retained for catalog compatibility
const DAMPING = 0.985;          // legacy constant retained for catalog compatibility
const ARRIVE_RADIUS = 24;       // click-to-move arrival radius
const AUTOPILOT_DOCK_WAIT_MS = 2000;
const AUTOPILOT_DEPOSIT_ANIMATION_MS = 1200;
const AUTOPILOT_LAUNCH_WAIT_MS = 2000;
const STATE_VERSION = 18;

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
  SHIP_CLASSES,
  SHIP_FAMILIES,
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
  AGENT_ROLES,
  AGENT_MISSIONS,
  WORLD_SIZE,
  ASTEROID_FIELDS,
  ASTEROIDS_PER_FIELD,
  ASTEROID_AMOUNT,
  MINING_RATE_MULTIPLIER,
  AUTOPILOT_EFFICIENCY,
  PLANET_COUNT,
  MINING_RANGE,
  ENGAGE_RANGE,
  DOCK_RANGE,
  GATE_RANGE,
  MAX_SPEED,
  MAX_ACCELERATION,
  MAX_THRUST,
  DAMPING,
  ARRIVE_RADIUS,
  AUTOPILOT_DOCK_WAIT_MS,
  AUTOPILOT_DEPOSIT_ANIMATION_MS,
  AUTOPILOT_LAUNCH_WAIT_MS,
  STATE_VERSION,
};
