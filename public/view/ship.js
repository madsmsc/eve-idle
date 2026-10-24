'use strict';

// The active ship node: it draws the ship, the click-to-move destination line,
// and the mining beam, and it owns the ship's own actions (warp, gate jump,
// engage, in-fight actions). The mining drones orbiting the rock you mine are
// its children. While docked at a station the ship is safely in the hangar, so
// nothing is drawn (the station view replaces the world).
import { Node } from '../core/node.js';
import { api } from '../core/api.js';
import { clamp, dist } from '../core/util.js';

function polygonPath(ctx, points) {
  ctx.beginPath();
  points.forEach(([x, y], i) => {
    if (i === 0) ctx.moveTo(x, y);
    else ctx.lineTo(x, y);
  });
  ctx.closePath();
}

export class ShipNode extends Node {
  // PUBLIC
  constructor(app) {
    super(app);
    this.add(new MiningDroneNode());
  }

  // ---- ship actions ----
  // The ship decides how it moves: these used to live on the app orchestrator,
  // but they belong to the ship node so the scene graph owns the ship's behaviour.

  // PUBLIC
  async doWarp(targetId, opts) {
    opts = opts || {};
    if (this.app.docking) return false;
    if (this.app.state.combat) {
      try {
        const data = await api('/api/state');
        this.app.onServerState(data.state);
      } catch (e) {
        this.app.toast(e.message, true);
        return false;
      }
      if (this.app.state.combat) {
        if (!opts.silent) this.app.toast('Cannot warp while in combat', true);
        return false;
      }
    }
    const payload = targetId ? { targetId } : { x: opts.x, y: opts.y };
    this.app.warpPending = true;
    const ok = await this.app.doAction('warp', payload);
    this.app.warpPending = false;
    if (ok) {
      const active = this.app.state.ships.find((s) => s.id === this.app.state.activeShipId);
      if (active) this.app.player.snap(active.x, active.y);
      // Every warp plays the same tunnel/flash so it feels weighty and consistent.
      if (!opts.noFx) this.app.warpFx = performance.now();
      if (!opts.silent) this.app.toast('Warping…');
    }
    return ok;
  }

  // PUBLIC
  navigate(targetId, coordinates, opts = {}) {
    if (this.app.state.combat) {
      this.app.toast('Cannot navigate while in combat', true);
      return false;
    }
    if (this.app.state.docked) {
      this.app.toast('Launch from the station before navigating', true);
      return false;
    }

    const payload = targetId ? { targetId } : coordinates;
    if (!payload) {
      this.app.toast('Invalid navigation destination', true);
      return false;
    }
    return this.app.doAction('navigate', payload).then((ok) => {
      if (ok) {
        this.app.targetEnemyId = this.app.state.navigation && this.app.state.navigation.targetId;
        if (!opts.silent) this.app.toast('Destination set');
      }
      return ok;
    });
  }

  // PUBLIC
  navigateToNearest(kind) {
    return this.app.doAction('navigate', { kind });
  }

  // PUBLIC
  async doGateJump() {
    this.app.warpPending = true;
    const ok = await this.app.doAction('gate', {});
    this.app.warpPending = false;
    if (ok) {
      // A jump feels like a warp (the tunnel) plus its own gate effect on top.
      this.app.warpFx = performance.now();
      this.app.gateFx = performance.now();
      if (this.app.state.combat) {
        this.app.toast('⚠ Ambushed at the gate!', true);
        this.app.camera.addShake(1);
      } else {
        this.app.toast('Jumping to ' + this.app.state.system.name + '…');
      }
    }
  }

  // PUBLIC
  async doEngage() {
    const ok = await this.app.doAction('engage', { enemyId: this.app.targetEnemyId });
    if (ok) this.app.toast('Engaged!');
  }

  // PUBLIC
  async doCombatAction(action) {
    const ok = await this.app.doAction('combat-action', { action });
    if (ok) {
      if (action === 'disengage') this.app.toast('Disengaged — rat escaped');
      else if (action === 'shieldBoost') this.app.toast('Shield boosted');
      else if (action === 'overload') this.app.toast('Weapons overloaded');
    }
  }

  // PUBLIC
  render(now) {
    if (this.app.state.docked) return super.render(now);
    this.#drawDestination(now);
    this.#drawBeam(now);
    this.#drawShip();
    return super.render(now);
  }

  // PRIVATE
  #drawDestination(now) {
    const ctx = this.app.ctx;
    const camera = this.app.camera;
    const player = this.app.player;
    if (!player.destination) return;
    const targetEnemy = this.app.targetEnemyId &&
      this.app.state.world.enemies.find((enemy) => enemy.id === this.app.targetEnemyId && enemy.alive);
    if (targetEnemy && dist(targetEnemy.x, targetEnemy.y, player.destination.x, player.destination.y) < 1) return;
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

  // PRIVATE
  #drawBeam(now) {
    const ctx = this.app.ctx;
    const camera = this.app.camera;
    const a = this.app.state.miningTargetId &&
      this.app.state.world.asteroids.find((asteroid) => asteroid.id === this.app.state.miningTargetId);
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

  // PRIVATE
  #drawShip() {
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
    polygonPath(ctx, [
      [0, -s],
      [s * 0.32, -s * 0.3],
      [s * 0.92, s * 0.24],
      [s * 0.68, s * 0.66],
      [s * 0.22, s * 0.46],
      [0, s * 0.78],
      [-s * 0.22, s * 0.46],
      [-s * 0.68, s * 0.66],
      [-s * 0.92, s * 0.24],
      [-s * 0.32, -s * 0.3],
    ]);
    ctx.fillStyle = 'rgba(30, 60, 90, 0.95)';
    ctx.fill();
    ctx.lineWidth = 2;
    ctx.strokeStyle = '#4fd1ff';
    ctx.stroke();
    polygonPath(ctx, [
      [0, -s * 0.8],
      [s * 0.22, -s * 0.22],
      [0, s * 0.2],
      [-s * 0.22, -s * 0.22],
    ]);
    ctx.fillStyle = 'rgba(100, 200, 235, 0.3)';
    ctx.fill();
    ctx.strokeStyle = 'rgba(115, 225, 255, 0.75)';
    ctx.lineWidth = Math.max(1, camera.zoom);
    ctx.stroke();
    ctx.strokeStyle = 'rgba(110, 210, 245, 0.7)';
    ctx.lineWidth = Math.max(1, camera.zoom);
    ctx.beginPath();
    ctx.moveTo(-s * 0.65, s * 0.35);
    ctx.lineTo(-s * 0.25, s * 0.18);
    ctx.lineTo(0, s * 0.45);
    ctx.lineTo(s * 0.25, s * 0.18);
    ctx.lineTo(s * 0.65, s * 0.35);
    ctx.stroke();
    for (const side of [-1, 1]) {
      polygonPath(ctx, [
        [side * s * 0.78, s * 0.27],
        [side * s * 0.49, s * 0.31],
        [side * s * 0.34, s * 0.43],
      ]);
      ctx.fillStyle = '#54c9e8';
      ctx.fill();
    }
    polygonPath(ctx, [
      [-s * 0.12, s * 0.56],
      [0, s * 0.46],
      [s * 0.12, s * 0.56],
      [s * 0.1, s * 0.69],
      [-s * 0.1, s * 0.69],
    ]);
    ctx.fillStyle = '#17364f';
    ctx.fill();
    ctx.strokeStyle = 'rgba(130, 230, 255, 0.8)';
    ctx.lineWidth = Math.max(1, camera.zoom);
    ctx.stroke();
    ctx.beginPath();
    ctx.moveTo(0, -s * 0.64);
    ctx.lineTo(0, s * 0.37);
    ctx.stroke();
    ctx.beginPath();
    ctx.arc(0, -s * 0.2, s * 0.12, 0, Math.PI * 2);
    ctx.fillStyle = '#bfefff';
    ctx.fill();
    ctx.restore();
  }
}

// The mining drones orbiting the asteroid you are mining (one per owned drone).
class MiningDroneNode extends Node {
  // PUBLIC
  render(now) {
    const ctx = this.app.ctx;
    const state = this.app.state;
    const miningDroneSlots = (state.activeShip && state.activeShip.fitting && state.activeShip.fitting.miningDrone) || [];
    const n = miningDroneSlots.filter((tier) => tier > 0).length;
    if (!n || state.combat) return super.render(now);
    const a = state.miningTargetId &&
      state.world.asteroids.find((asteroid) => asteroid.id === state.miningTargetId);
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
      polygonPath(ctx, [
        [0, -r],
        [r * 0.42, -r * 0.15],
        [r, r * 0.3],
        [r * 0.35, r * 0.42],
        [0, r * 0.85],
        [-r * 0.35, r * 0.42],
        [-r, r * 0.3],
        [-r * 0.42, -r * 0.15],
      ]);
      ctx.fillStyle = 'rgba(60, 200, 140, 0.9)';
      ctx.fill();
      ctx.strokeStyle = '#7ff0c0';
      ctx.lineWidth = 1;
      ctx.stroke();
      polygonPath(ctx, [[0, -r * 0.58], [r * 0.25, 0], [0, r * 0.3], [-r * 0.25, 0]]);
      ctx.fillStyle = 'rgba(215, 255, 225, 0.85)';
      ctx.fill();
      ctx.restore();
    }
    return super.render(now);
  }
}
