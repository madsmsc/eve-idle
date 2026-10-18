'use strict';

// The hangar / market overlay: cargo, fleet, fitting, skills, factions, drone
// bay, loot, industry, shipyard and killboard. All DOM. Re-rendered wholesale
// whenever a fresh server state arrives.
import { Node } from '../core/node.js';
import { fmt } from '../core/util.js';

const ROMAN = ['—', 'I', 'II', 'III'];

export class HangarNode extends Node {
  refresh() {
    this.renderHangar();
    this.renderCombatLog();
    return this;
  }
  // TODO: what's up with this repeated refresh pattern?  why isn't an update and render method enough?
  // TODO: also, i dont see an update or render method here - most of the classes aren't even using the node inheritance pattern...

  renderHangar() {
    const state = this.app.state;
    const catalog = this.app.catalog;
    const docked = !!state.docked;

    const cargo = document.getElementById('hangar-cargo');
    cargo.innerHTML = '';
    if (!docked) {
      const note = document.createElement('div');
      note.className = 'row';
      note.innerHTML = '<span class="sub">Dock at a station to trade.</span>';
      cargo.appendChild(note);
    } else {
      const dump = document.createElement('div');
      dump.className = 'row';
      dump.innerHTML = `
        <span class="label">Cargo hold <span class="sub">${fmt(state.cargoUsed)}/${fmt(state.cargoCapacity)}</span></span>
        <span class="actions"><button class="mini" data-action="sell-all" data-testid="sell-all" ${state.cargoUsed > 0 ? '' : 'disabled'}>Sell all</button></span>`;
      cargo.appendChild(dump);
    }
    for (const key of Object.keys(catalog.minerals)) {
      const def = catalog.minerals[key];
      const amt = state.minerals[key];
      const price = (state.world && state.world.prices && state.world.prices[key]) || def.price;
      const row = document.createElement('div');
      row.className = 'row';
      row.innerHTML = `
        <span class="label"><span class="dot" style="width:9px;height:9px;border-radius:50%;background:${def.color};display:inline-block"></span>${def.name} <span class="sub">${fmt(amt)} · ${price} ISK/u</span></span>
        <span class="actions">
          <button class="mini" data-action="sell-mineral" data-mineral="${key}" data-amount="100" data-testid="sell-${key}-100" ${docked ? '' : 'disabled'}>Sell 100</button>
          <button class="mini" data-action="sell-mineral" data-mineral="${key}" data-amount="all" data-testid="sell-${key}-all" ${docked ? '' : 'disabled'}>All</button>
        </span>`;
      cargo.appendChild(row);
    }

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
        <span class="label">${s.name} <span class="sub">Lv${s.level} · ⛏${s.mining.toFixed(0)}/s · ⚔${s.combat.toFixed(0)}${isActive ? ' · active' : ''}${inCombat ? ' · in combat' : ''}</span></span>
        <span class="actions">
          <button class="mini" data-action="set-active" data-id="${s.id}" data-testid="ship-${s.id}-active" ${isActive ? 'disabled' : ''}>Active</button>
          <button class="mini" data-action="upgrade" data-id="${s.id}" data-testid="ship-${s.id}-upgrade" ${inCombat ? 'disabled' : ''}>Up ${fmt(s.upgradeCost)}</button>
          <button class="mini danger" data-action="sell-ship" data-id="${s.id}" data-testid="ship-${s.id}-sell" ${inCombat ? 'disabled' : ''}>Sell ${fmt(s.sellValue)}</button>
        </span>`;
      fleet.appendChild(row);
    }

    const fitting = document.getElementById('hangar-fitting');
    fitting.innerHTML = '';
    const activeShip = state.activeShip;
    if (!activeShip) {
      fitting.innerHTML = '<div class="row"><span class="sub">No active ship.</span></div>';
    } else {
      const stats = document.createElement('div');
      stats.className = 'row fitting-stats';
      stats.innerHTML = `<span class="label">${activeShip.name} <span class="sub">⚔${Math.round(activeShip.dps)} · 🛡${Math.round(activeShip.shield)} · 🧱${Math.round(activeShip.hull)} · ⛏${activeShip.mining.toFixed(1)}/s · 📦${Math.round(activeShip.cargo)}</span></span>`;
      fitting.appendChild(stats);
      for (const slotType of Object.keys(catalog.modules)) {
        const mod = catalog.modules[slotType];
        const slotCount = activeShip.slots[slotType] || 0;
        if (!slotCount) continue;
        const tiers = activeShip.fitting[slotType] || [];
        for (let i = 0; i < slotCount; i++) {
          const current = tiers[i] || 0;
          const btns = [0, 1, 2, 3].map((t) => {
            const active = current === t ? ' active' : '';
            return `<button class="mini fit-btn${active}" data-action="fit-module" data-ship="${activeShip.id}" data-slot="${slotType}" data-index="${i}" data-tier="${t}" data-testid="fit-${slotType}-${i}-t${t}">${ROMAN[t]}</button>`;
          }).join('');
          const row = document.createElement('div');
          row.className = 'row';
          row.innerHTML = `<span class="label">${mod.name} <span class="sub">slot ${i + 1}</span></span><span class="actions">${btns}</span>`;
          fitting.appendChild(row);
        }
      }
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

    const lootEl = document.getElementById('hangar-loot');
    lootEl.innerHTML = '';
    const loot = state.loot || [];
    if (!loot.length) {
      const note = document.createElement('div');
      note.className = 'row';
      note.innerHTML = '<span class="sub">Destroy rats to loot modules.</span>';
      lootEl.appendChild(note);
    }
    for (const l of loot) {
      const row = document.createElement('div');
      row.className = 'row';
      row.innerHTML = `
        <span class="label">${l.name} <span class="sub">Tier ${ROMAN[l.tier] || l.tier}</span></span>
        <span class="actions"><button class="mini" data-action="equip-loot" data-loot="${l.id}" data-testid="equip-loot-${l.id}">Equip</button></span>`;
      lootEl.appendChild(row);
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
