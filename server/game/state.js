'use strict';

const { MINERALS, COMPONENTS, DOCK_RANGE } = require('../config');

function clone(state) {
  return JSON.parse(JSON.stringify(state));
}

function dist(ax, ay, bx, by) {
  return Math.hypot(ax - bx, ay - by);
}

function emptyMaterials() {
  return Object.fromEntries([...Object.keys(MINERALS), ...Object.keys(COMPONENTS)].map((key) => [key, 0]));
}

function emptyCargo() {
  return emptyMaterials();
}

function emptyStorage() {
  return { items: emptyMaterials(), loot: [], blueprints: [] };
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

function cargoUsed(state) {
  const active = state.ships.find((ship) => ship.id === state.activeShipId);
  return active ? Object.values(active.cargo).reduce((sum, amount) => sum + amount, 0) : 0;
}

function activeSystem(state) {
  const ship = state.ships.find((item) => item.id === state.activeShipId);
  return ship && state.systems ? state.systems[ship.systemId] || null : null;
}

function dockedStation(state) {
  const ship = state.ships.find((item) => item.id === state.activeShipId);
  const system = activeSystem(state);
  if (!ship || !system) return null;
  if (ship.dockedStationId !== undefined) {
    const station = system.stations.find((item) => item.id === ship.dockedStationId);
    return station && dist(ship.x, ship.y, station.x, station.y) <= DOCK_RANGE ? station : null;
  }

  let nearest = null;
  let nearestDistance = Infinity;
  for (const station of system.stations) {
    const distance = dist(ship.x, ship.y, station.x, station.y);
    if (distance <= DOCK_RANGE && distance < nearestDistance) {
      nearestDistance = distance;
      nearest = station;
    }
  }
  return nearest;
}

function isDocked(state) {
  return !!dockedStation(state);
}

module.exports = {
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
};
