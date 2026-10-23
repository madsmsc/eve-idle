'use strict';

// Action messages and death-screen overlays.
import { Node } from '../core/node.js';
import { fmt } from '../core/util.js';

export class OverlaysNode extends Node {
  showOfflineReport(report) {
    const el = document.getElementById('offline-report');
    const summary = document.getElementById('offline-report-summary');
    const detail = document.getElementById('offline-report-detail');
    const hours = Math.floor(report.elapsedSeconds / 3600);
    const minutes = Math.floor((report.elapsedSeconds % 3600) / 60);
    const duration = hours ? `${hours}h ${minutes}m` : `${minutes}m`;
    summary.textContent = `Away for ${duration}${report.capped ? ' (gains capped)' : ''}`;
    const lines = [];
    if (report.mined > 0) lines.push(`Ore mined: ${fmt(report.mined)}`);
    if (report.oreByType) {
      const parts = Object.entries(report.oreByType).map(([k, v]) => `${k} ${fmt(v)}`);
      if (parts.length) lines.push(`  ${parts.join(', ')}`);
    }
    if (report.isk > 0) lines.push(`Credits earned: ${fmt(report.isk)} cr`);
    if (report.kills > 0) lines.push(`Rats killed: ${fmt(report.kills)}`);
    if (report.beltsCompleted > 0) lines.push(`Belts completed: ${fmt(report.beltsCompleted)}`);
    if (report.distance > 0) lines.push(`Distance traveled: ${fmt(report.distance)} u`);
    if (report.skillPoints > 0) lines.push(`Skill points: ${fmt(report.skillPoints)} SP`);
    detail.innerHTML = lines.length ? `<ul>${lines.map((l) => `<li>${l}</li>`).join('')}</ul>` : '<p>Nothing happened while you were away.</p>';
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
