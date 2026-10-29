'use strict';

const {
  SHIPS,
  MODULES,
  ENEMIES,
  MISSION_ORDER,
  MISSIONS,
  DOCK_RANGE,
} = require('../config');

function createMissions({ clone, addStoredItems, emptyCargo, emptyFitting, dockedStation, clamp, nextId }) {
  function missionDef(state) {
    const mission = state.mission;
    if (!mission || !mission.active) return null;
    return MISSIONS[mission.active] || null;
  }

  function fitGrantModule(ship, slotType, tier) {
    if (!ship || !ship.fitting || !MODULES[slotType]) return false;
    const slots = SHIPS[ship.type].slots[slotType] || 0;
    for (let index = 0; index < slots; index++) {
      if (!ship.fitting[slotType][index]) {
        ship.fitting[slotType][index] = tier;
        return true;
      }
    }
    return false;
  }

  function grantShips(state, types) {
    const ship = state.ships.find((item) => item.id === state.activeShipId);
    let system = ship && state.systems ? state.systems[ship.systemId] : null;
    if (!system && state.systems) system = Object.values(state.systems)[0] || null;
    if (!system) return;
    const home = system.stations[0];
    for (let index = 0; index < types.length; index++) {
      const angle = ((index + 1) / (types.length + 1)) * Math.PI;
      const radius = DOCK_RANGE + 120;
      const replacement = {
        id: nextId(),
        type: types[index],
        x: clamp(home.x + Math.cos(angle) * radius, 60, system.width - 60),
        y: clamp(home.y + Math.sin(angle) * radius, 60, system.height - 60),
        systemId: system.id,
        dockTargetId: null,
        dockedStationId: null,
        cargo: emptyCargo(),
        fitting: emptyFitting(types[index]),
      };
      state.ships.push(replacement);
      state.activeShipId = replacement.id;
    }
  }

  function grantMissionRewards(state, definition) {
    if (!definition) return;
    const grant = definition.grant || {};
    addStoredItems(state, grant.items);
    if (grant.skillPoints) {
      state.skillPoints = (state.skillPoints || 0) + grant.skillPoints;
      state.stats.totalSpEarned = (state.stats.totalSpEarned || 0) + grant.skillPoints;
    }
    if (!Array.isArray(state.blueprints)) state.blueprints = [];
    for (const blueprint of grant.blueprints || []) {
      state.blueprints.push({ id: nextId(), ...blueprint });
    }
    if (Array.isArray(grant.ships)) grantShips(state, grant.ships);
    if (Array.isArray(grant.modules)) {
      const ship = state.ships.find((item) => item.id === state.activeShipId);
      for (const module of grant.modules) fitGrantModule(ship, module.slot, module.tier);
    }
  }

  function grantCompletionRewards(state, definition) {
    if (!definition) return;
    const completion = definition.completion || {};
    addStoredItems(state, completion.items);
    if (!Array.isArray(completion.drones)) return;
    const ship = state.ships.find((item) => item.id === state.activeShipId);
    for (const drone of completion.drones) {
      const slotType = drone.type === 'mining' ? 'miningDrone' : drone.type === 'combat' ? 'combatDrone' : null;
      if (!slotType) continue;
      if (!fitGrantModule(ship, slotType, drone.tier)) {
        if (!Array.isArray(state.loot)) state.loot = [];
        state.loot.push({ id: nextId(), slotType, tier: drone.tier });
      }
    }
  }

  function clearMissionEnemies(state) {
    for (const system of Object.values(state.systems)) {
      system.enemies = (system.enemies || []).filter((enemy) => !enemy.missionTag || enemy.alive === false);
    }
  }

  function spawnMissionEnemies(state, definition) {
    if (!definition || !definition.spawn) return;
    const ship = state.ships.find((item) => item.id === state.activeShipId);
    const system = state.systems && state.systems[definition.systemId || (ship && ship.systemId)];
    if (!system) return;
    const outpost = (system.outposts || [])[0];
    const site = outpost || system.stations[0];
    for (const spawn of definition.spawn) {
      const enemyDefinition = ENEMIES[spawn.type];
      if (!enemyDefinition) continue;
      for (let index = 0; index < spawn.count; index++) {
        const angle = (index / Math.max(1, spawn.count)) * Math.PI * 2;
        const radius = 420 + index * 60;
        system.enemies.push({
          id: nextId(),
          type: enemyDefinition.key,
          tier: spawn.tier || 'standard',
          missionTag: spawn.tag || spawn.type,
          x: clamp(site.x + Math.cos(angle) * radius, 60, system.width - 60),
          y: clamp(site.y + Math.sin(angle) * radius, 60, system.height - 60),
          outpostId: outpost && outpost.id,
          rangeDelay: spawn.rangeDelay || 0,
          alive: true,
        });
      }
    }
  }

  function startMission(state, id) {
    const definition = MISSIONS[id];
    if (!definition) return;
    state.mission.active = id;
    state.mission.flags = {};
    state.mission.ready = false;
    state.mission.offered = null;
    clearMissionEnemies(state);
    grantMissionRewards(state, definition);
    spawnMissionEnemies(state, definition);
  }

  function missionStartNeeded(state) {
    const mission = state && state.mission;
    return !mission || (!mission.active && (!mission.completed || mission.completed.length === 0));
  }

  function missionDone(state) {
    const mission = state.mission;
    const definition = missionDef(state);
    if (!mission || !definition) return false;
    const objective = definition.objective;
    switch (objective.type) {
      case 'kill': return (mission.flags.killed || 0) >= objective.count;
      case 'mine': return (mission.flags.mined || 0) >= objective.target;
      case 'craft':
        return objective.targets.every((target) =>
          (mission.flags.crafted && mission.flags.crafted[`${target.slot}:${target.tier}`] || 0) >= target.count
        );
      case 'dock': return !!mission.flags.docked;
      case 'death': return !!mission.flags.died;
      case 'dialogue': return !!mission.flags.done;
      default: return false;
    }
  }

  function checkMissionObjective(state) {
    const mission = state.mission;
    if (!mission || state.mode !== 'story' || !mission.active) return;
    const definition = MISSIONS[mission.active];
    if (!definition) return;
    if (definition.objective.type === 'dock' && dockedStation(state)) mission.flags.docked = 1;
    if (missionDone(state)) mission.ready = true;
  }

  function evaluateMission(state) {
    const mission = state.mission;
    if (!mission || state.mode !== 'story' || !mission.active) return { error: 'No active mission' };
    if (!dockedStation(state)) return { error: 'Return to a station to turn in the mission' };
    const definition = MISSIONS[mission.active];
    if (!definition) return { error: 'No active mission' };
    if (!missionDone(state)) return { error: 'Mission objective not complete' };
    grantCompletionRewards(state, definition);
    mission.completed.push(mission.active);
    state.stats.missionsCompleted = (state.stats.missionsCompleted || 0) + 1;
    const next = MISSION_ORDER[MISSION_ORDER.indexOf(mission.active) + 1] || null;
    mission.active = null;
    mission.flags = {};
    mission.ready = false;
    mission.offered = next
      ? { id: next, title: MISSIONS[next].title, npc: MISSIONS[next].npc, brief: MISSIONS[next].brief }
      : null;
    return { state };
  }

  function missionAction(state, action) {
    const nextState = clone(state);
    const mission = nextState.mission;
    if (!mission || nextState.mode !== 'story') return { error: 'No active mission' };
    if (action === 'continue') {
      if (!mission.active) return { error: 'No active mission' };
      const definition = MISSIONS[mission.active];
      if (!definition) return { error: 'No active mission' };
      if (definition.objective.type === 'dialogue') mission.flags.done = 1;
      checkMissionObjective(nextState);
      return { state: nextState };
    }
    if (action === 'turnin') {
      const result = evaluateMission(nextState);
      if (result.error) return { error: result.error };
      return { state: nextState };
    }
    if (action === 'accept') {
      if (!mission.offered) return { error: 'No mission offered' };
      if (!dockedStation(nextState)) return { error: 'Dock at a station to accept the mission' };
      startMission(nextState, mission.offered.id);
      return { state: nextState };
    }
    return { error: 'Unknown mission action' };
  }

  function missionView(state) {
    const mission = state.mission;
    if (!mission) return null;
    const definition = mission.active ? MISSIONS[mission.active] : null;
    const objective = definition ? definition.objective : null;
    let progress = null;
    let target = null;
    let objectives = [];
    if (objective) {
      switch (objective.type) {
        case 'kill':
          progress = Math.min(objective.count, mission.flags.killed || 0);
          target = objective.count;
          objectives = [{ label: objective.label, progress, target }];
          break;
        case 'mine':
          progress = Math.min(objective.target, mission.flags.mined || 0);
          target = objective.target;
          objectives = [{ label: objective.label, progress, target }];
          break;
        case 'craft':
          progress = objective.targets.map((item) =>
            Math.min(item.count, (mission.flags.crafted && mission.flags.crafted[`${item.slot}:${item.tier}`]) || 0)
          );
          target = objective.targets.map((item) => item.count);
          objectives = objective.targets.map((item) => ({
            label: item.label,
            progress: Math.min(item.count, (mission.flags.crafted && mission.flags.crafted[`${item.slot}:${item.tier}`]) || 0),
            target: item.count,
          }));
          break;
        default:
          objectives = [{ label: objective.label, progress: null, target: null }];
          break;
      }
    }
    return {
      mode: state.mode,
      active: mission.active,
      ready: !!mission.ready,
      offered: mission.offered ? { ...mission.offered } : null,
      title: definition ? definition.title : null,
      npc: definition ? definition.npc : null,
      brief: definition ? definition.brief : null,
      objective: objective ? objective.label : null,
      objectives,
      progress,
      target,
      done: definition ? missionDone(state) : false,
      completed: mission.completed.slice(),
    };
  }

  return {
    evaluateMission,
    checkMissionObjective,
    missionView,
    missionAction,
    spawnMissionEnemies,
    startMission,
    missionStartNeeded,
    missionDone,
    MISSIONS,
    MISSION_ORDER,
  };
}

module.exports = createMissions;
