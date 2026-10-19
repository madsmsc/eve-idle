'use strict';

// Application orchestrator. Owns the server state + catalog, the Player (local
// motion), Camera, the node tree, and the game loop. The tree is driven with a
// single chained call: root.update(dt).render(now).
import { Node } from './node.js';
import { api } from './api.js';
import { Camera } from './camera.js';
import { Player } from './player.js';
import { hexToRgb, dist } from './util.js';
import { initInput } from './input.js';
import { WorldNode, StarNode, BeltNode, PlanetNode, MoonNode, AsteroidNode, StationNode, GateNode, EnemyNode } from '../view/world.js';
import { ShipNode } from '../view/ship-node.js';
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
    this.autoPilot = false;
    this.lastAutoTick = 0;
    this.warpFx = 0;
    this.warpPending = false;
    this.toastTimer = null;
    this.deathTimer = null;
    this.lastFrame = 0;
    this.lastSync = 0;

    this.player = new Player(this);
    this.camera = new Camera(this);

    this.world = new WorldNode(this);
    this.world
      .add(new StarNode())
      .add(new BeltNode())
      .add(new PlanetNode())
      .add(new MoonNode())
      .add(new AsteroidNode())
      .add(new StationNode())
      .add(new GateNode())
      .add(new EnemyNode())
      .add(new ShipNode(this))
      .add(new CombatNode())
      .add(new EffectsNode());
    this.ui = new UINode(this);
    this.hangar = this.ui.hangar;
    this.hud = this.ui.hud; // TODO: this seems unecessary - couldnt access be through the ui, so app did not have a hud field?
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
    initInput(this);
    this.hud.refreshPanels(); // TODO: call through ui - no hud field
    this.lastFrame = performance.now();
    requestAnimationFrame(this.frame);
  }


  // TODO: what is an action? who calls them? are actions just a term for server calls?
  // ---- actions ----

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
    this.hud.refreshPanels(); // TODO: call through ui - no hud field
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

  async doWarp(targetId, opts) {
    opts = opts || {};
    if (this.state.combat) {
      if (!opts.silent) this.toast('Cannot warp while in combat', true);
      return false;
    }
    const payload = targetId ? { targetId } : { x: opts.x, y: opts.y };
    this.warpPending = true;
    const ok = await this.doAction('warp', payload);
    this.warpPending = false;
    if (ok) {
      const active = this.state.ships.find((s) => s.id === this.state.activeShipId);
      if (active) this.player.snap(active.x, active.y);
      if (!opts.silent) this.toast('Warping…');
    }
    return ok;
  }

  warpToNearest(kind) {
    const poi = this.player.nearestPoiOf(kind);
    if (!poi) {
      this.toast(`No ${kind} in this system`, true);
      return;
    }
    this.doWarp(poi.id);
  }

  async doGateJump() {
    const g = this.player.nearestGate();
    if (!g) {
      this.toast('Not at a gate', true);
      return;
    }
    const targetName = (this.state.systemNames || []).find((s) => s.id === g.targetSystemId);
    this.warpPending = true;
    const ok = await this.doAction('gate', { gateId: g.id });
    this.warpPending = false;
    if (ok) {
      if (this.state.combat) {
        this.toast('⚠ Ambushed at the gate!', true);
        this.camera.addShake(1);
      } else {
        this.toast('Jumping to ' + (targetName ? targetName.name : 'system') + '…');
      }
    }
  }

  async doEngage() {
    let target = null;
    if (this.targetEnemyId) {
      const e = this.state.world.enemies.find((x) => x.id === this.targetEnemyId && x.alive);
      if (e && dist(e.x, e.y, this.player.x, this.player.y) <= this.constants.engageRange) target = e;
    }
    if (!target) target = this.player.nearestEnemyInRange();
    if (!target) {
      this.toast('No target in range', true);
      return;
    }
    const ok = await this.doAction('engage', { enemyId: target.id });
    if (ok) this.toast('Engaged!');
  }

  async doCombatAction(action) {
    const ok = await this.doAction('combat-action', { action });
    if (ok) {
      if (action === 'disengage') this.toast('Disengaged — rat escaped');
      else if (action === 'shieldBoost') this.toast('Shield boosted');
      else if (action === 'overload') this.toast('Weapons overloaded');
    }
  }

  async doSetLoadout(loadout) {
    if (!this.state || !this.state.activeShipId) return;
    const ok = await this.doAction('set-loadout', { shipId: this.state.activeShipId, loadout });
    if (ok) this.toast('Loadout: ' + loadout);
  }

  toggleHangar(force) {
    this.hangarOpen = force !== undefined ? force : !this.hangarOpen;
    document.getElementById('hangar').hidden = !this.hangarOpen;
    if (this.hangarOpen) this.hangar.refresh();
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
  // when the hold is full, then go back to a belt. It only sends the same intents
  // a player would (warp / sell), so the server stays authoritative.
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
        if (belt) this.doWarp(belt.id, { silent: true });
      }
      return;
    }
    if (this.state.cargoFull) {
      this.player.maybeAutoRecall();
      return;
    }
    if (!this.player.nearestAsteroid()) {
      const belt = this.player.nearestPoiOf('belt');
      if (belt) this.doWarp(belt.id, { silent: true });
    }
  }

  // ---- loop ----

  frame(now) {
    const dt = Math.min(0.05, (now - this.lastFrame) / 1000);
    this.lastFrame = now;
    this.camera.update(dt);
    if (this.state) { // TODO: what does it mean for state to be undefined?
      this.player.maybeAutoRecall();
      this.player.update(dt);
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
