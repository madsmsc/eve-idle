'use strict';

// The active ship, rendered centered on screen. It draws its own hull, the
// click-to-move destination line, and the mining beam; the drones orbiting the
// rock you mine are its children (each drone is a child node).
import { Node } from '../core/node.js';
import { clamp } from '../core/util.js';

export class ShipNode extends Node {
  constructor(app) {
    super(app);
    this.add(new MiningDroneNode());
  }

  render(now) {
    this.drawDestination(now);
    this.drawBeam(now);
    this.drawShip();
    return super.render(now);
  }

  drawDestination(now) {
    const ctx = this.app.ctx;
    const camera = this.app.camera;
    const player = this.app.player;
    if (!player.destination) return;
    const p = camera.worldToScreen(player.destination.x, player.destination.y);
    const cx = this.app.canvas.width / 2;
    const cy = this.app.canvas.height / 2;
    ctx.save();
    ctx.strokeStyle = 'rgba(79, 209, 255, 0.5)';
    ctx.lineWidth = 1;
    ctx.setLineDash([4, 8]);
    ctx.lineDashOffset = -now / 40;
    ctx.beginPath();
    ctx.moveTo(cx, cy);
    ctx.lineTo(p.x, p.y);
    ctx.stroke();
    ctx.restore();
    ctx.strokeStyle = 'rgba(79, 209, 255, 0.8)';
    ctx.lineWidth = 1.5;
    const r = 12;
    ctx.beginPath();
    ctx.arc(p.x, p.y, r, 0, Math.PI * 2);
    ctx.stroke();
    ctx.beginPath();
    ctx.moveTo(p.x - r - 5, p.y);
    ctx.lineTo(p.x + r + 5, p.y);
    ctx.moveTo(p.x, p.y - r - 5);
    ctx.lineTo(p.x, p.y + r + 5);
    ctx.stroke();
  }

  drawBeam(now) {
    const ctx = this.app.ctx;
    const camera = this.app.camera;
    const a = this.app.player.nearestAsteroid();
    if (!a || this.app.state.combat) return;
    const p = camera.worldToScreen(a.x, a.y);
    const cx = this.app.canvas.width / 2;
    const cy = this.app.canvas.height / 2;
    const pulse = 0.5 + 0.5 * Math.sin(now / 120);
    ctx.save();
    ctx.strokeStyle = this.app.catalog.minerals[a.mineral].color;
    ctx.globalAlpha = 0.5 + 0.4 * pulse;
    ctx.lineWidth = 2 + pulse * 2;
    ctx.setLineDash([10, 6]);
    ctx.lineDashOffset = -now / 20;
    ctx.beginPath();
    ctx.moveTo(cx, cy);
    ctx.lineTo(p.x, p.y);
    ctx.stroke();
    ctx.restore();
  }

  drawShip() {
    const ctx = this.app.ctx;
    const camera = this.app.camera;
    const player = this.app.player;
    const cx = this.app.canvas.width / 2;
    const cy = this.app.canvas.height / 2;
    const s = 22 * camera.zoom;
    ctx.save();
    ctx.translate(cx, cy);
    ctx.rotate(player.heading + Math.PI / 2);
    const sp = Math.hypot(player.vx, player.vy);
    if (sp > 10) {
      ctx.globalAlpha = clamp(sp / this.app.constants.maxSpeed, 0.2, 0.9);
      ctx.fillStyle = '#4fd1ff';
      ctx.beginPath();
      ctx.moveTo(-s * 0.25, s * 0.7);
      ctx.lineTo(0, s * (0.9 + 0.5 * (sp / this.app.constants.maxSpeed)));
      ctx.lineTo(s * 0.25, s * 0.7);
      ctx.closePath();
      ctx.fill();
      ctx.globalAlpha = 1;
    }
    ctx.beginPath();
    ctx.moveTo(0, -s);
    ctx.lineTo(s * 0.7, s * 0.7);
    ctx.lineTo(0, s * 0.35);
    ctx.lineTo(-s * 0.7, s * 0.7);
    ctx.closePath();
    ctx.fillStyle = 'rgba(30, 60, 90, 0.95)';
    ctx.fill();
    ctx.lineWidth = 2;
    ctx.strokeStyle = '#4fd1ff';
    ctx.stroke();
    ctx.beginPath();
    ctx.arc(0, -s * 0.2, s * 0.22, 0, Math.PI * 2);
    ctx.fillStyle = '#bfefff';
    ctx.fill();
    ctx.restore();
  }
}

// The mining drones orbiting the asteroid you are mining (one per owned drone).
class MiningDroneNode extends Node {
  render(now) {
    const ctx = this.app.ctx;
    const state = this.app.state;
    const n = state.drones && state.drones.mining ? state.drones.mining.length : 0;
    if (!n || state.combat) return super.render(now);
    const a = this.app.player.nearestAsteroid();
    if (!a) return super.render(now);
    const p = this.app.camera.worldToScreen(a.x, a.y);
    const orbitR = 42 * this.app.camera.zoom;
    const ang = -now / 700;
    for (let i = 0; i < Math.min(n, 6); i++) {
      const t = ang + (i / Math.max(1, n)) * Math.PI * 2;
      const dx = p.x + Math.cos(t) * orbitR;
      const dy = p.y + Math.sin(t) * orbitR;
      ctx.save();
      ctx.translate(dx, dy);
      ctx.rotate(t);
      const r = 5 * this.app.camera.zoom;
      ctx.beginPath();
      ctx.moveTo(0, -r);
      ctx.lineTo(r * 0.8, r * 0.7);
      ctx.lineTo(-r * 0.8, r * 0.7);
      ctx.closePath();
      ctx.fillStyle = 'rgba(60, 200, 140, 0.9)';
      ctx.fill();
      ctx.strokeStyle = '#7ff0c0';
      ctx.lineWidth = 1;
      ctx.stroke();
      ctx.restore();
    }
    return super.render(now);
  }
}
