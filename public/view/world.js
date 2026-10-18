'use strict';

// The world scene: the starfield, grid, world bounds, and the celestial +
// entity nodes that make up the system. Each node renders itself (in insertion
// order = draw order) and recurses into its children.
import { Node } from '../core/node.js';
import { pseudo, dist, mixRgb, rgbStr } from '../core/util.js';

const STAR_TILE = 1500;
const STAR_COUNT = 170;

export class StarNode extends Node {
  render(now) {
    console.log('rendering');
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
  render(now) {
    const ctx = this.app.ctx;
    const camera = this.app.camera;
    const zoom = camera.zoom;
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
      ctx.fillStyle = 'rgba(150, 175, 220, 0.7)';
      ctx.font = `${Math.max(9, 11 * zoom)}px sans-serif`;
      ctx.textAlign = 'center';
      ctx.fillText(b.name, p.x, p.y - r - 6);
    }
    return super.render(now);
  }
}

export class PlanetNode extends Node {
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
      }
      const g = ctx.createRadialGradient(-r * 0.3, -r * 0.3, r * 0.2, 0, 0, r);
      g.addColorStop(0, pl.color);
      g.addColorStop(1, 'rgba(0,0,0,0.55)');
      ctx.fillStyle = g;
      ctx.beginPath();
      ctx.arc(0, 0, r, 0, Math.PI * 2);
      ctx.fill();
      ctx.restore();
    }
    return super.render(now);
  }
}

export class MoonNode extends Node {
  render(now) {
    const ctx = this.app.ctx;
    const camera = this.app.camera;
    for (const m of this.app.state.world.moons) {
      const p = camera.worldToScreen(m.x, m.y);
      ctx.fillStyle = 'rgba(180, 190, 210, 0.85)';
      ctx.beginPath();
      ctx.arc(p.x, p.y, Math.max(1.5, m.size * camera.zoom), 0, Math.PI * 2);
      ctx.fill();
    }
    return super.render(now);
  }
}

export class AsteroidNode extends Node {
  render(now) {
    const ctx = this.app.ctx;
    const camera = this.app.camera;
    const view = camera.getViewBounds();
    for (const a of this.app.state.world.asteroids) {
      if (a.amount <= 0) continue;
      if (a.x < view.minX - 50 || a.x > view.maxX + 50 || a.y < view.minY - 50 || a.y > view.maxY + 50) continue;
      const p = camera.worldToScreen(a.x, a.y);
      this.drawAsteroid(p.x, p.y, a);
    }
    return super.render(now);
  }

  drawAsteroid(sx, sy, a) {
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
    const n = 8;
    ctx.beginPath();
    for (let i = 0; i < n; i++) {
      const ang = (i / n) * Math.PI * 2;
      const wobble = 0.72 + 0.34 * pseudo(a.seed + i * 7);
      const px = sx + Math.cos(ang) * r * wobble;
      const py = sy + Math.sin(ang) * r * wobble;
      if (i === 0) ctx.moveTo(px, py);
      else ctx.lineTo(px, py);
    }
    ctx.closePath();
    ctx.fillStyle = 'rgba(52, 58, 76, 0.92)';
    ctx.fill();
    ctx.lineWidth = Math.max(1, 2 * zoom);
    ctx.strokeStyle = color;
    ctx.stroke();
    ctx.globalAlpha = 0.85;
    ctx.beginPath();
    ctx.arc(sx, sy, r * 0.32, 0, Math.PI * 2);
    ctx.fillStyle = color;
    ctx.fill();
    ctx.globalAlpha = 1;
  }
}

export class StationNode extends Node {
  render(now) {
    const ctx = this.app.ctx;
    const camera = this.app.camera;
    const zoom = camera.zoom;
    for (const st of this.app.state.world.stations) {
      const p = camera.worldToScreen(st.x, st.y);
      const r = 34 * zoom;
      ctx.save();
      ctx.translate(p.x, p.y);
      ctx.strokeStyle = 'rgba(120, 200, 255, 0.7)';
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.arc(0, 0, r, 0, Math.PI * 2);
      ctx.stroke();
      ctx.strokeStyle = 'rgba(120, 200, 255, 0.35)';
      ctx.beginPath();
      ctx.arc(0, 0, r * 0.6, 0, Math.PI * 2);
      ctx.stroke();
      ctx.strokeStyle = 'rgba(120, 200, 255, 0.6)';
      for (let i = 0; i < 4; i++) {
        const a = (i / 4) * Math.PI * 2 + Math.PI / 4;
        ctx.beginPath();
        ctx.moveTo(Math.cos(a) * r * 0.6, Math.sin(a) * r * 0.6);
        ctx.lineTo(Math.cos(a) * r * 1.15, Math.sin(a) * r * 1.15);
        ctx.stroke();
      }
      ctx.fillStyle = 'rgba(120, 200, 255, 0.9)';
      ctx.font = `${Math.max(10, 12 * zoom)}px sans-serif`;
      ctx.textAlign = 'center';
      ctx.fillText(st.name, 0, r + 18 * zoom);
      ctx.restore();
    }
    return super.render(now);
  }
}

export class GateNode extends Node {
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
      ctx.lineWidth = 3 * zoom;
      ctx.beginPath();
      ctx.arc(0, 0, r, 0, Math.PI * 2);
      ctx.stroke();
      ctx.strokeStyle = 'rgba(220, 200, 255, 0.9)';
      ctx.lineWidth = 1.5 * zoom;
      ctx.beginPath();
      ctx.arc(0, 0, r * 0.7, 0, Math.PI * 2);
      ctx.stroke();
      const target = (this.app.state.systemNames || []).find((s) => s.id === g.targetSystemId);
      ctx.fillStyle = target && target.color ? target.color : 'rgba(200, 180, 255, 0.9)';
      ctx.font = `${Math.max(9, 11 * zoom)}px sans-serif`;
      ctx.textAlign = 'center';
      ctx.fillText('Gate → ' + (target ? target.name : '?'), 0, r + 18 * zoom);
      ctx.restore();
    }
    return super.render(now);
  }
}

export class EnemyNode extends Node {
  render(now) {
    const ctx = this.app.ctx;
    const camera = this.app.camera;
    const view = camera.getViewBounds();
    for (const e of this.app.state.world.enemies) {
      if (!e.alive) continue;
      if (e.x < view.minX - 60 || e.x > view.maxX + 60 || e.y < view.minY - 60 || e.y > view.maxY + 60) continue;
      const p = camera.worldToScreen(e.x, e.y);
      this.drawEnemyShip(p.x, p.y, e);
      if (e.id === this.app.targetEnemyId) {
        const r = (this.enemySize(e.type) + 8) * camera.zoom;
        ctx.strokeStyle = '#ff5c7a';
        ctx.lineWidth = 1.5;
        ctx.strokeRect(p.x - r, p.y - r, r * 2, r * 2);
      }
    }
    return super.render(now);
  }

  enemySize(type) {
    return type === 'dread' ? 26 : type === 'faction' ? 20 : type === 'gang' ? 16 : 13;
  }

  drawEnemyShip(sx, sy, e) {
    const ctx = this.app.ctx;
    const r = this.enemySize(e.type) * this.app.camera.zoom;
    ctx.save();
    ctx.translate(sx, sy);
    ctx.rotate(pseudo(e.seed) * Math.PI * 2);
    ctx.beginPath();
    ctx.moveTo(0, -r);
    ctx.lineTo(r * 0.8, r * 0.7);
    ctx.lineTo(0, r * 0.3);
    ctx.lineTo(-r * 0.8, r * 0.7);
    ctx.closePath();
    ctx.fillStyle = 'rgba(120, 20, 40, 0.9)';
    ctx.fill();
    ctx.lineWidth = Math.max(1, 1.5 * this.app.camera.zoom);
    ctx.strokeStyle = '#ff5c7a';
    ctx.stroke();
    ctx.restore();
  }
}

export class WorldNode extends Node {
  constructor(app) {
    super(app);
    this.stars = [];
  }

  // The starfield tiles across the view, parallax-scrolled behind the world.
  genStars() {
    this.stars = [];
    for (let i = 0; i < STAR_COUNT; i++) {
      this.stars.push({
        x: Math.random() * STAR_TILE,
        y: Math.random() * STAR_TILE,
        size: 0.5 + Math.random() * 1.6,
        bright: 0.25 + Math.random() * 0.6,
      });
    }
  }

  drawStars() {
    const ctx = this.app.ctx;
    const camera = this.app.camera;
    const player = this.app.player;
    const parallax = 0.3;
    const offX = (((player.x * parallax) % STAR_TILE + STAR_TILE) % STAR_TILE) - camera.shakeX;
    const offY = (((player.y * parallax) % STAR_TILE + STAR_TILE) % STAR_TILE) - camera.shakeY;
    const cols = Math.ceil(this.app.canvas.width / STAR_TILE) + 1;
    const rows = Math.ceil(this.app.canvas.height / STAR_TILE) + 1;
    const starCol = rgbStr(mixRgb({ r: 207, g: 224, b: 255 }, this.app.systemColor, 0.5));
    for (let tx = -1; tx < cols; tx++) {
      for (let ty = -1; ty < rows; ty++) {
        const baseX = tx * STAR_TILE - offX;
        const baseY = ty * STAR_TILE - offY;
        for (const s of this.stars) {
          const sx = baseX + s.x;
          const sy = baseY + s.y;
          if (sx < -2 || sy < -2 || sx > this.app.canvas.width + 2 || sy > this.app.canvas.height + 2) continue;
          ctx.globalAlpha = s.bright;
          ctx.fillStyle = starCol;
          ctx.fillRect(sx, sy, s.size, s.size);
        }
      }
    }
    ctx.globalAlpha = 1;
  }

  renderBackground() {
    const ctx = this.app.ctx;
    const base = mixRgb({ r: 4, g: 6, b: 12 }, this.app.systemColor, 0.12);
    ctx.fillStyle = rgbStr(base);
    ctx.fillRect(0, 0, this.app.canvas.width, this.app.canvas.height);
    const blobs = [
      { fx: 0.22, fy: 0.28, r: 0.55 },
      { fx: 0.8, fy: 0.5, r: 0.65 },
      { fx: 0.5, fy: 0.85, r: 0.5 },
    ];
    for (const b of blobs) {
      const cx = b.fx * this.app.canvas.width;
      const cy = b.fy * this.app.canvas.height;
      const rad = b.r * Math.max(this.app.canvas.width, this.app.canvas.height);
      const g = ctx.createRadialGradient(cx, cy, 0, cx, cy, rad);
      g.addColorStop(0, rgbStr(this.app.systemColor, 0.11));
      g.addColorStop(1, rgbStr(this.app.systemColor, 0));
      ctx.fillStyle = g;
      ctx.fillRect(0, 0, this.app.canvas.width, this.app.canvas.height);
    }
  }

  drawGrid() {
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
      const p = camera.worldToScreen(gx, 0);
      ctx.moveTo(p.x, 0);
      ctx.lineTo(p.x, this.app.canvas.height);
    }
    for (let gy = startY; gy <= endY; gy += step) {
      const p = camera.worldToScreen(0, gy);
      ctx.moveTo(0, p.y);
      ctx.lineTo(this.app.canvas.width, p.y);
    }
    ctx.stroke();
  }

  drawWorldBounds() {
    const ctx = this.app.ctx;
    const camera = this.app.camera;
    const tl = camera.worldToScreen(0, 0);
    const br = camera.worldToScreen(this.app.constants.worldSize, this.app.constants.worldSize);
    ctx.lineWidth = 2;
    ctx.strokeStyle = 'rgba(255, 92, 122, 0.35)';
    ctx.strokeRect(tl.x, tl.y, br.x - tl.x, br.y - tl.y);
  }

  update(dt) {
    return super.update(dt);
  }

  render(now) {
    this.renderBackground();
    this.drawStars();
    this.drawGrid();
    this.drawWorldBounds();
    return super.render(now);
  }
}
