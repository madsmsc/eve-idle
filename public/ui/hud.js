'use strict';

// The main HUD: top-left system readout,
// mission tracker/dialogue, the ship-info line, and the per-frame fast readouts
// (status box + event log, engage/gate buttons, combat banner + combat HUD).
// DOM only; panels refresh on server sync, while fast readouts update every frame.
import { Node } from '../core/node.js';
import { fmt, pct } from '../core/util.js';

const CTX_COLORS = { idle: '#7a89ad', mining: '#35d07f', travel: '#4fd1ff', combat: '#ff5c7a', docked: '#a58bff', warn: '#ffb454' };
const EVENT_LIFETIME_MS = 6000;
const EVENT_FADE_AFTER_MS = 2500;
const MAX_VISIBLE_EVENTS = 6;

export function autoPilotBannerText(efficiency) {
  if (!Number.isFinite(efficiency) || efficiency <= 0) {
    throw new Error('Autopilot efficiency must be a positive number');
  }
  return `due to AI inefficiencies, all systems running at 1/${1 / efficiency} capacity`;
}

export function countAutomationEvents(log = []) {
  const counts = new Map();
  for (const event of log) {
    const key = `${event.at}:${event.message}`;
    counts.set(key, (counts.get(key) || 0) + 1);
  }
  return counts;
}

export function collectNewAutomationEvents(log = [], seenCounts = new Map()) {
  const currentCounts = countAutomationEvents(log);
  const fresh = [];
  const processed = new Map();
  for (const event of log.slice().reverse()) {
    const key = `${event.at}:${event.message}`;
    const count = (processed.get(key) || 0) + 1;
    processed.set(key, count);
    if (count > (seenCounts.get(key) || 0)) fresh.push(event);
  }
  return { currentCounts, fresh };
}

export function renderActivityLog(events, list, eventKey, now) {
  const visible = events.filter((event) => now - event.at < EVENT_LIFETIME_MS);
  const key = visible.map((event) => event.id).join(',');
  if (key !== eventKey) {
    list.innerHTML = '';
    for (const event of visible) {
      const line = document.createElement('li');
      line.className = event.tone;
      line.textContent = event.text;
      line.dataset.id = event.id;
      list.appendChild(line);
    }
  }
  for (const line of list.children) {
    const event = visible.find((item) => String(item.id) === line.dataset.id);
    const age = event ? now - event.at : EVENT_LIFETIME_MS;
    line.style.opacity = age < EVENT_FADE_AFTER_MS
      ? 1
      : Math.max(0, 1 - (age - EVENT_FADE_AFTER_MS) / (EVENT_LIFETIME_MS - EVENT_FADE_AFTER_MS));
  }
  return key;
}

export class HudNode extends Node {
  // PUBLIC
  constructor(app) {
    super(app);
    this.dialogueShownFor = null;
    this.lastCombatPool = null;
  }

  // Full panel rebuild, called when a fresh server state arrives.
  // PUBLIC
  refreshPanels() {
    this.#renderMission();
    const sysNameEl = document.getElementById('system-name');
    if (this.app.state.system) {
      sysNameEl.textContent = this.app.state.system.name;
      sysNameEl.style.color = this.app.state.system.color;
      sysNameEl.style.textShadow = `0 0 10px ${this.app.state.system.color}80`;
      document.getElementById('system-security').textContent =
        Number(this.app.state.system.security).toFixed(1);
    } else {
      sysNameEl.textContent = '';
      sysNameEl.style.color = '';
      sysNameEl.style.textShadow = '';
      document.getElementById('system-security').textContent = '';
    }
    this.#renderSystemObjectives();
    this.#collectEvents();
  }

  // PUBLIC
  update(dt) {
    this.#refreshFast();
    return super.update(dt);
  }

  // PUBLIC
  pushEvent(text, tone) {
    this.events = this.events || [];
    this.events.unshift({ id: (this.eventId = (this.eventId || 0) + 1), text, tone, at: performance.now() });
    if (this.events.length > MAX_VISIBLE_EVENTS) this.events.length = MAX_VISIBLE_EVENTS;
  }

  // PRIVATE
  // Turn new combat results, jumps and a full hold into short event-log lines.
  #collectEvents() {
    const state = this.app.state;
    const log = state.combatLog || [];
    const newest = log.length ? log[0].at : 0;
    if (this.lastLogAt === undefined) {
      this.lastLogAt = newest;
      this.lastSystemId = state.system ? state.system.id : null;
      this.wasCargoFull = !!state.cargoFull;
      this.seenAutomationEvents = countAutomationEvents(state.automationLog);
      return;
    }
    const fresh = log.filter((e) => e.at > this.lastLogAt).reverse();
    for (const e of fresh) {
      if (e.disengaged) this.pushEvent(`Disengaged from ${e.enemy}`, 'warn');
      else if (e.won) {
        const loot = e.loot ? ` · loot: ${e.loot.slotType} T${e.loot.tier}` : '';
      const blueprint = e.blueprint ? ` · blueprint: ${this.#blueprintName(e.blueprint)}` : '';
        this.pushEvent(`Destroyed ${e.enemy} · +${fmt(e.scrap || 0)} Scrap${loot}${blueprint}`, 'good');
      } else this.pushEvent(`${e.ship} lost to ${e.enemy}`, 'bad');
    }
    this.lastLogAt = Math.max(this.lastLogAt, newest);
    const systemId = state.system ? state.system.id : null;
    if (systemId && this.lastSystemId && systemId !== this.lastSystemId) {
      this.pushEvent(`Entered ${state.system.name}`, '');
    }
    this.lastSystemId = systemId;
    if (state.cargoFull && !this.wasCargoFull) this.pushEvent('Cargo hold full', 'warn');
    this.wasCargoFull = !!state.cargoFull;
    this.#collectAutomationEvents(state.automationLog);
  }

  // PRIVATE
  #collectAutomationEvents(log = []) {
    const { currentCounts, fresh } = collectNewAutomationEvents(log, this.seenAutomationEvents);
    for (const event of fresh) this.pushEvent(event.message, 'auto');
    this.seenAutomationEvents = currentCounts;
  }

  // PRIVATE
  #blueprintName(blueprint) {
    if (blueprint.kind === 'module') {
      const module = this.app.catalog.modules[blueprint.type];
      return `${module ? module.name : blueprint.type} T${blueprint.tier}`;
    }
    const ship = this.app.catalog.ships[blueprint.type];
    return `${ship ? ship.name : blueprint.type} ship`;
  }

  // PRIVATE
  #renderEventLog() {
    const list = document.querySelector('#context .ctx-log');
    const now = performance.now();
    this.eventKey = renderActivityLog(this.events || [], list, this.eventKey, now);
  }

  // PRIVATE
  #refreshFast() {
    const state = this.app.state;
    document.querySelector('.hud-bl').classList.toggle('combat-active', !!state.combat);
    this.#renderContext();
    this.#renderEventLog();

    const active = state.activeShip;
    const status = document.getElementById('ship-status');
    status.hidden = !!state.docked || !active;
    if (active) {
      const shield = state.combat ? state.combat.shipShield : active.shield;
      const shieldMax = state.combat ? state.combat.shipShieldMax : active.shield;
      const hull = state.combat ? state.combat.shipHull : active.hull;
      const hullMax = state.combat ? state.combat.shipHullMax : active.hull;
      const speed = active.speed || 0;
      const speedMax = state.maxSpeed || this.app.constants.maxSpeed;
      const setStatusBar = (name, value, max, label) => {
        const bar = status.querySelector(`[data-testid="status-${name}"]`);
        bar.querySelector('.status-track i').style.width = pct(value, max);
        status.querySelector(`[data-testid="status-${name}-value"]`).textContent = label;
      };
      setStatusBar('shield', shield, shieldMax, `${Math.ceil(shield)} / ${Math.ceil(shieldMax)}`);
      setStatusBar('hull', hull, hullMax, `${Math.ceil(hull)} / ${Math.ceil(hullMax)}`);
      setStatusBar('speed', speed, speedMax, `${Math.round(speed)} m/s`);
    }

    const btn = document.getElementById('engage');
    const target = state.world.enemies.find((enemy) => enemy.id === state.nearby.enemyId);
    const canEngage = !!target && !state.combat;
    btn.disabled = !canEngage;
    btn.title = canEngage ? `Engage ${target.name || 'enemy'}` : 'An enemy must be in range to engage';
    if (canEngage) {
      btn.classList.add('engage-ready');
    } else {
      btn.classList.remove('engage-ready');
    }

    const gateBtn = document.getElementById('gate-jump');
    const atGate = state.world.gates.find((gate) => gate.id === state.nearby.gateId);
    if (atGate && !state.combat) {
      const targetName = (state.systemNames || []).find((s) => s.id === atGate.targetSystemId);
      const chance = state.ambush ? state.ambush[atGate.targetSystemId] : null;
      const risk = chance != null ? ` · ${Math.round(chance * 100)}%` : '';
      gateBtn.textContent = '⇄ ' + (targetName ? targetName.name : 'Jump') + risk;
      gateBtn.disabled = false;
      gateBtn.title = `Jump to ${targetName ? targetName.name : 'the next system'}`;
    } else {
      gateBtn.textContent = '⇄ Jump';
      gateBtn.disabled = true;
      gateBtn.title = 'A jump gate must be in range to jump';
    }
    const mineButton = document.getElementById('mine');
    mineButton.disabled = state.docked || state.combat || state.cargoFull || !state.miningTargetId;

    const banner = document.getElementById('combat-banner');
    const autoBanner = document.getElementById('auto-banner');
    autoBanner.hidden = !state.autoPilotMode || state.docked;
    if (!autoBanner.hidden) {
      autoBanner.textContent = autoPilotBannerText(state.autoPilotEfficiency);
    }
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
      const tierTxt = e && e.tierName ? ` (${e.tierName})` : '';
      banner.hidden = false;
      banner.textContent = windowLeft > 0
        ? `⚔ ${active ? active.name : 'Ship'} vs ${edef ? edef.name : 'target'}${tierTxt} — free fire ${windowLeft}s`
        : `⚔ ${active ? active.name : 'Ship'} vs ${edef ? edef.name : 'target'}${tierTxt} — ${remain}s`;
      chud.hidden = false;
      chud.innerHTML = `
        <div class="chud-actions">
          <button class="chud-btn" data-action="shieldBoost" data-testid="act-boost" ${c.boostReady ? '' : 'disabled'}>
            🛡 Boost${c.boostReady ? ` · 1 ${c.boostItem}` : ` · ${Math.ceil(c.boostCooldown)}s`}
          </button>
          <button class="chud-btn" data-action="overload" data-testid="act-overload" ${c.overloadReady ? '' : 'disabled'}>
            ⚡ Overload${c.overloadReady ? ` · 1 ${c.overloadItem}` : ` · ${Math.ceil(c.overloadCooldown)}s`}${c.overloaded ? ' ✦' : ''}
          </button>
          <button class="chud-btn disengage" data-action="disengage" data-testid="act-disengage">🏃 Disengage</button>
        </div>`;
    } else {
      banner.hidden = true;
      chud.hidden = true;
      this.lastCombatPool = null;
    }
  }

  // PRIVATE
  #renderMission() {
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
      const hint = m.ready ? ' — return to a station to turn in' : '';
      tracker.innerHTML = `<span class="label">${m.title}</span> <span class="sub">${m.objective}${prog ? ' — ' + prog : ''}${hint}</span>`;
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

  // PRIVATE
  #renderSystemObjectives() {
      const list = document.getElementById('mission-objectives');
      const objectives = [];
      const mission = this.app.state.mission;
      if (mission && mission.active && mission.objective) {
        for (const objective of mission.objectives || [{
          label: mission.objective,
          progress: mission.progress,
          target: mission.target,
        }]) {
          objectives.push({ ...objective, ready: mission.ready });
        }
      }
      for (const agentMission of this.app.state.agentMission && this.app.state.agentMission.active || []) {
        objectives.push({
          label: agentMission.objective,
          progress: agentMission.progress,
          target: agentMission.target,
        });
      }

      list.replaceChildren();
      if (!objectives.length) {
        const empty = document.createElement('li');
        empty.textContent = 'No active mission';
        list.appendChild(empty);
        return;
      }
      for (const objective of objectives) {
        const line = document.createElement('li');
        let progress = '';
        if (Array.isArray(objective.progress)) {
          progress = ` — ${objective.progress.map((value, index) =>
            `${value}/${objective.target[index]}`
          ).join(', ')}`;
        } else if (objective.progress != null && objective.target != null) {
          progress = ` — ${objective.progress}/${objective.target}`;
        }
        line.textContent = `${objective.label}${progress}${objective.ready ? ' — return to a station' : ''}`;
        list.appendChild(line);
      }
  }

  // What the pilot is doing right now: a colored state plus a detail line.
  // PRIVATE
  #getContext() {
    const state = this.app.state;
    const player = this.app.player;
    const active = state.activeShip;
    if (state.combat) {
      const c = state.combat;
      const e = state.world.enemies.find((x) => x.id === c.enemyId);
      const def = e ? this.app.catalog.enemies[e.type] : null;
      const name = def ? def.name : 'target';
      const tier = e && e.tierName ? ` (${e.tierName})` : '';
      const hp = Math.ceil(c.enemyShield + c.enemyHull);
      const hpMax = Math.ceil(c.enemyShieldMax + c.enemyHullMax);
      return { label: 'Fighting', color: CTX_COLORS.combat, detail: `${name}${tier} · ${fmt(hp)}/${fmt(hpMax)} HP · ⚔${fmt(c.enemyDps)} dps` };
    }
    const nearestStation = state.world.stations.find((station) => station.id === state.nearby.stationId);
    const ns = nearestStation ? { station: nearestStation, d: state.nearby.stationDistance } : null;
    if (state.docked) {
      if (state.cargoFull) return { label: 'Docked', color: CTX_COLORS.docked, detail: `Cargo full at ${state.dockedStation} — sell or store it` };
      return { label: 'Docked', color: CTX_COLORS.docked, detail: `Docked at ${state.dockedStation} — access station services` };
    }
    if (player.destination && state.cargoFull) {
      const label = player.poiLabel(player.destination.x, player.destination.y);
      const d = Math.round(Math.hypot(player.destination.x - player.x, player.destination.y - player.y));
      return { label: 'Returning', color: CTX_COLORS.warn, detail: `Cargo full — returning to ${label || 'station'} · ${fmt(d)} m` };
    }
    const target = this.app.targetEnemyId
      ? state.world.enemies.find((enemy) => enemy.id === this.app.targetEnemyId && enemy.alive)
      : null;
    if (target) {
      const def = this.app.catalog.enemies[target.type];
      const tier = target.tierName ? ` (${target.tierName})` : '';
      const distance = Math.round(Math.hypot(target.x - player.x, target.y - player.y));
      const inRange = distance <= this.app.constants.engageRange;
      const difficulty = target.difficulty ? target.difficulty.label.toLowerCase() : 'unknown';
      return {
        label: inRange ? 'Hostile in range' : 'Target acquired',
        color: CTX_COLORS.warn,
        detail: `${def ? def.name : 'Enemy'}${tier} · Approx. ${difficulty} · ${fmt(distance)} m${inRange ? ' — press E to engage' : ''}`,
      };
    }
    const a = state.miningTargetId
      ? state.world.asteroids.find((asteroid) => asteroid.id === state.miningTargetId)
      : null;
    if (a && active && !state.cargoFull) {
      const belt = state.world.belts.find((b) => b.id === a.beltId);
      const ore = this.app.catalog.minerals[a.mineral].name;
      const rate = active.mining.toFixed(1);
      const cargo = `${fmt(state.cargoUsed)}/${fmt(state.cargoCapacity)}`;
      if (['mine', 'mine_fight'].includes(state.autoPilotMode)) {
        return { label: 'Mining', color: CTX_COLORS.mining, detail: `${ore}${belt ? ' · ' + belt.name : ''} · +${rate}/s · Cargo ${cargo}` };
      }
      return { label: 'Ore in range', color: CTX_COLORS.mining, detail: `${ore}${belt ? ' · ' + belt.name : ''} · press M to mine · Cargo ${cargo}` };
    }
    if (player.destination) {
      const label = player.poiLabel(player.destination.x, player.destination.y);
      const d = Math.round(Math.hypot(player.destination.x - player.x, player.destination.y - player.y));
      return { label: 'Traveling', color: CTX_COLORS.travel, detail: `${label || 'Your destination'} · ${fmt(d)} m` };
    }
    if (ns && ns.d < 240) return { label: 'Approaching', color: CTX_COLORS.travel, detail: `${ns.station.name}…` };
    const nearbyEnemy = state.world.enemies.find((enemy) => enemy.id === state.nearby.enemyId);
    if (nearbyEnemy) {
      const def = this.app.catalog.enemies[nearbyEnemy.type];
      const tier = nearbyEnemy.tierName ? ` (${nearbyEnemy.tierName})` : '';
      const difficulty = nearbyEnemy.difficulty ? nearbyEnemy.difficulty.label.toLowerCase() : 'unknown';
      return {
        label: 'Hostile in range',
        color: CTX_COLORS.warn,
        detail: `${def ? def.name : 'Enemy'}${tier} · Approx. ${difficulty} — press E to engage`,
      };
    }
    return { label: 'Idle', color: CTX_COLORS.idle, detail: 'Select a destination to fly there' };
  }

  // PRIVATE
  #renderContext() {
    const ctx = this.#getContext();
    const box = document.getElementById('context');
    box.style.setProperty('--ctx-color', ctx.color);
    const label = box.querySelector('.ctx-label');
    const detail = box.querySelector('.ctx-detail');
    if (label.textContent !== ctx.label) label.textContent = ctx.label;
    if (detail.textContent !== ctx.detail) detail.textContent = ctx.detail;
  }
}
