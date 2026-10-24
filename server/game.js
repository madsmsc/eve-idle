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
  AGENT_MISSIONS,
  AGENT_MISSION_COOLDOWN_MS,
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
  DAMPING,
  ARRIVE_RADIUS,
  STATE_VERSION,
} = require('./config');

let _counter = 0;
function nextId() {
  _counter += 1;
  return `ship_${_counter.toString(36)}_${Date.now().toString(36)}`;
}

function agentMissionAction(state, action, now = Date.now()) {
  if (action !== 'accept' && action !== 'cancel') return { error: 'Unknown agent mission action' };
  if (action === 'accept' && state.agentMission && state.agentMission.status === 'active') return { error: 'An agent mission is already active' };
  if (action === 'cancel' && (!state.agentMission || state.agentMission.status !== 'active')) return { error: 'No active agent mission' };
  const s = clone(state);
  if (action === 'cancel') {
    s.agentMission = null;
    s.agentMissionCompletedAt = now;
    return { state: s };
  }
  if (now < (s.agentMissionCompletedAt || 0) + AGENT_MISSION_COOLDOWN_MS) return { error: 'No agent mission available yet' };
  const index = Math.floor(now / AGENT_MISSION_COOLDOWN_MS) % AGENT_MISSIONS.length;
  const offer = AGENT_MISSIONS[index];
  s.agentMission = { key: offer.key, progress: 0, status: 'active', startedAt: now };
  return { state: s };
}

function advanceAgentMission(state, type, amount, enemyType) {
  const current = state.agentMission;
  if (!current || current.status !== 'active' || amount <= 0) return;
  const def = AGENT_MISSIONS.find((mission) => mission.key === current.key);
  if (!def || def.type !== type || (type === 'kill' && def.enemyType !== enemyType)) return;
  current.progress = Math.min(def.target, current.progress + amount);
  if (current.progress < def.target) return;
  current.status = 'complete';
  current.completedAt = Date.now();
  state.agentMissionCompletedAt = current.completedAt;
  const missionDef = AGENT_MISSIONS.find((mission) => mission.key === current.key);
  addStoredItems(state, missionDef && missionDef.rewardItems);
  state.stats.agentMissionsCompleted = (state.stats.agentMissionsCompleted || 0) + 1;
}

function agentMissionView(state, now = Date.now()) {
  const stored = state.agentMission;
  const active = stored && stored.status === 'active' && AGENT_MISSIONS.find((mission) => mission.key === stored.key);
  const availableAt = (state.agentMissionCompletedAt || 0) + AGENT_MISSION_COOLDOWN_MS;
  const offerIndex = Math.floor(now / AGENT_MISSION_COOLDOWN_MS) % AGENT_MISSIONS.length;
  return {
    active: active ? { ...active, progress: Math.min(active.target, stored.progress), status: 'active' } : null,
    completed: stored && stored.status === 'complete' ? AGENT_MISSIONS.find((mission) => mission.key === stored.key).name : null,
    available: !(stored && stored.status === 'active') && now >= availableAt,
    availableAt,
    remainingMs: Math.max(0, availableAt - now),
    offer: AGENT_MISSIONS[offerIndex],
  };
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
// A ship's effective stats are its base stats plus the flat bonus of every
// fitted module, multiplied by trained skills. There is no level/upgrade system:
// ships are what they are, and modules (or better ships) are how you get stronger.
function shipMining(ship, mults, drone = 0) {
  return (SHIPS[ship.type].mining + moduleBonus(ship, 'mining') + moduleBonus(ship, 'miningDrone') + drone) *
    (mults ? mults.mining : 1) * MINING_RATE_MULTIPLIER;
}
function miningRange(ship) {
  return MINING_RANGE + moduleBonus(ship, 'mining');
}
function shipCombat(ship) {
  return SHIPS[ship.type].combat;
}
function shipDps(ship, mults, drone = 0) {
  return (SHIPS[ship.type].dps + moduleBonus(ship, 'weapon') + moduleBonus(ship, 'combatDrone') + drone) * (mults ? mults.dps : 1);
}
function shipShield(ship, mults) {
  return (SHIPS[ship.type].shield + moduleBonus(ship, 'shield')) * (mults ? mults.shield : 1);
}
function shipHull(ship, mults) {
  return (SHIPS[ship.type].hull + moduleBonus(ship, 'armor')) * (mults ? mults.hull : 1);
}
function shipCargo(ship, mults) {
  return (SHIPS[ship.type].cargo + moduleBonus(ship, 'cargo')) * (mults ? mults.cargo : 1);
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
  const m = { mining: 1, cargo: 1, dps: 1, shield: 1, hull: 1 };
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

function skillTrainingView(state) {
  return Object.fromEntries(Object.entries(SKILLS).map(([key, def]) => {
    const level = (state.skills && state.skills[key]) || 0;
    const maxed = level >= def.maxLevel;
    const cost = maxed ? 0 : skillCost(def, level);
    return [key, {
      level,
      cost,
      maxed,
      canTrain: !maxed && (state.skillPoints || 0) >= cost,
    }];
  }));
}

function shipProgressionView(state, materials, docked) {
  return Object.fromEntries(SHIP_PROGRESSION.flatMap((tier) => tier.ships.map((entry) => {
    const blueprint = SHIP_BLUEPRINTS[entry.type];
    const skillsReady = entry.skills.every((requirement) =>
      ((state.skills && state.skills[requirement.skill]) || 0) >= requirement.level
    );
    const materialsReady = !blueprint || Object.entries(blueprint.recipe).every(([key, amount]) =>
      (materials[key] || 0) >= amount
    );
    const materialCounts = blueprint
      ? Object.fromEntries(Object.keys(blueprint.recipe).map((key) => [key, materials[key] || 0]))
      : {};
    const blueprintReady = entry.type === 'rifter' || (state.blueprints || []).some((item) =>
      item.kind === 'ship' && item.type === entry.type
    );
    return [entry.type, {
      skillsReady,
      materialsReady,
      blueprintReady,
      canBuild: entry.type !== 'rifter' && docked && skillsReady && materialsReady && blueprintReady,
      materials: blueprint ? { ...blueprint.recipe } : {},
      materialCounts,
    }];
  })));
}

function actionAvailability(state, materials, docked, active) {
  const craftModules = {};
  for (const [slotType, tiers] of Object.entries(BLUEPRINTS)) {
    for (const [tier, blueprint] of Object.entries(tiers)) {
      const hasBlueprint = (state.blueprints || []).some((item) =>
        item.kind === 'module' && item.type === slotType && item.tier === Number(tier)
      );
      const hasMaterials = Object.entries(blueprint.recipe).every(([key, amount]) =>
        (materials[key] || 0) >= amount
      );
      craftModules[`${slotType}:${tier}`] = {
        hasBlueprint,
        hasMaterials,
        materialCounts: Object.fromEntries(Object.keys(blueprint.recipe).map((key) => [key, materials[key] || 0])),
        canCraft: docked && hasBlueprint && hasMaterials,
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
    for (const [slotType, tiers] of Object.entries(active.fitting || {})) {
      for (let slotIndex = 0; slotIndex < tiers.length; slotIndex++) {
        const currentTier = tiers[slotIndex] || 0;
        for (let tier = 0; tier <= MODULES[slotType].tiers.length; tier++) {
          const hasItem = tier === 0 || tier === currentTier || (state.loot || []).some((item) =>
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
  for (const item of state.loot || []) {
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

function craftShip(state, type) {
  const blueprint = SHIP_BLUEPRINTS[type];
  if (!blueprint) return { error: `No ship blueprint for ${type}` };
  if (!isDocked(state)) return { error: 'Dock at a station to craft' };
  const s = clone(state);
  const active = s.ships.find((sh) => sh.id === s.activeShipId);
  const sys = activeSystem(s);
  if (!active || !sys) return { error: 'No active ship' };
  const skillError = shipSkillError(s, type);
  if (skillError) return { error: skillError };
  const blueprintIndex = (s.blueprints || []).findIndex((item) =>
    item.kind === 'ship' && item.type === type
  );
  if (blueprintIndex < 0) return { error: `You need a ${blueprint.name} blueprint` };
  if (!hasMaterials(s, blueprint.recipe)) return { error: `Need ore and components to build ${blueprint.name}` };
  consumeMaterials(s, blueprint.recipe);
  s.blueprints.splice(blueprintIndex, 1);
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
  const active = state && state.ships && state.ships.find((ship) => ship.id === state.activeShipId);
  const fittedSlot = droneType === 'mining' ? 'miningDrone' : 'combatDrone';
  if (active && active.fitting && active.fitting[fittedSlot] && active.fitting[fittedSlot].some((tier) => tier > 0)) return 0;
  if (!def || !Array.isArray(bay)) return 0;
  return bay.reduce((sum, t) => sum + (t > 0 ? def.tiers[t - 1].bonus : 0), 0);
}
function buyBlueprint(state, kind, type, tier = null) {
  if (kind !== 'module' && kind !== 'ship') return { error: `Unknown blueprint type: ${kind}` };
  const key = kind === 'module' ? `module:${type}:${tier}` : `ship:${type}`;
  const recipe = BLUEPRINT_COSTS[key];
  if (!recipe) return { error: `Unknown ${kind} blueprint: ${type}` };
  if (!NPC_BLUEPRINTS.includes(key)) {
    return { error: 'This blueprint is not sold by NPCs; higher-tier blueprints are found as rat loot' };
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

function moduleSkillKey(slotType) {
  return {
    weapon: 'gunnery',
    shield: 'shieldUpgrades',
    armor: 'hullUpgrades',
    mining: 'miningYield',
    cargo: 'cargoManagement',
    range: 'gunnery',
    miningDrone: 'miningYield',
    combatDrone: 'gunnery',
  }[slotType];
}

function moduleSkillError(state, slotType, tier) {
  const skill = moduleSkillKey(slotType);
  const required = Math.max(0, tier - 1);
  const current = (state.skills && state.skills[skill]) || 0;
  return current < required ? `Requires ${SKILLS[skill].name} level ${required}` : null;
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
// Equip a looted module (see resolveCombat for how rats drop them) into the
// first empty slot of its type on the active ship, free of charge.
function equipLoot(state, lootId) {
  if (!isDocked(state)) return { error: 'Dock at a station to equip modules' };
  if (state.combat) return { error: 'Modules cannot be changed during combat' };
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
  s.loot.splice(idx, 1);
  return { state: s };
}

function refineLoot(state, lootId) {
  if (!isDocked(state)) return { error: 'Dock at a station to refine modules' };
  const s = clone(state);
  const idx = (s.loot || []).findIndex((item) => item && item.id === lootId);
  if (idx === -1) return { error: 'Loot not found' };
  const loot = s.loot[idx];
  if (!MODULES[loot.slotType] || !BLUEPRINTS[loot.slotType] || !BLUEPRINTS[loot.slotType][loot.tier]) {
    return { error: 'Invalid loot module' };
  }
  const component = COMPONENT_EXCHANGE[loot.tier - 1];
  if (!component) return { error: 'Invalid module tier' };
  addStoredItems(s, { [component]: 1 });
  s.loot.splice(idx, 1);
  s.stats.modulesSalvaged = (s.stats.modulesSalvaged || 0) + 1;
  return { state: s };
}

function craftModule(state, slotType, tier) {
  const mod = MODULES[slotType];
  if (!mod) return { error: `Unknown module type: ${slotType}` };
  if (!mod.tiers[tier - 1]) return { error: `Invalid tier: ${tier}` };
  if (!isDocked(state)) return { error: 'Dock at a station to craft' };
  const s = clone(state);
  const skillError = moduleSkillError(s, slotType, tier);
  if (skillError) return { error: skillError };
  const bp = BLUEPRINTS[slotType][tier];
  const blueprintIndex = (s.blueprints || []).findIndex((item) =>
    item.kind === 'module' && item.type === slotType && item.tier === tier
  );
  if (blueprintIndex < 0) return { error: `You need a ${bp.name} blueprint` };
  if (!hasMaterials(s, bp.recipe)) return { error: `Need ore and components to craft ${bp.name}` };
  consumeMaterials(s, bp.recipe);
  s.blueprints.splice(blueprintIndex, 1);
  if (!Array.isArray(s.loot)) s.loot = [];
  s.loot.push({ id: nextId(), slotType, tier });
  s.stats.modulesCrafted = (s.stats.modulesCrafted || 0) + 1;
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

function shipInCombat(state, shipId) {
  return !!(state.combat && state.combat.shipId === shipId);
}
// A fresh, empty cargo hold (one key per mineral).
function emptyCargo() {
  return emptyMaterials();
}
// Quantum storage: a single player-level warehouse shared by every station in
// every system. It lives on the state (not per-system), so any station lets you
// deposit or withdraw the same contents. Unlike the active ship's hold, storage
// survives ship loss.
function emptyStorage() {
  return { items: emptyMaterials() };
}
function emptyMaterials() {
  return Object.fromEntries([...Object.keys(MINERALS), ...Object.keys(COMPONENTS)].map((key) => [key, 0]));
}
function materialDefinition(key) {
  return MINERALS[key] || COMPONENTS[key] || null;
}
function addStoredItems(state, items = {}) {
  if (!state.storage) state.storage = emptyStorage();
  if (!state.storage.items) state.storage.items = emptyMaterials();
  for (const [key, amount] of Object.entries(items)) {
    if (materialDefinition(key) && Number.isFinite(amount) && amount > 0) {
      state.storage.items[key] = (state.storage.items[key] || 0) + amount;
    }
  }
}
function availableMaterials(state, key) {
  if (!materialDefinition(key)) return 0;
  const active = state.ships.find((ship) => ship.id === state.activeShipId);
  const cargoAmount = active && active.cargo ? active.cargo[key] || 0 : 0;
  const stored = state.storage && (state.storage.items || state.storage.minerals);
  return cargoAmount + (stored ? stored[key] || 0 : 0);
}
function hasMaterials(state, recipe) {
  return Object.entries(recipe).every(([key, amount]) => availableMaterials(state, key) >= amount);
}
function consumeMaterials(state, recipe) {
  if (!hasMaterials(state, recipe)) return false;
  const active = state.ships.find((ship) => ship.id === state.activeShipId);
  if (!state.storage) state.storage = emptyStorage();
  if (!state.storage.items) state.storage.items = { ...emptyMaterials(), ...(state.storage.minerals || {}) };
  for (const [key, amount] of Object.entries(recipe)) {
    const fromCargo = Math.min(active && active.cargo ? active.cargo[key] || 0 : 0, amount);
    if (fromCargo > 0) active.cargo[key] -= fromCargo;
    state.storage.items[key] = (state.storage.items[key] || 0) - (amount - fromCargo);
  }
  return true;
}
// Total materials carried in the active ship's cargo hold.
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

// The enemy's combat stats: its type's base numbers times its tier multiplier,
// straight from enemies.json. Nothing else modifies them.
function enemyCombatStats(enemy) {
  const def = ENEMIES[enemy.type];
  const tier = ENEMY_TIERS[enemy.tier] || ENEMY_TIERS.standard;
  const m = tier ? tier.multiplier : 1;
  return {
    shield: def ? def.shield * m : 0,
    hull: def ? def.hull * m : 0,
    dps: def ? def.dps * m : 0,
    rangeDelay: enemy.rangeDelay || 0,
  };
}

function estimateCombatDifficulty(state, ship, enemy) {
  const enemyStats = enemyCombatStats(enemy);
  const mults = skillMults(state);
  const playerDurability = shipShield(ship, mults) + shipHull(ship, mults);
  const playerDps = shipDps(ship, mults, droneBonus(state, 'combat'));
  if (playerDps <= 0) return { key: 'unknown', label: 'Unknown', ratio: null };

  const timeToKill = (enemyStats.shield + enemyStats.hull) / playerDps;
  const timeToLose = enemyStats.dps > 0
    ? enemyStats.rangeDelay + moduleBonus(ship, 'range') + playerDurability / enemyStats.dps
    : Infinity;
  const ratio = timeToLose / timeToKill;
  if (ratio >= 1.5) return { key: 'favorable', label: 'Favorable', ratio };
  if (ratio >= 0.85) return { key: 'even', label: 'Even', ratio };
  if (ratio >= 0.55) return { key: 'dangerous', label: 'Dangerous', ratio };
  return { key: 'deadly', label: 'Deadly', ratio };
}

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

// Roll a rat (type + tier) from the spawn table allowed at `security`.
function rollRat(security, rng) {
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
  if (ship.dockedStationId !== undefined) {
    const station = sys.stations.find((st) => st.id === ship.dockedStationId);
    return station && dist(ship.x, ship.y, station.x, station.y) <= DOCK_RANGE ? station : null;
  }
  // Preserve docking for saves created before station-directed docking intent
  // was stored, while all new states use the explicit station marker.
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
  { id: 'sys_0', name: 'Jita',   color: '#ff9f45', security: 1.0, stationCount: 2 },
  { id: 'sys_1', name: 'Placid', color: '#3fd6a0', security: 0.5, stationCount: 2 },
  { id: 'sys_2', name: 'Domain', color: '#a970ff', security: 0.1, stationCount: 1 },
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
  const outposts = [];
  const belts = [];
  const asteroids = [];
  const enemies = [];
  let aid = 1;

  // The star anchors the system at the centre.
  const star = { id: 'star_1', x: cx, y: cy, size: 130 + rng() * 60, name: 'Sol' };

  // Reserve fixed gate locations and the home station before placing sites.
  const home = { id: 'stn_1', x: cx + 520, y: cy, name: 'Station A' };
  stations.push(home);
  const placedSites = [
    home,
    gateSlot(0),
    gateSlot(1),
  ];
  const placeSite = () => {
    for (let tries = 0; tries < 500; tries++) {
      const x = 600 + rng() * (size - 1200);
      const y = 600 + rng() * (size - 1200);
      if (placedSites.every((site) => dist(x, y, site.x, site.y) >= 1000)) {
        const site = { x, y };
        placedSites.push(site);
        return site;
      }
    }
    throw new Error(`Could not place a spaced site in ${profile.name}`);
  };

  // Additional stations are kept apart from all other navigational sites.
  for (let i = 1; i < profile.stationCount; i++) {
    const site = placeSite();
    stations.push({ id: `stn_${i + 1}`, ...site, name: `Station ${String.fromCharCode(66 + i)}` });
  }

  for (let i = 0; i < 2; i++) {
    const site = placeSite();
    outposts.push({ id: `outpost_${i + 1}`, ...site, name: `Outpost ${String.fromCharCode(65 + i)}` });
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
  for (let f = 0; f < ASTEROID_FIELDS; f++) {
    const { x: fx, y: fy } = placeSite();
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

  for (const outpost of outposts) {
    const count = 3 + Math.floor(rng() * 3);
    for (let i = 0; i < count; i++) {
      const ang = rng() * Math.PI * 2;
      const rad = 180 + rng() * 260;
      const { type, tier } = rollRat(profile.security, rng);
      enemies.push({
        id: `en_${enemies.length + 1}`,
        x: clamp(outpost.x + Math.cos(ang) * rad, 60, size - 60),
        y: clamp(outpost.y + Math.sin(ang) * rad, 60, size - 60),
        type,
        tier,
        outpostId: outpost.id,
        alive: true,
        seed: Math.floor(rng() * 1e9),
      });
    }
  }

  return {
    id: profile.id,
    name: profile.name,
    color: profile.color,
    security: profile.security,
    width: size,
    height: size,
    star,
    planets,
    moons,
    stations,
    outposts,
    belts,
    asteroids,
    enemies,
    gates: [],
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
  const systems = Object.values(state.systems);
  const currentLayout = systems.every((sys) =>
    sys.outposts && sys.outposts.length === 2 &&
    sys.belts && sys.belts.length === 2 &&
    sys.enemies.filter((enemy) => !enemy.missionTag).every((enemy) => enemy.outpostId)
  );
  if (currentLayout) return state;

  const homeSystem = state.systems.sys_0;
  const seed = homeSystem && Number.isInteger(homeSystem.seed)
    ? (homeSystem.seed - hashStr('sys_0')) >>> 0
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
    mission: { active: mode === 'story' ? 'm1' : null, step: 0, flags: {}, completed: [] },
    agentMission: null,
    agentMissionCompletedAt: 0,
    autoPilotMode: null,
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
  const range = miningRange(ship);
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

function mineActive(s, active, seconds) {
  const sys = activeSystem(s);
  if (!sys) return;
  const mults = skillMults(s);
  // Mining stops once the active ship's cargo hold is full.
  const room = shipCargo(active, mults) - cargoUsed(s);
  if (room <= 0) return;
  const budget = Math.min(shipMining(active, mults, droneBonus(s, 'mining')) * seconds, room);
  const range = miningRange(active);
  const inRange = [];
  for (const a of sys.asteroids) {
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

function setNavigation(ship, x, y, targetId = null, dockTargetId = null, orbitTargetId = null) {
  ship.navigation = { x, y, targetId, dockTargetId, orbitTargetId };
  ship.dockTargetId = dockTargetId;
  ship.dockedStationId = null;
}

function nearestStationFor(ship, sys) {
  return sys.stations.reduce((best, station) => {
    const distance = dist(ship.x, ship.y, station.x, station.y);
    return !best || distance < best.distance ? { station, distance } : best;
  }, null);
}

function nearestSafeRat(state, ship, sys) {
  return sys.enemies
    .filter((enemy) => enemy.alive)
    .map((enemy) => ({ enemy, difficulty: estimateCombatDifficulty(state, ship, enemy) }))
    .filter(({ difficulty }) => difficulty.ratio !== null && difficulty.ratio >= 0.85)
    .sort((a, b) =>
      dist(a.enemy.x, a.enemy.y, ship.x, ship.y) - dist(b.enemy.x, b.enemy.y, ship.x, ship.y)
    )[0]?.enemy || null;
}

function bestBeltTarget(ship, sys) {
  const values = new Map();
  for (const asteroid of sys.asteroids) {
    if (asteroid.amount <= 0) continue;
    const tier = MINERALS[asteroid.mineral].tier || 1;
    values.set(asteroid.beltId, (values.get(asteroid.beltId) || 0) + asteroid.amount * tier);
  }
  return sys.belts
    .map((belt) => ({
      belt,
      score: (values.get(belt.id) || 0) / Math.max(1, dist(belt.x, belt.y, ship.x, ship.y)),
    }))
    .filter((entry) => entry.score > 0)
    .sort((a, b) => b.score - a.score)[0]?.belt || null;
}

function recordAutomation(state, message, at = Date.now()) {
  if (!Array.isArray(state.automationLog)) state.automationLog = [];
  state.automationLog.unshift({ at, message });
  state.automationLog.length = Math.min(state.automationLog.length, 20);
}

function setAutopilotNavigation(state, ship, x, y, targetId = null, dockTargetId = null, orbitTargetId = null) {
  const current = ship.navigation;
  if (current && current.x === x && current.y === y && current.targetId === targetId &&
      current.dockTargetId === dockTargetId && current.orbitTargetId === orbitTargetId) return;
  setNavigation(ship, x, y, targetId, dockTargetId, orbitTargetId);
  const sys = activeSystem(state);
  const target = targetId && sys && sys.enemies.find((enemy) => enemy.id === targetId);
  const station = dockTargetId && sys && sys.stations.find((item) => item.id === dockTargetId);
  recordAutomation(state, target
    ? `Engaging ${ENEMIES[target.type].name}`
    : station ? `Returning to ${station.name}` : 'Traveling to a mining site');
}

function launchForAutopilot(ship, station) {
  ship.x = clamp(station.x + DOCK_RANGE + 30, 0, WORLD_SIZE);
  ship.y = station.y;
  ship.vx = 0;
  ship.vy = 0;
  ship.dockedStationId = null;
  ship.dockTargetId = null;
}

function runAutopilot(state, ship, sys, now) {
  const mode = state.autoPilotMode;
  if (!mode || state.combat || !ship || !sys) return;
  const canMine = mode === 'mine' || mode === 'mine_hunt';
  const canHunt = mode === 'hunt' || mode === 'mine_hunt';
  const station = nearestStationFor(ship, sys);

  if (isDocked(state)) {
    if (cargoUsed(state) > 0) {
      const stored = state.storage.items;
      const storedCount = cargoUsed(state);
      for (const [key, amount] of Object.entries(ship.cargo)) {
        stored[key] = (stored[key] || 0) + amount;
        ship.cargo[key] = 0;
      }
      recordAutomation(state, `Stored ${Math.floor(storedCount)} cargo`);
    }
    const belt = canMine ? bestBeltTarget(ship, sys) : null;
    const rat = !belt && canHunt ? nearestSafeRat(state, ship, sys) : null;
    const target = belt || rat;
    if (!target) {
      state.autoPilotMode = null;
      ship.navigation = null;
      recordAutomation(state, 'No suitable targets remain; auto-pilot stopped');
      return;
    }
    const docked = dockedStation(state);
    launchForAutopilot(ship, docked || station.station);
    if (belt) {
      const rock = closestBeltAsteroid(sys, belt, ship) || belt;
      setAutopilotNavigation(state, ship, rock.x, rock.y, null, null, rock.id);
    } else {
      setAutopilotNavigation(state, ship, rat.x, rat.y, rat.id);
    }
    return;
  }

  if (cargoUsed(state) >= cargoCapacity(state)) {
    if (station) setAutopilotNavigation(state, ship, station.station.x, station.station.y, null, station.station.id);
    return;
  }
  const navigation = ship.navigation;
  const navigationTarget = canHunt && navigation && navigation.targetId
    ? sys.enemies.find((enemy) => enemy.id === navigation.targetId && enemy.alive)
    : null;
  if (navigationTarget && dist(navigationTarget.x, navigationTarget.y, ship.x, ship.y) <= ENGAGE_RANGE) {
    startCombat(state, navigationTarget.id, now);
    ship.navigation = null;
    return;
  }
  const availableBelt = canMine ? bestBeltTarget(ship, sys) : null;
  const availableRat = canHunt ? nearestSafeRat(state, ship, sys) : null;
  if (!availableBelt && !availableRat) {
    state.autoPilotMode = null;
    ship.navigation = null;
    ship.dockTargetId = null;
    recordAutomation(state, 'No suitable targets remain; auto-pilot stopped');
    return;
  }
  if (navigation && (
    (navigation.targetId && sys.enemies.some((enemy) => enemy.id === navigation.targetId && enemy.alive)) ||
    (navigation.dockTargetId && sys.stations.some((item) => item.id === navigation.dockTargetId)) ||
    sys.asteroids.some((asteroid) =>
      asteroid.amount > 0 && asteroid.x === navigation.x && asteroid.y === navigation.y)
  )) return;
  if (nearestAsteroidInRange(state, ship)) return;
  if (canHunt) {
    const rat = nearestSafeRat(state, ship, sys);
    if (rat) {
      setAutopilotNavigation(state, ship, rat.x, rat.y, rat.id);
      if (dist(rat.x, rat.y, ship.x, ship.y) <= ENGAGE_RANGE) {
        startCombat(state, rat.id, now);
        ship.navigation = null;
      }
      return;
    }
  }
  if (canMine) {
    const belt = bestBeltTarget(ship, sys);
    if (belt) {
      const rock = closestBeltAsteroid(sys, belt, ship) || belt;
      setAutopilotNavigation(state, ship, rock.x, rock.y, null, null, rock.id);
      return;
    }
  }
}

function moveInOrbit(ship, target, radius, seconds, sys) {
  const distance = dist(target.x, target.y, ship.x, ship.y);
  const targetKey = target.id || `${target.x}:${target.y}`;
  if (ship.orbitTargetKey !== targetKey) {
    ship.orbitTargetKey = targetKey;
    ship.orbitAngle = distance > 0 ? Math.atan2(ship.y - target.y, ship.x - target.x) : ship.heading || 0;
  }
  ship.orbitAngle += seconds * 0.18;
  const desiredX = target.x + Math.cos(ship.orbitAngle) * radius;
  const desiredY = target.y + Math.sin(ship.orbitAngle) * radius;
  const previousX = ship.x;
  const previousY = ship.y;
  const response = 1 - Math.exp(-seconds * 4);
  ship.x = clamp(ship.x + (desiredX - ship.x) * response, 0, sys.width);
  ship.y = clamp(ship.y + (desiredY - ship.y) * response, 0, sys.height);
  ship.vx = (ship.x - previousX) / seconds;
  ship.vy = (ship.y - previousY) / seconds;
  if (Math.hypot(ship.vx, ship.vy) > 4) ship.heading = Math.atan2(ship.vy, ship.vx);
  ship.distanceTravelled = (ship.distanceTravelled || 0) + Math.hypot(ship.x - previousX, ship.y - previousY);
}

function advanceNavigation(ship, sys, seconds, combat = null) {
  if (ship.dockedStationId) return;
  let destination = ship.navigation;
  const combatEnemy = combat && combat.shipId === ship.id
    ? sys.enemies.find((enemy) => enemy.id === combat.enemyId && enemy.alive)
    : null;
  const enemy = combatEnemy || (destination && destination.targetId
    ? sys.enemies.find((item) => item.id === destination.targetId && item.alive)
    : null);
  const asteroid = destination && destination.orbitTargetId
    ? sys.asteroids.find((item) => item.id === destination.orbitTargetId && item.amount > 0)
    : null;
  if (destination && destination.orbitTargetId && !asteroid) {
    ship.navigation = null;
    destination = null;
  }
  const nearbyAsteroid = !destination && !combat
    ? sys.asteroids
      .filter((item) => item.amount > 0)
      .map((item) => ({ item, distance: dist(item.x, item.y, ship.x, ship.y) }))
      .filter(({ distance }) => distance <= miningRange(ship))
      .sort((a, b) => a.distance - b.distance)[0]?.item || null
    : null;
  const orbit = combatEnemy
    ? { target: combatEnemy, radius: 150 }
    : enemy && destination && dist(enemy.x, enemy.y, ship.x, ship.y) <= 162
      ? { target: enemy, radius: 150 }
      : asteroid && dist(asteroid.x, asteroid.y, ship.x, ship.y) <= 112
        ? { target: asteroid, radius: 100 }
        : nearbyAsteroid
          ? { target: nearbyAsteroid, radius: 100 }
          : null;
  if (orbit) {
    moveInOrbit(ship, orbit.target, orbit.radius, seconds, sys);
    return;
  }
  ship.orbitTargetKey = null;
  ship.orbitAngle = null;
  if (!destination) {
    ship.vx = 0;
    ship.vy = 0;
    return;
  }
  const dx = destination.x - ship.x;
  const dy = destination.y - ship.y;
  const distance = Math.hypot(dx, dy);
  if (distance <= ARRIVE_RADIUS) {
    const station = destination.dockTargetId && sys.stations.find((item) => item.id === destination.dockTargetId);
    ship.navigation = null;
    ship.vx = 0;
    ship.vy = 0;
    if (station) {
      ship.x = station.x;
      ship.y = station.y;
      ship.dockTargetId = station.id;
      ship.dockedStationId = station.id;
    }
    return;
  }
  const desired = Math.min(MAX_SPEED, distance * 0.6);
  const steer = Math.min(1, seconds * 2.2);
  ship.vx = (ship.vx || 0) + ((dx / distance) * desired - (ship.vx || 0)) * steer;
  ship.vy = (ship.vy || 0) + ((dy / distance) * desired - (ship.vy || 0)) * steer;
  const damping = Math.pow(DAMPING, seconds * 60);
  ship.vx *= damping;
  ship.vy *= damping;
  const speed = Math.hypot(ship.vx, ship.vy);
  if (speed > MAX_SPEED) {
    ship.vx = (ship.vx / speed) * MAX_SPEED;
    ship.vy = (ship.vy / speed) * MAX_SPEED;
  }
  const oldX = ship.x;
  const oldY = ship.y;
  ship.x = clamp(ship.x + ship.vx * seconds, 0, sys.width);
  ship.y = clamp(ship.y + ship.vy * seconds, 0, sys.height);
  ship.heading = Math.atan2(ship.vy, ship.vx);
  ship.distanceTravelled = (ship.distanceTravelled || 0) + Math.hypot(ship.x - oldX, ship.y - oldY);
}

function recordMiningProgress(state, beforeMined, beforeOreBelts, now) {
  const mined = (state.stats.totalMineralsMined || 0) - beforeMined;
  const sys = activeSystem(state);
  const afterOreBelts = new Set(sys.asteroids.filter((asteroid) => asteroid.amount > 0).map((asteroid) => asteroid.beltId));
  for (const beltId of beforeOreBelts) {
    if (!afterOreBelts.has(beltId)) state.stats.beltsCompleted = (state.stats.beltsCompleted || 0) + 1;
  }
  advanceAgentMission(state, 'mine', mined);
  if (state.autoPilotMode && mined > 0) recordAutomation(state, `Mined ${Math.floor(mined)} ore`, now);
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
    const movedDist = Math.hypot(nx - active.x, ny - active.y);
    active.x = nx;
    active.y = ny;
    s.stats.distanceTraveled = (s.stats.distanceTraveled || 0) + movedDist;
    const targetStation = sys.stations.find((st) => st.id === pos.dockTargetId);
    active.dockTargetId = targetStation ? targetStation.id : null;
    active.dockedStationId = targetStation && dist(active.x, active.y, targetStation.x, targetStation.y) <= DOCK_RANGE
      ? targetStation.id
      : null;
  }

  if (active && sys && !pos && seconds > 0 &&
      (active.navigation || s.autoPilotMode || s.combat || nearestAsteroidInRange(s, active))) {
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
        advanceNavigation(active, sys, substep, s.combat);
        movementRemaining -= substep;
      }
      if (!shipInCombat(s, active.id)) mineActive(s, active, step);
      remaining -= step;
    }
    recordMiningProgress(s, beforeMined, beforeOreBelts, now);
    s.stats.distanceTraveled = (s.stats.distanceTraveled || 0) +
      (active.distanceTravelled || 0);
    active.distanceTravelled = 0;
  } else if (active && !shipInCombat(s, active.id) && seconds > 0) {
    const beforeMined = s.stats.totalMineralsMined || 0;
    const beforeOreBelts = sys
      ? new Set(sys.asteroids.filter((asteroid) => asteroid.amount > 0).map((asteroid) => asteroid.beltId))
      : new Set();
    mineActive(s, active, seconds);
    if (sys) recordMiningProgress(s, beforeMined, beforeOreBelts, now);
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
    if (enemy && !enemy.missionTag) advanceAgentMission(s, 'kill', 1, enemy.type);
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
  const station = dockedStation(s);
  ship.dockTargetId = station ? station.id : null;
  ship.dockedStationId = station ? station.id : null;
  s.activeShipId = shipId;
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

// Move minerals from the active ship's cargo hold into quantum storage. Storage
// is shared by every station (see emptyStorage), so you can park ore at any
// dock and pick it up anywhere else. Docking is required.
function deposit(state, mineral, amount) {
  const def = materialDefinition(mineral);
  if (!def) return { error: `Unknown mineral: ${mineral}` };
  if (!isDocked(state)) return { error: 'Dock at a station to access storage' };
  const s = clone(state);
  if (!s.storage) s.storage = emptyStorage();
  if (!s.storage.items) s.storage.items = { ...emptyMaterials(), ...(s.storage.minerals || {}) };
  const active = s.ships.find((sh) => sh.id === s.activeShipId);
  if (!active) return { error: 'No active ship' };
  const amt = amount === 'all' ? active.cargo[mineral] : Number(amount);
  if (!Number.isFinite(amt) || amt <= 0) return { error: 'Invalid amount' };
  if (amt > active.cargo[mineral] + 1e-9) return { error: `Not enough ${def.name} in cargo` };
  const moved = Math.min(amt, active.cargo[mineral]);
  active.cargo[mineral] -= moved;
  s.storage.items[mineral] = (s.storage.items[mineral] || 0) + moved;
  return { state: s };
}

function depositAll(state) {
  if (!isDocked(state)) return { error: 'Dock at a station to access storage' };
  const s = clone(state);
  if (!s.storage) s.storage = emptyStorage();
  if (!s.storage.items) s.storage.items = { ...emptyMaterials(), ...(s.storage.minerals || {}) };
  const active = s.ships.find((ship) => ship.id === s.activeShipId);
  if (!active) return { error: 'No active ship' };
  const deposited = Object.values(active.cargo || {}).reduce((sum, amount) => sum + amount, 0);
  if (deposited <= 0) return { error: 'Nothing to deposit' };
  for (const [mineral, amount] of Object.entries(active.cargo)) {
    s.storage.items[mineral] = (s.storage.items[mineral] || 0) + amount;
    active.cargo[mineral] = 0;
  }
  return { state: s };
}

// Move minerals from quantum storage back into the active ship's cargo hold,
// limited by the hold's free space. Docking is required.
function withdraw(state, mineral, amount) {
  const def = materialDefinition(mineral);
  if (!def) return { error: `Unknown mineral: ${mineral}` };
  if (!isDocked(state)) return { error: 'Dock at a station to access storage' };
  const s = clone(state);
  if (!s.storage) s.storage = emptyStorage();
  if (!s.storage.items) s.storage.items = { ...emptyMaterials(), ...(s.storage.minerals || {}) };
  const active = s.ships.find((sh) => sh.id === s.activeShipId);
  if (!active) return { error: 'No active ship' };
  const have = s.storage.items[mineral] || 0;
  const amt = amount === 'all' ? have : Number(amount);
  if (!Number.isFinite(amt) || amt <= 0) return { error: 'Invalid amount' };
  if (amt > have + 1e-9) return { error: `Not enough ${def.name} in storage` };
  const room = shipCargo(active, skillMults(s)) - cargoUsed(s);
  const moved = Math.min(amt, have, Math.max(0, room));
  if (moved <= 0) return { error: 'Cargo hold is full' };
  active.cargo[mineral] += moved;
  s.storage.items[mineral] -= moved;
  return { state: s };
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
  const est = enemyCombatStats(enemy);
  const shipDef = SHIPS[ship.type];
  const mults = skillMults(s);
  const shipShieldMax = (shipDef.shield + moduleBonus(ship, 'shield')) * mults.shield;
  const shipHullMax = (shipDef.hull + moduleBonus(ship, 'armor')) * mults.hull;
  const playerDps = (
    shipDef.dps + moduleBonus(ship, 'weapon') + moduleBonus(ship, 'combatDrone') + droneBonus(s, 'combat')
  ) * mults.dps;
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
  return { state: s };
}

// Perform an in-fight action: shield boost and overload consume one scrap,
// while disengage bails out and lets the rat escape.
// 'overload' (temp DPS boost, item + cooldown) or 'disengage' (bail out, keep
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

// Find a POI by id within a system (station, belt, rat, planet, moon, gate, star).
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
    ship.vx = 0;
    ship.vy = 0;
    return { state: s };
  }

  let target = null;
  if (request && request.kind) {
    const lists = {
      belt: sys.belts,
      station: sys.stations,
      rat: sys.enemies.filter((enemy) => enemy.alive),
    };
    const candidates = lists[request.kind];
    if (!candidates) return { error: 'Unknown navigation target kind' };
    target = candidates.reduce((best, poi) =>
      !best || dist(poi.x, poi.y, ship.x, ship.y) < dist(best.x, best.y, ship.x, ship.y) ? poi : best
    , null);
    if (!target) return { error: `No ${request.kind} in this system` };
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

function setAutopilot(state, mode) {
  if (![null, 'mine', 'mine_hunt', 'hunt'].includes(mode)) return { error: 'Unknown autopilot mode' };
  const s = clone(state);
  s.autoPilotMode = mode;
  recordAutomation(s, mode ? `Auto-pilot set to ${mode.replace('_', '+')}` : 'Auto-pilot stopped');
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
// the same security-based roster as the system's regular rats. Returns the new enemy.
function spawnAmbush(sys, x, y, rng) {
  const { type, tier } = rollRat(sys.security, rng);
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

// ---- missions (story mode pilot training) ----

function missionDef(state) {
  const m = state.mission;
  if (!m || !m.active) return null;
  return MISSIONS[m.active] || null;
}

// Fit a module into the first empty slot of its type (used for mission grants).
function fitGrantModule(ship, slotType, tier) {
  if (!ship || !ship.fitting || !MODULES[slotType]) return false;
  const slots = SHIPS[ship.type].slots[slotType] || 0;
  for (let i = 0; i < slots; i++) {
    if (!ship.fitting[slotType][i]) {
      ship.fitting[slotType][i] = tier;
      return true;
    }
  }
  return false;
}

// Hand the player what a mission grants up front: ships, fitted modules,
// materials and blueprints.
// Ships are granted first so modules fit into the newly active replacement.
function grantMissionRewards(state, def) {
  if (!def) return;
  const g = def.grant || {};
  addStoredItems(state, g.items);
  if (!Array.isArray(state.blueprints)) state.blueprints = [];
  for (const blueprint of g.blueprints || []) {
    state.blueprints.push({ id: nextId(), ...blueprint });
  }
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
      x: clamp(home.x + Math.cos(ang) * rad, 60, sys.width - 60),
      y: clamp(home.y + Math.sin(ang) * rad, 60, sys.height - 60),
      systemId: sys.id,
      dockTargetId: null,
      dockedStationId: null,
      cargo: emptyCargo(),
      fitting: emptyFitting(types[i]),
    };
    state.ships.push(n);
    state.activeShipId = n.id;
  }
}

// Item rewards granted when a mission completes.
function grantCompletionRewards(state, def) {
  if (!def) return;
  const c = def.completion || {};
  addStoredItems(state, c.items);
  if (Array.isArray(c.drones)) {
    const ship = state.ships.find((item) => item.id === state.activeShipId);
    for (const d of c.drones) {
      const slotType = d.type === 'mining' ? 'miningDrone' : d.type === 'combat' ? 'combatDrone' : null;
      if (!slotType) continue;
      if (!fitGrantModule(ship, slotType, d.tier)) {
        if (!Array.isArray(state.loot)) state.loot = [];
        state.loot.push({ id: nextId(), slotType, tier: d.tier });
      }
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

// Place scripted targets near an outpost so hostile activity remains clustered.
function spawnMissionEnemies(state, def) {
  if (!def || !def.spawn) return;
  const ship = state.ships.find((sh) => sh.id === state.activeShipId);
  const sys = state.systems && state.systems[def.systemId || (ship && ship.systemId)];
  if (!sys) return;
  const outpost = (sys.outposts || [])[0];
  const site = outpost || sys.stations[0];
  for (const sp of def.spawn) {
    const eDef = ENEMIES[sp.type];
    if (!eDef) continue;
    for (let i = 0; i < sp.count; i++) {
      const ang = (i / Math.max(1, sp.count)) * Math.PI * 2;
      const rad = 420 + i * 60;
      sys.enemies.push({
        id: nextId(),
        type: eDef.key,
        tier: sp.tier || 'standard',
        missionTag: sp.tag || sp.type,
        x: clamp(site.x + Math.cos(ang) * rad, 60, sys.width - 60),
        y: clamp(site.y + Math.sin(ang) * rad, 60, sys.height - 60),
        outpostId: outpost && outpost.id,
        rangeDelay: sp.rangeDelay || 0,
        alive: true,
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
  state.stats.missionsCompleted = (state.stats.missionsCompleted || 0) + 1;
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
  const d = drone || { mining: 0, dps: 0 };
  return {
    id: ship.id,
    type: ship.type,
    name: def.name,
    x: ship.x,
    y: ship.y,
    vx: ship.vx || 0,
    vy: ship.vy || 0,
    heading: ship.heading || 0,
    speed: Math.hypot(ship.vx || 0, ship.vy || 0),
    systemId: ship.systemId,
    // Effective stats: base stats plus the flat bonus of every fitted module,
    // with drones adding a player-level bonus and trained skills multiplying
    // the result. No level/upgrade system.
    mining: shipMining(ship, mults, d.mining),
    combat: def.combat,
    dps: (def.dps + moduleBonus(ship, 'weapon') + moduleBonus(ship, 'combatDrone') + d.dps) * (mults ? mults.dps : 1),
    shield: (def.shield + moduleBonus(ship, 'shield')) * (mults ? mults.shield : 1),
    hull: (def.hull + moduleBonus(ship, 'armor')) * (mults ? mults.hull : 1),
    cargo: shipCargo(ship, mults),
    slots: def.slots,
    fitting: ship.fitting || emptyFitting(ship.type),
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
    boostItem: COMPONENTS[SHIELD_BOOST_ITEM].name,
    overloadItem: COMPONENTS[OVERLOAD_ITEM].name,
  };
}

function view(state) {
  const active = state.ships.find((sh) => sh.id === state.activeShipId);
  const sys = active && state.systems ? state.systems[active.systemId] : null;
  const mults = skillMults(state);
  const drone = { mining: droneBonus(state, 'mining'), dps: droneBonus(state, 'combat') };
  const materials = active ? { ...emptyMaterials(), ...active.cargo } : emptyMaterials();
  const storageItems = (state.storage && (state.storage.items || state.storage.minerals)) || emptyMaterials();
  const dockedAt = dockedStation(state);
  const progressionMaterials = { ...materials };
  for (const [key, amount] of Object.entries(storageItems)) {
    progressionMaterials[key] = (progressionMaterials[key] || 0) + amount;
  }
  const v = {
    version: state.version,
    mode: state.mode,
    mission: missionView(state),
    agentMission: agentMissionView(state),
    automationLog: state.automationLog || [],
    materials,
    minerals: Object.fromEntries(Object.keys(MINERALS).map((key) => [key, materials[key] || 0])),
    ships: state.ships.map((sh) => shipView(sh, mults, drone)),
    activeShipId: state.activeShipId,
    lastTick: state.lastTick,
    skillPoints: state.skillPoints || 0,
    skillPointRate: SP_RATE_PER_SEC,
    skills: state.skills || emptySkills(),
    skillMults: mults,
    drones: {
      mining: active && active.fitting && (active.fitting.miningDrone || []).some((tier) => tier > 0)
        ? active.fitting.miningDrone.filter((tier) => tier > 0)
        : (state.drones || emptyDroneBay()).mining,
      combat: active && active.fitting && (active.fitting.combatDrone || []).some((tier) => tier > 0)
        ? active.fitting.combatDrone.filter((tier) => tier > 0)
        : (state.drones || emptyDroneBay()).combat,
    },
    droneBonuses: {
      mining: moduleBonus(active, 'miningDrone') + droneBonus(state, 'mining'),
      dps: moduleBonus(active, 'combatDrone') + droneBonus(state, 'combat'),
    },
    loot: (state.loot || []).map((l) => ({
      id: l.id,
      slotType: l.slotType,
      tier: l.tier,
      name: MODULES[l.slotType] ? MODULES[l.slotType].name : l.slotType,
    })),
    blueprints: (state.blueprints || []).map((blueprint) => {
      const definition = blueprint.kind === 'module'
        ? BLUEPRINTS[blueprint.type] && BLUEPRINTS[blueprint.type][blueprint.tier]
        : blueprint.kind === 'ship' ? SHIP_BLUEPRINTS[blueprint.type] : null;
      return { ...blueprint, name: definition ? definition.name : 'Unknown Blueprint' };
    }),
    // Quantum storage (shared by every station) — mirrors of the raw state so
    // the client can render the inventory overlay.
    storage: { items: storageItems },
    combat: state.combat
      ? combatView(state.combat)
      : null,
    combatLog: state.combatLog.slice(),
    stats: { ...state.stats },
    achievements: Object.values(ACHIEVEMENTS).map((achievement) => {
      let progress;
      if (achievement.stat === 'missionsCompleted') progress = state.mission && state.mission.completed ? state.mission.completed.length : 0;
      else progress = state.stats[achievement.stat] || 0;
      return {
        ...achievement,
        progress: Math.min(progress, achievement.target),
        unlocked: progress >= achievement.target,
      };
    }),
    fittingPresets: state.fittingPresets || [],
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
          outposts: sys.outposts || [],
          belts: sys.belts,
          asteroids: sys.asteroids,
          enemies: sys.enemies.map((enemy) => {
            const stats = enemyCombatStats(enemy);
            const tier = ENEMY_TIERS[enemy.tier] || ENEMY_TIERS.standard;
            return {
              ...enemy,
              tier: tier.key,
              tierName: tier.name,
              shield: stats.shield,
              hull: stats.hull,
              dps: stats.dps,
              difficulty: active ? estimateCombatDifficulty(state, active, enemy) : { key: 'unknown', label: 'Unknown', ratio: null },
            };
          }),
          gates: sys.gates,
          security: sys.security,
        }
      : null,
    system: sys ? { id: sys.id, name: sys.name, color: sys.color, security: sys.security, gates: sys.gates } : null,
    systemNames: Object.values(state.systems).map((s) => ({ id: s.id, name: s.name, color: s.color, security: s.security })),
    // Gate-ambush chance by destination system security.
    ambush: Object.fromEntries(
      Object.values(state.systems).map((s) => [s.id, ambushChance(state, s.id)])
    ),
  };
  v.activeShip = active ? shipView(active, mults, drone) : null;
  v.docked = !!dockedAt;
  v.dockedStation = dockedAt ? dockedAt.name : null;
  v.dockTargetId = active ? active.dockTargetId || null : null;
  v.navigation = active && active.navigation ? { ...active.navigation } : null;
  v.autoPilotMode = state.autoPilotMode || null;
  v.skillTraining = skillTrainingView(state);
  v.shipProgression = shipProgressionView(state, progressionMaterials, v.docked);
  v.actionAvailability = actionAvailability(state, progressionMaterials, v.docked, active);
  v.cargoUsed = cargoUsed(state);
  v.cargoCapacity = cargoCapacity(state);
  v.cargoFull = v.cargoCapacity > 0 && v.cargoUsed >= v.cargoCapacity;
  v.miningPaused = active ? shipInCombat(state, active.id) : true;
  v.miningRange = active ? miningRange(active) : MINING_RANGE;
  v.miningRate = 0;
  v.miningTargetId = null;
  if (active && !v.miningPaused) {
    const t = nearestAsteroidInRange(state, active);
    if (t) {
      v.miningRate = shipMining(active, mults, drone.mining);
      v.miningTargetId = t.id;
    }
  }
  if (active && sys) {
    const nearestStation = sys.stations
      .map((station) => ({ station, distance: dist(active.x, active.y, station.x, station.y) }))
      .sort((a, b) => a.distance - b.distance)[0];
    const nearestGate = sys.gates
      .map((gate) => ({ gate, distance: dist(active.x, active.y, gate.x, gate.y) }))
      .filter((entry) => entry.distance <= GATE_RANGE)
      .sort((a, b) => a.distance - b.distance)[0];
    const nearestEnemy = sys.enemies
      .filter((enemy) => enemy.alive)
      .map((enemy) => ({ enemy, distance: dist(active.x, active.y, enemy.x, enemy.y) }))
      .filter((entry) => entry.distance <= ENGAGE_RANGE)
      .sort((a, b) => a.distance - b.distance)[0];
    v.nearby = {
      stationId: nearestStation ? nearestStation.station.id : null,
      stationDistance: nearestStation ? nearestStation.distance : null,
      gateId: nearestGate ? nearestGate.gate.id : null,
      enemyId: nearestEnemy ? nearestEnemy.enemy.id : null,
    };
  } else {
    v.nearby = { stationId: null, stationDistance: null, gateId: null, enemyId: null };
  }
  return v;
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
  ENEMIES,
  ENEMY_TIERS,
  spawnTable,
  DRONES,
  ACHIEVEMENTS,
  AGENT_MISSIONS,
  BLUEPRINTS,
  SHIP_BLUEPRINTS,
  createInitialState,
  migrateEconomy,
  isValidState,
  migrateWorldLayout,
  evaluateMission,
  missionView,
  missionAction,
  agentMissionAction,
  spawnMissionEnemies,
  startMission,
  missionStartNeeded,
  MISSIONS,
  MISSION_ORDER,
  tick,
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
  buyBlueprint,
  exchangeItems,
  equipLoot,
  refineLoot,
  craftModule,
  deposit,
  depositAll,
  withdraw,
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
  rollRat,
  enemyCombatStats,
  estimateCombatDifficulty,
  activeSystem,
  generateSystems,
  resetIds,
};
