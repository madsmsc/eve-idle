'use strict';

// HTTP layer. Built on Node's built-in http module (no framework). It exposes a
// small JSON API, validates every action by delegating to game.js, and persists
// the resulting state after each mutation. It also serves the static frontend.

const http = require('http');
const fs = require('fs');
const path = require('path');
const game = require('./game');
const cfg = require('./config');
const { Store } = require('./store');

const PUBLIC_DIR = path.join(__dirname, '..', 'public');

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
};

function sendJson(res, code, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(code, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
    'Cache-Control': 'no-store',
  });
  res.end(body);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', (chunk) => {
      data += chunk;
      if (data.length > 1e6) {
        reject(new Error('Request body too large'));
        req.destroy();
      }
    });
    req.on('end', () => {
      if (!data) return resolve({});
      try {
        resolve(JSON.parse(data));
      } catch (e) {
        reject(new Error('Invalid JSON body'));
      }
    });
    req.on('error', reject);
  });
}

function serveStatic(req, res, pathname) {
  const p = pathname === '/' ? '/index.html' : pathname;
  const safePath = path.normalize(p).replace(/^(\.\.[/\\])+/, '');
  const filePath = path.join(PUBLIC_DIR, safePath);
  if (filePath !== PUBLIC_DIR && !filePath.startsWith(PUBLIC_DIR + path.sep)) {
    res.writeHead(403, { 'Content-Type': 'text/plain' });
    res.end('Forbidden');
    return;
  }
  fs.readFile(filePath, (err, data) => {
    if (err) {
      res.writeHead(404, { 'Content-Type': 'text/plain' });
      res.end('Not found');
      return;
    }
    const ext = path.extname(filePath).toLowerCase();
    res.writeHead(200, { 'Content-Type': MIME[ext] || 'application/octet-stream' });
    res.end(data);
  });
}

// Build an isolated app instance (its own store + state). Used by the main
// entrypoint and by tests (which pass a temp data file and random port).
function createApp({ dataFile } = {}) {
  const store = new Store(dataFile);
  const loaded = store.load();
  let state = game.isValidState(loaded) ? loaded : game.createInitialState();
  store.save(state);

  function persist() {
    store.save(state);
  }
  function getState() {
    return state;
  }
  function setState(next) {
    state = next;
    persist();
  }

  function applyAction(action, payload) {
    const now = Date.now();
    switch (action) {
      case 'tick': {
        state = game.tick(state, now, payload);
        persist();
        return { state };
      }
      case 'buy-ship': {
        const r = game.buyShip(state, payload.type);
        if (r.error) return r;
        state = r.state;
        persist();
        return { state };
      }
      case 'sell-ship': {
        const r = game.sellShip(state, payload.shipId);
        if (r.error) return r;
        state = r.state;
        persist();
        return { state };
      }
      case 'upgrade-ship': {
        const r = game.upgradeShip(state, payload.shipId);
        if (r.error) return r;
        state = r.state;
        persist();
        return { state };
      }
      case 'set-active': {
        const r = game.setActive(state, payload.shipId);
        if (r.error) return r;
        state = r.state;
        persist();
        return { state };
      }
      case 'set-loadout': {
        const r = game.setLoadout(state, payload.shipId, payload.loadout);
        if (r.error) return r;
        state = r.state;
        persist();
        return { state };
      }
      case 'fit-module': {
        const r = game.fitModule(state, payload.shipId, payload.slotType, payload.slotIndex, payload.tier);
        if (r.error) return r;
        state = r.state;
        persist();
        return { state };
      }
      case 'train-skill': {
        const r = game.trainSkill(state, payload.skill);
        if (r.error) return r;
        state = r.state;
        persist();
        return { state };
      }
      case 'buy-drone': {
        const r = game.buyDrone(state, payload.type, payload.tier);
        if (r.error) return r;
        state = r.state;
        persist();
        return { state };
      }
      case 'equip-loot': {
        const r = game.equipLoot(state, payload.lootId);
        if (r.error) return r;
        state = r.state;
        persist();
        return { state };
      }
      case 'craft-module': {
        const r = game.craftModule(state, payload.slotType, payload.tier);
        if (r.error) return r;
        state = r.state;
        persist();
        return { state };
      }
      case 'sell-minerals': {
        const r = game.sellMinerals(state, payload.mineral, payload.amount);
        if (r.error) return r;
        state = r.state;
        persist();
        return { state };
      }
      case 'sell-all': {
        const r = game.sellAll(state);
        if (r.error) return r;
        state = r.state;
        persist();
        return { state };
      }
      case 'engage': {
        const r = game.engage(state, payload.enemyId, now);
        if (r.error) return r;
        state = r.state;
        persist();
        return { state };
      }
      case 'combat-action': {
        const r = game.combatAction(state, payload.action, now);
        if (r.error) return r;
        state = r.state;
        persist();
        return { state };
      }
      case 'warp': {
        const r = game.warp(state, payload.targetId, payload.x, payload.y);
        if (r.error) return r;
        state = r.state;
        persist();
        return { state };
      }
      case 'gate': {
        const r = game.gateJump(state, payload.gateId);
        if (r.error) return r;
        state = r.state;
        persist();
        return { state };
      }
      case 'reset': {
        state = game.reset(state, now);
        persist();
        return { state };
      }
      default:
        return { error: `Unknown action: ${action}` };
    }
  }

  const server = http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
      const pathname = url.pathname;

      if (pathname === '/health') return sendJson(res, 200, { ok: true });

      if (pathname === '/api/state') {
        return sendJson(res, 200, { state: game.view(state) });
      }

      if (pathname === '/api/catalog') {
        return sendJson(res, 200, {
          ships: game.SHIPS,
          modules: game.MODULES,
          skills: game.SKILLS,
          minerals: game.MINERALS,
          enemies: game.ENEMIES,
          loadouts: game.LOADOUTS,
          factions: game.FACTIONS,
          drones: game.DRONES,
          blueprints: game.BLUEPRINTS,
          constants: {
            worldSize: cfg.WORLD_SIZE,
            miningRange: cfg.MINING_RANGE,
            engageRange: cfg.ENGAGE_RANGE,
            dockRange: cfg.DOCK_RANGE,
            gateRange: cfg.GATE_RANGE,
            maxSpeed: cfg.MAX_SPEED,
            maxThrust: cfg.MAX_THRUST,
            damping: cfg.DAMPING,
            arriveRadius: cfg.ARRIVE_RADIUS,
            droneMaxPerType: cfg.DRONE_MAX_PER_TYPE,
          },
        });
      }

      if (pathname.startsWith('/api/') && req.method === 'POST') {
        const action = pathname.slice('/api/'.length);
        let payload;
        try {
          payload = await readBody(req);
        } catch (e) {
          return sendJson(res, 400, { error: e.message || 'Invalid request body' });
        }
        const result = applyAction(action, payload);
        if (result.error) return sendJson(res, 400, { error: result.error });
        return sendJson(res, 200, { state: game.view(result.state) });
      }

      if (req.method === 'GET') return serveStatic(req, res, pathname);

      sendJson(res, 405, { error: 'Method not allowed' });
    } catch (e) {
      sendJson(res, 500, { error: e.message || 'Internal error' });
    }
  });

  function close() {
    return new Promise((resolve) => server.close(resolve));
  }

  return { server, getState, setState, close, dataFile };
}

function start({
  port = Number(process.env.PORT) || 3000,
  dataFile = path.join(__dirname, '..', 'data', 'state.json'),
} = {}) {
  const app = createApp({ dataFile });
  return new Promise((resolve) => {
    app.server.listen(port, () => {
      console.log(`EVE Idle running on http://localhost:${port}`);
      resolve({ ...app, port });
    });
  });
}

if (require.main === module) {
  start();
}

module.exports = { createApp, start };
