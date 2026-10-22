'use strict';

// Application orchestrator. Owns the server state + catalog, the Player (local
// motion), Camera, the node tree, and the game loop. The tree is driven with a
// single chained call: root.update(dt).render(now).
import { Node } from './node.js';
import { api } from './api.js';
import { Camera } from './camera.js';
import { Player } from './player.js';
import { hexToRgb, dist } from './util.js';
import { Input } from './input.js';
import { WorldNode, StarNode, BeltNode, PlanetNode, MoonNode, AsteroidNode, StationNode, OutpostNode, GateNode, EnemyNode } from '../view/world.js';
import { ShipNode } from '../view/ship.js';
import { CombatNode } from '../view/combat.js';
import { EffectsNode } from '../view/effects.js';
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
    this.combatFx = { enemyId: null, enemyX: 0, enemyY: 0, battleStartPerf: 0, explosions: [] };
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

    this.player = new Player(this);
    this.camera = new Camera(this);
    this.ship = new ShipNode(this);

    this.world = new WorldNode(this);
    this.world
      .add(this.player)
      .add(new StarNode())
      .add(new BeltNode())
      .add(new PlanetNode())
      .add(new MoonNode())
      .add(new AsteroidNode())
      .add(new StationNode())
      .add(new OutpostNode())
      .add(new GateNode())
      .add(new EnemyNode())
      .add(this.ship)
      .add(new CombatNode())
      .add(new EffectsNode());
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
    if (this.state.docked) this.captureDockBackground();
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
      this.beginDocking(newState);
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
    this.updateCombatFx(prevShipPos);
    this.ui.refreshPanels();
    this.syncDockedView();
  }

  // The server flags the ship as docked the moment it is in range; the client
  // plays a short fly-in + fade before showing the station UI.
  beginDocking(newState) {
    const station = newState.world.stations.find((s) => s.name === newState.dockedStation);
    if (!station) return;
    this.captureDockBackground();
    this.docking = { station, dockedStation: newState.dockedStation, elapsed: 0, fading: false, fadeStart: 0 };
    newState.docked = false;
    newState.dockedStation = null;
  }

  setDockFade(on) {
    const el = document.getElementById('dock-fade');
    el.classList.toggle('on', on);
    el.classList.toggle('out', !on);
  }

  finishDocking() {
    const dock = this.docking;
    this.docking = null;
    this.player.snap(dock.station.x, dock.station.y);
    if (this.state) {
      this.state.docked = true;
      this.state.dockedStation = dock.dockedStation;
      this.ui.refreshPanels();
      this.syncDockedView();
    }
    this.setDockFade(false);
  }

  captureDockBackground() {
    const canvas = document.createElement('canvas');
    canvas.width = this.canvas.width;
    canvas.height = this.canvas.height;
    const context = canvas.getContext('2d');
    if (!context) throw new Error('Unable to create a canvas for the station background');

    const previousCanvas = this.canvas;
    const previousContext = this.ctx;
    const previousChildren = this.world.children;
    this.canvas = canvas;
    this.ctx = context;
    this.world.children = previousChildren.filter((child) => child !== this.ship);
    try {
      this.world.render(performance.now());
      this.dockBackground = canvas.toDataURL();
    } finally {
      this.canvas = previousCanvas;
      this.ctx = previousContext;
      this.world.children = previousChildren;
    }
  }

  // Docked stations overlay services on a ship-free capture of the world.
  syncDockedView() {
    const docked = this.state && this.state.docked;
    const wasDocked = document.body.classList.contains('docked');
    if (docked && !wasDocked) {
      this.menuPageOpen = false;
      this.activeMenu = 'fleet';
      document.getElementById('menu-window').hidden = true;
      document.body.classList.remove('menu-window-open');
    } else if (!docked && wasDocked) {
      this.menuPageOpen = false;
      this.activeMenu = 'cargo';
      document.getElementById('menu-window').hidden = true;
      document.body.classList.remove('menu-window-open');
    }
    document.body.classList.toggle('docked', !!docked);
    const view = document.getElementById('station-view');
    if (view) view.hidden = !docked;
    if (docked && view && this.dockBackground) {
      view.style.setProperty('--dock-background', `url("${this.dockBackground}")`);
    }
    if (docked && this.state.dockedStation) {
      const nameEl = document.getElementById('station-view-name');
      if (nameEl) nameEl.textContent = this.state.dockedStation;
    }
    this.hangarOpen = !!docked && ['fleet', 'shipyard', 'skills', 'achievements', 'factions', 'missions', 'drones', 'industry', 'killboard'].includes(this.activeMenu);
    document.getElementById('hangar').hidden = !this.hangarOpen;
    if (this.hangarOpen && (!wasDocked || this.activeMenu !== this.lastHangarTab)) this.ui.hangar.refresh();
    if (this.hangarOpen) this.ui.hangar.showService(this.activeMenu);
    this.lastHangarTab = this.activeMenu;
    document.querySelectorAll('.menu-card').forEach((button) => {
      const selected = this.activeMenu === button.dataset.menu && (this.menuPageOpen || this.hangarOpen);
      button.classList.toggle('active', selected);
      button.setAttribute('aria-current', selected ? 'page' : 'false');
      if (button.hasAttribute('data-station-menu')) {
        button.disabled = !docked;
      }
    });
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
    this.setDockFade(true);
    await new Promise((resolve) => setTimeout(resolve, 900));
    const launched = await this.ship.doWarp(null, {
      x: station.x + this.constants.dockRange + 30,
      y: station.y,
      silent: true,
      noFx: true,
    });
    if (launched) this.player.startUndock(station);
    else this.player.suppressAutoRecall = false;
    this.setDockFade(false);
    return launched;
  }

  // Detect combat start/resolution so we can play the right explosion. The server
  // is authoritative for the outcome (combatLog[0]); we just react to it.
  updateCombatFx(prevShipPos) {
    const c = this.state.combat;
    if (c) {
      if (this.combatFx.enemyId !== c.enemyId) {
        this.combatFx.enemyId = c.enemyId;
        this.combatFx.battleStartPerf = performance.now();
      }
      const e = this.state.world.enemies.find((x) => x.id === c.enemyId);
      if (e) {
        this.combatFx.enemyX = e.x;
        this.combatFx.enemyY = e.y;
      }
    } else if (this.combatFx.enemyId !== null) {
      const last = this.state.combatLog[0];
      if (last) {
        if (last.won) {
          this.combatFx.explosions.push({ x: this.combatFx.enemyX, y: this.combatFx.enemyY, at: performance.now(), kind: 'enemy' });
        } else if (last.shipLost) {
          this.combatFx.explosions.push({ x: prevShipPos.x, y: prevShipPos.y, at: performance.now(), kind: 'ship' });
          this.camera.addShake(2);
          this.overlays.showDeath(last);
        }
      }
      this.combatFx.enemyId = null;
      this.combatFx.battleStartPerf = 0;
    }
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
    const shipMenus = ['cargo', 'fitting', 'storage', 'pilot'];
    const stationMenus = ['fleet', 'shipyard', 'skills', 'achievements', 'factions', 'missions', 'drones', 'industry', 'killboard'];
    if (!shipMenus.includes(name) && !stationMenus.includes(name)) throw new Error(`Unknown menu: ${name}`);
    if (stationMenus.includes(name) && !(this.state && this.state.docked)) {
      this.toast('Dock at a station to use this service', true);
      return;
    }

    const opening = force !== undefined ? !!force : (!this.menuPageOpen && !this.hangarOpen || this.activeMenu !== name);
    if (!opening) {
      this.closeMenu();
      return;
    }
    this.activeMenu = name;
    this.menuPageOpen = shipMenus.includes(name);
    this.hangarOpen = stationMenus.includes(name);
    document.body.classList.toggle('menu-window-open', this.menuPageOpen);
    document.getElementById('menu-window').hidden = !this.menuPageOpen;
    document.getElementById('hangar').hidden = !this.hangarOpen;
    const page = document.querySelector(`.menu-page[data-menu-page="${name}"]`);
    document.querySelectorAll('.menu-page').forEach((item) => {
      const selected = item === page;
      item.classList.toggle('active', selected);
      item.hidden = !selected;
    });
    const button = document.querySelector(`.menu-card[data-menu="${name}"]`);
    document.getElementById('menu-window-title').textContent = button.querySelector('strong').textContent;
    document.querySelectorAll('.menu-card').forEach((item) => {
      const selected = item.dataset.menu === name;
      item.classList.toggle('active', selected);
      item.setAttribute('aria-current', selected ? 'page' : 'false');
    });
    if (this.menuPageOpen) this.ui.refreshMenuPage();
    if (this.hangarOpen) {
      this.ui.hangar.showService(name);
      this.ui.hangar.refresh();
    }
  }

  closeMenu() {
    this.menuPageOpen = false;
    this.hangarOpen = false;
    this.activeMenu = 'cargo';
    document.body.classList.remove('menu-window-open');
    document.getElementById('menu-window').hidden = true;
    document.getElementById('hangar').hidden = true;
    document.querySelectorAll('.menu-card').forEach((item) => {
      item.classList.remove('active');
      item.setAttribute('aria-current', 'false');
    });
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
    this.autoPilot = !this.autoPilot;
    const btn = document.getElementById('auto-pilot');
    btn.textContent = this.autoPilot ? '■ Stop' : '▶ Auto';
    btn.classList.toggle('on', this.autoPilot);
    this.toast(this.autoPilot ? 'Auto-pilot ON — belt → mine → sell → repeat' : 'Auto-pilot OFF');
    if (this.autoPilot) this.lastAutoTick = 0;
  }

  // The idle auto-loop: keep the ship mining the nearest belt, fly home to sell
  // when the hold is full, then return to a belt. The server remains authoritative
  // for position, mining, and every transaction.
  updateAutoPilot(now) {
    if (!this.autoPilot || !this.state || !this.state.activeShip) return;
    if (now - this.lastAutoTick < 800) return;
    this.lastAutoTick = now;
    if (this.state.combat) return;
    if (this.state.docked) {
      if (this.state.cargoUsed > 0) {
        this.doAction('sell-all', {});
      } else {
        const belt = this.player.nearestPoiOf('belt');
        if (belt) {
          this.launch({ keepAutoPilot: true }).then((launched) => {
            if (launched && this.autoPilot) {
              const p = this.player.beltApproachPoint(belt);
              this.player.setDestination(p.x, p.y);
            }
          });
        }
      }
      return;
    }
    if (this.state.cargoFull) {
      this.player.maybeAutoRecall();
      return;
    }
    if (!this.player.nearestAsteroid()) {
      const belt = this.player.nearestPoiOf('belt');
      if (belt) {
        const p = this.player.beltApproachPoint(belt);
        this.player.setDestination(p.x, p.y);
      }
    }
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
      this.player.maybeAutoRecall();
      this.root.update(dt);
      const updateEnd = perf ? performance.now() : 0;
      this.root.render(now);
      if (perf) {
        const renderEnd = performance.now();
        perf.camera.push(cameraEnd - frameStart);
        perf.update.push(updateEnd - cameraEnd);
        perf.render.push(renderEnd - updateEnd);
      }
      this.updateAutoPilot(now);
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
