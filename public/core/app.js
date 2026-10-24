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
  // PUBLIC
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
    this.warpFx = 0;
    this.gateFx = 0;
    this.dockBackground = null;
    this.warpPending = false;
    this.syncInFlight = false;
    this.pendingActions = 0;
    this.actionVersion = 0;
    this.uiInteractionActive = false;
    this.uiRefreshPending = false;
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

  // PUBLIC
  toast(msg, isError) {
    this.overlays.toast(msg, isError);
  }

  // PUBLIC
  resize() {
    this.canvas.width = window.innerWidth;
    this.canvas.height = window.innerHeight;
  }

  // PUBLIC
  async boot() {
    this.resize();
    this.world.genStars();
    try {
      const cat = await api('/api/catalog');
      this.catalog = cat;
      this.constants = cat.constants;
      this.#initModeMenu();
    } catch (e) {
      this.toast('Failed to load: ' + e.message, true);
    }
  }

  // ---- server actions ----

  // PUBLIC
  async doAction(action, payload) {
    this.actionVersion++;
    this.pendingActions++;
    try {
      const data = await api(`/api/${action}`, payload);
      this.onServerState(data.state);
      return true;
    } catch (e) {
      this.toast(e.message, true);
      return false;
    } finally {
      this.pendingActions--;
    }
  }

  // PUBLIC
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
    this.targetEnemyId = (newState.combat && newState.combat.enemyId) ||
      (newState.navigation && newState.navigation.targetId) || null;
    this.autoPilotMode = newState.autoPilotMode || null;
    this.autoPilot = !!this.autoPilotMode;
    this.#refreshAutoPilotButton();
    this.#applySystemColor();
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
      this.player.setServerState(active, this.state.navigation);
    }
    this.world.effects.combat.onServerState(prevShipPos);
    this.ui.refreshPanels();
    this.syncDockedView();
  }

  // Docked stations overlay services on a ship-free capture of the world.
  // PUBLIC
  syncDockedView() {
    this.ui.syncDockedView();
  }

  // Launch at the server-authoritative position outside the station.
  // PUBLIC
  async launch({ keepAutoPilot = false } = {}) {
    if (this.autoPilot && !keepAutoPilot) await this.doAction('autopilot', { mode: null });
    this.player.suppressAutoRecall = true;
    // Fade to black while the server performs the launch.
    this.player.docking.setFade(true);
    await new Promise((resolve) => setTimeout(resolve, 900));
    const launched = await this.doAction('launch', {});
    if (launched) this.player.startUndock();
    else this.player.suppressAutoRecall = false;
    this.player.docking.setFade(false);
    return launched;
  }

  // The ship node owns the ship's movement and combat actions; these are thin
  // wiring delegators so input, the test hook and autopilot can keep talking to
  // the app while the logic lives in the scene graph (ShipNode).
  // PUBLIC
  doWarp(targetId, opts) {
    return this.ship.doWarp(targetId, opts);
  }

  // PUBLIC
  navigateToNearest(kind) {
    return this.ship.navigateToNearest(kind);
  }

  // PUBLIC
  navigate(targetId, coordinates, opts) {
    return this.ship.navigate(targetId, coordinates, opts);
  }

  // PUBLIC
  doGateJump() {
    return this.ship.doGateJump();
  }

  // PUBLIC
  doEngage() {
    return this.ship.doEngage();
  }

  // PUBLIC
  doCombatAction(action) {
    return this.ship.doCombatAction(action);
  }

  // PUBLIC
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

  // PUBLIC
  openMenu(name, force) {
    this.ui.openMenu(name, force);
  }

  // PUBLIC
  closeMenu() {
    this.ui.closeMenu();
  }

  // PUBLIC
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

  // PUBLIC
  toggleInventory(force) {
    this.ui.inventory.setFilter('all');
    this.openMenu('cargo', force);
  }

  // PUBLIC
  toggleLoot(force) {
    this.ui.inventory.setFilter('loot');
    this.openMenu('cargo', force === undefined ? true : force);
  }

  // PUBLIC
  toggleStorage(force) {
    this.openMenu('storage', force);
  }

  // ---- autopilot ----

  // PUBLIC
  setAutoPilotMode(mode) {
    const currentMode = this.state.autoPilotMode || null;
    return this.doAction('autopilot', { mode: currentMode === mode ? null : mode });
  }

  // PUBLIC
  setAutoPilot(on) {
    return this.doAction('autopilot', { mode: on ? 'mine' : null });
  }

  // ---- loop ----

  // PUBLIC
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
        this.#sync();
      }
    }
    if (perf) perf.frame.push(performance.now() - frameStart);
    requestAnimationFrame(this.frame);
  }

  // PUBLIC
  resetPerfMetrics() {
    if (!this.perfMetrics) return;
    this.perfMetrics.frameIntervals.length = 0;
    this.perfMetrics.camera.length = 0;
    this.perfMetrics.update.length = 0;
    this.perfMetrics.render.length = 0;
    this.perfMetrics.frame.length = 0;
    this.perfMetrics.lastFrame = null;
  }

  // PUBLIC
  getPerfSnapshot() {
    if (!this.perfMetrics) return null;
    const { lastFrame, ...samples } = this.perfMetrics;
    return Object.fromEntries(Object.entries(samples).map(([key, values]) => [key, values.slice()]));
  }

  // PRIVATE
  #applySystemColor() {
    const hex =
      (this.state && this.state.world && this.state.world.color) ||
      (this.state && this.state.system && this.state.system.color) ||
      null;
    if (hex) this.systemColor = hexToRgb(hex);
  }

  // PRIVATE
  #initModeMenu() {
    const menu = document.getElementById('mode-menu');
    menu.querySelectorAll('.mode-btn').forEach((btn) => {
      btn.addEventListener('click', async () => {
        try {
          const st = await api('/api/mode', { mode: btn.dataset.mode });
          menu.hidden = true;
          this.state = st.state;
          this.#finishBoot();
          if (st.offlineReport) this.overlays.showOfflineReport(st.offlineReport);
        } catch (e) {
          this.toast(e.message, true);
        }
      });
    });
  }

  // PRIVATE
  #finishBoot() {
    this.#applySystemColor();
    this.player.dockTargetId = this.state.dockTargetId || null;
    this.autoPilotMode = this.state.autoPilotMode || null;
    this.autoPilot = !!this.autoPilotMode;
    this.#refreshAutoPilotButton();
    const active = this.state.ships.find((s) => s.id === this.state.activeShipId);
    if (active) {
      this.player.snap(active.x, active.y);
      this.player.setServerState(active, this.state.navigation);
    }
    this.input = new Input(this);
    this.input.wire();
    this.ui.refreshPanels();
    if (this.state.docked) this.dockBackground = this.world.captureDockBackground(this.ship);
    this.syncDockedView();
    this.#showFirstTimeTutorial();
    this.lastFrame = performance.now();
    requestAnimationFrame(this.frame);
  }

  // PRIVATE
  #showFirstTimeTutorial() {
    const hint = document.getElementById('tutorial-hint');
    const key = 'eve-idle-demo-tutorial-dismissed';
    if (this.state.mode !== 'demo' || localStorage.getItem(key) === 'true') return;
    hint.hidden = false;
    document.getElementById('tutorial-dismiss').addEventListener('click', () => {
      localStorage.setItem(key, 'true');
      hint.hidden = true;
    }, { once: true });
  }

  // PRIVATE
  #refreshAutoPilotButton() {
    document.querySelectorAll('[data-auto-mode]').forEach((button) => {
      const selected = button.dataset.autoMode === this.autoPilotMode;
      button.classList.toggle('auto-mode-selected', selected);
      button.setAttribute('aria-pressed', String(selected));
    });
  }

  // PRIVATE
  async #sync() {
    if (!this.state || !this.state.activeShip || this.syncInFlight || this.pendingActions) return;
    this.syncInFlight = true;
    const actionVersion = this.actionVersion;
    try {
      const data = await api('/api/tick', {});
      if (actionVersion === this.actionVersion) this.onServerState(data.state);
    } catch (e) {
      /* transient; keep going */
    } finally {
      this.syncInFlight = false;
    }
  }
}
