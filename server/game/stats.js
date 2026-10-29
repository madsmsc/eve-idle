'use strict';

const {
  SHIPS,
  MODULES,
  SHIP_BLUEPRINTS,
  SHIP_PROGRESSION,
  MINING_RATE_MULTIPLIER,
  MINING_RANGE,
  SKILLS,
  DRONES,
  AUTOPILOT_EFFICIENCY,
  MAX_SPEED,
  MAX_ACCELERATION,
} = require('../config');

function autoEfficiency(state) {
  return state && state.autoPilotMode ? AUTOPILOT_EFFICIENCY : 1;
}

function shipMining(ship, mults, drone = 0, skills = null) {
  const definition = SHIPS[ship.type];
  const droneMining = (moduleBonus(ship, 'miningDrone', skills, mults) + drone) *
    (mults ? mults.miningDrone || 1 : 1);
  return (definition.mining +
    moduleBonus(ship, 'mining', skills, mults) +
    droneMining) *
    (mults ? mults.mining : 1) *
    (mults ? mults.miningCycle || 1 : 1) *
    MINING_RATE_MULTIPLIER;
}

function miningRange(ship, mults, skills = null) {
  return (MINING_RANGE + moduleBonus(ship, 'mining', skills, mults)) *
    (mults ? mults.miningRange || 1 : 1);
}

function shipCombat(ship) {
  return SHIPS[ship.type].combat;
}

function shipDps(ship, mults, drone = 0, skills = null) {
  const definition = SHIPS[ship.type];
  const weaponSkill = definition.weaponType ? mults && mults[`${definition.weaponType}Dps`] || 1 : 1;
  const genericWeapon = moduleBonus(ship, 'weapon', skills, mults);
  const variantWeapon = moduleBonus(ship, definition.weaponSlot, skills, mults);
  const rawDroneDamage = moduleBonus(ship, 'combatDrone', skills, mults) + drone;
  const hullWeaponDamage = definition.weaponType === 'drone'
    ? (definition.dps + genericWeapon + variantWeapon + rawDroneDamage) * weaponSkill
    : (definition.dps + genericWeapon + variantWeapon) * weaponSkill +
      rawDroneDamage * (mults ? mults.droneDps || 1 : 1);
  return hullWeaponDamage * (mults ? mults.dps : 1);
}

function shipShield(ship, mults, skills = null) {
  return (SHIPS[ship.type].shield + moduleBonus(ship, 'shield', skills, mults)) * (mults ? mults.shield : 1);
}

function shipHull(ship, mults, skills = null) {
  return (SHIPS[ship.type].hull + moduleBonus(ship, 'armor', skills, mults)) * (mults ? mults.hull : 1);
}

function shipCargo(ship, mults, skills = null) {
  return (SHIPS[ship.type].cargo + moduleBonus(ship, 'cargo', skills, mults)) * (mults ? mults.cargo : 1);
}

function moduleRequirements(slotType, tier) {
  const definition = MODULES[slotType];
  if (!definition || tier <= 1) return [];
  const skill = definition.skill || ({
    weapon: 'gunnery',
    shield: 'shieldUpgrades',
    armor: 'hullUpgrades',
    mining: 'miningYield',
    cargo: 'cargoManagement',
    range: 'gunnery',
    miningDrone: 'miningDrones',
    combatDrone: 'droneDamage',
  })[slotType];
  const requirements = [{ skill, level: tier - 1 }, { skill: 'moduleEngineering', level: tier - 1 }];
  return requirements.filter((requirement) => requirement.skill && SKILLS[requirement.skill]);
}

function moduleBonus(ship, slotType, skills = null, mults = null) {
  const fit = ship && ship.fitting && ship.fitting[slotType];
  if (!fit) return 0;
  const tiers = MODULES[slotType] && MODULES[slotType].tiers;
  if (!tiers) return 0;
  const bonus = fit.reduce((sum, tier) => {
    if (tier <= 0) return sum;
    const locked = skills && moduleRequirements(slotType, tier).some(({ skill, level }) =>
      (skills[skill] || 0) < level
    );
    return sum + (locked ? 0 : tiers[tier - 1].bonus);
  }, 0);
  return bonus * (mults ? mults.moduleEffectiveness || 1 : 1);
}

function emptyFitting(type) {
  const slots = SHIPS[type].slots;
  const fitting = {};
  for (const slotType of Object.keys(slots)) {
    fitting[slotType] = new Array(slots[slotType]).fill(0);
  }
  return fitting;
}

function skillMults(state) {
  const multipliers = {};
  for (const def of Object.values(SKILLS)) {
    if (def.effect) multipliers[def.effect.stat] = 1;
  }
  const skills = state.skills || {};
  for (const key of Object.keys(SKILLS)) {
    const def = SKILLS[key];
    const level = skills[key] || 0;
    if (level > 0 && def.effect) multipliers[def.effect.stat] *= 1 + def.effect.pctPerLevel * level;
  }
  return multipliers;
}

function shipMaxSpeed(ship, mults) {
  const definition = ship && SHIPS[ship.type];
  return MAX_SPEED * (definition && definition.speedMultiplier || 1) * (mults ? mults.speed || 1 : 1);
}

function shipMaxAcceleration(ship, mults) {
  return MAX_ACCELERATION * (mults ? mults.acceleration || 1 : 1);
}

function skillCost(def, currentLevel) {
  return Math.round(def.baseCost * Math.pow(def.costGrowth, currentLevel));
}

function skillTrainingView(state) {
  return Object.fromEntries(Object.entries(SKILLS).map(([key, def]) => {
    const level = (state.skills && state.skills[key]) || 0;
    const maxed = level >= def.maxLevel;
    const cost = maxed ? 0 : skillCost(def, level);
    const missingRequirements = def.requirements.filter(({ skill, level: required }) =>
      ((state.skills && state.skills[skill]) || 0) < required
    );
    const requirementsMet = missingRequirements.length === 0;
    return [key, {
      level,
      cost,
      maxed,
      canTrain: !maxed && requirementsMet && (state.skillPoints || 0) >= cost,
      requirementsMet,
      missingRequirements,
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
    const blueprintReady = entry.type === 'rifter' ||
      [...(state.blueprints || []), ...((state.storage && state.storage.blueprints) || [])].some((item) =>
        item.kind === 'ship' && item.type === entry.type
      );
    return [entry.type, {
      skillsReady,
      materialsReady,
      blueprintReady,
      canBuild: entry.type !== 'rifter' && docked && skillsReady && materialsReady && blueprintReady,
      materials: blueprint ? { ...blueprint.recipe } : {},
      materialCounts,
      missingSkills: entry.skills.filter(({ skill, level }) =>
        ((state.skills && state.skills[skill]) || 0) < level
      ),
    }];
  })));
}

function emptySkills() {
  return Object.fromEntries(Object.keys(SKILLS).map((key) => [key, 0]));
}

function emptyDroneBay() {
  return Object.fromEntries(Object.keys(DRONES).map((key) => [key, []]));
}

function droneBonus(state, droneType) {
  const def = DRONES[droneType];
  const bay = state && state.drones && state.drones[droneType];
  const active = state && state.ships && state.ships.find((ship) => ship.id === state.activeShipId);
  const fittedSlot = droneType === 'mining' ? 'miningDrone' : 'combatDrone';
  if (active && active.fitting && active.fitting[fittedSlot] && active.fitting[fittedSlot].some((tier) => tier > 0)) return 0;
  if (!def || !Array.isArray(bay)) return 0;
  return bay.reduce((sum, tier) => sum + (tier > 0 ? def.tiers[tier - 1].bonus : 0), 0);
}

module.exports = {
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
};
