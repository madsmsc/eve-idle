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
