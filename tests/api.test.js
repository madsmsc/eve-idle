'use strict';

const { test, describe, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { createApp } = require('../server/index');
const cfg = require('../server/config');

function tmpDataFile() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'eve-idle-'));
  return path.join(dir, 'state.json');
}

async function startServer(dataFile, options = {}) {
  const app = createApp({ dataFile, ...options });
  await new Promise((resolve) => app.server.listen(0, resolve));
  const { port } = app.server.address();
  return { app, base: `http://127.0.0.1:${port}`, close: () => app.close() };
}

async function api(base, pathName, body) {
  const opts = { method: body ? 'POST' : 'GET', headers: {} };
  if (body) {
    opts.headers['Content-Type'] = 'application/json';
    opts.body = JSON.stringify(body);
  }
  const res = await fetch(base + pathName, opts);
  const text = await res.text();
  let data;
  try { data = JSON.parse(text); } catch { data = text; }
  return { status: res.status, data };
}

// Navigate using a server-side intent and wait until the authoritative ship
// position reaches the destination.
async function flyTo(base, x, y, maxIters = 80) {
  let st = (await api(base, '/api/state')).data.state;
  if (st.docked) {
    const launched = await api(base, '/api/launch', {});
    assert.equal(launched.status, 200);
    st = launched.data.state;
  }
  const navigation = await api(base, '/api/navigate', { x, y });
  assert.equal(navigation.status, 200);
  for (let i = 0; i < maxIters; i++) {
    await new Promise((resolve) => setTimeout(resolve, 200));
    st = (await api(base, '/api/tick', {})).data.state;
    const ship = st.ships.find((s) => s.id === st.activeShipId);
    if (Math.hypot(x - ship.x, y - ship.y) < 160) return st;
  }
  return st;
}

describe('HTTP API', () => {
  let srv;
  beforeEach(async () => {
    srv = await startServer(tmpDataFile());
  });
  afterEach(async () => {
    await srv.close();
  });

  test('GET /health returns ok', async () => {
    const r = await api(srv.base, '/health');
    assert.equal(r.status, 200);
    assert.equal(r.data.ok, true);
  });

  test('GET /api/state returns a spatial state with a world', async () => {
    const r = await api(srv.base, '/api/state');
    assert.equal(r.status, 200);
    const s = r.data.state;
    assert.ok(s.world);
    assert.ok(s.world.asteroids.length > 0);
    assert.ok(s.world.enemies.length > 0);
    assert.equal(s.world.belts.length, 2);
    assert.equal(s.world.outposts.length, 2);
    assert.ok(s.activeShip);
    assert.ok(Number.isFinite(s.activeShip.x));
  });

  test('GET /api/catalog exposes ships, item ladders, enemies and constants', async () => {
    const r = await api(srv.base, '/api/catalog');
    assert.equal(r.status, 200);
    assert.ok(r.data.ships.rifter);
    assert.ok(r.data.minerals.iron);
    assert.ok(r.data.enemies.pirate);
    assert.ok(r.data.components.scrap);
    assert.deepEqual(r.data.oreExchange, ['iron', 'bauxite', 'gadolinium', 'megacyte']);
    assert.ok(r.data.shipProgression.some((tier) => tier.ships.some((ship) => ship.type === 'brutix')));
    assert.deepEqual(r.data.npcBlueprints, Object.keys(cfg.MODULES).map((slotType) => `module:${slotType}:1`));
    assert.ok(r.data.achievements.miner);
    assert.equal(r.data.constants.worldSize, cfg.WORLD_SIZE);
    assert.ok(r.data.constants.miningRange > 0);
  });

  test('POST /api/refine-loot salvages a module into a component', async () => {
    const initial = srv.app.getState();
    initial.loot = [{ id: 'refine-me', slotType: 'shield', tier: 3 }];
    srv.app.setState(initial);
    const refined = await api(srv.base, '/api/refine-loot', { lootId: 'refine-me' });
    assert.equal(refined.status, 200);
    assert.equal(refined.data.state.loot.length, 0);
    assert.equal(refined.data.state.storage.items.circuits, 1);
  });

  test('GET /api/state exposes materials and ambush risk without reputation', async () => {
    const r = await api(srv.base, '/api/state');
    assert.equal(r.status, 200);
    const s = r.data.state;
    assert.ok(s.materials.iron >= 0);
    assert.ok(s.storage.items.scrap >= 0);
    assert.equal(s.standing, undefined);
    assert.equal(s.isk, undefined);
    assert.ok(s.ambush && Object.keys(s.ambush).length === 3);
    assert.ok(s.skillTraining.gunnery);
    assert.equal(typeof s.shipProgression.falcon.canBuild, 'boolean');
    assert.equal(s.agentMission.agents.length, 3);
    assert.equal(s.agentMission.station.name, s.dockedStation);
  });

  test('agent missions are station-specific and can be accepted from multiple agents', async () => {
    const state = (await api(srv.base, '/api/state')).data.state;
    const [security, mining] = state.agentMission.agents;
    const first = await api(srv.base, '/api/agent-mission', { action: 'accept', agentId: security.id });
    assert.equal(first.status, 200);
    const second = await api(srv.base, '/api/agent-mission', { action: 'accept', agentId: mining.id });
    assert.equal(second.status, 200);
    assert.equal(second.data.state.agentMission.active.length, 2);

    await api(srv.base, '/api/launch', {});
    const rejected = await api(srv.base, '/api/agent-mission', { action: 'accept', agentId: security.id });
    assert.equal(rejected.status, 400);
    assert.match(rejected.data.error, /dock/i);
  });

  test('POST /api/tick advances movement from server navigation and ignores client positions', async () => {
    const before = (await api(srv.base, '/api/state')).data.state;
    const launch = await api(srv.base, '/api/launch', {});
    assert.equal(launch.status, 200);
    const target = { x: launch.data.state.activeShip.x + 1000, y: launch.data.state.activeShip.y };
    const nav = await api(srv.base, '/api/navigate', target);
    assert.equal(nav.status, 200);
    await new Promise((resolve) => setTimeout(resolve, 100));
    const r = await api(srv.base, '/api/tick', { x: 0, y: 0 });
    assert.equal(r.status, 200);
    assert.ok(r.data.state.lastTick >= before.lastTick);
    assert.ok(r.data.state.activeShip.x > launch.data.state.activeShip.x);
    assert.ok(r.data.state.activeShip.x > 0);
  });

  test('autopilot selects targets and launches on the server', async () => {
    const enabled = await api(srv.base, '/api/autopilot', { mode: 'mine' });
    assert.equal(enabled.status, 200);
    await new Promise((resolve) => setTimeout(resolve, 200));
    const updated = await api(srv.base, '/api/tick', {});
    assert.equal(updated.data.state.autoPilotMode, 'mine');
    assert.equal(updated.data.state.docked, false);
    assert.ok(updated.data.state.navigation);
    assert.ok(updated.data.state.automationLog.length > 0);
    const selectedTarget = updated.data.state.navigation;
    await new Promise((resolve) => setTimeout(resolve, 200));
    const continued = await api(srv.base, '/api/tick', {});
    assert.deepEqual(continued.data.state.navigation, selectedTarget);
  });

  test('NPCs sell basic module blueprints but not higher-tier or ship blueprints', async () => {
    const basic = await api(srv.base, '/api/buy-blueprint', { kind: 'module', type: 'weapon', tier: 1 });
    assert.equal(basic.status, 200);
    assert.equal(basic.data.state.blueprints[0].kind, 'module');
    const higherTier = await api(srv.base, '/api/buy-blueprint', { kind: 'module', type: 'weapon', tier: 2 });
    assert.equal(higherTier.status, 400);
    assert.match(higherTier.data.error, /rat loot/i);
    const ship = await api(srv.base, '/api/buy-blueprint', { kind: 'ship', type: 'falcon' });
    assert.equal(ship.status, 400);
    assert.match(ship.data.error, /rat loot/i);
  });

  test('world enemies expose an approximate difficulty for the active ship', async () => {
    const r = await api(srv.base, '/api/state');
    assert.ok(r.data.state.world.enemies.every((enemy) =>
      ['Favorable', 'Even', 'Dangerous', 'Deadly', 'Unknown'].includes(enemy.difficulty.label)
    ));
  });

  test('POST /api/craft-ship builds a ship using a found blueprint and materials', async () => {
    const state = srv.app.getState();
    state.skills.miningYield = 1;
    state.storage.blueprints.push({ id: 'found-falcon', kind: 'ship', type: 'falcon', tier: null });
    srv.app.setState(state);
    const r = await api(srv.base, '/api/craft-ship', { type: 'falcon', blueprintId: 'found-falcon' });
    assert.equal(r.status, 200);
    assert.equal(r.data.state.ships.length, 2);
    assert.equal(r.data.state.storage.blueprints.length, 0);
  });

  test('POST /api/exchange-items trades a 3:1 material stack', async () => {
    const r = await api(srv.base, '/api/exchange-items', {
      family: 'ore',
      item: 'iron',
      amount: 6,
    });
    assert.equal(r.status, 200);
    assert.equal(r.data.state.storage.items.iron, 12);
    assert.equal(r.data.state.storage.items.bauxite, 2);
  });

  test('legacy direct ship purchase action is removed', async () => {
    const r = await api(srv.base, '/api/buy-ship', { type: 'falcon' });
    assert.equal(r.status, 400);
    assert.ok(r.data.error);
  });

  test('POST /api/engage rejects out-of-range target (400)', async () => {
    const st = (await api(srv.base, '/api/state')).data.state;
    const e = st.world.enemies[0];
    // Park the ship in open space (not docked), far from the target.
    await api(srv.base, '/api/warp', { x: 200, y: 200 });
    const after = (await api(srv.base, '/api/state')).data.state;
    const ship = after.ships.find((s) => s.id === after.activeShipId);
    if (Math.hypot(e.x - ship.x, e.y - ship.y) <= cfg.ENGAGE_RANGE) {
      await api(srv.base, '/api/warp', { x: cfg.WORLD_SIZE - 200, y: 200 });
    }
    const r = await api(srv.base, '/api/engage', { enemyId: e.id });
    assert.equal(r.status, 400);
    assert.match(r.data.error, /range/i);
  });

  test('POST /api/engage works in range after flying to the target', async () => {
    const st = (await api(srv.base, '/api/state')).data.state;
    const e = st.world.enemies[0];
    await flyTo(srv.base, e.x, e.y);
    const r = await api(srv.base, '/api/engage', { enemyId: e.id });
    assert.equal(r.status, 200);
    assert.ok(r.data.state.combat);
    assert.equal(r.data.state.combat.enemyId, e.id);
  });

  test('POST /api/engage exposes the range free-fire window for short-range enemies', async () => {
    // Turn a rat into a mission-style short-range frigate (stats on the object,
    // like spawnMissionEnemies does) and engage it through the API.
    const st = srv.app.getState();
    const e = st.systems[st.ships[0].systemId].enemies[0];
    Object.assign(e, { type: 'shortrange', shield: 45, hull: 90, dps: 12, rangeDelay: 2 });
    st.ships[0].x = e.x;
    st.ships[0].y = e.y;
    srv.app.setState(st);
    const r = await api(srv.base, '/api/engage', { enemyId: e.id });
    assert.equal(r.status, 200);
    assert.equal(r.data.state.combat.enemyRangeDelay, 2);
  });

  test('POST /api/combat-action rejects when not in combat (400)', async () => {
    const r = await api(srv.base, '/api/combat-action', { action: 'disengage' });
    assert.equal(r.status, 400);
    assert.match(r.data.error, /not in combat/i);
  });

  test('POST /api/combat-action disengages and keeps the ship', async () => {
    const st = (await api(srv.base, '/api/state')).data.state;
    const e = st.world.enemies[0];
    await flyTo(srv.base, e.x, e.y);
    const engaged = await api(srv.base, '/api/engage', { enemyId: e.id });
    assert.equal(engaged.status, 200);
    const shipsBefore = engaged.data.state.ships.length;
    const r = await api(srv.base, '/api/combat-action', { action: 'disengage' });
    assert.equal(r.status, 200);
    assert.equal(r.data.state.combat, null);
    assert.equal(r.data.state.ships.length, shipsBefore, 'ship survives disengage');
    assert.equal(r.data.state.combatLog[0].disengaged, true);
  });

  test('POST /api/fit-module fits a module from inventory', async () => {
    const st = srv.app.getState();
    const shipId = st.activeShipId;
    st.loot.push({ id: 'weapon-inventory', slotType: 'weapon', tier: 1 });
    srv.app.setState(st);
    const r = await api(srv.base, '/api/fit-module', { shipId, slotType: 'weapon', slotIndex: 0, tier: 1 });
    assert.equal(r.status, 200);
    const ship = r.data.state.ships.find((s) => s.id === shipId);
    assert.equal(ship.fitting.weapon[0], 1);
    assert.equal(r.data.state.loot.length, 0);
  });

  test('GET /api/state explains and disables fitting modules above trained skill', async () => {
    const state = srv.app.getState();
    const ship = state.ships.find((item) => item.id === state.activeShipId);
    state.loot.push({ id: 'mining-tier-4', slotType: 'mining', tier: 4 });
    srv.app.setState(state);

    const result = await api(srv.base, '/api/state');
    const key = `${ship.id}:mining:0:4`;

    assert.equal(result.data.state.actionAvailability.fitting[key], false);
    assert.equal(result.data.state.actionAvailability.fittingReasons[key], 'Requires Mining Yield level 3.');
    assert.equal(result.data.state.actionAvailability.loot['mining-tier-4'].canEquip, false);
    assert.equal(result.data.state.actionAvailability.loot['mining-tier-4'].equipReason, 'Requires Mining Yield level 3.');

    const fit = await api(srv.base, '/api/fit-module', {
      shipId: ship.id,
      slotType: 'mining',
      slotIndex: 0,
      tier: 4,
    });
    assert.equal(fit.status, 400);
    assert.equal(fit.data.error, 'Requires Mining Yield level 3');
  });

  test('saving fitting presets is no longer available', async () => {
    const result = await api(srv.base, '/api/save-fitting-preset', { name: 'Old fit' });
    assert.equal(result.status, 400);
    assert.equal(result.data.error, 'Unknown action: save-fitting-preset');
  });

  test('POST /api/unequip-all returns fitted modules to inventory', async () => {
    const state = srv.app.getState();
    const ship = state.ships.find((item) => item.id === state.activeShipId);
    ship.fitting.weapon[0] = 2;
    ship.fitting.shield[0] = 1;
    srv.app.setState(state);

    const before = (await api(srv.base, '/api/state')).data.state;
    assert.equal(before.actionAvailability.canUnequipAll, true);
    assert.equal(before.actionAvailability.unequipAllReason, '');
    const result = await api(srv.base, '/api/unequip-all', {});

    assert.equal(result.status, 200);
    assert.equal(result.data.state.activeShip.fitting.weapon[0], 0);
    assert.equal(result.data.state.activeShip.fitting.shield[0], 0);
    assert.deepEqual(
      result.data.state.loot.map(({ slotType, tier }) => ({ slotType, tier })),
      [{ slotType: 'weapon', tier: 2 }, { slotType: 'shield', tier: 1 }],
    );
    assert.equal(result.data.state.actionAvailability.canUnequipAll, false);
  });

  test('POST /api/unequip-all requires docking', async () => {
    const state = srv.app.getState();
    const ship = state.ships.find((item) => item.id === state.activeShipId);
    ship.x = 200;
    ship.y = 200;
    ship.dockedStationId = null;
    ship.dockTargetId = null;
    ship.fitting.weapon[0] = 1;
    srv.app.setState(state);

    const result = await api(srv.base, '/api/unequip-all', {});
    assert.equal(result.status, 400);
    assert.match(result.data.error, /dock at a station/i);
    const stateAfter = (await api(srv.base, '/api/state')).data.state;
    assert.equal(stateAfter.actionAvailability.canUnequipAll, false);
    assert.equal(stateAfter.actionAvailability.unequipAllReason, 'Dock at a station to unequip modules.');
  });

  test('POST /api/fit-module rejects a slot type the ship has none of (400)', async () => {
    const st = (await api(srv.base, '/api/state')).data.state;
    const r = await api(srv.base, '/api/fit-module', { shipId: st.activeShipId, slotType: 'armor', slotIndex: 0, tier: 1 });
    assert.equal(r.status, 400);
    assert.ok(r.data.error);
  });

  test('POST /api/train-skill exposes skill state and rejects without skill points (400)', async () => {
    const st = (await api(srv.base, '/api/state')).data.state;
    assert.ok(Number.isFinite(st.skillPoints));
    assert.ok(st.skills && 'gunnery' in st.skills);
    // A fresh state has no skill points, so training is rejected.
    const r = await api(srv.base, '/api/train-skill', { skill: 'gunnery' });
    assert.equal(r.status, 400);
    assert.match(r.data.error, /skill points/i);
  });

  test('POST /api/train-skill rejects an unknown skill (400)', async () => {
    const r = await api(srv.base, '/api/train-skill', { skill: 'warp' });
    assert.equal(r.status, 400);
    assert.ok(r.data.error);
  });

  test('GET /api/catalog exposes drones and the drone cap', async () => {
    const r = await api(srv.base, '/api/catalog');
    assert.equal(r.status, 200);
    assert.ok(r.data.drones.mining && r.data.drones.combat);
    assert.equal(r.data.constants.droneMaxPerType, cfg.DRONE_MAX_PER_TYPE);
    assert.ok(r.data.blueprints.weapon && r.data.blueprints.weapon[2].recipe);
    assert.ok(r.data.shipBlueprints.falcon.recipe);
  });

  test('GET /api/state exposes the drone bay and loot inventory', async () => {
    const r = await api(srv.base, '/api/state');
    assert.equal(r.status, 200);
    assert.deepEqual(r.data.state.drones, { mining: [], combat: [] });
    assert.ok(Array.isArray(r.data.state.loot));
    assert.ok('mining' in r.data.state.droneBonuses && 'dps' in r.data.state.droneBonuses);
  });

  test('POST /api/equip-loot fits a looted module into the active ship', async () => {
    const cur = srv.app.getState();
    cur.skills.gunnery = 1;
    cur.loot = [{ id: 'loot_api', slotType: 'weapon', tier: 2 }];
    srv.app.setState(cur);
    const r = await api(srv.base, '/api/equip-loot', { lootId: 'loot_api' });
    assert.equal(r.status, 200);
    const ship = r.data.state.ships.find((s) => s.id === r.data.state.activeShipId);
    assert.equal(ship.fitting.weapon[0], 2);
    assert.equal(r.data.state.loot.length, 0);
  });

  test('POST /api/equip-loot equips a module directly from Quantum Storage', async () => {
    const cur = srv.app.getState();
    cur.storage.loot.push({ id: 'stored-loot-api', slotType: 'weapon', tier: 1 });
    srv.app.setState(cur);
    const r = await api(srv.base, '/api/equip-loot', { lootId: 'stored-loot-api' });
    assert.equal(r.status, 200);
    const ship = r.data.state.ships.find((item) => item.id === r.data.state.activeShipId);
    assert.equal(ship.fitting.weapon[0], 1);
    assert.equal(r.data.state.storage.loot.length, 0);
  });

  test('POST /api/refine-loot salvages a module directly from Quantum Storage', async () => {
    const cur = srv.app.getState();
    const scrapBefore = cur.storage.items.scrap;
    cur.storage.loot.push({ id: 'stored-salvage-api', slotType: 'weapon', tier: 1 });
    srv.app.setState(cur);
    const r = await api(srv.base, '/api/refine-loot', { lootId: 'stored-salvage-api' });
    assert.equal(r.status, 200);
    assert.equal(r.data.state.storage.loot.length, 0);
    assert.equal(r.data.state.storage.items.scrap, scrapBefore + 1);
  });

  test('POST /api/craft-module turns ore into a looted module', async () => {
    const cur = srv.app.getState();
    const active = cur.ships.find((s) => s.id === cur.activeShipId);
    cur.storage.blueprints.push({ id: 'weapon-blueprint', kind: 'module', type: 'weapon', tier: 1 });
    for (const [key, amount] of Object.entries(cfg.BLUEPRINTS.weapon[1].recipe)) {
      cur.storage.items[key] += amount;
    }
    srv.app.setState(cur);
    const r = await api(srv.base, '/api/craft-module', { slotType: 'weapon', tier: 1, blueprintId: 'weapon-blueprint' });
    assert.equal(r.status, 200);
    assert.equal(r.data.state.loot.length, 1);
    assert.equal(r.data.state.loot[0].slotType, 'weapon');
    assert.equal(r.data.state.loot[0].tier, 1);
    assert.equal(r.data.state.storage.blueprints.length, 0);
  });

  test('POST /api/craft-module rejects when the ore is missing (400)', async () => {
    const r = await api(srv.base, '/api/craft-module', { slotType: 'weapon', tier: 3 });
    assert.equal(r.status, 400);
    assert.ok(r.data.error);
  });

  test('POST /api/deposit and /api/withdraw move minerals via quantum storage', async () => {
    const cur = srv.app.getState();
    const active = cur.ships.find((s) => s.id === cur.activeShipId);
    active.cargo = { iron: 100, bauxite: 0, gadolinium: 0, megacyte: 0 };
    cur.storage.items.iron = 0;
    srv.app.setState(cur);
    const dep = await api(srv.base, '/api/deposit', { mineral: 'iron', amount: 100 });
    assert.equal(dep.status, 200);
    assert.equal(dep.data.state.storage.items.iron, 100);
    assert.equal(dep.data.state.minerals.iron, 0); // hold emptied (minerals = hold)
    const wd = await api(srv.base, '/api/withdraw', { mineral: 'iron', amount: 40 });
    assert.equal(wd.status, 200);
    assert.equal(wd.data.state.storage.items.iron, 60);
    assert.equal(wd.data.state.minerals.iron, 40);
  });

  test('POST /api/store-item and /api/retrieve-item move modules and blueprints through quantum storage', async () => {
    const cur = srv.app.getState();
    cur.loot.push({ id: 'stored-module', slotType: 'weapon', tier: 1 });
    cur.blueprints.push({ id: 'stored-blueprint', kind: 'module', type: 'weapon', tier: 1 });
    srv.app.setState(cur);

    const storedModule = await api(srv.base, '/api/store-item', { kind: 'loot', id: 'stored-module' });
    assert.equal(storedModule.status, 200);
    assert.equal(storedModule.data.state.loot.length, 0);
    assert.equal(storedModule.data.state.storage.loot[0].id, 'stored-module');

    const storedBlueprint = await api(srv.base, '/api/store-item', { kind: 'blueprints', id: 'stored-blueprint' });
    assert.equal(storedBlueprint.status, 200);
    assert.equal(storedBlueprint.data.state.blueprints.length, 0);
    assert.equal(storedBlueprint.data.state.storage.blueprints[0].id, 'stored-blueprint');

    const retrievedModule = await api(srv.base, '/api/retrieve-item', { kind: 'loot', id: 'stored-module' });
    assert.equal(retrievedModule.status, 200);
    assert.equal(retrievedModule.data.state.loot[0].id, 'stored-module');
    const retrievedBlueprint = await api(srv.base, '/api/retrieve-item', { kind: 'blueprints', id: 'stored-blueprint' });
    assert.equal(retrievedBlueprint.status, 200);
    assert.equal(retrievedBlueprint.data.state.blueprints[0].id, 'stored-blueprint');
  });

  test('POST /api/deposit-all transfers cargo to storage without selling', async () => {
    const cur = srv.app.getState();
    const active = cur.ships.find((s) => s.id === cur.activeShipId);
    active.cargo = { iron: 100, bauxite: 25, gadolinium: 0, megacyte: 0 };
    cur.storage.items.iron = 0;
    cur.storage.items.bauxite = 0;
    srv.app.setState(cur);
    const r = await api(srv.base, '/api/deposit-all', {});
    assert.equal(r.status, 200);
    assert.equal(r.data.state.minerals.iron, 0);
    assert.equal(r.data.state.minerals.bauxite, 0);
    assert.equal(r.data.state.storage.items.iron, 100);
    assert.equal(r.data.state.storage.items.bauxite, 25);
    assert.equal(r.data.state.isk, undefined);
  });

  test('POST /api/deposit-filtered stores only the selected cargo categories', async () => {
    const cur = srv.app.getState();
    const active = cur.ships.find((ship) => ship.id === cur.activeShipId);
    active.cargo = { iron: 11, bauxite: 12, gadolinium: 0, megacyte: 0, scrap: 13, alloy: 14, circuits: 0, quantumCores: 0 };
    cur.loot = [
      { id: 'filtered-module', slotType: 'weapon', tier: 1 },
    ];
    cur.blueprints = [
      { id: 'filtered-blueprint', kind: 'module', type: 'weapon', tier: 1 },
    ];
    cur.storage.items.iron = 0;
    cur.storage.items.bauxite = 0;
    cur.storage.items.scrap = 0;
    cur.storage.items.alloy = 0;
    cur.storage.loot = [];
    cur.storage.blueprints = [];
    srv.app.setState(cur);

    let response = await api(srv.base, '/api/deposit-filtered', { filter: 'ore' });
    assert.equal(response.status, 200);
    assert.equal(response.data.state.materials.iron, 0);
    assert.equal(response.data.state.materials.scrap, 13);
    assert.equal(response.data.state.loot.length, 1);
    assert.equal(response.data.state.storage.items.iron, 11);

    response = await api(srv.base, '/api/deposit-filtered', { filter: 'components' });
    assert.equal(response.status, 200);
    assert.equal(response.data.state.materials.scrap, 0);
    assert.equal(response.data.state.storage.items.alloy, 14);
    assert.equal(response.data.state.loot.length, 1);

    response = await api(srv.base, '/api/deposit-filtered', { filter: 'loot' });
    assert.equal(response.status, 200);
    assert.equal(response.data.state.loot.length, 0);
    assert.equal(response.data.state.storage.loot[0].id, 'filtered-module');
    assert.equal(response.data.state.blueprints.length, 1);

    response = await api(srv.base, '/api/deposit-filtered', { filter: 'blueprints' });
    assert.equal(response.status, 200);
    assert.equal(response.data.state.blueprints.length, 0);
    assert.equal(response.data.state.storage.blueprints[0].id, 'filtered-blueprint');

    const next = srv.app.getState();
    const nextActive = next.ships.find((ship) => ship.id === next.activeShipId);
    nextActive.cargo.iron = 5;
    next.loot.push({ id: 'all-module', slotType: 'weapon', tier: 1 });
    next.blueprints.push({ id: 'all-blueprint', kind: 'module', type: 'weapon', tier: 1 });
    srv.app.setState(next);
    response = await api(srv.base, '/api/deposit-filtered', { filter: 'all' });
    assert.equal(response.status, 200);
    assert.equal(response.data.state.materials.iron, 0);
    assert.equal(response.data.state.storage.items.iron, 16);
    assert.ok(response.data.state.storage.loot.some((item) => item.id === 'all-module'));
    assert.ok(response.data.state.storage.blueprints.some((item) => item.id === 'all-blueprint'));
  });

  test('POST /api/deposit and /api/withdraw reject when not docked (400)', async () => {
    await api(srv.base, '/api/warp', { x: 100, y: 100 });
    const dep = await api(srv.base, '/api/deposit', { mineral: 'iron', amount: 10 });
    assert.equal(dep.status, 400);
    assert.match(dep.data.error, /dock/i);
    const wd = await api(srv.base, '/api/withdraw', { mineral: 'iron', amount: 10 });
    assert.equal(wd.status, 400);
    assert.match(wd.data.error, /dock/i);
  });

  test('manual mining works over HTTP and ordinary ticks do not mine', async () => {
    const st = (await api(srv.base, '/api/state')).data.state;
    const a = st.world.asteroids.find((x) => x.amount > 0);
    await flyTo(srv.base, a.x, a.y);
    const tick = await api(srv.base, '/api/tick', {});
    assert.equal(tick.status, 200);
    assert.equal(tick.data.state.stats.totalMineralsMined, 0);
    const mined = await api(srv.base, '/api/mine', {});
    assert.equal(mined.status, 200);
    assert.ok(mined.data.state.stats.totalMineralsMined > 0);
    assert.ok(Object.values(mined.data.state.minerals).some((amount) => amount > 0));
  });

  test('POST /api/warp moves the ship to a POI in its system', async () => {
    const st = (await api(srv.base, '/api/state')).data.state;
    const belt = st.world.belts[0];
    const r = await api(srv.base, '/api/warp', { targetId: belt.id });
    assert.equal(r.status, 200);
    const ship = r.data.state.ships.find((s) => s.id === r.data.state.activeShipId);
    const rocks = st.world.asteroids.filter((a) => a.beltId === belt.id && a.amount > 0);
    assert.ok(rocks.some((a) => Math.abs(ship.x - a.x) < 1e-6 && Math.abs(ship.y - a.y) < 1e-6), 'lands on an asteroid of the belt');
  });

  test('POST /api/warp rejects an unknown target (400)', async () => {
    const r = await api(srv.base, '/api/warp', { targetId: 'nope' });
    assert.equal(r.status, 400);
    assert.ok(r.data.error);
  });

  test('POST /api/gate jumps to the connected system when at a gate', async () => {
    const st = (await api(srv.base, '/api/state')).data.state;
    const gate = st.system.gates[0];
    await api(srv.base, '/api/warp', { targetId: gate.id });
    const r = await api(srv.base, '/api/gate', { gateId: gate.id });
    assert.equal(r.status, 200);
    assert.equal(r.data.state.system.id, gate.targetSystemId);
    const ship = r.data.state.ships.find((s) => s.id === r.data.state.activeShipId);
    assert.ok(ship);
  });

  test('POST /api/gate rejects when too far from the gate (400)', async () => {
    const st = (await api(srv.base, '/api/state')).data.state;
    const gate = st.system.gates[0];
    const r = await api(srv.base, '/api/gate', { gateId: gate.id });
    assert.equal(r.status, 400);
    assert.ok(r.data.error);
  });

  test('rejects invalid JSON body (400)', async () => {
    const res = await fetch(srv.base + '/api/buy-ship', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '{not json',
    });
    assert.equal(res.status, 400);
  });

  test('rejects unknown action (400)', async () => {
    const r = await api(srv.base, '/api/teleport', {});
    assert.equal(r.status, 400);
    assert.ok(r.data.error);
  });

  test('serves the frontend at /', async () => {
    const res = await fetch(srv.base + '/');
    assert.equal(res.status, 200);
    const html = await res.text();
    assert.match(html, /<canvas id="world">/);
  });

  test('development server refreshes the browser when frontend files change', async () => {
    const dev = await startServer(tmpDataFile(), { liveReload: true });
    const changedFile = path.join(__dirname, '..', 'public', `__live-reload-${process.pid}-${Date.now()}.tmp`);
    let reader;
    try {
      const page = await fetch(dev.base + '/');
      assert.match(await page.text(), /__dev\/live-reload/);

      const events = await fetch(dev.base + '/__dev/live-reload');
      reader = events.body.getReader();
      const connected = await reader.read();
      assert.match(new TextDecoder().decode(connected.value), /event: session/);

      const changeEvent = reader.read();
      fs.writeFileSync(changedFile, 'changed');
      let timeout;
      const changed = await Promise.race([
        changeEvent,
        new Promise((_, reject) => {
          timeout = setTimeout(() => reject(new Error('Timed out waiting for live reload')), 2000);
        }),
      ]).finally(() => clearTimeout(timeout));
      assert.match(new TextDecoder().decode(changed.value), /event: change/);
    } finally {
      if (reader) await reader.cancel();
      if (fs.existsSync(changedFile)) fs.unlinkSync(changedFile);
      await dev.close();
    }
  });

  test('POST /api/mode starts a story save with item supplies and the first mission', async () => {
    const r = await api(srv.base, '/api/mode', { mode: 'story' });
    assert.equal(r.status, 200);
    assert.equal(r.data.state.mode, 'story');
    assert.equal(r.data.state.isk, undefined);
    assert.ok(r.data.state.storage.items.iron > 0);
    assert.equal(r.data.state.mission.active, 'm1');
    assert.deepEqual(r.data.state.mission.completed, []);
  });

  test('POST /api/mission drives the hangar turn-in and accept lifecycle', async () => {
    const started = await api(srv.base, '/api/mode', { mode: 'story' });
    assert.equal(started.data.state.mission.active, 'm1');
    assert.equal(started.data.state.mission.ready, false);

    // Kill the m1 attacker: teleport onto it, engage, force an instant win.
    let state = srv.app.getState();
    const attacker = state.systems.sys_0.enemies.find((e) => e.missionTag === 'attacker');
    state.ships[0].fitting.weapon[0] = 4;
    state.ships[0].x = attacker.x;
    state.ships[0].y = attacker.y;
    srv.app.setState(state);
    const engaged = await api(srv.base, '/api/engage', { enemyId: attacker.id });
    assert.equal(engaged.status, 200);
    state = srv.app.getState();
    state.combat.playerDps = 1e9;
    state.combat.enemyDps = 0;
    state.lastTick = Date.now() - 1000;
    srv.app.setState(state);
    const resolved = await api(srv.base, '/api/tick', {});
    assert.equal(resolved.status, 200);
    assert.equal(resolved.data.state.mission.ready, true);
    assert.equal(resolved.data.state.mission.active, 'm1');

    // Turning in while undocked is refused over HTTP too.
    const spaceTurnin = await api(srv.base, '/api/mission', { action: 'turnin' });
    assert.equal(spaceTurnin.status, 400);
    assert.ok(/station/i.test(spaceTurnin.data.error));

    // Dock, turn in and accept m2 — the hangar lifecycle.
    state = srv.app.getState();
    const home = state.systems.sys_0.stations[0];
    state.ships[0].x = home.x;
    state.ships[0].y = home.y;
    state.ships[0].dockedStationId = home.id;
    srv.app.setState(state);
    const turnin = await api(srv.base, '/api/mission', { action: 'turnin' });
    assert.equal(turnin.status, 200);
    assert.equal(turnin.data.state.mission.active, null);
    assert.equal(turnin.data.state.mission.offered.id, 'm2');
    assert.equal(turnin.data.state.mission.ready, false);
    const scrapBefore = (started.data.state.storage.items.scrap || 0);
    assert.equal(turnin.data.state.storage.items.scrap, scrapBefore + 3, 'completion items land in storage');
    const accept = await api(srv.base, '/api/mission', { action: 'accept' });
    assert.equal(accept.status, 200);
    assert.equal(accept.data.state.mission.active, 'm2');
    assert.equal(accept.data.state.mission.offered, null);
    const again = await api(srv.base, '/api/mission', { action: 'accept' });
    assert.equal(again.status, 400);
    assert.ok(/offer/i.test(again.data.error));
  });

  test('resuming a save reports capped simulation and full offline skill-point progress once', async () => {
    const state = srv.app.getState();
    const asteroid = state.systems[state.ships[0].systemId].asteroids[0];
    state.ships[0].x = asteroid.x;
    state.ships[0].y = asteroid.y;
    state.autoPilotMode = 'mine';
    state.lastTick = Date.now() - (cfg.MAX_OFFLINE_SECONDS + 3600) * 1000;
    srv.app.setState(state);
    const resumed = await api(srv.base, '/api/mode', { mode: 'demo' });
    assert.equal(resumed.status, 200);
    assert.ok(resumed.data.offlineReport.elapsedSeconds >= cfg.MAX_OFFLINE_SECONDS + 3600);
    assert.equal(resumed.data.offlineReport.capped, true);
    assert.ok(Math.abs(
      resumed.data.offlineReport.skillPoints -
        cfg.SP_RATE_PER_SEC * resumed.data.offlineReport.elapsedSeconds,
    ) < 0.1);
    assert.ok(resumed.data.offlineReport.mined > 0);
    const secondResume = await api(srv.base, '/api/mode', { mode: 'demo' });
    assert.equal(secondResume.data.offlineReport, null);
  });

  test('POST /api/mode rejects an unknown mode (400)', async () => {
    const r = await api(srv.base, '/api/mode', { mode: 'arcade' });
    assert.equal(r.status, 400);
    assert.ok(r.data.error);
  });

  test('mode saves are isolated: switching modes never clobbers the other', async () => {
    const demo = (await api(srv.base, '/api/mode', { mode: 'demo' })).data.state;
    assert.equal(demo.mode, 'demo');
    assert.equal(demo.isk, undefined);
    const story = (await api(srv.base, '/api/mode', { mode: 'story' })).data.state;
    assert.equal(story.mode, 'story');
    assert.equal(story.isk, undefined);
    const demoAgain = (await api(srv.base, '/api/mode', { mode: 'demo' })).data.state;
    assert.equal(demoAgain.mode, 'demo');
    assert.equal(demoAgain.isk, undefined);
  });

  test('reset regenerates the active mode only', async () => {
    await api(srv.base, '/api/mode', { mode: 'story' });
    const st = (await api(srv.base, '/api/reset', {})).data.state;
    assert.equal(st.mode, 'story');
    assert.equal(st.isk, undefined);
    assert.equal(st.ships.length, 1);
  });

  test('blocks path traversal', async () => {
    const res = await fetch(srv.base + '/..%2fserver%2fgame.js');
    assert.notEqual(res.status, 200);
  });
});

describe('persistence', () => {
  test('state and world survive a server restart', async () => {
    const dataFile = tmpDataFile();
    const a = await startServer(dataFile);
    const before = (await api(a.base, '/api/state')).data.state;
    const worldSeed = before.world.seed;
    const astCount = before.world.asteroids.length;
    const state = a.app.getState();
    state.skills.miningYield = 1;
    state.blueprints.push({ id: 'found-falcon', kind: 'ship', type: 'falcon', tier: null });
    a.app.setState(state);
    const crafted = await api(a.base, '/api/craft-ship', { type: 'falcon' });
    assert.equal(crafted.status, 200);
    await a.close();

    assert.ok(fs.existsSync(dataFile));
    const b = await startServer(dataFile);
    const restored = (await api(b.base, '/api/state')).data.state;
    assert.equal(restored.ships.length, 2);
    assert.equal(restored.world.seed, worldSeed);
    assert.equal(restored.world.asteroids.length, astCount);
    await b.close();
  });

  test('reset regenerates a fresh world and state', async () => {
    const dataFile = tmpDataFile();
    const a = await startServer(dataFile);
    const state = a.app.getState();
    state.blueprints.push({ id: 'found-vexor', kind: 'ship', type: 'vexor', tier: null });
    a.app.setState(state);
    await api(a.base, '/api/reset', {});
    await a.close();

    const b = await startServer(dataFile);
    const restored = (await api(b.base, '/api/state')).data.state;
    assert.equal(restored.ships.length, 1);
    assert.equal(restored.ships[0].type, 'rifter');
    await b.close();
  });

  test('an old (v1) save is discarded and a new world is created', async () => {
    const dataFile = tmpDataFile();
    fs.writeFileSync(dataFile, JSON.stringify({ version: 1, isk: 1, ships: [{ id: 'x', type: 'rifter', level: 1 }] }));
    const a = await startServer(dataFile);
    const st = (await api(a.base, '/api/state')).data.state;
    assert.equal(st.version, cfg.STATE_VERSION);
    assert.ok(st.world);
    await a.close();
  });
});
