'use strict';

function createAutopilot({
  MINERALS,
  ENEMIES,
  WORLD_SIZE,
  DOCK_RANGE,
  ENGAGE_RANGE,
  AUTOPILOT_DOCK_WAIT_MS,
  AUTOPILOT_LAUNCH_WAIT_MS,
  clone,
  dist,
  clamp,
  isDocked,
  dockedStation,
  cargoUsed,
  cargoCapacity,
  activeSystem,
  estimateCombatDifficulty,
  setNavigation,
  closestBeltAsteroid,
  startCombat,
  nearestAsteroidInRange,
}) {
  function nearestStationFor(ship, system) {
    return system.stations.reduce((best, station) => {
      const distance = dist(ship.x, ship.y, station.x, station.y);
      return !best || distance < best.distance ? { station, distance } : best;
    }, null);
  }

  function nearestSafeEnemy(state, ship, system) {
    return system.enemies
      .filter((enemy) => enemy.alive)
      .map((enemy) => ({ enemy, difficulty: estimateCombatDifficulty(state, ship, enemy) }))
      .filter(({ difficulty }) => difficulty.ratio !== null && difficulty.ratio >= 0.85)
      .sort((a, b) =>
        dist(a.enemy.x, a.enemy.y, ship.x, ship.y) - dist(b.enemy.x, b.enemy.y, ship.x, ship.y)
      )[0]?.enemy || null;
  }

  function bestBeltTarget(ship, system) {
    const values = new Map();
    for (const asteroid of system.asteroids) {
      if (asteroid.amount <= 0) continue;
      const tier = MINERALS[asteroid.mineral].tier || 1;
      values.set(asteroid.beltId, (values.get(asteroid.beltId) || 0) + asteroid.amount * tier);
    }
    return system.belts
      .map((belt) => ({
        belt,
        score: (values.get(belt.id) || 0) / Math.max(1, dist(belt.x, belt.y, ship.x, ship.y)),
      }))
      .filter((entry) => entry.score > 0)
      .sort((a, b) => b.score - a.score)[0]?.belt || null;
  }

  function recordAutomation(state, message, at = Date.now()) {
    if (!Array.isArray(state.automationLog)) state.automationLog = [];
    state.automationLog.unshift({ at, message });
    state.automationLog.length = Math.min(state.automationLog.length, 20);
  }

  function setAutopilotNavigation(state, ship, x, y, targetId = null, dockTargetId = null, orbitTargetId = null) {
    const current = ship.navigation;
    if (current && current.x === x && current.y === y && current.targetId === targetId &&
        current.dockTargetId === dockTargetId && current.orbitTargetId === orbitTargetId) return;
    setNavigation(ship, x, y, targetId, dockTargetId, orbitTargetId);
    const system = activeSystem(state);
    const target = targetId && system && system.enemies.find((enemy) => enemy.id === targetId);
    const station = dockTargetId && system && system.stations.find((item) => item.id === dockTargetId);
    recordAutomation(state, target
      ? `Engaging ${ENEMIES[target.type].name}`
      : station ? `Returning to ${station.name}` : 'Traveling to a mining site');
  }

  function launchForAutopilot(ship, station) {
    ship.x = clamp(station.x + DOCK_RANGE + 30, 0, WORLD_SIZE);
    ship.y = station.y;
    ship.vx = 0;
    ship.vy = 0;
    ship.dockedStationId = null;
    ship.dockTargetId = null;
  }

  function runAutopilot(state, ship, system, now) {
    const mode = state.autoPilotMode;
    if (!mode || state.combat || !ship || !system) return;
    const canMine = mode === 'mine' || mode === 'mine_fight';
    const canFight = mode === 'fight' || mode === 'mine_fight';
    const station = nearestStationFor(ship, system);

    if (isDocked(state)) {
      const sequence = state.autoPilotSequence;
      if (sequence) {
        if (sequence.phase === 'dock_wait') {
          if (sequence.startedAt == null || now - sequence.startedAt < AUTOPILOT_DOCK_WAIT_MS) return;
          if (cargoUsed(state) > 0) {
            sequence.phase = 'deposit';
            sequence.startedAt = now;
          } else {
            sequence.phase = 'launch_wait';
            sequence.startedAt = now;
          }
          return;
        }
        if (sequence.phase === 'deposit') {
          if (cargoUsed(state) <= 0) {
            sequence.phase = 'launch_wait';
            sequence.startedAt = now;
          }
          return;
        }
        if (sequence.phase === 'launch_wait' && now - sequence.startedAt < AUTOPILOT_LAUNCH_WAIT_MS) return;
        delete state.autoPilotSequence;
      } else if (cargoUsed(state) > 0) {
        state.autoPilotSequence = { phase: 'dock_wait', startedAt: null };
        return;
      }
      const belt = canMine ? bestBeltTarget(ship, system) : null;
      const enemy = !belt && canFight ? nearestSafeEnemy(state, ship, system) : null;
      const target = belt || enemy;
      if (!target) {
        state.autoPilotMode = null;
        ship.navigation = null;
        recordAutomation(state, 'No suitable targets remain; auto-pilot stopped');
        return;
      }
      const docked = dockedStation(state);
      launchForAutopilot(ship, docked || station.station);
      if (belt) {
        const rock = closestBeltAsteroid(system, belt, ship) || belt;
        setAutopilotNavigation(state, ship, rock.x, rock.y, null, null, rock.id);
      } else {
        setAutopilotNavigation(state, ship, enemy.x, enemy.y, enemy.id);
      }
      return;
    }

    if (cargoUsed(state) >= cargoCapacity(state)) {
      if (station) setAutopilotNavigation(state, ship, station.station.x, station.station.y, null, station.station.id);
      return;
    }
    const navigation = ship.navigation;
    const navigationTarget = canFight && navigation && navigation.targetId
      ? system.enemies.find((enemy) => enemy.id === navigation.targetId && enemy.alive)
      : null;
    if (navigationTarget && dist(navigationTarget.x, navigationTarget.y, ship.x, ship.y) <= ENGAGE_RANGE) {
      startCombat(state, navigationTarget.id, now);
      ship.navigation = null;
      return;
    }
    const availableBelt = canMine ? bestBeltTarget(ship, system) : null;
    const availableEnemy = canFight ? nearestSafeEnemy(state, ship, system) : null;
    if (!availableBelt && !availableEnemy) {
      state.autoPilotMode = null;
      ship.navigation = null;
      ship.dockTargetId = null;
      recordAutomation(state, 'No suitable targets remain; auto-pilot stopped');
      return;
    }
    if (navigation && (
      (navigation.targetId && system.enemies.some((enemy) => enemy.id === navigation.targetId && enemy.alive)) ||
      (navigation.dockTargetId && system.stations.some((item) => item.id === navigation.dockTargetId)) ||
      system.asteroids.some((asteroid) =>
        asteroid.amount > 0 && asteroid.x === navigation.x && asteroid.y === navigation.y)
    )) return;
    if (nearestAsteroidInRange(state, ship)) return;
    if (canFight) {
      const enemy = nearestSafeEnemy(state, ship, system);
      if (enemy) {
        setAutopilotNavigation(state, ship, enemy.x, enemy.y, enemy.id);
        if (dist(enemy.x, enemy.y, ship.x, ship.y) <= ENGAGE_RANGE) {
          startCombat(state, enemy.id, now);
          ship.navigation = null;
        }
        return;
      }
    }
    if (canMine) {
      const belt = bestBeltTarget(ship, system);
      if (belt) {
        const rock = closestBeltAsteroid(system, belt, ship) || belt;
        setAutopilotNavigation(state, ship, rock.x, rock.y, null, null, rock.id);
      }
    }
  }

  function setAutopilot(state, mode) {
    const aliases = { hunt: 'fight', mine_hunt: 'mine_fight' };
    const canonicalMode = aliases[mode] || mode;
    if (![null, 'mine', 'mine_fight', 'fight'].includes(canonicalMode)) return { error: 'Unknown autopilot mode' };
    const nextState = clone(state);
    if (nextState.autoPilotMode !== canonicalMode) delete nextState.autoPilotSequence;
    nextState.autoPilotMode = canonicalMode;
    nextState.manualMining = false;
    nextState.manualMiningTargetId = null;
    recordAutomation(nextState, canonicalMode ? `Auto-pilot set to ${canonicalMode.replace('_', ' & ')}` : 'Auto-pilot stopped');
    return { state: nextState };
  }

  function startAutopilotDockWait(state, now = Date.now()) {
    if (!isDocked(state) || !state.autoPilotSequence ||
        state.autoPilotSequence.phase !== 'dock_wait' || state.autoPilotSequence.startedAt != null) {
      return { error: 'Auto-pilot is not waiting for a dock animation' };
    }
    const nextState = clone(state);
    nextState.autoPilotSequence.startedAt = now;
    return { state: nextState };
  }

  function completeAutopilotDeposit(state, now = Date.now()) {
    if (!state.autoPilotSequence || state.autoPilotSequence.phase !== 'deposit') {
      return { state };
    }
    if (cargoUsed(state) > 0) return { state };
    const nextState = clone(state);
    nextState.autoPilotSequence = { phase: 'launch_wait', startedAt: now };
    recordAutomation(nextState, 'Stored cargo');
    return { state: nextState };
  }

  return {
    nearestSafeEnemy,
    bestBeltTarget,
    recordAutomation,
    setAutopilotNavigation,
    launchForAutopilot,
    runAutopilot,
    setAutopilot,
    startAutopilotDockWait,
    completeAutopilotDeposit,
  };
}

module.exports = createAutopilot;
