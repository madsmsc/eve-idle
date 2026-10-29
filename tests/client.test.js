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

  test('an invisible node skips rendering its subtree but keeps updating it', async () => {
    const { Node } = await import('../public/core/node.js');
    const events = [];
    class Tracker extends Node {
      update(dt) {
        events.push(`update:${dt}`);
        return super.update(dt);
      }
      render(now) {
        events.push(`render:${now}`);
        return super.render(now);
      }
    }
    const root = new Node();
    const hidden = root.add(new Tracker());
    hidden.visible = false;
    hidden.add(new Tracker());

    root.update(0.25);
    root.render(10);

    assert.deepEqual(events, ['update:0.25', 'update:0.25']);
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
    assert.deepEqual(app.world.children, [app.world.backdrop, app.world.system, app.world.actors, app.world.effects, app.world.labels]);
    assert.ok(app.player.children.includes(app.player.docking));
    assert.ok(app.player.children.includes(app.ship));

    const assertAppPropagation = (node) => {
      for (const child of node.children) {
        assert.equal(child.app, app);
        assertAppPropagation(child);
      }
    };
    assertAppPropagation(app.root);
  });
});

describe('Player interpolation', () => {
  test('caps predicted speed to the effective server max speed', async () => {
    const { Player } = await import('../public/core/player.js');
    const player = new Player({ docking: false, constants: { maxSpeed: 1200, maxAcceleration: 180 } });
    const caps = { maxSpeed: 100, maxAcceleration: 100 };
    player.setServerState({ x: 0, y: 0, vx: 30, vy: 0, heading: 0 }, null, caps);
    player.serverTargetAge = 1;
    player.setServerState({ x: 0, y: 0, vx: 80, vy: 0, heading: 0 }, null, caps);

    player.update(0.75);

    assert.ok(player.x > 67 && player.x < 68);
  });
});

describe('UI panel refresh', () => {
  test('refreshes the open menu page when selected', async () => {
    const { UINode } = await import('../public/ui/ui.js');
    const app = { hangarOpen: false, menuPageOpen: false, activeMenu: 'cargo' };
    const ui = new UINode(app);
    const refreshed = [];
    ui.hud.refreshPanels = () => refreshed.push('hud');
    ui.hangar.refresh = () => refreshed.push('hangar');
    ui.inventory.refresh = () => refreshed.push('inventory');

    ui.refreshPanels();
    assert.deepEqual(refreshed, ['hud']);

    app.hangarOpen = true;
    ui.refreshPanels();
    assert.deepEqual(refreshed, ['hud', 'hud', 'hangar']);

    app.menuPageOpen = true;
    ui.refreshPanels();
    assert.deepEqual(refreshed, ['hud', 'hud', 'hangar', 'hud', 'hangar', 'inventory']);

    app.activeMenu = 'cargo';
    ui.refreshPanels();
    assert.deepEqual(refreshed, ['hud', 'hud', 'hangar', 'hud', 'hangar', 'inventory', 'hud', 'hangar', 'inventory']);
  });

  test('defers destructive panel refreshes during a UI pointer interaction', async () => {
    const { UINode } = await import('../public/ui/ui.js');
    const app = { hangarOpen: true, menuPageOpen: true, activeMenu: 'cargo', uiInteractionActive: true };
    const ui = new UINode(app);
    let refreshCount = 0;
    ui.hud.refreshPanels = () => refreshCount++;
    ui.hangar.refresh = () => refreshCount++;
    ui.inventory.refresh = () => refreshCount++;

    ui.refreshPanels();

    assert.equal(refreshCount, 0);
    assert.equal(app.uiRefreshPending, true);
  });
});

describe('HUD activity log', () => {
  test('autopilot banner describes the active efficiency multiplier', async () => {
    const { autoPilotBannerText } = await import('../public/ui/hud.js');
    assert.equal(
      autoPilotBannerText(0.25),
      'due to AI inefficiencies, all systems running at 1/4 capacity',
    );
    assert.throws(() => autoPilotBannerText(0), /positive number/);
  });

  test('shows newest events first, fades old events, and removes expired events', async () => {
    const { HudNode, renderActivityLog } = await import('../public/ui/hud.js');
    const previousDocument = global.document;
    const list = {
      children: [],
      set innerHTML(value) {
        if (value === '') this.children = [];
      },
      appendChild(child) {
        this.children.push(child);
      },
    };
    global.document = {
      querySelector: () => list,
      createElement: () => ({ style: {}, dataset: {} }),
    };

    try {
      const hud = new HudNode({});
      hud.pushEvent('Older event', '');
      let eventKey = renderActivityLog(hud.events, list, '', performance.now());
      hud.pushEvent('Newer event', '');
      eventKey = renderActivityLog(hud.events, list, eventKey, performance.now());

      assert.deepEqual(list.children.map((line) => line.textContent), ['Newer event', 'Older event']);

      hud.events.find((event) => event.text === 'Older event').at -= 2500;
      eventKey = renderActivityLog(hud.events, list, eventKey, performance.now());
      assert.ok(Number.parseFloat(list.children[1].style.opacity) < 1);

      hud.events.find((event) => event.text === 'Older event').at -= 12000;
      renderActivityLog(hud.events, list, eventKey, performance.now());
      assert.deepEqual(list.children.map((line) => line.textContent), ['Newer event']);
    } finally {
      global.document = previousDocument;
    }
  });

  test('adds new autopilot messages to the shared activity log', async () => {
    const { collectNewAutomationEvents } = await import('../public/ui/hud.js');
    const { fresh } = collectNewAutomationEvents([
      { at: 200, message: 'Latest event' },
      { at: 100, message: 'Old event' },
    ], new Map([['100:Old event', 1]]));

    assert.deepEqual(fresh.map((event) => event.message), ['Latest event']);
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
  test('draws the enemy name and live shield and hull for the world-label layer', async () => {
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

    new EnemyNode(app).drawEnemyStatus(250, 250, enemy);

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

describe('edge navigation overview', () => {
  test('shows off-screen destinations with bearings, distances, and selectable clusters', async () => {
    const { renderEdgeMap } = await import('../public/ui/edge-map.js');
    const createElement = () => ({
      children: [],
      dataset: {},
      style: { setProperty() {} },
      classList: { add() {} },
      attributes: {},
      append(...children) { this.children.push(...children); },
      appendChild(child) { this.children.push(child); },
      setAttribute(name, value) { this.attributes[name] = value; },
    });
    const container = {
      children: [],
      replaceChildren() { this.children = []; },
      appendChild(child) { this.children.push(child); },
    };
    const previousDocument = global.document;
    global.document = {
      getElementById: () => container,
      createElement,
    };
    const app = {
      overviewMode: 'edge',
      canvas: { width: 800, height: 600 },
      player: { x: 0, y: 0 },
      camera: {
        worldToScreen: (x, y) => ({ x: x + 400, y: y + 300 }),
      },
      state: {
        world: {
          belts: [{ id: 'belt-1', name: 'Belt A', x: 1000, y: 0 }],
          stations: [{ id: 'station-1', name: 'Station A', x: 1200, y: 0 }],
          outposts: [{ id: 'outpost-1', name: 'Outpost A', x: -1000, y: 0 }],
          gates: [{ id: 'gate-1', name: 'Gate A', x: 0, y: 1200 }],
        },
      },
    };

    try {
      renderEdgeMap(app, 500);
      assert.equal(container.children.length, 3);
      const cluster = container.children.find((group) => group.children[0].dataset.clusterToggle);
      assert.ok(cluster);
      assert.equal(cluster.style.left, '800px');
      assert.equal(cluster.style.top, '300px');
      assert.equal(cluster.style.transform, 'translate(-100%, -50%)');
      const toggle = cluster.children[0];
      assert.match(toggle.attributes['aria-label'], /2 destinations/);
      assert.match(toggle.children[0].textContent, /→|↘|↓|↙|←|↖|↑|↗/);
      assert.equal(cluster.children[1].children.length, 2);
      assert.deepEqual(
        cluster.children[1].children.map((option) => option.dataset.targetId),
        ['belt-1', 'station-1'],
      );
      assert.ok(cluster.children[1].children.every((option) => /m$/.test(option.textContent)));
    } finally {
      global.document = previousDocument;
    }
  });
});

describe('Ship destination indicator', () => {
  test('thruster trail is three times its original length at the same speed', async () => {
    const { ShipNode } = await import('../public/view/ship.js');
    const lineTos = [];
    const ctx = {
      save() {},
      restore() {},
      translate() {},
      rotate() {},
      beginPath() {},
      moveTo() {},
      lineTo(x, y) { lineTos.push([x, y]); },
      closePath() {},
      arc() {},
      fill() {},
      stroke() {},
    };
    const app = {
      ctx,
      canvas: { width: 800, height: 600 },
      camera: { zoom: 1, worldToScreen: () => ({ x: 400, y: 300 }) },
      constants: { maxSpeed: 1000 },
      player: { destination: null, heading: 0, vx: 500, vy: 0 },
      state: { docked: false, miningTargetId: null, combat: null, world: { enemies: [], asteroids: [] } },
      targetEnemyId: null,
    };

    new ShipNode(app).render(0);

    assert.ok(lineTos.some(([x, y]) => x === 0 && Math.abs(y - 45.1) < 0.001));
  });

  test('hides the blue destination crosshair when the destination is the selected enemy', async () => {
    const { ShipNode } = await import('../public/view/ship.js');
    const calls = { arcs: 0, strokes: 0 };
    const ctx = {
      save() {},
      restore() {},
      translate() {},
      rotate() {},
      setLineDash() {},
      beginPath() {},
      moveTo() {},
      lineTo() {},
      closePath() {},
      fill() {},
      arc() { calls.arcs++; },
      stroke() { calls.strokes++; },
    };
    const enemy = { id: 'enemy-1', x: 300, y: 400, alive: true };
    const app = {
      ctx,
      canvas: { width: 800, height: 600 },
      camera: { zoom: 1, worldToScreen: () => ({ x: 500, y: 400 }) },
      constants: { maxSpeed: 1000 },
      player: { destination: { x: enemy.x, y: enemy.y }, heading: 0, vx: 0, vy: 0 },
      state: { docked: false, world: { enemies: [enemy] } },
      targetEnemyId: enemy.id,
    };

    new ShipNode(app).render(0);

    assert.equal(calls.arcs, 1, 'only the ship cockpit is drawn; no target destination arc');
  });

  test('keeps the destination indicator for non-target navigation', async () => {
    const { ShipNode } = await import('../public/view/ship.js');
    let arcs = 0;
    const ctx = {
      save() {},
      restore() {},
      translate() {},
      rotate() {},
      setLineDash() {},
      beginPath() {},
      moveTo() {},
      lineTo() {},
      closePath() {},
      fill() {},
      arc() { arcs++; },
      stroke() {},
    };
    const app = {
      ctx,
      canvas: { width: 800, height: 600 },
      camera: { zoom: 1, worldToScreen: () => ({ x: 500, y: 400 }) },
      constants: { maxSpeed: 1000 },
      player: { destination: { x: 300, y: 400 }, heading: 0, vx: 0, vy: 0 },
      state: { docked: false, world: { enemies: [] } },
      targetEnemyId: null,
    };

    new ShipNode(app).render(0);

    assert.equal(arcs, 2, 'destination and ship cockpit are both drawn');
  });
});

describe('Player authoritative state', () => {
  test('cargo state does not trigger client-side recall decisions', async () => {
    const { Player } = await import('../public/core/player.js');
    const app = {
      state: { combat: null, cargoFull: true },
      docking: null,
    };
    const player = new Player(app);
    player.x = 100;
    player.y = 200;
    player.setServerState({ x: 100, y: 200 }, null);
    player.update(0.05);
    assert.equal(player.destination, null);
    assert.deepEqual({ x: player.x, y: player.y }, { x: 100, y: 200 });
  });
});

describe('Player undocking', () => {
  test('launch uses the server launch position and accepts destinations immediately', async () => {
    const { Player } = await import('../public/core/player.js');
    const app = {
      constants: { worldSize: 8000, dockRange: 260 },
      state: { activeShip: { x: 1260, y: 1000 } },
      undocking: true,
    };
    const player = new Player(app);
    player.x = 1000;
    player.y = 1000;
    player.undock = { t: 1 };

    player.startUndock();
    assert.equal(player.x, 1260);
    assert.equal(player.y, 1000);
    assert.equal(app.undocking, false);
    assert.equal(player.undock, null);
    player.setServerState({ x: 3000, y: 2500 }, { x: 3000, y: 2500 });
    assert.deepEqual(player.destination, { x: 3000, y: 2500 });
    player.update(0.05);
    assert.ok(player.x > 1260);
  });
});

describe('Player server-authoritative motion', () => {
  test('does not locally orbit a selected enemy', async () => {
    const { Player } = await import('../public/core/player.js');
    const enemy = { id: 'enemy-1', x: 500, y: 500, alive: true };
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

    const position = { x: player.x, y: player.y };
    for (let i = 0; i < 200; i++) player.update(0.05);
    assert.deepEqual({ x: player.x, y: player.y }, position);
  });

  test('does not locally orbit a nearby mineable asteroid', async () => {
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

    const position = { x: player.x, y: player.y };
    for (let i = 0; i < 200; i++) player.update(0.05);
    assert.deepEqual({ x: player.x, y: player.y }, position);
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
    player.setServerState({ x: asteroid.x, y: asteroid.y }, { x: asteroid.x, y: asteroid.y });
    const initialX = player.x;
    for (let i = 0; i < 300; i++) {
      player.update(0.05);
    }
    assert.ok(player.x > initialX);
    assert.equal(player.destination.x, asteroid.x);
  });

  test('server position updates control the interpolated destination', async () => {
    const { Player } = await import('../public/core/player.js');
    const enemy = { id: 'enemy-1', x: 500, y: 500, alive: true };
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
    player.setServerState({ x: 900, y: 900 }, { x: 900, y: 900 });
    player.update(0.05);
    assert.ok(player.x > enemy.x + 150);
  });

  test('continues moving smoothly between server position updates', async () => {
    const { Player } = await import('../public/core/player.js');
    const app = {
      state: { world: { enemies: [], asteroids: [] } },
    };
    const player = new Player(app);
    player.x = 100;
    player.y = 200;
    player.setServerState({ x: 100, y: 200, vx: 120, vy: 0, heading: 0 }, null);

    for (let i = 0; i < 8; i++) player.update(0.05);

    assert.ok(player.x > 130);
    assert.ok(player.x < 200);
    assert.equal(player.y, 200);
  });

  test('snap resets the prediction acceleration before rendering resumes', async () => {
    const { Player } = await import('../public/core/player.js');
    const app = {
      state: { world: { enemies: [], asteroids: [] } },
    };
    const player = new Player(app);
    player.snap(200, 300);
    player.update(0.05);

    assert.equal(player.x, 200);
    assert.equal(player.y, 300);
    assert.equal(Number.isFinite(player.x), true);
    assert.equal(Number.isFinite(player.y), true);
  });

  test('smoothly predicts acceleration between server updates', async () => {
    const { Player } = await import('../public/core/player.js');
    const app = {
      constants: { maxAcceleration: 1000 },
      state: { world: { enemies: [], asteroids: [] } },
    };
    const player = new Player(app);
    player.setServerState({ x: 0, y: 0, vx: 100, vy: 0, heading: 0 }, null);
    for (let i = 0; i < 8; i++) player.update(0.05);

    player.x = 40;
    player.setServerState({ x: 40, y: 0, vx: 200, vy: 0, heading: 0 }, null);
    assert.ok(Math.abs(player.serverTarget.ax - 250) < 0.001);
    const positions = [];
    for (let i = 0; i < 5; i++) {
      player.update(0.05);
      positions.push(player.x);
    }

    assert.ok(positions[1] - positions[0] > positions[0] - 40);
    assert.ok(positions[4] > positions[0]);
  });

  test('caps predicted acceleration to the server movement limit', async () => {
    const { Player } = await import('../public/core/player.js');
    const player = new Player({
      constants: { maxAcceleration: 180 },
      state: { world: { enemies: [], asteroids: [] } },
    });
    player.setServerState({ x: 0, y: 0, vx: 0, vy: 0, heading: 0 }, null);
    player.serverTargetAge = 0.2;
    player.setServerState({ x: 0, y: 0, vx: 1000, vy: 1000, heading: 0 }, null);

    assert.ok(Math.hypot(player.serverTarget.ax, player.serverTarget.ay) <= 180.001);
  });
});

describe('Inventory grid stacks', () => {
  test('materials use one stack and grid capacity grows with loot items', async () => {
    const { buildInventoryCells } = await import('../public/ui/inventory.js');
    const app = {
      state: {
        materials: { iron: 1000000 },
        loot: Array.from({ length: 30 }, (_, index) => ({
          id: `loot-${index}`,
          name: `Module ${index}`,
          slotType: 'weapon',
          tier: 1,
        })),
      },
      catalog: { minerals: { iron: {} }, components: {} },
    };
    const { cells, total } = buildInventoryCells(app.state, app.catalog, 'all');
    assert.equal(cells.filter((cell) => cell.kind === 'material').length, 1);
    assert.equal(cells[0].count, 1000000);
    assert.equal(cells.filter((cell) => cell.kind === 'loot').length, 30);
    assert.equal(total, 31);
  });

  test('quantum storage stacks materials and represents modules and blueprints as item slots', async () => {
    const { buildStorageCells } = await import('../public/ui/inventory.js');
    const storage = {
      items: { iron: 12 },
      loot: [{ id: 'module-1', slotType: 'weapon', tier: 1 }],
      blueprints: [{ id: 'blueprint-1', kind: 'module', type: 'weapon', tier: 1 }],
    };
    const catalog = {
      minerals: { iron: {} },
      components: {},
    };
    const { cells, total } = buildStorageCells(storage, catalog);
    assert.deepEqual(cells.map((cell) => cell.select), [
      'storage:item:iron',
      'storage:loot:module-1',
      'storage:blueprint:blueprint-1',
    ]);
    assert.equal(cells[0].count, 12);
    assert.equal(total, 26);
  });
});
