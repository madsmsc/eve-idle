'use strict';

// Combat presentation. CombatNode animates the fight the server is resolving:
// drones orbit the ship, lasers and rockets fly at the target, and an explosion
// plays when the server reports the outcome. HealthBarNode draws the live
// shield/hull bars (enemy above it, your ship below center) straight from the
// server's real-time simulation.
import { Node } from '../core/node.js';
import { clamp, pseudo } from '../core/util.js';

export class HealthBarNode extends Node {
  render(now) {
    const state = this.app.state;
    if (!state.combat) return super.render(now);
    const c = state.combat;
    const e = state.world.enemies.find((x) => x.id === c.enemyId);
    if (!e) return super.render(now);
    const ep = this.app.camera.worldToScreen(e.x, e.y);
    const cx = this.app.canvas.width / 2;
    const cy = this.app.canvas.height / 2;
    const zoom = this.app.camera.zoom;
    const er = this.enemySize(e.type) * zoom;
    this.drawShipBars(ep.x, ep.y - er - 24 * zoom, 66 * zoom, c.enemyShield, c.enemyShieldMax, c.enemyHull, c.enemyHullMax);
    this.drawShipBars(cx, cy + 40 * zoom, 74 * zoom, c.shipShield, c.shipShieldMax, c.shipHull, c.shipHullMax);
    return super.render(now);
  }

  enemySize(type) {
    return type === 'dread' ? 26 : type === 'faction' ? 20 : type === 'gang' ? 16 : 13;
  }

  // Two stacked bars (shield on top, hull below) centered on (x, y).
  drawShipBars(x, y, w, shield, shieldMax, hull, hullMax) {
    const h = 5;
    const gap = 2;
    this.drawBar(x, y, w, h, shieldMax > 0 ? shield / shieldMax : 0, '#4fd1ff');
    this.drawBar(x, y + h + gap, w, h, hullMax > 0 ? hull / hullMax : 0, '#35d07f');
  }

  drawBar(x, y, w, h, frac, color) {
    const ctx = this.app.ctx;
    ctx.save();
    ctx.fillStyle = 'rgba(0,0,0,0.6)';
    ctx.fillRect(x - w / 2, y, w, h);
    ctx.fillStyle = color;
    ctx.fillRect(x - w / 2, y, w * clamp(frac, 0, 1), h);
    ctx.strokeStyle = 'rgba(255,255,255,0.35)';
    ctx.lineWidth = 1;
    ctx.strokeRect(x - w / 2, y, w, h);
    ctx.restore();
  }
}

export class CombatNode extends Node {
  render(now) {
    const ctx = this.app.ctx;
    const state = this.app.state;
    const fx = this.app.combatFx;
    fx.explosions = fx.explosions.filter((ex) => now - ex.at < 1100);
    for (const ex of fx.explosions) this.drawExplosion(ex, now);

    const c = state.combat;
    if (!c) return super.render(now);
    const e = state.world.enemies.find((x) => x.id === c.enemyId);
    if (!e) return super.render(now);
    const ep = this.app.camera.worldToScreen(e.x, e.y);
    const cx = this.app.canvas.width / 2;
    const cy = this.app.canvas.height / 2;

    const combatDrones = state.drones && state.drones.combat ? state.drones.combat.length : 0;
    const nDrones = combatDrones > 0 ? Math.min(combatDrones, 6) : 3;
    const orbitR = 48 * this.app.camera.zoom;
    const orbitAng = now / 850;
    for (let i = 0; i < nDrones; i++) {
      const a = orbitAng + (i / nDrones) * Math.PI * 2;
      const dx = cx + Math.cos(a) * orbitR;
      const dy = cy + Math.sin(a) * orbitR;
      this.drawDrone(dx, dy, a + Math.PI / 2);
      if (pseudo(i * 31 + Math.floor(now / 130)) > 0.3) {
        this.drawLaser(dx, dy, ep.x, ep.y, now, i * 7 + 1);
      }
    }
    this.drawLaser(cx, cy, ep.x, ep.y, now, 42);
    this.drawRockets(cx, cy, ep.x, ep.y, now);

    const er = this.enemySize(e.type) * this.app.camera.zoom;
    const flash = Math.max(0, Math.sin(now / 80));
    if (flash > 0.35) {
      ctx.save();
      ctx.globalAlpha = (flash - 0.35) * 0.7;
      ctx.fillStyle = '#fff';
      ctx.beginPath();
      ctx.arc(ep.x, ep.y, er, 0, Math.PI * 2);
      ctx.fill();
      ctx.restore();
    }
    return super.render(now);
  }

  enemySize(type) {
    return type === 'dread' ? 26 : type === 'faction' ? 20 : type === 'gang' ? 16 : 13;
  }

  drawDrone(x, y, angle) {
    const ctx = this.app.ctx;
    const r = 7 * this.app.camera.zoom;
    ctx.save();
    ctx.translate(x, y);
    ctx.rotate(angle);
    ctx.beginPath();
    ctx.moveTo(0, -r);
    ctx.lineTo(r * 0.8, r * 0.7);
    ctx.lineTo(-r * 0.8, r * 0.7);
    ctx.closePath();
    ctx.fillStyle = 'rgba(40, 180, 200, 0.9)';
    ctx.fill();
    ctx.lineWidth = 1;
    ctx.strokeStyle = '#7fe7f0';
    ctx.stroke();
    ctx.restore();
  }

  drawLaser(x1, y1, x2, y2, now, seed) {
    const ctx = this.app.ctx;
    const pulse = 0.5 + 0.5 * Math.sin(now / 60 + seed);
    ctx.save();
    ctx.globalAlpha = 0.35 + 0.5 * pulse;
    ctx.strokeStyle = '#ffd24a';
    ctx.lineWidth = 1.5 + pulse * 1.5;
    ctx.shadowColor = '#ffb020';
    ctx.shadowBlur = 8;
    ctx.beginPath();
    ctx.moveTo(x1, y1);
    ctx.lineTo(x2, y2);
    ctx.stroke();
    ctx.restore();
  }

  drawRockets(cx, cy, ex, ey, now) {
    const ctx = this.app.ctx;
    const zoom = this.app.camera.zoom;
    const period = 900;
    for (let i = 0; i < 2; i++) {
      const t = (now / period + i * 0.5) % 1;
      const mx = (cx + ex) / 2;
      const my = (cy + ey) / 2 - 40 * zoom;
      const bx = (1 - t) * (1 - t) * cx + 2 * (1 - t) * t * mx + t * t * ex;
      const by = (1 - t) * (1 - t) * cy + 2 * (1 - t) * t * my + t * t * ey;
      ctx.save();
      ctx.fillStyle = '#9fd8ff';
      ctx.shadowColor = '#5ab0ff';
      ctx.shadowBlur = 6;
      ctx.beginPath();
      ctx.arc(bx, by, 2.5 * zoom, 0, Math.PI * 2);
      ctx.fill();
      ctx.restore();
    }
  }

  drawExplosion(ex, now) {
    const ctx = this.app.ctx;
    const t = (now - ex.at) / 1100;
    if (t < 0 || t > 1) return;
    const p = this.app.camera.worldToScreen(ex.x, ex.y);
    const maxR = (ex.kind === 'ship' ? 60 : 46) * this.app.camera.zoom;
    const r = maxR * (0.2 + 0.8 * t);
    const alpha = 1 - t;
    ctx.save();
    ctx.globalAlpha = alpha;
    const g = ctx.createRadialGradient(p.x, p.y, 0, p.x, p.y, r);
    g.addColorStop(0, ex.kind === 'ship' ? 'rgba(150,210,255,0.95)' : 'rgba(255,225,130,0.95)');
    g.addColorStop(0.5, 'rgba(255,140,40,0.8)');
    g.addColorStop(1, 'rgba(255,60,20,0)');
    ctx.fillStyle = g;
    ctx.beginPath();
    ctx.arc(p.x, p.y, r, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = '#fff';
    for (let i = 0; i < 8; i++) {
      const a = pseudo(i * 17 + ex.at) * Math.PI * 2;
      const sr = r * (0.5 + 0.7 * t) * pseudo(i * 3 + ex.at);
      ctx.globalAlpha = alpha * 0.8;
      ctx.beginPath();
      ctx.arc(p.x + Math.cos(a) * sr, p.y + Math.sin(a) * sr, 1.5, 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.restore();
  }
}
