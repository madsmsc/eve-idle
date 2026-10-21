'use strict';

// The character sheet overlay: pilot summary plus your standing with every
// faction (the HUD only shows the active system's faction, this shows the whole
// picture). Openable in space or docked; DOM only, rebuilt on open/state change.
import { Node } from '../core/node.js';
import { fmt } from '../core/util.js';

export class CharacterNode extends Node {
  refresh() {
    this.renderPilot();
    this.renderFactions();
    return this;
  }

  renderPilot() {
    const state = this.app.state;
    const el = document.getElementById('character-pilot');
    const stats = state.stats || {};
    const system = state.system || {};
    const security = system.security != null ? system.security.toFixed(1) : '—';
    el.innerHTML = `
      <div class="char-stat"><span class="label">ISK</span><span class="value">${fmt(state.isk)}</span></div>
      <div class="char-stat"><span class="label">Security</span><span class="value">${security}</span></div>
      <div class="char-stat"><span class="label">Skill Points</span><span class="value">${fmt(Math.floor(state.skillPoints || 0))}</span></div>
      <div class="char-stat"><span class="label">Battles Won</span><span class="value">${fmt(stats.combatsWon || 0)}</span></div>
      <div class="char-stat"><span class="label">Ships Lost</span><span class="value">${fmt(stats.shipsLost || 0)}</span></div>`;
  }

  renderFactions() {
    const state = this.app.state;
    const factionsEl = document.getElementById('character-factions');
    factionsEl.innerHTML = '';
    for (const f of state.factions || []) {
      const sysId = this.app.catalog.factions && this.app.catalog.factions[f.key]
        ? this.app.catalog.factions[f.key].systemId
        : null;
      const sysName = sysId ? (state.systemNames || []).find((s) => s.id === sysId) : null;
      const chance = sysId && state.ambush ? state.ambush[sysId] : null;
      const risk = chance != null ? `${Math.round(chance * 100)}% ambush` : '—';
      const sign = f.standing > 0 ? '+' : '';
      const row = document.createElement('div');
      row.className = 'char-faction';
      row.innerHTML = `
        <span class="char-faction-name">${f.name}</span>
        <span class="char-faction-sys">${sysName ? sysName.name : 'Unknown'}</span>
        <span class="char-faction-standing" data-testid="standing-${f.key}">${sign}${f.standing.toFixed(1)}</span>
        <span class="char-faction-risk">${risk}</span>`;
      factionsEl.appendChild(row);
    }
  }
}
