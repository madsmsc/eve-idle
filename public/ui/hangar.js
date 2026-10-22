'use strict';

// The hangar / market overlay: fleet, skills, factions, drone bay, industry,
// shipyard and killboard. Its DOM is rebuilt when the
// overlay opens or when state changes while it is open.
import { Node } from '../core/node.js';
import { fmt } from '../core/util.js';

const ROMAN = ['—', 'I', 'II', 'III', 'IV'];

export class HangarNode extends Node {
  refresh() {
    this.renderHangar();
    this.renderCombatLog();
    return this;
  }
  // Display one station service selected from the persistent menu rail.
  showService(name) {
    const hangar = document.getElementById('hangar');
    hangar.querySelectorAll('.hangar-body section[data-panel]').forEach((section) => {
      section.classList.toggle('active', section.dataset.panel === name);
    });
  }
  renderHangar() {
    const state = this.app.state;
    const catalog = this.app.catalog;
    const docked = !!state.docked;

    const fleet = document.getElementById('hangar-fleet');
    fleet.innerHTML = '';
    if (!state.ships.length) {
      fleet.innerHTML = '<div class="row"><span class="sub">No ships in fleet.</span></div>';
    }
    for (const s of state.ships) {
      const isActive = state.activeShipId === s.id;
      const inCombat = state.combat && state.combat.shipId === s.id;
      const row = document.createElement('div');
      row.className = 'row' + (isActive ? ' active' : '');
      row.innerHTML = `
        <span class="label">${s.name} <span class="sub">⛏${s.mining.toFixed(0)}/s · ⚔${s.combat.toFixed(0)}${isActive ? ' · active' : ''}${inCombat ? ' · in combat' : ''}</span></span>
        <span class="actions">
          <button class="mini" data-action="set-active" data-id="${s.id}" data-testid="ship-${s.id}-active" ${isActive ? 'disabled' : ''}>Active</button>
          <button class="mini danger" data-action="sell-ship" data-id="${s.id}" data-testid="ship-${s.id}-sell" ${inCombat ? 'disabled' : ''}>Sell ${fmt(s.sellValue)}</button>
        </span>`;
      fleet.appendChild(row);
    }

    const skills = document.getElementById('hangar-skills');
    const spLabel = document.getElementById('hangar-sp');
    skills.innerHTML = '';
    spLabel.textContent = `${Math.floor(state.skillPoints || 0)} SP`;
    const categories = {};
    for (const key of Object.keys(catalog.skills)) {
      const def = catalog.skills[key];
      (categories[def.category] = categories[def.category] || []).push(def);
    }
    for (const cat of Object.keys(categories)) {
      const head = document.createElement('div');
      head.className = 'skill-cat';
      head.textContent = cat;
      skills.appendChild(head);
      for (const def of categories[cat]) {
        const lvl = (state.skills && state.skills[def.key]) || 0;
        const maxed = lvl >= def.maxLevel;
        const cost = maxed ? 0 : Math.round(def.baseCost * Math.pow(def.costGrowth, lvl));
        const affordable = !maxed && (state.skillPoints || 0) >= cost;
        const row = document.createElement('div');
        row.className = 'row';
        row.innerHTML = `
          <span class="label">${def.name} <span class="sub">Lv${lvl}/${def.maxLevel} · +${Math.round(def.effect.pctPerLevel * 100)}% ${def.effect.stat}/lv</span></span>
          <span class="actions"><button class="mini" data-action="train-skill" data-skill="${def.key}" data-testid="skill-${def.key}" ${maxed || !affordable ? 'disabled' : ''}>${maxed ? 'Max' : `Train ${fmt(cost)} SP`}</button></span>`;
        skills.appendChild(row);
      }
    }

    const achievementsEl = document.getElementById('hangar-achievements');
    achievementsEl.innerHTML = '';
    for (const achievement of state.achievements || []) {
      const row = document.createElement('div');
      row.className = `row${achievement.unlocked ? ' active' : ''}`;
      row.textContent = `${achievement.unlocked ? '✓' : '○'} ${achievement.name} — ${achievement.description} (${fmt(achievement.progress)}/${fmt(achievement.target)})`;
      achievementsEl.appendChild(row);
    }

    const agentPanel = document.getElementById('hangar-agent-missions');
    const cooldown = document.getElementById('agent-mission-cooldown');
    agentPanel.innerHTML = '';
    const agent = state.agentMission;
    if (agent.active) {
      const row = document.createElement('div');
      row.className = 'row';
      row.innerHTML = `<span class="label">${agent.active.name} <span class="sub">${agent.active.objective} · ${fmt(agent.active.progress)}/${fmt(agent.active.target)} · reward ${fmt(agent.active.reward)} ISK</span></span><span class="actions"><button class="mini danger" data-action="cancel-agent-mission">Cancel</button></span>`;
      agentPanel.appendChild(row);
    } else if (agent.available) {
      const offers = this.app.catalog.agentMissions;
      const offer = offers[Math.floor(Date.now() / 86400000) % offers.length];
      const row = document.createElement('div');
      row.className = 'row';
      row.innerHTML = `<span class="label">${offer.name} <span class="sub">${offer.objective} · reward ${fmt(offer.reward)} ISK</span></span><span class="actions"><button class="mini" data-action="accept-agent-mission" data-testid="accept-agent-mission">Accept</button></span>`;
      agentPanel.appendChild(row);
      cooldown.textContent = 'available';
    } else {
      const remaining = Math.max(0, agent.availableAt - Date.now());
      cooldown.textContent = `${Math.ceil(remaining / 3600000)}h`;
      const note = document.createElement('div');
      note.className = 'row';
      note.textContent = agent.completed ? `${agent.completed} complete — next contract in ${cooldown.textContent}.` : `Next contract in ${cooldown.textContent}.`;
      agentPanel.appendChild(note);
    }
    if (agent.active) cooldown.textContent = 'in progress';

    const factions = document.getElementById('hangar-factions');
    factions.innerHTML = '';
    for (const f of state.factions || []) {
      const st = f.standing;
      const sign = st > 0 ? '+' : '';
      const sysId = catalog.factions && catalog.factions[f.key] ? catalog.factions[f.key].systemId : null;
      const chance = sysId && state.ambush ? state.ambush[sysId] : null;
      const risk = chance != null ? ` · ${Math.round(chance * 100)}% ambush` : '';
      const row = document.createElement('div');
      row.className = 'row';
      row.innerHTML = `<span class="label">${f.name} <span class="sub">${sign}${st.toFixed(1)}${risk}</span></span>`;
      factions.appendChild(row);
    }

    const droneBay = document.getElementById('hangar-drones');
    const droneCount = document.getElementById('drone-bay-count');
    droneBay.innerHTML = '';
    const ownedDrones = state.drones || { mining: [], combat: [] };
    const totalDrones = ownedDrones.mining.length + ownedDrones.combat.length;
    droneCount.textContent = totalDrones ? `${totalDrones} owned` : '';
    if (!docked) {
      const note = document.createElement('div');
      note.className = 'row';
      note.innerHTML = '<span class="sub">Dock at a station to buy drones.</span>';
      droneBay.appendChild(note);
    }
    for (const type of Object.keys(catalog.drones)) {
      const def = catalog.drones[type];
      const count = (ownedDrones[type] || []).length;
      const bonus = state.droneBonuses[def.stat] || 0;
      const head = document.createElement('div');
      head.className = 'skill-cat';
      head.textContent = `${def.name} — ${count}/${this.app.constants.droneMaxPerType} · +${bonus} ${def.stat}`;
      droneBay.appendChild(head);
      for (const t of def.tiers) {
        const atCap = count >= this.app.constants.droneMaxPerType;
        const row = document.createElement('div');
        row.className = 'row';
        row.innerHTML = `
          <span class="label">Tier ${ROMAN[t.tier]} <span class="sub">+${t.bonus} ${def.stat}</span></span>
          <span class="actions"><button class="mini" data-action="buy-drone" data-type="${type}" data-tier="${t.tier}" data-testid="buy-drone-${type}-t${t.tier}" ${docked && !atCap ? '' : 'disabled'}>${fmt(t.cost)} ISK</button></span>`;
        droneBay.appendChild(row);
      }
    }

    const industry = document.getElementById('hangar-industry');
    industry.innerHTML = '';
    const minerals = state.minerals || {};
    if (!docked) {
      const note = document.createElement('div');
      note.className = 'row';
      note.innerHTML = '<span class="sub">Dock at a station to craft.</span>';
      industry.appendChild(note);
    }
    for (const slotType of Object.keys(catalog.blueprints)) {
      for (const tier of Object.keys(catalog.blueprints[slotType])) {
        const bp = catalog.blueprints[slotType][tier];
        const recipe = Object.keys(bp.recipe)
          .filter((k) => bp.recipe[k] > 0)
          .map((k) => `${bp.recipe[k]} ${catalog.minerals[k].name}`)
          .join(' + ');
        const have = Object.keys(bp.recipe).every((k) => (minerals[k] || 0) >= bp.recipe[k]);
        const row = document.createElement('div');
        row.className = 'row';
        row.innerHTML = `
          <span class="label">${bp.name} <span class="sub">${recipe}</span></span>
          <span class="actions"><button class="mini" data-action="craft-module" data-slot="${bp.slotType}" data-tier="${bp.tier}" data-testid="craft-${slotType}-t${bp.tier}" ${docked && have ? '' : 'disabled'}>Craft</button></span>`;
        industry.appendChild(row);
      }
    }
    for (const [type, blueprint] of Object.entries(catalog.shipBlueprints || {})) {
      const recipe = Object.entries(blueprint.recipe)
        .map(([key, amount]) => `${amount} ${catalog.minerals[key].name}`)
        .join(' + ');
      const have = Object.entries(blueprint.recipe).every(([key, amount]) => (minerals[key] || 0) >= amount);
      const row = document.createElement('div');
      row.className = 'row';
      row.innerHTML = `
        <span class="label">${blueprint.name} Blueprint <span class="sub">${recipe}</span></span>
        <span class="actions"><button class="mini" data-action="craft-ship" data-type="${type}" data-testid="craft-ship-${type}" ${docked && have ? '' : 'disabled'}>Build</button></span>`;
      industry.appendChild(row);
    }

    const shop = document.getElementById('hangar-shop');
    shop.innerHTML = '';
    if (!docked) {
      const note = document.createElement('div');
      note.className = 'row';
      note.innerHTML = '<span class="sub">Dock at a station to buy ships.</span>';
      shop.appendChild(note);
    }
    for (const key of Object.keys(catalog.ships)) {
      const def = catalog.ships[key];
      const row = document.createElement('div');
      row.className = 'row';
      row.innerHTML = `
        <span class="label">${def.name} <span class="sub">⛏${def.mining}/s · ⚔${def.combat}</span></span>
        <span class="actions"><button class="mini" data-action="buy-ship" data-type="${key}" data-testid="buy-${key}" ${docked ? '' : 'disabled'}>${def.cost ? fmt(def.cost) + ' ISK' : 'Free'}</button></span>`;
      shop.appendChild(row);
    }
  }

  renderCombatLog() {
    const log = document.getElementById('combat-log');
    log.innerHTML = '';
    if (!this.app.state.combatLog.length) {
      log.innerHTML = '<li class="empty">No battles yet.</li>';
      return;
    }
    for (const e of this.app.state.combatLog) {
      const li = document.createElement('li');
      li.className = e.won ? 'win' : 'lose';
      const tag = e.won ? '<span class="win-tag">VICTORY</span>' : '<span class="lose-tag">DEFEAT</span>';
      const sysName = e.system ? ` · ${e.system}` : '';
      let loot;
      if (e.won) {
        loot = `+${fmt(e.isk)} ISK`;
        if (e.loot && this.app.catalog.modules[e.loot.slotType]) {
          loot += ` · loot: ${this.app.catalog.modules[e.loot.slotType].name} ${ROMAN[e.loot.tier] || ''}`;
        }
      } else if (e.shipLost) {
        const parts = ['ship lost'];
        if (e.cargoLost > 0) parts.push(`${e.cargoLost} cargo`);
        if (e.insurance > 0) parts.push(`+${fmt(e.insurance)} insurance`);
        loot = parts.join(' · ');
      } else {
        loot = 'disengaged';
      }
      li.innerHTML = `${tag} ${e.ship} vs ${e.enemy}${sysName} — ${loot}`;
      log.appendChild(li);
    }
  }
}
