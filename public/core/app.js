'use strict';

// Application orchestrator. Owns the server state + catalog, the Player (local
// motion), Camera, the node tree, and the game loop. The tree is driven with a
// single chained call: root.update(dt).render(now).
import { Node } from './node.js';
import { api } from './api.js';
import { Camera } from './camera.js';
import { hexToRgb, dist } from './util.js';
import { Input } from './input.js';
import { WorldNode } from '../view/world.js';
import { UINode } from '../ui/ui.js';

const SYNC_MS = 400;

export class App {
  constructor({ canvas, ctx, minimap, mctx }) {
    this.canvas = canvas;
    this.ctx = ctx;
    this.minimap = minimap;
    this.mctx = mctx;

    this.catalog = null;
    this.constants = null;
    this.state = null;
    this.systemColor = { r: 120, g: 120, b: 160 };
    this.targetEnemyId = null;
    this.hangarOpen = false;
    this.menuPageOpen = false;
    this.activeMenu = 'cargo';
    this.overviewVisible = true;
    this.autoPilot = false;
    this.lastAutoTick = 0;
    this.warpFx = 0;
    this.gateFx = 0;
    this.dockBackground = null;
    this.warpPending = false;
    this.deathTimer = null;
    this.lastFrame = 0;
    this.lastSync = 0;
    this.perfMetrics = typeof window !== 'undefined' && window.__EVE_PERF__ ? {
      frameIntervals: [],
      camera: [],
      update: [],
      render: [],
      frame: [],
      lastFrame: null,
    } : null;

    this.camera = new Camera(this);
    this.world = new WorldNode(this);
    this.player = this.world.player;
    this.ship = this.world.ship;
    this.ui = new UINode(this);
    this.overlays = this.ui.overlays;
    this.root = new Node(this);
    this.root.add(this.world);
    this.root.add(this.ui);

    this.frame = this.frame.bind(this);
  }

  toast(msg, isError) {
    this.overlays.toast(msg, isError);
  }

  applySystemColor() {
    const hex =
      (this.state && this.state.world && this.state.world.color) ||
      (this.state && this.state.system && this.state.system.color) ||
      null;
    if (hex) this.systemColor = hexToRgb(hex);
  }

  resize() {
    this.canvas.width = window.innerWidth;
    this.canvas.height = window.innerHeight;
  }

  async boot() {
    this.resize();
    this.world.genStars();
    try {
      const cat = await api('/api/catalog');
      this.catalog = cat;
      this.constants = cat.constants;
      this.initModeMenu();
    } catch (e) {
      this.toast('Failed to load: ' + e.message, true);
    }
  }

  initModeMenu() {
    const menu = document.getElementById('mode-menu');
    menu.querySelectorAll('.mode-btn').forEach((btn) => {
      btn.addEventListener('click', async () => {
        try {
          const st = await api('/api/mode', { mode: btn.dataset.mode });
          menu.hidden = true;
          this.state = st.state;
          this.finishBoot();
          if (st.offlineReport) this.overlays.showOfflineReport(st.offlineReport);
        } catch (e) {
          this.toast(e.message, true);
        }
      });
    });
  }

  finishBoot() {
    this.applySystemColor();
    this.player.dockTargetId = this.state.dockTargetId || null;
    const active = this.state.ships.find((s) => s.id === this.state.activeShipId);
    if (active) this.player.snap(active.x, active.y);
    this.input = new Input(this);
    this.input.wire();
    this.ui.refreshPanels();
    if (this.state.docked) this.dockBackground = this.world.captureDockBackground(this.ship);
    this.syncDockedView();
    this.showFirstTimeTutorial();
    this.lastFrame = performance.now();
    requestAnimationFrame(this.frame);
  }

  showFirstTimeTutorial() {
    const hint = document.getElementById('tutorial-hint');
    const key = 'eve-idle-demo-tutorial-dismissed';
    if (this.state.mode !== 'demo' || localStorage.getItem(key) === 'true') return;
    hint.hidden = false;
    document.getElementById('tutorial-dismiss').addEventListener('click', () => {
      localStorage.setItem(key, 'true');
      hint.hidden = true;
    }, { once: true });
  }


  // ---- server actions ----

  async doAction(action, payload) {
    try {
      const data = await api(`/api/${action}`, payload);
      this.onServerState(data.state);
      return true;
    } catch (e) {
      this.toast(e.message, true);
      return false;
    }
  }

  onServerState(newState) {
    if (this.docking) {
      // Keep presenting the ship as in space until the cutscene finishes.
      this.docking.dockedStation = newState.dockedStation;
      newState.docked = false;
      newState.dockedStation = null;
    } else if (newState.docked && this.state && !this.state.docked) {
      this.player.docking.begin(newState);
    }
    const prevActive = this.state ? this.state.activeShipId : null;
    const prevShipPos = { x: this.player.x, y: this.player.y };
    const prevSystem = this.state ? this.state.system.id : null;
    this.state = newState;
    this.player.dockTargetId = newState.dockTargetId || null;
    this.applySystemColor();
    const active = this.state.ships.find((s) => s.id === this.state.activeShipId);
    if (active) {
      const jumped =
        dist(active.x, active.y, prevShipPos.x, prevShipPos.y) > 1500 ||
        prevSystem !== this.state.system.id;
      if (prevActive !== this.state.activeShipId || jumped) {
        this.player.snap(active.x, active.y);
        if (jumped) {
          this.warpFx = performance.now();
          if (prevSystem !== this.state.system.id) this.world.genStars();
        }
      }
    }
    this.world.effects.combat.onServerState(prevShipPos);
    this.#logAutoEvents(prevActive, prevSystem);
    this.ui.refreshPanels();
    this.syncDockedView();
  }

  #logAutoEvents(prevActiveId, prevSystemId) {
    if (!this.autoPilot || !this.state || !this._prevAutoState) return;
    const prev = this._prevAutoState;
    const cur = this.state;
    const events = [];
    const prevCargo = Object.values(prev.minerals || {}).reduce((s, v) => s + v, 0);
    const curCargo = Object.values(cur.minerals || {}).reduce((s, v) => s + v, 0);
    if (curCargo > prevCargo) events.push(`mined ${Math.round(curCargo - prevCargo)} ore`);
    if (cur.isk > prev.isk) events.push(`earned ${Math.round(cur.isk - prev.isk)} cr`);
    if (cur.combat === null && prev.combat !== null) {
      events.push(prev.combat.won ? 'rat killed' : 'combat lost');
    }
    const prevOreBelts = new Set(Object.keys(prev.world.asteroids.reduce((m, a) => { if (a.amount > 0) m[a.beltId] = 1; return m; }, {})));
    const curOreBelts = new Set(Object.keys(cur.world.asteroids.reduce((m, a) => { if (a.amount > 0) m[a.beltId] = 1; return m; }, {})));
    for (const bid of prevOreBelts) {
      if (!curOreBelts.has(bid)) {
        const belt = cur.world.belts.find((b) => b.id === bid);
        events.push(`belt ${belt ? belt.name : bid} completed`);
      }
    }
    if (prevSystemId && prevSystemId !== cur.system.id) events.push(`warp to ${cur.system.name}`);
    for (const msg of events) {
      this.autoLog = this.autoLog || [];
      this.autoLog.unshift({ t: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' }), msg });
      if (this.autoLog.length > 20) this.autoLog.pop();
    }
    this._prevAutoState = { minerals: { ...cur.minerals }, isk: cur.isk, combat: cur.combat, world: { asteroids: cur.world.asteroids, belts: cur.world.belts }, system: cur.system };
  }

  // Docked stations overlay services on a ship-free capture of the world.
  syncDockedView() {
    this.ui.syncDockedView();
  }

  // Undock into nearby space without steering the ship back to the station.
  async launch({ keepAutoPilot = false } = {}) {
    const station =
      this.state.world.stations.find((s) => s.name === this.state.dockedStation) ||
      this.state.world.stations[0];
    if (!station) return;
    if (this.autoPilot && !keepAutoPilot) this.toggleAutoPilot();
    this.player.suppressAutoRecall = true;
    // Fade to black, then reappear at the station itself and fly out of it.
    this.player.docking.setFade(true);
    await new Promise((resolve) => setTimeout(resolve, 900));
    const launched = await this.ship.doWarp(null, {
      x: station.x + this.constants.dockRange + 30,
      y: station.y,
      silent: true,
      noFx: true,
    });
    if (launched) this.player.startUndock(station);
    else this.player.suppressAutoRecall = false;
    this.player.docking.setFade(false);
    return launched;
  }

  async sync() {
    if (!this.state || !this.state.activeShip) return;
    try {
      const data = await api('/api/tick', {
        x: this.player.x,
        y: this.player.y,
        dockTargetId: this.player.dockTargetId,
      });
      this.onServerState(data.state);
    } catch (e) {
      /* transient; keep going */
    }
  }

  // The ship node owns the ship's movement and combat actions; these are thin
  // wiring delegators so input, the test hook and autopilot can keep talking to
  // the app while the logic lives in the scene graph (ShipNode).
  doWarp(targetId, opts) {
    return this.ship.doWarp(targetId, opts);
  }

  navigateToNearest(kind) {
    return this.ship.navigateToNearest(kind);
  }

  navigate(targetId, coordinates, opts) {
    return this.ship.navigate(targetId, coordinates, opts);
  }

  doGateJump() {
    return this.ship.doGateJump();
  }

  doEngage() {
    return this.ship.doEngage();
  }

  doCombatAction(action) {
    return this.ship.doCombatAction(action);
  }

  toggleHangar(force) {
    if (force === false) {
      this.closeMenu();
      return;
    }
    if (this.state && this.state.docked) {
      this.openMenu('fleet', true);
    } else {
      this.toast('Dock at a station to use the hangar', true);
    }
  }

  openMenu(name, force) {
    this.ui.openMenu(name, force);
  }

  closeMenu() {
    this.ui.closeMenu();
  }

  toggleOverview(force) {
    this.overviewVisible = force !== undefined ? !!force : !this.overviewVisible;
    const map = document.getElementById('minimap');
    const button = document.getElementById('overview-toggle');
    map.hidden = !this.overviewVisible;
    button.textContent = this.overviewVisible ? 'X' : 'V';
    button.setAttribute('aria-label', this.overviewVisible ? 'Hide minimap' : 'Show minimap');
    button.title = this.overviewVisible ? 'Hide minimap' : 'Show minimap';
    button.setAttribute('aria-expanded', String(this.overviewVisible));
  }

  toggleCharacter(force) {
    this.openMenu('pilot', force);
  }

  toggleInventory(force) {
    this.ui.inventory.setFilter('all');
    this.openMenu('cargo', force);
  }

  toggleFitting(force) {
    this.openMenu('fitting', force);
  }

  toggleLoot(force) {
    this.ui.inventory.setFilter('loot');
    this.openMenu('cargo', force === undefined ? true : force);
  }

  toggleStorage(force) {
    this.openMenu('storage', force);
  }

  // ---- autopilot ----

  toggleAutoPilot() {
    const modes = [null, 'mine', 'mine_hunt', 'hunt'];
    const labels = { null: '▶ Auto', mine: '⛏ Mine', mine_hunt: '⛏⚔ Mine+Hunt', hunt: '⚔ Hunt' };
    const cur = this.autoPilotMode || null;
    const idx = modes.indexOf(cur);
    const next = modes[(idx + 1) % modes.length];
    this.autoPilot = next !== null;
    this.autoPilotMode = next;
    const btn = document.getElementById('auto-pilot');
    btn.textContent = labels[next];
    btn.classList.toggle('on', this.autoPilot);
    if (this.autoPilot) {
      this.lastAutoTick = 0;
      this.autoLog = [];
      this._prevAutoState = { minerals: { ...this.state.minerals }, isk: this.state.isk, combat: this.state.combat, world: { asteroids: this.state.world.asteroids, belts: this.state.world.belts }, system: this.state.system };
      const w = this.state.world;
      const prices = w.prices || {};
      const oreBelts = new Set(w.asteroids.filter((a) => a.amount > 0).map((a) => a.beltId));
      const beltCount = oreBelts.size;
      let totalOre = 0;
      let totalValue = 0;
      for (const a of w.asteroids) {
        if (a.amount <= 0) continue;
        totalOre += a.amount;
        totalValue += a.amount * (prices[a.mineral] || 0);
      }
      const ship = this.state.activeShip;
      const playerHP = ship ? (ship.shield + ship.hull) : 0;
      const safeRats = w.enemies.filter((e) => e.alive && (e.shield + e.hull) < playerHP * 0.5).length;
      const parts = [];
      if (next !== 'hunt') parts.push(`${beltCount} belt(s) [${Math.round(totalOre)} ore ~${Math.round(totalValue)} cr]`);
      if (next !== 'mine') parts.push(`${safeRats} safe rat(s)`);
      this.toast(`Auto [${next.replace('_', '+')}]: ${parts.join(', ') || 'nothing to do'}`);
    } else {
      this.toast('Auto-pilot OFF');
    }
    document.getElementById('auto-log').hidden = !this.autoPilot;
  }

  toggleAutoLog() {
    const panel = document.getElementById('auto-log-panel');
    const list = document.getElementById('auto-log-list');
    if (!panel.hidden) {
      panel.hidden = true;
      return;
    }
    list.innerHTML = (this.autoLog || []).map((e) => `<li><span class="log-time">${e.t}</span> ${e.msg}</li>`).join('') || '<li>No activity yet.</li>';
    panel.hidden = false;
  }

  // ---- loop ----

  frame(now) {
    const dt = Math.min(0.05, (now - this.lastFrame) / 1000);
    this.lastFrame = now;
    const perf = this.perfMetrics;
    const frameStart = perf ? performance.now() : 0;
    if (perf) {
      if (perf.lastFrame !== null) perf.frameIntervals.push(now - perf.lastFrame);
      perf.lastFrame = now;
    }
    this.camera.update(dt);
    const cameraEnd = perf ? performance.now() : 0;
    if (this.state) {
      this.root.update(dt);
      const updateEnd = perf ? performance.now() : 0;
      this.root.render(now);
      if (perf) {
        const renderEnd = performance.now();
        perf.camera.push(cameraEnd - frameStart);
        perf.update.push(updateEnd - cameraEnd);
        perf.render.push(renderEnd - updateEnd);
      }
      if (now - this.lastSync > SYNC_MS && !this.warpPending && !this.undocking) {
        this.lastSync = now;
        this.sync();
      }
    }
    if (perf) perf.frame.push(performance.now() - frameStart);
    requestAnimationFrame(this.frame);
  }

  resetPerfMetrics() {
    if (!this.perfMetrics) return;
    this.perfMetrics.frameIntervals.length = 0;
    this.perfMetrics.camera.length = 0;
    this.perfMetrics.update.length = 0;
    this.perfMetrics.render.length = 0;
    this.perfMetrics.frame.length = 0;
    this.perfMetrics.lastFrame = null;
  }

  getPerfSnapshot() {
    if (!this.perfMetrics) return null;
    const { lastFrame, ...samples } = this.perfMetrics;
    return Object.fromEntries(Object.entries(samples).map(([key, values]) => [key, values.slice()]));
  }
}
