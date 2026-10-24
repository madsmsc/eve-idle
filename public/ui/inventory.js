'use strict';

// Cargo, fitting, and shared Quantum Storage menu content.
// DOM is rebuilt when a menu page opens or state changes while one is active.
import { Node } from '../core/node.js';
import { fmt } from '../core/util.js';

const ROMAN = ['—', 'I', 'II', 'III', 'IV'];
const COLUMNS = 6;
const MIN_CELLS = 24;

export class InventoryNode extends Node {
  constructor(app) {
    super(app);
    this.selected = null;
    this.filter = 'all';
    this.statsTimer = 0;
  }

  refresh() {
    this.renderFitting();
    this.renderCargo();
    this.renderStorage();
    return this;
  }

  update(dt) {
    this.statsTimer -= dt;
    if (this.statsTimer <= 0 && this.app.menuPageOpen && this.app.activeMenu === 'fitting' && this.app.state) {
      this.statsTimer = 0.25;
      this.renderStats();
    }
    return super.update(dt);
  }

  select(key) {
    this.selected = this.selected === key ? null : key;
    this.renderCargo();
  }

  setFilter(filter) {
    if (!['all', 'ore', 'components', 'loot', 'blueprints'].includes(filter)) throw new Error(`Unknown cargo filter: ${filter}`);
    this.filter = filter;
    document.querySelectorAll('[data-cargo-filter]').forEach((button) => {
      button.classList.toggle('active', button.dataset.cargoFilter === filter);
    });
    this.renderCargo();
  }

  renderStats() {
    const { state, player, constants } = this.app;
    const ship = state.activeShip;
    const el = document.getElementById('fit-stats');
    el.innerHTML = '';
    if (!ship) return;
    const shield = state.combat ? state.combat.shipShield : ship.shield;
    const hull = state.combat ? state.combat.shipHull : ship.hull;
    const speed = player ? Math.hypot(player.vx, player.vy) : 0;
    const rows = [
      ['⛏ Mining', `${ship.mining.toFixed(1)}/s`],
      ['⚔ DPS', fmt(ship.dps)],
      ['📦 Cargo', fmt(ship.cargo)],
      ['🚀 Speed', `${Math.round(speed)} / ${constants.maxSpeed} m/s`],
      ['🛡 Shield', `${Math.ceil(shield)} / ${fmt(ship.shield)}`],
      ['🧱 Hull', `${Math.ceil(hull)} / ${fmt(ship.hull)}`],
    ];
    for (const [label, value] of rows) {
      const stat = document.createElement('div');
      stat.className = 'char-stat';
      stat.innerHTML = `<span class="label">${label}</span><span class="value">${value}</span>`;
      el.appendChild(stat);
    }
  }

  renderFitting() {
    const { state, catalog } = this.app;
    const ship = state.activeShip;
    const el = document.getElementById('inv-fitting');
    document.getElementById('inv-ship-name').textContent = ship ? ship.name : '';
    el.innerHTML = '';
    this.renderStats();
    const presetSelect = document.getElementById('fitting-preset-select');
    presetSelect.innerHTML = '<option value="">Saved presets</option>';
    for (const preset of state.fittingPresets || []) {
      const option = document.createElement('option');
      option.value = preset.name;
      option.textContent = `${preset.name} (${catalog.ships[preset.shipType].name})`;
      presetSelect.appendChild(option);
    }
    if (presetSelect.options.length > 1) presetSelect.value = presetSelect.options[1].value;
    document.querySelector('[data-action="save-fitting-preset"]').disabled = !ship;
    document.querySelector('[data-action="apply-fitting-preset"]').disabled = !ship || presetSelect.options.length === 1;
    document.querySelector('[data-action="delete-fitting-preset"]').disabled = !presetSelect.value;
    if (!ship) {
      el.innerHTML = '<div class="row"><span class="sub">No active ship.</span></div>';
      return;
    }
    for (const slotType of Object.keys(catalog.modules)) {
      const count = ship.slots[slotType] || 0;
      const tiers = ship.fitting[slotType] || [];
      for (let i = 0; i < count; i++) {
        const t = tiers[i] || 0;
        const buttons = [0, 1, 2, 3, 4].map((tier) => {
          const label = tier === 4 ? 'Faction' : ROMAN[tier];
          const active = t === tier ? ' active' : '';
          const available = tier === 0 || tier === t || (state.loot || []).some((item) => item.slotType === slotType && item.tier === tier);
          return `<button class="mini fit-btn${active}" data-action="fit-module" data-ship="${ship.id}" data-slot="${slotType}" data-index="${i}" data-tier="${tier}" data-testid="fit-${slotType}-${i}-t${tier}" ${state.docked && available ? '' : 'disabled'}>${label}</button>`;
        }).join('');
        const row = document.createElement('div');
        row.className = 'row';
        row.innerHTML = `<span class="label">${catalog.modules[slotType].name} <span class="sub">slot ${i + 1}</span></span><span class="actions">${buttons}</span>`;
        el.appendChild(row);
      }
    }
  }

  // Material stacks and itemized blueprints share the inventory grid.
  buildCells() {
    const { state, catalog } = this.app;
    const cells = [];
    if (['all', 'ore'].includes(this.filter)) {
      for (const key of Object.keys(catalog.minerals)) {
        const amt = Math.floor(state.materials[key] || 0);
        if (amt > 0) cells.push({ kind: 'material', key, select: `item:${key}`, count: amt });
      }
    }
    if (['all', 'components'].includes(this.filter)) {
      for (const key of Object.keys(catalog.components)) {
        const amt = Math.floor(state.materials[key] || 0);
        if (amt > 0) cells.push({ kind: 'material', key, select: `item:${key}`, count: amt });
      }
    }
    if (['all', 'loot'].includes(this.filter)) {
      for (const l of state.loot || []) {
        cells.push({ kind: 'loot', key: l.id, select: `loot:${l.id}`, loot: l });
      }
    }
    if (['all', 'blueprints'].includes(this.filter)) {
      for (const blueprint of state.blueprints || []) {
        cells.push({ kind: 'blueprint', key: blueprint.id, select: `blueprint:${blueprint.id}`, blueprint });
      }
    }
    const total = Math.max(MIN_CELLS, cells.length);
    return { cells, total: Math.ceil(total / COLUMNS) * COLUMNS };
  }

  renderCargo() {
    const { state, catalog } = this.app;
    const grid = document.getElementById('inv-grid');
    const usage = document.getElementById('inv-cargo-usage');
    usage.textContent = `${fmt(state.cargoUsed)}/${fmt(state.cargoCapacity)}${state.cargoFull ? ' (FULL)' : ''}`;
    const { cells, total } = this.buildCells();
    if (this.selected && !cells.some((c) => c.select === this.selected)) this.selected = null;
    const storeAll = document.querySelector('[data-testid="inv-deposit-all"]');
    storeAll.disabled = !state.docked || state.cargoUsed <= 0;

    grid.innerHTML = '';
    grid.style.gridTemplateColumns = `repeat(${COLUMNS}, 1fr)`;
    for (let i = 0; i < total; i++) {
      const c = cells[i];
      const div = document.createElement('div');
      if (!c) {
        div.className = 'inv-cell empty';
      } else if (c.kind === 'material') {
        const def = catalog.minerals[c.key] || catalog.components[c.key];
        div.className = `inv-cell ${catalog.minerals[c.key] ? 'ore' : 'module'}`;
        if (def.color) div.style.setProperty('--cell-color', def.color);
        div.title = `${def.name} ×${fmt(c.count)}`;
        div.innerHTML = `<span class="cell-name">${def.name.slice(0, 6)}</span><span class="cell-count">${fmt(c.count)}</span>`;
        div.dataset.testid = `inv-cell-${c.key}`;
      } else if (c.kind === 'loot') {
        const l = c.loot;
        const mod = catalog.modules[l.slotType];
        div.className = 'inv-cell module';
        div.title = `${l.name} · Tier ${ROMAN[l.tier] || l.tier}`;
        div.innerHTML = `<span class="cell-name">${(mod ? mod.name : l.slotType).slice(0, 6)}</span><span class="cell-count">${ROMAN[l.tier] || l.tier}</span>`;
        div.dataset.testid = `inv-cell-${l.id}`;
      } else {
        const blueprint = c.blueprint;
        const name = blueprint.kind === 'module'
          ? catalog.blueprints[blueprint.type][blueprint.tier].name
          : catalog.shipBlueprints[blueprint.type].name;
        div.className = 'inv-cell module';
        div.title = `${name} Blueprint`;
        div.innerHTML = `<span class="cell-name">${name.slice(0, 6)}</span><span class="cell-count">BP</span>`;
        div.dataset.testid = `inv-cell-${blueprint.id}`;
      }
      if (c) {
        div.dataset.cell = c.select;
        if (c.select === this.selected) div.classList.add('selected');
      }
      grid.appendChild(div);
    }
    this.renderDetail();
  }

  renderDetail() {
    const { state, catalog } = this.app;
    const docked = !!state.docked;
    const el = document.getElementById('inv-detail');
    el.innerHTML = '';
    const note = (html) => {
      const row = document.createElement('div');
      row.className = 'row';
      row.innerHTML = `<span class="sub">${html}</span>`;
      el.appendChild(row);
    };
    if (!this.selected) {
      note('Select an item to see what you can do with it.');
      return;
    }
    const [kind, id] = this.selected.split(':');
    if (kind === 'item') {
      const def = catalog.minerals[id] || catalog.components[id];
      const amt = (state.materials && state.materials[id]) || 0;
      const row = document.createElement('div');
      row.className = 'row';
      row.innerHTML = `
        <span class="label">${def.name} <span class="sub">${fmt(amt)} in ship cargo</span></span>
        <span class="actions">
          <button class="mini" data-action="deposit" data-mineral="${id}" data-amount="100" data-testid="inv-deposit-${id}-100" ${docked && amt > 0 ? '' : 'disabled'}>Deposit 100</button>
          <button class="mini" data-action="deposit" data-mineral="${id}" data-amount="all" data-testid="inv-deposit-${id}-all" ${docked && amt > 0 ? '' : 'disabled'}>All</button>
        </span>`;
      el.appendChild(row);
      if (!docked) note('Dock at any station to store or exchange materials.');
      return;
    }
    if (kind === 'loot') {
      const loot = (state.loot || []).find((item) => item.id === id);
      if (!loot) return;
      const row = document.createElement('div');
      row.className = 'row';
      row.innerHTML = `
        <span class="label">${loot.name} <span class="sub">Tier ${ROMAN[loot.tier] || loot.tier}</span></span>
        <span class="actions">
          <button class="mini" data-action="equip-loot" data-loot="${loot.id}" data-testid="inv-equip-${loot.id}" ${docked ? '' : 'disabled'}>Equip</button>
          <button class="mini" data-action="refine-loot" data-loot="${loot.id}" data-testid="inv-refine-loot-${loot.id}" ${docked ? '' : 'disabled'}>Salvage</button>
        </span>`;
      el.appendChild(row);
      if (!docked) note('Dock at a station to equip or salvage this module.');
      return;
    }
    if (kind === 'blueprint') {
      const blueprint = (state.blueprints || []).find((item) => item.id === id);
      if (!blueprint) return;
      const action = blueprint.kind === 'module' ? 'craft-module' : 'craft-ship';
      const def = blueprint.kind === 'module'
        ? catalog.blueprints[blueprint.type][blueprint.tier]
        : catalog.shipBlueprints[blueprint.type];
      const recipe = def.recipe;
      const label = blueprint.kind === 'module' ? `${def.name} Blueprint` : `${def.name} Blueprint`;
      const row = document.createElement('div');
      row.className = 'row';
      row.innerHTML = `<span class="label">${label}<span class="sub">Manufacturing: ${Object.entries(recipe).map(([key, amount]) => `${amount} ${(catalog.minerals[key] || catalog.components[key]).name}`).join(' + ')}</span></span><span class="actions"><button class="mini" data-action="${action}" data-slot="${blueprint.type}" data-tier="${blueprint.tier}" data-type="${blueprint.type}" ${docked ? '' : 'disabled'}>Manufacture</button></span>`;
      el.appendChild(row);
      return;
    }
  }

  renderStorage() {
    const state = this.app.state;
    const docked = !!state.docked;
    const el = document.getElementById('inv-storage');
    el.innerHTML = '';
    const stored = (state.storage && state.storage.items) || {};
    const total = Object.values(stored).reduce((a, b) => a + b, 0);
    if (!docked) {
      const note = document.createElement('div');
      note.className = 'row';
      note.innerHTML = '<span class="sub">Quantum storage is shared by every station — dock to withdraw what you have stored.</span>';
      el.appendChild(note);
      return;
    }
    if (total <= 0) {
      const note = document.createElement('div');
      note.className = 'row';
      note.innerHTML = '<span class="sub">Storage is empty. Store ore and components here to keep them safe between trips.</span>';
      el.appendChild(note);
      return;
    }
    const definitions = { ...this.app.catalog.minerals, ...this.app.catalog.components };
    for (const key of Object.keys(definitions)) {
      const def = definitions[key];
      const amt = stored[key] || 0;
      if (amt <= 0) continue;
      const row = document.createElement('div');
      row.className = 'row';
      row.innerHTML = `
        <span class="label">${def.name} <span class="sub">${fmt(amt)}</span></span>
        <span class="actions">
          <button class="mini" data-action="withdraw" data-mineral="${key}" data-amount="100" data-testid="inv-withdraw-${key}-100">Withdraw 100</button>
          <button class="mini" data-action="withdraw" data-mineral="${key}" data-amount="all" data-testid="inv-withdraw-${key}-all">All</button>
        </span>`;
      el.appendChild(row);
    }
  }
}
