'use strict';

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const game = require('../server/game');
const cfg = require('../server/config');

const T0 = 1_000_000_000_000;

function fresh() {
  return game.createInitialState(T0, 42);
}

describe('item economy', () => {
  test('initial progression materials live in quantum storage without currency or standing', () => {
    const state = fresh();
    assert.equal(state.isk, undefined);
    assert.equal(state.standing, undefined);
    assert.ok(state.storage.items.iron > 0);
    assert.ok(state.storage.items.scrap > 0);
  });

  test('NPC exchange consumes three lower-tier items per higher-tier item', () => {
    const state = fresh();
    const exchangedOre = game.exchangeItems(state, 'ore', 'iron', 6);
    assert.equal(exchangedOre.state.storage.items.iron, state.storage.items.iron - 6);
    assert.equal(exchangedOre.state.storage.items.bauxite, state.storage.items.bauxite + 2);

    const exchangedComponents = game.exchangeItems(state, 'components', 'scrap', 9);
    assert.equal(exchangedComponents.state.storage.items.scrap, state.storage.items.scrap - 9);
    assert.equal(exchangedComponents.state.storage.items.alloy, state.storage.items.alloy + 3);
    assert.ok(game.exchangeItems(state, 'ore', 'iron', 4).error);
  });

  test('blueprint purchase and crafting consume items and produce a module item', () => {
    const purchased = game.buyBlueprint(fresh(), 'module', 'weapon', 1);
    assert.equal(purchased.state.blueprints.length, 1);
    assert.equal(purchased.state.storage.items.iron, 15);
    assert.equal(purchased.state.storage.items.scrap, 10);

    const crafted = game.craftModule(purchased.state, 'weapon', 1);
    assert.equal(crafted.state.blueprints.length, 0);
    assert.equal(crafted.state.storage.items.iron, 12);
    assert.equal(crafted.state.storage.items.scrap, 8);
    assert.deepEqual(
      crafted.state.loot.map(({ slotType, tier }) => ({ slotType, tier })),
      [{ slotType: 'weapon', tier: 1 }],
    );
  });

  test('higher-tier module and ship blueprints are found from rat loot, not bought from NPCs', () => {
    const state = fresh();
    assert.match(game.buyBlueprint(state, 'module', 'weapon', 2).error, /rat loot/i);
    assert.match(game.buyBlueprint(state, 'ship', 'falcon').error, /rat loot/i);

    const enemy = state.systems.sys_0.enemies[0];
    enemy.type = 'pirate';
    enemy.tier = 'novice';
    state.ships[0].type = 'brutix';
    state.ships[0].x = enemy.x;
    state.ships[0].y = enemy.y;
    const engaged = game.engage(state, enemy.id, T0).state;
    const killed = game.tick(engaged, T0 + 10_000, null, () => 0);

    assert.ok(killed.blueprints.some((blueprint) =>
      blueprint.kind === 'module' && blueprint.type === 'weapon' && blueprint.tier === 2
    ));
    assert.equal(killed.combatLog[0].blueprint.kind, 'module');
  });

  test('the ship progression contains explicit skill and material paths', () => {
    const progression = cfg.SHIP_PROGRESSION.flatMap((tier) => tier.ships);
    assert.deepEqual(new Set(progression.map((ship) => ship.type)), new Set(Object.keys(cfg.SHIP_BLUEPRINTS).concat('rifter')));
    for (const entry of progression.filter((ship) => ship.type !== 'rifter')) {
      assert.ok(cfg.SHIP_BLUEPRINTS[entry.type].recipe);
      assert.ok(entry.skills.length > 0);
    }
    const slotCountsByTier = cfg.SHIP_PROGRESSION.map((tier) =>
      tier.ships.map((ship) => Object.values(cfg.SHIPS[ship.type].slots).reduce((total, count) => total + count, 0))
    );
    for (let tier = 1; tier < slotCountsByTier.length; tier++) {
      assert.ok(
        Math.min(...slotCountsByTier[tier]) > Math.max(...slotCountsByTier[tier - 1]),
        `Tier ${tier + 1} ships must have more module slots than every Tier ${tier} ship`
      );
    }
  });

  test('target difficulty reflects the fitted ship compared with the enemy', () => {
    const state = fresh();
    const enemy = state.systems.sys_0.enemies[0];
    enemy.type = 'gang';
    enemy.tier = 'elite';
    assert.equal(game.view(state).world.enemies.find((item) => item.id === enemy.id).difficulty.label, 'Deadly');

    state.ships[0].type = 'brutix';
    state.ships[0].fitting = game.emptyFitting('brutix');
    assert.notEqual(game.view(state).world.enemies.find((item) => item.id === enemy.id).difficulty.label, 'Deadly');
  });

  test('salvaging a module yields a component matching its tier', () => {
    const state = fresh();
    state.loot.push({ id: 'salvage-test', slotType: 'shield', tier: 3 });
    const salvaged = game.refineLoot(state, 'salvage-test');
    assert.equal(salvaged.state.loot.length, 0);
    assert.equal(salvaged.state.storage.items.circuits, state.storage.items.circuits + 1);
    assert.equal(salvaged.state.stats.modulesSalvaged, 1);
  });

  test('rats drop scrap but killing them grants no extra skill points', () => {
    const state = fresh();
    const enemy = state.systems.sys_0.enemies[0];
    enemy.type = 'pirate';
    enemy.tier = 'novice';
    state.ships[0].type = 'brutix';
    state.ships[0].x = enemy.x;
    state.ships[0].y = enemy.y;
    const engaged = game.engage(state, enemy.id, T0).state;
    const killed = game.tick(engaged, T0 + 10_000, null, () => 0);

    assert.equal(killed.combat, null);
    assert.ok(killed.combatLog[0].scrap > 0);
    assert.equal(killed.ships[0].cargo.scrap, killed.combatLog[0].scrap);
    assert.equal(killed.skillPoints, cfg.SP_RATE_PER_SEC * 10);
  });

  test('skill points accrue for the full offline interval independently of capped simulation', () => {
    const state = fresh();
    const elapsed = cfg.MAX_OFFLINE_SECONDS + 3600;
    const advanced = game.tick(state, T0 + elapsed * 1000);
    assert.equal(advanced.skillPoints, cfg.SP_RATE_PER_SEC * elapsed);
    assert.equal(advanced.stats.totalSpEarned, cfg.SP_RATE_PER_SEC * elapsed);
  });

  test('legacy currency migration converts value once and removes reputation fields', () => {
    const state = fresh();
    state.version = 15;
    state.isk = 1250;
    state.standing = { gallente: 5 };
    state.stats = undefined;
    state.storage = { minerals: { iron: 2 } };

    const migrated = game.migrateEconomy(state);
    assert.equal(migrated.version, cfg.STATE_VERSION);
    assert.equal(migrated.storage.items.iron, 14);
    assert.equal(migrated.storage.items.scrap, 5);
    assert.equal(migrated.isk, undefined);
    assert.equal(migrated.standing, undefined);
    assert.equal(migrated.stats.modulesSalvaged, 0);
  });

  test('legacy save migration supplies missing items for a pilot already on the industry mission', () => {
    const state = game.createInitialState(T0, 42, 'story');
    state.version = 15;
    state.mission.active = 'm7';
    state.blueprints = [];
    state.storage.items = game.emptyStorage().items;

    const migrated = game.migrateEconomy(state);
    assert.ok(migrated.blueprints.some((item) => item.kind === 'module' && item.type === 'weapon' && item.tier === 1));
    assert.ok(migrated.blueprints.some((item) => item.kind === 'module' && item.type === 'shield' && item.tier === 2));
    assert.ok(migrated.storage.items.iron >= 3);
    assert.ok(migrated.storage.items.bauxite >= 3);
  });

  test('applying a fitting preset exchanges a different module tier correctly', () => {
    const state = fresh();
    state.ships[0].fitting.weapon[0] = 2;
    state.loot.push({ id: 'tier-one', slotType: 'weapon', tier: 1 });
    state.fittingPresets.push({
      name: 'Lower tier',
      shipType: 'rifter',
      fitting: { ...game.emptyFitting('rifter'), weapon: [1] },
    });

    const applied = game.applyFittingPreset(state, 'Lower tier');
    assert.equal(applied.state.ships[0].fitting.weapon[0], 1);
    assert.equal(applied.state.loot.some((item) => item.id === 'tier-one'), false);
    assert.ok(applied.state.loot.some((item) => item.slotType === 'weapon' && item.tier === 2));
    assert.equal(state.ships[0].fitting.weapon[0], 2, 'the input state is not mutated');
  });
});
