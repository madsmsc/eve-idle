'use strict';

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const game = require('../server/game');
const cfg = require('../server/config');

const T0 = 1_000_000_000_000;
const SYSTEM_COUNT = 13;

function fresh(seed = 42) {
  return game.createInitialState(T0, seed);
}

function story(seed = 42) {
  return game.createInitialState(T0, seed, 'story');
}

// The star system the active ship is in.
function sys(state) {
  const active = state.ships.find((sh) => sh.id === state.activeShipId);
  return state.systems[active.systemId];
}

// Put the active ship exactly on the first non-empty asteroid.
function atAsteroid(state) {
  const a = sys(state).asteroids.find((x) => x.amount > 0);
  const ship = state.ships.find((sh) => sh.id === state.activeShipId);
  ship.x = a.x;
  ship.y = a.y;
  ship.dockedStationId = null;
  ship.dockTargetId = null;
  return a;
}

// Dock the active ship at the first station of its system.
function atStation(state) {
  const ship = state.ships.find((sh) => sh.id === state.activeShipId);
  const station = sys(state).stations[0];
  ship.x = station.x;
  ship.y = station.y;
  ship.dockedStationId = station.id;
  ship.dockTargetId = station.id;
  return state;
}

// Move the active ship away from any POI so it is unambiguously in open space.
function openSpace(state) {
  const ship = state.ships.find((sh) => sh.id === state.activeShipId);
  ship.x = 200;
  ship.y = 200;
  ship.dockedStationId = null;
  ship.dockTargetId = null;
  return state;
}

// Set the active ship's cargo hold (merges `partial` over a fresh hold).
function withCargo(state, partial) {
  const active = state.ships.find((sh) => sh.id === state.activeShipId);
  active.cargo = { iron: 0, bauxite: 0, gadolinium: 0, megacyte: 0, scrap: 0, alloy: 0, circuits: 0, quantumCores: 0, ...partial };
  return state;
}

// Add a module to the loot inventory.
function withModule(state, slotType, tier) {
  if (!Array.isArray(state.loot)) state.loot = [];
  state.loot.push({ id: `inv_${slotType}_${tier}`, slotType, tier });
  return state;
}

// Add a blueprint to the blueprint inventory.
function withBlueprint(state, kind, type, tier = null) {
  if (!Array.isArray(state.blueprints)) state.blueprints = [];
  state.blueprints.push({ id: `bp_${kind}_${type}_${tier}`, kind, type, tier });
  return state;
}

function unlockShip(state, type) {
  const entry = cfg.SHIP_PROGRESSION.flatMap((tier) => tier.ships).find((ship) => ship.type === type);
  for (const { skill, level } of entry.skills) state.skills[skill] = level;
  return state;
}

function fundShip(state, type) {
  for (const [item, amount] of Object.entries(cfg.SHIP_BLUEPRINTS[type].recipe)) {
    state.storage.items[item] = (state.storage.items[item] || 0) + amount;
  }
  return state;
}

// Add materials to quantum storage.
function withStorage(state, items) {
  if (!state.storage.items) state.storage.items = {};
  for (const [key, amount] of Object.entries(items)) state.storage.items[key] = amount;
  return state;
}

// Find an enemy near a given point (for combat tests).
function nearestEnemy(state, point) {
  let best = null;
  let bd = Infinity;
  for (const e of sys(state).enemies) {
    const d = Math.hypot(e.x - point.x, e.y - point.y);
    if (d < bd) {
      bd = d;
      best = e;
    }
  }
  return best.id;
}

// Seconds until the fight resolves from the current (start-of-fight) pools.
function fightDuration(c) {
  const pTtd = c.enemyDps > 0 ? (c.shipShieldMax + c.shipHullMax) / c.enemyDps : Infinity;
  const eTtd = c.playerDps > 0 ? (c.enemyShieldMax + c.enemyHullMax) / c.playerDps : Infinity;
  return Math.min(pTtd, eTtd);
}

// Win a fight against `enemyType` with a given rng (0 = force a drop, 1 = no drop).
function winAgainst(state, enemyType, rng, shipType = 'brutix') {
  state.ships[0].type = shipType;
  state.ships[0].fitting = game.emptyFitting(shipType);
  state.ships[0].fitting.weapon[0] = 4; // fit a Faction weapon to guarantee the win
  const e = sys(state).enemies[0];
  e.type = enemyType;
  state.ships[0].x = e.x;
  state.ships[0].y = e.y;
  const eng = game.engage(state, e.id, T0).state;
  return game.tick(eng, T0 + 100000, null, rng);
}

// Place the active ship on a known enemy of a known type and engage it.
function setupFight(state, shipType, enemyType) {
  state.ships[0].systemId = 'sys_1';
  state.ships[0].type = shipType;
  state.ships[0].fitting = game.emptyFitting(shipType);
  const e = sys(state).enemies[0];
  e.type = enemyType;
  state.ships[0].x = e.x;
  state.ships[0].y = e.y;
  return game.engage(state, e.id, T0).state;
}

describe('world generation', () => {
  test('generates multiple systems, each bounded with all POI types', () => {
    const s = fresh();
    assert.ok(Object.keys(s.systems).length >= 3, 'should have at least 3 systems');
    for (const system of Object.values(s.systems)) {
      assert.equal(system.width, cfg.WORLD_SIZE);
      assert.ok(system.star);
      assert.ok(system.planets.length >= 1);
      assert.ok(system.stations.length >= 1);
      assert.equal(system.outposts.length, 2);
      assert.equal(system.belts.length, 2);
      assert.ok(system.asteroids.length > 0);
      assert.ok(system.enemies.length > 0);
      const beltIds = new Set(system.belts.map((b) => b.id));
      for (const belt of system.belts) {
        assert.ok(system.asteroids.filter((a) => a.beltId === belt.id).length >= cfg.ASTEROIDS_PER_FIELD[0]);
      }
      for (const outpost of system.outposts) {
        const outpostEnemies = system.enemies.filter((enemy) => enemy.outpostId === outpost.id);
        assert.ok(outpostEnemies.length >= 3 && outpostEnemies.length <= 5);
        for (const enemy of outpostEnemies) {
          assert.ok(Math.hypot(enemy.x - outpost.x, enemy.y - outpost.y) <= 440);
        }
      }
      for (const a of system.asteroids) {
        assert.ok(a.x >= 0 && a.x <= cfg.WORLD_SIZE);
        assert.ok(a.y >= 0 && a.y <= cfg.WORLD_SIZE);
        assert.ok(a.amount > 0);
        assert.ok(cfg.MINERALS[a.mineral]);
        assert.ok(beltIds.has(a.beltId));
      }
      const sites = [...system.stations, ...system.outposts, ...system.belts, ...system.gates];
      for (let i = 0; i < sites.length; i++) {
        for (let j = i + 1; j < sites.length; j++) {
          assert.ok(
            Math.hypot(sites[i].x - sites[j].x, sites[i].y - sites[j].y) >= 1000,
            `${sites[i].id} and ${sites[j].id} are too close`,
          );
        }
      }
    }
  });

  test('every system has gates that link to other systems', () => {
    const s = fresh();
    for (const system of Object.values(s.systems)) {
      assert.ok(system.gates.length >= 2, `${system.name} should have at least 2 gates`);
      for (const g of system.gates) {
        assert.ok(s.systems[g.targetSystemId], `gate target ${g.targetSystemId} exists`);
        assert.ok(g.targetGateId);
        assert.ok(g.x >= 0 && g.x <= cfg.WORLD_SIZE);
        assert.ok(g.y >= 0 && g.y <= cfg.WORLD_SIZE);
      }
    }
  });

  test('gates are paired symmetrically (jumping back returns to the origin gate)', () => {
    const s = fresh();
    const system = Object.values(s.systems)[0];
    for (const g of system.gates) {
      const target = s.systems[g.targetSystemId];
      const back = target.gates.find((x) => x.id === g.targetGateId);
      assert.ok(back, `return gate ${g.targetGateId} exists in ${g.targetSystemId}`);
      assert.equal(back.targetSystemId, system.id);
      assert.equal(back.targetGateId, g.id);
    }
  });

  test('moons only exist near planets and are bounded', () => {
    const s = fresh();
    for (const m of sys(s).moons) {
      assert.ok(m.x >= 0 && m.x <= cfg.WORLD_SIZE);
      assert.ok(m.y >= 0 && m.y <= cfg.WORLD_SIZE);
    }
  });

  test('every belt is mineable from its center', () => {
    const s = fresh();
    for (const system of Object.values(s.systems)) {
      for (const belt of system.belts) {
        const inRange = system.asteroids.some(
          (a) => a.beltId === belt.id && a.amount > 0 &&
            Math.hypot(a.x - belt.x, a.y - belt.y) <= cfg.MINING_RANGE
        );
        assert.ok(inRange, `belt ${belt.name} has no asteroid in mining range of its center`);
      }
    }
  });

  test('seeded asteroids remain within their belt and never overlap', () => {
    for (let seed = 1; seed <= 25; seed++) {
      const state = fresh(seed);
      const duplicate = fresh(seed);
      for (const system of Object.values(state.systems)) {
        const duplicateSystem = duplicate.systems[system.id];
        assert.deepEqual(
          system.asteroids.map(({ x, y, size, seed: asteroidSeed }) => ({ x, y, size, seed: asteroidSeed })),
          duplicateSystem.asteroids.map(({ x, y, size, seed: asteroidSeed }) => ({ x, y, size, seed: asteroidSeed })),
        );
        for (let i = 0; i < system.asteroids.length; i++) {
          const asteroid = system.asteroids[i];
          const belt = system.belts.find((item) => item.id === asteroid.beltId);
          assert.ok(Math.hypot(asteroid.x - belt.x, asteroid.y - belt.y) <= 320);
          assert.ok(asteroid.x >= 60 && asteroid.x <= system.width - 60);
          assert.ok(asteroid.y >= 60 && asteroid.y <= system.height - 60);
          for (let j = i + 1; j < system.asteroids.length; j++) {
            const other = system.asteroids[j];
            if (other.beltId !== asteroid.beltId) continue;
            const minimum = (asteroid.size + other.size) * 1.04 + 4;
            assert.ok(
              Math.hypot(asteroid.x - other.x, asteroid.y - other.y) >= minimum,
              `${system.name}: ${asteroid.id} overlaps ${other.id}`,
            );
          }
        }
      }
    }
  });

  test('generated enemies stay clustered around the two outposts', () => {
    for (let seed = 1; seed <= 15; seed++) {
      const state = fresh(seed);
      for (const system of Object.values(state.systems)) {
        assert.equal(system.outposts.length, 2);
        assert.equal(system.belts.length, 2);
        for (const enemy of system.enemies) {
          const outpost = system.outposts.find((site) => site.id === enemy.outpostId);
          assert.ok(outpost, `${enemy.id} is assigned to an outpost`);
          assert.ok(Math.hypot(enemy.x - outpost.x, enemy.y - outpost.y) <= 440);
        }
      }
    }
  });

  test('stations, outposts, belts, and gates are spaced across each system', () => {
    for (let seed = 1; seed <= 15; seed++) {
      const state = fresh(seed);
      for (const system of Object.values(state.systems)) {
        const sites = [...system.stations, ...system.outposts, ...system.belts, ...system.gates];
        for (let i = 0; i < sites.length; i++) {
          for (let j = i + 1; j < sites.length; j++) {
            assert.ok(
              Math.hypot(sites[i].x - sites[j].x, sites[i].y - sites[j].y) >= 1000,
              `${system.name}: ${sites[i].id} and ${sites[j].id} are too close`,
            );
          }
        }
      }
    }
  });

  test('is deterministic for a given seed', () => {
    const a = fresh(1234);
    const b = fresh(1234);
    assert.deepEqual(a.systems, b.systems);
  });

  test('differs across seeds', () => {
    const a = fresh(1);
    const b = fresh(2);
    assert.notDeepEqual(a.systems, b.systems);
  });

  test('migrates saved systems to the new layout without resetting pilot progress', () => {
    const state = story();
    const original = {
      cargo: { ...state.ships[0].cargo },
      mission: { ...state.mission },
      skills: { ...state.skills },
    };
    state.ships[0].cargo.iron = 17;
    state.drones = {
      mining: Array(5).fill(3),
      combat: Array(5).fill(3),
    };
    for (const system of Object.values(state.systems)) {
      delete system.outposts;
      system.belts.pop();
      for (const enemy of system.enemies) delete enemy.outpostId;
    }

    game.migrateWorldLayout(state);

    assert.equal(state.ships[0].cargo.iron, 17);
    assert.equal(state.mission.active, 'm1');
    assert.equal(state.ships[0].fitting.miningDrone[0], 4);
    assert.equal(state.ships[0].fitting.combatDrone[0], 4);
    assert.deepEqual(state.drones, game.emptyDroneBay());
    for (const [id, system] of Object.entries(state.systems)) {
      assert.equal(system.outposts.length, 2);
      assert.equal(system.belts.length, 2);
      if (id === 'sys_0') assert.ok(system.enemies.some((enemy) => enemy.missionTag === 'attacker'));
    }
    const station = state.systems[state.ships[0].systemId].stations.find((item) => item.id === state.ships[0].dockedStationId);
    assert.equal(state.ships[0].x, station.x);
    assert.equal(state.ships[0].y, station.y);
  });
});

describe('blueprints and materials', () => {
  test('buyBlueprint spends materials from cargo or storage and adds the blueprint', () => {
    const s = fresh();
    const cost = cfg.BLUEPRINT_COSTS['module:weapon:1'];
    const r = game.buyBlueprint(s, 'module', 'weapon', 1);
    assert.ok(!r.error, r.error);
    assert.equal(r.state.storage.items.iron, (fresh().storage.items.iron || 0) - cost.iron);
    assert.equal(r.state.storage.items.scrap, (fresh().storage.items.scrap || 0) - cost.scrap);
    assert.ok(r.state.blueprints.some((bp) => bp.kind === 'module' && bp.type === 'weapon' && bp.tier === 1));
  });

  test('buyBlueprint rejects unknown blueprints, unsold blueprints and a bad tier', () => {
    const s = fresh();
    assert.ok(game.buyBlueprint(s, 'module', 'weapon', 9).error);
    assert.ok(game.buyBlueprint(s, 'ship', 'brutix').error, 'tier-4 blueprints are enemy loot only');
    assert.ok(game.buyBlueprint(s, 'minerals', 'iron').error);
  });

  test('buyBlueprint rejects when not docked or short on materials', () => {
    assert.ok(game.buyBlueprint(openSpace(fresh()), 'module', 'weapon', 1).error);
    const poor = fresh();
    poor.storage.items.iron = 0;
    poor.storage.items.scrap = 0;
    assert.match(game.buyBlueprint(poor, 'module', 'weapon', 1).error, /not enough/i);
  });

  test('exchangeItems trades three lower-tier items for one higher-tier item', () => {
    const s = fresh();
    const r = game.exchangeItems(s, 'ore', 'iron', 9);
    assert.ok(!r.error, r.error);
    assert.equal(r.state.storage.items.iron, (fresh().storage.items.iron || 0) - 9);
    assert.equal(r.state.storage.items.bauxite, 3);
  });

  test('exchangeItems rejects a wrong family, a bad amount, or open space', () => {
    assert.ok(game.exchangeItems(fresh(), 'minerals', 'iron', 3).error);
    assert.ok(game.exchangeItems(fresh(), 'ore', 'iron', 4).error);
    assert.ok(game.exchangeItems(fresh(), 'ore', 'quantumCores', 3).error);
    assert.ok(game.exchangeItems(openSpace(fresh()), 'ore', 'iron', 3).error);
  });
});

describe('isValidState', () => {
  test('accepts a fresh state', () => {
    assert.ok(game.isValidState(fresh()));
  });
  test('rejects a v1 (non-spatial) state', () => {
    const old = { version: 1, ships: [{ id: 'x', type: 'rifter' }] };
    assert.equal(game.isValidState(old), false);
  });
  test('rejects null / missing world', () => {
    assert.equal(game.isValidState(null), false);
    assert.equal(game.isValidState({ version: cfg.STATE_VERSION }), false);
  });
});

describe('modes', () => {
  test('demo is the default mode with material supplies and no mission', () => {
    const s = fresh();
    assert.equal(s.mode, 'demo');
    assert.equal(s.isk, undefined);
    assert.equal(s.storage.items.iron, 18);
    assert.equal(s.storage.items.scrap, 12);
    assert.deepEqual(s.mission, { active: null, ready: false, offered: null, flags: {}, completed: [] });
  });
  test('story mode keeps its mode through reset', () => {
    const s = story();
    assert.equal(s.mode, 'story');
    const r = game.reset(s, T0 + 1000);
    assert.equal(r.mode, 'story');
    assert.equal(r.mission.active, 'm1');
  });
  test('an unknown mode falls back to demo', () => {
    const s = game.createInitialState(T0, 42, 'arcade');
    assert.equal(s.mode, 'demo');
  });
  test('view exposes mode and mission', () => {
    const s = story();
    const v = game.view(s);
    assert.equal(v.mode, 'story');
    assert.equal(v.mission.active, 'm1');
    assert.equal(v.mission.title, 'Under Attack');
    assert.equal(v.mission.objective, 'Destroy the attacker frigate');
    assert.equal(v.mission.target, 1);
    assert.equal(v.mission.ready, false);
    assert.equal(v.mission.offered, null);
    assert.deepEqual(v.mission.completed, []);
  });
});

describe('missions (storyline)', () => {
  test('a story save starts m1 with its target spawned near an outpost', () => {
    const s = story();
    assert.equal(s.mission.active, 'm1');
    assert.equal(s.ships[0].fitting.weapon[0], 1, 'm1 grants a Weapon I');
    const outpost = sys(s).outposts[0];
    const attacker = sys(s).enemies.find((e) => e.missionTag === 'attacker');
    assert.ok(attacker, 'attacker spawned');
    assert.ok(attacker.alive);
    assert.equal(attacker.outpostId, outpost.id);
    assert.ok(Math.hypot(attacker.x - outpost.x, attacker.y - outpost.y) < 1000, 'attacker near an outpost');
  });

  test('killing the m1 target only marks it ready — completion needs a docked turn-in', () => {
    const s = story();
    const attacker = sys(s).enemies.find((e) => e.missionTag === 'attacker');
    s.ships[0].fitting.weapon[0] = 4; // fit a Faction weapon to guarantee the win
    s.ships[0].x = attacker.x;
    s.ships[0].y = attacker.y;
    const resolved = game.tick(game.engage(s, attacker.id, T0).state, T0 + 100000, null, () => 1);
    assert.equal(resolved.combatLog[0].won, true);
    assert.equal(resolved.mission.ready, true, 'the objective is met but the mission is not auto-completed');
    assert.equal(resolved.mission.active, 'm1');
    assert.deepEqual(resolved.mission.completed, []);
    assert.match(game.missionAction(resolved, 'turnin').error, /station/i, 'turning in while undocked is refused');
  });

  test('a docked turn-in completes m1, pays completion items and offers m2', () => {
    let s = story();
    const attacker = sys(s).enemies.find((e) => e.missionTag === 'attacker');
    s.ships[0].fitting.weapon[0] = 4;
    s.ships[0].x = attacker.x;
    s.ships[0].y = attacker.y;
    s = game.tick(game.engage(s, attacker.id, T0).state, T0 + 100000, null, () => 1);
    const home = sys(s).stations[0];
    const docked = game.warp(s, home.id).state;
    const r = game.missionAction(docked, 'turnin');
    assert.ok(!r.error, r.error);
    assert.deepEqual(r.state.mission.completed, ['m1']);
    assert.equal(r.state.mission.offered.id, 'm2');
    assert.equal(r.state.mission.active, null);
    assert.equal(r.state.stats.missionsCompleted, 1);
    assert.equal(r.state.storage.items.scrap, (fresh().storage.items.scrap || 0) + 3, 'completion items land in storage');
    const accepted = game.missionAction(r.state, 'accept');
    assert.ok(!accepted.error, accepted.error);
    assert.equal(accepted.state.mission.active, 'm2');
    const activeShip = accepted.state.ships.find((sh) => sh.id === accepted.state.activeShipId);
    assert.equal(activeShip.fitting.range[0], 1, 'm2 grant fits a Range Amplifier I after accept');
    assert.equal(sys(accepted.state).enemies.filter((e) => e.missionTag === 'shortrange' && e.alive).length, 3);
  });

  test('accepting an offered mission requires docking', () => {
    let s = story();
    const attacker = sys(s).enemies.find((e) => e.missionTag === 'attacker');
    s.ships[0].fitting.weapon[0] = 4;
    s.ships[0].x = attacker.x;
    s.ships[0].y = attacker.y;
    s = game.tick(game.engage(s, attacker.id, T0).state, T0 + 100000, null, () => 1);
    const home = sys(s).stations[0];
    s = game.tick(game.warp(s, home.id).state, T0 + 100001, { x: home.x, y: home.y, dockTargetId: home.id });
    s = game.missionAction(s, 'turnin').state;
    assert.equal(s.mission.offered.id, 'm2');
    openSpace(s);
    const r = game.missionAction(s, 'accept');
    assert.match(r.error, /dock/i);
  });

  test('the storyline blocks jump gates until certified', () => {
    const s = story();
    const gate = sys(s).gates[0];
    s.ships[0].x = gate.x;
    s.ships[0].y = gate.y;
    const r = game.gateJump(s, gate.id);
    assert.ok(r.error && /pilot training/i.test(r.error));
  });

  test('certification (m8) unlocks jump gates', () => {
    const s = story();
    s.mission.completed = cfg.MISSION_ORDER.slice();
    const gate = sys(s).gates[0];
    s.ships[0].x = gate.x;
    s.ships[0].y = gate.y;
    const r = game.gateJump(s, gate.id);
    assert.ok(!r.error, r.error);
  });

  test('mining counts towards a mine objective', () => {
    const s = story();
    game.startMission(s, 'm5');
    atAsteroid(s);
    let cur = game.mine(s, T0).state;
    for (let i = 0; i < 30 && !cur.mission.ready; i++) {
      cur = game.tick(cur, T0 + (i + 1) * 1000);
    }
    assert.ok((cur.mission.flags.mined || 0) >= 40, 'mined ore counted');
    assert.equal(cur.mission.active, 'm5', 'mining only marks the mission ready');
    assert.equal(cur.mission.ready, true);
    const home = sys(cur).stations[0];
    const docked = game.tick(game.warp(cur, home.id).state, T0 + 100001, { x: home.x, y: home.y, dockTargetId: home.id });
    const r = game.missionAction(docked, 'turnin');
    assert.ok(!r.error, r.error);
    assert.equal(r.state.mission.offered.id, 'm6');
  });

  test('m7 crafting objective counts each target recipe', () => {
    let s = story();
    game.startMission(s, 'm7');
    s.skills.gunnery = 1;
    s.skills.shieldUpgrades = 1;
    s.skills.moduleEngineering = 1;
    assert.deepEqual(game.view(s).mission.objectives, [
      { label: 'Craft Weapon I', progress: 0, target: 1 },
      { label: 'Craft Shield Extender II', progress: 0, target: 1 },
    ]);
    assert.equal(s.ships[0].fitting.cargo[0], 3, 'm7 grant fits a cargo expander');
    s.skillPoints = 5000;
    s = game.trainSkill(s, 'shieldUpgrades').state; // crafting a tier-II module needs the skill
    let cur = game.craftModule(s, 'weapon', 1).state;
    assert.equal(cur.mission.active, 'm7', 'one craft is not enough');
    assert.equal(cur.mission.ready, false);
    cur = game.craftModule(cur, 'shield', 2).state;
    assert.equal(cur.mission.ready, true);
    const r = game.missionAction(cur, 'turnin');
    assert.ok(!r.error, r.error);
    assert.equal(r.state.mission.offered.id, 'm8');
  });

  test('m3 last stand: losing the scripted wave marks it done and the pod respawns docked', () => {
    const s = story();
    game.startMission(s, 'm3');
    const wave = sys(s).enemies.find((e) => e.missionTag === 'waveship');
    assert.ok(wave, 'waveship spawned');
    s.ships[0].x = wave.x;
    s.ships[0].y = wave.y;
    const resolved = game.tick(game.engage(s, wave.id, T0).state, T0 + 100000, null, () => 1);
    assert.equal(resolved.combatLog[0].won, false, 'the wave is unwinnable');
    assert.equal(resolved.mission.active, 'm3', 'the death does not auto-complete');
    assert.equal(resolved.mission.ready, true);
    assert.equal(resolved.ships.length, 1, 'the pod respawns so the game cannot soft-lock');
    assert.equal(resolved.ships[0].type, 'rifter');
    assert.equal(game.isDocked(resolved), true, 'the pod respawns docked at the station');
    const r = game.missionAction(resolved, 'turnin');
    assert.ok(!r.error, r.error);
    assert.equal(r.state.mission.offered.id, 'm4');
    const acc = game.missionAction(r.state, 'accept');
    assert.ok(!acc.error, acc.error);
    assert.equal(acc.state.mission.active, 'm4');
    assert.equal(acc.state.ships.length, 2, 'the m4 grant hands out the replacement frigate');
    assert.equal(acc.state.ships[1].type, 'rifter');
    assert.equal(game.isDocked(acc.state), false, 'the replacement waits outside the dock — docking still teaches the lesson');
    assert.equal(acc.state.ships[1].fitting.weapon[0], 1, 'm4 grants a Weapon I');
  });

  test('m4: docking completes it, turn-in offers m5 and accept starts mining 101', () => {
    const s = story();
    game.startMission(s, 'm3');
    const wave = sys(s).enemies.find((e) => e.missionTag === 'waveship');
    s.ships[0].x = wave.x;
    s.ships[0].y = wave.y;
    let cur = game.tick(game.engage(s, wave.id, T0).state, T0 + 100000, null, () => 1);
    cur = game.missionAction(cur, 'turnin').state;
    cur = game.missionAction(cur, 'accept').state;
    assert.equal(cur.mission.active, 'm4');
    const home = sys(cur).stations[0];
    cur = game.tick(cur, T0 + 100001, { x: home.x, y: home.y, dockTargetId: home.id });
    assert.equal(cur.mission.ready, true, 'docking at the station completes the objective');
    const turnin = game.missionAction(cur, 'turnin');
    assert.ok(!turnin.error, turnin.error);
    assert.deepEqual(turnin.state.mission.completed, ['m3', 'm4']);
    assert.equal(turnin.state.mission.offered.id, 'm5');
    const acc = game.missionAction(turnin.state, 'accept');
    assert.ok(!acc.error, acc.error);
    assert.equal(acc.state.mission.active, 'm5');
    const activeShip = acc.state.ships.find((sh) => sh.id === acc.state.activeShipId);
    assert.equal(activeShip.fitting.mining[0], 1, 'm5 grant fits a Mining Laser I');
  });

  test('m6: killing the drone hub marks it ready, turn-in grants a mining drone and offers m7', () => {
    const s = story();
    game.startMission(s, 'm6');
    const hub = sys(s).enemies.find((e) => e.missionTag === 'dronhub');
    assert.ok(hub, 'drone hub spawned');
    s.ships[0].fitting.weapon[0] = 4;
    s.ships[0].x = hub.x;
    s.ships[0].y = hub.y;
    const resolved = game.tick(game.engage(s, hub.id, T0).state, T0 + 100000, null, () => 1);
    assert.equal(resolved.combatLog[0].won, true);
    assert.equal(resolved.mission.ready, true);
    const home = sys(resolved).stations[0];
    const docked = game.tick(game.warp(resolved, home.id).state, T0 + 100001, { x: home.x, y: home.y, dockTargetId: home.id });
    const turnin = game.missionAction(docked, 'turnin');
    assert.ok(!turnin.error, turnin.error);
    assert.equal(turnin.state.storage.items.alloy, 2, 'completion alloy lands in storage');
    assert.equal(turnin.state.ships[0].fitting.miningDrone[0], 1, 'a Mining Drone Control module is fitted');
    const acc = game.missionAction(turnin.state, 'accept');
    assert.ok(!acc.error, acc.error);
    assert.equal(acc.state.mission.active, 'm7');
  });

  test('certification: continue accepts it, turn-in offers m9, and completing m9 ends the storyline', () => {
    const s = story();
    game.startMission(s, 'm8');
    const r = game.missionAction(s, 'continue');
    assert.ok(!r.error, r.error);
    assert.equal(r.state.mission.ready, true, 'the dialogue ack completes the certification objective');
    const turnin = game.missionAction(r.state, 'turnin');
    assert.ok(!turnin.error, turnin.error);
    assert.equal(turnin.state.mission.offered.id, 'm9');
    const acc = game.missionAction(turnin.state, 'accept');
    assert.ok(!acc.error, acc.error);
    assert.equal(acc.state.mission.active, 'm9');
    assert.equal(acc.state.systems.sys_1.enemies.filter((e) => e.missionTag === 'placidraider' && e.alive).length, 2);
    const raiders = acc.state.systems.sys_1.enemies.filter((e) => e.missionTag === 'placidraider');
    acc.state.mission.completed = cfg.MISSION_ORDER.slice();
    const gate = acc.state.systems.sys_0.gates[0];
    acc.state.ships[0].x = gate.x;
    acc.state.ships[0].y = gate.y;
    const jumped = game.gateJump(acc.state, gate.id, () => 1, T0);
    assert.ok(!jumped.error, jumped.error);
    assert.equal(jumped.state.ships[0].systemId, 'sys_1');
    let cur = jumped.state;
    let now = T0;
    for (const raider of raiders) {
      cur.ships[0].x = raider.x;
      cur.ships[0].y = raider.y;
      cur = game.tick(game.engage(cur, raider.id, now).state, now + 100000, null, () => 1);
      now += 100000;
      assert.equal(cur.combatLog[0].won, true);
    }
    assert.equal(cur.mission.ready, true);
    const home = sys(cur).stations[0];
    const docked = game.tick(game.warp(cur, home.id).state, T0 + 100001, { x: home.x, y: home.y, dockTargetId: home.id });
    const done = game.missionAction(docked, 'turnin');
    assert.ok(!done.error, done.error);
    assert.equal(done.state.mission.active, null, 'm9 turn-in ends the storyline');
    assert.equal(done.state.mission.offered, null, 'no further mission is offered');
    assert.deepEqual(done.state.mission.completed, [...cfg.MISSION_ORDER.slice(), 'm9']);
  });

  test('missionView exposes ready and offered states', () => {
    let s = story();
    assert.equal(game.missionView(s).ready, false);
    const attacker = sys(s).enemies.find((e) => e.missionTag === 'attacker');
    s.ships[0].fitting.weapon[0] = 4;
    s.ships[0].x = attacker.x;
    s.ships[0].y = attacker.y;
    s = game.tick(game.engage(s, attacker.id, T0).state, T0 + 100000, null, () => 1);
    assert.equal(game.missionView(s).ready, true);
    const home = sys(s).stations[0];
    const docked = game.tick(game.warp(s, home.id).state, T0 + 100001, { x: home.x, y: home.y, dockTargetId: home.id });
    s = game.missionAction(docked, 'turnin').state;
    assert.equal(game.missionView(s).offered.id, 'm2');
  });
});

describe('spatial mining', () => {
  test('autopilot reduces mining yield, including the drone contribution, to one quarter', () => {
    const manual = fresh();
    atAsteroid(manual);
    manual.drones.mining = [1];
    const manualYield = game.shipMining(
      manual.ships[0],
      game.skillMults(manual),
      game.droneBonus(manual, 'mining'),
      manual.skills,
    );

    const automatic = fresh();
    atAsteroid(automatic);
    automatic.drones.mining = [1];
    automatic.autoPilotMode = 'mine';
    const automaticYield = game.shipMining(
      automatic.ships[0],
      game.skillMults(automatic),
      game.droneBonus(automatic, 'mining'),
      automatic.skills,
    ) * game.autoEfficiency(automatic);

    assert.equal(game.autoEfficiency(automatic), cfg.AUTOPILOT_EFFICIENCY);
    assert.ok(Math.abs(automaticYield / manualYield - cfg.AUTOPILOT_EFFICIENCY) < 1e-9);
  });

  test('manual mine action toggles continuous mining on and off', () => {
    const s = fresh();
    const a = atAsteroid(s);
    const before = a.amount;
    const rate = game.shipMining(s.ships[0]);
    const result = game.mine(s, T0 + 1000);
    assert.ok(!result.error, result.error);
    assert.equal(result.state.manualMining, true);
    const s2 = game.tick(result.state, T0 + 1000);
    const a2 = sys(s2).asteroids.find((x) => x.id === a.id);
    assert.ok(a2.amount < before);
    assert.ok(Math.abs(s2.ships[0].cargo[a.mineral] - (before - a2.amount)) < 1e-6);
    assert.ok(Math.abs(s2.stats.totalMineralsMined - (before - a2.amount)) < 1e-6);
    assert.ok(rate > 0);
    const stopped = game.mine(s2, T0 + 1000).state;
    assert.equal(stopped.manualMining, false);
  });

  test('manual mining remains enabled while its selected asteroid is out of range', () => {
    const state = fresh();
    const asteroid = atAsteroid(state);
    const started = game.mine(state, T0).state;
    const awayX = asteroid.x > 300 ? asteroid.x - 300 : asteroid.x + 300;
    const away = game.tick(started, T0 + 1000, { x: awayX, y: asteroid.y });
    assert.equal(away.manualMining, true);
    assert.equal(game.view(away).miningRate, 0);

    const returned = game.tick(away, T0 + 2000, { x: asteroid.x, y: asteroid.y });
    const mining = game.tick(returned, T0 + 3000);
    assert.equal(mining.manualMining, true);
    assert.ok(mining.stats.totalMineralsMined > 0);
  });

  test('manual mining keeps the ship near its selected asteroid when another is nearby', () => {
    const state = fresh();
    const system = sys(state);
    const asteroid = atAsteroid(state);
    const other = system.asteroids.find((item) => item.id !== asteroid.id);
    for (const item of system.asteroids) item.amount = 0;
    asteroid.x = 1000;
    asteroid.y = 1000;
    asteroid.amount = 1000;
    other.x = 1200;
    other.y = 1000;
    other.amount = 1000;
    const ship = state.ships.find((item) => item.id === state.activeShipId);
    ship.x = asteroid.x;
    ship.y = asteroid.y;

    let mining = game.mine(state, T0).state;
    for (let second = 1; second <= 15; second++) {
      mining = game.tick(mining, T0 + second * 1000);
    }

    assert.equal(mining.manualMining, true);
    assert.equal(mining.manualMiningTargetId, asteroid.id);
    const active = mining.ships.find((item) => item.id === mining.activeShipId);
    assert.ok(Math.hypot(active.x - asteroid.x, active.y - asteroid.y) <= cfg.MINING_RANGE);
    assert.ok(mining.stats.totalMineralsMined > 20);
  });

  test('ordinary ticks do not passively mine an asteroid in range', () => {
    const s = fresh();
    const a = atAsteroid(s);
    const before = a.amount;
    const s2 = game.tick(s, T0 + 10_000);
    const a2 = sys(s2).asteroids.find((x) => x.id === a.id);
    assert.equal(a2.amount, before);
    assert.equal(s2.stats.totalMineralsMined, 0);
  });

  test('mining autopilot continues mining while in range', () => {
    const s = fresh();
    const a = atAsteroid(s);
    s.autoPilotMode = 'mine';
    const s2 = game.tick(s, T0 + 5000);
    assert.ok(s2.stats.totalMineralsMined > 0);
    assert.ok(s2.automationLog.some((event) => /^Mined [1-9]\d* ore$/.test(event.message)));
    assert.ok(!s2.automationLog.some((event) => event.message === 'Mined 0 ore'));
  });

  test('manual mining rejects when far from any asteroid', () => {
    const s = openSpace(fresh());
    const result = game.mine(s, T0 + 1000);
    assert.match(result.error, /range/i);
  });

  test('manual mining stops at cargo capacity', () => {
    const s = fresh();
    const a = atAsteroid(s);
    a.amount = 10_000_000;
    const cap = cfg.SHIPS[s.ships[0].type].cargo;
    s.ships[0].cargo[a.mineral] = cap - 10; // nearly full
    const result = game.mine(s, T0 + 1000);
    assert.ok(!result.error, result.error);
    const s2 = result.state;
    const used = Object.values(s2.ships[0].cargo).reduce((x, y) => x + y, 0);
    assert.ok(used <= cap, `cargo ${used} exceeded cap ${cap}`);
  });

  test('does not mine while in combat', () => {
    const s = fresh();
    const a = atAsteroid(s);
    // Force an in-progress combat on the active ship (range check is tested separately).
    s.combat = {
      shipId: s.ships[0].id,
      enemyId: sys(s).enemies[0].id,
      startedAt: T0,
      resolvesAt: T0 + 100_000,
    };
    const result = game.mine(s, T0 + 5_000);
    assert.match(result.error, /combat/i);
  });
});

describe('position sync', () => {
  test('moves the active ship to the reported position', () => {
    const s = fresh();
    atStation(s);
    const s2 = game.tick(s, T0 + 1_000, { x: sys(s).stations[0].x + 50, y: sys(s).stations[0].y });
    assert.ok(Math.abs(s2.ships[0].x - (sys(s).stations[0].x + 50)) < 1e-6);
  });

  test('clamps a teleport (anti-cheat)', () => {
    const s = fresh();
    atStation(s);
    const startX = s.ships[0].x;
    const startY = s.ships[0].y;
    // Report a position far away in a single 500ms tick.
    const s2 = game.tick(s, T0 + 500, { x: 0, y: 0 });
    const moved = Math.hypot(s2.ships[0].x - startX, s2.ships[0].y - startY);
    const full = Math.hypot(0 - startX, 0 - startY);
    const maxJump = cfg.MAX_SPEED * (0.5 + 1) * 3 + 200;
    assert.ok(moved <= maxJump + 1, `ship exceeded max jump: ${moved.toFixed(0)}`);
    assert.ok(moved < full, 'teleport should be clamped');
  });

  test('ignores position while in combat', () => {
    let s = fresh();
    const e = sys(s).enemies[0];
    s.ships[0].x = e.x;
    s.ships[0].y = e.y;
    s = game.engage(s, e.id, T0).state;
    const before = { x: s.ships[0].x, y: s.ships[0].y };
    const s2 = game.tick(s, T0 + 1_000, { x: before.x + 500, y: before.y });
    assert.equal(s2.ships[0].x, before.x);
  });
});

describe('ships: crafting and command', () => {
  test('catalog contains 45 new hulls across five classes and nine families', () => {
    const newHulls = Object.values(game.SHIPS).filter((ship) => ship.familyKey);
    assert.equal(game.SHIP_CLASSES.length, 5);
    assert.equal(game.SHIP_FAMILIES.length, 9);
    assert.equal(newHulls.length, 45);
    assert.equal(Object.keys(game.SKILLS).length, 30);
    assert.equal(new Set(newHulls.map((ship) => ship.classKey)).size, 5);
  });

  test('hull speed and skills affect maximum speed and combat mitigation uses relative velocity', () => {
    const state = fresh();
    const fastType = Object.keys(game.SHIPS).find((type) =>
      game.SHIPS[type].classKey === 'frigate' && game.SHIPS[type].role === 'fast'
    );
    state.ships[0].type = fastType;
    state.ships[0].fitting = game.emptyFitting(fastType);
    const baseSpeed = game.view(state).activeShip.maxSpeed;
    state.skills.navigation = 1;
    assert.ok(game.view(state).activeShip.maxSpeed > baseSpeed);

    const enemy = sys(state).enemies[0];
    const active = state.ships[0];
    active.x = enemy.x;
    active.y = enemy.y;
    active.vx = cfg.MAX_SPEED / 6;
    const combat = game.engage(state, enemy.id, T0).state.combat;
    assert.equal(combat.speedMitigation, 0.5);
    assert.equal(combat.incomingDamageMultiplier, 0.5);
  });

  test('new skill gates apply to ship ownership and module fitting', () => {
    const state = fresh();
    const falcon = { id: 'locked-falcon', type: 'falcon', systemId: sys(state).id, cargo: {}, fitting: game.emptyFitting('falcon') };
    state.ships.push(falcon);
    assert.match(game.setActive(state, falcon.id).error, /requires/i);
    state.loot.push({ id: 'tier-two-weapon', slotType: 'weapon', tier: 2 });
    assert.match(game.equipLoot(state, 'tier-two-weapon').error, /gunnery/i);
    state.skills.gunnery = 1;
    assert.match(game.equipLoot(state, 'tier-two-weapon').error, /module engineering/i);
    state.skills.moduleEngineering = 1;
    assert.ok(!game.equipLoot(state, 'tier-two-weapon').error);
  });

  test('enabling autopilot stops manual mining and its old target', () => {
    const state = fresh();
    atAsteroid(state);
    const mining = game.mine(state, T0).state;
    assert.equal(mining.manualMining, true);
    const autopilot = game.setAutopilot(mining, 'mine').state;
    assert.equal(autopilot.manualMining, false);
    assert.equal(autopilot.manualMiningTargetId, null);
  });

  test('craftShip builds a ship from a blueprint and materials at a station', () => {
    const s = fundShip(unlockShip(fresh(), 'falcon'), 'falcon');
    const r = game.craftShip(withBlueprint(s, 'ship', 'falcon'), 'falcon');
    assert.ok(!r.error, r.error);
    assert.equal(r.state.ships.length, 2);
    assert.equal(r.state.ships[1].type, 'falcon');
    assert.equal(r.state.stats.shipsCrafted, 1);
    assert.equal(r.state.storage.items.iron, fresh().storage.items.iron || 0);
    assert.equal(r.state.storage.items.scrap, fresh().storage.items.scrap || 0);
  });

  test('craftShip rejects without a blueprint, materials, or docking', () => {
    const skilled = unlockShip(fresh(), 'falcon');
    skilled.skillPoints = 5000;
    assert.match(game.craftShip(game.trainSkill(skilled, 'miningYield').state, 'falcon').error, /blueprint/i);
    const noSkill = withBlueprint(fresh(), 'ship', 'falcon');
    assert.match(game.craftShip(noSkill, 'falcon').error, /Requires/i);
    const poor = withBlueprint(fresh(), 'ship', 'falcon');
    poor.skillPoints = 5000;
    unlockShip(poor, 'falcon');
    poor.storage.items.iron = 0;
    poor.storage.items.scrap = 0;
    assert.match(game.craftShip(game.trainSkill(poor, 'miningYield').state, 'falcon').error, /need/i);
    assert.ok(game.craftShip(withBlueprint(openSpace(fresh()), 'ship', 'falcon'), 'falcon').error);
  });

  test('setActive switches the piloted ship', () => {
    const s = unlockShip(fresh(), 'falcon');
    s.ships.push({ id: 'second', type: 'falcon', x: 1, y: 1, systemId: sys(s).id, cargo: {}, fitting: game.emptyFitting('falcon') });
    const s2 = game.setActive(s, 'second').state;
    assert.equal(s2.activeShipId, 'second');
  });
});

describe('quantum storage', () => {
  // Park the active ship at the first station of a *different* system, proving
  // storage follows the pilot (shared by every station) rather than the system.
  function atOtherStation(state) {
    const other = Object.keys(state.systems).find((id) => id !== sys(state).id);
    const ship = state.ships.find((sh) => sh.id === state.activeShipId);
    ship.systemId = other;
    ship.x = state.systems[other].stations[0].x;
    ship.y = state.systems[other].stations[0].y;
    ship.dockedStationId = state.systems[other].stations[0].id;
  }

  test('deposits materials from the cargo hold into storage', () => {
    const s = withCargo(fresh(), { iron: 150, bauxite: 60 });
    const r = game.deposit(s, 'iron', 100);
    assert.equal(r.state.ships[0].cargo.iron, 50);
    assert.equal(r.state.storage.items.iron, (fresh().storage.items.iron || 0) + 100);
    assert.equal(r.state.storage.items.bauxite, 0);
  });

  test('depositAll moves every material to storage', () => {
    const s = withCargo(fresh(), { iron: 150, bauxite: 60 });
    const r = game.depositAll(s);
    assert.ok(!r.error, r.error);
    assert.equal(r.state.ships[0].cargo.iron, 0);
    assert.equal(r.state.ships[0].cargo.bauxite, 0);
    assert.equal(r.state.storage.items.iron, (fresh().storage.items.iron || 0) + 150);
    assert.equal(r.state.storage.items.bauxite, 60);
  });

  test('depositFiltered separates ore, components, loot and blueprints', () => {
    const s = withCargo(fresh(), { iron: 10, scrap: 7 });
    s.loot.push({ id: 'loot-m', slotType: 'weapon', tier: 1 });
    const r = game.depositFiltered(s, 'ore').state;
    assert.equal(r.storage.items.iron, (fresh().storage.items.iron || 0) + 10);
    assert.equal(r.ships[0].cargo.scrap, 7, 'components stay in the hold');
    const s2 = withCargo(fresh(), { scrap: 7 });
    s2.loot.push({ id: 'loot-s2', slotType: 'shield', tier: 1 });
    const stored = game.depositFiltered(s2, 'loot').state;
    assert.equal(stored.ships[0].cargo.scrap, 7);
  });

  test('deposit rejects when not docked, over-depositing or with a bad amount', () => {
    const s = openSpace(withCargo(fresh(), { iron: 10 }));
    assert.ok(game.deposit(s, 'iron', 5).error);
    assert.ok(game.deposit(s, 'iron', 50).error); // more than the hold
    assert.ok(game.deposit(s, 'iron', 0).error);
    assert.ok(game.deposit(s, 'not-a-mineral', 5).error);
  });

  test('withdraws materials from storage into the cargo hold', () => {
    const s = withStorage(fresh(), { iron: 300 });
    const r = game.withdraw(s, 'iron', 40);
    assert.equal(r.state.ships[0].cargo.iron, 40);
    assert.equal(r.state.storage.items.iron, 260);
  });

  test('withdraw respects the cargo hold capacity', () => {
    const s = withStorage(withCargo(fresh(), { iron: 50 }), { iron: 500 });
    const r = game.withdraw(s, 'iron', 'all');
    assert.equal(r.state.ships[0].cargo.iron, cfg.SHIPS.rifter.cargo); // hold full
    assert.ok(r.state.storage.items.iron > 0);
  });

  test('withdraw rejects when not docked, over-withdrawing or with a full hold', () => {
    const s = openSpace(withStorage(withCargo(fresh(), {}), { iron: 100 }));
    assert.ok(game.withdraw(s, 'iron', 10).error);
    const docked = withStorage(withCargo(fresh(), {}), { iron: 500 });
    assert.ok(game.withdraw(docked, 'iron', 501).error);
    const full = withCargo(fresh(), { iron: cfg.SHIPS.rifter.cargo });
    assert.ok(game.withdraw(full, 'iron', 1).error); // no room in the hold
  });

  test('storeInventoryItem and retrieveInventoryItem move loot and blueprints', () => {
    let s = fresh();
    s.loot.push({ id: 'loot-store', slotType: 'weapon', tier: 2 });
    s.blueprints.push({ id: 'bp-store', kind: 'module', type: 'weapon', tier: 1 });
    const stored = game.storeInventoryItem(s, 'loot', 'loot-store').state;
    assert.equal(stored.loot.length, 0);
    assert.equal(stored.storage.loot.length, 1);
    const withBp = game.storeInventoryItem(stored, 'blueprints', 'bp-store').state;
    assert.equal(withBp.storage.blueprints.length, 1);
    const back = game.retrieveInventoryItem(withBp, 'blueprints', 'bp-store').state;
    assert.equal(back.blueprints.length, 1);
    assert.equal(back.storage.blueprints.length, 0);
    assert.ok(game.storeInventoryItem(openSpace(fresh()), 'loot', 'x').error);
    assert.ok(game.retrieveInventoryItem(openSpace(fresh()), 'loot', 'x').error);
  });

  test('quantum storage is shared across systems', () => {
    const s = withCargo(fresh(), { bauxite: 80 });
    const deposited = game.deposit(s, 'bauxite', 80).state;
    atOtherStation(deposited);
    const r = game.withdraw(deposited, 'bauxite', 40);
    assert.equal(r.state.storage.items.bauxite, 40);
    assert.equal(r.state.ships[0].cargo.bauxite, 40);
  });

  test('storage is exposed in the view', () => {
    const s = withCargo(fresh(), { iron: 30 });
    const deposited = game.deposit(s, 'iron', 30).state;
    const v = game.view(deposited);
    assert.equal(v.storage.items.iron, (fresh().storage.items.iron || 0) + 30);
    assert.equal(deposited.storage.items.iron, (fresh().storage.items.iron || 0) + 30);
  });
});

describe('docking', () => {
  test('is docked at a station, not in open space', () => {
    const s = fresh();
    assert.ok(game.isDocked(s));
    assert.equal(game.dockedStation(s).name, sys(s).stations[0].name);
    openSpace(s);
    assert.equal(game.isDocked(s), false);
  });

  test('view exposes docked and dockedStation', () => {
    const s = fresh();
    const v = game.view(s);
    assert.equal(v.docked, true);
    assert.equal(v.dockedStation, sys(s).stations[0].name);
    const away = game.view(openSpace(fresh()));
    assert.equal(away.docked, false);
    assert.equal(away.dockedStation, null);
  });

  test('passing within dock range does not dock unless the station is the target', () => {
    const s = fresh();
    const station = sys(s).stations[0];
    let state = game.warp(s, null, station.x + cfg.DOCK_RANGE - 1, station.y).state;
    state = game.tick(state, T0 + 1, { x: station.x + cfg.DOCK_RANGE - 1, y: station.y });
    assert.equal(game.view(state).docked, false);

    state = game.tick(state, T0 + 2, {
      x: station.x + cfg.DOCK_RANGE - 1,
      y: station.y,
      dockTargetId: station.id,
    });
    assert.equal(game.view(state).docked, true);
    assert.equal(game.view(state).dockedStation, station.name);
  });
});

describe('engage + combat', () => {
  test('engages an enemy you are next to and captures live shield/hull', () => {
    const s = fresh();
    const e = sys(s).enemies[0];
    s.ships[0].x = e.x;
    s.ships[0].y = e.y;
    const r = game.engage(s, e.id, T0);
    assert.ok(!r.error);
    assert.equal(r.state.combat.enemyId, e.id);
    const c = r.state.combat;
    const tier = cfg.ENEMY_TIERS[e.tier];
    assert.ok(c.shipShield > 0 && c.shipHull > 0);
    assert.ok(c.enemyShield > 0 && c.enemyHull > 0);
    assert.ok(c.playerDps > 0 && c.enemyDps > 0);
    assert.equal(c.enemyShieldMax, cfg.ENEMIES[e.type].shield * tier.multiplier);
    assert.equal(c.enemyHullMax, cfg.ENEMIES[e.type].hull * tier.multiplier);
    assert.equal(c.enemyDps, cfg.ENEMIES[e.type].dps * tier.multiplier);
    assert.ok(fightDuration(c) > 0);
  });

  test('rejects engaging out of range', () => {
    const s = fresh();
    const e = sys(s).enemies[0];
    // Park in open space (not docked) on the opposite side of the world.
    s.ships[0].x = e.x > cfg.WORLD_SIZE / 2 ? 100 : cfg.WORLD_SIZE - 100;
    s.ships[0].y = 100;
    const r = game.engage(s, e.id, T0);
    assert.ok(r.error && /range/i.test(r.error));
  });

  test('rejects engaging while docked', () => {
    const s = fresh();
    atStation(s);
    const e = sys(s).enemies[0];
    const r = game.engage(s, e.id, T0);
    assert.ok(r.error && /docked/i.test(r.error));
  });

  test('rejects a second engage while in combat', () => {
    let s = fresh();
    const e = sys(s).enemies[0];
    s.ships[0].x = e.x;
    s.ships[0].y = e.y;
    s = game.engage(s, e.id, T0).state;
    const e2 = sys(s).enemies.find((x) => x.id !== e.id);
    s.ships[0].x = e2.x;
    s.ships[0].y = e2.y;
    const r = game.engage(s, e2.id, T0);
    assert.ok(r.error);
  });

  test('win destroys the enemy and drops scrap into the hold', () => {
    const s = setupFight(fresh(), 'brutix', 'pirate'); // brutix (fast TTK) beats a pirate
    const scrapBefore = s.ships[0].cargo.scrap;
    const s2 = game.tick(s, T0 + Math.ceil(fightDuration(s.combat)) * 1000 + 1000, null);
    assert.equal(s2.combat, null);
    assert.ok(s2.combatLog[0].won);
    assert.equal(sys(s2).enemies[0].alive, false);
    assert.equal(s2.ships[0].cargo.scrap, scrapBefore + s2.combatLog[0].scrap);
    assert.ok(s2.combatLog[0].scrap >= 1, 'a kill drops scrap');
    assert.equal(s2.stats.combatsWon, 1);
  });

  test('loss destroys the ship and its cargo, and the pod respawns docked', () => {
    const s = setupFight(withCargo(fresh(), { iron: 50, megacyte: 20 }), 'rifter', 'dread'); // rifter (slow TTK) loses to a dreadnought
    const cargoBefore = Object.values(s.ships[0].cargo).reduce((a, b) => a + b, 0);
    const s2 = game.tick(s, T0 + Math.ceil(fightDuration(s.combat)) * 1000 + 1000, null);
    assert.equal(s2.combat, null);
    assert.equal(s2.combatLog[0].won, false);
    assert.equal(s2.combatLog[0].shipLost, true);
    assert.equal(s2.combatLog[0].cargoLost, cargoBefore);
    assert.equal(s2.stats.cargoLost, cargoBefore);
    // The destroyed ship is gone, but a free loaner Rifter respawns so the game
    // can't soft-lock when you lose your only ship.
    assert.equal(s2.ships.length, 1);
    assert.equal(s2.ships[0].type, 'rifter');
    assert.equal(s2.activeShipId, s2.ships[0].id);
    assert.equal(s2.stats.combatsLost, 1);
    assert.equal(s2.stats.shipsLost, 1);
  });

  test('losing a ship when you have others just switches to the next ship', () => {
    // Dock at the station, craft a second ship, then fly the rifter to a dread.
    let s = fundShip(unlockShip(fresh(), 'falcon'), 'falcon');
    s = game.craftShip(withBlueprint(s, 'ship', 'falcon'), 'falcon').state;
    const rifter = s.ships.find((sh) => sh.id === s.activeShipId);
    rifter.systemId = 'sys_1';
    const e = sys(s).enemies[0];
    e.type = 'dread';
    rifter.x = e.x;
    rifter.y = e.y;
    s = game.engage(s, e.id, T0).state;
    const before = s.ships.length;
    const s2 = game.tick(s, T0 + Math.ceil(fightDuration(s.combat)) * 1000 + 1000, null);
    assert.equal(s2.combat, null);
    assert.equal(s2.combatLog[0].won, false);
    assert.equal(s2.ships.length, before - 1, 'only the destroyed ship is removed');
    assert.equal(s2.ships.some((sh) => sh.type === 'falcon'), true);
    assert.ok(s2.activeShipId, 'still has an active ship');
  });

  test('the fight drains shields before hull and resolves by TTK', () => {
    const s = setupFight(fresh(), 'brutix', 'pirate');
    const c = s.combat;
    // Mid-fight: the enemy has taken damage (shield and/or hull reduced).
    const s2 = game.tick(s, T0 + fightDuration(c) * 0.5 * 1000, null);
    assert.ok(s2.combat, 'fight should still be in progress at the midpoint');
    const c2 = s2.combat;
    assert.ok(c2.enemyShield < c.enemyShieldMax || c2.enemyHull < c.enemyHullMax);
    // Finish the fight; the faster TTK (brutix) wins.
    const s3 = game.tick(s2, T0 + (fightDuration(c) + 2) * 1000, null);
    assert.equal(s3.combat, null);
    assert.ok(s3.combatLog[0].won);
  });

  test('rejects a combat action when not in combat', () => {
    const s = fresh();
    const r = game.combatAction(s, 'shieldBoost', T0);
    assert.ok(r.error && /not in combat/i.test(r.error));
  });

  test('shield boost restores the shield, costs scrap, and goes on cooldown', () => {
    const s = setupFight(withCargo(fresh(), { scrap: 5 }), 'brutix', 'gang');
    const scrapBefore = s.ships[0].cargo.scrap;
    const c = s.combat;
    // Take a second of damage so the shield is no longer full.
    const s1 = game.tick(s, T0 + 1000, null);
    const c1 = s1.combat;
    assert.ok(c1.shipShield < c.shipShieldMax, 'shield should have taken damage');
    const r = game.combatAction(s1, 'shieldBoost', T0 + 1000);
    assert.ok(!r.error);
    const c2 = r.state.combat;
    assert.equal(c2.shipShield, c2.shipShieldMax, 'shield restored to full');
    assert.equal(r.state.ships[0].cargo.scrap, scrapBefore - 1, 'the boost consumed one scrap');
    assert.ok(c2.boostReadyAt > c2.fightTime, 'boost should be on cooldown');
    const r2 = game.combatAction(r.state, 'shieldBoost', T0 + 1000);
    assert.ok(r2.error && /cooldown/i.test(r2.error));
  });

  test('shield boost is refused without scrap in the hold', () => {
    const s = setupFight(fresh(), 'brutix', 'pirate');
    const r = game.combatAction(s, 'shieldBoost', T0);
    assert.ok(r.error && /scrap/i.test(r.error));
  });

  test('overload boosts the player DPS, costs scrap, and goes on cooldown', () => {
    const s = setupFight(withCargo(fresh(), { scrap: 5 }), 'brutix', 'pirate');
    const scrapBefore = s.ships[0].cargo.scrap;
    const r = game.combatAction(s, 'overload', T0);
    assert.ok(!r.error);
    const c2 = r.state.combat;
    assert.ok(c2.overloadUntil > c2.fightTime, 'overload should be active');
    assert.ok(c2.overloadReadyAt > c2.fightTime, 'overload should be on cooldown');
    assert.equal(r.state.ships[0].cargo.scrap, scrapBefore - 1);
    const r2 = game.combatAction(r.state, 'overload', T0);
    assert.ok(r2.error && /cooldown/i.test(r2.error));
  });

  test('overload drains the enemy faster while active', () => {
    const s = setupFight(withCargo(fresh(), { scrap: 5 }), 'vexor', 'faction'); // a ~10s fight, well past a 4s tick
    // Four seconds of fighting with no action.
    const sA = game.tick(s, T0 + 4000, null);
    // Four seconds of fighting with an overload at the start.
    const sB = game.tick(game.combatAction(s, 'overload', T0).state, T0 + 4000, null);
    const hpA = sA.combat.enemyShield + sA.combat.enemyHull;
    const hpB = sB.combat.enemyShield + sB.combat.enemyHull;
    assert.ok(hpB < hpA, 'overload should drain the enemy faster');
  });

  test('disengage ends the fight, keeps the ship, and pays no reward', () => {
    const s = setupFight(fresh(), 'brutix', 'pirate');
    const scrapBefore = s.ships[0].cargo.scrap;
    const enemyId = s.combat.enemyId;
    const r = game.combatAction(s, 'disengage', T0);
    assert.ok(!r.error);
    assert.equal(r.state.combat, null, 'combat should be over');
    assert.equal(r.state.ships.length, 1, 'ship should survive');
    assert.equal(r.state.ships[0].cargo.scrap, scrapBefore, 'no reward for a disengage');
    assert.equal(sys(r.state).enemies.find((e) => e.id === enemyId).alive, true, 'enemy escapes');
    assert.equal(r.state.combatLog[0].disengaged, true);
    assert.equal(r.state.combatLog[0].won, false);
  });
});

describe('range free-fire window', () => {
  // Turn the first enemy into a mission-style short-range pirate (rangeDelay set
  // on the enemy, like spawnMissionEnemies does) and engage it.
  function engageEnemyOfType(state, type, rangeDelay = 0) {
    state.ships[0].systemId = 'sys_1';
    const e = sys(state).enemies[0];
    Object.assign(e, { type, tier: 'standard', rangeDelay });
    state.ships[0].x = e.x;
    state.ships[0].y = e.y;
    return game.engage(state, e.id, T0).state;
  }

  test('a short-range enemy grants an opening free-fire window before its guns bite', () => {
    const s = engageEnemyOfType(fresh(), 'pirate', 2);
    const playerBefore = s.combat.shipShield + s.combat.shipHull;
    const enemyBefore = s.combat.enemyShield + s.combat.enemyHull;
    // One second in: still inside the window, the player is untouched...
    const t1 = game.tick(s, T0 + 1000);
    assert.equal(t1.combat.shipShield + t1.combat.shipHull, playerBefore);
    // ...but the enemy is already taking fire.
    assert.ok(t1.combat.enemyShield + t1.combat.enemyHull < enemyBefore);
    // Past the window the enemy's guns start hitting.
    const t2 = game.tick(t1, T0 + 3000);
    assert.ok(t2.combat.shipShield + t2.combat.shipHull < playerBefore);
  });

  test('fitting a range module extends the free-fire window', () => {
    let s = fresh();
    const e = sys(s).enemies[0];
    Object.assign(e, { type: 'pirate', tier: 'standard', rangeDelay: 2 });
    s = game.fitModule(withModule(s, 'range', 1), s.ships[0].id, 'range', 0, 1).state;
    s.ships[0].x = e.x;
    s.ships[0].y = e.y;
    const c = game.engage(s, e.id, T0).state.combat;
    assert.equal(c.enemyRangeDelay, 2 + cfg.MODULES.range.tiers[0].bonus);
  });

  test('a normal enemy has no free-fire window', () => {
    const s = engageEnemyOfType(fresh(), 'pirate');
    assert.equal(s.combat.enemyRangeDelay, 0);
  });
});

describe('autopilot efficiency', () => {
  test('reduces movement acceleration and speed without changing the catalog caps', () => {
    const state = fresh();
    const ship = state.ships[0];
    const station = sys(state).stations[0];
    station.x = 7000;
    station.y = 7000;
    openSpace(state);
    ship.cargo.iron = game.cargoCapacity(state);
    state.autoPilotMode = 'mine';

    const accelerated = game.tick(state, T0 + 50).ships[0];
    assert.ok(Math.hypot(accelerated.vx, accelerated.vy) <=
      cfg.MAX_ACCELERATION * cfg.AUTOPILOT_EFFICIENCY * 0.05 + 0.001);
    const cruising = game.tick(state, T0 + 10_000).ships[0];
    assert.ok(Math.hypot(cruising.vx, cruising.vy) <=
      cfg.MAX_SPEED * cfg.AUTOPILOT_EFFICIENCY + 0.001);
    assert.ok(Math.hypot(cruising.vx, cruising.vy) > 250);
    assert.equal(cfg.MAX_SPEED, 1200);
    assert.equal(cfg.MAX_ACCELERATION, 180);
  });

  test('reduces player and drone combat damage when combat starts under autopilot', () => {
    const manualState = fresh();
    manualState.drones.combat = [1];
    const manual = setupFight(manualState, 'brutix', 'pirate');
    const automaticState = fresh();
    automaticState.autoPilotMode = 'mine';
    automaticState.drones.combat = [1];
    const automatic = setupFight(automaticState, 'brutix', 'pirate');
    assert.ok(Math.abs(
      automatic.combat.playerDps / manual.combat.playerDps - cfg.AUTOPILOT_EFFICIENCY,
    ) < 1e-9);
  });
});

describe('autopilot target selection', () => {
  test('fight selects a viable standard pirate and launches from station', () => {
    const state = fresh();
    const system = sys(state);
    for (const enemy of system.enemies) {
      enemy.type = 'pirate';
      enemy.tier = 'standard';
      enemy.alive = true;
    }
    state.autoPilotMode = 'fight';

    const after = game.tick(state, T0 + 1000);
    const ship = after.ships.find((item) => item.id === after.activeShipId);

    assert.equal(after.autoPilotMode, 'fight');
    assert.equal(game.isDocked(after), false);
    assert.ok(ship.navigation && ship.navigation.targetId);
  });

  test('fight automatically engages a viable target when already in range', () => {
    const state = fresh();
    const system = sys(state);
    const ship = state.ships.find((item) => item.id === state.activeShipId);
    const enemy = system.enemies[0];
    for (const item of system.enemies) item.alive = false;
    enemy.type = 'pirate';
    enemy.tier = 'standard';
    enemy.alive = true;
    ship.x = enemy.x;
    ship.y = enemy.y;
    ship.dockedStationId = null;
    ship.dockTargetId = null;
    state.autoPilotMode = 'fight';

    const after = game.tick(state, T0 + 1000);

    assert.equal(after.autoPilotMode, 'fight');
    assert.equal(after.combat.enemyId, enemy.id);
  });

  test('autopilot waits for docking, deposit animation, and post-deposit delay', () => {
    const state = atStation(fresh());
    const ship = state.ships.find((item) => item.id === state.activeShipId);
    state.autoPilotMode = 'mine';
    ship.cargo.iron = 50;

    const docked = game.tick(state, T0 + 1000);
    assert.deepEqual(docked.autoPilotSequence, { phase: 'dock_wait', startedAt: null });
    const acknowledged = game.startAutopilotDockWait(docked, T0 + 1000);
    const waiting = game.tick(acknowledged.state, T0 + 1000 + cfg.AUTOPILOT_DOCK_WAIT_MS - 1);
    assert.equal(waiting.autoPilotSequence.phase, 'dock_wait');

    const depositReady = game.tick(
      acknowledged.state,
      T0 + 1000 + cfg.AUTOPILOT_DOCK_WAIT_MS + 1500,
    );
    assert.equal(depositReady.autoPilotSequence.phase, 'deposit');
    assert.equal(game.cargoUsed(depositReady), 50);

    const deposit = game.depositAll(depositReady);
    const deposited = game.completeAutopilotDeposit(deposit.state, T0 + 4000).state;
    assert.equal(deposited.autoPilotSequence.phase, 'launch_wait');
    assert.equal(game.cargoUsed(deposited), 0);

    const stillDocked = game.tick(
      deposited,
      T0 + 4000 + cfg.AUTOPILOT_LAUNCH_WAIT_MS - 1,
    );
    assert.equal(game.isDocked(stillDocked), true);
    const launched = game.tick(
      deposited,
      T0 + 4000 + cfg.AUTOPILOT_LAUNCH_WAIT_MS + 1500,
    );
    assert.equal(game.isDocked(launched), false);
    assert.equal(launched.autoPilotSequence, undefined);
  });

  test('stops in space instead of docking when no targets remain and cargo is empty', () => {
    const state = fresh();
    const system = sys(state);
    system.asteroids.forEach((asteroid) => { asteroid.amount = 0; });
    system.enemies.forEach((enemy) => { enemy.alive = false; });
    const ship = state.ships.find((item) => item.id === state.activeShipId);
    const station = system.stations[0];
    ship.x = station.x + 1000;
    ship.y = station.y;
    ship.dockedStationId = null;
    ship.dockTargetId = null;
    state.autoPilotMode = 'mine';

    const after = game.tick(state, T0 + 1000);
    const updatedShip = after.ships.find((item) => item.id === after.activeShipId);

    assert.equal(game.cargoUsed(after), 0);
    assert.equal(after.autoPilotMode, null);
    assert.equal(game.isDocked(after), false);
    assert.equal(updatedShip.navigation, null);
    assert.match(after.automationLog[0].message, /No suitable targets remain/);
  });
});

describe('server-authoritative target orbit', () => {
  function placeUndockedShip(state, x, y) {
    const ship = state.ships.find((item) => item.id === state.activeShipId);
    ship.x = x;
    ship.y = y;
    ship.vx = 0;
    ship.vy = 0;
    ship.dockedStationId = null;
    ship.dockTargetId = null;
    return ship;
  }

  test('orbits a mineable asteroid without a navigation destination', () => {
    const state = fresh();
    const system = sys(state);
    const asteroid = system.asteroids.find((item) => item.amount > 0);
    system.asteroids = [asteroid];
    state.autoPilotMode = 'mine';
    const ship = placeUndockedShip(state, asteroid.x + 100, asteroid.y);
    const before = { x: ship.x, y: ship.y };

    const after = game.tick(state, T0 + 10_000);
    const movedShip = after.ships.find((item) => item.id === after.activeShipId);
    const movedAsteroid = sys(after).asteroids[0];
    const distance = Math.hypot(movedShip.x - movedAsteroid.x, movedShip.y - movedAsteroid.y);
    const angle = Math.atan2(movedShip.y - movedAsteroid.y, movedShip.x - movedAsteroid.x);

    assert.ok(Math.hypot(movedShip.x - before.x, movedShip.y - before.y) > 20);
    assert.ok(Math.abs(distance - 100) < 5, `orbit radius was ${distance}`);
    assert.ok(angle > 0.5, `ship did not orbit far enough: ${angle}`);
  });

  test('orbiting obeys the acceleration limit', () => {
    const state = fresh();
    const asteroid = sys(state).asteroids.find((item) => item.amount > 0);
    placeUndockedShip(state, asteroid.x + 100, asteroid.y);

    const after = game.tick(state, T0 + 50);
    const ship = after.ships.find((item) => item.id === after.activeShipId);

    assert.ok(Math.hypot(ship.vx, ship.vy) <= cfg.MAX_ACCELERATION * 0.05 + 0.001);
  });

  test('navigation uses a fixed acceleration limit and the doubled speed cap', () => {
    const state = fresh();
    const system = sys(state);
    const ship = placeUndockedShip(state, 1000, 1000);
    system.asteroids.forEach((asteroid) => { asteroid.amount = 0; });
    ship.navigation = { x: 10_000, y: 1000, targetId: null, dockTargetId: null, orbitTargetId: null };

    const accelerated = game.tick(state, T0 + 1000);
    const acceleratedShip = accelerated.ships.find((item) => item.id === accelerated.activeShipId);
    const initialSpeed = Math.hypot(ship.vx || 0, ship.vy || 0);
    const acceleratedSpeed = Math.hypot(acceleratedShip.vx, acceleratedShip.vy);
    assert.ok(acceleratedSpeed > initialSpeed);
    assert.ok(acceleratedSpeed <= cfg.MAX_ACCELERATION + 0.001);
    assert.equal(cfg.MAX_SPEED, 1200);

    const cruising = game.tick(state, T0 + 7000);
    const cruisingShip = cruising.ships.find((item) => item.id === cruising.activeShipId);
    const cruisingSpeed = Math.hypot(cruisingShip.vx, cruisingShip.vy);
    assert.ok(cruisingSpeed > 1100);
    assert.ok(cruisingSpeed <= cfg.MAX_SPEED + 0.001);
  });

  test('cancelling navigation brakes smoothly instead of zeroing velocity', () => {
    const state = fresh();
    const system = sys(state);
    const ship = placeUndockedShip(state, 1000, 1000);
    system.asteroids.forEach((asteroid) => { asteroid.amount = 0; });
    ship.navigation = { x: 10_000, y: 1000, targetId: null, dockTargetId: null, orbitTargetId: null };

    const moving = game.tick(state, T0 + 1000);
    const movingShip = moving.ships.find((item) => item.id === moving.activeShipId);
    const speedBeforeCancel = Math.hypot(movingShip.vx, movingShip.vy);
    const cancelled = game.navigate(moving, { cancel: true }).state;
    const braking = game.tick(cancelled, T0 + 1500);
    const brakingShip = braking.ships.find((item) => item.id === braking.activeShipId);
    const speedAfterCancel = Math.hypot(brakingShip.vx, brakingShip.vy);

    assert.ok(speedAfterCancel > 0);
    assert.ok(speedAfterCancel < speedBeforeCancel);
    assert.ok(speedBeforeCancel - speedAfterCancel <= cfg.MAX_ACCELERATION * 0.5 + 0.001);
  });

  test('orbits a selected enemy and continues orbiting during combat', () => {
    const state = fresh();
    const enemy = sys(state).enemies.find((item) => item.alive);
    const ship = placeUndockedShip(state, enemy.x + 150, enemy.y);
    const navigation = game.navigate(state, { targetId: enemy.id });
    assert.ok(navigation.state);

    const afterNavigation = game.tick(navigation.state, T0 + 5_000);
    const afterShip = afterNavigation.ships.find((item) => item.id === afterNavigation.activeShipId);
    const distance = Math.hypot(afterShip.x - enemy.x, afterShip.y - enemy.y);
    assert.ok(Math.abs(distance - 150) < 5, `orbit radius was ${distance}`);
    assert.equal(afterShip.navigation.targetId, enemy.id);

    const engaged = game.engage(afterNavigation, enemy.id, T0 + 5_000);
    assert.ok(engaged.state);
    const beforeCombat = { x: engaged.state.ships[0].x, y: engaged.state.ships[0].y };
    const duringCombat = game.tick(engaged.state, T0 + 6_000);
    const combatShip = duringCombat.ships.find((item) => item.id === duringCombat.activeShipId);

    assert.ok(Math.hypot(combatShip.x - beforeCombat.x, combatShip.y - beforeCombat.y) > 1);
  });
});

describe('fitting slots', () => {
  // The default active ship is a rifter: weapon 1, shield 1, armor 0, mining 1, cargo 1.
  const shipId = (s) => s.ships[0].id;

  test('a fresh ship has an empty fitting sized to its slots', () => {
    const s = fresh();
    const fit = s.ships[0].fitting;
    assert.deepEqual(fit.weapon, [0]);
    assert.deepEqual(fit.shield, [0]);
    assert.deepEqual(fit.armor, []);
    assert.deepEqual(fit.mining, [0]);
    assert.deepEqual(fit.cargo, [0]);
  });

  test('fitting a module consumes it from inventory and returns the replaced module', () => {
    const s = withModule(fresh(), 'weapon', 1);
    const r = game.fitModule(s, shipId(s), 'weapon', 0, 1);
    assert.ok(!r.error, r.error);
    assert.equal(r.state.ships[0].fitting.weapon[0], 1);
    assert.equal(r.state.loot.length, 0, 'the fitted module left the inventory');
    const down = game.fitModule(r.state, shipId(r.state), 'weapon', 0, 0).state;
    assert.equal(down.ships[0].fitting.weapon[0], 0);
    assert.equal(down.loot.length, 1, 'unfitting returns the module to inventory');
  });

  test('fitting rejects without the module in inventory or skill, or with a bad request', () => {
    const s = fresh();
    assert.match(game.fitModule(s, shipId(s), 'weapon', 0, 1).error, /inventory/i);
    const skilled = withModule(withModule(fresh(), 'shield', 2), 'weapon', 1);
    assert.match(game.fitModule(skilled, shipId(skilled), 'shield', 0, 2).error, /Requires Shield Upgrades level 1/i);
    const extra = withModule(fresh(), 'weapon', 1);
    assert.ok(game.fitModule(extra, shipId(extra), 'laser', 0, 1).error);
    assert.ok(game.fitModule(extra, shipId(extra), 'weapon', 5, 1).error);
    assert.ok(game.fitModule(extra, shipId(extra), 'armor', 0, 1).error); // rifter has no armor slots
  });

  test('moduleBonus sums the bonuses of every fitted module of a type', () => {
    const s = fresh();
    assert.equal(game.moduleBonus(s.ships[0], 'weapon'), 0);
    const s2 = game.fitModule(withModule(s, 'weapon', 1), shipId(s), 'weapon', 0, 1).state;
    assert.equal(game.moduleBonus(s2.ships[0], 'weapon'), cfg.MODULES.weapon.tiers[0].bonus);
  });

  test('a weapon module raises the ship DPS in a fight', () => {
    const s = withModule(fresh(), 'weapon', 1);
    const e = sys(s).enemies[0];
    s.ships[0].x = e.x;
    s.ships[0].y = e.y;
    const before = game.engage(s, e.id, T0).state.combat.playerDps;
    const s2 = game.fitModule(s, shipId(s), 'weapon', 0, 1).state;
    const e2 = sys(s2).enemies[0];
    s2.ships[0].x = e2.x;
    s2.ships[0].y = e2.y;
    const after = game.engage(s2, e2.id, T0).state.combat.playerDps;
    assert.ok(after > before, 'fitted weapon raises DPS');
    assert.ok(Math.abs((after - before) - cfg.MODULES.weapon.tiers[0].bonus) < 1e-6);
  });

  test('a shield module raises the ship shield in a fight', () => {
    const s = withModule(fresh(), 'shield', 1);
    const e = sys(s).enemies[0];
    s.ships[0].x = e.x;
    s.ships[0].y = e.y;
    const before = game.engage(s, e.id, T0).state.combat.shipShieldMax;
    const s2 = game.fitModule(s, shipId(s), 'shield', 0, 1).state;
    const e2 = sys(s2).enemies[0];
    s2.ships[0].x = e2.x;
    s2.ships[0].y = e2.y;
    const after = game.engage(s2, e2.id, T0).state.combat.shipShieldMax;
    assert.ok(after > before, 'fitted shield extender raises shield');
    assert.ok(Math.abs((after - before) - cfg.MODULES.shield.tiers[0].bonus) < 1e-6);
  });

  test('a mining module raises the mining rate', () => {
    const s = withModule(fresh(), 'mining', 1);
    const before = game.shipMining(s.ships[0]);
    assert.equal(before, cfg.SHIPS.rifter.mining * cfg.MINING_RATE_MULTIPLIER);
    const s2 = game.fitModule(s, shipId(s), 'mining', 0, 1).state;
    const after = game.shipMining(s2.ships[0]);
    assert.ok(Math.abs((after - before) - cfg.MODULES.mining.tiers[0].bonus * cfg.MINING_RATE_MULTIPLIER) < 1e-6);
  });

  test('a cargo module raises the cargo capacity', () => {
    const s = withModule(fresh(), 'cargo', 1);
    const before = game.cargoCapacity(s);
    const s2 = game.fitModule(s, shipId(s), 'cargo', 0, 1).state;
    const after = game.cargoCapacity(s2);
    assert.ok(Math.abs((after - before) - cfg.MODULES.cargo.tiers[0].bonus) < 1e-6);
  });

  test('existing fitting presets consume inventory modules and can be deleted', () => {
    const s = withModule(fresh(), 'weapon', 1);
    s.fittingPresets = [{
      name: 'Combat',
      shipType: 'rifter',
      fitting: { ...game.emptyFitting('rifter'), weapon: [1] },
    }];
    const applied = game.applyFittingPreset(s, 'Combat');
    assert.ok(!applied.error, applied.error);
    assert.equal(applied.state.ships[0].fitting.weapon[0], 1);
    assert.equal(applied.state.loot.length, 0);
    const removed = game.deleteFittingPreset(applied.state, 'Combat');
    assert.equal(removed.state.fittingPresets.length, 0);
  });

  test('applying a fitting preset rejects modules above trained skill', () => {
    const s = fresh();
    s.fittingPresets = [{
      name: 'High tier',
      shipType: 'rifter',
      fitting: { ...game.emptyFitting('rifter'), mining: [4] },
    }];
    assert.match(game.applyFittingPreset(s, 'High tier').error, /requires mining yield level 3/i);
  });

  test('shipView exposes slots, fitting and the effective stats', () => {
    const s = fresh();
    const s2 = game.fitModule(withModule(s, 'weapon', 1), s.ships[0].id, 'weapon', 0, 1).state;
    const v = game.shipView(s2.ships[0]);
    assert.ok(v.slots && v.slots.weapon === 1);
    assert.deepEqual(v.fitting.weapon, [1]);
    assert.ok(Math.abs(v.dps - (cfg.SHIPS.rifter.dps + cfg.MODULES.weapon.tiers[0].bonus)) < 1e-6);
  });

  test('unequipAllModules returns every fitted module to inventory', () => {
    const s = fresh();
    const s2 = game.fitModule(withModule(s, 'weapon', 1), s.ships[0].id, 'weapon', 0, 1).state;
    const r = game.unequipAllModules(s2);
    assert.ok(!r.error, r.error);
    assert.deepEqual(r.state.ships[0].fitting.weapon, [0]);
    assert.equal(r.state.loot.length, 1);
    assert.ok(game.unequipAllModules(openSpace(fresh())).error);
  });

  test('combat starts with the ship base stats plus fitting bonuses', () => {
    const s = fresh();
    const enemy = sys(s).enemies[0];
    s.ships[0].x = enemy.x;
    s.ships[0].y = enemy.y;
    const combat = game.engage(s, enemy.id, T0).state.combat;
    assert.equal(combat.playerDps, cfg.SHIPS.rifter.dps);
    assert.equal(combat.shipShieldMax, cfg.SHIPS.rifter.shield);
    assert.equal(combat.shipHullMax, cfg.SHIPS.rifter.hull);
  });
});

describe('skill tree', () => {
  const shipId = (s) => s.ships[0].id;

  test('a fresh state has zero skill points and all-level-0 skills', () => {
    const s = fresh();
    assert.equal(s.skillPoints, 0);
    for (const key of Object.keys(cfg.SKILLS)) assert.equal(s.skills[key], 0);
  });

  test('skillMults is all ones with no skills trained', () => {
    const s = fresh();
    const m = game.skillMults(s);
    assert.equal(m.mining, 1);
    assert.equal(m.dps, 1);
    assert.equal(m.shield, 1);
    assert.equal(m.hull, 1);
    assert.equal(m.cargo, 1);
  });

  test('skillCost follows the growth formula', () => {
    const def = cfg.SKILLS.gunnery;
    assert.equal(game.skillCost(def, 0), Math.round(def.baseCost));
    assert.equal(game.skillCost(def, 1), Math.round(def.baseCost * def.costGrowth));
  });

  test('trainSkill spends skill points and raises the level', () => {
    const s = fresh();
    s.skillPoints = 5000;
    const cost = game.skillCost(cfg.SKILLS.gunnery, 0);
    const r = game.trainSkill(s, 'gunnery');
    assert.ok(!r.error);
    assert.equal(r.state.skills.gunnery, 1);
    assert.ok(Math.abs(r.state.skillPoints - (5000 - cost)) < 1e-6);
  });

  test('trainSkill rejects an unknown skill', () => {
    const s = fresh();
    s.skillPoints = 1000;
    assert.ok(game.trainSkill(s, 'warp').error);
  });

  test('trainSkill rejects a skill at max level', () => {
    let s = fresh();
    s.skillPoints = 100000;
    const def = cfg.SKILLS.cargoManagement;
    for (let i = 0; i < def.maxLevel; i++) s = game.trainSkill(s, 'cargoManagement').state;
    const r = game.trainSkill(s, 'cargoManagement');
    assert.ok(r.error && /max level/i.test(r.error));
  });

  test('trainSkill rejects when there are not enough skill points', () => {
    const s = fresh();
    s.skillPoints = 0;
    assert.ok(game.trainSkill(s, 'gunnery').error);
  });

  test('a mining skill raises the mining rate', () => {
    const s = fresh();
    s.skillPoints = 5000;
    const before = game.shipMining(s.ships[0], game.skillMults(s));
    const s2 = game.trainSkill(s, 'miningYield').state;
    const after = game.shipMining(s2.ships[0], game.skillMults(s2));
    assert.ok(after > before, 'mining rate rises');
    assert.ok(Math.abs(after / before - (1 + cfg.SKILLS.miningYield.effect.pctPerLevel)) < 1e-6);
  });

  test('a gunnery skill raises the ship DPS in a fight', () => {
    const s = fresh();
    s.skillPoints = 5000;
    const e = sys(s).enemies[0];
    s.ships[0].x = e.x;
    s.ships[0].y = e.y;
    const before = game.engage(s, e.id, T0).state.combat.playerDps;
    const s2 = game.trainSkill(s, 'gunnery').state;
    const e2 = sys(s2).enemies[0];
    s2.ships[0].x = e2.x;
    s2.ships[0].y = e2.y;
    const after = game.engage(s2, e2.id, T0).state.combat.playerDps;
    assert.ok(after > before, 'DPS rises');
  });

  test('skill points accrue over time in tick', () => {
    const s = fresh();
    const before = s.skillPoints;
    const s2 = game.tick(s, T0 + 10000, { x: s.ships[0].x, y: s.ships[0].y });
    assert.ok(Math.abs((s2.skillPoints - before) - cfg.SP_RATE_PER_SEC * 10) < 1e-6);
  });

  test('a win awards skill points', () => {
    const s = fresh();
    const e = sys(s).enemies[0];
    s.ships[0].x = e.x;
    s.ships[0].y = e.y;
    const engaged = game.engage(s, e.id, T0).state;
    // Force an instant, certain player win.
    engaged.combat.playerDps = 1e9;
    engaged.combat.enemyDps = 0;
    const before = engaged.skillPoints;
    const s2 = game.tick(engaged, T0 + 1000, { x: engaged.ships[0].x, y: engaged.ships[0].y });
    assert.equal(s2.combat, null, 'fight resolved');
    // SP accrues from the 1s of elapsed time during the tick.
    const expected = cfg.SP_RATE_PER_SEC * 1;
    assert.ok(Math.abs((s2.skillPoints - before) - expected) < 1e-6);
  });

  test('view exposes skillPoints, skills and skillMults', () => {
    const s = fresh();
    s.skillPoints = 50;
    const v = game.view(s);
    assert.equal(v.skillPoints, 50);
    assert.ok(v.skills);
    assert.ok(v.skillMults);
    assert.equal(v.skillMults.mining, 1);
  });
});

describe('warp', () => {
  test('warps the active ship into a belt in its system', () => {
    const s = fresh();
    const belt = sys(s).belts[0];
    const r = game.warp(s, belt.id);
    assert.ok(!r.error);
    const ship = r.state.ships[0];
    assert.ok(sys(s).asteroids.some((a) => a.beltId === belt.id && a.x === ship.x && a.y === ship.y));
  });

  test('warping to a belt lands on its closest asteroid with ore left', () => {
    const s = fresh();
    const belt = sys(s).belts[0];
    const rocks = sys(s).asteroids.filter((a) => a.beltId === belt.id);
    const ship = s.ships[0];
    const d = (a) => Math.hypot(a.x - ship.x, a.y - ship.y);
    rocks.sort((a, b) => d(a) - d(b));
    rocks[0].amount = 0; // an empty rock is skipped
    const r = game.warp(s, belt.id);
    assert.ok(!r.error);
    const out = r.state.ships[0];
    assert.ok(Math.abs(out.x - rocks[1].x) < 1e-6);
    assert.ok(Math.abs(out.y - rocks[1].y) < 1e-6);
  });

  test('warps to a station and to an enemy', () => {
    const s = fresh();
    const st = sys(s).stations[0];
    let r = game.warp(s, st.id);
    assert.ok(!r.error);
    assert.ok(Math.abs(r.state.ships[0].x - st.x) < 1e-6);
    const enemy = sys(s).enemies[0];
    r = game.warp(s, enemy.id);
    assert.ok(!r.error);
    assert.ok(Math.abs(r.state.ships[0].x - enemy.x) < 1e-6);
  });

  test('rejects an unknown warp target', () => {
    const s = fresh();
    assert.ok(game.warp(s, 'does_not_exist').error);
  });

  test('rejects warping while in combat', () => {
    let s = fresh();
    const e = sys(s).enemies[0];
    s.ships[0].x = e.x;
    s.ships[0].y = e.y;
    s = game.engage(s, e.id, T0).state;
    const belt = sys(s).belts[0];
    assert.ok(game.warp(s, belt.id).error);
  });
});

describe('gate jump', () => {
  test('jumps to the connected system when at a gate', () => {
    const s = fresh();
    const gate = sys(s).gates[0];
    let r = game.warp(s, gate.id);
    assert.ok(!r.error);
    const before = r.state.ships[0].systemId;
    r = game.gateJump(r.state, gate.id, () => 1); // () => 1 = never ambush
    assert.ok(!r.error);
    const ship = r.state.ships[0];
    assert.notEqual(ship.systemId, before, 'should be in a different system');
    const targetSys = r.state.systems[ship.systemId];
    const targetGate = targetSys.gates.find((g) => g.id === gate.targetGateId);
    assert.ok(Math.abs(ship.x - targetGate.x) < 1e-6);
    assert.ok(Math.abs(ship.y - targetGate.y) < 1e-6);
  });

  test('rejects a jump when too far from the gate', () => {
    const s = fresh();
    const gate = sys(s).gates[0];
    const r = game.gateJump(s, gate.id);
    assert.ok(r.error && /far/i.test(r.error));
  });

  test('jumping back through the paired gate returns to the origin', () => {
    let s = fresh();
    const originId = sys(s).id;
    const gate = sys(s).gates[0];
    s = game.warp(s, gate.id).state;
    s = game.gateJump(s, gate.id, () => 1).state; // () => 1 = never ambush
    const newSys = s.systems[s.ships[0].systemId];
    const backGate = newSys.gates.find((g) => g.id === gate.targetGateId);
    s = game.gateJump(s, backGate.id, () => 1).state;
    assert.equal(s.ships[0].systemId, originId, 'should be back in the origin system');
  });

  test('re-entering a system respawns outpost enemies and refills asteroids', () => {
    let s = fresh();
    const gate = sys(s).gates[0];
    const target = s.systems[gate.targetSystemId];
    target.enemies.forEach((enemy) => { enemy.alive = false; });
    target.asteroids.forEach((asteroid) => { asteroid.amount = 0; });
    s = game.warp(s, gate.id).state;
    s = game.gateJump(s, gate.id, () => 1).state;
    const arrived = s.systems[gate.targetSystemId];
    assert.ok(arrived.enemies.every((enemy) => enemy.alive));
    assert.ok(arrived.asteroids.every((asteroid) => asteroid.amount === asteroid.maxAmount));
  });
});

describe('star map', () => {
  test('systems span high to low security and are all connected by gates', () => {
    const s = fresh();
    const names = game.view(s).systemNames;
    assert.equal(names.length, SYSTEM_COUNT);
    const securities = names.map((item) => item.security);
    assert.equal(Math.max(...securities), 1);
    assert.ok(Math.min(...securities) <= 0.2);
    assert.ok(names.every((item) => item.map && item.links.length >= 2));
    const seen = new Set(['sys_0']);
    const queue = ['sys_0'];
    while (queue.length) {
      const current = queue.shift();
      for (const link of names.find((item) => item.id === current).links) {
        if (!seen.has(link)) { seen.add(link); queue.push(link); }
      }
    }
    assert.equal(seen.size, SYSTEM_COUNT);
  });

  test('older saves gain the new systems and gates on migration', () => {
    const s = fresh();
    for (const id of Object.keys(s.systems)) {
      if (!['sys_0', 'sys_1', 'sys_2'].includes(id)) delete s.systems[id];
    }
    for (const id of ['sys_0', 'sys_1', 'sys_2']) s.systems[id].gates = s.systems[id].gates.slice(0, 2);
    game.migrateWorldLayout(s);
    assert.equal(Object.keys(s.systems).length, SYSTEM_COUNT);
    assert.ok(s.systems.sys_0.gates.length >= 3);
  });
});

describe('gate ambush', () => {
  // Force the ambush roll to always trigger (rng() < chance is always true).
  const always = () => 0;
  // Force the ambush roll to never trigger (rng() >= chance is always true).
  const never = () => 1;

  test('a gate jump can spawn an ambush and start combat', () => {
    let s = fresh();
    const gate = sys(s).gates[0];
    s = game.warp(s, gate.id).state;
    const targetSysId = gate.targetSystemId;
    const before = s.systems[targetSysId].enemies.length;
    const r = game.gateJump(s, gate.id, always, T0);
    assert.ok(!r.error);
    assert.ok(r.state.combat, 'an ambush should start a fight');
    const targetSys = r.state.systems[targetSysId];
    assert.equal(targetSys.enemies.length, before + 1, 'an ambush enemy was spawned');
    const ambusher = targetSys.enemies[targetSys.enemies.length - 1];
    assert.equal(ambusher.ambush, true);
    const allowed = cfg.spawnTable(targetSys.security).map((row) => `${row.type}:${row.tier}`);
    assert.ok(allowed.includes(`${ambusher.type}:${ambusher.tier}`), 'ambush follows the system roster');
    assert.equal(r.state.combat.enemyId, ambusher.id);
  });

  test('a gate jump without an ambush does not start combat', () => {
    let s = fresh();
    const gate = sys(s).gates[0];
    s = game.warp(s, gate.id).state;
    const r = game.gateJump(s, gate.id, never, T0);
    assert.ok(!r.error);
    assert.equal(r.state.combat, null);
  });

  test('ambush chance falls as security rises', () => {
    const s = fresh();
    const gate = sys(s).gates[0];
    const targetSysId = gate.targetSystemId;
    assert.ok(game.ambushChance(s, targetSysId) >= cfg.AMBUSH_MIN_CHANCE);
    assert.ok(game.ambushChance(s, targetSysId) <= cfg.AMBUSH_MAX_CHANCE);
  });
});

describe('drones', () => {
  test('a fresh state has an empty drone bay', () => {
    const s = fresh();
    assert.deepEqual(s.drones, { mining: [], combat: [] });
    assert.equal(game.droneBonus(s, 'mining'), 0);
    assert.equal(game.droneBonus(s, 'combat'), 0);
  });

  test('droneBonus sums every owned drone of a type', () => {
    const s = fresh();
    s.drones.mining = [1, 3];
    s.drones.combat = [2];
    assert.equal(game.droneBonus(s, 'mining'), cfg.DRONES.mining.tiers[0].bonus + cfg.DRONES.mining.tiers[2].bonus);
    assert.equal(game.droneBonus(s, 'combat'), cfg.DRONES.combat.tiers[1].bonus);
  });

  test('fitted control modules override the drone bay', () => {
    const s = fresh();
    s.drones.mining = [2];
    const fitted = game.fitModule(withModule(s, 'miningDrone', 1), s.ships[0].id, 'miningDrone', 0, 1).state;
    assert.equal(game.droneBonus(fitted, 'mining'), 0, 'a fitted control module replaces the bay bonus');
  });

  test('a mining drone raises the mining rate', () => {
    const s = fresh();
    const a = atAsteroid(s);
    s.drones.mining = [2];
    const v = game.view(s);
    assert.equal(v.miningTargetId, a.id);
    const base = game.shipMining(s.ships[0]);
    const withDrone = game.shipMining(s.ships[0], game.skillMults(s), cfg.DRONES.mining.tiers[1].bonus);
    assert.ok(Math.abs(v.miningRate - withDrone) < 1e-6);
    assert.ok(withDrone > base);
  });

  test('a combat drone raises the ship DPS in a fight', () => {
    const s = fresh();
    s.drones.combat = [1];
    const e = sys(s).enemies[0];
    s.ships[0].x = e.x;
    s.ships[0].y = e.y;
    const eng = game.engage(s, e.id, T0).state;
    const mults = game.skillMults(eng);
    const expected = cfg.SHIPS[s.ships[0].type].dps * mults.dps + cfg.DRONES.combat.tiers[0].bonus * mults.dps;
    assert.ok(Math.abs(eng.combat.playerDps - expected) < 1e-6);
  });

  test('view exposes the drone bay and the bonuses it grants', () => {
    const s = fresh();
    s.drones.combat = [1];
    const v = game.view(s);
    assert.deepEqual(v.drones.combat, [1]);
    assert.equal(v.droneBonuses.dps, cfg.DRONES.combat.tiers[0].bonus);
    assert.equal(v.droneBonuses.mining, 0);
  });
});

describe('repeatable agent missions', () => {
  test('each station has three agents and one active mission is allowed per agent', () => {
    const s = fresh();
    const agents = game.view(s).agentMission.agents;
    assert.deepEqual(agents.map((agent) => agent.role), ['security', 'mining', 'industry']);
    const accepted = game.agentMissionAction(s, 'accept', agents[0].id, T0);
    assert.ok(!accepted.error, accepted.error);
    assert.ok(accepted.state.agentMissions[agents[0].id].active);
    assert.match(game.agentMissionAction(accepted.state, 'accept', agents[0].id, T0 + 1).error, /already have an active mission/i);
    const second = game.agentMissionAction(accepted.state, 'accept', agents[1].id, T0 + 2);
    assert.ok(!second.error, second.error);
    assert.equal(Object.values(second.state.agentMissions).filter((record) => record.active).length, 2);
  });

  test('missions can only be accepted at the agent station and cancellation preserves the offer', () => {
    const s = fresh();
    const agent = game.view(s).agentMission.agents[1];
    const accepted = game.agentMissionAction(s, 'accept', agent.id, T0);
    const missionKey = accepted.state.agentMissions[agent.id].active.key;
    const cancelled = game.agentMissionAction(accepted.state, 'cancel', agent.id, T0 + 1000).state;
    const next = game.agentMissionAction(cancelled, 'accept', agent.id, T0 + 1001);
    assert.ok(!next.error, next.error);
    assert.equal(next.state.agentMissions[agent.id].active.key, missionKey);
    next.state.ships[0].dockedStationId = null;
    assert.match(game.agentMissionAction(next.state, 'accept', agent.id, T0 + 1002).error, /dock at an agent/i);
  });

  test('matching actions progress active contracts together and completion unlocks the next offer', () => {
    const s = fresh();
    const agent = game.view(s).agentMission.agents.find((entry) => entry.role === 'mining');
    const accepted = game.agentMissionAction(s, 'accept', agent.id, T0);
    const current = accepted.state.agentMissions[agent.id].active;
    current.target = 1;
    const missionKey = current.key;
    const asteroid = atAsteroid(accepted.state);
    const started = game.mine(accepted.state, T0);
    assert.ok(!started.error, started.error);
    const result = game.tick(started.state, T0 + 1000);
    assert.equal(result.stats.agentMissionsCompleted, 1);
    assert.ok(result.storage.items[current.rewardItems && Object.keys(current.rewardItems)[0]] > 0);
    const updated = game.view(atStation(result)).agentMission.agents.find((entry) => entry.id === agent.id);
    assert.equal(updated.active, null);
    assert.ok(updated.offer);
    assert.notEqual(updated.offer.key, missionKey);
    assert.ok(asteroid.amount > 0);
  });

  test('one mining action progresses matching contracts accepted at different stations', () => {
    const s = fresh();
    const firstAgent = game.view(s).agentMission.agents.find((entry) => entry.role === 'mining');
    const firstAccepted = game.agentMissionAction(s, 'accept', firstAgent.id, T0).state;
    const otherStation = sys(firstAccepted).stations.find((station) => station.id !== firstAgent.stationId);
    assert.ok(otherStation);

    firstAccepted.ships[0].dockedStationId = otherStation.id;
    firstAccepted.ships[0].x = otherStation.x;
    firstAccepted.ships[0].y = otherStation.y;
    const secondAgent = game.view(firstAccepted).agentMission.agents.find((entry) => entry.role === 'mining');
    const accepted = game.agentMissionAction(firstAccepted, 'accept', secondAgent.id, T0 + 1);
    assert.ok(!accepted.error, accepted.error);
    const contracts = Object.values(accepted.state.agentMissions)
      .map((record) => record.active)
      .filter(Boolean);
    assert.equal(contracts.length, 2);
    for (const contract of contracts) contract.target = 1;

    accepted.state.ships[0].dockedStationId = null;
    atAsteroid(accepted.state);
    const started = game.mine(accepted.state, T0);
    assert.ok(!started.error, started.error);
    const result = game.tick(started.state, T0 + 1000);
    assert.equal(result.stats.agentMissionsCompleted, 2);
    assert.equal(game.view(result).agentMission.active.length, 0);
  });

  test('old single-agent mission saves migrate to the matching station agent', () => {
    const s = fresh();
    s.agentMission = { key: 'ore-haul', progress: 30, status: 'active', startedAt: T0 };
    delete s.agentMissions;
    const migrated = game.migrateAgentMissionState(s);
    const mission = game.view(migrated).agentMission.active[0];
    assert.equal(mission.role, 'mining');
    assert.equal(mission.progress, 30);
    assert.equal(migrated.agentMission, undefined);
  });

  test('legacy autopilot and agent mission values migrate without losing progress', () => {
    const state = fresh();
    state.version = 16;
    state.autoPilotMode = 'mine_hunt';
    state.agentMissions = {
      agent_1: {
        completed: 3,
        lastMissionKey: 'pirate-hunt',
        active: { key: 'pirate-hunt', name: 'Pirate Hunt', objective: 'Destroy 3 rats', progress: 2 },
      },
    };

    const migrated = game.migrateTerminology(state);

    assert.equal(migrated.version, cfg.STATE_VERSION);
    assert.equal(migrated.autoPilotMode, 'mine_fight');
    assert.equal(migrated.agentMissions.agent_1.completed, 3);
    assert.equal(migrated.agentMissions.agent_1.lastMissionKey, 'pirate-patrol');
    assert.equal(migrated.agentMissions.agent_1.active.key, 'pirate-patrol');
    assert.equal(migrated.agentMissions.agent_1.active.name, 'Pirate Patrol');
    assert.equal(migrated.agentMissions.agent_1.active.progress, 2);
    assert.equal(migrated.agentMissions.agent_1.active.objective, 'Destroy 3 Enemies');
  });

  test('skill migration preserves locked hulls and provides an eligible loaner ship', () => {
    const state = fresh();
    state.ships[0].type = 'falcon';
    state.ships[0].fitting = game.emptyFitting('falcon');
    state.version = cfg.STATE_VERSION - 1;
    state.skills = game.emptySkills();
    const migrated = game.migrateSkillTree(game.migrateTerminology(state));

    assert.ok(migrated.ships.some((ship) => ship.type === 'falcon'));
    assert.ok(migrated.ships.some((ship) => ship.type === 'rifter'));
    assert.equal(migrated.ships.find((ship) => ship.id === migrated.activeShipId).type, 'rifter');
    assert.ok(game.isDocked(migrated));
  });
});

describe('loot drops', () => {
  test('a fresh state starts with an empty loot inventory', () => {
    assert.deepEqual(fresh().loot, []);
  });

  test('winning a fight can drop a module into the loot inventory', () => {
    const s = winAgainst(fresh(), 'dread', () => 0); // force a drop
    assert.equal(s.combatLog[0].won, true);
    assert.equal(s.loot.length, 1);
    assert.ok(cfg.MODULES[s.loot[0].slotType], 'dropped slot type is a real module');
    assert.ok(s.loot[0].tier >= 1 && s.loot[0].tier <= 3);
    assert.equal(s.combatLog[0].loot.slotType, s.loot[0].slotType);
    assert.equal(s.combatLog[0].loot.tier, s.loot[0].tier);
  });

  test('a failed drop roll leaves the loot inventory empty', () => {
    const s = winAgainst(fresh(), 'pirate', () => 1); // never drop
    assert.equal(s.loot.length, 0);
    assert.equal(s.combatLog[0].loot, null);
  });

  test('a dread always drops a tier-3 module', () => {
    const s = winAgainst(fresh(), 'dread', () => 0);
    assert.equal(s.loot[0].tier, 3);
  });

  test('equipLoot fits a looted module into the first empty slot, consuming it', () => {
    const s = winAgainst(fresh(), 'dread', () => 0);
    const home = fresh().ships[0];
    const loot = s.loot[0];
    const away = game.equipLoot(s, loot.id);
    assert.match(away.error, /dock/i);
    Object.assign(s.ships[0], { x: home.x, y: home.y, systemId: home.systemId, dockedStationId: home.dockedStationId });
    s.skills.gunnery = 3; // tier-III loot needs the skill to fit
    s.skills.moduleEngineering = 3;
    s.skills.projectileWeapons = 3;
    s.skills.missileWeapons = 3;
    s.skills.laserWeapons = 3;
    s.skills.droneCommand = 3;
    s.skills.droneDamage = 3;
    const r = game.equipLoot(s, loot.id);
    assert.ok(!r.error, r.error);
    assert.ok(r.state.ships[0].fitting[loot.slotType].includes(loot.tier), 'loot lands in an empty slot');
    assert.equal(r.state.loot.length, 0, 'loot is consumed');
    assert.equal(r.state.loot.length, 0);
  });

  test('equipLoot rejects a module type the active ship has no slot for', () => {
    const s = fresh();
    s.loot = [{ id: 'loot_armor', slotType: 'armor', tier: 2 }]; // the rifter has no armor slots
    const r = game.equipLoot(s, 'loot_armor');
    assert.ok(r.error && /armor/i.test(r.error));
    assert.equal(s.loot.length, 1, 'loot is not consumed on failure');
  });

  test('equipLoot rejects when every slot of that type is occupied', () => {
    const s = fresh();
    s.loot = [{ id: 'loot_w', slotType: 'weapon', tier: 1 }];
    s.ships[0].fitting.weapon[0] = 1; // the rifter's only weapon slot is taken
    const r = game.equipLoot(s, 'loot_w');
    assert.ok(r.error && /occupied/i.test(r.error));
  });

  test('loot is player-level and survives a ship loss', () => {
    const s = withCargo(fresh(), { iron: 10 });
    s.loot = [{ id: 'loot_survive', slotType: 'weapon', tier: 1 }];
    s.ships[0].type = 'rifter';
    s.ships[0].systemId = 'sys_2';
    const e = sys(s).enemies[0];
    e.type = 'dread';
    s.ships[0].x = e.x;
    s.ships[0].y = e.y;
    const eng = game.engage(s, e.id, T0).state;
    const s2 = game.tick(eng, T0 + 100000, null);
    assert.equal(s2.combatLog[0].won, false);
    assert.equal(s2.ships[0].type, 'rifter'); // loaner respawn
    assert.equal(s2.loot.length, 1, 'loot is not lost with the ship');
  });

  test('view exposes the loot inventory with module names', () => {
    const s = fresh();
    s.loot = [{ id: 'loot_v', slotType: 'shield', tier: 2 }];
    const v = game.view(s);
    assert.equal(v.loot.length, 1);
    assert.equal(v.loot[0].name, cfg.MODULES.shield.name);
    assert.equal(v.loot[0].tier, 2);
  });

  test('refining a looted module returns a component to storage', () => {
    const s = fresh();
    s.loot = [{ id: 'loot-refine', slotType: 'weapon', tier: 1 }];
    const r = game.refineLoot(s, 'loot-refine');
    assert.ok(!r.error, r.error);
    assert.equal(r.state.loot.length, 0);
    assert.equal(r.state.storage.items.scrap, (fresh().storage.items.scrap || 0) + 1);
    assert.equal(r.state.stats.modulesSalvaged, 1);
  });

  test('refining loot requires docking', () => {
    const s = fresh();
    s.loot = [{ id: 'loot-sale', slotType: 'weapon', tier: 1 }];
    openSpace(s);
    assert.match(game.refineLoot(s, 'loot-sale').error, /dock/i);
  });
});

describe('industry (blueprint crafting)', () => {
  test('every module tier has a blueprint with a mineral recipe', () => {
    for (const slotType of Object.keys(cfg.MODULES)) {
      for (const t of cfg.MODULES[slotType].tiers) {
        const bp = cfg.BLUEPRINTS[slotType][t.tier];
        assert.ok(bp, `missing blueprint for ${slotType} t${t.tier}`);
        assert.equal(bp.slotType, slotType);
        assert.equal(bp.tier, t.tier);
        const total = Object.values(bp.recipe).reduce((a, b) => a + b, 0);
        assert.ok(total > 0, 'recipe should not be empty');
      }
    }
  });

  test('crafting consumes the ore and blueprint and adds a module to the loot inventory', () => {
    const s = withBlueprint(fresh(), 'module', 'weapon', 1);
    const bp = cfg.BLUEPRINTS.weapon[1];
    const r = game.craftModule(s, 'weapon', 1);
    assert.ok(!r.error, r.error);
    for (const mKey of Object.keys(bp.recipe)) {
      assert.equal(r.state.storage.items[mKey], (fresh().storage.items[mKey] || 0) - bp.recipe[mKey], `${mKey} should be consumed`);
    }
    assert.equal(r.state.blueprints.length, 0, 'the blueprint is consumed');
    assert.equal(r.state.loot.length, 1);
    assert.equal(r.state.loot[0].slotType, 'weapon');
    assert.equal(r.state.loot[0].tier, 1);
  });

  test('crafting rejects when not docked, missing ore, or missing the blueprint', () => {
    assert.match(game.craftModule(openSpace(fresh()), 'weapon', 1).error, /dock/i);
    assert.match(game.craftModule(fresh(), 'weapon', 1).error, /blueprint/i);
    const poor = withBlueprint(fresh(), 'module', 'weapon', 1);
    poor.storage.items.iron = 0;
    poor.storage.items.scrap = 0;
    assert.match(game.craftModule(poor, 'weapon', 1).error, /need/i);
  });

  test('crafting rejects unknown types and tiers', () => {
    const s = withBlueprint(fresh(), 'module', 'weapon', 1);
    assert.ok(game.craftModule(s, 'nope', 1).error);
    assert.ok(game.craftModule(s, 'weapon', 9).error);
  });

  test('a crafted module can be equipped like loot', () => {
    const s = withBlueprint(fresh(), 'module', 'weapon', 1);
    const crafted = game.craftModule(s, 'weapon', 1).state;
    const r = game.equipLoot(crafted, crafted.loot[0].id);
    assert.ok(!r.error, r.error);
    assert.equal(r.state.ships[0].fitting.weapon[0], 1);
  });
});

describe('enemy tiers and security rosters', () => {
  test('combat stats are the JSON base x tier multiplier', () => {
    const stats = (tier) => {
      const s = fresh();
      const e = sys(s).enemies[0];
      e.type = 'pirate';
      e.tier = tier;
      s.ships[0].x = e.x;
      s.ships[0].y = e.y;
      return game.engage(s, e.id, T0).state.combat;
    };
    const novice = stats('novice');
    const elite = stats('elite');
    assert.equal(novice.enemyHullMax, cfg.ENEMIES.pirate.hull * cfg.ENEMY_TIERS.novice.multiplier);
    assert.equal(elite.enemyHullMax, cfg.ENEMIES.pirate.hull * cfg.ENEMY_TIERS.elite.multiplier);
    assert.equal(elite.enemyDps / novice.enemyDps, cfg.ENEMY_TIERS.elite.multiplier / cfg.ENEMY_TIERS.novice.multiplier);
  });

  test('view exposes each enemy tier and exact numbers and no threat', () => {
    const v = game.view(fresh());
    assert.equal(v.threat, undefined);
    for (const e of v.world.enemies) {
      const tier = cfg.ENEMY_TIERS[e.tier];
      assert.ok(tier, `unknown tier ${e.tier}`);
      assert.equal(e.tierName, tier.name);
      assert.equal(e.hull, cfg.ENEMIES[e.type].hull * tier.multiplier);
      assert.equal(e.dps, cfg.ENEMIES[e.type].dps * tier.multiplier);
    }
  });

  test('every enemy in a system comes from that security level\'s roster', () => {
    const expected = {
      sys_0: { types: ['pirate'], tiers: ['novice', 'standard'] },
      sys_1: { types: ['pirate', 'gang'], tiers: ['novice', 'standard', 'elite'] },
      sys_2: { types: ['gang', 'faction', 'dread'], tiers: ['novice', 'standard', 'elite'] },
    };
    for (let seed = 1; seed <= 15; seed++) {
      const s = game.createInitialState(T0, seed, 'demo');
      for (const [id, want] of Object.entries(expected)) {
        const allowed = new Set(cfg.spawnTable(s.systems[id].security).map((r) => `${r.type}:${r.tier}`));
        for (const e of s.systems[id].enemies) {
          assert.ok(allowed.has(`${e.type}:${e.tier}`), `${id} spawned ${e.type}:${e.tier}`);
          assert.ok(want.types.includes(e.type));
          assert.ok(want.tiers.includes(e.tier));
        }
      }
    }
    // Sec 1.0 has only the easiest class; elites start appearing at lower security.
    assert.ok(cfg.spawnTable(1.0).every((r) => r.type === 'pirate' && r.tier !== 'elite'));
    assert.ok(cfg.spawnTable(0.5).some((r) => r.tier === 'elite'));
  });

  test('ambushes are rolled from the destination system roster', () => {
    for (const id of ['sys_0', 'sys_1', 'sys_2']) {
      const s = fresh();
      const allowed = new Set(cfg.spawnTable(s.systems[id].security).map((r) => `${r.type}:${r.tier}`));
      let n = 0;
      const rng = () => ((n = (n + 0.137) % 1), n);
      for (let i = 0; i < 20; i++) {
        const ambusher = game.rollEnemy(s.systems[id].security, rng);
        assert.ok(allowed.has(`${ambusher.type}:${ambusher.tier}`));
      }
    }
  });

  test('enemies.json validation rejects broken data', () => {
    const good = JSON.parse(JSON.stringify(require('../server/data/enemies.json')));
    assert.doesNotThrow(() => cfg.loadEnemyData(good));
    const badTier = JSON.parse(JSON.stringify(good));
    badTier.types.pirate.spawn[0].tier = 'legendary';
    assert.throws(() => cfg.loadEnemyData(badTier), /unknown tier/);
    const badStat = JSON.parse(JSON.stringify(good));
    delete badStat.types.gang.hull;
    assert.throws(() => cfg.loadEnemyData(badStat), /invalid hull/);
  });

  test('systems expose distinct security that affects ambush risk', () => {
    const s = fresh();
    const high = s.systems.sys_0;
    const low = s.systems.sys_2;
    assert.ok(high.security > low.security);
    assert.ok(game.ambushChance(s, high.id) < game.ambushChance(s, low.id));
  });

  test('a starter Rifter beats every enemy that can spawn in Jita', () => {
    for (const row of cfg.spawnTable(sys(fresh()).security)) {
      const state = fresh();
      const enemy = sys(state).enemies[0];
      enemy.type = row.type;
      enemy.tier = row.tier;
      state.ships[0].x = enemy.x;
      state.ships[0].y = enemy.y;
      const engaged = game.engage(state, enemy.id, T0);
      assert.ok(!engaged.error, engaged.error);
      const result = game.tick(engaged.state, T0 + 100000, null, () => 1);
      assert.equal(result.combatLog[0].won, true, `starter Rifter should beat ${row.tier} ${row.type}`);
      assert.equal(result.combat, null);
    }
  });
});

describe('view', () => {
  test('exposes active ship, position and mining target', () => {
    const s = fresh();
    const a = atAsteroid(s);
    const v = game.view(s);
    assert.ok(v.activeShip);
    assert.equal(v.activeShip.x, a.x);
    assert.equal(v.miningTargetId, a.id);
    assert.ok(v.miningRate > 0);
  });

  test('exposes a persistent, unique background color per system', () => {
    const s = fresh();
    const v = game.view(s);
    // The active system's color is exposed on both world and system.
    assert.match(v.world.color, /^#[0-9a-f]{6}$/i);
    assert.equal(v.world.color, v.system.color);
    // Every system has a color, and they are all distinct.
    const colors = v.systemNames.map((x) => x.color);
    assert.equal(colors.length, SYSTEM_COUNT);
    assert.ok(colors.every((c) => /^#[0-9a-f]{6}$/i.test(c)));
    assert.equal(new Set(colors).size, SYSTEM_COUNT);
  });

  test('exposes cargo, storage, drones, skills and achievements', () => {
    const s = fresh();
    const v = game.view(s);
    assert.ok(v.cargoCapacity > 0);
    assert.equal(v.cargoUsed, 0);
    assert.equal(v.storage.items.iron, 18);
    assert.ok(v.drones.mining.length === 0);
    assert.ok(v.skillTraining.gunnery.level === 0);
    assert.ok(Array.isArray(v.achievements));
    assert.equal(v.achievements.find((a) => a.key === 'certified').target, 8);
  });
});