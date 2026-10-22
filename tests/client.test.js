'use strict';

// Unit tests for the client-side core (Node + Camera). These are pure JS with no
// DOM, so they run under node --test. The client files are ES modules (public/
// is a "type":"module" package), so they are loaded here via dynamic import.

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');

describe('Node', () => {
  test('update and render recurse through children in order and return this', async () => {
    const { Node } = await import('../public/core/node.js');
    const log = [];
    class Tracker extends Node {
      constructor(tag) {
        super();
        this.tag = tag;
      }
      update(dt) {
        log.push(`u${this.tag}:${dt}`);
        return super.update(dt);
      }
      render(now) {
        log.push(`r${this.tag}:${now}`);
        return super.render(now);
      }
    }
    const root = new Node();
    const a = root.add(new Tracker('a'));
    a.add(new Tracker('b'));
    root.add(new Tracker('c'));

    assert.equal(root.update(0.5), root, 'update returns this for chaining');
    assert.deepEqual(log, ['ua:0.5', 'ub:0.5', 'uc:0.5']);

    log.length = 0;
    assert.equal(a.update(1), a, 'update returns this on an inner node');
    assert.deepEqual(log, ['ua:1', 'ub:1']);

    log.length = 0;
    assert.equal(root.render(12345), root, 'render returns this for chaining');
    assert.deepEqual(log, ['ra:12345', 'rb:12345', 'rc:12345']);
  });

  test('add propagates the app reference to children', async () => {
    const { Node } = await import('../public/core/node.js');
    const app = { name: 'fake' };
    const root = new Node(app);
    const child = new Node();
    root.add(child);
    assert.equal(child.app, app, 'child inherits the parent app');
    assert.equal(child.add(new Node()).app, app, 'grandchild inherits via add');
  });

  test('a node can both draw itself and own children (non-leaf rendering)', async () => {
    const { Node } = await import('../public/core/node.js');
    const drawn = [];
    class Parent extends Node {
      render(now) {
        drawn.push('parent');
        return super.render(now);
      }
    }
    class Child extends Node {
      render(now) {
        drawn.push('child');
        return super.render(now);
      }
    }
    const p = new Parent();
    p.add(new Child());
    p.render(1);
    assert.deepEqual(drawn, ['parent', 'child']);
  });
});

describe('App scene tree', () => {
  test('renders the world and UI as sibling layers', async () => {
    const { App } = await import('../public/core/app.js');
    const app = new App({ canvas: {}, ctx: {}, minimap: {}, mctx: {} });
    const rendered = [];
    app.world.render = () => rendered.push('world');
    app.ui.render = () => rendered.push('ui');

    app.root.render(12345);

    assert.equal(app.root.children[0], app.world);
    assert.equal(app.root.children[1], app.ui);
    assert.deepEqual(rendered, ['world', 'ui']);

    const assertAppPropagation = (node) => {
      for (const child of node.children) {
        assert.equal(child.app, app);
        assertAppPropagation(child);
      }
    };
    assertAppPropagation(app.root);
  });
});

describe('UI panel refresh', () => {
  test('refreshes the open menu page and pilot details when selected', async () => {
    const { UINode } = await import('../public/ui/ui.js');
    const app = { hangarOpen: false, menuPageOpen: false, activeMenu: 'cargo' };
    const ui = new UINode(app);
    const refreshed = [];
    ui.hud.refreshPanels = () => refreshed.push('hud');
    ui.hangar.refresh = () => refreshed.push('hangar');
    ui.character.refresh = () => refreshed.push('character');
    ui.inventory.refresh = () => refreshed.push('inventory');

    ui.refreshPanels();
    assert.deepEqual(refreshed, ['hud']);

    app.hangarOpen = true;
    ui.refreshPanels();
    assert.deepEqual(refreshed, ['hud', 'hud', 'hangar']);

    app.menuPageOpen = true;
    ui.refreshPanels();
    assert.deepEqual(refreshed, ['hud', 'hud', 'hangar', 'hud', 'hangar', 'inventory']);

    app.activeMenu = 'pilot';
    ui.refreshPanels();
    assert.deepEqual(refreshed, ['hud', 'hud', 'hangar', 'hud', 'hangar', 'inventory', 'hud', 'hangar', 'inventory', 'character']);
  });
});

describe('Camera', () => {
  test('worldToScreen / screenToWorld are inverses around the player', async () => {
    const { Camera } = await import('../public/core/camera.js');
    const app = { canvas: { width: 800, height: 600 }, player: { x: 100, y: 200 } };
    const cam = new Camera(app);
    const w = cam.worldToScreen(300, 400);
    assert.equal(w.x, 600); // (300-100)*1 + 400
    assert.equal(w.y, 500); // (400-200)*1 + 300
    const back = cam.screenToWorld(w.x, w.y);
    assert.equal(back.x, 300);
    assert.equal(back.y, 400);
  });

  test('zoom scales the view and clamps to [0.4, 2.2]', async () => {
    const { Camera } = await import('../public/core/camera.js');
    const app = { canvas: { width: 800, height: 600 }, player: { x: 0, y: 0 } };
    const cam = new Camera(app);
    cam.scale(1.1);
    assert.equal(cam.zoom, 1.1);
    cam.scale(100);
    assert.equal(cam.zoom, 2.2, 'zoom clamps high');
    cam.scale(0.0001);
    assert.equal(cam.zoom, 0.4, 'zoom clamps low');
  });

  test('screen shake decays over time', async () => {
    const { Camera } = await import('../public/core/camera.js');
    const app = { canvas: { width: 800, height: 600 }, player: { x: 0, y: 0 } };
    const cam = new Camera(app);
    assert.equal(cam.shake, 0);
    cam.addShake(2);
    assert.equal(cam.shake, 2);
    cam.update(0.5);
    assert.ok(cam.shake < 2, 'shake decays');
    assert.ok(cam.shake > 0, 'shake still active');
    cam.update(10);
    assert.equal(cam.shake, 0, 'shake fully decays');
    assert.equal(cam.shakeX, 0);
    assert.equal(cam.shakeY, 0);
  });
});

describe('CombatNode', () => {
  test('renders hostile laser fire in red after the enemy range delay', async () => {
    const { CombatNode } = await import('../public/view/combat.js');
    const strokes = [];
    let path = [];
    const ctx = {
      save() {},
      restore() {},
      beginPath() { path = []; },
      moveTo(x, y) { path.push([x, y]); },
      lineTo(x, y) { path.push([x, y]); },
      stroke() { strokes.push({ color: this.strokeStyle, path: [...path] }); },
      fill() {},
      closePath() {},
      translate() {},
      rotate() {},
      arc() {},
    };
    const app = {
      ctx,
      canvas: { width: 800, height: 600 },
      camera: { zoom: 1, worldToScreen: (x, y) => ({ x: x + 50, y: y + 70 }) },
      combatFx: { explosions: [] },
      state: {
        combat: { enemyId: 'enemy-1', fightTime: 3, enemyRangeDelay: 2 },
        world: { enemies: [{ id: 'enemy-1', x: 100, y: 200, type: 'pirate' }] },
        drones: { combat: [] },
      },
    };

    new CombatNode(app).render(100);

    assert.ok(strokes.some(({ color, path: line }) =>
      color === '#ff4657' &&
      JSON.stringify(line) === JSON.stringify([[150, 270], [400, 300]])
    ), 'enemy laser travels from the target to the player in red');
  });
});

describe('EnemyNode status labels', () => {
  test('shows the enemy name and live shield and hull above its ship', async () => {
    const { EnemyNode } = await import('../public/view/world.js');
    const labels = [];
    const bars = [];
    const ctx = {
      save() {},
      restore() {},
      translate() {},
      rotate() {},
      beginPath() {},
      moveTo() {},
      lineTo() {},
      closePath() {},
      fill() {},
      stroke() {},
      fillRect(x, y, width) {
        if (this.fillStyle === '#4fd1ff' || this.fillStyle === '#ff657a') bars.push({ color: this.fillStyle, width });
      },
      strokeRect() {},
      fillText(text) { labels.push(text); },
    };
    const enemy = { id: 'enemy-1', x: 100, y: 200, type: 'pirate', alive: true, seed: 1 };
    const app = {
      ctx,
      camera: {
        zoom: 1,
        getViewBounds: () => ({ minX: 0, maxX: 500, minY: 0, maxY: 500 }),
        worldToScreen: () => ({ x: 250, y: 250 }),
      },
      catalog: { enemies: { pirate: { name: 'Pirate Frigate', shield: 40, hull: 80 } } },
      state: {
        combat: {
          enemyId: enemy.id,
          enemyShield: 20,
          enemyShieldMax: 40,
          enemyHull: 40,
          enemyHullMax: 80,
        },
        world: { enemies: [enemy] },
      },
      targetEnemyId: null,
    };

    new EnemyNode(app).render(0);

    assert.ok(labels.includes('Pirate Frigate'));
    assert.deepEqual(bars.map(({ color, width }) => ({ color, width })), [
      { color: '#4fd1ff', width: 33 },
      { color: '#ff657a', width: 33 },
    ]);
  });

  test('marks the selected target with four corner brackets, not a full box or crosshair', async () => {
    const { EnemyNode } = await import('../public/view/world.js');
    const paths = [];
    const rectangles = [];
    let path = [];
    const ctx = {
      save() {},
      restore() {},
      translate() {},
      rotate() {},
      beginPath() { path = []; },
      moveTo(x, y) { path.push([x, y]); },
      lineTo(x, y) { path.push([x, y]); },
      closePath() {},
      fill() {},
      stroke() { paths.push([...path]); },
      fillRect() {},
      strokeRect(x, y, width, height) { rectangles.push({ x, y, width, height }); },
      fillText() {},
    };
    const enemy = { id: 'enemy-1', x: 100, y: 200, type: 'pirate', alive: true, seed: 1 };
    const app = {
      ctx,
      camera: {
        zoom: 1,
        getViewBounds: () => ({ minX: 0, maxX: 500, minY: 0, maxY: 500 }),
        worldToScreen: () => ({ x: 250, y: 250 }),
      },
      catalog: { enemies: { pirate: { name: 'Pirate Frigate', shield: 40, hull: 80 } } },
      constants: { enemyHealthMultiplier: 0.65 },
      state: { combat: null, world: { enemies: [enemy] } },
      targetEnemyId: enemy.id,
    };

    new EnemyNode(app).render(0);

    const targetPath = paths.find((points) => points.length === 12);
    assert.ok(targetPath, 'selected target should render four L-shaped corners');
    assert.ok(!rectangles.some(({ width, height }) => width > 20 && height > 20), 'should not draw a full target box');
    assert.ok(!targetPath.some(([x, y]) => x === 250 || y === 250), 'should not draw a crosshair through the target');
  });
});

describe('Ship destination indicator', () => {
  test('hides the blue destination crosshair when the destination is the selected rat', async () => {
    const { ShipNode } = await import('../public/view/ship.js');
    const calls = { arcs: 0, strokes: 0 };
    const ctx = {
      save() {},
      restore() {},
      setLineDash() {},
      beginPath() {},
      moveTo() {},
      lineTo() {},
      arc() { calls.arcs++; },
      stroke() { calls.strokes++; },
    };
    const enemy = { id: 'rat-1', x: 300, y: 400, alive: true };
    const app = {
      ctx,
      canvas: { width: 800, height: 600 },
      camera: { worldToScreen: () => ({ x: 500, y: 400 }) },
      player: { destination: { x: enemy.x, y: enemy.y } },
      state: { world: { enemies: [enemy] } },
      targetEnemyId: enemy.id,
    };

    new ShipNode(app).drawDestination(0);

    assert.deepEqual(calls, { arcs: 0, strokes: 0 });
  });

  test('keeps the destination indicator for non-target navigation', async () => {
    const { ShipNode } = await import('../public/view/ship.js');
    let arcs = 0;
    const ctx = {
      save() {},
      restore() {},
      setLineDash() {},
      beginPath() {},
      moveTo() {},
      lineTo() {},
      arc() { arcs++; },
      stroke() {},
    };
    const app = {
      ctx,
      canvas: { width: 800, height: 600 },
      camera: { worldToScreen: () => ({ x: 500, y: 400 }) },
      player: { destination: { x: 300, y: 400 } },
      state: { world: { enemies: [] } },
      targetEnemyId: null,
    };

    new ShipNode(app).drawDestination(0);

    assert.equal(arcs, 1);
  });
});

describe('Player auto-recall', () => {
  test('launching suppresses recall of cargo already full at the station', async () => {
    const { Player } = await import('../public/core/player.js');
    const app = {
      constants: { worldSize: 8000, dockRange: 260 },
      state: { combat: null, cargoFull: true, world: { stations: [] } },
    };
    const player = new Player(app);
    const station = { x: 1000, y: 1000 };
    player.nearestStation = () => ({ station, d: 500 });
    player.suppressAutoRecall = true;
    player.maybeAutoRecall();
    assert.equal(player.destination, null);

    app.state.cargoFull = false;
    player.maybeAutoRecall();
    assert.equal(player.suppressAutoRecall, false);
    app.state.cargoFull = true;
    player.maybeAutoRecall();
    assert.deepEqual(player.destination, station);
  });
});

describe('Player target orbit', () => {
  test('slowly orbits a selected rat during and outside combat', async () => {
    const { Player } = await import('../public/core/player.js');
    const enemy = { id: 'rat-1', x: 500, y: 500, alive: true };
    const app = {
      constants: {
        worldSize: 1000,
        damping: 0.985,
        maxSpeed: 600,
        arriveRadius: 24,
        engageRange: 240,
        miningRange: 160,
      },
      state: { combat: null, world: { enemies: [enemy], asteroids: [] } },
      targetEnemyId: enemy.id,
    };
    const player = new Player(app);
    player.x = enemy.x + 150;
    player.y = enemy.y;

    for (let i = 0; i < 200; i++) player.update(0.05);
    const distance = Math.hypot(player.x - enemy.x, player.y - enemy.y);
    const angle = Math.atan2(player.y - enemy.y, player.x - enemy.x);
    assert.ok(Math.abs(distance - 150) < 5, `orbit radius was ${distance}`);
    assert.ok(angle > 0.5, `ship did not orbit far enough: ${angle}`);

    app.state.combat = { enemyId: enemy.id };
    const beforeCombatOrbit = { x: player.x, y: player.y };
    for (let i = 0; i < 40; i++) player.update(0.05);
    assert.notDeepEqual({ x: player.x, y: player.y }, beforeCombatOrbit);
  });

  test('slowly orbits a nearby mineable asteroid', async () => {
    const { Player } = await import('../public/core/player.js');
    const asteroid = { x: 500, y: 500, amount: 100, mineral: 'iron' };
    const app = {
      constants: {
        worldSize: 1000,
        damping: 0.985,
        maxSpeed: 600,
        arriveRadius: 24,
        engageRange: 240,
        miningRange: 160,
      },
      state: { combat: null, world: { enemies: [], asteroids: [asteroid] } },
      targetEnemyId: null,
    };
    const player = new Player(app);
    player.x = asteroid.x + 100;
    player.y = asteroid.y;

    for (let i = 0; i < 200; i++) player.update(0.05);
    const distance = Math.hypot(player.x - asteroid.x, player.y - asteroid.y);
    const angle = Math.atan2(player.y - asteroid.y, player.x - asteroid.x);
    assert.ok(Math.abs(distance - 100) < 5, `orbit radius was ${distance}`);
    assert.ok(angle > 0.5, `ship did not orbit far enough: ${angle}`);
  });

  test('starts orbiting an asteroid as soon as the orbit radius is reached', async () => {
    const { Player } = await import('../public/core/player.js');
    const asteroid = { id: 'rock-1', x: 500, y: 500, amount: 100, mineral: 'iron' };
    const app = {
      constants: {
        worldSize: 1000,
        damping: 0.985,
        maxSpeed: 600,
        arriveRadius: 24,
        engageRange: 240,
        miningRange: 160,
      },
      state: { combat: null, world: { enemies: [], asteroids: [asteroid] } },
      targetEnemyId: null,
    };
    const player = new Player(app);
    player.x = 100;
    player.y = 500;
    player.setDestination(asteroid.x, asteroid.y);

    let closestDistance = Infinity;
    for (let i = 0; i < 300; i++) {
      player.update(0.05);
      closestDistance = Math.min(closestDistance, Math.hypot(player.x - asteroid.x, player.y - asteroid.y));
    }

    const distance = Math.hypot(player.x - asteroid.x, player.y - asteroid.y);
    assert.ok(closestDistance > 95, `ship moved too close before orbiting: ${closestDistance}`);
    assert.ok(Math.abs(distance - 100) < 5, `orbit radius was ${distance}`);
    assert.ok(player.destination, 'approach destination remains associated with its asteroid orbit');
  });

  test('manual destinations take priority over orbiting a previously selected rat', async () => {
    const { Player } = await import('../public/core/player.js');
    const enemy = { id: 'rat-1', x: 500, y: 500, alive: true };
    const app = {
      constants: {
        worldSize: 1000,
        damping: 0.985,
        maxSpeed: 600,
        arriveRadius: 24,
        engageRange: 240,
        miningRange: 160,
      },
      state: { combat: null, world: { enemies: [enemy], asteroids: [] } },
      targetEnemyId: enemy.id,
    };
    const player = new Player(app);
    player.x = enemy.x + 150;
    player.y = enemy.y;
    player.setDestination(900, 900);
    player.update(0.05);
    assert.ok(player.x > enemy.x + 150, 'ship should continue toward the manual destination');
  });
});

describe('Inventory grid stacks', () => {
  test('ore uses one unlimited stack and grid capacity grows with loot items', async () => {
    const { InventoryNode } = await import('../public/ui/inventory.js');
    const app = {
      state: {
        minerals: { iron: 1000000 },
        loot: Array.from({ length: 30 }, (_, index) => ({
          id: `loot-${index}`,
          name: `Module ${index}`,
          slotType: 'weapon',
          tier: 1,
        })),
      },
      catalog: { minerals: { iron: {} } },
    };
    const inventory = new InventoryNode(app);
    const { cells, total } = inventory.buildCells();
    assert.equal(cells.filter((cell) => cell.kind === 'ore').length, 1);
    assert.equal(cells[0].count, 1000000);
    assert.equal(cells.filter((cell) => cell.kind === 'loot').length, 30);
    assert.equal(total, 36);
  });
});
