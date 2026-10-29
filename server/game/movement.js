'use strict';

function createMovement({ ARRIVE_RADIUS, MAX_SPEED, MAX_ACCELERATION, dist, clamp, miningRange }) {
  function moveInOrbit(ship, target, radius, seconds, sys, efficiency) {
    const distance = dist(target.x, target.y, ship.x, ship.y);
    const targetKey = target.id || `${target.x}:${target.y}`;
    if (ship.orbitTargetKey !== targetKey) {
      ship.orbitTargetKey = targetKey;
      ship.orbitAngle = distance > 0 ? Math.atan2(ship.y - target.y, ship.x - target.x) : ship.heading || 0;
    }
    ship.orbitAngle += seconds * 0.18;
    const desiredX = target.x + Math.cos(ship.orbitAngle) * radius;
    const desiredY = target.y + Math.sin(ship.orbitAngle) * radius;
    const response = 1 - Math.exp(-seconds * 4);
    const desiredVx = ((desiredX - ship.x) * response) / seconds;
    const desiredVy = ((desiredY - ship.y) * response) / seconds;
    moveVelocityToward(ship, desiredVx, desiredVy, seconds, efficiency);
    const previousX = ship.x;
    const previousY = ship.y;
    ship.x = clamp(ship.x + ship.vx * seconds, 0, sys.width);
    ship.y = clamp(ship.y + ship.vy * seconds, 0, sys.height);
    if (Math.hypot(ship.vx, ship.vy) > 4) ship.heading = Math.atan2(ship.vy, ship.vx);
    ship.distanceTravelled = (ship.distanceTravelled || 0) + Math.hypot(ship.x - previousX, ship.y - previousY);
  }

  function moveVelocityToward(ship, targetVx, targetVy, seconds, efficiency = 1) {
    let vx = ship.vx || 0;
    let vy = ship.vy || 0;
    const deltaX = targetVx - vx;
    const deltaY = targetVy - vy;
    const deltaSpeed = Math.hypot(deltaX, deltaY);
    const maxAcceleration = MAX_ACCELERATION * efficiency;
    const maxSpeed = MAX_SPEED * efficiency;
    const maxChange = maxAcceleration * seconds;
    if (deltaSpeed <= maxChange) {
      vx = targetVx;
      vy = targetVy;
    } else {
      vx += (deltaX / deltaSpeed) * maxChange;
      vy += (deltaY / deltaSpeed) * maxChange;
    }
    const speed = Math.hypot(vx, vy);
    if (speed > maxSpeed) {
      vx = (vx / speed) * maxSpeed;
      vy = (vy / speed) * maxSpeed;
    }
    ship.vx = vx;
    ship.vy = vy;
    return Math.hypot(vx, vy);
  }

  function advanceNavigation(ship, sys, seconds, combat = null, efficiency = 1) {
    if (ship.dockedStationId) return;
    let destination = ship.navigation;
    const combatEnemy = combat && combat.shipId === ship.id
      ? sys.enemies.find((enemy) => enemy.id === combat.enemyId && enemy.alive)
      : null;
    const enemy = combatEnemy || (destination && destination.targetId
      ? sys.enemies.find((item) => item.id === destination.targetId && item.alive)
      : null);
    const asteroid = destination && destination.orbitTargetId
      ? sys.asteroids.find((item) => item.id === destination.orbitTargetId && item.amount > 0)
      : null;
    if (destination && destination.orbitTargetId && !asteroid) {
      ship.navigation = null;
      destination = null;
    }
    const nearbyAsteroid = !destination && !combat
      ? sys.asteroids
        .filter((item) => item.amount > 0)
        .map((item) => ({ item, distance: dist(item.x, item.y, ship.x, ship.y) }))
        .filter(({ distance }) => distance <= miningRange(ship))
        .sort((a, b) => a.distance - b.distance)[0]?.item || null
      : null;
    const orbit = combatEnemy
      ? { target: combatEnemy, radius: 150 }
      : enemy && destination && dist(enemy.x, enemy.y, ship.x, ship.y) <= 162
        ? { target: enemy, radius: 150 }
        : asteroid && dist(asteroid.x, asteroid.y, ship.x, ship.y) <= 112
          ? { target: asteroid, radius: 100 }
          : nearbyAsteroid
            ? { target: nearbyAsteroid, radius: 100 }
            : null;
    if (orbit) {
      moveInOrbit(ship, orbit.target, orbit.radius, seconds, sys, efficiency);
      return;
    }
    ship.orbitTargetKey = null;
    ship.orbitAngle = null;
    if (!destination) {
      const speed = moveVelocityToward(ship, 0, 0, seconds, efficiency);
      if (speed > 0) {
        const oldX = ship.x;
        const oldY = ship.y;
        ship.x = clamp(ship.x + ship.vx * seconds, 0, sys.width);
        ship.y = clamp(ship.y + ship.vy * seconds, 0, sys.height);
        if (speed > 4) ship.heading = Math.atan2(ship.vy, ship.vx);
        ship.distanceTravelled = (ship.distanceTravelled || 0) + Math.hypot(ship.x - oldX, ship.y - oldY);
      }
      return;
    }
    const dx = destination.x - ship.x;
    const dy = destination.y - ship.y;
    const distance = Math.hypot(dx, dy);
    const currentSpeed = Math.hypot(ship.vx || 0, ship.vy || 0);
    if (distance <= ARRIVE_RADIUS && currentSpeed <= 5) {
      const station = destination.dockTargetId && sys.stations.find((item) => item.id === destination.dockTargetId);
      ship.navigation = null;
      ship.vx = 0;
      ship.vy = 0;
      if (station) {
        ship.x = station.x;
        ship.y = station.y;
        ship.dockTargetId = station.id;
        ship.dockedStationId = station.id;
      }
      return;
    }
    const maxSpeed = MAX_SPEED * efficiency;
    const maxAcceleration = MAX_ACCELERATION * efficiency;
    const stoppingSpeed = Math.sqrt(2 * maxAcceleration * distance);
    const desiredSpeed = Math.min(maxSpeed, distance * 0.6, stoppingSpeed);
    const desiredVx = distance > 0 ? (dx / distance) * desiredSpeed : 0;
    const desiredVy = distance > 0 ? (dy / distance) * desiredSpeed : 0;
    moveVelocityToward(ship, desiredVx, desiredVy, seconds, efficiency);
    const oldX = ship.x;
    const oldY = ship.y;
    ship.x = clamp(ship.x + ship.vx * seconds, 0, sys.width);
    ship.y = clamp(ship.y + ship.vy * seconds, 0, sys.height);
    ship.heading = Math.atan2(ship.vy, ship.vx);
    ship.distanceTravelled = (ship.distanceTravelled || 0) + Math.hypot(ship.x - oldX, ship.y - oldY);
  }

  return { moveInOrbit, moveVelocityToward, advanceNavigation };
}

module.exports = createMovement;
