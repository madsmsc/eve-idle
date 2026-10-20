'use strict';

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const game = require('../server/game');
const cfg = require('../server/config');

const T0 = 1_000_000_000_000;

function fresh(seed = 42) {
  return game.createInitialState(T0, seed);
}

// The star system the active ship is in.
function sys(state) {
  const active = state.ships.find((sh) => sh.id === state.activeShipId);
  return state.systems[active.systemId];
}

// Put the active ship exactly on the first non-empty asteroid.
function atAsteroid(state) {
  const a = sys(state).asteroids.find((x) => x.amount > 0);
  state.ships[0].x = a.x;
  state.ships[0].y = a.y;
  return a;
}

function atStation(state) {
  state.ships[0].x = sys(state).stations[0].x;
  state.ships[0].y = sys(state).stations[0].y;
}

// Set the active ship's cargo hold (merges `partial` over a fresh hold).
function withCargo(state, partial) {
  const active = state.ships.find((sh) => sh.id === state.activeShipId);
  active.cargo = { iron: 0, bauxite: 0, gadolinium: 0, megacyte: 0, ...partial };
  return state;
}

describe('world generation', () => {
  test('generates multiple systems, each bounded with all POI types', () => {
    const s = fresh();
    assert.ok(Object.keys(s.systems).length >= 3, 'should have at least 3 systems');
    for (const sys of Object.values(s.systems)) {
      assert.equal(sys.width, cfg.WORLD_SIZE);
      assert.ok(sys.star);
      assert.ok(sys.planets.length >= 1);
      assert.ok(sys.stations.length >= 1);
      assert.ok(sys.belts.length > 0);
      assert.ok(sys.asteroids.length > 0);
      assert.ok(sys.enemies.length > 0);
      const beltIds = new Set(sys.belts.map((b) => b.id));
      for (const a of sys.asteroids) {
        assert.ok(a.x >= 0 && a.x <= cfg.WORLD_SIZE);
        assert.ok(a.y >= 0 && a.y <= cfg.WORLD_SIZE);
        assert.ok(a.amount > 0);
        assert.ok(cfg.MINERALS[a.mineral]);
        assert.ok(beltIds.has(a.beltId));
      }
    }
  });

  test('every system has gates that link to other systems', () => {
    const s = fresh();
    for (const sys of Object.values(s.systems)) {
      assert.ok(sys.gates.length >= 2, `${sys.name} should have at least 2 gates`);
      for (const g of sys.gates) {
        assert.ok(s.systems[g.targetSystemId], `gate target ${g.targetSystemId} exists`);
        assert.ok(g.targetGateId);
        assert.ok(g.x >= 0 && g.x <= cfg.WORLD_SIZE);
        assert.ok(g.y >= 0 && g.y <= cfg.WORLD_SIZE);
      }
    }
  });

  test('gates are paired symmetrically (jumping back returns to the origin gate)', () => {
    const s = fresh();
    const sys = Object.values(s.systems)[0];
    for (const g of sys.gates) {
      const target = s.systems[g.targetSystemId];
      const back = target.gates.find((x) => x.id === g.targetGateId);
      assert.ok(back, `return gate ${g.targetGateId} exists in ${g.targetSystemId}`);
      assert.equal(back.targetSystemId, sys.id);
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
    for (const sys of Object.values(s.systems)) {
      for (const belt of sys.belts) {
        const inRange = sys.asteroids.some(
          (a) => a.beltId === belt.id && a.amount > 0 &&
            Math.hypot(a.x - belt.x, a.y - belt.y) <= cfg.MINING_RANGE
        );
        assert.ok(inRange, `belt ${belt.name} has no asteroid in mining range of its center`);
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
});

describe('market prices', () => {
  test('every system has a price for every mineral', () => {
    const s = fresh();
    for (const sys of Object.values(s.systems)) {
      for (const key of Object.keys(cfg.MINERALS)) {
        assert.ok(sys.prices[key] >= 1, `${sys.name} has a ${key} price`);
      }
    }
  });

  test('prices vary between systems so hauling is profitable', () => {
    const s = fresh();
    const sysList = Object.values(s.systems);
    let hasSpread = false;
    for (const key of Object.keys(cfg.MINERALS)) {
      const prices = sysList.map((sys) => sys.prices[key]);
      if (Math.max(...prices) > Math.min(...prices)) hasSpread = true;
    }
    assert.ok(hasSpread, 'some mineral has different prices in different systems');
  });

  test('selling uses the active system price', () => {
    const s = withCargo(fresh(), { iron: 100 });
    const homePrice = sys(s).prices.iron;
    const r = game.sellMinerals(s, 'iron', 10).state;
    assert.ok(Math.abs(r.isk - (cfg.START_ISK + 10 * homePrice)) < 1e-6);
  });
});

describe('isValidState', () => {
  test('accepts a fresh state', () => {
    assert.ok(game.isValidState(fresh()));
  });
  test('rejects a v1 (non-spatial) state', () => {
    const old = { version: 1, isk: 1, ships: [{ id: 'x', type: 'rifter', level: 1 }] };
    assert.equal(game.isValidState(old), false);
  });
  test('rejects null / missing world', () => {
    assert.equal(game.isValidState(null), false);
    assert.equal(game.isValidState({ version: cfg.STATE_VERSION }), false);
  });
});

describe('modes', () => {
  test('demo is the default mode with the sandbox starting ISK', () => {
    const s = fresh();
    assert.equal(s.mode, 'demo');
    assert.equal(s.isk, cfg.START_ISK);
    assert.deepEqual(s.mission, { active: null, step: 0, flags: {}, completed: [] });
  });
  test('story mode starts with zero ISK and keeps its mode through reset', () => {
    const s = game.createInitialState(T0, 42, 'story');
    assert.equal(s.mode, 'story');
    assert.equal(s.isk, cfg.START_STORY_ISK);
    const r = game.reset(s, T0 + 1000);
    assert.equal(r.mode, 'story');
    assert.equal(r.isk, cfg.START_STORY_ISK);
  });
  test('an unknown mode falls back to demo', () => {
    const s = game.createInitialState(T0, 42, 'arcade');
    assert.equal(s.mode, 'demo');
  });
  test('view exposes mode and mission', () => {
    const s = game.createInitialState(T0, 42, 'story');
    const v = game.view(s);
    assert.equal(v.mode, 'story');
    assert.equal(v.mission.active, 'm1');
    assert.equal(v.mission.title, 'Under Attack');
    assert.equal(v.mission.objective, 'Destroy the attacker frigate');
    assert.equal(v.mission.target, 1);
    assert.deepEqual(v.mission.completed, []);
  });
});

describe('missions', () => {
  test('a story save starts m1 with its target spawned near the station', () => {
    const s = game.createInitialState(T0, 42, 'story');
    assert.equal(s.mission.active, 'm1');
    assert.equal(s.ships[0].fitting.weapon[0], 1, 'm1 grants a Weapon I');
    const home = sys(s).stations[0];
    const attacker = sys(s).enemies.find((e) => e.missionTag === 'attacker');
    assert.ok(attacker, 'attacker spawned');
    assert.ok(attacker.alive);
    assert.ok(Math.hypot(attacker.x - home.x, attacker.y - home.y) < 1000, 'attacker near the station');
  });

  test('certification unlocks a post-course Placid mission', () => {
    const s = game.createInitialState(T0, 42, 'story');
    s.mission.completed = ['m1', 'm2', 'm3', 'm4', 'm5', 'm6', 'm7', 'm8'];
    game.startMission(s, 'm9');
    const placid = s.systems.sys_1;
    assert.equal(placid.enemies.filter((enemy) => enemy.missionTag === 'placidraider' && enemy.alive).length, 2);
    const gate = s.systems.sys_0.gates[0];
    s.ships[0].x = gate.x;
    s.ships[0].y = gate.y;
    const jumped = game.gateJump(s, gate.id, () => 1, T0);
    assert.ok(!jumped.error, jumped.error);
    assert.equal(jumped.state.ships[0].systemId, 'sys_1');
  });

  test('killing the m1 target completes it, pays the reward and starts m2', () => {
    const s = game.createInitialState(T0, 42, 'story');
    const before = s.isk;
    const attacker = sys(s).enemies.find((e) => e.missionTag === 'attacker');
    s.ships[0].fitting.weapon[0] = 4; // fit a Faction weapon to guarantee the win
    s.ships[0].x = attacker.x;
    s.ships[0].y = attacker.y;
    const eng = game.engage(s, attacker.id, T0).state;
    const s2 = game.tick(eng, T0 + 100000, null, () => 1);
    assert.equal(s2.combatLog[0].won, true);
    assert.deepEqual(s2.mission.completed, ['m1']);
    assert.equal(s2.mission.active, 'm2');
    assert.equal(s2.isk, before + cfg.MISSIONS.m1.completion.isk + cfg.MISSION_ENEMIES.attacker.iskReward);
    assert.equal(s2.ships[0].fitting.range[0], 1, 'm2 grant fits a Range Amplifier I');
  });

  test('the storyline blocks jump gates until certified', () => {
    const s = game.createInitialState(T0, 42, 'story');
    const gate = sys(s).gates[0];
    s.ships[0].x = gate.x;
    s.ships[0].y = gate.y;
    const r = game.gateJump(s, gate.id);
    assert.ok(r.error && /pilot training/i.test(r.error));
  });

  test('certification (m8) unlocks jump gates', () => {
    const s = game.createInitialState(T0, 42, 'story');
    s.mission.completed = cfg.MISSION_ORDER.slice();
    const gate = sys(s).gates[0];
    s.ships[0].x = gate.x;
    s.ships[0].y = gate.y;
    const r = game.gateJump(s, gate.id);
    assert.ok(!r.error, r.error);
  });

  test('mining counts towards a mine objective', () => {
    const s = game.createInitialState(T0, 42, 'story');
    s.mission.active = 'm5';
    s.mission.flags = {};
    const a = sys(s).asteroids.find((x) => x.amount > 0);
    s.ships[0].x = a.x;
    s.ships[0].y = a.y;
    const s2 = game.tick(s, T0 + 2000, { x: a.x, y: a.y });
    assert.ok((s2.mission.flags.mined || 0) > 0, 'mined ore counted');
    assert.equal(s2.mission.active, 'm5', 'not complete after one short tick');
  });

  test('m7 crafting objective counts each target recipe', () => {
    const s = game.createInitialState(T0, 42, 'story');
    game.startMission(s, 'm7');
    assert.equal(s.ships[0].fitting.cargo[0], 3, 'm7 grant fits a cargo expander');
    s.ships[0].x = sys(s).stations[0].x;
    s.ships[0].y = sys(s).stations[0].y;
    const bp1 = cfg.BLUEPRINTS.weapon[1].recipe;
    s.ships[0].cargo = { iron: bp1.iron + 5, bauxite: bp1.bauxite + 5, gadolinium: bp1.gadolinium + 5, megacyte: bp1.megacyte + 5 };
    let s2 = game.craftModule(s, 'weapon', 1).state;
    assert.equal(s2.mission.active, 'm7', 'one craft is not enough');
    const bp2 = cfg.BLUEPRINTS.shield[2].recipe;
    s2.ships[0].cargo = { iron: bp2.iron + 5, bauxite: bp2.bauxite + 5, gadolinium: bp2.gadolinium + 5, megacyte: bp2.megacyte + 5 };
    s2 = game.craftModule(s2, 'shield', 2).state;
    assert.deepEqual(s2.mission.completed, ['m7']);
    assert.equal(s2.mission.active, 'm8');
  });

  test('m3 last stand: losing the scripted wave completes it and grants the m4 clone frigate (no loaner)', () => {
    const s = game.createInitialState(T0, 42, 'story');
    game.startMission(s, 'm3');
    const wave = sys(s).enemies.find((e) => e.missionTag === 'waveship');
    assert.ok(wave, 'waveship spawned');
    s.ships[0].x = wave.x;
    s.ships[0].y = wave.y;
    const eng = game.engage(s, wave.id, T0).state;
    const s2 = game.tick(eng, T0 + 100000, null, () => 1);
    assert.equal(s2.combatLog[0].won, false, 'the wave is unwinnable');
    assert.deepEqual(s2.mission.completed, ['m3']);
    assert.equal(s2.mission.active, 'm4');
    // The scripted death suppresses the free loaner; the m4 grant is the respawn.
    assert.equal(s2.ships.length, 1, 'no free loaner on top of the replacement');
    assert.equal(s2.ships[0].fitting.weapon[0], 1, 'm4 grants a Weapon I');
    assert.equal(game.view(s2).docked, false, 'the replacement spawns outside the dock');
  });

  test('m4: docking at the station completes it and starts m5', () => {
    const s = game.createInitialState(T0, 42, 'story');
    game.startMission(s, 'm3');
    const wave = sys(s).enemies.find((e) => e.missionTag === 'waveship');
    s.ships[0].x = wave.x;
    s.ships[0].y = wave.y;
    let s2 = game.tick(game.engage(s, wave.id, T0).state, T0 + 100000, null, () => 1);
    assert.equal(s2.mission.active, 'm4');
    const home = sys(s2).stations[0];
    s2.ships[0].x = home.x;
    s2.ships[0].y = home.y;
    s2 = game.tick(s2, T0 + 100001);
    assert.deepEqual(s2.mission.completed, ['m3', 'm4']);
    assert.equal(s2.mission.active, 'm5');
    assert.equal(s2.ships[0].fitting.mining[0], 1, 'm5 grant fits a Mining Laser I');
  });

  test('m6: killing the drone hub completes it, pays ISK and grants a mining drone', () => {
    const s = game.createInitialState(T0, 42, 'story');
    game.startMission(s, 'm6');
    const hub = sys(s).enemies.find((e) => e.missionTag === 'dronhub');
    assert.ok(hub, 'drone hub spawned');
    s.ships[0].fitting.weapon[0] = 4; // fit a Faction weapon to guarantee the win
    s.ships[0].x = hub.x;
    s.ships[0].y = hub.y;
    const eng = game.engage(s, hub.id, T0).state;
    const before = eng.isk;
    const s2 = game.tick(eng, T0 + 100000, null, () => 1);
    assert.equal(s2.combatLog[0].won, true);
    assert.deepEqual(s2.mission.completed, ['m6']);
    assert.equal(s2.mission.active, 'm7');
    assert.equal(s2.isk, before + cfg.MISSIONS.m6.completion.isk);
    assert.ok((s2.drones.mining || []).some((d) => d.type === 'mining' && d.tier === 1), 'mining drone granted');
  });
});

describe('spatial mining', () => {
  test('mines the asteroid you stand on, yielding its mineral', () => {
    const s = fresh();
    const a = atAsteroid(s);
    const before = a.amount;
    const rate = game.shipMining(s.ships[0]);
    const s2 = game.tick(s, T0 + 10_000, { x: a.x, y: a.y });
    const a2 = sys(s2).asteroids.find((x) => x.id === a.id);
    assert.ok(a2.amount < before);
    assert.ok(Math.abs(s2.ships[0].cargo[a.mineral] - (before - a2.amount)) < 1e-6);
    assert.ok(Math.abs(s2.stats.totalMineralsMined - (before - a2.amount)) < 1e-6);
    assert.ok(rate > 0);
  });

  test('does not mine when far from any asteroid', () => {
    const s = fresh();
    atStation(s); // station is kept clear of asteroids
    const s2 = game.tick(s, T0 + 10_000, { x: s.ships[0].x, y: s.ships[0].y });
    assert.equal(s2.stats.totalMineralsMined, 0);
  });

  test('mining is capped by offline time and cargo', () => {
    const s = fresh();
    const a = atAsteroid(s);
    // Refill the asteroid so the cap, not depletion, is what limits mining.
    a.amount = 10_000_000;
    const s2 = game.tick(s, T0 + 1000 * 3600 * 100, { x: a.x, y: a.y }); // 100h
    const offlineCap = game.shipMining(s.ships[0]) * cfg.MAX_OFFLINE_SECONDS;
    const cargoCap = cfg.SHIPS[s.ships[0].type].cargo;
    const expected = Math.min(offlineCap, cargoCap);
    assert.ok(Math.abs(s2.stats.totalMineralsMined - expected) < 1e-3);
  });

  test('mining stops when the cargo hold is full', () => {
    const s = fresh();
    const a = atAsteroid(s);
    a.amount = 10_000_000;
    const cap = cfg.SHIPS[s.ships[0].type].cargo;
    s.ships[0].cargo[a.mineral] = cap - 10; // nearly full
    const s2 = game.tick(s, T0 + 1000, { x: a.x, y: a.y });
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
    const s2 = game.tick(s, T0 + 5_000, { x: a.x, y: a.y });
    assert.equal(s2.stats.totalMineralsMined, 0);
  });
});

// find an enemy near a given point (for combat tests)
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

describe('buyShip / sellShip / setActive', () => {
  test('buying spawns a ship at the station and charges ISK', () => {
    const s = fresh();
    const s2 = game.buyShip(s, 'falcon').state;
    assert.equal(s2.ships.length, 2);
    assert.ok(Math.abs(s2.isk - (cfg.START_ISK - 5000)) < 1e-6);
    const f = s2.ships[1];
    assert.ok(Math.hypot(f.x - sys(s2).stations[0].x, f.y - sys(s2).stations[0].y) < 1e-6);
  });

  test('rejects an unaffordable purchase', () => {
    const r = game.buyShip(fresh(), 'brutix');
    assert.ok(r.error);
  });

  test('selling a ship refunds its value', () => {
    const s = game.buyShip(fresh(), 'falcon').state;
    const id = s.ships[1].id;
    const before = s.isk;
    const s2 = game.sellShip(s, id).state;
    assert.equal(s2.ships.length, 1);
    assert.ok(Math.abs(s2.isk - (before + 2500)) < 1e-6);
  });

  test('setActive switches the piloted ship', () => {
    const s = game.buyShip(fresh(), 'falcon').state;
    const s2 = game.setActive(s, s.ships[1].id).state;
    assert.equal(s2.activeShipId, s.ships[1].id);
  });
});

describe('sellMinerals', () => {
  function withMineral(state, mineral, amt) {
    return withCargo(state, { [mineral]: amt });
  }
  test('sells cargo for ISK', () => {
    const s = withMineral(fresh(), 'iron', 100);
    const price = sys(s).prices.iron;
    const r = game.sellMinerals(s, 'iron', 40);
    assert.ok(Math.abs(r.state.ships[0].cargo.iron - 60) < 1e-6);
    assert.ok(Math.abs(r.state.isk - (cfg.START_ISK + 40 * price)) < 1e-6);
  });
  test('rejects selling more than owned', () => {
    const s = withMineral(fresh(), 'iron', 10);
    assert.ok(game.sellMinerals(s, 'iron', 50).error);
  });
  test('rejects invalid amounts', () => {
    const s = withMineral(fresh(), 'iron', 100);
    assert.ok(game.sellMinerals(s, 'iron', 0).error);
    assert.ok(game.sellMinerals(s, 'iron', 'abc').error);
  });

  test('sellAll dumps the whole hold for ISK', () => {
    const s = withCargo(fresh(), { iron: 100, bauxite: 50 });
    const prices = sys(s).prices;
    const r = game.sellAll(s).state;
    assert.equal(r.ships[0].cargo.iron, 0);
    assert.equal(r.ships[0].cargo.bauxite, 0);
    const expected = 100 * prices.iron + 50 * prices.bauxite;
    assert.ok(Math.abs(r.isk - (cfg.START_ISK + expected)) < 1e-6);
  });

  test('sellAll requires docking and something to sell', () => {
    const s = withCargo(fresh(), { iron: 100 });
    s.ships[0].x = 100;
    s.ships[0].y = 100; // not docked
    assert.ok(game.sellAll(s).error);
    const empty = fresh();
    assert.ok(game.sellAll(empty).error); // docked but empty hold
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
  }

  test('deposits minerals from the cargo hold into storage', () => {
    const s = withCargo(fresh(), { iron: 150, bauxite: 60 });
    const r = game.deposit(s, 'iron', 100);
    assert.equal(r.state.ships[0].cargo.iron, 50);
    assert.equal(r.state.storage.minerals.iron, 100);
    assert.equal(r.state.storage.minerals.bauxite, 0);
  });

  test('deposit rejects when not docked, over-depositing or with a bad amount', () => {
    const s = withCargo(fresh(), { iron: 10 });
    s.ships[0].x = 100;
    s.ships[0].y = 100; // not docked
    assert.ok(game.deposit(s, 'iron', 5).error);
    assert.ok(game.deposit(s, 'iron', 50).error); // more than the hold
    assert.ok(game.deposit(s, 'iron', 0).error);
    assert.ok(game.deposit(s, 'not-a-mineral', 5).error);
  });

  test('withdraws minerals from storage into the cargo hold', () => {
    const s = withCargo(fresh(), {});
    s.storage = game.emptyStorage();
    s.storage.minerals.iron = 300;
    const r = game.withdraw(s, 'iron', 40);
    assert.equal(r.state.ships[0].cargo.iron, 40);
    assert.equal(r.state.storage.minerals.iron, 260);
  });

  test('withdraw respects the cargo hold capacity', () => {
    const s = withCargo(fresh(), { iron: 50 });
    s.storage = game.emptyStorage();
    s.storage.minerals.iron = 500;
    const r = game.withdraw(s, 'iron', 'all');
    assert.equal(r.state.ships[0].cargo.iron, cfg.SHIPS.rifter.cargo); // hold full
    assert.ok(r.state.storage.minerals.iron > 0);
  });

  test('withdraw rejects when not docked, over-withdrawing or with a full hold', () => {
    const s = withCargo(fresh(), {});
    s.storage = game.emptyStorage();
    s.storage.minerals.iron = 100;
    s.ships[0].x = 100;
    s.ships[0].y = 100; // not docked
    assert.ok(game.withdraw(s, 'iron', 10).error);
    s.ships[0].x = sys(s).stations[0].x;
    s.ships[0].y = sys(s).stations[0].y;
    assert.ok(game.withdraw(s, 'iron', 500).error); // more than stored
    withCargo(s, { iron: cfg.SHIPS.rifter.cargo });
    assert.ok(game.withdraw(s, 'iron', 1).error); // no room in the hold
  });

  test('quantum storage is shared across systems', () => {
    const s = withCargo(fresh(), { bauxite: 80 });
    const deposited = game.deposit(s, 'bauxite', 80).state;
    atOtherStation(deposited);
    const r = game.withdraw(deposited, 'bauxite', 40);
    assert.equal(r.state.storage.minerals.bauxite, 40);
    assert.equal(r.state.ships[0].cargo.bauxite, 40);
  });

  test('storage is exposed in the view and survives ship loss', () => {
    const s = withCargo(fresh(), { iron: 30 });
    const deposited = game.deposit(s, 'iron', 30).state;
    const v = game.view(deposited);
    assert.equal(v.storage.minerals.iron, 30);
    assert.equal(deposited.storage.minerals.iron, 30); // state-level, not per-ship
  });
});

describe('docking', () => {
  test('is docked at a station, not in open space', () => {
    const s = fresh();
    assert.ok(game.isDocked(s));
    assert.equal(game.dockedStation(s).name, sys(s).stations[0].name);
    s.ships[0].x = 100;
    s.ships[0].y = 100;
    assert.equal(game.isDocked(s), false);
  });

  test('buying a ship requires docking', () => {
    const s = fresh();
    s.ships[0].x = 100;
    s.ships[0].y = 100;
    const r = game.buyShip(s, 'falcon');
    assert.ok(r.error && /dock/i.test(r.error));
  });

  test('selling minerals requires docking', () => {
    const s = withCargo(fresh(), { iron: 100 });
    s.ships[0].x = 100;
    s.ships[0].y = 100;
    const r = game.sellMinerals(s, 'iron', 10);
    assert.ok(r.error && /dock/i.test(r.error));
  });

  test('view exposes docked and dockedStation', () => {
    const s = fresh();
    const v = game.view(s);
    assert.equal(v.docked, true);
    assert.equal(v.dockedStation, sys(s).stations[0].name);
  });
});

describe('engage + combat', () => {
  // Place the active ship on a known enemy of a known type and engage it.
  function setupFight(state, shipType, enemyType) {
    state.ships[0].type = shipType;
    const e = sys(state).enemies[0];
    e.type = enemyType;
    state.ships[0].x = e.x;
    state.ships[0].y = e.y;
    return game.engage(state, e.id, T0).state;
  }

  // Seconds until the fight resolves from the current (start-of-fight) pools.
  function fightDuration(c) {
    const pTtd = c.enemyDps > 0 ? (c.shipShieldMax + c.shipHullMax) / c.enemyDps : Infinity;
    const eTtd = c.playerDps > 0 ? (c.enemyShieldMax + c.enemyHullMax) / c.playerDps : Infinity;
    return Math.min(pTtd, eTtd);
  }

  test('engages an enemy you are next to and captures live shield/hull', () => {
    const s = fresh();
    const e = sys(s).enemies[0];
    s.ships[0].x = e.x;
    s.ships[0].y = e.y;
    const r = game.engage(s, e.id, T0);
    assert.ok(!r.error);
    assert.equal(r.state.combat.enemyId, e.id);
    const c = r.state.combat;
    assert.ok(c.shipShield > 0 && c.shipHull > 0);
    assert.ok(c.enemyShield > 0 && c.enemyHull > 0);
    assert.ok(c.playerDps > 0 && c.enemyDps > 0);
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

  test('win destroys the enemy and pays ISK', () => {
    const s = setupFight(fresh(), 'brutix', 'pirate'); // brutix (fast TTK) beats a pirate
    const iskBefore = s.isk;
    const reward = Math.floor(s.combat.reward);
    const s2 = game.tick(s, T0 + Math.ceil(fightDuration(s.combat)) * 1000 + 1000, null);
    assert.equal(s2.combat, null);
    assert.ok(s2.combatLog[0].won);
    assert.ok(Math.abs(s2.isk - (iskBefore + reward)) < 1e-6);
    assert.equal(sys(s2).enemies[0].alive, false);
    assert.equal(s2.stats.combatsWon, 1);
  });

  test('loss destroys the ship and its cargo, and pays insurance', () => {
    const s = setupFight(fresh(), 'rifter', 'dread'); // rifter (slow TTK) loses to a dreadnought
    const s2 = game.tick(s, T0 + Math.ceil(fightDuration(s.combat)) * 1000 + 1000, null);
    assert.equal(s2.combat, null);
    assert.equal(s2.combatLog[0].won, false);
    assert.equal(s2.combatLog[0].shipLost, true);
    // The destroyed ship is gone, but a free loaner Rifter respawns so the game
    // can't soft-lock when you lose your only ship.
    assert.equal(s2.ships.length, 1);
    assert.equal(s2.ships[0].type, 'rifter');
    assert.equal(s2.activeShipId, s2.ships[0].id);
    assert.equal(s2.stats.combatsLost, 1);
    assert.equal(s2.stats.shipsLost, 1);
  });

  test('losing a ship when you have others just switches to the next ship', () => {
    // Dock at the station, buy a second ship, then fly the rifter to a dread.
    let s = fresh();
    const st = sys(s).stations[0];
    s = game.warp(s, st.id).state;
    s = game.buyShip(s, 'falcon').state;
    const e = sys(s).enemies[0];
    e.type = 'dread';
    const rifter = s.ships.find((sh) => sh.id === s.activeShipId);
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

  test('loss destroys the ship AND its cargo, and pays insurance', () => {
    const s = setupFight(withCargo(fresh(), { iron: 50, megacyte: 20 }), 'falcon', 'dread');
    const cargoBefore = Object.values(s.ships[0].cargo).reduce((a, b) => a + b, 0);
    const iskBefore = s.isk;
    const s2 = game.tick(s, T0 + Math.ceil(fightDuration(s.combat)) * 1000 + 1000, null);
    assert.equal(s2.combat, null);
    assert.equal(s2.combatLog[0].won, false);
    assert.equal(s2.ships.length, 1); // the falcon is gone; a loaner Rifter respawns
    assert.equal(s2.ships[0].type, 'rifter');
    assert.equal(s2.combatLog[0].cargoLost, cargoBefore);
    assert.equal(s2.stats.cargoLost, cargoBefore);
    // Insurance refunds a fraction of the falcon's cost (5000 * 0.5 = 2500).
    const insurance = Math.floor(cfg.SHIPS.falcon.cost * cfg.INSURANCE_FRACTION);
    assert.equal(s2.combatLog[0].insurance, insurance);
    assert.ok(Math.abs(s2.isk - (iskBefore + insurance)) < 1e-6);
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

  test('shield boost restores the shield, costs ISK, and goes on cooldown', () => {
    const s = setupFight(fresh(), 'brutix', 'pirate');
    const iskBefore = s.isk;
    const c = s.combat;
    // Take a second of damage so the shield is no longer full.
    const s1 = game.tick(s, T0 + 1000, null);
    const c1 = s1.combat;
    assert.ok(c1.shipShield < c.shipShieldMax, 'shield should have taken damage');
    const r = game.combatAction(s1, 'shieldBoost', T0 + 1000);
    assert.ok(!r.error);
    const c2 = r.state.combat;
    assert.equal(c2.shipShield, c2.shipShieldMax, 'shield restored to full');
    assert.ok(Math.abs(r.state.isk - (iskBefore - cfg.SHIELD_BOOST_COST)) < 1e-6);
    assert.ok(c2.boostReadyAt > c2.fightTime, 'boost should be on cooldown');
    const r2 = game.combatAction(r.state, 'shieldBoost', T0 + 1000);
    assert.ok(r2.error && /cooldown/i.test(r2.error));
  });

  test('shield boost is refused without enough ISK', () => {
    const s = setupFight(fresh(), 'brutix', 'pirate');
    s.isk = 0;
    const r = game.combatAction(s, 'shieldBoost', T0);
    assert.ok(r.error && /ISK/i.test(r.error));
  });

  test('overload boosts the player DPS, costs ISK, and goes on cooldown', () => {
    const s = setupFight(fresh(), 'brutix', 'pirate');
    const iskBefore = s.isk;
    const r = game.combatAction(s, 'overload', T0);
    assert.ok(!r.error);
    const c2 = r.state.combat;
    assert.ok(c2.overloadUntil > c2.fightTime, 'overload should be active');
    assert.ok(c2.overloadReadyAt > c2.fightTime, 'overload should be on cooldown');
    assert.ok(Math.abs(r.state.isk - (iskBefore - cfg.OVERLOAD_COST)) < 1e-6);
    const r2 = game.combatAction(r.state, 'overload', T0);
    assert.ok(r2.error && /cooldown/i.test(r2.error));
  });

  test('overload drains the enemy faster while active', () => {
    const s = setupFight(fresh(), 'vexor', 'faction'); // a ~10s fight, well past a 4s tick
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
    const iskBefore = s.isk;
    const enemyId = s.combat.enemyId;
    const r = game.combatAction(s, 'disengage', T0);
    assert.ok(!r.error);
    assert.equal(r.state.combat, null, 'combat should be over');
    assert.equal(r.state.ships.length, 1, 'ship should survive');
    assert.ok(Math.abs(r.state.isk - iskBefore) < 1e-6, 'no ISK gained');
    assert.equal(sys(r.state).enemies.find((e) => e.id === enemyId).alive, true, 'rat escapes');
    assert.equal(r.state.combatLog[0].disengaged, true);
    assert.equal(r.state.combatLog[0].won, false);
  });
});

describe('range free-fire window', () => {
  // Turn the first enemy into a mission-style short-range frigate (stats stored on
  // the enemy object, like spawnMissionEnemies does) and engage it.
  function engageEnemyOfType(state, type, rangeDelay = 0) {
    const e = sys(state).enemies[0];
    Object.assign(e, { type, shield: 45, hull: 90, dps: 12, rangeDelay });
    state.ships[0].x = e.x;
    state.ships[0].y = e.y;
    return game.engage(state, e.id, T0).state;
  }

  test('a short-range enemy grants an opening free-fire window before its guns bite', () => {
    const s = engageEnemyOfType(fresh(), 'shortrange', 2);
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
    Object.assign(e, { type: 'shortrange', shield: 45, hull: 90, dps: 12, rangeDelay: 2 });
    s = game.fitModule(s, s.ships[0].id, 'range', 0, 1).state;
    s.ships[0].x = e.x;
    s.ships[0].y = e.y;
    const c = game.engage(s, e.id, T0).state.combat;
    assert.equal(c.enemyRangeDelay, 2 + cfg.MODULES.range.tiers[0].bonus);
  });

  test('a normal rat has no free-fire window', () => {
    const s = engageEnemyOfType(fresh(), 'pirate');
    assert.equal(s.combat.enemyRangeDelay, 0);
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

  test('fitting a module deducts ISK and sets the slot tier', () => {
    const s = fresh();
    const cost = cfg.MODULES.weapon.tiers[0].cost;
    const r = game.fitModule(s, shipId(s), 'weapon', 0, 1);
    assert.ok(!r.error);
    assert.equal(r.state.ships[0].fitting.weapon[0], 1);
    assert.ok(Math.abs(r.state.isk - (cfg.START_ISK - cost)) < 1e-6);
  });

  test('moduleBonus sums the bonuses of every fitted module of a type', () => {
    const s = fresh();
    assert.equal(game.moduleBonus(s.ships[0], 'weapon'), 0);
    const s2 = game.fitModule(s, shipId(s), 'weapon', 0, 1).state;
    assert.equal(game.moduleBonus(s2.ships[0], 'weapon'), cfg.MODULES.weapon.tiers[0].bonus);
  });

  test('a weapon module raises the ship DPS in a fight', () => {
    const s = fresh();
    s.isk = 1_000_000;
    const e = sys(s).enemies[0];
    s.ships[0].x = e.x;
    s.ships[0].y = e.y;
    const before = game.engage(s, e.id, T0).state.combat.playerDps;
    const s2 = game.fitModule(s, shipId(s), 'weapon', 0, 3).state;
    const e2 = sys(s2).enemies[0];
    s2.ships[0].x = e2.x;
    s2.ships[0].y = e2.y;
    const after = game.engage(s2, e2.id, T0).state.combat.playerDps;
    assert.ok(after > before, 'fitted weapon raises DPS');
    assert.ok(Math.abs((after - before) - cfg.MODULES.weapon.tiers[2].bonus) < 1e-6);
  });

  test('a shield module raises the ship shield in a fight', () => {
    const s = fresh();
    s.isk = 1_000_000;
    const e = sys(s).enemies[0];
    s.ships[0].x = e.x;
    s.ships[0].y = e.y;
    const before = game.engage(s, e.id, T0).state.combat.shipShieldMax;
    const s2 = game.fitModule(s, shipId(s), 'shield', 0, 2).state;
    const e2 = sys(s2).enemies[0];
    s2.ships[0].x = e2.x;
    s2.ships[0].y = e2.y;
    const after = game.engage(s2, e2.id, T0).state.combat.shipShieldMax;
    assert.ok(after > before, 'fitted shield extender raises shield');
    assert.ok(Math.abs((after - before) - cfg.MODULES.shield.tiers[1].bonus) < 1e-6);
  });

  test('a mining module raises the mining rate', () => {
    const s = fresh();
    const before = game.shipMining(s.ships[0]);
    const s2 = game.fitModule(s, shipId(s), 'mining', 0, 3).state;
    const after = game.shipMining(s2.ships[0]);
    assert.ok(Math.abs((after - before) - cfg.MODULES.mining.tiers[2].bonus) < 1e-6);
  });

  test('a cargo module raises the cargo capacity', () => {
    const s = fresh();
    const before = game.cargoCapacity(s);
    const s2 = game.fitModule(s, shipId(s), 'cargo', 0, 1).state;
    const after = game.cargoCapacity(s2);
    assert.ok(Math.abs((after - before) - cfg.MODULES.cargo.tiers[0].bonus) < 1e-6);
  });

  test('fitting presets save, apply with the correct price delta, and delete', () => {
    let s = fresh();
    s = game.fitModule(s, shipId(s), 'weapon', 0, 1).state;
    s = game.saveFittingPreset(s, 'Combat').state;
    s = game.fitModule(s, shipId(s), 'weapon', 0, 0).state;
    const applied = game.applyFittingPreset(s, 'Combat');
    assert.ok(!applied.error, applied.error);
    assert.equal(applied.state.ships[0].fitting.weapon[0], 1);
    assert.equal(applied.state.isk, s.isk - cfg.MODULES.weapon.tiers[0].cost);
    const removed = game.deleteFittingPreset(applied.state, 'Combat');
    assert.equal(removed.state.fittingPresets.length, 0);
  });

  test('fitting preset rejects invalid names and insufficient funds', () => {
    const s = fresh();
    assert.ok(game.saveFittingPreset(s, '   ').error);
    const saved = game.saveFittingPreset(s, 'Expensive').state;
    saved.fittingPresets[0].fitting.weapon[0] = 4;
    saved.isk = 0;
    assert.match(game.applyFittingPreset(saved, 'Expensive').error, /not enough isk/i);
  });

  test('faction-grade Tier IV modules can be crafted and fitted', () => {
    let s = fresh();
    const recipe = cfg.BLUEPRINTS.weapon[4].recipe;
    s.ships[0].cargo = { ...s.ships[0].cargo, ...recipe };
    const crafted = game.craftModule(s, 'weapon', 4);
    assert.ok(!crafted.error, crafted.error);
    const fitted = game.equipLoot(crafted.state, crafted.state.loot[0].id);
    assert.ok(!fitted.error, fitted.error);
    assert.equal(fitted.state.ships[0].fitting.weapon[0], 4);
  });

  test('ship blueprints craft a ship from cargo at a station', () => {
    const s = fresh();
    const recipe = cfg.SHIP_BLUEPRINTS.falcon.recipe;
    s.ships[0].cargo = { ...s.ships[0].cargo, ...recipe };
    const r = game.craftShip(s, 'falcon');
    assert.ok(!r.error, r.error);
    assert.equal(r.state.ships.length, 2);
    assert.equal(r.state.ships[1].type, 'falcon');
    assert.equal(r.state.stats.shipsCrafted, 1);
  });

  test('downgrading a slot refunds the price difference', () => {
    const s = fresh();
    const t2 = cfg.MODULES.weapon.tiers[1].cost;
    const t1 = cfg.MODULES.weapon.tiers[0].cost;
    const up = game.fitModule(s, shipId(s), 'weapon', 0, 2).state;
    assert.ok(Math.abs(up.isk - (cfg.START_ISK - t2)) < 1e-6);
    const down = game.fitModule(up, shipId(up), 'weapon', 0, 1).state;
    assert.equal(down.ships[0].fitting.weapon[0], 1);
    assert.ok(Math.abs(down.isk - (cfg.START_ISK - t1)) < 1e-6);
  });

  test('unfitting a slot (tier 0) refunds the full cost', () => {
    const s = fresh();
    const t1 = cfg.MODULES.weapon.tiers[0].cost;
    const up = game.fitModule(s, shipId(s), 'weapon', 0, 1).state;
    const out = game.fitModule(up, shipId(up), 'weapon', 0, 0).state;
    assert.equal(out.ships[0].fitting.weapon[0], 0);
    assert.ok(Math.abs(out.isk - cfg.START_ISK) < 1e-6);
  });

  test('fitting rejects an unknown module type', () => {
    const s = fresh();
    assert.ok(game.fitModule(s, shipId(s), 'laser', 0, 1).error);
  });

  test('fitting rejects an invalid tier', () => {
    const s = fresh();
    assert.ok(game.fitModule(s, shipId(s), 'weapon', 0, 4).error);
    assert.ok(game.fitModule(s, shipId(s), 'weapon', 0, -1).error);
  });

  test('fitting rejects an out-of-range slot index', () => {
    const s = fresh();
    assert.ok(game.fitModule(s, shipId(s), 'weapon', 5, 1).error);
  });

  test('fitting rejects a slot type the ship has none of', () => {
    const s = fresh(); // rifter has no armor slots
    assert.ok(game.fitModule(s, shipId(s), 'armor', 0, 1).error);
  });

  test('fitting rejects when there is not enough ISK', () => {
    const s = fresh();
    s.isk = 0;
    assert.ok(game.fitModule(s, shipId(s), 'weapon', 0, 1).error);
  });

  test('shipView exposes slots, fitting and the effective stats', () => {
    const s = fresh();
    const s2 = game.fitModule(s, shipId(s), 'weapon', 0, 1).state;
    const v = game.shipView(s2.ships[0]);
    assert.ok(v.slots && v.slots.weapon === 1);
    assert.deepEqual(v.fitting.weapon, [1]);
    assert.ok(Math.abs(v.dps - (cfg.SHIPS.rifter.dps + cfg.MODULES.weapon.tiers[0].bonus)) < 1e-6);
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
    assert.equal(m.reward, 1);
  });

  test('skillCost follows the growth formula', () => {
    const def = cfg.SKILLS.gunnery;
    assert.equal(game.skillCost(def, 0), Math.round(def.baseCost));
    assert.equal(game.skillCost(def, 1), Math.round(def.baseCost * def.costGrowth));
  });

  test('trainSkill spends skill points and raises the level', () => {
    const s = fresh();
    s.skillPoints = 1000;
    const cost = game.skillCost(cfg.SKILLS.gunnery, 0);
    const r = game.trainSkill(s, 'gunnery');
    assert.ok(!r.error);
    assert.equal(r.state.skills.gunnery, 1);
    assert.ok(Math.abs(r.state.skillPoints - (1000 - cost)) < 1e-6);
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
    s.skillPoints = 1000;
    const before = game.shipMining(s.ships[0], game.skillMults(s));
    const s2 = game.trainSkill(s, 'miningYield').state;
    const after = game.shipMining(s2.ships[0], game.skillMults(s2));
    assert.ok(after > before, 'mining rate rises');
    assert.ok(Math.abs(after / before - (1 + cfg.SKILLS.miningYield.effect.pctPerLevel)) < 1e-6);
  });

  test('a gunnery skill raises the ship DPS in a fight', () => {
    const s = fresh();
    s.isk = 1_000_000;
    s.skillPoints = 1000;
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
    s.isk = 1_000_000;
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
    // SP from the kill plus the 1s of idle accrual during the tick.
    const expected = cfg.SP_PER_KILL + cfg.SP_RATE_PER_SEC * 1;
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
  test('warps the active ship to a belt in its system', () => {
    const s = fresh();
    const belt = sys(s).belts[0];
    const r = game.warp(s, belt.id);
    assert.ok(!r.error);
    const ship = r.state.ships[0];
    assert.ok(Math.abs(ship.x - belt.x) < 1e-6);
    assert.ok(Math.abs(ship.y - belt.y) < 1e-6);
  });

  test('warps to a station and to a rat', () => {
    const s = fresh();
    const st = sys(s).stations[0];
    let r = game.warp(s, st.id);
    assert.ok(!r.error);
    assert.ok(Math.abs(r.state.ships[0].x - st.x) < 1e-6);
    const rat = sys(s).enemies[0];
    r = game.warp(s, rat.id);
    assert.ok(!r.error);
    assert.ok(Math.abs(r.state.ships[0].x - rat.x) < 1e-6);
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
});

describe('faction standing', () => {
  test('a fresh state has neutral standing with every faction', () => {
    const s = fresh();
    for (const key of Object.keys(cfg.FACTIONS)) {
      assert.equal(s.standing[key], 0);
    }
  });

  test('clearing a rat in a faction system raises standing with that faction', () => {
    const s = fresh();
    const e = sys(s).enemies[0];
    e.type = 'pirate';
    s.ships[0].type = 'brutix';
    s.ships[0].x = e.x;
    s.ships[0].y = e.y;
    const eng = game.engage(s, e.id, T0).state;
    const faction = game.factionForSystem(sys(s).id);
    const before = eng.standing[faction];
    const after = game.tick(eng, T0 + 10000); // the brutix wins easily
    assert.equal(after.combat, null);
    assert.ok(after.standing[faction] > before, 'standing should rise on a win');
  });

  test('losing a ship in a faction system lowers standing with that faction', () => {
    const s = fresh();
    const e = sys(s).enemies[0];
    e.type = 'dread';
    s.ships[0].type = 'rifter';
    s.ships[0].x = e.x;
    s.ships[0].y = e.y;
    const eng = game.engage(s, e.id, T0).state;
    const faction = game.factionForSystem(sys(s).id);
    const before = eng.standing[faction];
    const after = game.tick(eng, T0 + 10000); // the rifter loses to a dread
    assert.equal(after.combat, null);
    assert.ok(after.standing[faction] < before, 'standing should fall on a loss');
  });

  test('standing is clamped to the configured range', () => {
    const s = fresh();
    const faction = game.factionForSystem(sys(s).id);
    s.standing[faction] = cfg.STANDING_MAX;
    const e = sys(s).enemies[0];
    e.type = 'pirate';
    s.ships[0].type = 'brutix';
    s.ships[0].x = e.x;
    s.ships[0].y = e.y;
    const eng = game.engage(s, e.id, T0).state;
    const after = game.tick(eng, T0 + 10000);
    assert.ok(after.standing[faction] <= cfg.STANDING_MAX, 'should not exceed the cap');
  });

  test('higher standing raises the market price of minerals', () => {
    const hi = withCargo(fresh(), { megacyte: 1000 });
    atStation(hi);
    hi.standing[game.factionForSystem(sys(hi).id)] = 10;
    const hiIsk = game.sellMinerals(hi, 'megacyte', 'all').state.isk;
    const lo = withCargo(fresh(), { megacyte: 1000 });
    atStation(lo);
    lo.standing[game.factionForSystem(sys(lo).id)] = -10;
    const loIsk = game.sellMinerals(lo, 'megacyte', 'all').state.isk;
    assert.ok(hiIsk > loIsk, 'higher standing should pay more');
  });

  test('view exposes standing, factions, activeFaction, priceBonus and ambush', () => {
    const v = game.view(fresh());
    assert.ok(v.standing);
    assert.ok(Array.isArray(v.factions) && v.factions.length === Object.keys(cfg.FACTIONS).length);
    assert.ok(v.activeFaction && v.activeFaction.name);
    assert.equal(v.priceBonus, 1); // neutral standing
    assert.ok(v.ambush && Object.keys(v.ambush).length === 3);
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
    assert.ok(ambusher.type === 'faction' || ambusher.type === 'dread');
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

  test('ambush chance falls as standing with the destination rises', () => {
    const s = fresh();
    const gate = sys(s).gates[0];
    const targetSysId = gate.targetSystemId;
    const faction = game.factionForSystem(targetSysId);
    const neutral = game.ambushChance(s, targetSysId);
    s.standing[faction] = 10;
    const liked = game.ambushChance(s, targetSysId);
    s.standing[faction] = -10;
    const disliked = game.ambushChance(s, targetSysId);
    assert.ok(liked < neutral, 'higher standing -> lower ambush chance');
    assert.ok(disliked > neutral, 'lower standing -> higher ambush chance');
  });

  test('ambush chance stays within the configured bounds', () => {
    const s = fresh();
    const gate = sys(s).gates[0];
    const targetSysId = gate.targetSystemId;
    const faction = game.factionForSystem(targetSysId);
    s.standing[faction] = -10;
    assert.ok(game.ambushChance(s, targetSysId) >= cfg.AMBUSH_MIN_CHANCE);
    s.standing[faction] = 10;
    assert.ok(game.ambushChance(s, targetSysId) <= cfg.AMBUSH_MAX_CHANCE);
  });
});

describe('drones', () => {
  // Dock at the home station, buy a drone, and return the result state.
  function buyAtStation(state, type, tier) {
    const st = sys(state).stations[0];
    const docked = game.warp(state, st.id).state;
    return game.buyDrone(docked, type, tier);
  }

  test('a fresh state has an empty drone bay', () => {
    const s = fresh();
    assert.deepEqual(s.drones, { mining: [], combat: [] });
    assert.equal(game.droneBonus(s, 'mining'), 0);
    assert.equal(game.droneBonus(s, 'combat'), 0);
  });

  test('buying a drone deducts ISK and adds it to the bay', () => {
    const r = buyAtStation(fresh(), 'mining', 1);
    assert.ok(!r.error, r.error);
    assert.equal(r.state.drones.mining.length, 1);
    assert.equal(r.state.drones.mining[0], 1);
    assert.ok(Math.abs(r.state.isk - (fresh().isk - cfg.DRONES.mining.tiers[0].cost)) < 1e-6);
  });

  test('droneBonus sums every owned drone of a type', () => {
    let s = buyAtStation(fresh(), 'mining', 1).state;
    s.isk = 1e9;
    s = game.buyDrone(s, 'mining', 3).state;
    s = game.buyDrone(s, 'combat', 2).state;
    const expectedMining = cfg.DRONES.mining.tiers[0].bonus + cfg.DRONES.mining.tiers[2].bonus;
    assert.equal(game.droneBonus(s, 'mining'), expectedMining);
    assert.equal(game.droneBonus(s, 'combat'), cfg.DRONES.combat.tiers[1].bonus);
  });

  test('buying a drone rejects when not docked', () => {
    const s = fresh();
    s.ships[0].x = 100; // far from the home station
    s.ships[0].y = 100;
    const r = game.buyDrone(s, 'mining', 1);
    assert.ok(r.error && /dock/i.test(r.error));
  });

  test('buying a drone rejects when unaffordable', () => {
    const s = buyAtStation(fresh(), 'mining', 1).state;
    s.isk = 0;
    const r = game.buyDrone(s, 'combat', 1);
    assert.ok(r.error && /ISK/i.test(r.error));
  });

  test('buying respects the per-type cap', () => {
    let s = fresh();
    const st = sys(s).stations[0];
    s = game.warp(s, st.id).state;
    s.isk = 1e9;
    for (let i = 0; i < cfg.DRONE_MAX_PER_TYPE; i++) {
      s = game.buyDrone(s, 'mining', 1).state;
    }
    const r = game.buyDrone(s, 'mining', 1);
    assert.ok(r.error && /full/i.test(r.error));
    assert.equal(s.drones.mining.length, cfg.DRONE_MAX_PER_TYPE);
  });

  test('a mining drone raises the mining rate', () => {
    const s = buyAtStation(fresh(), 'mining', 2).state;
    const a = atAsteroid(s);
    const v = game.view(s);
    assert.equal(v.miningTargetId, a.id);
    const base = game.shipMining(s.ships[0]);
    assert.ok(Math.abs(v.miningRate - (base + cfg.DRONES.mining.tiers[1].bonus)) < 1e-6);
  });

  test('a combat drone raises the ship DPS in a fight', () => {
    const s = buyAtStation(fresh(), 'combat', 1).state;
    const e = sys(s).enemies[0];
    s.ships[0].x = e.x;
    s.ships[0].y = e.y;
    const eng = game.engage(s, e.id, T0).state;
    const mults = game.skillMults(eng);
    const expected = cfg.SHIPS[s.ships[0].type].dps * mults.dps + cfg.DRONES.combat.tiers[0].bonus * mults.dps;
    assert.ok(Math.abs(eng.combat.playerDps - expected) < 1e-6);
  });

  test('view exposes the drone bay and the bonuses it grants', () => {
    const s = buyAtStation(fresh(), 'combat', 1).state;
    const v = game.view(s);
    assert.deepEqual(v.drones.combat, [1]);
    assert.equal(v.droneBonuses.dps, cfg.DRONES.combat.tiers[0].bonus);
    assert.equal(v.droneBonuses.mining, 0);
  });
});

describe('repeatable agent missions', () => {
  test('contracts can be accepted once, cancelled, and offered again after a day', () => {
    const s = fresh();
    const accepted = game.agentMissionAction(s, 'accept', T0);
    assert.ok(!accepted.error, accepted.error);
    assert.ok(accepted.state.agentMission);
    assert.match(game.agentMissionAction(accepted.state, 'accept', T0 + 1).error, /already active/i);
    const cancelledAt = T0 + 1000;
    const cancelled = game.agentMissionAction(accepted.state, 'cancel', cancelledAt).state;
    assert.match(game.agentMissionAction(cancelled, 'accept', cancelledAt + 1000).error, /available yet/i);
    const next = game.agentMissionAction(cancelled, 'accept', cancelledAt + cfg.AGENT_MISSION_COOLDOWN_MS);
    assert.ok(!next.error, next.error);
  });

  test('selling ore completes a haul contract and grants its reward', () => {
    const s = withCargo(fresh(), { iron: 100 });
    s.agentMission = { key: 'ore-haul', progress: 0, status: 'active', startedAt: T0 };
    const result = game.sellMinerals(s, 'iron', 'all');
    assert.ok(!result.error, result.error);
    assert.equal(result.state.agentMission.status, 'complete');
    assert.equal(result.state.agentMission.progress, 100);
    assert.equal(result.state.stats.agentMissionsCompleted, 1);
  });
});

describe('loot drops', () => {
  // Win a fight against `enemyType` with a given rng (0 = force a drop,
  // 1 = never drop), returning the resolved state.
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
    const loot = s.loot[0];
    const r = game.equipLoot(s, loot.id);
    assert.ok(!r.error, r.error);
    assert.ok(r.state.ships[0].fitting[loot.slotType].includes(loot.tier), 'loot lands in an empty slot');
    assert.equal(r.state.loot.length, 0, 'loot is consumed');
    assert.ok(Math.abs(r.state.isk - s.isk) < 1e-6, 'equipping loot is free');
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
    s.loot = [{ id: 'loot_w', slotType: 'weapon', tier: 2 }];
    s.ships[0].fitting.weapon[0] = 1; // the rifter's only weapon slot is taken
    const r = game.equipLoot(s, 'loot_w');
    assert.ok(r.error && /occupied/i.test(r.error));
  });

  test('loot is player-level and survives a ship loss', () => {
    const s = withCargo(fresh(), { iron: 10 });
    s.loot = [{ id: 'loot_survive', slotType: 'weapon', tier: 1 }];
    s.ships[0].type = 'rifter';
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

  test('selling a looted module returns half its listed cost at a station', () => {
    const s = fresh();
    s.loot = [{ id: 'loot-sale', slotType: 'weapon', tier: 2 }];
    const before = s.isk;
    const r = game.sellLoot(s, 'loot-sale');
    assert.ok(!r.error, r.error);
    assert.equal(r.state.loot.length, 0);
    assert.equal(r.state.isk, before + Math.floor(cfg.MODULES.weapon.tiers[1].cost * 0.5));
  });

  test('refining a looted module returns half its recipe as cargo', () => {
    const s = fresh();
    s.loot = [{ id: 'loot-refine', slotType: 'weapon', tier: 1 }];
    const r = game.refineLoot(s, 'loot-refine');
    assert.ok(!r.error, r.error);
    assert.equal(r.state.loot.length, 0);
    for (const [mineral, amount] of Object.entries(cfg.BLUEPRINTS.weapon[1].recipe)) {
      assert.equal(r.state.ships[0].cargo[mineral], Math.max(1, Math.floor(amount / 2)));
    }
  });

  test('selling or refining loot requires docking', () => {
    const s = fresh();
    s.loot = [{ id: 'loot-sale', slotType: 'weapon', tier: 1 }];
    s.ships[0].x = 0;
    assert.match(game.sellLoot(s, 'loot-sale').error, /dock/i);
    assert.match(game.refineLoot(s, 'loot-sale').error, /dock/i);
  });
});

describe('industry (blueprint crafting)', () => {
  // Dock and load the active ship's cargo with the recipe for a module.
  function withRecipe(state, slotType, tier) {
    const bp = cfg.BLUEPRINTS[slotType][tier];
    const s = withCargo(state, { ...bp.recipe });
    atStation(s);
    return s;
  }

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

  test('crafting consumes the ore and adds a module to the loot inventory', () => {
    const s = withRecipe(fresh(), 'weapon', 2);
    const bp = cfg.BLUEPRINTS.weapon[2];
    const r = game.craftModule(s, 'weapon', 2);
    assert.ok(!r.error, r.error);
    for (const mKey of Object.keys(bp.recipe)) {
      assert.equal(r.state.ships[0].cargo[mKey], 0, `${mKey} should be consumed`);
    }
    assert.equal(r.state.loot.length, 1);
    assert.equal(r.state.loot[0].slotType, 'weapon');
    assert.equal(r.state.loot[0].tier, 2);
  });

  test('crafting rejects when not docked', () => {
    const s = withCargo(fresh(), { iron: 1000 });
    s.ships[0].x = 100; // far from the home station
    s.ships[0].y = 100;
    const r = game.craftModule(s, 'weapon', 1);
    assert.ok(r.error && /dock/i.test(r.error));
  });

  test('crafting rejects when the ore is missing', () => {
    const s = withCargo(fresh(), { iron: 1 });
    atStation(s);
    const r = game.craftModule(s, 'weapon', 3);
    assert.ok(r.error && /need/i.test(r.error));
  });

  test('crafting rejects unknown types and tiers', () => {
    const s = withRecipe(fresh(), 'weapon', 1);
    assert.ok(game.craftModule(s, 'nope', 1).error);
    assert.ok(game.craftModule(s, 'weapon', 9).error);
  });

  test('a crafted module can be equipped like loot', () => {
    const s = withRecipe(fresh(), 'cargo', 1);
    const crafted = game.craftModule(s, 'cargo', 1).state;
    const r = game.equipLoot(crafted, crafted.loot[0].id);
    assert.ok(!r.error, r.error);
    assert.equal(r.state.ships[0].fitting.cargo[0], 1);
  });
});

describe('threat scaling', () => {
  test('threat level rises with ISK earned and is capped', () => {
    const s = fresh();
    assert.equal(game.threatLevel(s), 0);
    s.stats.totalIskEarned = cfg.THREAT_ISK_STEP;
    assert.equal(game.threatLevel(s), 1);
    s.stats.totalIskEarned = cfg.THREAT_ISK_STEP * 5;
    assert.equal(game.threatLevel(s), 5);
    s.stats.totalIskEarned = cfg.THREAT_ISK_STEP * 1000;
    assert.equal(game.threatLevel(s), cfg.THREAT_MAX);
  });

  test('selling minerals banks ISK and raises the threat', () => {
    const s = withCargo(fresh(), { iron: 100000 });
    const s2 = game.sellMinerals(s, 'iron', 'all').state;
    assert.ok(s2.stats.totalIskEarned > 0);
    assert.ok(s2.isk > s.isk);
    assert.ok(game.threatLevel(s2) > 0);
  });

  test('combat rewards scale up with the threat level', () => {
    const base = fresh();
    const e1 = sys(base).enemies[0];
    e1.type = 'pirate';
    base.ships[0].type = 'brutix';
    base.ships[0].x = e1.x;
    base.ships[0].y = e1.y;
    const s1 = game.engage(base, e1.id, T0).state;
    const baseReward = s1.combat.reward;

    const hi = fresh();
    hi.stats.totalIskEarned = cfg.THREAT_ISK_STEP * 10;
    const e2 = sys(hi).enemies[0];
    e2.type = 'pirate';
    hi.ships[0].type = 'brutix';
    hi.ships[0].x = e2.x;
    hi.ships[0].y = e2.y;
    const s2 = game.engage(hi, e2.id, T0).state;
    const hiReward = s2.combat.reward;

    assert.ok(hiReward > baseReward, `threat should raise the reward: ${hiReward} <= ${baseReward}`);
  });

  test('view exposes the threat level', () => {
    assert.equal(game.view(fresh()).threat, 0);
  });

  test('systems expose distinct security that affects combat, markets, and ambush risk', () => {
    const s = fresh();
    const high = s.systems.sys_0;
    const low = s.systems.sys_2;
    assert.ok(high.security > low.security);
    assert.ok(high.prices.iron < low.prices.iron);
    assert.ok(game.ambushChance(s, high.id) < game.ambushChance(s, low.id));

    const safe = fresh();
    const safeEnemy = sys(safe).enemies[0];
    safeEnemy.type = 'pirate';
    safe.ships[0].x = safeEnemy.x;
    safe.ships[0].y = safeEnemy.y;
    const safeFight = game.engage(safe, safeEnemy.id, T0).state.combat;
    const risky = fresh();
    const riskyEnemy = risky.systems.sys_2.enemies[0];
    riskyEnemy.type = 'pirate';
    risky.ships[0].systemId = 'sys_2';
    risky.ships[0].x = riskyEnemy.x;
    risky.ships[0].y = riskyEnemy.y;
    const riskyFight = game.engage(risky, riskyEnemy.id, T0).state.combat;
    assert.ok(riskyFight.enemyDps > safeFight.enemyDps);
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
    assert.equal(colors.length, 3);
    assert.ok(colors.every((c) => /^#[0-9a-f]{6}$/i.test(c)));
    assert.equal(new Set(colors).size, 3);
  });
});
