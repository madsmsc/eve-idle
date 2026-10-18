'use strict';

// The main HUD: top-left readouts (system, ISK, cargo, threat, faction), the
// mission tracker/dialogue, the ship-info line, and the per-frame fast readouts
// (context, mining indicator, engage/gate buttons, combat banner + combat HUD).
// DOM only; refreshPanels() runs on each server sync, refreshFast() every frame.
import { Node } from '../core/node.js';
import { fmt, pct } from '../core/util.js';

export class HudNode extends Node {
  constructor(app) {
    super(app);
    this.dialogueShownFor = null;
    this.lastCombatPool = null;
  }

  // TODO: no render method? only update method? how does it render? manually calling more specific render methods does not align well with the object oriented approach.

  // Full panel rebuild, called when a fresh server state arrives.
  refreshPanels() {
    this.renderMission();
    document.getElementById('isk').textContent = `${fmt(this.app.state.isk)} ISK`;
    const sysNameEl = document.getElementById('system-name');
    if (this.app.state.system) {
      sysNameEl.textContent = this.app.state.system.name;
      sysNameEl.style.color = this.app.state.system.color;
      sysNameEl.style.textShadow = `0 0 10px ${this.app.state.system.color}80`;
    } else {
      sysNameEl.textContent = '';
      sysNameEl.style.color = '';
      sysNameEl.style.textShadow = '';
    }
    const factionEl = document.getElementById('faction');
    if (this.app.state.activeFaction) {
      const st = this.app.state.activeFaction.standing;
      const sign = st > 0 ? '+' : '';
      factionEl.textContent = `${this.app.state.activeFaction.name} · ${sign}${st.toFixed(1)}`;
      factionEl.hidden = false;
    } else {
      factionEl.hidden = true;
    }
    this.renderCargo();

    const active = this.app.state.activeShip;
    const info = document.getElementById('ship-info');
    if (active) {
      const cargo = `Cargo ${fmt(this.app.state.cargoUsed)}/${fmt(this.app.state.cargoCapacity)}${this.app.state.cargoFull ? ' (FULL)' : ''}`;
      const drones = this.app.state.drones || { mining: [], combat: [] };
      const droneTxt = drones.mining.length + drones.combat.length
        ? ` · 🤖${drones.mining.length}⛏/${drones.combat.length}⚔`
        : '';
      info.innerHTML = `<span class="name">${active.name}</span> <span class="meta">Lv${active.level} · ⛏${active.mining.toFixed(0)}/s · ⚔${active.combat.toFixed(0)}${droneTxt} · ${cargo}</span>`;
    } else {
      info.innerHTML = `<span class="meta">No ship — open the Hangar to buy one</span>`;
    }
    this.updateLoadoutUI();
    this.app.hangar.refresh();
  }

  // Per-frame fast readouts (cheap DOM text updates).
  update(dt) {
    this.refreshFast();
    return super.update(dt);
  }

  refreshFast() {
    const state = this.app.state;
    document.getElementById('isk').textContent = `${fmt(state.isk)} ISK`;
    document.getElementById('threat').textContent = `Threat ${state.threat || 0}`;
    document.getElementById('context').textContent = this.getContext();

    const ind = document.getElementById('mining-indicator');
    const a = this.app.player.nearestAsteroid();
    const active = state.activeShip;
    if (state.combat) {
      ind.textContent = '⚔ In combat';
      ind.className = 'mining-indicator';
    } else if (a && active) {
      ind.textContent = `⛏ Mining ${this.app.catalog.minerals[a.mineral].name} +${active.mining.toFixed(1)}/s`;
      ind.className = 'mining-indicator';
    } else {
      ind.textContent = 'Idle — fly to an asteroid to mine';
      ind.className = 'mining-indicator idle';
    }

    const btn = document.getElementById('engage');
    const target = this.app.player.nearestEnemyInRange();
    if (target && !state.combat) {
      btn.disabled = false;
      btn.classList.add('engage-ready');
      btn.textContent = `Engage ${(this.app.catalog.enemies[target.type] || {}).name || 'target'}`;
    } else {
      btn.disabled = true;
      btn.classList.remove('engage-ready');
      btn.textContent = 'Engage';
    }

    const gateBtn = document.getElementById('gate-jump');
    const atGate = this.app.player.nearestGate();
    if (atGate && !state.combat) {
      gateBtn.hidden = false;
      const targetName = (state.systemNames || []).find((s) => s.id === atGate.targetSystemId);
      const chance = state.ambush ? state.ambush[atGate.targetSystemId] : null;
      const risk = chance != null ? ` · ${Math.round(chance * 100)}%` : '';
      gateBtn.textContent = '⇄ ' + (targetName ? targetName.name : 'Jump') + risk;
    } else {
      gateBtn.hidden = true;
    }

    const banner = document.getElementById('combat-banner');
    const chud = document.getElementById('combat-hud');
    if (state.combat) {
      const c = state.combat;
      const pool = c.shipShield + c.shipHull;
      if (this.lastCombatPool !== null && pool < this.lastCombatPool - 0.5) this.app.camera.addShake(0.3);
      this.lastCombatPool = pool;
      const e = state.world.enemies.find((x) => x.id === c.enemyId);
      const edef = e ? this.app.catalog.enemies[e.type] : null;
      const active = state.activeShip;
      const remain = Math.max(0, Math.ceil(c.remaining));
      const windowLeft = c.enemyRangeDelay > 0 ? Math.max(0, Math.ceil(c.enemyRangeDelay - c.fightTime)) : 0;
      banner.hidden = false;
      banner.textContent = windowLeft > 0
        ? `⚔ ${active ? active.name : 'Ship'} vs ${edef ? edef.name : 'target'} — free fire ${windowLeft}s`
        : `⚔ ${active ? active.name : 'Ship'} vs ${edef ? edef.name : 'target'} — ${remain}s`;
      chud.hidden = false;
      chud.innerHTML = `
        <div class="chud-row you">
          <span class="chud-name">${active ? active.name : 'Ship'}</span>
          <span class="chud-bars">
            <span class="chud-bar shield"><i style="width:${pct(c.shipShield, c.shipShieldMax)}"></i></span>
            <span class="chud-bar hull"><i style="width:${pct(c.shipHull, c.shipHullMax)}"></i></span>
          </span>
          <span class="chud-num">${Math.ceil(c.shipShield)}/${Math.ceil(c.shipHull)}</span>
        </div>
        <div class="chud-row foe">
          <span class="chud-name">${edef ? edef.name : 'Target'}</span>
          <span class="chud-bars">
            <span class="chud-bar shield"><i style="width:${pct(c.enemyShield, c.enemyShieldMax)}"></i></span>
            <span class="chud-bar hull"><i style="width:${pct(c.enemyHull, c.enemyHullMax)}"></i></span>
          </span>
          <span class="chud-num">${Math.ceil(c.enemyShield)}/${Math.ceil(c.enemyHull)}</span>
        </div>
        <div class="chud-actions">
          <button class="chud-btn" data-action="shieldBoost" data-testid="act-boost" ${c.boostReady ? '' : 'disabled'}>
            🛡 Boost${c.boostReady ? ` · ${c.boostCost}` : ` · ${Math.ceil(c.boostCooldown)}s`}
          </button>
          <button class="chud-btn" data-action="overload" data-testid="act-overload" ${c.overloadReady ? '' : 'disabled'}>
            ⚡ Overload${c.overloadReady ? ` · ${c.overloadCost}` : ` · ${Math.ceil(c.overloadCooldown)}s`}${c.overloaded ? ' ✦' : ''}
          </button>
          <button class="chud-btn disengage" data-action="disengage" data-testid="act-disengage">🏃 Disengage</button>
        </div>`;
    } else {
      banner.hidden = true;
      chud.hidden = true;
      this.lastCombatPool = null;
    }
  }

  renderCargo() {
    const el = document.getElementById('cargo');
    el.innerHTML = '';
    for (const key of Object.keys(this.app.catalog.minerals)) {
      const def = this.app.catalog.minerals[key];
      const amt = this.app.state.minerals[key];
      if (amt < 0.5) continue;
      const chip = document.createElement('span');
      chip.className = 'chip';
      chip.innerHTML = `<span class="dot" style="background:${def.color}"></span>${def.name} <span class="amt">${fmt(amt)}</span>`;
      el.appendChild(chip);
    }
  }

  renderMission() {
    const tracker = document.getElementById('mission-tracker');
    const dlg = document.getElementById('mission-dialogue');
    const state = this.app.state;
    if (!state || state.mode !== 'story') {
      tracker.hidden = true;
      dlg.hidden = true;
      return;
    }
    const m = state.mission;
    if (m && m.active && m.objective) {
      let prog = '';
      if (m.progress != null) {
        prog = Array.isArray(m.progress)
          ? m.progress.map((p, i) => `${p}/${m.target[i]}`).join(', ')
          : `${m.progress}/${m.target}`;
      }
      tracker.innerHTML = `<span class="label">${m.title}</span> <span class="sub">${m.objective}${prog ? ' — ' + prog : ''}</span>`;
      tracker.hidden = false;
      if (this.dialogueShownFor !== m.active) {
        this.dialogueShownFor = m.active;
        document.getElementById('mission-npc').textContent = m.npc;
        document.getElementById('mission-text').textContent = m.brief;
        dlg.hidden = false;
      }
    } else {
      tracker.hidden = true;
      dlg.hidden = true;
    }
  }

  updateLoadoutUI() {
    const current = this.app.state && this.app.state.activeShip ? this.app.state.activeShip.loadout : 'balanced';
    for (const btn of document.querySelectorAll('#loadout-panel .loadout-btn')) {
      btn.classList.toggle('active', btn.dataset.loadout === current);
    }
  }

  // A one-line "where am I / what can I do" prompt for the idle player.
  getContext() {
    const state = this.app.state;
    const player = this.app.player;
    if (state.combat) return '⚔ In combat';
    const ns = player.nearestStation();
    if (state.docked) {
      if (state.cargoFull) return `Cargo full at ${state.dockedStation} — sell it (H)`;
      return `Docked at ${state.dockedStation} — press H to trade`;
    }
    if (player.destination) {
      const label = player.poiLabel(player.destination.x, player.destination.y);
      if (state.cargoFull) return `Cargo full — returning to ${label || 'station'}…`;
      return 'Traveling to ' + (label || 'your destination') + '…';
    }
    if (ns && ns.d < 240) return `Approaching ${ns.station.name}…`;
    const a = player.nearestAsteroid();
    if (a) {
      const belt = state.world.belts.find((b) => b.id === a.beltId);
      return `Mining ${this.app.catalog.minerals[a.mineral].name}${belt ? ' · ' + belt.name : ''}`;
    }
    if (player.nearestEnemyInRange()) return 'Rat nearby — press E to engage';
    return 'Idle — click to warp, or use the ⚡ buttons';
  }
}
