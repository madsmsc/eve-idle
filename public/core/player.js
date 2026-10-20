'use strict';

// The active ship's client-authoritative motion. The server owns position
// truth; this is the smooth local interpolation between syncs plus the
// click-to-move destination. It also answers proximity queries ("what is near
// me?") used by the HUD, autopilot and input.
//
// It is a scene-graph node (the ship's "body"): its update() runs from the tree
// via root.update(dt), alongside the render nodes.
import { Node } from './node.js';
import { clamp, dist } from './util.js';

export class Player extends Node {
  constructor(app) {
    super(app);
    this.x = 0;
    this.y = 0;
    this.vx = 0;
    this.vy = 0;
    this.heading = 0;
    this.destination = null;
  }

  setDestination(x, y) {
    this.destination = { x, y };
  }

  // Snap to a server-authoritative position (warp / jump / respawn).
  snap(x, y) {
    this.x = x;
    this.y = y;
    this.vx = 0;
    this.vy = 0;
    this.destination = null;
  }

  clampToWorld() {
    const C = this.app.constants;
    this.x = clamp(this.x, 0, C.worldSize);
    this.y = clamp(this.y, 0, C.worldSize);
  }

  update(dt) {
    const C = this.app.constants;
    const state = this.app.state;
    const inCombat = !!state.combat;
    if (inCombat) {
      this.vx *= 0.9;
      this.vy *= 0.9;
      this.x += this.vx * dt;
      this.y += this.vy * dt;
      this.clampToWorld();
      return;
    }

    if (this.destination) {
      const dx = this.destination.x - this.x;
      const dy = this.destination.y - this.y;
      const d = Math.hypot(dx, dy);
      if (d < C.arriveRadius) {
        this.destination = null;
      } else {
        const desired = Math.min(C.maxSpeed, d * 0.6);
        const steer = Math.min(1, dt * 2.2);
        this.vx += ((dx / d) * desired - this.vx) * steer;
        this.vy += ((dy / d) * desired - this.vy) * steer;
      }
    }

    const damp = Math.pow(C.damping, dt * 60);
    this.vx *= damp;
    this.vy *= damp;
    const sp = Math.hypot(this.vx, this.vy);
    if (sp > C.maxSpeed) {
      this.vx = (this.vx / sp) * C.maxSpeed;
      this.vy = (this.vy / sp) * C.maxSpeed;
    }
    this.x += this.vx * dt;
    this.y += this.vy * dt;
    this.clampToWorld();
    if (sp > 4) this.heading = Math.atan2(this.vy, this.vx);
  }

  // Idle convenience: when the cargo hold is full, automatically fly home to
  // the nearest station to dump it. Skipped during combat and while inbound.
  maybeAutoRecall() {
    const state = this.app.state;
    if (state.combat) return;
    if (!state.cargoFull) return;
    const ns = this.nearestStation();
    if (!ns) return;
    if (ns.d < this.app.constants.dockRange) return; // already at a station
    if (this.destination) {
      const inbound = state.world.stations.some(
        (st) => dist(st.x, st.y, this.destination.x, this.destination.y) < 80
      );
      if (inbound) return;
    }
    this.destination = { x: ns.station.x, y: ns.station.y };
  }

  // ---- proximity queries ----

  nearestAsteroid() {
    const state = this.app.state;
    let best = null;
    let bd = Infinity;
    for (const a of state.world.asteroids) {
      if (a.amount <= 0) continue;
      const d = dist(a.x, a.y, this.x, this.y);
      if (d <= this.app.constants.miningRange && d < bd) {
        bd = d;
        best = a;
      }
    }
    return best;
  }

  nearestEnemyInRange() {
    const state = this.app.state;
    let best = null;
    let bd = Infinity;
    for (const e of state.world.enemies) {
      if (!e.alive) continue;
      const d = dist(e.x, e.y, this.x, this.y);
      if (d <= this.app.constants.engageRange && d < bd) {
        bd = d;
        best = e;
      }
    }
    return best;
  }

  nearestStation() {
    const state = this.app.state;
    let best = null;
    let bd = Infinity;
    for (const st of state.world.stations) {
      const d = dist(this.x, this.y, st.x, st.y);
      if (d < bd) {
        bd = d;
        best = st;
      }
    }
    return best ? { station: best, d: bd } : null;
  }

  nearestGate() {
    const state = this.app.state;
    let best = null;
    let bd = Infinity;
    for (const g of state.world.gates || []) {
      const d = dist(g.x, g.y, this.x, this.y);
      if (d <= (this.app.constants.gateRange || 320) && d < bd) {
        bd = d;
        best = g;
      }
    }
    return best;
  }

  nearestPoiOf(kind) {
    const w = this.app.state.world;
    let list = [];
    if (kind === 'belt') list = w.belts;
    else if (kind === 'station') list = w.stations;
    else if (kind === 'rat') list = w.enemies.filter((e) => e.alive);
    let best = null;
    let bd = Infinity;
    for (const p of list) {
      const d = dist(p.x, p.y, this.x, this.y);
      if (d < bd) {
        bd = d;
        best = p;
      }
    }
    return best;
  }

  // Name the POI nearest to a world point (used to label travel destinations).
  poiLabel(x, y) {
    const w = this.app.state.world;
    const catalog = this.app.catalog;
    const cands = [{ x: w.star.x, y: w.star.y, name: w.star.name }];
    for (const pl of w.planets) cands.push({ x: pl.x, y: pl.y, name: pl.name });
    for (const m of w.moons) cands.push({ x: m.x, y: m.y, name: m.name });
    for (const st of w.stations) cands.push({ x: st.x, y: st.y, name: st.name });
    for (const b of w.belts) cands.push({ x: b.x, y: b.y, name: b.name });
    for (const a of w.asteroids) {
      if (a.amount > 0) cands.push({ x: a.x, y: a.y, name: `${catalog.minerals[a.mineral].name} asteroid` });
    }
    for (const e of w.enemies) if (e.alive) cands.push({ x: e.x, y: e.y, name: 'a rat' });
    let best = null;
    let bd = Infinity;
    for (const c of cands) {
      const d = dist(c.x, c.y, x, y);
      if (d < bd) {
        bd = d;
        best = c;
      }
    }
    return best && bd < 160 ? best.name : null;
  }
}
