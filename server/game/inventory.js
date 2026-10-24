'use strict';

const { MINERALS, COMPONENTS } = require('../config');
const {
  clone,
  emptyMaterials,
  emptyStorage,
  materialDefinition,
  isDocked,
  cargoUsed,
} = require('./state');

function deposit(state, mineral, amount) {
  const definition = materialDefinition(mineral);
  if (!definition) return { error: `Unknown mineral: ${mineral}` };
  if (!isDocked(state)) return { error: 'Dock at a station to access storage' };
  const next = clone(state);
  if (!next.storage) next.storage = emptyStorage();
  if (!next.storage.items) next.storage.items = { ...emptyMaterials(), ...(next.storage.minerals || {}) };
  const active = next.ships.find((ship) => ship.id === next.activeShipId);
  if (!active) return { error: 'No active ship' };
  const requested = amount === 'all' ? active.cargo[mineral] : Number(amount);
  if (!Number.isFinite(requested) || requested <= 0) return { error: 'Invalid amount' };
  if (requested > active.cargo[mineral] + 1e-9) return { error: `Not enough ${definition.name} in cargo` };
  const moved = Math.min(requested, active.cargo[mineral]);
  active.cargo[mineral] -= moved;
  next.storage.items[mineral] = (next.storage.items[mineral] || 0) + moved;
  return { state: next };
}

function depositAll(state) {
  if (!isDocked(state)) return { error: 'Dock at a station to access storage' };
  const next = clone(state);
  if (!next.storage) next.storage = emptyStorage();
  if (!next.storage.items) next.storage.items = { ...emptyMaterials(), ...(next.storage.minerals || {}) };
  const active = next.ships.find((ship) => ship.id === next.activeShipId);
  if (!active) return { error: 'No active ship' };
  const deposited = Object.values(active.cargo || {}).reduce((sum, amount) => sum + amount, 0);
  if (deposited <= 0) return { error: 'Nothing to deposit' };
  for (const [mineral, amount] of Object.entries(active.cargo)) {
    next.storage.items[mineral] = (next.storage.items[mineral] || 0) + amount;
    active.cargo[mineral] = 0;
  }
  return { state: next };
}

function depositFiltered(state, filter) {
  if (!isDocked(state)) return { error: 'Dock at a station to access storage' };
  if (!['all', 'ore', 'components', 'loot', 'blueprints'].includes(filter)) {
    return { error: `Unknown cargo filter: ${filter}` };
  }
  const next = clone(state);
  if (!next.storage) next.storage = emptyStorage();
  if (!next.storage.items) next.storage.items = { ...emptyMaterials(), ...(next.storage.minerals || {}) };
  if (!Array.isArray(next.storage.loot)) next.storage.loot = [];
  if (!Array.isArray(next.storage.blueprints)) next.storage.blueprints = [];
  const active = next.ships.find((ship) => ship.id === next.activeShipId);
  if (!active) return { error: 'No active ship' };

  let moved = 0;
  if (['all', 'ore', 'components'].includes(filter)) {
    const keys = filter === 'ore'
      ? Object.keys(MINERALS)
      : filter === 'components'
        ? Object.keys(COMPONENTS)
        : [...Object.keys(MINERALS), ...Object.keys(COMPONENTS)];
    for (const key of keys) {
      const amount = active.cargo[key] || 0;
      if (amount <= 0) continue;
      next.storage.items[key] = (next.storage.items[key] || 0) + amount;
      active.cargo[key] = 0;
      moved++;
    }
  }
  for (const kind of ['loot', 'blueprints']) {
    if (filter !== 'all' && filter !== kind) continue;
    const items = next[kind] || [];
    if (!Array.isArray(next[kind])) next[kind] = [];
    next.storage[kind].push(...items);
    moved += items.length;
    next[kind] = [];
  }
  if (moved === 0) return { error: 'No visible cargo items to store' };
  return { state: next };
}

function withdraw(state, mineral, amount, { shipCargo, skillMults }) {
  const definition = materialDefinition(mineral);
  if (!definition) return { error: `Unknown mineral: ${mineral}` };
  if (!isDocked(state)) return { error: 'Dock at a station to access storage' };
  const next = clone(state);
  if (!next.storage) next.storage = emptyStorage();
  if (!next.storage.items) next.storage.items = { ...emptyMaterials(), ...(next.storage.minerals || {}) };
  const active = next.ships.find((ship) => ship.id === next.activeShipId);
  if (!active) return { error: 'No active ship' };
  const have = next.storage.items[mineral] || 0;
  const requested = amount === 'all' ? have : Number(amount);
  if (!Number.isFinite(requested) || requested <= 0) return { error: 'Invalid amount' };
  if (requested > have + 1e-9) return { error: `Not enough ${definition.name} in storage` };
  const room = shipCargo(active, skillMults(next)) - cargoUsed(next);
  const moved = Math.min(requested, have, Math.max(0, room));
  if (moved <= 0) return { error: 'Cargo hold is full' };
  active.cargo[mineral] += moved;
  next.storage.items[mineral] -= moved;
  return { state: next };
}

function transferStoredItem(state, kind, id, direction) {
  if (!isDocked(state)) return { error: 'Dock at a station to access storage' };
  if (!['loot', 'blueprints'].includes(kind)) return { error: `Unknown stored item type: ${kind}` };
  if (typeof id !== 'string' || !id) return { error: 'Invalid item id' };
  const next = clone(state);
  if (!next.storage) next.storage = emptyStorage();
  if (!Array.isArray(next.storage[kind])) next.storage[kind] = [];
  if (!Array.isArray(next[kind])) next[kind] = [];
  const source = direction === 'store' ? next : next.storage;
  const destination = direction === 'store' ? next.storage : next;
  const index = source[kind].findIndex((item) => item && item.id === id);
  if (index < 0) {
    return { error: direction === 'store' ? 'Item not found in inventory' : 'Item not found in storage' };
  }
  destination[kind].push(source[kind].splice(index, 1)[0]);
  return { state: next };
}

function storeInventoryItem(state, kind, id) {
  return transferStoredItem(state, kind, id, 'store');
}

function retrieveInventoryItem(state, kind, id) {
  return transferStoredItem(state, kind, id, 'retrieve');
}

module.exports = {
  deposit,
  depositAll,
  depositFiltered,
  withdraw,
  storeInventoryItem,
  retrieveInventoryItem,
};
