'use strict';

// Action messages and death-screen overlays.
import { Node } from '../core/node.js';
import { fmt } from '../core/util.js';

export class OverlaysNode extends Node {
  // PUBLIC
  constructor(app) {
    super(app);
    this.offlineDialogReady = false;
  }

  // PUBLIC
  showOfflineReport(report) {
    const el = document.getElementById('offline-report');
    if (!this.offlineDialogReady) {
      el.addEventListener('cancel', (event) => event.preventDefault());
      el.addEventListener('close', () => { el.hidden = true; });
      document.getElementById('offline-report-close').addEventListener('click', () => el.close());
      this.offlineDialogReady = true;
    }
    const summary = document.getElementById('offline-report-summary');
    const detail = document.getElementById('offline-report-detail');
    const hours = Math.floor(report.elapsedSeconds / 3600);
    const minutes = Math.floor((report.elapsedSeconds % 3600) / 60);
    const duration = hours ? `${hours}h ${minutes}m` : `${minutes}m`;
    summary.textContent = `Away for ${duration}${report.capped ? ' (mining and combat catch-up capped)' : ''}`;
    const lines = [];
    if (report.mined > 0) lines.push(`Ore mined: ${fmt(report.mined)}`);
    if (report.oreByType) {
      const parts = Object.entries(report.oreByType).map(([k, v]) => `${k} ${fmt(v)}`);
      if (parts.length) lines.push(`  ${parts.join(', ')}`);
    }
    if (report.items) {
      const items = Object.entries(report.items).map(([key, amount]) => `${key} ${fmt(amount)}`);
      if (items.length) lines.push(`Items gained: ${items.join(', ')}`);
    }
    if (report.kills > 0) lines.push(`Rats killed: ${fmt(report.kills)}`);
    if (report.beltsCompleted > 0) lines.push(`Belts completed: ${fmt(report.beltsCompleted)}`);
    if (report.distance > 0) lines.push(`Distance traveled: ${fmt(report.distance)} u`);
    if (report.skillPoints > 0) lines.push(`Skill points: ${fmt(report.skillPoints)} SP`);
    detail.innerHTML = lines.length ? `<ul>${lines.map((l) => `<li>${l}</li>`).join('')}</ul>` : '<p>Nothing happened while you were away.</p>';
    el.hidden = false;
    if (!el.open) el.showModal();
  }

  // PUBLIC
  toast(msg, isError) {
    this.app.ui.hud.pushEvent(msg, isError ? 'bad' : '');
  }

  // PUBLIC
  showDeath(mail) {
    const el = document.getElementById('death-screen');
    const detail = document.getElementById('death-detail');
    const lines = [`${mail.ship} lost to ${mail.enemy}`];
    if (mail.system) lines.push(`in ${mail.system}`);
    if (mail.cargoLost > 0) lines.push(`${mail.cargoLost} units of cargo lost`);
    detail.innerHTML = lines.map((l) => `<div>${l}</div>`).join('');
    el.hidden = false;
    if (this.app.deathTimer) clearTimeout(this.app.deathTimer);
    this.app.deathTimer = setTimeout(() => { el.hidden = true; }, 6000);
  }

  // PUBLIC
  hideDeath() {
    document.getElementById('death-screen').hidden = true;
    if (this.app.deathTimer) clearTimeout(this.app.deathTimer);
  }
}
