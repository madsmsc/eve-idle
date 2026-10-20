'use strict';

// Entry point. Builds the app over the two canvases and re-exposes the test hook
// (window.__eve) the E2E suite drives.
import { App } from './core/app.js';

const canvas = document.getElementById('world');
const ctx = canvas.getContext('2d');
const minimap = document.getElementById('minimap');
const mctx = minimap.getContext('2d');

const app = new App({ canvas, ctx, minimap, mctx });

// Test hook used by the E2E suite to drive flight and setup scenarios.
window.__eve = {
  setDestination: (x, y) => {
    app.player.setDestination(x, y);
  },
  getDestination: () => app.player.destination && { ...app.player.destination },
  warp: (targetId, opts) => app.doWarp(targetId, { silent: true, ...(opts || {}) }),
  combatAction: (action) => app.doCombatAction(action),
  setAutoPilot: (on) => {
    if (app.autoPilot !== !!on) app.toggleAutoPilot();
  },
  getShip: () => ({ x: app.player.x, y: app.player.y }),
  get state() {
    return app.state;
  },
};

app.boot();
