'use strict';

// Whole-system minimap. It redraws current world/player state every frame;
// camera zoom does not affect its fixed scale.
import { Node } from '../core/node.js';
import { renderEdgeMap } from './edge-map.js';

export class MinimapNode extends Node {
  // PUBLIC
  render(now) {
    const w = this.app.minimap.width;
    const h = this.app.minimap.height;
    const sc = w / this.app.constants.worldSize;
    const state = this.app.state;

    this.#drawBackground(this.app.mctx, w, h);
    this.#drawWorld(state, sc);
    this.#drawPlayer(sc);
    renderEdgeMap(this.app, now);
    return super.render(now);
  }

  // PRIVATE
  #drawBackground(ctx, width, height) {
    ctx.clearRect(0, 0, width, height);
  }

  // PRIVATE
  #drawWorld(state, scale) {
    const ctx = this.app.mctx;
    const world = state.world;
    const star = world.star;
    ctx.fillStyle = '#ffd27a';
    ctx.beginPath();
    ctx.arc(star.x * scale, star.y * scale, 3, 0, Math.PI * 2);
    ctx.fill();
    for (const pl of world.planets) {
      ctx.fillStyle = pl.color;
      ctx.beginPath();
      ctx.arc(pl.x * scale, pl.y * scale, 2.5, 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.fillStyle = '#b4bed2';
    for (const m of world.moons) ctx.fillRect(m.x * scale - 1, m.y * scale - 1, 2, 2);
    for (const a of world.asteroids) {
      if (a.amount <= 0) continue;
      ctx.fillStyle = this.app.catalog.minerals[a.mineral].color;
      ctx.globalAlpha = 0.8;
      ctx.fillRect(a.x * scale - 1, a.y * scale - 1, 2, 2);
    }
    ctx.globalAlpha = 1;
    ctx.fillStyle = '#78c8ff';
    for (const st of world.stations) ctx.fillRect(st.x * scale - 2, st.y * scale - 2, 4, 4);
    ctx.fillStyle = '#ffb45c';
    for (const outpost of world.outposts || []) ctx.fillRect(outpost.x * scale - 2, outpost.y * scale - 2, 4, 4);
    ctx.fillStyle = '#7c5cff';
    for (const g of world.gates || []) {
      ctx.save();
      ctx.translate(g.x * scale, g.y * scale);
      ctx.rotate(Math.PI / 4);
      ctx.fillRect(-2.5, -2.5, 5, 5);
      ctx.restore();
    }
    for (const e of world.enemies) {
      if (!e.alive) continue;
      ctx.fillStyle = '#ff5c7a';
      ctx.fillRect(e.x * scale - 1.5, e.y * scale - 1.5, 3, 3);
    }
  }

  // PRIVATE
  #drawPlayer(scale) {
    const ctx = this.app.mctx;
    ctx.fillStyle = '#4fd1ff';
    ctx.beginPath();
    ctx.arc(this.app.player.x * scale, this.app.player.y * scale, 3, 0, Math.PI * 2);
    ctx.fill();
  }
}
