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
} = require('../config');

function autoEfficiency(state) {
  return state && state.autoPilotMode ? AUTOPILOT_EFFICIENCY : 1;
}

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
  return (SHIPS[ship.type].dps + moduleBonus(ship, 'weapon') + moduleBonus(ship, 'combatDrone') + drone) *
    (mults ? mults.dps : 1);
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

function moduleBonus(ship, slotType) {
  const fit = ship && ship.fitting && ship.fitting[slotType];
  if (!fit) return 0;
  const tiers = MODULES[slotType] && MODULES[slotType].tiers;
  if (!tiers) return 0;
  return fit.reduce((sum, tier) => sum + (tier > 0 ? tiers[tier - 1].bonus : 0), 0);
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
  const multipliers = { mining: 1, cargo: 1, dps: 1, shield: 1, hull: 1 };
  const skills = state.skills || {};
  for (const key of Object.keys(SKILLS)) {
    const def = SKILLS[key];
    const level = skills[key] || 0;
    if (level > 0) multipliers[def.effect.stat] *= 1 + def.effect.pctPerLevel * level;
  }
  return multipliers;
}

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
  moduleBonus,
  emptyFitting,
  skillMults,
  skillCost,
  skillTrainingView,
  shipProgressionView,
  emptySkills,
  emptyDroneBay,
  droneBonus,
};
