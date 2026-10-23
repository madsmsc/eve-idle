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
    this.suppressAutoRecall = false;
    this.orbitTargetKey = null;
    this.orbitAngle = 0;
    this.docking = this.add(new DockingNode(app));
    this.add(new AutoPilotNode(app));
  }

  setDestination(x, y, dockTargetId = null) {
    if (this.app.docking || this.undock) return;
    this.destination = {
      x: clamp(x, 0, this.app.constants.worldSize),
      y: clamp(y, 0, this.app.constants.worldSize),
    };
    this.dockTargetId = dockTargetId;
  }

  // Snap to a server-authoritative position (warp / jump / respawn).
  snap(x, y) {
    this.drift = null;
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

  orbitTarget() {
    const state = this.app.state;
    const enemyId = (state.combat && state.combat.enemyId) || this.app.targetEnemyId;
    const enemyRadius = 150;
    if (enemyId) {
      const enemy = state.world.enemies.find((e) => e.id === enemyId && e.alive);
      const destinationIsEnemy = !this.destination || !!(
        enemy && dist(enemy.x, enemy.y, this.destination.x, this.destination.y) < this.app.constants.engageRange
      );
      if (enemy && (
        (state.combat && state.combat.enemyId === enemyId) ||
        (destinationIsEnemy && dist(enemy.x, enemy.y, this.x, this.y) <= enemyRadius + 12)
      )) {
        return { target: enemy, radius: enemyRadius };
      }
    }

    if (!state.combat && this.destination) {
      const asteroid = state.world.asteroids.find((a) =>
        a.amount > 0 &&
        dist(a.x, a.y, this.destination.x, this.destination.y) < 1
      );
      if (asteroid && dist(asteroid.x, asteroid.y, this.x, this.y) <= 112) {
        return { target: asteroid, radius: 100 };
      }
    } else if (!state.combat) {
      const asteroid = this.nearestAsteroid();
      if (asteroid) return { target: asteroid, radius: 100 };
    }
    return null;
  }

  moveInOrbit(dt, target, radius) {
    const distance = dist(target.x, target.y, this.x, this.y);
    const targetKey = target.id || `${target.x}:${target.y}`;
    if (this.orbitTargetKey !== targetKey) {
      this.orbitTargetKey = targetKey;
      this.orbitAngle = distance > 0 ? Math.atan2(this.y - target.y, this.x - target.x) : this.heading;
    }
    this.orbitAngle += dt * 0.18;
    const desiredX = target.x + Math.cos(this.orbitAngle) * radius;
    const desiredY = target.y + Math.sin(this.orbitAngle) * radius;
    const previousX = this.x;
    const previousY = this.y;
    const response = 1 - Math.exp(-dt * 4);
    this.x += (desiredX - this.x) * response;
    this.y += (desiredY - this.y) * response;
    this.clampToWorld();
    if (dt > 0) {
      this.vx = (this.x - previousX) / dt;
      this.vy = (this.y - previousY) / dt;
      if (Math.hypot(this.vx, this.vy) > 4) this.heading = Math.atan2(this.vy, this.vx);
    }
  }

  integrateMotion(dt) {
    const C = this.app.constants;
    const damp = Math.pow(C.damping, dt * 60);
    this.vx *= damp;
    this.vy *= damp;
    const speed = Math.hypot(this.vx, this.vy);
    if (speed > C.maxSpeed) {
      this.vx = (this.vx / speed) * C.maxSpeed;
      this.vy = (this.vy / speed) * C.maxSpeed;
    }
    this.x += this.vx * dt;
    this.y += this.vy * dt;
    this.clampToWorld();
    if (speed > 4) this.heading = Math.atan2(this.vy, this.vx);
  }

  // Undocking: the ship starts at the station's centre and flies out to the
  // dock boundary (where the server already placed it), then keeps drifting.
  startUndock(station) {
    this.x = station.x;
    this.y = station.y;
    this.vx = 0;
    this.vy = 0;
    this.heading = 0;
    this.destination = null;
    this.undock = { station, t: 0 };
    this.app.undocking = true;
  }

  updateUndock(dt) {
    const u = this.undock;
    u.t += dt;
    const speed = Math.min(45, 14 + u.t * 4);
    const exitX = u.station.x + this.app.constants.dockRange + 30;
    this.x = Math.min(exitX, this.x + speed * dt);
    this.y = u.station.y;
    this.vx = speed;
    this.vy = 0;
    this.heading = 0;
    if (this.x >= exitX) {
      this.undock = null;
      this.app.undocking = false;
      this.drift = { ax: 1, ay: 0, t: 2.2 };
    }
  }

  // Docking cutscene: glide slowly into the station centre, fading to black
  // over the last stretch; the app swaps in the hangar once it is black.
  updateDrift(dt) {
    const dr = this.drift;
    dr.t += dt;
    const speed = Math.min(90, 25 + dr.t * 30);
    this.vx = dr.ax * speed;
    this.vy = dr.ay * speed;
    this.x += this.vx * dt;
    this.y += this.vy * dt;
    this.clampToWorld();
    if (dr.t > 3.5) this.drift = null;
  }

  update(dt) {
    if (this.app.state) this.maybeAutoRecall();
    this.#updateMotion(dt);
    return super.update(dt);
  }

  #updateMotion(dt) {
    if (this.app.docking) return;
    if (this.undock) {
      this.updateUndock(dt);
      return;
    }
    if (this.drift && !this.destination && !this.app.state.combat) {
      this.updateDrift(dt);
      return;
    }
    if (this.drift && (this.destination || this.app.state.combat)) this.drift = null;
    const C = this.app.constants;
    const state = this.app.state;
    const orbit = this.orbitTarget();
    const inCombat = !!state.combat;
    if (!orbit) this.orbitTargetKey = null;
    if (inCombat) {
      if (orbit) this.moveInOrbit(dt, orbit.target, orbit.radius);
      else {
        this.vx *= 0.9;
        this.vy *= 0.9;
        this.x += this.vx * dt;
        this.y += this.vy * dt;
        this.clampToWorld();
      }
      return;
    }

    if (orbit) {
      this.moveInOrbit(dt, orbit.target, orbit.radius);
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

    this.integrateMotion(dt);
  }

  // Idle convenience: when the cargo hold is full, automatically fly home to
  // the nearest station to dump it. Skipped during combat and while inbound.
  maybeAutoRecall() {
    const state = this.app.state;
    if (state.combat) return;
    if (!state.cargoFull) {
      this.suppressAutoRecall = false;
      return;
    }
    if (this.suppressAutoRecall) return;
    const ns = this.nearestStation();
    if (!ns) return;
    if (ns.d < this.app.constants.dockRange) return; // already at a station
    if (this.destination) {
      const inbound = state.world.stations.some(
        (st) => dist(st.x, st.y, this.destination.x, this.destination.y) < 80
      );
      if (inbound) return;
    }
    this.dockTargetId = ns.station.id;
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

  // Closest asteroid with ore left in a belt (falls back to the belt centre).
  beltApproachPoint(belt) {
    let best = null;
    let bd = Infinity;
    for (const a of this.app.state.world.asteroids) {
      if (a.beltId !== belt.id || a.amount <= 0) continue;
      const d = dist(a.x, a.y, this.x, this.y);
      if (d < bd) {
        bd = d;
        best = a;
      }
    }
    return best || belt;
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

class AutoPilotNode extends Node {
  update(dt) {
    this.#run(performance.now());
    return super.update(dt);
  }

  #run(now) {
    const app = this.app;
    const state = app.state;
    if (!app.autoPilot || !state || !state.activeShip || now - app.lastAutoTick < 800) return;
    app.lastAutoTick = now;
    if (state.combat) return;
    if (state.docked) {
      if (state.cargoUsed > 0) {
        app.doAction('sell-all', {});
      } else {
        const belt = app.player.nearestPoiOf('belt');
        if (belt) {
          app.launch({ keepAutoPilot: true }).then((launched) => {
            if (launched && app.autoPilot) {
              const point = app.player.beltApproachPoint(belt);
              app.player.setDestination(point.x, point.y);
            }
          });
        }
      }
      return;
    }
    if (state.cargoFull) return;
    if (!app.player.nearestAsteroid()) {
      const belt = app.player.nearestPoiOf('belt');
      if (belt) {
        const point = app.player.beltApproachPoint(belt);
        app.player.setDestination(point.x, point.y);
      }
    }
  }
}

class DockingNode extends Node {
  begin(newState) {
    const station = newState.world.stations.find((item) => item.name === newState.dockedStation);
    if (!station) return false;
    this.app.dockBackground = this.app.world.captureDockBackground(this.app.ship);
    this.app.docking = {
      station,
      dockedStation: newState.dockedStation,
      elapsed: 0,
      fading: false,
      fadeStart: 0,
    };
    newState.docked = false;
    newState.dockedStation = null;
    return true;
  }

  setFade(on) {
    const element = document.getElementById('dock-fade');
    element.classList.toggle('on', on);
    element.classList.toggle('out', !on);
  }

  update(dt) {
    const dock = this.app.docking;
    if (dock) this.#updateTransition(dt, dock);
    return super.update(dt);
  }

  #updateTransition(dt, dock) {
    const player = this.app.player;
    const station = dock.station;
    const dx = station.x - player.x;
    const dy = station.y - player.y;
    const distance = Math.hypot(dx, dy);
    dock.elapsed += dt;
    const speed = distance > 1 ? Math.max(70, Math.min(170, distance * 0.8)) : 0;
    const step = Math.min(distance, speed * dt);
    if (distance > 1) {
      player.vx = (dx / distance) * speed;
      player.vy = (dy / distance) * speed;
      player.x += (dx / distance) * step;
      player.y += (dy / distance) * step;
      player.heading = Math.atan2(dy, dx);
    } else {
      player.vx = 0;
      player.vy = 0;
    }
    if (!dock.fading && (distance < 70 || dock.elapsed > 3.5)) {
      dock.fading = true;
      dock.fadeStart = dock.elapsed;
      this.setFade(true);
    }
    if (dock.fading && dock.elapsed - dock.fadeStart >= 1) this.#finish(dock);
  }

  #finish(dock) {
    this.app.docking = null;
    this.app.player.snap(dock.station.x, dock.station.y);
    if (this.app.state) {
      this.app.state.docked = true;
      this.app.state.dockedStation = dock.dockedStation;
      this.app.ui.refreshPanels();
      this.app.syncDockedView();
    }
    this.setFade(false);
  }
}
