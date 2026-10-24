'use strict';

// The character sheet overlay; openable in space or docked.
import { Node } from '../core/node.js';
import { fmt } from '../core/util.js';

export class CharacterNode extends Node {
  refresh() {
    this.renderPilot();
    return this;
  }

  renderPilot() {
    const state = this.app.state;
    const el = document.getElementById('character-pilot');
    const stats = state.stats || {};
    const system = state.system || {};
    const security = system.security != null ? system.security.toFixed(1) : '—';
    el.innerHTML = `
      <div class="char-stat"><span class="label">Security</span><span class="value">${security}</span></div>
      <div class="char-stat"><span class="label">Skill Points</span><span class="value">${fmt(Math.floor(state.skillPoints || 0))}</span></div>
      <div class="char-stat"><span class="label">Modules Salvaged</span><span class="value">${fmt(stats.modulesSalvaged || 0)}</span></div>
      <div class="char-stat"><span class="label">Battles Won</span><span class="value">${fmt(stats.combatsWon || 0)}</span></div>
      <div class="char-stat"><span class="label">Ships Lost</span><span class="value">${fmt(stats.shipsLost || 0)}</span></div>`;
  }

}
