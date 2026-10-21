'use strict';

// The inventory overlay: the active ship's contents (cargo + loot, shown
// anywhere) and the quantum storage shared by every station (docked to access).
// Deposit/withdraw move minerals between the hold and storage. DOM only; the
// panel is rebuilt when it opens or when state changes while it is open.
import { Node } from '../core/node.js';
import { fmt } from '../core/util.js';

const ROMAN = ['—', 'I', 'II', 'III', 'IV'];

export class InventoryNode extends Node {
  refresh() {
    this.renderFitting();
    this.renderCargo();
    this.renderLoot();
    this.renderStorage();
    return this;
  }

  renderFitting() {
    const { state, catalog } = this.app;
    const ship = state.activeShip;
    const el = document.getElementById('inv-fitting');
    document.getElementById('inv-ship-name').textContent = ship ? ship.name : '';
    el.innerHTML = '';
    if (!ship) {
      el.innerHTML = '<div class="row"><span class="sub">No active ship.</span></div>';
      return;
    }
    const drones = state.drones || { mining: [], combat: [] };
    const droneTxt = drones.mining.length + drones.combat.length
      ? ` · 🤖${drones.mining.length}⛏/${drones.combat.length}⚔`
      : '';
    const stats = document.createElement('div');
    stats.className = 'row fitting-stats';
    stats.dataset.testid = 'inv-ship-stats';
    stats.innerHTML = `<span class="label"><span class="sub">⛏${ship.mining.toFixed(1)}/s · ⚔${fmt(ship.dps)} dps · 🛡${fmt(ship.shield)} · 🧱${fmt(ship.hull)} · 📦${fmt(ship.cargo)}${droneTxt}</span></span>`;
    el.appendChild(stats);
    for (const slotType of Object.keys(catalog.modules)) {
      const count = ship.slots[slotType] || 0;
      const tiers = ship.fitting[slotType] || [];
      for (let i = 0; i < count; i++) {
        const t = tiers[i] || 0;
        const tierLabel = t === 4 ? 'Faction' : ROMAN[t];
        const row = document.createElement('div');
        row.className = 'row';
        row.innerHTML = `<span class="label">${catalog.modules[slotType].name} <span class="sub">${t ? `Tier ${tierLabel}` : 'empty'}</span></span>`;
        el.appendChild(row);
      }
    }
  }

  renderCargo() {
    const state = this.app.state;
    const docked = !!state.docked;
    const el = document.getElementById('inv-ship');
    el.innerHTML = '';
    const usage = document.getElementById('inv-cargo-usage');
    if (usage) usage.textContent = `${fmt(state.cargoUsed)}/${fmt(state.cargoCapacity)}${state.cargoFull ? ' (FULL)' : ''}`;
    for (const key of Object.keys(this.app.catalog.minerals)) {
      const def = this.app.catalog.minerals[key];
      const amt = state.minerals[key];
      const price = (state.world && state.world.prices && state.world.prices[key]) || def.price;
      const row = document.createElement('div');
      row.className = 'row';
      row.innerHTML = `
        <span class="label"><span class="dot" style="width:9px;height:9px;border-radius:50%;background:${def.color};display:inline-block"></span>${def.name} <span class="sub">${fmt(amt)} · ${price} ISK/u</span></span>
        <span class="actions">
          <button class="mini" data-action="deposit" data-mineral="${key}" data-amount="100" data-testid="inv-deposit-${key}-100" ${docked && amt > 0 ? '' : 'disabled'}>Deposit 100</button>
          <button class="mini" data-action="deposit" data-mineral="${key}" data-amount="all" data-testid="inv-deposit-${key}-all" ${docked && amt > 0 ? '' : 'disabled'}>All</button>
        </span>`;
      el.appendChild(row);
    }
    if (!docked) {
      const note = document.createElement('div');
      note.className = 'row';
      note.innerHTML = '<span class="sub">Dock at a station to deposit cargo into quantum storage.</span>';
      el.appendChild(note);
    }
  }

  renderLoot() {
    const el = document.getElementById('inv-loot');
    el.innerHTML = '';
    const loot = this.app.state.loot || [];
    if (!loot.length) {
      const note = document.createElement('div');
      note.className = 'row';
      note.innerHTML = '<span class="sub">Destroy rats to loot modules.</span>';
      el.appendChild(note);
      return;
    }
    for (const l of loot) {
      const row = document.createElement('div');
      row.className = 'row';
      row.innerHTML = `<span class="label">${l.name} <span class="sub">Tier ${ROMAN[l.tier] || l.tier}</span></span>`;
      el.appendChild(row);
    }
  }

  renderStorage() {
    const state = this.app.state;
    const docked = !!state.docked;
    const el = document.getElementById('inv-storage');
    el.innerHTML = '';
    const stored = (state.storage && state.storage.minerals) || {};
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
      note.innerHTML = '<span class="sub">Storage is empty. Deposit ore to keep it safe between trips.</span>';
      el.appendChild(note);
      return;
    }
    for (const key of Object.keys(this.app.catalog.minerals)) {
      const def = this.app.catalog.minerals[key];
      const amt = stored[key] || 0;
      if (amt <= 0) continue;
      const row = document.createElement('div');
      row.className = 'row';
      row.innerHTML = `
        <span class="label"><span class="dot" style="width:9px;height:9px;border-radius:50%;background:${def.color};display:inline-block"></span>${def.name} <span class="sub">${fmt(amt)}</span></span>
        <span class="actions">
          <button class="mini" data-action="withdraw" data-mineral="${key}" data-amount="100" data-testid="inv-withdraw-${key}-100">Withdraw 100</button>
          <button class="mini" data-action="withdraw" data-mineral="${key}" data-amount="all" data-testid="inv-withdraw-${key}-all">All</button>
        </span>`;
      el.appendChild(row);
    }
  }
}
