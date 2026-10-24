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

function serveStatic(req, res, pathname, liveReload = false) {
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
    const headers = { 'Content-Type': MIME[ext] || 'application/octet-stream' };
    if (liveReload) headers['Cache-Control'] = 'no-store';
    if (liveReload && ext === '.html') {
      const reloadClient = `<script>
        (() => {
          const source = new EventSource('/__dev/live-reload');
          source.addEventListener('session', (event) => {
            const key = 'eve-idle-dev-session';
            const previous = sessionStorage.getItem(key);
            sessionStorage.setItem(key, event.data);
            if (previous && previous !== event.data) window.location.reload();
          });
          source.addEventListener('change', () => window.location.reload());
        })();
      </script>`;
      const html = data.toString('utf8').replace('</body>', `${reloadClient}</body>`);
      res.writeHead(200, headers);
      res.end(html);
      return;
    }
    res.writeHead(200, headers);
    res.end(data);
  });
}

// Build an isolated app instance (its own store + state). Used by the main
// entrypoint and by tests (which pass a temp data file and random port).
//
// Saves are stored per mode in a single container file: { demo, story }. Each
// mode keeps its own progress, so switching modes never clobbers the other.
function normalizeStore(loaded) {
  const migrate = (state) => {
    const current = game.migrateEconomy(state);
    return game.isValidState(current) ? game.migrateWorldLayout(current) : null;
  };
  if (loaded && typeof loaded === 'object' && (loaded.demo || loaded.story || loaded.__slots)) {
    return { demo: migrate(loaded.demo), story: migrate(loaded.story) };
  }
  // Legacy single-state save: treat as the demo slot (STATE_VERSION-gated).
  return { demo: migrate(loaded), story: null };
}

function materialTotals(state) {
  const totals = Object.fromEntries([
    ...Object.keys(game.MINERALS),
    ...Object.keys(game.COMPONENTS),
  ].map((key) => [key, 0]));
  for (const ship of state.ships || []) {
    for (const [key, amount] of Object.entries(ship.cargo || {})) {
      if (key in totals) totals[key] += amount || 0;
    }
  }
  const stored = state.storage && (state.storage.items || state.storage.minerals);
  for (const [key, amount] of Object.entries(stored || {})) {
    if (key in totals) totals[key] += amount || 0;
  }
  return totals;
}

function createApp({ dataFile, liveReload = false } = {}) {
  const store = new Store(dataFile);
  const saves = normalizeStore(store.load());
  let mode = 'demo';
  let state = game.isValidState(saves[mode]) ? saves[mode] : game.createInitialState(undefined, undefined, mode);
  saves[mode] = state;
  store.save(saves);
  const liveReloadClients = new Set();
  const liveReloadSession = `${process.pid}-${Date.now()}-${Math.random()}`;
  let liveReloadWatcher = null;
  let liveReloadTimer = null;

  if (liveReload) {
    liveReloadWatcher = fs.watch(PUBLIC_DIR, { recursive: true }, () => {
      if (liveReloadTimer) clearTimeout(liveReloadTimer);
      liveReloadTimer = setTimeout(() => {
        liveReloadTimer = null;
        for (const client of liveReloadClients) client.write('event: change\ndata: reload\n\n');
      }, 100);
    });
    liveReloadWatcher.on('error', (error) => {
      console.error('Live reload file watcher error:', error);
    });
  }

  function persist() {
    saves[mode] = state;
    store.save(saves);
  }
  function getState() {
    return state;
  }
  function getMode() {
    return mode;
  }
  function setState(next) {
    state = next;
    saves[mode] = state;
    persist();
  }

  function applyAction(action, payload) {
    const now = Date.now();
    switch (action) {
      case 'tick': {
        state = game.tick(state, now);
        persist();
        return { state };
      }
      case 'navigate': {
        const r = game.navigate(state, payload);
        if (r.error) return r;
        state = r.state;
        persist();
        return { state };
      }
      case 'autopilot': {
        const r = game.setAutopilot(state, payload.mode);
        if (r.error) return r;
        state = r.state;
        persist();
        return { state };
      }
      case 'launch': {
        const r = game.launch(state);
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
      case 'fit-module': {
        const r = game.fitModule(state, payload.shipId, payload.slotType, payload.slotIndex, payload.tier);
        if (r.error) return r;
        state = r.state;
        persist();
        return { state };
      }
      case 'unequip-all': {
        const r = game.unequipAllModules(state);
        if (r.error) return r;
        state = r.state;
        persist();
        return { state };
      }
      case 'apply-fitting-preset': {
        const r = game.applyFittingPreset(state, payload.name);
        if (r.error) return r;
        state = r.state;
        persist();
        return { state };
      }
      case 'delete-fitting-preset': {
        const r = game.deleteFittingPreset(state, payload.name);
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
      case 'buy-blueprint': {
        const r = game.buyBlueprint(state, payload.kind, payload.type, payload.tier);
        if (r.error) return r;
        state = r.state;
        persist();
        return { state };
      }
      case 'exchange-items': {
        const r = game.exchangeItems(state, payload.family, payload.item, payload.amount);
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
      case 'refine-loot': {
        const r = game.refineLoot(state, payload.lootId);
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
      case 'craft-ship': {
        const r = game.craftShip(state, payload.type);
        if (r.error) return r;
        state = r.state;
        persist();
        return { state };
      }
      case 'deposit': {
        const r = game.deposit(state, payload.mineral, payload.amount);
        if (r.error) return r;
        state = r.state;
        persist();
        return { state };
      }
      case 'deposit-all': {
        const r = game.depositAll(state);
        if (r.error) return r;
        state = r.state;
        persist();
        return { state };
      }
      case 'deposit-filtered': {
        const r = game.depositFiltered(state, payload.filter);
        if (r.error) return r;
        state = r.state;
        persist();
        return { state };
      }
      case 'withdraw': {
        const r = game.withdraw(state, payload.mineral, payload.amount);
        if (r.error) return r;
        state = r.state;
        persist();
        return { state };
      }
      case 'store-item': {
        const r = game.storeInventoryItem(state, payload.kind, payload.id);
        if (r.error) return r;
        state = r.state;
        persist();
        return { state };
      }
      case 'retrieve-item': {
        const r = game.retrieveInventoryItem(state, payload.kind, payload.id);
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
      case 'mission': {
        const r = game.missionAction(state, payload.action);
        if (r.error) return r;
        state = r.state;
        persist();
        return { state };
      }
      case 'agent-mission': {
        const r = game.agentMissionAction(state, payload.action, now);
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

      if (pathname === '/__dev/live-reload') {
        if (!liveReload) return sendJson(res, 404, { error: 'Not found' });
        res.writeHead(200, {
          'Content-Type': 'text/event-stream',
          'Cache-Control': 'no-cache',
          Connection: 'keep-alive',
        });
        res.write(`event: session\ndata: ${liveReloadSession}\n\n`);
        liveReloadClients.add(res);
        req.on('close', () => liveReloadClients.delete(res));
        return;
      }

      if (pathname === '/health') return sendJson(res, 200, { ok: true });

      if (pathname === '/api/state') {
        return sendJson(res, 200, { state: game.view(state) });
      }

      if (pathname === '/api/catalog') {
        return sendJson(res, 200, {
          ships: game.SHIPS,
          modules: game.MODULES,
          skills: game.SKILLS,
          achievements: game.ACHIEVEMENTS,
          agentMissions: game.AGENT_MISSIONS,
          minerals: game.MINERALS,
          components: game.COMPONENTS,
          oreExchange: game.ORE_EXCHANGE,
          componentExchange: game.COMPONENT_EXCHANGE,
          blueprintCosts: game.BLUEPRINT_COSTS,
          npcBlueprints: game.NPC_BLUEPRINTS,
          enemies: game.ENEMIES,
          enemyTiers: game.ENEMY_TIERS,
          drones: game.DRONES,
          blueprints: game.BLUEPRINTS,
          shipBlueprints: game.SHIP_BLUEPRINTS,
          shipProgression: game.SHIP_PROGRESSION,
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

      if (pathname === '/api/mode' && req.method === 'POST') {
        let payload;
        try {
          payload = await readBody(req);
        } catch (e) {
          return sendJson(res, 400, { error: e.message || 'Invalid request body' });
        }
        if (!cfg.MODES.includes(payload.mode)) {
          return sendJson(res, 400, { error: 'Unknown mode' });
        }
        let offlineReport = null;
        if (!saves[payload.mode] || !game.isValidState(saves[payload.mode])) {
          saves[payload.mode] = game.createInitialState(Date.now(), undefined, payload.mode);
        } else {
          const saved = saves[payload.mode];
          const actualSeconds = Math.max(0, Math.floor((Date.now() - saved.lastTick) / 1000));
          if (actualSeconds >= 60) {
            const before = saved.stats || {};
            const itemsBefore = materialTotals(saved);
            const caughtUp = game.tick(saved, Date.now(), null);
            const after = caughtUp.stats || {};
            const itemsAfter = materialTotals(caughtUp);
            const items = {};
            for (const [key, amount] of Object.entries(itemsAfter)) {
              const delta = amount - (itemsBefore[key] || 0);
              if (delta > 0) items[key] = delta;
            }
            const oreByType = {};
            for (const [k, v] of Object.entries(after.oreMinedByType || {})) {
              const delta = v - ((before.oreMinedByType || {})[k] || 0);
              if (delta > 0) oreByType[k] = delta;
            }
            offlineReport = {
              elapsedSeconds: actualSeconds,
              capped: actualSeconds > cfg.MAX_OFFLINE_SECONDS,
              mined: Math.max(0, (after.totalMineralsMined || 0) - (before.totalMineralsMined || 0)),
              kills: Math.max(0, (after.combatsWon || 0) - (before.combatsWon || 0)),
              skillPoints: Math.max(0, (after.totalSpEarned || 0) - (before.totalSpEarned || 0)),
              distance: Math.max(0, (after.distanceTraveled || 0) - (before.distanceTraveled || 0)),
              beltsCompleted: Math.max(0, (after.beltsCompleted || 0) - (before.beltsCompleted || 0)),
              oreByType,
              items,
            };
            saves[payload.mode] = caughtUp;
          }
          if (payload.mode === 'story' && game.missionStartNeeded(saves[payload.mode])) {
            game.startMission(saves[payload.mode], 'm1');
          }
        }
        mode = payload.mode;
        state = saves[mode];
        persist();
        return sendJson(res, 200, { mode, state: game.view(state), offlineReport });
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

      if (req.method === 'GET') return serveStatic(req, res, pathname, liveReload);

      sendJson(res, 405, { error: 'Method not allowed' });
    } catch (e) {
      sendJson(res, 500, { error: e.message || 'Internal error' });
    }
  });

  function close() {
    if (liveReloadTimer) clearTimeout(liveReloadTimer);
    if (liveReloadWatcher) liveReloadWatcher.close();
    for (const client of liveReloadClients) client.end();
    return new Promise((resolve) => server.close(resolve));
  }

  return { server, getState, setState, close, dataFile };
}

function start({
  port = Number(process.env.PORT) || 3000,
  dataFile = process.env.DATA_FILE || path.join(__dirname, '..', 'data', 'state.json'),
  liveReload = process.argv.includes('--dev'),
} = {}) {
  const app = createApp({ dataFile, liveReload });
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
