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
import { WorldNode, StarNode, BeltNode, PlanetNode, MoonNode, AsteroidNode, StationNode, GateNode, EnemyNode } from '../view/world.js';
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
    this.characterOpen = false;
    this.inventoryOpen = false;
    this.autoPilot = false;
    this.lastAutoTick = 0;
    this.warpFx = 0;
    this.gateFx = 0;
    this.warpPending = false;
    this.toastTimer = null;
    this.deathTimer = null;
    this.lastFrame = 0;
    this.lastSync = 0;

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
    const active = this.state.ships.find((s) => s.id === this.state.activeShipId);
    if (active) this.player.snap(active.x, active.y);
    this.input = new Input(this);
    this.input.wire();
    this.ui.refreshPanels();
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
    const prevActive = this.state ? this.state.activeShipId : null;
    const prevShipPos = { x: this.player.x, y: this.player.y };
    const prevSystem = this.state ? this.state.system.id : null;
    this.state = newState;
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

  // Docked stations replace the world with a station view and make the hangar
  // available; leaving the station hides it and closes the hangar.
  syncDockedView() {
    const docked = this.state && this.state.docked;
    const wasOpen = this.hangarOpen;
    document.body.classList.toggle('docked', !!docked);
    const view = document.getElementById('station-view');
    if (view) view.hidden = !docked;
    if (docked && this.state.dockedStation) {
      const nameEl = document.getElementById('station-view-name');
      if (nameEl) nameEl.textContent = this.state.dockedStation;
    }
    this.hangarOpen = !!docked;
    document.getElementById('hangar').hidden = !docked;
    if (docked && !wasOpen) this.ui.hangar.refresh();
  }

  // Undock into nearby space without steering the ship back to the station.
  async launch({ keepAutoPilot = false } = {}) {
    const station =
      this.state.world.stations.find((s) => s.name === this.state.dockedStation) ||
      this.state.world.stations[0];
    if (!station) return;
    if (this.autoPilot && !keepAutoPilot) this.toggleAutoPilot();
    this.player.suppressAutoRecall = true;
    const launched = await this.ship.doWarp(null, {
      x: station.x + this.constants.dockRange + 200,
      y: station.y,
      silent: true,
    });
    if (!launched) this.player.suppressAutoRecall = false;
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
      const data = await api('/api/tick', { x: this.player.x, y: this.player.y });
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
    if (this.state && this.state.docked) {
      this.hangarOpen = true;
      document.getElementById('hangar').hidden = false;
      this.ui.hangar.refresh();
      return;
    }
    const wantOpen = force !== undefined ? force : !this.hangarOpen;
    if (wantOpen) {
      this.toast('Dock at a station to use the hangar', true);
      return;
    }
    this.hangarOpen = wantOpen;
    document.getElementById('hangar').hidden = !this.hangarOpen;
    if (this.hangarOpen) this.ui.hangar.refresh();
  }

  // Generic corner-panel open/close. Tracks the open flag, reflects it on <body>
  // (so CSS can reflow the docked hangar) and re-renders the panel when shown.
  setPanel(flagKey, elementId, bodyClass, refresh, force) {
    this[flagKey] = force !== undefined ? force : !this[flagKey];
    document.body.classList.toggle(bodyClass, this[flagKey]);
    document.getElementById(elementId).hidden = !this[flagKey];
    if (this[flagKey]) refresh();
  }

  // Character sheet (standings) is available in space and docked.
  toggleCharacter(force) {
    this.setPanel('characterOpen', 'character-sheet', 'char-open', () => this.ui.character.refresh(), force);
  }

  // Inventory (ship contents + quantum storage) is available in space and docked;
  // storage deposit/withdraw still requires docking.
  toggleInventory(force) {
    this.setPanel('inventoryOpen', 'inventory', 'inv-open', () => this.ui.inventory.refresh(), force);
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
            if (launched && this.autoPilot) this.player.setDestination(belt.x, belt.y);
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
      if (belt) this.player.setDestination(belt.x, belt.y);
    }
  }

  // ---- loop ----

  frame(now) {
    const dt = Math.min(0.05, (now - this.lastFrame) / 1000);
    this.lastFrame = now;
    this.camera.update(dt);
    if (this.state) {
      this.player.maybeAutoRecall();
      this.root.update(dt).render(now);
      this.updateAutoPilot(now);
      if (now - this.lastSync > SYNC_MS && !this.warpPending) {
        this.lastSync = now;
        this.sync();
      }
    }
    requestAnimationFrame(this.frame);
  }
}
