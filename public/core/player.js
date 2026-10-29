'use strict';

// Renders the server-authoritative ship position with smooth local interpolation.
import { Node } from './node.js';
import { dist } from './util.js';

const MAX_POSITION_PREDICTION_SECONDS = 0.75;

export class Player extends Node {
  // PUBLIC
  constructor(app) {
    super(app);
    this.x = 0;
    this.y = 0;
    this.vx = 0;
    this.vy = 0;
    this.heading = 0;
    this.destination = null;
    this.serverTarget = null;
    this.serverTargetAge = 0;
    this.maxSpeed = null;
    this.maxAcceleration = null;
    this.docking = this.add(new DockingNode(app));
  }

  // PUBLIC
  setServerState(ship, navigation, state) {
    if (!ship) return;
    this.maxSpeed = state && Number.isFinite(state.maxSpeed)
      ? state.maxSpeed
      : (this.app.constants && this.app.constants.maxSpeed) || 1200;
    this.maxAcceleration = state && Number.isFinite(state.maxAcceleration)
      ? state.maxAcceleration
      : (this.app.constants && this.app.constants.maxAcceleration) || 180;
    const velocityX = ship.vx || 0;
    const velocityY = ship.vy || 0;
    let accelerationX = 0;
    let accelerationY = 0;
    if (this.serverTarget && this.serverTargetAge >= 0.1) {
      accelerationX = (velocityX - this.serverTarget.vx) / this.serverTargetAge;
      accelerationY = (velocityY - this.serverTarget.vy) / this.serverTargetAge;
      const maxAcceleration = this.maxAcceleration;
      const acceleration = Math.hypot(accelerationX, accelerationY);
      if (acceleration > maxAcceleration) {
        accelerationX = (accelerationX / acceleration) * maxAcceleration;
        accelerationY = (accelerationY / acceleration) * maxAcceleration;
      }
    }
    this.serverTarget = {
      x: ship.x,
      y: ship.y,
      vx: velocityX,
      vy: velocityY,
      ax: accelerationX,
      ay: accelerationY,
      heading: ship.heading || 0,
    };
    this.serverTargetAge = 0;
    this.destination = navigation ? { x: navigation.x, y: navigation.y } : null;
    this.dockTargetId = navigation ? navigation.dockTargetId : null;
  }

  // PUBLIC
  snap(x, y) {
    this.x = x;
    this.y = y;
    this.vx = 0;
    this.vy = 0;
    this.destination = null;
    this.serverTarget = { x, y, vx: 0, vy: 0, ax: 0, ay: 0, heading: this.heading };
    this.serverTargetAge = 0;
  }

  // PUBLIC
  startUndock() {
    const ship = this.app.state.activeShip;
    if (!ship) throw new Error('Cannot undock without an active ship');
    this.snap(ship.x, ship.y);
    this.undock = null;
    this.app.undocking = false;
  }

  // PUBLIC
  update(dt) {
    if (this.serverTarget && !this.app.docking) {
      const previousX = this.x;
      const previousY = this.y;
      this.serverTargetAge += dt;
      const predictionAge = Math.min(this.serverTargetAge, MAX_POSITION_PREDICTION_SECONDS);
      let predictedVelocityX = this.serverTarget.vx + this.serverTarget.ax * predictionAge;
      let predictedVelocityY = this.serverTarget.vy + this.serverTarget.ay * predictionAge;
      const currentSpeed = Math.hypot(this.serverTarget.vx, this.serverTarget.vy);
      const predictedSpeed = Math.hypot(predictedVelocityX, predictedVelocityY);
      if (currentSpeed <= this.maxSpeed && predictedSpeed > this.maxSpeed) {
        const scale = this.maxSpeed / predictedSpeed;
        predictedVelocityX *= scale;
        predictedVelocityY *= scale;
      }
      const targetX = this.serverTarget.x +
        ((this.serverTarget.vx + predictedVelocityX) / 2) * predictionAge;
      const targetY = this.serverTarget.y +
        ((this.serverTarget.vy + predictedVelocityY) / 2) * predictionAge;
      const response = 1 - Math.exp(-dt * 12);
      this.x += (targetX - this.x) * response;
      this.y += (targetY - this.y) * response;
      if (dist(this.x, this.y, targetX, targetY) < 0.5) {
        this.x = targetX;
        this.y = targetY;
      }
      this.vx = dt > 0 ? (this.x - previousX) / dt : this.serverTarget.vx;
      this.vy = dt > 0 ? (this.y - previousY) / dt : this.serverTarget.vy;
      if (Math.hypot(this.vx, this.vy) > 4) this.heading = Math.atan2(this.vy, this.vx);
      else this.heading = this.serverTarget.heading;
    }
    return super.update(dt);
  }

  // PUBLIC
  poiLabel(x, y) {
    const world = this.app.state.world;
    const candidates = [
      world.star,
      ...world.planets,
      ...world.moons,
      ...world.stations,
      ...world.belts,
      ...world.asteroids.filter((asteroid) => asteroid.amount > 0).map((asteroid) => ({
        ...asteroid,
        name: `${this.app.catalog.minerals[asteroid.mineral].name} asteroid`,
      })),
      ...world.enemies.filter((enemy) => enemy.alive).map((enemy) => ({ ...enemy, name: 'an enemy' })),
    ];
    const nearest = candidates
      .map((point) => ({ point, distance: dist(point.x, point.y, x, y) }))
      .sort((a, b) => a.distance - b.distance)[0];
    return nearest && nearest.distance < 160 ? nearest.point.name : null;
  }
}

class DockingNode extends Node {
  // PUBLIC
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

  // PUBLIC
  setFade(on) {
    const element = document.getElementById('dock-fade');
    element.classList.toggle('on', on);
    element.classList.toggle('out', !on);
  }

  // PUBLIC
  update(dt) {
    const dock = this.app.docking;
    if (dock) this.#updateTransition(dt, dock);
    return super.update(dt);
  }

  // PRIVATE
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

  // PRIVATE
  #finish(dock) {
    this.app.docking = null;
    this.app.player.snap(dock.station.x, dock.station.y);
    if (this.app.state) {
      this.app.state.docked = true;
      this.app.state.dockedStation = dock.dockedStation;
      this.app.ui.refreshPanels();
      this.app.syncDockedView();
      this.app.handleAutoPilotSequence();
    }
    this.setFade(false);
  }
}
