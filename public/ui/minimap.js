'use strict';

// Screen-space minimap, rendered on its own small canvas.
import { Node } from '../core/node.js';
import { mixRgb, rgbStr } from '../core/util.js';

export class MinimapNode extends Node {
  // TODO: where's the update function? there is not state updating of the minimap? zoom/show/hide/etc.?
  // TODO: too big render method - break down into smaller functions
  render(now) {
    const w = this.app.minimap.width;
    const h = this.app.minimap.height;
    const sc = w / this.app.constants.worldSize;
    const mctx = this.app.mctx;
    const state = this.app.state;
    mctx.clearRect(0, 0, w, h);
    mctx.fillStyle = rgbStr(mixRgb({ r: 6, g: 10, b: 20 }, this.app.systemColor, 0.2), 0.9);
    mctx.fillRect(0, 0, w, h);
    const star = state.world.star;
    mctx.fillStyle = '#ffd27a';
    mctx.beginPath();
    mctx.arc(star.x * sc, star.y * sc, 3, 0, Math.PI * 2);
    mctx.fill();
    for (const pl of state.world.planets) {
      mctx.fillStyle = pl.color;
      mctx.beginPath();
      mctx.arc(pl.x * sc, pl.y * sc, 2.5, 0, Math.PI * 2);
      mctx.fill();
    }
    mctx.fillStyle = '#b4bed2';
    for (const m of state.world.moons) mctx.fillRect(m.x * sc - 1, m.y * sc - 1, 2, 2);
    for (const a of state.world.asteroids) {
      if (a.amount <= 0) continue;
      mctx.fillStyle = this.app.catalog.minerals[a.mineral].color;
      mctx.globalAlpha = 0.8;
      mctx.fillRect(a.x * sc - 1, a.y * sc - 1, 2, 2);
    }
    mctx.globalAlpha = 1;
    mctx.fillStyle = '#78c8ff';
    for (const st of state.world.stations) mctx.fillRect(st.x * sc - 2, st.y * sc - 2, 4, 4);
    mctx.fillStyle = '#7c5cff';
    for (const g of state.world.gates || []) {
      mctx.save();
      mctx.translate(g.x * sc, g.y * sc);
      mctx.rotate(Math.PI / 4);
      mctx.fillRect(-2.5, -2.5, 5, 5);
      mctx.restore();
    }
    for (const e of state.world.enemies) {
      if (!e.alive) continue;
      mctx.fillStyle = '#ff5c7a';
      mctx.fillRect(e.x * sc - 1.5, e.y * sc - 1.5, 3, 3);
    }
    mctx.fillStyle = '#4fd1ff';
    mctx.beginPath();
    mctx.arc(this.app.player.x * sc, this.app.player.y * sc, 3, 0, Math.PI * 2);
    mctx.fill();
    return super.render(now);
  }
}
