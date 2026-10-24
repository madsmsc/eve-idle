'use strict';

// Cosmetic full-screen effects drawn on top of the world: the warp tunnel and
// the jump-gate effect. Both are driven by performance.now() stamps on the app
// (app.warpFx / app.gateFx) that are set on every warp / gate jump, so those
// transitions always feel weighty and consistent, never an instant cut. A gate
// jump plays the warp tunnel *plus* its own gate effect on top, so jumping
// reads as a different motion than plain warping.
import { Node } from '../core/node.js';

export class EffectsNode extends Node {
  // PUBLIC
  render(now) {
    const ctx = this.app.ctx;
    const w = this.app.canvas.width;
    const h = this.app.canvas.height;
    const cx = w / 2;
    const cy = h / 2;
    if (this.app.warpFx) this.#drawWarpTunnel(ctx, now, cx, cy, w, h);
    if (this.app.gateFx) this.#drawGate(ctx, now, cx, cy, w, h);
    return super.render(now);
  }

  // PRIVATE
  // The standard warp: a bright flash that collapses toward the viewer plus
  // streaks racing outward from the centre, fading over ~650ms.
  #drawWarpTunnel(ctx, now, cx, cy, w, h) {
    const t = (now - this.app.warpFx) / 650;
    if (t >= 1) {
      this.app.warpFx = 0;
      return;
    }
    const fade = 1 - t;
    ctx.save();
    const grad = ctx.createRadialGradient(cx, cy, 0, cx, cy, Math.max(w, h) * 0.9);
    grad.addColorStop(0, `rgba(200, 235, 255, ${0.3 * fade})`);
    grad.addColorStop(0.55, `rgba(120, 180, 255, ${0.45 * fade})`);
    grad.addColorStop(1, 'rgba(60, 90, 160, 0)');
    ctx.fillStyle = grad;
    ctx.fillRect(0, 0, w, h);
    ctx.strokeStyle = `rgba(140, 200, 255, ${0.5 * fade})`;
    ctx.lineWidth = 1.5;
    const grow = 40 + 260 * t;
    for (let i = 0; i < 26; i++) {
      const a = (i / 26) * Math.PI * 2;
      const dx = Math.cos(a);
      const dy = Math.sin(a);
      ctx.beginPath();
      ctx.moveTo(cx + dx * (80 * fade), cy + dy * (80 * fade));
      ctx.lineTo(cx + dx * (80 + grow), cy + dy * (80 + grow));
      ctx.stroke();
    }
    ctx.restore();
  }

  // PRIVATE
  // The jump-gate: teal light columns spreading apart (the gate "opening") over
  // an expanding ring, layered on top of the warp tunnel. Distinctly vertical
  // and green, so jumping never looks like plain warping.
  #drawGate(ctx, now, cx, cy, w, h) {
    const t = (now - this.app.gateFx) / 900;
    if (t >= 1) {
      this.app.gateFx = 0;
      return;
    }
    const fade = 1 - t;
    const spread = 70 + 500 * t;
    ctx.save();
    // A soft teal wash so the gate reads green against the blue warp.
    ctx.fillStyle = `rgba(70, 230, 190, ${0.14 * fade})`;
    ctx.fillRect(0, 0, w, h);
    // The two gate pylons sliding apart.
    ctx.strokeStyle = `rgba(120, 255, 215, ${0.9 * fade})`;
    ctx.lineWidth = 3;
    ctx.beginPath();
    ctx.moveTo(cx - spread, 0);
    ctx.lineTo(cx - spread, h);
    ctx.moveTo(cx + spread, 0);
    ctx.lineTo(cx + spread, h);
    ctx.stroke();
    // Inner chevron bars travelling out from the pylons.
    ctx.strokeStyle = `rgba(160, 255, 230, ${0.5 * fade})`;
    ctx.lineWidth = 1.5;
    const chevron = spread * 0.6;
    for (let i = 0; i < 4; i++) {
      const inset = 90 + 340 * t;
      ctx.beginPath();
      ctx.moveTo(cx - chevron - i * 6, cy - inset - 40);
      ctx.lineTo(cx - chevron - i * 6, cy + inset + 40);
      ctx.moveTo(cx + chevron + i * 6, cy - inset - 40);
      ctx.lineTo(cx + chevron + i * 6, cy + inset + 40);
      ctx.stroke();
    }
    // An expanding ring at the jump point.
    ctx.strokeStyle = `rgba(140, 255, 225, ${0.55 * fade})`;
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.arc(cx, cy, 40 + 540 * t, 0, Math.PI * 2);
    ctx.stroke();
    ctx.restore();
  }
}
