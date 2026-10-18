'use strict';

// Screen-space toast + death-screen overlays.
import { Node } from '../core/node.js';
import { fmt } from '../core/util.js';

export class OverlaysNode extends Node {
  toast(msg, isError) {
    const el = document.getElementById('toast');
    el.textContent = msg;
    el.className = 'toast show' + (isError ? ' error' : '');
    clearTimeout(this.app.toastTimer);
    this.app.toastTimer = setTimeout(() => { el.className = 'toast'; }, 2600);
  }

  showDeath(mail) {
    const el = document.getElementById('death-screen');
    const detail = document.getElementById('death-detail');
    const lines = [`${mail.ship} lost to ${mail.enemy}`];
    if (mail.system) lines.push(`in ${mail.system}`);
    if (mail.cargoLost > 0) lines.push(`${mail.cargoLost} units of cargo lost`);
    if (mail.insurance > 0) lines.push(`insurance paid ${fmt(mail.insurance)} ISK`);
    detail.innerHTML = lines.map((l) => `<div>${l}</div>`).join('');
    el.hidden = false;
    if (this.app.deathTimer) clearTimeout(this.app.deathTimer);
    this.app.deathTimer = setTimeout(() => { el.hidden = true; }, 6000);
  }

  hideDeath() {
    document.getElementById('death-screen').hidden = true;
    if (this.app.deathTimer) clearTimeout(this.app.deathTimer);
  }
}
