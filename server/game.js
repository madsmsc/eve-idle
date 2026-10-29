'use strict';

// Pure, spatial game logic. Every action takes the current state and returns
// { state } on success or { error } on failure. No I/O here, so it is easy to
// unit test.
//
// The world is a 2D plane. Your active ship has a position; you mine the
// asteroid you are standing next to and you can only engage an enemy you are
// close to. The client only sends intents; movement, ranges, yields, rewards
// and timing are computed here.

const {
  SHIPS,
  MODULES,
  SHIP_BLUEPRINTS,
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
  AGENT_ROLES,
  AGENT_MISSIONS,
  AMBUSH_BASE_CHANCE,
  AMBUSH_MIN_CHANCE,
  AMBUSH_MAX_CHANCE,
  DRONES,
  DRONE_MAX_PER_TYPE,
  LOOT_DROP_CHANCE,
  LOOT_TIERS,
  CRAFT_DISCOUNT,
  BLUEPRINTS,
  MISSION_ORDER,
  MISSIONS,
  WORLD_SIZE,
  MINING_RANGE,
  ENGAGE_RANGE,
  DOCK_RANGE,
  GATE_RANGE,
  MAX_SPEED,
  MAX_ACCELERATION,
  ARRIVE_RADIUS,
  AUTOPILOT_DOCK_WAIT_MS,
  AUTOPILOT_DEPOSIT_ANIMATION_MS,
  AUTOPILOT_LAUNCH_WAIT_MS,
  STATE_VERSION,
} = require('./config');
const {
  clone,
  dist,
  emptyMaterials,
  emptyCargo,
  emptyStorage,
  materialDefinition,
  addStoredItems,
  availableMaterials,
  hasMaterials,
  consumeMaterials,
  cargoUsed,
  activeSystem,
  dockedStation,
  isDocked,
} = require('./game/state');
const {
  autoEfficiency,
  shipMining,
  miningRange,
  shipCombat,
  shipDps,
  shipShield,
  shipHull,
  shipCargo,
  shipMaxSpeed,
  shipMaxAcceleration,
  moduleBonus,
  moduleRequirements,
  emptyFitting,
  skillMults,
  skillCost,
  skillTrainingView,
  shipProgressionView,
  emptySkills,
  emptyDroneBay,
  droneBonus,
} = require('./game/stats');
const createMovement = require('./game/movement');
const createCombatMath = require('./game/combat');
const createMissions = require('./game/missions');
const createAutopilot = require('./game/autopilot');
const createView = require('./game/view');
const {
  deposit,
  depositAll,
  depositFiltered,
  withdraw: withdrawFromStorage,
  storeInventoryItem,
  retrieveInventoryItem,
} = require('./game/inventory');
const {
  SYSTEM_DEFS,
  generateSystems: generateWorldSystems,
  recoverWorldSeed,
} = require('./game/world');

const { moveInOrbit, moveVelocityToward, advanceNavigation } = createMovement({
  SHIPS,
  ARRIVE_RADIUS,
  MAX_SPEED,
  MAX_ACCELERATION,
  dist,
  clamp: (value, min, max) => Math.max(min, Math.min(max, value)),
  miningRange,
});
const {
  applyPool,
  enemyCombatStats,
  estimateCombatDifficulty,
  effectivePlayerDps,
  playerTtd,
  enemyTtd,
  damagePlayer,
  damageEnemy,
} = createCombatMath({
  ENEMIES,
  ENEMY_TIERS,
  MAX_SPEED,
  OVERLOAD_DPS_MULT,
  skillMults,
  shipShield,
  shipHull,
  shipDps,
  moduleBonus,
  droneBonus,
});
const {
  evaluateMission,
  checkMissionObjective,
  missionView,
  missionAction,
  spawnMissionEnemies,
  startMission,
  missionStartNeeded,
} = createMissions({
  clone,
  addStoredItems,
  emptyCargo,
  emptyFitting,
  dockedStation,
  clamp: (value, min, max) => Math.max(min, Math.min(max, value)),
  nextId,
});
const {
  nearestSafeEnemy,
  bestBeltTarget,
  recordAutomation,
  setAutopilotNavigation,
  launchForAutopilot,
  runAutopilot,
  setAutopilot,
  startAutopilotDockWait,
  completeAutopilotDeposit,
} = createAutopilot({
  MINERALS,
  ENEMIES,
  WORLD_SIZE,
  DOCK_RANGE,
  ENGAGE_RANGE,
  AUTOPILOT_DOCK_WAIT_MS,
  AUTOPILOT_LAUNCH_WAIT_MS,
  clone,
  dist,
  clamp: (value, min, max) => Math.max(min, Math.min(max, value)),
  isDocked,
  dockedStation,
  cargoUsed,
  cargoCapacity,
  activeSystem,
  estimateCombatDifficulty,
  setNavigation,
  closestBeltAsteroid,
  startCombat,
  nearestAsteroidInRange,
});
const { shipView, view } = createView({
  SHIPS,
  MINERALS,
  MODULES,
  BLUEPRINTS,
  SHIP_BLUEPRINTS,
  ACHIEVEMENTS,
  ENEMY_TIERS,
  SP_RATE_PER_SEC,
  COMPONENTS,
  SHIELD_BOOST_ITEM,
  OVERLOAD_ITEM,
  OVERLOAD_DURATION,
  OVERLOAD_DPS_MULT,
  SKILLS,
  MAX_SPEED,
  MAX_ACCELERATION,
  MINING_RANGE,
  ENGAGE_RANGE,
  GATE_RANGE,
}, {
  skillMults,
  shipMaxSpeed,
  shipMaxAcceleration,
  droneBonus,
  shipDps,
  shipShield,
  shipHull,
  emptyMaterials,
  dockedStation,
  missionView,
  agentMissionView,
  emptySkills,
  emptyDroneBay,
  emptyFitting,
  moduleBonus,
  moduleRequirements,
  shipMining,
  shipCargo,
  skillTrainingView,
  shipProgressionView,
  actionAvailability,
  cargoUsed,
  cargoCapacity,
  shipInCombat,
  miningRange,
  nearestAsteroidInRange,
  ambushChance,
  enemyCombatStats,
  estimateCombatDifficulty,
  autoEfficiency,
  dist,
  playerTtd,
  enemyTtd,
});

let _counter = 0;
function nextId() {
  _counter += 1;
  return `ship_${_counter.toString(36)}_${Date.now().toString(36)}`;
}

function hashString(value) {
  let hash = 2166136261;
  for (const character of value) {
    hash ^= character.charCodeAt(0);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}

function stationAgents(system, station) {
  return AGENT_ROLES.map((role) => {
    const seed = hashString(`${system.id}:${station.id}:${role.key}`);
    return {
      id: `${system.id}:${station.id}:${role.key}`,
      name: role.agents[seed % role.agents.length],
      role: role.key,
      roleName: role.name,
      title: role.titles[(seed >>> 8) % role.titles.length],
      stationId: station.id,
      stationName: station.name,
      systemId: system.id,
      systemName: system.name,
    };
  });
}

function agentMissionOffer(agent, completed, lastMissionKey = null) {
  const templates = AGENT_MISSIONS[agent.role];
  const index = hashString(`${agent.id}:${completed}`) % templates.length;
  let offer = templates[index];
  if (templates.length > 1 && offer.key === lastMissionKey) {
    offer = templates[(index + 1) % templates.length];
  }
  return { ...offer, rewardItems: { ...offer.rewardItems } };
}

function agentMissionAction(state, action, agentId, now = Date.now()) {
  if (action !== 'accept' && action !== 'cancel') return { error: 'Unknown agent mission action' };
  const station = dockedStation(state);
  const ship = state.ships.find((item) => item.id === state.activeShipId);
  const system = ship && state.systems[ship.systemId];
  if (!station || !system) return { error: 'Dock at an agent’s station to manage missions' };
  const agent = stationAgents(system, station).find((item) => item.id === agentId);
  if (!agent) return { error: 'Agent is not at the docked station' };
  const s = clone(state);
  if (!s.agentMissions) s.agentMissions = {};
  const record = s.agentMissions[agent.id] || { completed: 0, lastMissionKey: null, active: null };
  if (action === 'accept' && record.active) return { error: 'You already have an active mission from this agent' };
  if (action === 'cancel' && !record.active) return { error: 'No active mission from this agent' };
  if (action === 'cancel') {
    record.active = null;
    s.agentMissions[agent.id] = record;
    return { state: s };
  }
  const offer = agentMissionOffer(agent, record.completed || 0, record.lastMissionKey);
  record.active = {
    ...offer,
    agentId: agent.id,
    agentName: agent.name,
    role: agent.role,
    roleName: agent.roleName,
    stationId: station.id,
    stationName: station.name,
    systemId: system.id,
    systemName: system.name,
    progress: 0,
    status: 'active',
    startedAt: now,
  };
  s.agentMissions[agent.id] = record;
  return { state: s };
}

function advanceAgentMissions(state, type, amount, enemyType) {
  if (!state.agentMissions || amount <= 0) return;
  for (const record of Object.values(state.agentMissions)) {
    const current = record.active;
    if (!current || current.type !== type || (current.enemyType && current.enemyType !== enemyType)) continue;
    current.progress = Math.min(current.target, current.progress + amount);
    if (current.progress < current.target) continue;
    record.lastMissionKey = current.key;
    record.completed = (record.completed || 0) + 1;
    record.lastCompleted = {
      id: `${current.agentId}:${record.completed}`,
      name: current.name,
      agentName: current.agentName,
      completedAt: Date.now(),
    };
    record.active = null;
    addStoredItems(state, current.rewardItems);
    state.stats.agentMissionsCompleted = (state.stats.agentMissionsCompleted || 0) + 1;
  }
}

function agentMissionView(state) {
  const activeShip = state.ships.find((item) => item.id === state.activeShipId);
  const system = activeShip && state.systems[activeShip.systemId];
  const station = dockedStation(state);
  const active = Object.values(state.agentMissions || {}).flatMap((record) =>
    record.active ? [{ ...record.active, rewardItems: { ...record.active.rewardItems } }] : []
  );
  const completed = Object.values(state.agentMissions || {})
    .map((record) => record.lastCompleted)
    .filter(Boolean)
    .sort((left, right) => right.completedAt - left.completedAt);
  const stationRoster = station && system
    ? stationAgents(system, station).map((agent) => {
      const record = (state.agentMissions || {})[agent.id] || { completed: 0, lastMissionKey: null, active: null };
      return {
        ...agent,
        completed: record.completed || 0,
        active: record.active ? { ...record.active, rewardItems: { ...record.active.rewardItems } } : null,
        offer: record.active ? null : agentMissionOffer(agent, record.completed || 0, record.lastMissionKey),
      };
    })
    : [];
  return {
    station: station ? { id: station.id, name: station.name, systemId: system.id, systemName: system.name } : null,
    agents: stationRoster,
    active,
    completed,
  };
}
function resetIds() {
  _counter = 0;
}

function clamp(v, lo, hi) {
  return Math.max(lo, Math.min(hi, v));
}
function actionAvailability(state, materials, docked, active) {
  const craftModules = {};
  for (const [slotType, tiers] of Object.entries(BLUEPRINTS)) {
    for (const [tier, blueprint] of Object.entries(tiers)) {
      const hasBlueprint = [...(state.blueprints || []), ...((state.storage && state.storage.blueprints) || [])].some((item) =>
        item.kind === 'module' && item.type === slotType && item.tier === Number(tier)
      );
      const hasMaterials = Object.entries(blueprint.recipe).every(([key, amount]) =>
        (materials[key] || 0) >= amount
      );
      const skillError = moduleSkillError(state, slotType, Number(tier));
      craftModules[`${slotType}:${tier}`] = {
        hasBlueprint,
        hasMaterials,
        skillError,
        materialCounts: Object.fromEntries(Object.keys(blueprint.recipe).map((key) => [key, materials[key] || 0])),
        canCraft: docked && hasBlueprint && hasMaterials && !skillError,
      };
    }
  }

  const buyBlueprints = {};
  for (const key of NPC_BLUEPRINTS) {
    const cost = BLUEPRINT_COSTS[key];
    const hasMaterials = Object.entries(cost).every(([material, amount]) => (materials[material] || 0) >= amount);
    buyBlueprints[key] = {
      hasMaterials,
      canBuy: docked && hasMaterials,
      materialCounts: Object.fromEntries(Object.keys(cost).map((material) => [material, materials[material] || 0])),
    };
  }

  const exchange = {};
  for (const [family, ladder] of [['ore', ORE_EXCHANGE], ['components', COMPONENT_EXCHANGE]]) {
    for (let index = 0; index < ladder.length - 1; index++) {
      const item = ladder[index];
      const count = materials[item] || 0;
      exchange[`${family}:${item}`] = { count, canExchange: docked && count >= 3 };
    }
  }

  const fitting = {};
  const fittingReasons = {};
  const loot = {};
  const deposit = {};
  for (const key of Object.keys(materials)) {
    const amount = active && active.cargo ? active.cargo[key] || 0 : 0;
    deposit[key] = {
      canDeposit100: docked && amount >= 100,
      canDepositAll: docked && amount > 0,
    };
  }
  if (active) {
    const availableLoot = [...(state.loot || []), ...((state.storage && state.storage.loot) || [])];
    for (const [slotType, tiers] of Object.entries(active.fitting || {})) {
      for (let slotIndex = 0; slotIndex < tiers.length; slotIndex++) {
        const currentTier = tiers[slotIndex] || 0;
        for (let tier = 0; tier <= MODULES[slotType].tiers.length; tier++) {
          const hasItem = tier === 0 || tier === currentTier || availableLoot.some((item) =>
            item.slotType === slotType && item.tier === tier
          );
          const skillError = tier > 0 && tier !== currentTier
            ? moduleSkillError(state, slotType, tier)
            : null;
          const key = `${active.id}:${slotType}:${slotIndex}:${tier}`;
          const reason = !docked
            ? 'Dock at a station to change fittings.'
            : state.combat
              ? 'Modules cannot be changed during combat.'
              : skillError
                ? `${skillError}.`
                : !hasItem
                  ? `No ${MODULES[slotType].name} Tier ${tier} module in inventory.`
                  : '';
          fitting[key] = reason === '';
          fittingReasons[key] = reason;
        }
      }
    }
  }
  for (const item of [...(state.loot || []), ...((state.storage && state.storage.loot) || [])]) {
    const module = MODULES[item.slotType];
    const fitted = active && active.fitting && active.fitting[item.slotType];
    const activeSlots = active && SHIPS[active.type] ? SHIPS[active.type].slots : {};
    const skillError = module ? moduleSkillError(state, item.slotType, item.tier) : null;
    const reason = !docked
      ? 'Dock at a station to equip modules.'
      : state.combat
        ? 'Modules cannot be changed during combat.'
        : !active
          ? 'There is no active ship.'
          : !module || !activeSlots[item.slotType]
            ? `Active ship has no ${module ? module.name : 'matching'} slots.`
            : skillError
              ? `${skillError}.`
              : !fitted || !fitted.some((tier) => !tier)
                ? `All ${module.name} slots are occupied.`
                : '';
    loot[item.id] = { canEquip: reason === '', equipReason: reason };
  }
  const hasFittedModules = !!active && Object.values(active.fitting || {}).some((tiers) =>
    Array.isArray(tiers) && tiers.some((tier) => tier > 0)
  );
  const unequipAllReason = !docked
    ? 'Dock at a station to unequip modules.'
    : state.combat
      ? 'Modules cannot be changed during combat.'
      : !active
        ? 'There is no active ship.'
        : !hasFittedModules
          ? 'No fitted modules to return.'
          : '';
  return {
    craftModules,
    buyBlueprints,
    exchange,
    fitting,
    fittingReasons,
    loot,
    deposit,
    canDepositAll: docked && cargoUsed(state) > 0,
    canUnequipAll: unequipAllReason === '',
    unequipAllReason,
  };
}
// Train a skill up one level, spending skill points.
function trainSkill(state, skillKey) {
  const def = SKILLS[skillKey];
  if (!def) return { error: `Unknown skill: ${skillKey}` };
  const s = clone(state);
  if (!s.skills) s.skills = emptySkills();
  const current = s.skills[skillKey] || 0;
  if (current >= def.maxLevel) return { error: 'Skill already at max level' };
  const missing = def.requirements.find(({ skill, level }) => (s.skills[skill] || 0) < level);
  if (missing) return { error: `Requires ${SKILLS[missing.skill].name} level ${missing.level}` };
  const cost = skillCost(def, current);
  if (s.skillPoints < cost) {
    return { error: `Not enough skill points (need ${cost}, have ${Math.floor(s.skillPoints)})` };
  }
  s.skillPoints -= cost;
  s.skills[skillKey] = current + 1;
  return { state: s };
}

function applyFittingPreset(state, name) {
  const s = clone(state);
  if (!Array.isArray(s.loot)) s.loot = [];
  const ship = s.ships.find((item) => item.id === s.activeShipId);
  if (!ship) return { error: 'No active ship' };
  if (shipInCombat(s, ship.id)) return { error: 'Cannot change fittings during combat' };
  const preset = (s.fittingPresets || []).find((item) => item.name === name);
  if (!preset) return { error: 'Fitting preset not found for this ship' };
  if (preset.shipType !== ship.type) return { error: 'Fitting preset is for a different ship type' };
  const slots = SHIPS[ship.type].slots;
  for (const [slotType, count] of Object.entries(slots)) {
    const mod = MODULES[slotType];
    const next = preset.fitting[slotType];
    if (!Array.isArray(next) || next.length !== count) return { error: 'Fitting preset is invalid' };
    for (let i = 0; i < count; i++) {
      const tier = next[i];
      if (!Number.isInteger(tier) || tier < 0 || tier > mod.tiers.length) return { error: 'Fitting preset is invalid' };
    }
  }
  const requiredModules = {};
  for (const [slotType, count] of Object.entries(slots)) {
    const before = (ship.fitting && ship.fitting[slotType]) || [];
    const after = preset.fitting[slotType];
    for (let i = 0; i < count; i++) {
      const tier = after[i] || 0;
      if (tier !== (before[i] || 0) && tier > 0) {
        const key = `${slotType}:${tier}`;
        requiredModules[key] = (requiredModules[key] || 0) + 1;
      }
    }
  }
  for (const [key, count] of Object.entries(requiredModules)) {
    const [slotType, tier] = key.split(':');
    if (moduleSkillError(s, slotType, Number(tier))) return { error: moduleSkillError(s, slotType, Number(tier)) };
    const have = (s.loot || []).filter((item) => item.slotType === slotType && item.tier === Number(tier)).length;
    if (have < count) return { error: `Not enough ${MODULES[slotType].name} Tier ${tier} modules in inventory` };
  }
  for (const [slotType, count] of Object.entries(slots)) {
    const before = (ship.fitting && ship.fitting[slotType]) || [];
    const after = preset.fitting[slotType];
    for (let i = 0; i < count; i++) {
      const oldTier = before[i] || 0;
      const nextTier = after[i] || 0;
      if (nextTier !== oldTier && nextTier > 0) {
        const idx = s.loot.findIndex((item) => item.slotType === slotType && item.tier === nextTier);
        s.loot.splice(idx, 1);
      }
      if (nextTier !== oldTier && oldTier > 0) {
        s.loot.push({ id: nextId(), slotType, tier: oldTier });
      }
    }
  }
  ship.fitting = clone(preset.fitting);
  return { state: s };
}

function deleteFittingPreset(state, name) {
  const s = clone(state);
  const index = (s.fittingPresets || []).findIndex((preset) => preset.name === name);
  if (index === -1) return { error: 'Fitting preset not found' };
  s.fittingPresets.splice(index, 1);
  return { state: s };
}

function craftShip(state, type, blueprintId = null) {
  const blueprint = SHIP_BLUEPRINTS[type];
  if (!blueprint) return { error: `No ship blueprint for ${type}` };
  if (!isDocked(state)) return { error: 'Dock at a station to craft' };
  const s = clone(state);
  const active = s.ships.find((sh) => sh.id === s.activeShipId);
  const sys = activeSystem(s);
  const movementMultipliers = skillMults(s);
  if (!active || !sys) return { error: 'No active ship' };
  const skillError = shipSkillError(s, type);
  if (skillError) return { error: skillError };
  let blueprintIndex = (s.blueprints || []).findIndex((item) =>
    item.kind === 'ship' && item.type === type && (!blueprintId || item.id === blueprintId)
  );
  let blueprintInventory = s.blueprints;
  if (blueprintIndex < 0) {
    blueprintInventory = s.storage && s.storage.blueprints;
    blueprintIndex = (blueprintInventory || []).findIndex((item) =>
      item.kind === 'ship' && item.type === type && (!blueprintId || item.id === blueprintId)
    );
  }
  if (blueprintIndex < 0) return { error: `You need a ${blueprint.name} blueprint` };
  if (!hasMaterials(s, blueprint.recipe)) return { error: `Need ore and components to build ${blueprint.name}` };
  consumeMaterials(s, blueprint.recipe);
  blueprintInventory.splice(blueprintIndex, 1);
  const ship = {
    id: nextId(),
    type,
    x: sys.stations[0].x,
    y: sys.stations[0].y,
    systemId: sys.id,
    dockTargetId: dockedStation(s)?.id || null,
    dockedStationId: dockedStation(s)?.id || null,
    cargo: emptyCargo(),
    fitting: emptyFitting(type),
  };
  s.ships.push(ship);
  s.stats.shipsCrafted = (s.stats.shipsCrafted || 0) + 1;
  advanceAgentMissions(s, 'craft', 1);
  return { state: s };
}
function buyBlueprint(state, kind, type, tier = null) {
  if (kind !== 'module' && kind !== 'ship') return { error: `Unknown blueprint type: ${kind}` };
  const key = kind === 'module' ? `module:${type}:${tier}` : `ship:${type}`;
  const recipe = BLUEPRINT_COSTS[key];
  if (!recipe) return { error: `Unknown ${kind} blueprint: ${type}` };
  if (!NPC_BLUEPRINTS.includes(key)) {
    return { error: 'This blueprint is not sold by NPCs; higher-tier blueprints are found as enemy loot' };
  }
  if (kind === 'module' && (!Number.isInteger(tier) || !MODULES[type].tiers[tier - 1])) {
    return { error: `Invalid module tier: ${tier}` };
  }
  if (!isDocked(state)) return { error: 'Dock at any station to trade blueprints' };
  const s = clone(state);
  if (!consumeMaterials(s, recipe)) return { error: 'Not enough ore and components for this blueprint' };
  if (!Array.isArray(s.blueprints)) s.blueprints = [];
  s.blueprints.push({ id: nextId(), kind, type, tier });
  return { state: s };
}

function exchangeItems(state, family, item, amount) {
  const ladder = family === 'ore' ? ORE_EXCHANGE : family === 'components' ? COMPONENT_EXCHANGE : null;
  if (!ladder) return { error: `Unknown exchange family: ${family}` };
  const index = ladder.indexOf(item);
  if (index < 0 || index === ladder.length - 1) return { error: 'That item cannot be exchanged upward' };
  const count = Number(amount);
  if (!Number.isInteger(count) || count < 3 || count % 3 !== 0) {
    return { error: 'Exchange quantity must be a positive multiple of 3' };
  }
  if (!isDocked(state)) return { error: 'Dock at any station to exchange items' };
  const s = clone(state);
  if (!consumeMaterials(s, { [item]: count })) return { error: `Not enough ${materialDefinition(item).name}` };
  addStoredItems(s, { [ladder[index + 1]]: count / 3 });
  return { state: s };
}

function moduleSkillError(state, slotType, tier) {
  for (const { skill, level } of moduleRequirements(slotType, tier)) {
    const current = (state.skills && state.skills[skill]) || 0;
    if (current < level) return `Requires ${SKILLS[skill].name} level ${level}`;
  }
  return null;
}

function shipSkillError(state, type) {
  const progression = SHIP_PROGRESSION.flatMap((tier) => tier.ships).find((ship) => ship.type === type);
  if (!progression) return null;
  for (const requirement of progression.skills) {
    const current = (state.skills && state.skills[requirement.skill]) || 0;
    if (current < requirement.level) {
      return `Requires ${SKILLS[requirement.skill].name} level ${requirement.level}`;
    }
  }
  return null;
}

// ---- loot drops ----
// Equip a looted module (see resolveCombat for how enemies drop them) into the
// first empty slot of its type on the active ship, free of charge.
function equipLoot(state, lootId) {
  if (!isDocked(state)) return { error: 'Dock at a station to equip modules' };
  if (state.combat) return { error: 'Modules cannot be changed during combat' };
  const s = clone(state);
  if (!Array.isArray(s.loot)) s.loot = [];
  const cargoIndex = s.loot.findIndex((l) => l && l.id === lootId);
  const storageLoot = s.storage && Array.isArray(s.storage.loot) ? s.storage.loot : [];
  const storageIndex = cargoIndex < 0 ? storageLoot.findIndex((item) => item && item.id === lootId) : -1;
  if (cargoIndex < 0 && storageIndex < 0) return { error: 'Loot not found' };
  const loot = cargoIndex < 0 ? storageLoot[storageIndex] : s.loot[cargoIndex];
  const mod = MODULES[loot.slotType];
  if (!mod) return { error: `Unknown loot module type: ${loot.slotType}` };
  const ship = s.ships.find((sh) => sh.id === s.activeShipId);
  if (!ship) return { error: 'No active ship' };
  const slots = SHIPS[ship.type].slots;
  if (!slots[loot.slotType] || slots[loot.slotType] <= 0) {
    return { error: `Active ship has no ${mod.name} slots` };
  }
  const skillError = moduleSkillError(s, loot.slotType, loot.tier);
  if (skillError) return { error: skillError };
  if (!ship.fitting) ship.fitting = emptyFitting(ship.type);
  if (!Array.isArray(s.loot)) s.loot = [];
  const arr = ship.fitting[loot.slotType];
  const free = arr.findIndex((t) => !t);
  if (free === -1) {
    return { error: `All ${mod.name} slots are occupied` };
  }
  arr[free] = loot.tier;
  if (cargoIndex < 0) storageLoot.splice(storageIndex, 1);
  else s.loot.splice(cargoIndex, 1);
  return { state: s };
}

function refineLoot(state, lootId) {
  if (!isDocked(state)) return { error: 'Dock at a station to refine modules' };
  const s = clone(state);
  const cargoIndex = (s.loot || []).findIndex((item) => item && item.id === lootId);
  const storageLoot = s.storage && Array.isArray(s.storage.loot) ? s.storage.loot : [];
  const storageIndex = cargoIndex < 0 ? storageLoot.findIndex((item) => item && item.id === lootId) : -1;
  if (cargoIndex < 0 && storageIndex < 0) return { error: 'Loot not found' };
  const loot = cargoIndex < 0 ? storageLoot[storageIndex] : s.loot[cargoIndex];
  if (!MODULES[loot.slotType] || !BLUEPRINTS[loot.slotType] || !BLUEPRINTS[loot.slotType][loot.tier]) {
    return { error: 'Invalid loot module' };
  }
  const component = COMPONENT_EXCHANGE[loot.tier - 1];
  if (!component) return { error: 'Invalid module tier' };
  addStoredItems(s, { [component]: 1 });
  if (cargoIndex < 0) storageLoot.splice(storageIndex, 1);
  else s.loot.splice(cargoIndex, 1);
  s.stats.modulesSalvaged = (s.stats.modulesSalvaged || 0) + 1;
  return { state: s };
}

function craftModule(state, slotType, tier, blueprintId = null) {
  const mod = MODULES[slotType];
  if (!mod) return { error: `Unknown module type: ${slotType}` };
  if (!mod.tiers[tier - 1]) return { error: `Invalid tier: ${tier}` };
  if (!isDocked(state)) return { error: 'Dock at a station to craft' };
  const s = clone(state);
  const skillError = moduleSkillError(s, slotType, tier);
  if (skillError) return { error: skillError };
  const bp = BLUEPRINTS[slotType][tier];
  let blueprintIndex = (s.blueprints || []).findIndex((item) =>
    item.kind === 'module' && item.type === slotType && item.tier === tier && (!blueprintId || item.id === blueprintId)
  );
  let blueprintInventory = s.blueprints;
  if (blueprintIndex < 0) {
    blueprintInventory = s.storage && s.storage.blueprints;
    blueprintIndex = (blueprintInventory || []).findIndex((item) =>
      item.kind === 'module' && item.type === slotType && item.tier === tier && (!blueprintId || item.id === blueprintId)
    );
  }
  if (blueprintIndex < 0) return { error: `You need a ${bp.name} blueprint` };
  if (!hasMaterials(s, bp.recipe)) return { error: `Need ore and components to craft ${bp.name}` };
  consumeMaterials(s, bp.recipe);
  blueprintInventory.splice(blueprintIndex, 1);
  if (!Array.isArray(s.loot)) s.loot = [];
  s.loot.push({ id: nextId(), slotType, tier });
  s.stats.modulesCrafted = (s.stats.modulesCrafted || 0) + 1;
  advanceAgentMissions(s, 'craft', 1);
  if (s.mode === 'story' && s.mission && s.mission.active) {
    const mdef = MISSIONS[s.mission.active];
    if (mdef && mdef.objective.type === 'craft') {
      if (!s.mission.flags.crafted) s.mission.flags.crafted = {};
      const key = `${slotType}:${tier}`;
      s.mission.flags.crafted[key] = (s.mission.flags.crafted[key] || 0) + 1;
    }
    checkMissionObjective(s);
  }
  return { state: s };
}

function shipInCombat(state, shipId) {
  return !!(state.combat && state.combat.shipId === shipId);
}
function cargoCapacity(state) {
  const active = state.ships.find((sh) => sh.id === state.activeShipId);
  return active ? shipCargo(active, skillMults(state), state.skills) : 0;
}

// ---- real-time combat simulation ----
// A fight is a deterministic damage race: both sides deal constant DPS and the
// loser is whoever's hull hits zero first. The live shield/hull pools are kept
// as state and drained each tick, so in-fight actions (shield boost, overload,
// disengage) can change the pools/DPS mid-fight and the outcome follows. The
// winner is decided by each side's time-to-death from the *current* pools, so
// the server can tick by any step size (a 400ms sync or an offline gap) and
// always land on the same result.

function rollBlueprintDrop(state, enemy, rng) {
  const chance = BLUEPRINT_DROP_CHANCE[enemy.type] || 0;
  const pool = BLUEPRINT_DROP_POOLS[enemy.tier];
  if (!pool || chance <= 0 || rng() >= chance) return null;

  const choices = [
    ...pool.moduleTiers.map((tier) => ({ kind: 'module', tier })),
    ...pool.ships.map((type) => ({ kind: 'ship', type })),
  ];
  const choice = choices[Math.min(choices.length - 1, Math.floor(rng() * choices.length))];
  const blueprint = choice.kind === 'module'
    ? {
        id: nextId(),
        kind: 'module',
        type: Object.keys(MODULES)[Math.min(Object.keys(MODULES).length - 1, Math.floor(rng() * Object.keys(MODULES).length))],
        tier: choice.tier,
      }
    : { id: nextId(), kind: 'ship', type: choice.type, tier: null };
  if (!Array.isArray(state.blueprints)) state.blueprints = [];
  state.blueprints.push(blueprint);
  return blueprint;
}

// Roll an enemy (type + tier) from the spawn table allowed at `security`.
function rollEnemy(security, rng) {
  const table = spawnTable(security);
  if (!table.length) return { type: 'pirate', tier: 'novice' };
  let r = rng() * table.reduce((a, b) => a + b.weight, 0);
  for (const row of table) {
    r -= row.weight;
    if (r < 0) return { type: row.type, tier: row.tier };
  }
  const last = table[table.length - 1];
  return { type: last.type, tier: last.tier };
}

function generateSystems(seed) {
  return generateWorldSystems(seed, rollEnemy);
}

// Saves from before the star map only hold the first systems: add any newer
// systems and the gates that connect them to existing ones.
function addMissingSystems(state) {
  if (SYSTEM_DEFS.every((def) => state.systems[def.id])) return;
  const home = state.systems.sys_0;
  const seed = home && Number.isInteger(home.seed) ? recoverWorldSeed(home.seed) : 1;
  const regenerated = generateSystems(seed);
  for (const def of SYSTEM_DEFS) {
    const system = state.systems[def.id];
    if (!system) {
      state.systems[def.id] = regenerated[def.id];
      continue;
    }
    system.gates = system.gates || [];
    for (const gate of regenerated[def.id].gates) {
      if (!system.gates.some((item) => item.id === gate.id)) system.gates.push(gate);
    }
  }
}

function migrateWorldLayout(state) {
  if (!isValidState(state)) return state;
  const legacyDrones = state.drones || emptyDroneBay();
  for (const ship of state.ships) {
    const fitting = emptyFitting(ship.type);
    for (const [slotType, tiers] of Object.entries(ship.fitting || {})) {
      if (fitting[slotType]) {
        for (let i = 0; i < fitting[slotType].length; i++) {
          fitting[slotType][i] = Array.isArray(tiers) && Number.isInteger(tiers[i]) ? tiers[i] : 0;
        }
      }
    }
    ship.fitting = fitting;
  }
  const active = state.ships.find((ship) => ship.id === state.activeShipId);
  if (active) {
    for (const [droneType, slotType] of [['mining', 'miningDrone'], ['combat', 'combatDrone']]) {
      const amount = (Array.isArray(legacyDrones[droneType]) ? legacyDrones[droneType] : []).reduce((sum, tier) => {
        const level = typeof tier === 'number' ? tier : tier.tier;
        return sum + (DRONES[droneType].tiers[level - 1]?.bonus || 0);
      }, 0);
      if (amount > 0 && !active.fitting[slotType].some((tier) => tier > 0)) {
        const tiers = MODULES[slotType].tiers;
        const best = tiers.reduce((closest, item, index) =>
          Math.abs(item.bonus - amount) < Math.abs(tiers[closest].bonus - amount) ? index : closest, 0);
        active.fitting[slotType][0] = best + 1;
      }
    }
  }
  state.drones = emptyDroneBay();
  addMissingSystems(state);
  const systems = Object.values(state.systems);
  const currentLayout = systems.every((sys) =>
    sys.outposts && sys.outposts.length === 2 &&
    sys.belts && sys.belts.length === 2 &&
    sys.enemies.filter((enemy) => !enemy.missionTag).every((enemy) => enemy.outpostId)
  );
  if (currentLayout) return state;

  const homeSystem = state.systems.sys_0;
  const seed = homeSystem && Number.isInteger(homeSystem.seed)
    ? recoverWorldSeed(homeSystem.seed)
    : 1;
  const regenerated = generateSystems(seed);
  for (const def of SYSTEM_DEFS) {
    const oldSystem = state.systems[def.id];
    const nextSystem = regenerated[def.id];
    if (!oldSystem) continue;

    const oldEnemies = new Map((oldSystem.enemies || []).map((enemy) => [enemy.id, enemy]));
    for (const enemy of nextSystem.enemies) {
      if (oldEnemies.has(enemy.id)) enemy.alive = oldEnemies.get(enemy.id).alive;
    }
    const outpost = nextSystem.outposts[0];
    for (const [index, enemy] of (oldSystem.enemies || []).filter((item) => item.missionTag).entries()) {
      const angle = (index / Math.max(1, oldSystem.enemies.length)) * Math.PI * 2;
      enemy.x = clamp(outpost.x + Math.cos(angle) * 500, 60, nextSystem.width - 60);
      enemy.y = clamp(outpost.y + Math.sin(angle) * 500, 60, nextSystem.height - 60);
      enemy.outpostId = outpost.id;
      nextSystem.enemies.push(enemy);
    }
    const combatShip = state.combat && state.ships.find((ship) => ship.id === state.combat.shipId);
    if (combatShip && combatShip.systemId === def.id) {
      const target = (oldSystem.enemies || []).find((enemy) => enemy.id === state.combat.enemyId);
      if (target && !nextSystem.enemies.some((enemy) => enemy.id === target.id)) {
        target.x = clamp(outpost.x + 500, 60, nextSystem.width - 60);
        target.y = outpost.y;
        target.outpostId = outpost.id;
        nextSystem.enemies.push(target);
      }
    }

    const depleted = {};
    for (const asteroid of oldSystem.asteroids || []) {
      const lost = Math.max(0, (asteroid.maxAmount || asteroid.amount) - asteroid.amount);
      depleted[asteroid.mineral] = (depleted[asteroid.mineral] || 0) + lost;
    }
    for (const asteroid of nextSystem.asteroids) {
      const remainingDepletion = depleted[asteroid.mineral] || 0;
      const lost = Math.min(asteroid.amount, remainingDepletion);
      asteroid.amount -= lost;
      depleted[asteroid.mineral] -= lost;
    }

    Object.assign(oldSystem, nextSystem, {
      security: oldSystem.security,
    });
  }
  for (const ship of state.ships) {
    if (!ship.dockedStationId) continue;
    const station = state.systems[ship.systemId].stations.find((item) => item.id === ship.dockedStationId);
    if (station) {
      ship.x = station.x;
      ship.y = station.y;
    }
  }
  return state;
}

function createInitialState(now = Date.now(), seed = (Date.now() % 1000000) + 1, mode = 'demo') {
  const systems = generateSystems(seed);
  const homeSystem = systems[SYSTEM_DEFS[0].id];
  const rifter = {
    id: nextId(),
    type: 'rifter',
    x: homeSystem.stations[0].x,
    y: homeSystem.stations[0].y,
    systemId: homeSystem.id,
    dockTargetId: homeSystem.stations[0].id,
    dockedStationId: homeSystem.stations[0].id,
    navigation: null,
    vx: 0,
    vy: 0,
    heading: 0,
    cargo: emptyCargo(),
    fitting: emptyFitting('rifter'),
  };
  const st = {
    version: STATE_VERSION,
    mode: MODES.includes(mode) ? mode : 'demo',
    mission: { active: mode === 'story' ? 'm1' : null, ready: false, offered: null, flags: {}, completed: [] },
    agentMissions: {},
    autoPilotMode: null,
    manualMining: false,
    manualMiningTargetId: null,
    automationLog: [],
    systems,
    ships: [rifter],
    activeShipId: rifter.id,
    lastTick: now,
    combat: null,
    combatLog: [],
    skillPoints: 0,
    skills: emptySkills(),
    drones: emptyDroneBay(),
    loot: [],
    blueprints: [],
    storage: emptyStorage(),
    fittingPresets: [],
    stats: {
      totalMineralsMined: 0,
      cargoLost: 0,
      combatsWon: 0,
      combatsLost: 0,
      shipsLost: 0,
      shipsBought: 0,
      totalSpEarned: 0,
      modulesCrafted: 0,
      modulesSalvaged: 0,
      shipsCrafted: 0,
      missionsCompleted: 0,
      agentMissionsCompleted: 0,
      distanceTraveled: 0,
      beltsCompleted: 0,
      oreMinedByType: {},
    },
  };
  st.storage.items.iron = 18;
  st.storage.items.scrap = 12;
  if (mode === 'story') startMission(st, 'm1');
  return st;
}

function migrateEconomy(state) {
  if (!state || state.version !== 15 || !Array.isArray(state.ships)) return state;
  const migrated = clone(state);
  migrated.version = STATE_VERSION;
  migrated.stats = migrated.stats || {};
  migrated.storage = migrated.storage || emptyStorage();
  const legacyStorage = migrated.storage.items || migrated.storage.minerals || {};
  migrated.storage.items = { ...emptyMaterials(), ...legacyStorage };
  migrated.storage.loot = Array.isArray(migrated.storage.loot) ? migrated.storage.loot : [];
  migrated.storage.blueprints = Array.isArray(migrated.storage.blueprints) ? migrated.storage.blueprints : [];
  const legacyBalance = Math.max(0, Number(migrated.isk) || 0);
  migrated.storage.items.iron += Math.floor(legacyBalance / 100);
  migrated.storage.items.scrap += Math.floor(legacyBalance / 250);
  for (const ship of migrated.ships) {
    ship.cargo = { ...emptyCargo(), ...(ship.cargo || {}) };
  }
  migrated.blueprints = Array.isArray(migrated.blueprints) ? migrated.blueprints : [];
  delete migrated.storage.minerals;
  delete migrated.isk;
  delete migrated.standing;
  delete migrated.stats.totalIskEarned;
  migrated.stats.modulesSalvaged = migrated.stats.modulesSalvaged || 0;
  if (migrated.mode === 'story' && migrated.mission && migrated.mission.active === 'm7') {
    const grant = MISSIONS.m7.grant;
    addStoredItems(migrated, grant.items);
    for (const blueprint of grant.blueprints || []) {
      const alreadyOwned = migrated.blueprints.some((item) =>
        item.kind === blueprint.kind && item.type === blueprint.type && item.tier === blueprint.tier
      );
      if (!alreadyOwned) migrated.blueprints.push({ id: nextId(), ...blueprint });
    }
  }
  return migrated;
}

function migrateAgentMissionState(state) {
  if (!state || !Array.isArray(state.ships)) return state;
  if (state.agentMissions && typeof state.agentMissions === 'object') return state;
  const migrated = clone(state);
  migrated.agentMissions = {};
  const legacy = migrated.agentMission;
  if (legacy && legacy.key) {
    const keyMap = {
      'pirate-hunt': ['pirate-patrol', 'security'],
      'ore-haul': ['ore-survey', 'mining'],
      'field-survey': ['field-sample', 'mining'],
    };
    const [missionKey, role] = keyMap[legacy.key] || [];
    if (missionKey && role) {
      const activeShip = migrated.ships.find((ship) => ship.id === migrated.activeShipId);
      const system = activeShip && migrated.systems[activeShip.systemId];
      const station = system && (dockedStation(migrated) || system.stations[0]);
      if (system && station) {
        const agent = stationAgents(system, station).find((item) => item.role === role);
        const record = {
          completed: legacy.status === 'complete' ? 1 : 0,
          lastMissionKey: legacy.status === 'complete' ? missionKey : null,
          active: null,
        };
        if (legacy.status === 'active') {
          const definition = AGENT_MISSIONS[role].find((mission) => mission.key === missionKey);
          record.active = {
            ...definition,
            agentId: agent.id,
            agentName: agent.name,
            role: agent.role,
            roleName: agent.roleName,
            stationId: station.id,
            stationName: station.name,
            systemId: system.id,
            systemName: system.name,
            progress: legacy.progress || 0,
            status: 'active',
            startedAt: legacy.startedAt || migrated.lastTick,
          };
        }
        migrated.agentMissions[agent.id] = record;
      }
    }
  }
  delete migrated.agentMission;
  delete migrated.agentMissionCompletedAt;
  return migrated;
}

function migrateTerminology(state) {
  if (!state || !Array.isArray(state.ships)) return state;
  if (!Number.isInteger(state.version) || state.version < STATE_VERSION - 2 || state.version > STATE_VERSION) return state;
  const legacyModes = { hunt: 'fight', mine_hunt: 'mine_fight' };
  const hasLegacyMode = Object.prototype.hasOwnProperty.call(legacyModes, state.autoPilotMode);
  const hasLegacyMission = Object.values(state.agentMissions || {}).some((record) =>
    record && (record.lastMissionKey === 'pirate-hunt' ||
      record.active && record.active.key === 'pirate-hunt')
  );
  if (state.version === STATE_VERSION && !hasLegacyMode && !hasLegacyMission) return state;
  const migrated = clone(state);
  if (hasLegacyMode) migrated.autoPilotMode = legacyModes[state.autoPilotMode];
  for (const record of Object.values(migrated.agentMissions || {})) {
    if (!record) continue;
    if (record.lastMissionKey === 'pirate-hunt') record.lastMissionKey = 'pirate-patrol';
    if (record.active && record.active.key === 'pirate-hunt') {
      record.active.key = 'pirate-patrol';
      if (record.active.name === 'Pirate Hunt') record.active.name = 'Pirate Patrol';
      if (typeof record.active.objective === 'string') {
        record.active.objective = record.active.objective.replace(/\bRats?\b/gi, 'Enemies');
      }
    }
  }
  for (const event of migrated.automationLog || []) {
    if (typeof event.message !== 'string') continue;
    event.message = event.message
      .replace(/\bmine_hunt\b/g, 'mine_fight')
      .replace(/\bhunt\b/gi, 'fight')
      .replace(/\brats?\b/gi, 'enemies');
  }
  migrated.version = STATE_VERSION;
  return migrated;
}

function migrateSkillTree(state) {
  if (!state || !Array.isArray(state.ships) ||
      (state.version !== STATE_VERSION - 1 && state.version !== STATE_VERSION)) return state;
  const migrated = clone(state);
  migrated.skills = { ...emptySkills(), ...(migrated.skills || {}) };
  if (typeof migrated.manualMining !== 'boolean') migrated.manualMining = false;
  if (!migrated.manualMining || typeof migrated.manualMiningTargetId !== 'string') {
    migrated.manualMining = false;
    migrated.manualMiningTargetId = null;
  }
  const active = migrated.ships.find((ship) => ship.id === migrated.activeShipId);
  if (active && shipSkillError(migrated, active.type)) {
    const availableShip = migrated.ships.find((ship) => !shipSkillError(migrated, ship.type));
    if (availableShip) {
      migrated.activeShipId = availableShip.id;
    } else {
      const activeShipSystem = migrated.systems && migrated.systems[active.systemId];
      const system = activeShipSystem || migrated.systems && Object.values(migrated.systems)[0];
      const station = system && system.stations && system.stations[0];
      if (system && station) {
        const loaner = {
          id: nextId(),
          type: 'rifter',
          x: station.x,
          y: station.y,
          systemId: system.id,
          dockTargetId: station.id,
          dockedStationId: station.id,
          cargo: emptyCargo(),
          fitting: emptyFitting('rifter'),
        };
        migrated.ships.push(loaner);
        migrated.activeShipId = loaner.id;
      }
    }
    migrated.manualMining = false;
    migrated.manualMiningTargetId = null;
  }
  migrated.version = STATE_VERSION;
  return migrated;
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

function nearestAsteroidInRange(state, ship) {
  const sys = activeSystem(state);
  if (!sys) return null;
  const range = miningRange(ship, skillMults(state), state.skills);
  let best = null;
  let bd = Infinity;
  for (const a of sys.asteroids) {
    if (a.amount <= 0) continue;
    const d = dist(a.x, a.y, ship.x, ship.y);
    if (d <= range && d < bd) {
      bd = d;
      best = a;
    }
  }
  return best;
}

function incomingDamageProfile(ship, enemy, skills) {
  const relativeSpeed = Math.hypot(
    (ship.vx || 0) - (enemy.vx || 0),
    (ship.vy || 0) - (enemy.vy || 0),
  );
  const speedMitigation = clamp(relativeSpeed / (MAX_SPEED / 12) * 0.5, 0, 0.5);
  const skillMitigation = clamp(
    ((skills && skills.evasiveManeuver) || 0) * 0.04 +
    ((skills && skills.damageControl) || 0) * 0.025,
    0,
    0.3,
  );
  return {
    relativeSpeed,
    speedMitigation,
    incomingDamageMultiplier: Math.max(0.2, 1 - speedMitigation - skillMitigation),
  };
}

function mineActive(s, active, seconds, targetId = null) {
  const sys = activeSystem(s);
  if (!sys) return;
  const mults = skillMults(s);
  // Mining stops once the active ship's cargo hold is full.
  const room = shipCargo(active, mults, s.skills) - cargoUsed(s);
  if (room <= 0) return;
  const budget = Math.min(
    shipMining(active, mults, droneBonus(s, 'mining'), s.skills) * autoEfficiency(s) * seconds,
    room,
  );
  const range = miningRange(active, mults, s.skills);
  const inRange = [];
  for (const a of sys.asteroids) {
    if (targetId && a.id !== targetId) continue;
    if (a.amount <= 0) continue;
    const d = dist(a.x, a.y, active.x, active.y);
    if (d <= range) inRange.push({ a, d });
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
    s.stats.oreMinedByType = s.stats.oreMinedByType || {};
    s.stats.oreMinedByType[a.mineral] = (s.stats.oreMinedByType[a.mineral] || 0) + take;
  }
}

function mine(state, now = Date.now()) {
  if (state.manualMining) {
    const stopped = clone(state);
    stopped.manualMining = false;
    stopped.manualMiningTargetId = null;
    return { state: stopped };
  }
  if (isDocked(state)) return { error: 'Launch from a station before mining' };
  if (state.combat) return { error: 'Cannot mine while in combat' };
  if (state.autoPilotMode) return { error: 'Stop auto-pilot before manual mining' };
  const active = state.ships.find((ship) => ship.id === state.activeShipId);
  if (!active) return { error: 'No active ship' };
  if (cargoUsed(state) >= cargoCapacity(state)) return { error: 'Cargo hold is full' };
  const target = nearestAsteroidInRange(state, active);
  if (!target) return { error: 'No asteroid in mining range' };
  const next = clone(state);
  next.manualMining = true;
  next.manualMiningTargetId = target.id;
  return { state: next };
}

function setNavigation(ship, x, y, targetId = null, dockTargetId = null, orbitTargetId = null) {
  ship.navigation = { x, y, targetId, dockTargetId, orbitTargetId };
  ship.dockTargetId = dockTargetId;
  ship.dockedStationId = null;
}

function recordMiningProgress(state, beforeMined, beforeOreBelts, now) {
  const mined = (state.stats.totalMineralsMined || 0) - beforeMined;
  const sys = activeSystem(state);
  const afterOreBelts = new Set(sys.asteroids.filter((asteroid) => asteroid.amount > 0).map((asteroid) => asteroid.beltId));
  for (const beltId of beforeOreBelts) {
    if (!afterOreBelts.has(beltId)) state.stats.beltsCompleted = (state.stats.beltsCompleted || 0) + 1;
  }
  advanceAgentMissions(state, 'mine', mined);
  const wholeUnits = Math.floor(mined);
  if (state.autoPilotMode && wholeUnits > 0) recordAutomation(state, `Mined ${wholeUnits} ore`, now);
  if (state.mode === 'story' && state.mission && state.mission.active) {
    const definition = MISSIONS[state.mission.active];
    if (definition && definition.objective.type === 'mine') {
      state.mission.flags.mined = (state.mission.flags.mined || 0) + mined;
    }
  }
}

// Advance the simulation to `now`. Ship movement and automation are simulated
// from server-held navigation intent; clients never submit authoritative positions.
function tick(state, now = Date.now(), pos = null, rng = Math.random) {
  const s = clone(state);
  let elapsed = (now - s.lastTick) / 1000;
  if (!Number.isFinite(elapsed) || elapsed < 0) elapsed = 0;
  const seconds = Math.min(elapsed, MAX_OFFLINE_SECONDS);

  const active = s.ships.find((sh) => sh.id === s.activeShipId);
  const sys = activeSystem(s);
  const movementMultipliers = skillMults(s);
  if (active && sys && !shipInCombat(s, active.id) && pos && Number.isFinite(pos.x) && Number.isFinite(pos.y)) {
    // Light sanity clamp so a client cannot teleport across the map to a rich
    // field. Generous enough that normal movement is never affected.
    const maxJump = shipMaxSpeed(active, movementMultipliers) * autoEfficiency(s) * (seconds + 1) * 3 + 200;
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
    const movedDist = Math.hypot(nx - active.x, ny - active.y);
    active.x = nx;
    active.y = ny;
    s.stats.distanceTraveled = (s.stats.distanceTraveled || 0) + movedDist;
    const targetStation = sys.stations.find((st) => st.id === pos.dockTargetId);
    active.dockTargetId = targetStation ? targetStation.id : null;
    active.dockedStationId = targetStation && dist(active.x, active.y, targetStation.x, targetStation.y) <= DOCK_RANGE
      ? targetStation.id
      : null;
    if (active.dockedStationId) {
      s.manualMining = false;
      s.manualMiningTargetId = null;
    }
  }

  if (active && sys && !pos && seconds > 0 &&
      (active.navigation || s.autoPilotMode || s.manualMining || s.combat ||
       Math.hypot(active.vx || 0, active.vy || 0) > 0.1)) {
    const beforeMined = s.stats.totalMineralsMined || 0;
    const beforeOreBelts = new Set(sys.asteroids.filter((asteroid) => asteroid.amount > 0).map((asteroid) => asteroid.beltId));
    let remaining = seconds;
    const movementStep = seconds <= 10 ? 0.05 : 0.5;
    while (remaining > 0) {
      const step = Math.min(0.5, remaining);
      if (!s.combat) runAutopilot(s, active, sys, now - remaining * 1000);
      let movementRemaining = step;
      while (movementRemaining > 0) {
        const substep = Math.min(movementStep, movementRemaining);
        advanceNavigation(
          active, sys, substep, s.combat, autoEfficiency(s), movementMultipliers, s.skills,
          s.manualMining ? s.manualMiningTargetId : null
        );
        movementRemaining -= substep;
      }
      if (s.manualMining) {
        const target = sys.asteroids.find((asteroid) => asteroid.id === s.manualMiningTargetId);
        if (s.combat || isDocked(s) || !target || target.amount <= 0 ||
            cargoUsed(s) >= cargoCapacity(s)) {
          s.manualMining = false;
          s.manualMiningTargetId = null;
        } else {
          mineActive(s, active, step, target.id);
          if (target.amount <= 0 || cargoUsed(s) >= cargoCapacity(s)) {
            s.manualMining = false;
            s.manualMiningTargetId = null;
          }
        }
      }
      if (!shipInCombat(s, active.id) && ['mine', 'mine_fight'].includes(s.autoPilotMode)) {
        mineActive(s, active, step);
      }
      remaining -= step;
    }
    recordMiningProgress(s, beforeMined, beforeOreBelts, now);
    s.stats.distanceTraveled = (s.stats.distanceTraveled || 0) +
      (active.distanceTravelled || 0);
    active.distanceTravelled = 0;
  }
  if (s.combat && active && sys) {
    const enemy = sys.enemies.find((item) => item.id === s.combat.enemyId);
    if (enemy) Object.assign(s.combat, incomingDamageProfile(active, enemy, s.skills));
  }
  // Skill points accrue over time (idle progression), including offline gaps.
  if (elapsed > 0) {
    const sp = SP_RATE_PER_SEC * elapsed;
    s.skillPoints = (s.skillPoints || 0) + sp;
    s.stats.totalSpEarned = (s.stats.totalSpEarned || 0) + sp;
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
      damagePlayer(c, c.enemyDps * enemyFire * (c.incomingDamageMultiplier || 1));
      damageEnemy(c, pdps * seconds);
    }
  }
  checkMissionObjective(s);
  return s;
}

function resolveCombat(s, now, won, rng = Math.random) {
  const c = s.combat;
  const ship = s.ships.find((sh) => sh.id === c.shipId);
  const sys = ship && s.systems ? s.systems[ship.systemId] : null;
  const enemy = sys ? sys.enemies.find((e) => e.id === c.enemyId) : null;
  const shipName = ship ? SHIPS[ship.type].name : 'Unknown';
  const enemyName = enemy ? (ENEMIES[enemy.type] ? ENEMIES[enemy.type].name : enemy.type) : 'Unknown';
  let shipLost = false;
  let cargoLost = 0;
  let lootDropped = null;
  let blueprintDropped = null;
  let scrapDropped = 0;

  // Snapshot the hold before it's lost, so the killmail can itemize the loot.
  const cargoSnapshot = ship ? { ...ship.cargo } : null;

  if (won) {
    const tier = ENEMY_TIERS[enemy && enemy.tier] || ENEMY_TIERS.standard;
    const dropAmount = 1 + Math.min(2, Math.floor(tier.multiplier));
    const cargoRoom = ship ? Math.max(0, cargoCapacity(s) - cargoUsed(s)) : 0;
    scrapDropped = Math.min(dropAmount, Math.floor(cargoRoom));
    if (ship && scrapDropped > 0) ship.cargo.scrap = (ship.cargo.scrap || 0) + scrapDropped;
    if (enemy) enemy.alive = false;
    if (enemy) advanceAgentMissions(s, 'kill', 1, enemy.type);
    s.stats.combatsWon += 1;
    // Loot: an enemy can drop a module into your loot inventory. Stronger enemies
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
    if (enemy) blueprintDropped = rollBlueprintDrop(s, enemy, rng);
  } else {
    shipLost = true;
    // The ship is destroyed: its cargo hold and carried materials are lost.
    cargoLost = ship ? Object.values(ship.cargo).reduce((a, b) => a + b, 0) : 0;
    s.stats.combatsLost += 1;
    s.stats.shipsLost += 1;
    s.stats.cargoLost = (s.stats.cargoLost || 0) + cargoLost;
    s.ships = s.ships.filter((sh) => sh.id !== ship.id);
    if (s.activeShipId === ship.id) s.activeShipId = s.ships.length ? s.ships[0].id : null;
    // Respawn: if you lost your last ship, your pod makes it home to the local
    // station (docked for the scripted Last Stand — the next mission's replacement
    // frigate is handed out at the hangar) so the game can't soft-lock. You still
    // paid the price — the destroyed ship and its cargo are gone.
    if (s.ships.length === 0 && sys) {
      const home = sys.stations[0];
      const pod = {
        id: nextId(),
        type: 'rifter',
        x: home.x,
        y: home.y,
        systemId: sys.id,
        dockTargetId: home.id,
        dockedStationId: home.id,
        cargo: emptyCargo(),
        fitting: emptyFitting('rifter'),
      };
      s.ships.push(pod);
      s.activeShipId = pod.id;
    }
  }

  s.combatLog.unshift({
    at: now,
    enemy: enemyName,
    enemyType: enemy ? enemy.type : null,
    ship: shipName,
    shipType: ship ? ship.type : null,
    system: sys ? sys.name : null,
    won,
    shipLost,
    cargoLost,
    cargo: shipLost ? cargoSnapshot : null,
    scrap: scrapDropped,
    loot: lootDropped,
    blueprint: blueprintDropped,
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

function setActive(state, shipId) {
  const s = clone(state);
  const ship = s.ships.find((sh) => sh.id === shipId);
  if (!ship) return { error: 'Ship not found' };
  const skillError = shipSkillError(s, ship.type);
  if (skillError) return { error: skillError };
  const station = dockedStation(s);
  ship.dockTargetId = station ? station.id : null;
  ship.dockedStationId = station ? station.id : null;
  s.activeShipId = shipId;
  s.manualMining = false;
  s.manualMiningTargetId = null;
  return { state: s };
}

// Set a fitting slot from inventory; the replaced module returns to inventory.
function fitModule(state, shipId, slotType, slotIndex, tier) {
  const mod = MODULES[slotType];
  if (!mod) return { error: `Unknown module type: ${slotType}` };
  if (!Number.isInteger(tier) || tier < 0 || tier > mod.tiers.length) {
    return { error: `Invalid tier: ${tier}` };
  }
  const s = clone(state);
  if (!Array.isArray(s.loot)) s.loot = [];
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
  const skillError = tier ? moduleSkillError(s, slotType, tier) : null;
  if (skillError) return { error: skillError };
  let inventoryIndex = -1;
  if (tier > 0) {
    inventoryIndex = (s.loot || []).findIndex((item) => item.slotType === slotType && item.tier === tier);
    if (inventoryIndex < 0) return { error: `No ${mod.name} Tier ${tier} module in inventory` };
  }
  if (tier > 0) s.loot.splice(inventoryIndex, 1);
  if (current > 0) s.loot.push({ id: nextId(), slotType, tier: current });
  ship.fitting[slotType][slotIndex] = tier;
  return { state: s };
}

function unequipAllModules(state) {
  if (!isDocked(state)) return { error: 'Dock at a station to change fittings' };
  if (state.combat) return { error: 'Cannot change fittings during combat' };
  const s = clone(state);
  const ship = s.ships.find((item) => item.id === s.activeShipId);
  if (!ship) return { error: 'No active ship' };
  if (!Array.isArray(s.loot)) s.loot = [];
  for (const [slotType, tiers] of Object.entries(ship.fitting || {})) {
    if (!MODULES[slotType] || !Array.isArray(tiers)) continue;
    for (const tier of tiers) {
      if (Number.isInteger(tier) && tier > 0) {
        s.loot.push({ id: nextId(), slotType, tier });
      }
    }
  }
  ship.fitting = emptyFitting(ship.type);
  return { state: s };
}

function withdraw(state, mineral, amount) {
  return withdrawFromStorage(state, mineral, amount, { shipCargo, skillMults });
}

// Engage the enemy you are standing next to with your active ship. Starts a
// real-time damage race: both sides' shield/hull/dps are captured here and the
// fight is simulated on subsequent ticks.
// Set up a real-time damage race against `enemyId` on the (already-cloned)
// state `s`. Assumes the enemy is alive, in range, and that s.combat is null.
// Fitted modules add a flat bonus to base stats, and trained skills multiply
// the result.
function startCombat(s, enemyId, now) {
  const ship = s.ships.find((sh) => sh.id === s.activeShipId);
  const sys = activeSystem(s);
  const enemy = sys.enemies.find((e) => e.id === enemyId);
  s.manualMining = false;
  s.manualMiningTargetId = null;
  const est = enemyCombatStats(enemy);
  const shipDef = SHIPS[ship.type];
  const mults = skillMults(s);
  const shipShieldMax = shipShield(ship, mults, s.skills);
  const shipHullMax = shipHull(ship, mults, s.skills);
  const playerDps = shipDps(ship, mults, droneBonus(s, 'combat'), s.skills) * autoEfficiency(s);
  const damageProfile = incomingDamageProfile(ship, enemy, s.skills);
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
    ...damageProfile,
    // Range advantage (D2): the enemy's guns are silent for this many seconds of
    // fight time. Mission "short-range" enemies carry a base `rangeDelay`; the
    // player's fitted range modules extend the window even further.
    enemyRangeDelay: est.rangeDelay + moduleBonus(ship, 'range', s.skills, mults),
    // In-fight action state (all measured in fight-time seconds).
    overloadUntil: 0,     // overload (DPS boost) is active until this fightTime
    boostReadyAt: 0,      // shield boost usable again at this fightTime
    overloadReadyAt: 0,   // overload usable again at this fightTime
  };
}

function engage(state, enemyId, now = Date.now()) {
  const s = clone(state);
  if (s.combat) return { error: 'Already in combat' };
  if (isDocked(state)) return { error: 'Cannot engage while docked — launch first' };
  const ship = s.ships.find((sh) => sh.id === s.activeShipId);
  if (!ship) return { error: 'No active ship' };
  const sys = activeSystem(s);
  const enemy = sys
    ? enemyId
      ? sys.enemies.find((e) => e.id === enemyId)
      : sys.enemies
        .filter((item) => item.alive && dist(item.x, item.y, ship.x, ship.y) <= ENGAGE_RANGE)
        .sort((a, b) => dist(a.x, a.y, ship.x, ship.y) - dist(b.x, b.y, ship.x, ship.y))[0]
    : null;
  if (!enemy || !enemy.alive) return { error: 'Target not found' };
  if (dist(enemy.x, enemy.y, ship.x, ship.y) > ENGAGE_RANGE) {
    return { error: 'Target out of range' };
  }
  startCombat(s, enemyId, now);
  ship.navigation = null;
  s.manualMining = false;
  s.manualMiningTargetId = null;
  return { state: s };
}

// Perform an in-fight action: shield boost and overload consume one scrap,
// while disengage bails out and lets the enemy escape.
// 'overload' (temp DPS boost, item + cooldown) or 'disengage' (bail out, keep
// the ship, no reward, the enemy escapes).
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
      shipLost: false,
      cargoLost: 0,
    });
    if (s.combatLog.length > 20) s.combatLog.length = 20;
    s.combat = null;
    return { state: s };
  }
  if (action === 'shieldBoost') {
    if (c.fightTime < c.boostReadyAt) return { error: 'Shield boost is on cooldown' };
    const ship = s.ships.find((item) => item.id === c.shipId);
    if (!ship || (ship.cargo[SHIELD_BOOST_ITEM] || 0) < 1) return { error: 'Need 1 Scrap in cargo' };
    ship.cargo[SHIELD_BOOST_ITEM] -= 1;
    c.shipShield = c.shipShieldMax;
    c.boostReadyAt = c.fightTime + SHIELD_BOOST_COOLDOWN;
    return { state: s };
  }
  if (action === 'overload') {
    if (c.fightTime < c.overloadReadyAt) return { error: 'Overload is on cooldown' };
    const ship = s.ships.find((item) => item.id === c.shipId);
    if (!ship || (ship.cargo[OVERLOAD_ITEM] || 0) < 1) return { error: 'Need 1 Scrap in cargo' };
    ship.cargo[OVERLOAD_ITEM] -= 1;
    c.overloadUntil = c.fightTime + OVERLOAD_DURATION;
    c.overloadReadyAt = c.fightTime + OVERLOAD_COOLDOWN;
    return { state: s };
  }
  return { error: `Unknown combat action: ${action}` };
}

// Find a POI by id within a system (station, belt, enemy, planet, moon, gate, star).
function findPoi(sys, id) {
  if (!sys || !id) return null;
  const inList = (list) => (list || []).find((p) => p.id === id) || null;
  return (
    inList(sys.stations) ||
    inList(sys.outposts) ||
    inList(sys.belts) ||
    inList(sys.enemies) ||
    inList(sys.planets) ||
    inList(sys.moons) ||
    inList(sys.gates) ||
    (sys.star && sys.star.id === id ? sys.star : null)
  );
}

// Approaching a belt means approaching its nearest rock that still has ore, so
// the whole belt is mineable without clicking individual asteroids.
function closestBeltAsteroid(sys, belt, from) {
  let best = null;
  let bd = Infinity;
  for (const a of sys.asteroids || []) {
    if (a.beltId !== belt.id || a.amount <= 0) continue;
    const d = Math.hypot(a.x - from.x, a.y - from.y);
    if (d < bd) {
      bd = d;
      best = a;
    }
  }
  return best;
}

function navigate(state, request) {
  const s = clone(state);
  const ship = s.ships.find((item) => item.id === s.activeShipId);
  const sys = activeSystem(s);
  if (!ship || !sys) return { error: 'No active ship or system' };
  if (s.combat) return { error: 'Cannot navigate while in combat' };
  if (isDocked(s)) return { error: 'Launch from the station before navigating' };
  if (request && request.cancel) {
    ship.navigation = null;
    ship.dockTargetId = null;
    return { state: s };
  }

  let target = null;
  if (request && request.kind) {
    const kind = request.kind === 'rat' ? 'enemy' : request.kind;
    const lists = {
      belt: sys.belts,
      station: sys.stations,
      enemy: sys.enemies.filter((enemy) => enemy.alive),
    };
    const candidates = lists[kind];
    if (!candidates) return { error: 'Unknown navigation target kind' };
    target = candidates.reduce((best, poi) =>
      !best || dist(poi.x, poi.y, ship.x, ship.y) < dist(best.x, best.y, ship.x, ship.y) ? poi : best
    , null);
    if (!target) return { error: `No ${kind} in this system` };
  } else if (request && request.targetId) {
    target = findPoi(sys, request.targetId);
    if (!target || (sys.enemies.includes(target) && !target.alive)) {
      return { error: 'Navigation target is no longer available' };
    }
  }

  if (target) {
    const asteroid = sys.belts.includes(target) ? closestBeltAsteroid(sys, target, ship) : null;
    const destination = asteroid || target;
    const station = sys.stations.find((item) => item.id === target.id);
    const orbitTargetId = sys.asteroids.includes(destination) ? destination.id : null;
    setNavigation(ship, destination.x, destination.y, sys.enemies.includes(target) ? target.id : null, station ? station.id : null, orbitTargetId);
  } else if (request && Number.isFinite(request.x) && Number.isFinite(request.y)) {
    setNavigation(ship, clamp(request.x, 0, sys.width), clamp(request.y, 0, sys.height));
  } else {
    return { error: 'Invalid navigation target' };
  }
  return { state: s };
}

function launch(state) {
  const s = clone(state);
  const ship = s.ships.find((item) => item.id === s.activeShipId);
  const station = dockedStation(s);
  const sys = activeSystem(s);
  if (!ship || !station || !sys) return { error: 'Dock at a station before launching' };
  ship.x = clamp(station.x + DOCK_RANGE + 30, 0, sys.width);
  ship.y = station.y;
  ship.vx = 0;
  ship.vy = 0;
  ship.navigation = null;
  ship.dockTargetId = null;
  ship.dockedStationId = null;
  return { state: s };
}

// Warp the active ship instantly within its own system. `targetId` may be a POI
// id (belt/station/enemy/planet/moon/gate/star) or, if omitted, raw {x, y}
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
    const rock = poi.id && String(poi.id).startsWith('belt_') ? closestBeltAsteroid(sys, poi, ship) : null;
    tx = (rock || poi).x;
    ty = (rock || poi).y;
    const station = sys.stations.find((st) => st.id === poi.id);
    ship.dockTargetId = station ? station.id : null;
    ship.dockedStationId = station ? station.id : null;
  } else if (Number.isFinite(x) && Number.isFinite(y)) {
    tx = x;
    ty = y;
    ship.dockTargetId = null;
    ship.dockedStationId = null;
  } else {
    return { error: 'Invalid warp target' };
  }
  ship.x = clamp(tx, 0, sys.width);
  ship.y = clamp(ty, 0, sys.height);
  ship.navigation = null;
  ship.vx = 0;
  ship.vy = 0;
  if (ship.dockedStationId) {
    s.manualMining = false;
    s.manualMiningTargetId = null;
  }
  return { state: s };
}

// The chance a gate jump into `systemId` triggers an ambush, based on system
// security only.
function ambushChance(state, systemId) {
  const security = state.systems[systemId] ? state.systems[systemId].security || 0.5 : 0.5;
  const chance = AMBUSH_BASE_CHANCE * (1 + (0.5 - security) * 0.7);
  return clamp(chance, AMBUSH_MIN_CHANCE, AMBUSH_MAX_CHANCE);
}
// Spawn a predator near the arrival point in `sys` (a gate ambush), rolled from
// the same security-based roster as the system's regular enemies. Returns the new enemy.
function spawnAmbush(sys, x, y, rng) {
  const { type, tier } = rollEnemy(sys.security, rng);
  const ang = rng() * Math.PI * 2;
  const rad = 60 + rng() * 120; // within ENGAGE_RANGE of the arrival point
  const enemy = {
    id: `ambush_${Date.now().toString(36)}_${Math.floor(rng() * 1e6)}`,
    x: clamp(x + Math.cos(ang) * rad, 60, sys.width - 60),
    y: clamp(y + Math.sin(ang) * rad, 60, sys.height - 60),
    type,
    tier,
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
  const gate = gateId
    ? (sys.gates || []).find((item) => item.id === gateId)
    : (sys.gates || [])
      .filter((item) => dist(ship.x, ship.y, item.x, item.y) <= GATE_RANGE)
      .sort((a, b) => dist(ship.x, ship.y, a.x, a.y) - dist(ship.x, ship.y, b.x, b.y))[0];
  if (!gate) return { error: 'Gate not found in this system' };
  if (dist(ship.x, ship.y, gate.x, gate.y) > GATE_RANGE) {
    return { error: 'Too far from the gate to jump' };
  }
  const targetSys = s.systems[gate.targetSystemId];
  if (!targetSys) return { error: 'Target system not found' };
  // Re-entering a system respawns its outpost enemies and refills its asteroid belts.
  for (const enemy of targetSys.enemies) {
    if (enemy.outpostId && !enemy.missionTag) enemy.alive = true;
  }
  for (const asteroid of targetSys.asteroids) asteroid.amount = asteroid.maxAmount || asteroid.amount;
  const targetGate = (targetSys.gates || []).find((g) => g.id === gate.targetGateId);
  const arriveX = targetGate ? targetGate.x : targetSys.stations[0].x;
  const arriveY = targetGate ? targetGate.y : targetSys.stations[0].y;
  ship.systemId = targetSys.id;
  ship.x = clamp(arriveX, 0, targetSys.width);
  ship.y = clamp(arriveY, 0, targetSys.height);
  ship.navigation = null;
  ship.vx = 0;
  ship.vy = 0;
  ship.dockTargetId = null;
  ship.dockedStationId = null;
  s.manualMining = false;
  s.manualMiningTargetId = null;
  // Lower security systems have a higher chance of gate ambushes.
  if (rng() < ambushChance(s, targetSys.id)) {
    const ambusher = spawnAmbush(targetSys, ship.x, ship.y, rng);
    startCombat(s, ambusher.id, now);
  }
  return { state: s };
}

function reset(state, now = Date.now(), seed = (Date.now() % 1000000) + 1) {
  return createInitialState(now, seed, state.mode || 'demo');
}

module.exports = {
  SHIPS,
  MODULES,
  SKILLS,
  MINERALS,
  COMPONENTS,
  ORE_EXCHANGE,
  COMPONENT_EXCHANGE,
  BLUEPRINT_COSTS,
  NPC_BLUEPRINTS,
  SHIP_PROGRESSION,
  SHIP_CLASSES,
  SHIP_FAMILIES,
  ENEMIES,
  ENEMY_TIERS,
  spawnTable,
  DRONES,
  ACHIEVEMENTS,
  AGENT_ROLES,
  AGENT_MISSIONS,
  BLUEPRINTS,
  SHIP_BLUEPRINTS,
  createInitialState,
  migrateEconomy,
  migrateAgentMissionState,
  isValidState,
  migrateWorldLayout,
  evaluateMission,
  checkMissionObjective,
  missionView,
  missionAction,
  agentMissionAction,
  spawnMissionEnemies,
  startMission,
  missionStartNeeded,
  MISSIONS,
  MISSION_ORDER,
  tick,
  mine,
  navigate,
  setAutopilot,
  launch,
  setActive,
  fitModule,
  unequipAllModules,
  applyFittingPreset,
  deleteFittingPreset,
  craftShip,
  moduleBonus,
  emptyFitting,
  trainSkill,
  skillMults,
  skillCost,
  emptySkills,
  emptyDroneBay,
  droneBonus,
  autoEfficiency,
  buyBlueprint,
  exchangeItems,
  equipLoot,
  refineLoot,
  craftModule,
  deposit,
  depositAll,
  depositFiltered,
  withdraw,
  storeInventoryItem,
  retrieveInventoryItem,
  emptyStorage,
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
  nearestAsteroidInRange,
  isDocked,
  dockedStation,
  rollEnemy,
  migrateTerminology,
  migrateSkillTree,
  startAutopilotDockWait,
  completeAutopilotDeposit,
  enemyCombatStats,
  estimateCombatDifficulty,
  activeSystem,
  generateSystems,
  resetIds,
};
