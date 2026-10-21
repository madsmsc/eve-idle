'use strict';

// Action messages and death-screen overlays.
import { Node } from '../core/node.js';
import { fmt } from '../core/util.js';

export class OverlaysNode extends Node {
  showOfflineReport(report) {
    const el = document.getElementById('offline-report');
    const summary = document.getElementById('offline-report-summary');
    const hours = Math.floor(report.elapsedSeconds / 3600);
    const minutes = Math.floor((report.elapsedSeconds % 3600) / 60);
    const duration = hours ? `${hours}h ${minutes}m` : `${minutes}m`;
    summary.textContent = `${duration}${report.capped ? ' (offline gains capped)' : ''}: mined ${fmt(report.mined)} ore, earned ${fmt(report.isk)} ISK, won ${fmt(report.kills)} battles, and gained ${fmt(report.skillPoints)} SP.`;
    el.hidden = false;
    document.getElementById('offline-report-close').addEventListener('click', () => { el.hidden = true; }, { once: true });
  }

  toast(msg, isError) {
    this.app.ui.hud.pushEvent(msg, isError ? 'bad' : '');
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
