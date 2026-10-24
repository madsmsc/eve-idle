'use strict';

// The hangar / market overlay: fleet, skills, barter, industry,
// shipyard and killboard. Its DOM is rebuilt when the
// overlay opens or when state changes while it is open.
import { Node } from '../core/node.js';
import { fmt } from '../core/util.js';

const ROMAN = ['—', 'I', 'II', 'III', 'IV'];

function itemName(catalog, key) {
  return (catalog.minerals[key] || catalog.components[key] || {}).name || key;
}

function recipeText(recipe, catalog) {
  return Object.entries(recipe).map(([key, amount]) => `${fmt(amount)} ${itemName(catalog, key)}`).join(' + ');
}

function recipeProgressText(recipe, state, catalog) {
  return Object.entries(recipe).map(([key, amount]) =>
    `${fmt(materialCount(state, key))}/${fmt(amount)} ${itemName(catalog, key)}`
  ).join(' · ');
}

function materialCount(state, key) {
  return ((state.materials && state.materials[key]) || 0) +
    ((state.storage && state.storage.items && state.storage.items[key]) || 0);
}

function canPay(state, recipe) {
  return Object.entries(recipe).every(([key, amount]) => materialCount(state, key) >= amount);
}

function ownsBlueprint(state, kind, type, tier = null) {
  return (state.blueprints || []).some((item) =>
    item.kind === kind && item.type === type && (kind !== 'module' || item.tier === Number(tier))
  );
}

export class HangarNode extends Node {
  refresh() {
    this.renderHangar();
    this.renderCombatLog();
    this.app.ui.inventory.renderStorage();
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
        </span>`;
      fleet.appendChild(row);
    }

    const skills = document.getElementById('hangar-skills');
    const spLabel = document.getElementById('hangar-sp');
    skills.innerHTML = '';
    spLabel.textContent = `${Math.floor(state.skillPoints || 0)} SP · ${state.skillPointRate} SP/s, offline`;
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
      row.innerHTML = `<span class="label">${agent.active.name} <span class="sub">${agent.active.objective} · ${fmt(agent.active.progress)}/${fmt(agent.active.target)} · reward ${recipeText(agent.active.rewardItems || {}, catalog)}</span></span><span class="actions"><button class="mini danger" data-action="cancel-agent-mission">Cancel</button></span>`;
      agentPanel.appendChild(row);
    } else if (agent.available) {
      const offers = this.app.catalog.agentMissions;
      const offer = offers[Math.floor(Date.now() / 86400000) % offers.length];
      const row = document.createElement('div');
      row.className = 'row';
      row.innerHTML = `<span class="label">${offer.name} <span class="sub">${offer.objective} · reward ${recipeText(offer.rewardItems || {}, catalog)}</span></span><span class="actions"><button class="mini" data-action="accept-agent-mission" data-testid="accept-agent-mission">Accept</button></span>`;
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

    const industry = document.getElementById('hangar-industry');
    industry.innerHTML = '';
    if (!docked) {
      const note = document.createElement('div');
      note.className = 'row';
      note.innerHTML = '<span class="sub">Dock at a station to manufacture. Blueprints are consumed when used.</span>';
      industry.appendChild(note);
    }
    for (const slotType of Object.keys(catalog.blueprints)) {
      for (const tier of Object.keys(catalog.blueprints[slotType])) {
        const bp = catalog.blueprints[slotType][tier];
        const recipe = recipeText(bp.recipe, catalog);
        const have = canPay(state, bp.recipe);
        const hasBlueprint = ownsBlueprint(state, 'module', slotType, bp.tier);
        const row = document.createElement('div');
        row.className = 'row';
        row.innerHTML = `
          <span class="label">${bp.name} <span class="sub">${recipe} · ${hasBlueprint ? 'blueprint ready' : 'blueprint required'}</span></span>
          <span class="actions"><button class="mini" data-action="craft-module" data-slot="${bp.slotType}" data-tier="${bp.tier}" data-testid="craft-${slotType}-t${bp.tier}" ${docked && have && hasBlueprint ? '' : 'disabled'}>Craft</button></span>`;
        industry.appendChild(row);
      }
    }

    const shop = document.getElementById('hangar-shop');
    shop.innerHTML = '';
    if (!docked) {
      const note = document.createElement('div');
      note.className = 'row';
      note.innerHTML = '<span class="sub">Ship blueprints drop as rat loot. Skills and materials are required to build each hull.</span>';
      shop.appendChild(note);
    }
    shop.insertAdjacentHTML('beforeend', '<p class="sub">Ship progression — requirements are checked against your skills and shared/cargo materials.</p>');
    for (const tier of catalog.shipProgression || []) {
      const header = document.createElement('div');
      header.className = 'skill-cat';
      header.textContent = `Tier ${tier.tier}`;
      shop.appendChild(header);
      for (const entry of tier.ships) {
        const type = entry.type;
        const blueprint = catalog.shipBlueprints[type];
        const skillRequirements = entry.skills.map((requirement) => {
          const skill = catalog.skills[requirement.skill];
          const level = (state.skills && state.skills[requirement.skill]) || 0;
          return `${skill.name} ${level}/${requirement.level}${level < requirement.level ? ' (missing)' : ''}`;
        });
        const skillsReady = entry.skills.every((requirement) =>
          ((state.skills && state.skills[requirement.skill]) || 0) >= requirement.level
        );
        const hasBlueprint = type === 'rifter' || ownsBlueprint(state, 'ship', type);
        const materialReady = !blueprint || canPay(state, blueprint.recipe);
        const ownedCount = state.ships.filter((ship) => ship.type === type).length;
        const row = document.createElement('div');
        row.className = 'row ship-tree-row';
        const requirements = [
          skillRequirements.length ? `Skills: ${skillRequirements.join(', ')}` : 'No skill prerequisite',
          blueprint ? `Materials: ${recipeProgressText(blueprint.recipe, state, catalog)}` : 'Starter hull',
          type === 'rifter' ? 'Starter ship' : hasBlueprint ? 'Blueprint acquired' : 'Blueprint: rat loot',
          ownedCount ? `Owned: ${ownedCount}` : '',
        ].filter(Boolean).join(' · ');
        const action = type === 'rifter'
          ? '<span class="sub">Starting hull</span>'
          : `<button class="mini" data-action="craft-ship" data-type="${type}" data-testid="craft-ship-${type}" ${docked && skillsReady && materialReady && hasBlueprint ? '' : 'disabled'}>Build</button>`;
        row.innerHTML = `
          <span class="label">${catalog.ships[type].name} <span class="sub">${requirements}</span></span>
          <span class="actions">${action}</span>`;
        shop.appendChild(row);
      }
    }

    const market = document.getElementById('hangar-market');
    market.innerHTML = '';
    const exchangeFamilies = [
      ['ore', catalog.oreExchange, catalog.minerals],
      ['components', catalog.componentExchange, catalog.components],
    ];
    for (const [family, ladder, definitions] of exchangeFamilies) {
      const header = document.createElement('div');
      header.className = 'row';
      header.textContent = family === 'ore' ? 'Ore exchange — 3 lower tier → 1 higher tier' : 'Component exchange — 3 lower tier → 1 higher tier';
      market.appendChild(header);
      for (let index = 0; index < ladder.length - 1; index++) {
        const item = ladder[index];
        const next = ladder[index + 1];
        const row = document.createElement('div');
        row.className = 'row';
        row.innerHTML = `<span class="label">${definitions[item].name} → ${definitions[next].name} <span class="sub">Have ${fmt(materialCount(state, item))}</span></span><span class="actions"><button class="mini" data-action="exchange-items" data-family="${family}" data-item="${item}" data-amount="3" data-testid="exchange-${family}-${item}" ${docked && materialCount(state, item) >= 3 ? '' : 'disabled'}>3 to 1</button></span>`;
        market.appendChild(row);
      }
    }
    const blueprintHeader = document.createElement('div');
    blueprintHeader.className = 'row';
    blueprintHeader.textContent = 'NPC blueprints — available at any station; each is consumed during manufacturing';
    market.appendChild(blueprintHeader);
    for (const key of catalog.npcBlueprints || []) {
      const [, slotType, tierText] = key.split(':');
      const tier = Number(tierText);
      const def = catalog.modules[slotType];
      const cost = catalog.blueprintCosts[key];
      const row = document.createElement('div');
      row.className = 'row';
      row.innerHTML = `<span class="label">${def.name} ${ROMAN[tier]} Blueprint <span class="sub">${recipeText(cost, catalog)}</span></span><span class="actions"><button class="mini" data-action="buy-blueprint" data-kind="module" data-type="${slotType}" data-tier="${tier}" data-testid="buy-blueprint-${slotType}-t${tier}" ${docked && canPay(state, cost) ? '' : 'disabled'}>Buy blueprint</button></span>`;
      market.appendChild(row);
    }
    const dropNote = document.createElement('div');
    dropNote.className = 'row';
    dropNote.textContent = 'Higher-tier module and ship blueprints are recovered from rat loot; NPCs do not sell them.';
    market.appendChild(dropNote);
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
        loot = `+${fmt(e.scrap || 0)} Scrap`;
        if (e.loot && this.app.catalog.modules[e.loot.slotType]) {
          loot += ` · loot: ${this.app.catalog.modules[e.loot.slotType].name} ${ROMAN[e.loot.tier] || ''}`;
        }
        if (e.blueprint) {
          if (e.blueprint.kind === 'module') {
            const module = this.app.catalog.modules[e.blueprint.type];
            loot += ` · blueprint: ${module ? module.name : e.blueprint.type} T${e.blueprint.tier}`;
          } else {
            const ship = this.app.catalog.ships[e.blueprint.type];
            loot += ` · blueprint: ${ship ? ship.name : e.blueprint.type} ship`;
          }
        }
      } else if (e.shipLost) {
        const parts = ['ship lost'];
        if (e.cargoLost > 0) parts.push(`${e.cargoLost} cargo`);
        loot = parts.join(' · ');
      } else {
        loot = 'disengaged';
      }
      li.innerHTML = `${tag} ${e.ship} vs ${e.enemy}${sysName} — ${loot}`;
      log.appendChild(li);
    }
  }
}
