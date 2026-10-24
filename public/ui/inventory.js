'use strict';

// Ship fitting, cargo, and shared Quantum Storage menu content.
// DOM is rebuilt when a menu page opens or state changes while one is active.
import { Node } from '../core/node.js';
import { fmt } from '../core/util.js';

const ROMAN = ['—', 'I', 'II', 'III', 'IV'];
const MIN_CELLS = 26;

export function buildInventoryCells(state, catalog, filter) {
  const cells = [];
  if (['all', 'ore'].includes(filter)) {
    for (const key of Object.keys(catalog.minerals)) {
      const amt = Math.floor(state.materials[key] || 0);
      if (amt > 0) cells.push({ kind: 'material', key, select: `item:${key}`, count: amt });
    }
  }
  if (['all', 'components'].includes(filter)) {
    for (const key of Object.keys(catalog.components)) {
      const amt = Math.floor(state.materials[key] || 0);
      if (amt > 0) cells.push({ kind: 'material', key, select: `item:${key}`, count: amt });
    }
  }
  if (['all', 'loot'].includes(filter)) {
    for (const loot of state.loot || []) {
      cells.push({ kind: 'loot', key: loot.id, select: `loot:${loot.id}`, loot });
    }
  }
  if (['all', 'blueprints'].includes(filter)) {
    for (const blueprint of state.blueprints || []) {
      cells.push({ kind: 'blueprint', key: blueprint.id, select: `blueprint:${blueprint.id}`, blueprint });
    }
  }
  return { cells, total: Math.max(MIN_CELLS, cells.length) };
}

export function buildStorageCells(storage, catalog) {
  const cells = [];
  const definitions = { ...catalog.minerals, ...catalog.components };
  for (const key of Object.keys(definitions)) {
    const count = Math.floor((storage.items && storage.items[key]) || 0);
    if (count > 0) cells.push({ kind: 'material', key, select: `storage:item:${key}`, count });
  }
  for (const loot of storage.loot || []) {
    cells.push({ kind: 'loot', key: loot.id, select: `storage:loot:${loot.id}`, loot });
  }
  for (const blueprint of storage.blueprints || []) {
    cells.push({ kind: 'blueprint', key: blueprint.id, select: `storage:blueprint:${blueprint.id}`, blueprint });
  }
  return { cells, total: Math.max(MIN_CELLS, cells.length) };
}

function blueprintDefinition(blueprint, catalog) {
  return blueprint.kind === 'module'
    ? catalog.blueprints[blueprint.type][blueprint.tier]
    : catalog.shipBlueprints[blueprint.type];
}

function blueprintName(blueprint, catalog) {
  return blueprintDefinition(blueprint, catalog).name;
}

function recipeDescription(recipe, catalog) {
  return Object.entries(recipe || {}).map(([key, amount]) => {
    const definition = catalog.minerals[key] || catalog.components[key];
    return `${fmt(amount)} ${definition ? definition.name : key}`;
  }).join(' + ');
}

function itemDescription(cell, catalog, location) {
  const where = location === 'storage' ? 'Quantum Storage' : 'Ship cargo';
  if (cell.kind === 'material') {
    const definition = catalog.minerals[cell.key] || catalog.components[cell.key];
    const category = catalog.minerals[cell.key] ? 'Ore' : 'Component';
    return `${definition.name} · Tier ${definition.tier} ${category} · ${fmt(cell.count)} in ${where}. Used for trade-ups and manufacturing. Select to view transfer options.`;
  }
  if (cell.kind === 'loot') {
    const module = catalog.modules[cell.loot.slotType];
    const tier = module && module.tiers.find((entry) => entry.tier === cell.loot.tier);
    const bonus = tier ? ` · +${fmt(tier.bonus)} ${module.stat}` : '';
    return `${module ? module.name : cell.loot.slotType} · Tier ${ROMAN[cell.loot.tier] || cell.loot.tier} module${bonus} · ${where}. Select to view module actions.`;
  }
  const name = blueprintName(cell.blueprint, catalog);
  const blueprintType = cell.blueprint.kind === 'module' ? 'Module' : 'Ship';
  const recipe = recipeDescription(blueprintDefinition(cell.blueprint, catalog).recipe, catalog);
  return `${name} · ${blueprintType} blueprint · ${where}. Manufacturing requires ${recipe || 'no materials'}. Select to view manufacturing or transfer options.`;
}

export class InventoryNode extends Node {
  // PUBLIC
  constructor(app) {
    super(app);
    this.selected = null;
    this.filter = 'all';
    this.statsTimer = 0;
  }

  // PUBLIC
  refresh() {
    this.#renderFitting();
    this.#renderCargo();
    this.#renderStorage();
    return this;
  }

  // PUBLIC
  update(dt) {
    this.statsTimer -= dt;
    if (this.statsTimer <= 0 && this.app.hangarOpen && this.app.activeMenu === 'fitting' && this.app.state) {
      this.statsTimer = 0.25;
      this.#renderStats();
    }
    return super.update(dt);
  }

  // PUBLIC
  select(key) {
    this.selected = this.selected === key ? null : key;
    if (key.startsWith('storage:') || this.selected && this.selected.startsWith('storage:')) {
      this.#renderStorage();
    } else {
      this.#renderCargo();
    }
  }

  // PUBLIC
  setFilter(filter) {
    if (!['all', 'ore', 'components', 'loot', 'blueprints'].includes(filter)) throw new Error(`Unknown cargo filter: ${filter}`);
    this.filter = filter;
    document.querySelectorAll('[data-cargo-filter]').forEach((button) => {
      button.classList.toggle('active', button.dataset.cargoFilter === filter);
    });
    this.#renderCargo();
  }

  // PUBLIC
  renderFitting() {
    this.#renderFitting();
  }

  // PUBLIC
  renderStorage() {
    this.#renderStorage();
  }

  // PRIVATE
  #renderStats() {
    const { state, constants } = this.app;
    const ship = state.activeShip;
    const el = document.getElementById('fit-stats');
    el.innerHTML = '';
    if (!ship) return;
    const shield = state.combat ? state.combat.shipShield : ship.shield;
    const hull = state.combat ? state.combat.shipHull : ship.hull;
    const speed = ship.speed || 0;
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

  // PRIVATE
  #renderFittingItems() {
    const { state, catalog } = this.app;
    const el = document.getElementById('fitting-items');
    el.innerHTML = '';
    for (const item of state.loot || []) {
      const module = catalog.modules[item.slotType];
      if (!module) continue;
      const availability = state.actionAvailability.loot[item.id];
      const row = document.createElement('div');
      row.className = 'row fitting-item';
      row.title = availability.canEquip
        ? `${module.name} Tier ${ROMAN[item.tier] || item.tier}. Equip it in an open ${module.name.toLowerCase()} slot, or salvage it for components.`
        : `${module.name} Tier ${ROMAN[item.tier] || item.tier}. ${availability.equipReason}`;
      row.innerHTML = `
        <span class="label">${module.name} <span class="sub">Tier ${ROMAN[item.tier] || item.tier}</span></span>
        <span class="actions">
          <button class="mini" data-action="equip-loot" data-loot="${item.id}" data-testid="fitting-equip-${item.id}" title="${availability.canEquip ? 'Equip this module in an open matching slot.' : availability.equipReason}" ${availability.canEquip ? '' : 'disabled'}>Equip</button>
          <button class="mini" data-action="refine-loot" data-loot="${item.id}" data-testid="fitting-salvage-${item.id}" title="Salvage this module into components." ${state.docked ? '' : 'disabled'}>Salvage</button>
        </span>`;
      el.appendChild(row);
    }
    for (const item of (state.storage && state.storage.loot) || []) {
      const module = catalog.modules[item.slotType];
      if (!module) continue;
      const row = document.createElement('div');
      row.className = 'row';
      row.innerHTML = `
        <span class="label">${module.name} <span class="sub">Tier ${ROMAN[item.tier] || item.tier} · Quantum Storage</span></span>
        <span class="actions"><button class="mini" data-action="retrieve-item" data-kind="loot" data-id="${item.id}" data-testid="fitting-retrieve-${item.id}" ${state.docked ? '' : 'disabled'}>Retrieve</button></span>`;
      el.appendChild(row);
    }
    if (!el.childElementCount) {
      const note = document.createElement('p');
      note.className = 'sub';
      note.textContent = 'No modules available. Recover them from rats, or craft modules from blueprints at Industry.';
      el.appendChild(note);
    }
  }

  // PRIVATE
  #renderFitting() {
    const { state, catalog } = this.app;
    const ship = state.activeShip;
    const el = document.getElementById('inv-fitting');
    const totalSlots = ship ? Object.values(ship.slots).reduce((total, count) => total + count, 0) : 0;
    document.getElementById('inv-ship-name').textContent = ship ? `${ship.name} · ${totalSlots} slots` : '';
    el.innerHTML = '';
    this.#renderStats();
    const unequipAll = document.querySelector('[data-action="unequip-all"]');
    const canUnequipAll = state.actionAvailability.canUnequipAll;
    unequipAll.disabled = !canUnequipAll;
    document.getElementById('unequip-all-hint').textContent = canUnequipAll
      ? 'Returns all fitted modules to inventory.'
      : state.actionAvailability.unequipAllReason;
    document.getElementById('loadout-hint').textContent = 'Fitted modules are shown here. Equip available modules below; unequipped modules return to ship inventory.';
    this.#renderFittingItems();
    if (!ship) {
      el.innerHTML = '<div class="row"><span class="sub">No active ship.</span></div>';
      return;
    }
    for (const slotType of Object.keys(catalog.modules)) {
      const count = ship.slots[slotType] || 0;
      const tiers = ship.fitting[slotType] || [];
      if (!count) continue;
      const equippedCount = tiers.slice(0, count).filter((tier) => tier > 0).length;
      const group = document.createElement('section');
      group.className = 'loadout-group';
      group.dataset.slotType = slotType;
      const heading = document.createElement('h4');
      heading.innerHTML = `${catalog.modules[slotType].name}<span class="sub">${equippedCount}/${count} fitted</span>`;
      group.appendChild(heading);
      const slots = document.createElement('div');
      slots.className = 'loadout-slots';
      for (let i = 0; i < count; i++) {
        const t = tiers[i] || 0;
        const card = document.createElement('div');
        card.className = 'loadout-card';
        const slot = document.createElement('div');
        slot.className = 'loadout-slot';
        slot.dataset.testid = `fit-slot-${slotType}-${i}`;
        slot.setAttribute('role', 'group');
        const description = `${catalog.modules[slotType].name} slot ${i + 1}: ${t ? `Tier ${ROMAN[t] || t} fitted` : 'empty'}.`;
        slot.setAttribute('aria-label', description);
        slot.title = description;
        const tierLabel = t ? `Tier ${ROMAN[t] || t}` : 'Empty';
        slot.innerHTML = `<span class="loadout-slot-name">Slot ${i + 1}</span><span class="loadout-slot-tier">${tierLabel}</span>`;
        card.appendChild(slot);
        slots.appendChild(card);
      }
      group.appendChild(slots);
      el.appendChild(group);
    }
  }

  // PRIVATE
  #renderCargo() {
    const { state, catalog } = this.app;
    const grid = document.getElementById('inv-grid');
    const usage = document.getElementById('inv-cargo-usage');
    usage.textContent = `${fmt(state.cargoUsed)}/${fmt(state.cargoCapacity)}${state.cargoFull ? ' (FULL)' : ''}`;
    const capacity = state.cargoCapacity > 0
      ? Math.min(100, (state.cargoUsed / state.cargoCapacity) * 100)
      : 0;
    const capacityBar = document.querySelector('[data-testid="cargo-capacity"]');
    capacityBar.setAttribute('aria-valuenow', String(Math.round(capacity)));
    capacityBar.setAttribute('aria-valuetext', `${fmt(state.cargoUsed)} of ${fmt(state.cargoCapacity)} cargo space used`);
    document.getElementById('inv-cargo-capacity-fill').style.width = `${capacity}%`;
    const { cells, total } = buildInventoryCells(state, catalog, this.filter);
    if (this.selected && !this.selected.startsWith('storage:') && !cells.some((c) => c.select === this.selected)) this.selected = null;
    const storeFiltered = document.querySelector('[data-testid="inv-deposit-filtered"]');
    storeFiltered.disabled = !state.docked || cells.length === 0;

    grid.innerHTML = '';
    for (let i = 0; i < total; i++) {
      const c = cells[i];
      const div = document.createElement('div');
      if (!c) {
        div.className = 'inv-cell empty';
      } else if (c.kind === 'material') {
        const def = catalog.minerals[c.key] || catalog.components[c.key];
        div.className = `inv-cell ${catalog.minerals[c.key] ? 'ore' : 'module'}`;
        if (def.color) div.style.setProperty('--cell-color', def.color);
        div.title = itemDescription(c, catalog, 'cargo');
        div.setAttribute('aria-label', div.title);
        div.innerHTML = `<span class="cell-name">${def.name.slice(0, 6)}</span><span class="cell-count">${fmt(c.count)}</span>`;
        div.dataset.testid = `inv-cell-${c.key}`;
      } else if (c.kind === 'loot') {
        const l = c.loot;
        const mod = catalog.modules[l.slotType];
        div.className = 'inv-cell module';
        div.title = itemDescription(c, catalog, 'cargo');
        div.setAttribute('aria-label', div.title);
        div.innerHTML = `<span class="cell-name">${(mod ? mod.name : l.slotType).slice(0, 6)}</span><span class="cell-count">${ROMAN[l.tier] || l.tier}</span>`;
        div.dataset.testid = `inv-cell-${l.id}`;
      } else {
        const blueprint = c.blueprint;
        const name = blueprintName(blueprint, catalog);
        div.className = 'inv-cell module';
        div.title = itemDescription(c, catalog, 'cargo');
        div.setAttribute('aria-label', div.title);
        div.innerHTML = `<span class="cell-name">${name.slice(0, 6)}</span><span class="cell-count">BP</span>`;
        div.dataset.testid = `inv-cell-${blueprint.id}`;
      }
      if (c) {
        div.dataset.cell = c.select;
        if (c.select === this.selected) div.classList.add('selected');
      }
      grid.appendChild(div);
    }
    this.#renderDetail();
  }

  // PRIVATE
  #renderDetail() {
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
      const deposit = state.actionAvailability.deposit[id];
      const row = document.createElement('div');
      row.className = 'row';
      row.innerHTML = `
        <span class="label">${def.name} <span class="sub">${fmt(amt)} in ship cargo</span></span>
        <span class="actions">
          <button class="mini" data-action="deposit" data-mineral="${id}" data-amount="100" data-testid="inv-deposit-${id}-100" ${deposit.canDeposit100 ? '' : 'disabled'}>Deposit 100</button>
          <button class="mini" data-action="deposit" data-mineral="${id}" data-amount="all" data-testid="inv-deposit-${id}-all" ${deposit.canDepositAll ? '' : 'disabled'}>All</button>
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
          <button class="mini" data-action="store-item" data-kind="loot" data-id="${loot.id}" data-testid="inv-store-loot-${loot.id}" ${docked ? '' : 'disabled'}>Store</button>
          <button class="mini" data-action="refine-loot" data-loot="${loot.id}" data-testid="inv-refine-loot-${loot.id}" ${docked ? '' : 'disabled'}>Salvage</button>
        </span>`;
      el.appendChild(row);
      if (!docked) note('Dock at any station to store modules.');
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
      row.innerHTML = `<span class="label">${label}<span class="sub">Manufacturing: ${Object.entries(recipe).map(([key, amount]) => `${amount} ${(catalog.minerals[key] || catalog.components[key]).name}`).join(' + ')}</span></span><span class="actions"><button class="mini" data-action="${action}" data-slot="${blueprint.type}" data-tier="${blueprint.tier}" data-type="${blueprint.type}" ${docked ? '' : 'disabled'}>Manufacture</button><button class="mini" data-action="store-item" data-kind="blueprints" data-id="${blueprint.id}" data-testid="inv-store-blueprint-${blueprint.id}" ${docked ? '' : 'disabled'}>Store</button></span>`;
      el.appendChild(row);
      return;
    }
  }

  // PRIVATE
  #renderStorage() {
    const state = this.app.state;
    const docked = !!state.docked;
    const storage = state.storage || {};
    const grid = document.getElementById('inv-storage-grid');
    const detail = document.getElementById('inv-storage-detail');
    grid.innerHTML = '';
    detail.innerHTML = '';
    if (!docked) {
      this.#appendStorageNote(detail, 'Dock at any station to access your shared Quantum Storage.');
      return;
    }
    const { cells, total } = buildStorageCells(storage, this.app.catalog);
    if (this.selected && !cells.some((cell) => cell.select === this.selected)) this.selected = null;
    if (!cells.length) {
      this.#appendStorageNote(detail, 'Storage is empty. Store materials, modules, and blueprints here to keep them safe between trips.');
      return;
    }
    for (let i = 0; i < total; i++) {
      const cell = cells[i];
      const tile = document.createElement('div');
      tile.className = cell ? `inv-cell ${cell.kind === 'material' ? (this.app.catalog.minerals[cell.key] ? 'ore' : 'module') : 'module'}` : 'inv-cell empty';
      if (cell) {
        tile.title = itemDescription(cell, this.app.catalog, 'storage');
        tile.setAttribute('aria-label', tile.title);
        tile.dataset.cell = cell.select;
        tile.dataset.testid = `inv-storage-cell-${cell.key}`;
        if (cell.kind === 'material') {
          const definition = this.app.catalog.minerals[cell.key] || this.app.catalog.components[cell.key];
          if (definition.color) tile.style.setProperty('--cell-color', definition.color);
          tile.innerHTML = `<span class="cell-name">${definition.name.slice(0, 6)}</span><span class="cell-count">${fmt(cell.count)}</span>`;
        } else if (cell.kind === 'loot') {
          const module = this.app.catalog.modules[cell.loot.slotType];
          tile.innerHTML = `<span class="cell-name">${(module ? module.name : cell.loot.slotType).slice(0, 6)}</span><span class="cell-count">${ROMAN[cell.loot.tier] || cell.loot.tier}</span>`;
        } else {
          const name = blueprintName(cell.blueprint, this.app.catalog);
          tile.innerHTML = `<span class="cell-name">${name.slice(0, 6)}</span><span class="cell-count">BP</span>`;
        }
        if (cell.select === this.selected) tile.classList.add('selected');
      }
      grid.appendChild(tile);
    }
    this.#renderStorageDetail(cells.find((cell) => cell.select === this.selected));
  }

  // PRIVATE
  #appendStorageNote(container, text) {
    const note = document.createElement('div');
    note.className = 'row';
    note.textContent = text;
    container.appendChild(note);
  }

  // PRIVATE
  #renderStorageDetail(cell) {
    const { state, catalog } = this.app;
    const el = document.getElementById('inv-storage-detail');
    if (!cell) {
      this.#appendStorageNote(el, 'Select an item to see its details and retrieve it to your ship.');
      return;
    }
    const row = document.createElement('div');
    row.className = 'row storage-item-detail';
    row.title = itemDescription(cell, catalog, 'storage');
    const actions = document.createElement('span');
    actions.className = 'actions';
    if (cell.kind === 'material') {
      const definition = catalog.minerals[cell.key] || catalog.components[cell.key];
      row.innerHTML = `<span class="label">${definition.name} <span class="sub">${fmt(cell.count)} in storage</span></span>`;
      const partial = document.createElement('button');
      partial.className = 'mini';
      partial.dataset.action = 'withdraw';
      partial.dataset.mineral = cell.key;
      partial.dataset.amount = '100';
      partial.dataset.testid = `inv-withdraw-${cell.key}-100`;
      partial.title = `Withdraw up to 100 ${definition.name} into ship cargo.`;
      partial.textContent = 'Withdraw 100';
      partial.disabled = cell.count < 100;
      const all = document.createElement('button');
      all.className = 'mini';
      all.dataset.action = 'withdraw';
      all.dataset.mineral = cell.key;
      all.dataset.amount = 'all';
      all.dataset.testid = `inv-withdraw-${cell.key}-all`;
      all.title = `Withdraw all ${fmt(cell.count)} ${definition.name} into ship cargo.`;
      all.textContent = 'All';
      actions.append(partial, all);
    } else if (cell.kind === 'loot') {
      const module = catalog.modules[cell.loot.slotType];
      row.innerHTML = `<span class="label">${module ? module.name : cell.loot.slotType} <span class="sub">Tier ${ROMAN[cell.loot.tier] || cell.loot.tier} module</span></span>`;
      actions.appendChild(this.#createRetrieveButton('loot', cell.loot.id, `Retrieve this Tier ${ROMAN[cell.loot.tier] || cell.loot.tier} module to ship inventory.`));
    } else {
      const name = blueprintName(cell.blueprint, catalog);
      row.innerHTML = `<span class="label">${name} <span class="sub">Blueprint</span></span>`;
      actions.appendChild(this.#createRetrieveButton('blueprints', cell.blueprint.id, `Retrieve the ${name} blueprint to ship inventory.`));
    }
    row.appendChild(actions);
    el.appendChild(row);
  }

  // PRIVATE
  #createRetrieveButton(kind, id, description) {
    const button = document.createElement('button');
    button.className = 'mini';
    button.dataset.action = 'retrieve-item';
    button.dataset.kind = kind;
    button.dataset.id = id;
    button.dataset.testid = `inv-retrieve-${kind === 'loot' ? 'loot' : 'blueprint'}-${id}`;
    button.title = description;
    button.textContent = 'Retrieve';
    return button;
  }
}
