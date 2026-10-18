'use strict';

// Cosmetic full-screen effects drawn on top of the world (currently the warp /
// gate-jump flash). Driven by app.warpFx (a performance.now() stamp of the
// last warp/jump).
import { Node } from '../core/node.js';

export class EffectsNode extends Node {
  render(now) {
    const ctx = this.app.ctx;
    if (!this.app.warpFx) return super.render(now);
    const t = (now - this.app.warpFx) / 350;
    if (t >= 1) {
      this.app.warpFx = 0;
      return super.render(now);
    }
    ctx.save();
    ctx.fillStyle = `rgba(120, 200, 255, ${(1 - t) * 0.5})`;
    ctx.fillRect(0, 0, this.app.canvas.width, this.app.canvas.height);
    ctx.restore();
    return super.render(now);
  }
}
