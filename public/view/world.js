'use strict';

// The world scene: the starfield, grid, world bounds, and the celestial +
// entity nodes that make up the system. Each node renders itself (in insertion
// order = draw order) and recurses into its children.
import { Node } from '../core/node.js';
import { pseudo, dist, mixRgb, rgbStr } from '../core/util.js';
import { Player } from '../core/player.js';
import { ShipNode } from './ship.js';
import { CombatNode } from './combat.js';
import { EffectsNode } from './effects.js';

const STAR_TILE = 1500;
const STAR_COUNT = 170;
const TIER_COLORS = { novice: '#8fd19e', standard: '#8ec5ff', elite: '#ffcf5c' };

function polygonPath(ctx, points) {
  ctx.beginPath();
  points.forEach(([x, y], i) => {
    if (i === 0) ctx.moveTo(x, y);
    else ctx.lineTo(x, y);
  });
  ctx.closePath();
}

function regularPolygonPath(ctx, radius, sides, rotation = 0) {
  ctx.beginPath();
  for (let i = 0; i < sides; i++) {
    const angle = rotation + (i / sides) * Math.PI * 2;
    const x = Math.cos(angle) * radius;
    const y = Math.sin(angle) * radius;
    if (i === 0) ctx.moveTo(x, y);
    else ctx.lineTo(x, y);
  }
  ctx.closePath();
}

export class StarNode extends Node {
  // PUBLIC
  render(now) {
    const ctx = this.app.ctx;
    const s = this.app.state.world.star;
    const p = this.app.camera.worldToScreen(s.x, s.y);
    const r = s.size * this.app.camera.zoom;
    const g = ctx.createRadialGradient(p.x, p.y, 0, p.x, p.y, r * 2.2);
    g.addColorStop(0, 'rgba(255, 244, 214, 0.95)');
    g.addColorStop(0.3, 'rgba(255, 200, 90, 0.5)');
    g.addColorStop(1, 'rgba(255, 160, 40, 0)');
    ctx.fillStyle = g;
    ctx.beginPath();
    ctx.arc(p.x, p.y, r * 2.2, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = '#fff4d6';
    ctx.beginPath();
    ctx.arc(p.x, p.y, r * 0.5, 0, Math.PI * 2);
    ctx.fill();
    return super.render(now);
  }
}

export class BeltNode extends Node {
  // PUBLIC
  render(now) {
    const ctx = this.app.ctx;
    const camera = this.app.camera;
    const zoom = camera.zoom;
    const asteroids = this.app.state.world.asteroids;
    for (const b of this.app.state.world.belts) {
      const p = camera.worldToScreen(b.x, b.y);
      const r = 300 * zoom;
      ctx.strokeStyle = 'rgba(120, 150, 200, 0.18)';
      ctx.lineWidth = 1;
      ctx.setLineDash([6, 10]);
      ctx.beginPath();
      ctx.arc(p.x, p.y, r, 0, Math.PI * 2);
      ctx.stroke();
      ctx.setLineDash([]);
      let remaining = 0;
      let total = 0;
      for (const a of asteroids) {
        if (a.beltId !== b.id) continue;
        remaining += a.amount;
        total += a.maxAmount || a.amount;
      }
      const frac = total > 0 ? remaining / total : 0;
      if (frac > 0) {
        ctx.strokeStyle = frac > 0.5 ? 'rgba(100, 220, 140, 0.5)' : frac > 0.2 ? 'rgba(220, 200, 80, 0.5)' : 'rgba(220, 100, 80, 0.5)';
        ctx.lineWidth = 2;
        ctx.beginPath();
        ctx.arc(p.x, p.y, r, -Math.PI / 2, -Math.PI / 2 + frac * Math.PI * 2);
        ctx.stroke();
        ctx.lineWidth = 1;
      }
    }
    return super.render(now);
  }
}

export class PlanetNode extends Node {
  // PUBLIC
  render(now) {
    const ctx = this.app.ctx;
    const camera = this.app.camera;
    const zoom = camera.zoom;
    for (const pl of this.app.state.world.planets) {
      const p = camera.worldToScreen(pl.x, pl.y);
      const r = pl.size * zoom;
      if (r < 2) {
        ctx.fillStyle = pl.color;
        ctx.fillRect(p.x - 1, p.y - 1, 2, 2);
        continue;
      }
      ctx.save();
      ctx.translate(p.x, p.y);
      if (pl.ring) {
        ctx.strokeStyle = 'rgba(220, 220, 240, 0.5)';
        ctx.lineWidth = Math.max(1, r * 0.12);
        ctx.beginPath();
        ctx.ellipse(0, 0, r * 1.7, r * 0.5, -0.4, 0, Math.PI * 2);
        ctx.stroke();
        ctx.strokeStyle = 'rgba(255, 235, 190, 0.4)';
        ctx.lineWidth = Math.max(1, r * 0.035);
        ctx.beginPath();
        ctx.ellipse(0, 0, r * 1.42, r * 0.4, -0.4, Math.PI * 0.05, Math.PI * 0.95);
        ctx.stroke();
      }
      const g = ctx.createRadialGradient(-r * 0.3, -r * 0.3, r * 0.2, 0, 0, r);
      g.addColorStop(0, pl.color);
      g.addColorStop(1, 'rgba(0,0,0,0.55)');
      ctx.fillStyle = g;
      ctx.beginPath();
      ctx.arc(0, 0, r, 0, Math.PI * 2);
      ctx.fill();
      ctx.save();
      ctx.beginPath();
      ctx.arc(0, 0, r * 0.98, 0, Math.PI * 2);
      ctx.clip();
      const seed = pl.x + pl.y;
      for (let i = 0; i < 5; i++) {
        const a = pseudo(seed + i * 13) * Math.PI * 2;
        const x = Math.cos(a) * r * 0.42;
        const y = Math.sin(a) * r * 0.42;
        const size = r * (0.22 + pseudo(seed + i * 19) * 0.2);
        polygonPath(ctx, [
          [x - size * 0.8, y - size * 0.4],
          [x - size * 0.25, y - size],
          [x + size * 0.7, y - size * 0.65],
          [x + size, y + size * 0.1],
          [x + size * 0.15, y + size * 0.75],
          [x - size * 0.65, y + size * 0.45],
        ]);
        ctx.fillStyle = i % 2 ? 'rgba(255,255,255,0.08)' : 'rgba(0,0,0,0.1)';
        ctx.fill();
      }
      ctx.strokeStyle = 'rgba(235,245,255,0.12)';
      ctx.lineWidth = Math.max(1, r * 0.025);
      for (let i = -1; i <= 1; i++) {
        ctx.beginPath();
        ctx.ellipse(0, i * r * 0.24, r * 0.92, r * (0.18 + Math.abs(i) * 0.06), -0.16, 0, Math.PI * 2);
        ctx.stroke();
      }
      ctx.restore();
      if (pl.ring) {
        ctx.strokeStyle = 'rgba(245, 220, 170, 0.58)';
        ctx.lineWidth = Math.max(1, r * 0.045);
        ctx.beginPath();
        ctx.ellipse(0, 0, r * 1.7, r * 0.5, -0.4, Math.PI, Math.PI * 2);
        ctx.stroke();
      }
      ctx.restore();
    }
    return super.render(now);
  }
}

export class MoonNode extends Node {
  // PUBLIC
  render(now) {
    const ctx = this.app.ctx;
    const camera = this.app.camera;
    for (const m of this.app.state.world.moons) {
      const p = camera.worldToScreen(m.x, m.y);
      ctx.fillStyle = 'rgba(180, 190, 210, 0.85)';
      ctx.beginPath();
      ctx.arc(p.x, p.y, Math.max(1.5, m.size * camera.zoom), 0, Math.PI * 2);
      ctx.fill();
      const r = Math.max(1.5, m.size * camera.zoom);
      if (r > 5) {
        ctx.save();
        ctx.translate(p.x, p.y);
        ctx.rotate(pseudo(m.x + m.y) * Math.PI);
        ctx.strokeStyle = 'rgba(55, 65, 85, 0.42)';
        ctx.lineWidth = Math.max(1, r * 0.08);
        regularPolygonPath(ctx, r * 0.55, 6, Math.PI / 6);
        ctx.stroke();
        ctx.fillStyle = 'rgba(35, 45, 62, 0.24)';
        ctx.beginPath();
        ctx.arc(-r * 0.28, -r * 0.18, r * 0.16, 0, Math.PI * 2);
        ctx.arc(r * 0.25, r * 0.22, r * 0.1, 0, Math.PI * 2);
        ctx.fill();
        ctx.restore();
      }
    }
    return super.render(now);
  }
}

export class AsteroidNode extends Node {
  // PUBLIC
  render(now) {
    const ctx = this.app.ctx;
    const camera = this.app.camera;
    const view = camera.getViewBounds();
    for (const a of this.app.state.world.asteroids) {
      if (a.amount <= 0) continue;
      if (a.x < view.minX - 50 || a.x > view.maxX + 50 || a.y < view.minY - 50 || a.y > view.maxY + 50) continue;
      const p = camera.worldToScreen(a.x, a.y);
      this.#drawAsteroid(p.x, p.y, a);
    }
    return super.render(now);
  }

  // PRIVATE
  #drawAsteroid(sx, sy, a) {
    const ctx = this.app.ctx;
    const zoom = this.app.camera.zoom;
    const r = a.size * zoom;
    if (r < 1.5) {
      ctx.fillStyle = this.app.catalog.minerals[a.mineral].color;
      ctx.globalAlpha = 0.7;
      ctx.fillRect(sx - 1, sy - 1, 2, 2);
      ctx.globalAlpha = 1;
      return;
    }
    const color = this.app.catalog.minerals[a.mineral].color;
    const n = 9;
    const points = [];
    for (let i = 0; i < n; i++) {
      const ang = (i / n) * Math.PI * 2;
      const wobble = 0.62 + 0.42 * pseudo(a.seed + i * 7);
      points.push([Math.cos(ang) * r * wobble, Math.sin(ang) * r * wobble]);
    }
    ctx.save();
    ctx.translate(sx, sy);
    polygonPath(ctx, points);
    ctx.fillStyle = 'rgba(52, 58, 76, 0.92)';
    ctx.fill();
    for (let i = 0; i < n; i++) {
      const [x1, y1] = points[i];
      const [x2, y2] = points[(i + 1) % n];
      polygonPath(ctx, [[0, 0], [x1 * 0.78, y1 * 0.78], [x2 * 0.78, y2 * 0.78]]);
      ctx.fillStyle = pseudo(a.seed + i * 23) > 0.5
        ? 'rgba(225, 235, 255, 0.11)'
        : 'rgba(8, 14, 24, 0.2)';
      ctx.fill();
      ctx.strokeStyle = 'rgba(190, 205, 225, 0.14)';
      ctx.lineWidth = Math.max(0.6, zoom);
      ctx.stroke();
    }
    polygonPath(ctx, points);
    // Mineral color intentionally marks the asteroid silhouette and core.
    ctx.lineWidth = Math.max(1, 2 * zoom);
    ctx.strokeStyle = color;
    ctx.stroke();
    ctx.globalAlpha = 0.8;
    regularPolygonPath(ctx, r * 0.25, 6, Math.PI / 6);
    ctx.fillStyle = color;
    ctx.fill();
    ctx.strokeStyle = 'rgba(225, 245, 255, 0.75)';
    ctx.lineWidth = Math.max(1, zoom);
    ctx.stroke();
    ctx.restore();
  }
}

export class StationNode extends Node {
  // PUBLIC
  render(now) {
    const ctx = this.app.ctx;
    const camera = this.app.camera;
    const zoom = camera.zoom;
    for (const st of this.app.state.world.stations) {
      const p = camera.worldToScreen(st.x, st.y);
      const r = 34 * zoom;
      ctx.save();
      ctx.translate(p.x, p.y);
      ctx.rotate(pseudo(st.x + st.y) * Math.PI);
      ctx.strokeStyle = 'rgba(110, 232, 138, 0.72)';
      ctx.lineWidth = Math.max(1, 2 * zoom);
      regularPolygonPath(ctx, r, 8, Math.PI / 8);
      ctx.stroke();
      ctx.strokeStyle = 'rgba(110, 232, 138, 0.4)';
      regularPolygonPath(ctx, r * 0.65, 6, 0);
      ctx.stroke();
      ctx.fillStyle = 'rgba(45, 150, 80, 0.3)';
      regularPolygonPath(ctx, r * 0.38, 6, Math.PI / 6);
      ctx.fill();
      ctx.strokeStyle = 'rgba(110, 232, 138, 0.6)';
      for (let i = 0; i < 4; i++) {
        const a = (i / 4) * Math.PI * 2 + Math.PI / 4;
        ctx.beginPath();
        ctx.moveTo(Math.cos(a) * r * 0.35, Math.sin(a) * r * 0.35);
        ctx.lineTo(Math.cos(a) * r * 0.68, Math.sin(a) * r * 0.68);
        ctx.lineTo(Math.cos(a) * r * 1.05, Math.sin(a) * r * 1.05);
        ctx.stroke();
        const podX = Math.cos(a) * r * 1.05;
        const podY = Math.sin(a) * r * 1.05;
        ctx.save();
        ctx.translate(podX, podY);
        ctx.rotate(a);
        ctx.fillStyle = 'rgba(25, 95, 55, 0.8)';
        ctx.fillRect(-r * 0.16, -r * 0.11, r * 0.32, r * 0.22);
        ctx.strokeRect(-r * 0.16, -r * 0.11, r * 0.32, r * 0.22);
        ctx.restore();
      }
      ctx.fillStyle = 'rgba(190, 255, 205, 0.95)';
      regularPolygonPath(ctx, r * 0.17, 4, Math.PI / 4);
      ctx.fill();
      ctx.restore();
    }
    return super.render(now);
  }
}

export class OutpostNode extends Node {
  // PUBLIC
  render(now) {
    const ctx = this.app.ctx;
    const camera = this.app.camera;
    const zoom = camera.zoom;
    for (const outpost of this.app.state.world.outposts || []) {
      const p = camera.worldToScreen(outpost.x, outpost.y);
      const r = 24 * zoom;
      ctx.save();
      ctx.translate(p.x, p.y);
      ctx.rotate(pseudo(outpost.x + outpost.y) * Math.PI);
      ctx.fillStyle = 'rgba(255, 176, 92, 0.16)';
      regularPolygonPath(ctx, r, 6, Math.PI / 6);
      ctx.fill();
      ctx.strokeStyle = 'rgba(255, 190, 110, 0.85)';
      ctx.lineWidth = Math.max(1.5, 2 * zoom);
      regularPolygonPath(ctx, r, 6, Math.PI / 6);
      ctx.stroke();
      ctx.strokeStyle = 'rgba(255, 190, 110, 0.52)';
      ctx.lineWidth = Math.max(1, zoom);
      regularPolygonPath(ctx, r * 0.62, 4, Math.PI / 4);
      ctx.stroke();
      for (let i = 0; i < 4; i++) {
        const angle = (i / 4) * Math.PI * 2 + Math.PI / 4;
        ctx.beginPath();
        ctx.moveTo(Math.cos(angle) * r * 0.24, Math.sin(angle) * r * 0.24);
        ctx.lineTo(Math.cos(angle) * r * 0.8, Math.sin(angle) * r * 0.8);
        ctx.stroke();
      }
      ctx.fillStyle = 'rgba(255, 214, 158, 0.95)';
      regularPolygonPath(ctx, r * 0.24, 4, Math.PI / 4);
      ctx.fill();
      ctx.restore();
    }
    return super.render(now);
  }
}

export class GateNode extends Node {
  // PUBLIC
  render(now) {
    const ctx = this.app.ctx;
    const camera = this.app.camera;
    const zoom = camera.zoom;
    const view = camera.getViewBounds();
    for (const g of this.app.state.world.gates || []) {
      if (g.x < view.minX - 120 || g.x > view.maxX + 120 || g.y < view.minY - 120 || g.y > view.maxY + 120) continue;
      const p = camera.worldToScreen(g.x, g.y);
      const r = 60 * zoom;
      const pulse = 0.6 + 0.4 * Math.sin(now / 500);
      ctx.save();
      ctx.translate(p.x, p.y);
      const glow = ctx.createRadialGradient(0, 0, 0, 0, 0, r * 1.8);
      glow.addColorStop(0, `rgba(124, 92, 255, ${0.5 * pulse})`);
      glow.addColorStop(1, 'rgba(124, 92, 255, 0)');
      ctx.fillStyle = glow;
      ctx.beginPath();
      ctx.arc(0, 0, r * 1.8, 0, Math.PI * 2);
      ctx.fill();
      ctx.strokeStyle = `rgba(180, 150, 255, ${0.8 * pulse})`;
      ctx.lineWidth = Math.max(1, 3 * zoom);
      regularPolygonPath(ctx, r, 8, Math.PI / 8);
      ctx.stroke();
      ctx.strokeStyle = 'rgba(220, 200, 255, 0.9)';
      ctx.lineWidth = Math.max(1, 1.5 * zoom);
      regularPolygonPath(ctx, r * 0.68, 6, Math.PI / 6);
      ctx.stroke();
      ctx.fillStyle = `rgba(180, 150, 255, ${0.2 * pulse})`;
      regularPolygonPath(ctx, r * 0.38, 4, Math.PI / 4);
      ctx.fill();
      ctx.strokeStyle = `rgba(220, 200, 255, ${0.5 * pulse})`;
      ctx.lineWidth = Math.max(1, zoom);
      for (let i = 0; i < 4; i++) {
        const a = i * Math.PI / 2 + Math.PI / 4;
        ctx.beginPath();
        ctx.moveTo(Math.cos(a) * r * 0.68, Math.sin(a) * r * 0.68);
        ctx.lineTo(Math.cos(a) * r * 1.18, Math.sin(a) * r * 1.18);
        ctx.stroke();
      }
      ctx.restore();
    }
    return super.render(now);
  }
}

export class EnemyNode extends Node {
  // PUBLIC
  render(now) {
    const ctx = this.app.ctx;
    const camera = this.app.camera;
    const view = camera.getViewBounds();
    for (const e of this.app.state.world.enemies) {
      if (!e.alive) continue;
      if (e.x < view.minX - 60 || e.x > view.maxX + 60 || e.y < view.minY - 60 || e.y > view.maxY + 60) continue;
      const p = camera.worldToScreen(e.x, e.y);
      this.#drawEnemyShip(p.x, p.y, e);
      if (e.id === this.app.targetEnemyId) {
        this.#drawTargetIndicator(p.x, p.y, e, now);
      }
    }
    return super.render(now);
  }

  // PRIVATE
  #drawTargetIndicator(sx, sy, enemy, now) {
    const ctx = this.app.ctx;
    const zoom = this.app.camera.zoom;
    const radius = (this.#enemySize(enemy.type) + 8) * zoom;
    const length = Math.min(radius * 0.55, 14 * zoom);
    const left = sx - radius;
    const right = sx + radius;
    const top = sy - radius;
    const bottom = sy + radius;
    const pulse = 0.5 + 0.5 * Math.sin(now / 420);

    ctx.save();
    ctx.beginPath();
    ctx.moveTo(left, top + length);
    ctx.lineTo(left, top);
    ctx.lineTo(left + length, top);
    ctx.moveTo(right - length, top);
    ctx.lineTo(right, top);
    ctx.lineTo(right, top + length);
    ctx.moveTo(right, bottom - length);
    ctx.lineTo(right, bottom);
    ctx.lineTo(right - length, bottom);
    ctx.moveTo(left + length, bottom);
    ctx.lineTo(left, bottom);
    ctx.lineTo(left, bottom - length);
    ctx.lineCap = 'round';
    ctx.strokeStyle = `rgba(255, 92, 122, ${0.2 + pulse * 0.12})`;
    ctx.lineWidth = 5 * zoom;
    ctx.stroke();
    ctx.strokeStyle = '#ff7891';
    ctx.lineWidth = Math.max(1.5, 1.8 * zoom);
    ctx.stroke();
    ctx.restore();
  }

  // PRIVATE
  #enemySize(type) {
    return type === 'dread' ? 26 : type === 'faction' ? 20 : type === 'gang' ? 16 : 13;
  }

  // PRIVATE
  #drawEnemyShip(sx, sy, e) {
    const ctx = this.app.ctx;
    const r = this.#enemySize(e.type) * this.app.camera.zoom;
    const hulls = {
      pirate: [[0, -1], [0.42, -0.22], [0.95, 0.3], [0.45, 0.25], [0, 0.76], [-0.45, 0.25], [-0.95, 0.3], [-0.42, -0.22]],
      gang: [[0, -1], [0.48, -0.42], [1, -0.18], [0.65, 0.15], [0.85, 0.55], [0.2, 0.42], [0, 0.85], [-0.2, 0.42], [-0.85, 0.55], [-0.65, 0.15], [-1, -0.18], [-0.48, -0.42]],
      faction: [[0, -1], [0.3, -0.42], [1, -0.48], [0.63, 0.02], [0.88, 0.6], [0.2, 0.38], [0, 0.82], [-0.2, 0.38], [-0.88, 0.6], [-0.63, 0.02], [-1, -0.48], [-0.3, -0.42]],
      dread: [[0, -1], [0.36, -0.6], [0.7, -0.45], [0.62, -0.05], [1, 0.32], [0.58, 0.48], [0.42, 0.85], [0, 0.64], [-0.42, 0.85], [-0.58, 0.48], [-1, 0.32], [-0.62, -0.05], [-0.7, -0.45], [-0.36, -0.6]],
    };
    const hull = hulls[e.type] || hulls.pirate;
    ctx.save();
    ctx.translate(sx, sy);
    ctx.rotate(pseudo(e.seed) * Math.PI * 2);
    polygonPath(ctx, hull.map(([x, y]) => [x * r, y * r]));
    ctx.fillStyle = 'rgba(120, 20, 40, 0.9)';
    ctx.fill();
    ctx.strokeStyle = 'rgba(255, 115, 140, 0.48)';
    ctx.lineWidth = Math.max(1, r * 0.08);
    polygonPath(ctx, hull.slice(0, Math.ceil(hull.length / 2)).map(([x, y]) => [x * r, y * r]));
    ctx.stroke();
    polygonPath(ctx, [[0, -r * 0.72], [r * 0.28, -r * 0.05], [0, r * 0.48], [-r * 0.28, -r * 0.05]]);
    ctx.fillStyle = 'rgba(255, 95, 125, 0.28)';
    ctx.fill();
    ctx.strokeStyle = '#ff5c7a';
    ctx.lineWidth = Math.max(1, 1.5 * this.app.camera.zoom);
    regularPolygonPath(ctx, r * 0.14, 4, Math.PI / 4);
    ctx.fillStyle = '#ff91a4';
    ctx.fill();
    ctx.stroke();
    ctx.restore();
  }

  // PUBLIC
  drawEnemyStatus(sx, sy, e, offsetY = 0) {
    const ctx = this.app.ctx;
    const zoom = this.app.camera.zoom;
    const radius = this.#enemySize(e.type) * zoom;
    const combat = this.app.state.combat;
    const liveCombat = combat && combat.enemyId === e.id ? combat : null;
    const enemyDef = this.app.catalog.enemies[e.type];
    const shieldMax = liveCombat
      ? liveCombat.enemyShieldMax
      : (e.shield ?? (enemyDef && enemyDef.shield) ?? 0);
    const hullMax = liveCombat
      ? liveCombat.enemyHullMax
      : (e.hull ?? (enemyDef && enemyDef.hull) ?? 0);
    const shield = liveCombat ? liveCombat.enemyShield : shieldMax;
    const hull = liveCombat ? liveCombat.enemyHull : hullMax;
    const name = (enemyDef && enemyDef.name) || e.type;
    const width = Math.max(42, Math.min(84, 66 * zoom));
    const top = sy - radius - 26 - offsetY;
    const label = Math.max(9, Math.min(12, 10 * zoom));
    const tierName = e.tierName || e.tier || '';
    const tierColor = TIER_COLORS[e.tier] || TIER_COLORS.standard;

    ctx.save();
    ctx.font = `600 ${label}px sans-serif`;
    ctx.textBaseline = 'middle';
    ctx.shadowColor = '#000';
    ctx.shadowBlur = 3;
    const tierText = tierName ? ` (${tierName})` : '';
    const nameWidth = ctx.measureText(name).width;
    const tierWidth = ctx.measureText(tierText).width;
    const left = sx - (nameWidth + tierWidth) / 2;
    ctx.textAlign = 'left';
    ctx.fillStyle = '#ffd7de';
    ctx.fillText(name, left, top, 150);
    if (tierText) {
      ctx.fillStyle = tierColor;
      ctx.fillText(tierText, left + nameWidth, top, 150);
    }
    ctx.shadowBlur = 0;
    this.#drawHealthBar(sx, top + 8, width, shieldMax > 0 ? shield / shieldMax : 0, '#4fd1ff');
    this.#drawHealthBar(sx, top + 14, width, hullMax > 0 ? hull / hullMax : 0, '#ff657a');
    ctx.restore();
  }

  // PRIVATE
  #drawHealthBar(cx, y, width, fraction, color) {
    const ctx = this.app.ctx;
    const x = cx - width / 2;
    ctx.fillStyle = 'rgba(0, 0, 0, 0.75)';
    ctx.fillRect(x, y, width, 4);
    ctx.fillStyle = color;
    ctx.fillRect(x, y, width * Math.max(0, Math.min(1, fraction)), 4);
    ctx.strokeStyle = 'rgba(255, 255, 255, 0.45)';
    ctx.lineWidth = 1;
    ctx.strokeRect(x, y, width, 4);
  }
}

class BackgroundNode extends Node {
  // PUBLIC
  render(now) {
    const ctx = this.app.ctx;
    const base = mixRgb({ r: 4, g: 6, b: 12 }, this.app.systemColor, 0.12);
    ctx.fillStyle = rgbStr(base);
    ctx.fillRect(0, 0, this.app.canvas.width, this.app.canvas.height);
    for (const blob of [
      { fx: 0.22, fy: 0.28, r: 0.55 },
      { fx: 0.8, fy: 0.5, r: 0.65 },
      { fx: 0.5, fy: 0.85, r: 0.5 },
    ]) {
      const cx = blob.fx * this.app.canvas.width;
      const cy = blob.fy * this.app.canvas.height;
      const radius = blob.r * Math.max(this.app.canvas.width, this.app.canvas.height);
      const gradient = ctx.createRadialGradient(cx, cy, 0, cx, cy, radius);
      gradient.addColorStop(0, rgbStr(this.app.systemColor, 0.11));
      gradient.addColorStop(1, rgbStr(this.app.systemColor, 0));
      ctx.fillStyle = gradient;
      ctx.fillRect(0, 0, this.app.canvas.width, this.app.canvas.height);
    }
    return super.render(now);
  }
}

class StarfieldNode extends Node {
  // PUBLIC
  constructor(app) {
    super(app);
    this.stars = [];
    this.generate();
  }

  // PUBLIC
  generate() {
    this.stars = Array.from({ length: STAR_COUNT }, () => ({
      x: Math.random() * STAR_TILE,
      y: Math.random() * STAR_TILE,
      size: 0.5 + Math.random() * 1.6,
      bright: 0.25 + Math.random() * 0.6,
    }));
  }

  // PUBLIC
  render(now) {
    const ctx = this.app.ctx;
    const camera = this.app.camera;
    const player = this.app.player;
    const parallax = 0.3;
    const offX = (((player.x * parallax) % STAR_TILE + STAR_TILE) % STAR_TILE) - camera.shakeX;
    const offY = (((player.y * parallax) % STAR_TILE + STAR_TILE) % STAR_TILE) - camera.shakeY;
    const cols = Math.ceil(this.app.canvas.width / STAR_TILE) + 1;
    const rows = Math.ceil(this.app.canvas.height / STAR_TILE) + 1;
    const starColor = rgbStr(mixRgb({ r: 207, g: 224, b: 255 }, this.app.systemColor, 0.5));
    for (let tx = -1; tx < cols; tx++) {
      for (let ty = -1; ty < rows; ty++) {
        const baseX = tx * STAR_TILE - offX;
        const baseY = ty * STAR_TILE - offY;
        for (const star of this.stars) {
          const sx = baseX + star.x;
          const sy = baseY + star.y;
          if (sx < -2 || sy < -2 || sx > this.app.canvas.width + 2 || sy > this.app.canvas.height + 2) continue;
          ctx.globalAlpha = star.bright;
          ctx.fillStyle = starColor;
          ctx.fillRect(sx, sy, star.size, star.size);
        }
      }
    }
    ctx.globalAlpha = 1;
    return super.render(now);
  }
}

class GridNode extends Node {
  // PUBLIC
  render(now) {
    const ctx = this.app.ctx;
    const camera = this.app.camera;
    const view = camera.getViewBounds();
    const step = 500;
    ctx.lineWidth = 1;
    ctx.strokeStyle = 'rgba(80, 120, 200, 0.08)';
    const startX = Math.floor(view.minX / step) * step;
    const endX = Math.ceil(view.maxX / step) * step;
    const startY = Math.floor(view.minY / step) * step;
    const endY = Math.ceil(view.maxY / step) * step;
    ctx.beginPath();
    for (let gx = startX; gx <= endX; gx += step) {
      const point = camera.worldToScreen(gx, 0);
      ctx.moveTo(point.x, 0);
      ctx.lineTo(point.x, this.app.canvas.height);
    }
    for (let gy = startY; gy <= endY; gy += step) {
      const point = camera.worldToScreen(0, gy);
      ctx.moveTo(0, point.y);
      ctx.lineTo(this.app.canvas.width, point.y);
    }
    ctx.stroke();
    return super.render(now);
  }
}

class BoundsNode extends Node {
  // PUBLIC
  render(now) {
    const ctx = this.app.ctx;
    const camera = this.app.camera;
    const topLeft = camera.worldToScreen(0, 0);
    const bottomRight = camera.worldToScreen(this.app.constants.worldSize, this.app.constants.worldSize);
    ctx.lineWidth = 2;
    ctx.strokeStyle = 'rgba(255, 92, 122, 0.35)';
    ctx.strokeRect(topLeft.x, topLeft.y, bottomRight.x - topLeft.x, bottomRight.y - topLeft.y);
    return super.render(now);
  }
}

class BackdropNode extends Node {
  // PUBLIC
  constructor(app) {
    super(app);
    this.add(new BackgroundNode());
    this.starfield = this.add(new StarfieldNode());
    this.add(new GridNode());
    this.add(new BoundsNode());
  }

  // PUBLIC
  generateStars() {
    this.starfield.generate();
  }
}

class SystemNode extends Node {
  // PUBLIC
  constructor(app) {
    super(app);
    this.add(new StarNode())
      .add(new BeltGroupNode(app))
      .add(new CelestialGroupNode(app))
      .add(new ResourceGroupNode(app))
      .add(new InfrastructureGroupNode(app));
  }
}

class BeltGroupNode extends Node {
  // PUBLIC
  constructor(app) {
    super(app);
    this.add(new BeltNode());
  }
}

class CelestialGroupNode extends Node {
  // PUBLIC
  constructor(app) {
    super(app);
    this.add(new PlanetNode()).add(new MoonNode());
  }
}

class ResourceGroupNode extends Node {
  // PUBLIC
  constructor(app) {
    super(app);
    this.add(new AsteroidNode());
  }
}

class InfrastructureGroupNode extends Node {
  // PUBLIC
  constructor(app) {
    super(app);
    this.add(new StationNode()).add(new OutpostNode()).add(new GateNode());
  }
}

class ActorsNode extends Node {
  // PUBLIC
  constructor(app) {
    super(app);
    this.enemy = this.add(new EnemyNode());
    this.player = this.add(new Player(app));
    this.ship = this.player.add(new ShipNode(app));
  }
}

class WorldLabelsNode extends Node {
  // PUBLIC
  render(now) {
    const app = this.app;
    const ctx = app.ctx;
    const camera = app.camera;
    const zoom = camera.zoom;
    const world = app.state.world;
    const labels = [];
    const add = (entity, text, color, y, kind = 'plain') => {
      const point = camera.worldToScreen(entity.x, entity.y);
      if (point.x < -100 || point.x > app.canvas.width + 100 ||
          point.y < -100 || point.y > app.canvas.height + 100) return;
      labels.push({ id: entity.id, x: point.x, y, text, color, kind, entity });
    };

    for (const belt of world.belts) {
      const asteroids = world.asteroids.filter((asteroid) => asteroid.beltId === belt.id);
      const remaining = asteroids.reduce((sum, asteroid) => sum + asteroid.amount, 0);
      const total = asteroids.reduce((sum, asteroid) => sum + (asteroid.maxAmount || asteroid.amount), 0);
      const percent = total > 0 ? Math.round((remaining / total) * 100) : 0;
      const point = camera.worldToScreen(belt.x, belt.y);
      add(belt, `${belt.name} ${percent}%`, '#b4bed2', point.y - 300 * zoom - 6);
    }
    for (const planet of world.planets) {
      const point = camera.worldToScreen(planet.x, planet.y);
      add(planet, planet.name, planet.color, point.y - planet.size * zoom - 8);
    }
    for (const moon of world.moons) {
      const point = camera.worldToScreen(moon.x, moon.y);
      add(moon, moon.name, '#b4bed2', point.y - moon.size * zoom - 8);
    }
    for (const station of world.stations) {
      const point = camera.worldToScreen(station.x, station.y);
      add(station, station.name, '#6ee88a', point.y - 34 * zoom - 8);
    }
    for (const outpost of world.outposts || []) {
      const point = camera.worldToScreen(outpost.x, outpost.y);
      add(outpost, outpost.name, '#ffd2a0', point.y - 24 * zoom - 8);
    }
    for (const gate of world.gates || []) {
      const target = (app.state.systemNames || []).find((system) => system.id === gate.targetSystemId);
      const point = camera.worldToScreen(gate.x, gate.y);
      add(gate, `Gate to ${target ? target.name : 'unknown system'}`,
        target && target.color ? target.color : '#c8b4ff', point.y - 60 * zoom - 8);
    }
    for (const enemy of world.enemies) {
      if (!enemy.alive) continue;
      const point = camera.worldToScreen(enemy.x, enemy.y);
      const radius = enemy.type === 'dread' ? 26 : enemy.type === 'faction' ? 20 : enemy.type === 'gang' ? 16 : 13;
      add({ ...enemy, labelPoint: point }, '', '', point.y - radius * zoom - 43, 'enemy');
    }

    labels.sort((left, right) => left.y - right.y || String(left.id).localeCompare(String(right.id)));
    const placed = [{ x: app.canvas.width / 2 - 30, y: app.canvas.height / 2 - 30, width: 60, height: 60 }];
    for (const label of labels) {
      const enemy = label.kind === 'enemy';
      ctx.font = enemy ? '600 11px sans-serif' : `${Math.max(9, Math.min(12, 11 * zoom))}px sans-serif`;
      const width = enemy ? 164 : Math.max(34, ctx.measureText(label.text).width + 12);
      const height = enemy ? 47 : 18;
      const baseTop = enemy ? label.y : label.y - 14;
      const x = Math.max(width / 2 + 4, Math.min(app.canvas.width - width / 2 - 4, label.x));
      let chosenTop = baseTop;
      let chosenRect = null;
      for (let attempt = 0; attempt < 18; attempt++) {
        const top = Math.max(4, baseTop - attempt * (height + 4));
        const rect = { x: x - width / 2, y: top, width, height };
        if (!placed.some((other) =>
          rect.x < other.x + other.width + 4 && rect.x + rect.width + 4 > other.x &&
          rect.y < other.y + other.height + 3 && rect.y + rect.height + 3 > other.y
        )) {
          chosenTop = top;
          chosenRect = rect;
          break;
        }
      }
      if (!chosenRect) chosenRect = { x: x - width / 2, y: chosenTop, width, height };
      placed.push(chosenRect);
      if (enemy) {
        const offset = baseTop - chosenTop;
        app.world.actors.enemy.drawEnemyStatus(x, label.entity.labelPoint.y, label.entity, offset);
        continue;
      }
      ctx.save();
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.font = `${Math.max(9, Math.min(12, 11 * zoom))}px sans-serif`;
      ctx.fillStyle = 'rgba(5, 9, 17, 0.82)';
      ctx.fillRect(x - width / 2, chosenTop, width, height);
      ctx.strokeStyle = `${label.color}70`;
      ctx.lineWidth = 1;
      ctx.strokeRect(x - width / 2, chosenTop, width, height);
      ctx.fillStyle = label.color;
      ctx.shadowColor = '#000';
      ctx.shadowBlur = 3;
      ctx.fillText(label.text, x, chosenTop + height / 2);
      ctx.restore();
    }
    return super.render(now);
  }
}

class WorldEffectsNode extends Node {
  // PUBLIC
  constructor(app) {
    super(app);
    this.combat = this.add(new CombatNode());
    this.add(new EffectsNode());
  }
}

export class WorldNode extends Node {
  // PUBLIC
  constructor(app) {
    super(app);
    this.backdrop = this.add(new BackdropNode(app));
    this.system = this.add(new SystemNode(app));
    this.actors = this.add(new ActorsNode(app));
    this.effects = this.add(new WorldEffectsNode(app));
    this.labels = this.add(new WorldLabelsNode(app));
    this.player = this.actors.player;
    this.ship = this.actors.ship;
  }

  // PUBLIC
  genStars() {
    this.backdrop.generateStars();
  }

  // PUBLIC
  captureDockBackground(excludedNode) {
    const canvas = document.createElement('canvas');
    canvas.width = this.app.canvas.width;
    canvas.height = this.app.canvas.height;
    const context = canvas.getContext('2d');
    if (!context) throw new Error('Unable to create a canvas for the station background');

    const previousCanvas = this.app.canvas;
    const previousContext = this.app.ctx;
    const previousVisibility = excludedNode ? excludedNode.visible : true;
    this.app.canvas = canvas;
    this.app.ctx = context;
    if (excludedNode) excludedNode.visible = false;
    try {
      this.render(performance.now());
      return canvas.toDataURL();
    } finally {
      this.app.canvas = previousCanvas;
      this.app.ctx = previousContext;
      if (excludedNode) excludedNode.visible = previousVisibility;
    }
  }
}
