'use strict';

// The view camera. Owns zoom, screen shake, and the world<->screen transforms.
// It reads the player's position from app.player (the camera follows the ship).
import { clamp } from './util.js';

export class Camera {
  // PUBLIC
  constructor(app) {
    this.app = app;
    this.zoom = 1.0;
    this.shake = 0;
    this.shakeX = 0;
    this.shakeY = 0;
  }

  // PUBLIC
  update(dt) {
    if (this.shake > 0) {
      this.shake = Math.max(0, this.shake - dt * 3);
      if (this.shake <= 0) {
        this.shakeX = 0;
        this.shakeY = 0;
      } else {
        const a = this.shake * 10;
        this.shakeX = (Math.random() * 2 - 1) * a;
        this.shakeY = (Math.random() * 2 - 1) * a;
      }
    } else {
      this.shakeX = 0;
      this.shakeY = 0;
    }
  }

  // PUBLIC
  addShake(amount) {
    this.shake = Math.min(2, this.shake + amount);
  }

  // PUBLIC
  worldToScreen(wx, wy) {
    const player = this.app.player;
    return {
      x: (wx - player.x) * this.zoom + this.app.canvas.width / 2 + this.shakeX,
      y: (wy - player.y) * this.zoom + this.app.canvas.height / 2 + this.shakeY,
    };
  }

  // PUBLIC
  screenToWorld(sx, sy) {
    const player = this.app.player;
    return {
      x: (sx - this.app.canvas.width / 2) / this.zoom + player.x,
      y: (sy - this.app.canvas.height / 2) / this.zoom + player.y,
    };
  }

  // PUBLIC
  getViewBounds() {
    const hw = this.app.canvas.width / 2 / this.zoom;
    const hh = this.app.canvas.height / 2 / this.zoom;
    const player = this.app.player;
    return { minX: player.x - hw, maxX: player.x + hw, minY: player.y - hh, maxY: player.y + hh };
  }

  // Zoom the view around a factor step, clamped to [0.4, 2.2].
  // PUBLIC
  scale(factor) {
    this.zoom = clamp(this.zoom * factor, 0.4, 2.2);
  }
}
