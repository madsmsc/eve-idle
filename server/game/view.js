'use strict';

const { SYSTEM_DEFS } = require('./world');

function createView(config, helpers) {
  const {
    MINERALS,
    MODULES,
    BLUEPRINTS,
    SHIP_BLUEPRINTS,
    ACHIEVEMENTS,
    ENEMY_TIERS,
    SP_RATE_PER_SEC,
    COMPONENTS,
    SHIELD_BOOST_ITEM,
    OVERLOAD_ITEM,
    OVERLOAD_DURATION,
    OVERLOAD_DPS_MULT,
    MINING_RANGE,
    ENGAGE_RANGE,
    GATE_RANGE,
  } = config;
  const {
    skillMults,
    shipMaxSpeed,
    shipMaxAcceleration,
    droneBonus,
    shipDps,
    shipShield,
    shipHull,
    emptyMaterials,
    dockedStation,
    missionView,
    agentMissionView,
    emptySkills,
    emptyDroneBay,
    moduleBonus,
    moduleRequirements,
    shipMining,
    shipCargo,
    skillTrainingView,
    shipProgressionView,
    actionAvailability,
    cargoUsed,
    cargoCapacity,
    shipInCombat,
    miningRange,
    nearestAsteroidInRange,
    ambushChance,
    enemyCombatStats,
    estimateCombatDifficulty,
    autoEfficiency,
    dist,
  } = helpers;
  const { SHIPS, SKILLS } = config;

  function shipView(ship, mults, drone, skills) {
    const definition = SHIPS[ship.type];
    const bonuses = drone || { mining: 0, dps: 0 };
    const fitting = ship.fitting || helpers.emptyFitting(ship.type);
    const fittingLocks = Object.fromEntries(Object.entries(fitting).map(([slotType, tiers]) => [
      slotType,
      tiers.map((tier) => {
        const missing = tier > 0
          ? moduleRequirements(slotType, tier).find(({ skill, level }) => ((skills && skills[skill]) || 0) < level)
          : null;
        return missing
          ? `Requires ${SKILLS[missing.skill].name} level ${missing.level}`
          : null;
      }),
    ]));
    return {
      id: ship.id,
      type: ship.type,
      name: definition.name,
      className: definition.className || null,
      role: definition.role || 'legacy',
      weaponType: definition.weaponType || null,
      x: ship.x,
      y: ship.y,
      vx: ship.vx || 0,
      vy: ship.vy || 0,
      heading: ship.heading || 0,
      speed: Math.hypot(ship.vx || 0, ship.vy || 0),
      systemId: ship.systemId,
      mining: shipMining(ship, mults, bonuses.mining, skills),
      combat: definition.combat,
      dps: shipDps(ship, mults, bonuses.dps, skills),
      shield: shipShield(ship, mults, skills),
      hull: shipHull(ship, mults, skills),
      cargo: shipCargo(ship, mults, skills),
      maxSpeed: shipMaxSpeed(ship, mults),
      slots: definition.slots,
      fitting,
      fittingLocks,
    };
  }

  function combatView(combat, state) {
    const timeToDeath = Math.min(helpers.playerTtd(combat), helpers.enemyTtd(combat));
    const ship = state.ships.find((item) => item.id === combat.shipId);
    const scrap = ship && ship.cargo[SHIELD_BOOST_ITEM] || 0;
    const boostReady = combat.fightTime >= combat.boostReadyAt;
    const overloadReady = combat.fightTime >= combat.overloadReadyAt;
    return {
      ...combat,
      remaining: Math.max(0, timeToDeath),
      overloaded: combat.fightTime < combat.overloadUntil,
      boostReady,
      overloadReady,
      boostAvailable: boostReady && scrap > 0 && combat.shipShield < combat.shipShieldMax,
      overloadAvailable: overloadReady && scrap > 0,
      boostCooldown: Math.max(0, combat.boostReadyAt - combat.fightTime),
      overloadCooldown: Math.max(0, combat.overloadReadyAt - combat.fightTime),
      boostItem: COMPONENTS[SHIELD_BOOST_ITEM].name,
      overloadItem: COMPONENTS[OVERLOAD_ITEM].name,
      overloadDuration: OVERLOAD_DURATION,
      overloadDpsMultiplier: OVERLOAD_DPS_MULT,
      scrap,
      incomingDamageMultiplier: combat.incomingDamageMultiplier || 1,
    };
  }

  function view(state) {
    const active = state.ships.find((ship) => ship.id === state.activeShipId);
    const system = active && state.systems ? state.systems[active.systemId] : null;
    const multipliers = skillMults(state);
    const drone = { mining: droneBonus(state, 'mining'), dps: droneBonus(state, 'combat') };
    const materials = active ? { ...emptyMaterials(), ...active.cargo } : emptyMaterials();
    const storageItems = (state.storage && (state.storage.items || state.storage.minerals)) || emptyMaterials();
    const dockedAt = dockedStation(state);
    const progressionMaterials = { ...materials };
    for (const [key, amount] of Object.entries(storageItems)) {
      progressionMaterials[key] = (progressionMaterials[key] || 0) + amount;
    }
    const result = {
      version: state.version,
      mode: state.mode,
      mission: missionView(state),
      agentMission: agentMissionView(state),
      automationLog: state.automationLog || [],
      materials,
      minerals: Object.fromEntries(Object.keys(MINERALS).map((key) => [key, materials[key] || 0])),
      ships: state.ships.map((ship) => shipView(ship, multipliers, drone, state.skills || emptySkills())),
      activeShipId: state.activeShipId,
      lastTick: state.lastTick,
      skillPoints: state.skillPoints || 0,
      skillPointRate: SP_RATE_PER_SEC,
      skills: state.skills || emptySkills(),
      skillMults: multipliers,
      drones: {
        mining: active && active.fitting && (active.fitting.miningDrone || []).some((tier) => tier > 0)
          ? active.fitting.miningDrone.filter((tier) => tier > 0)
          : (state.drones || emptyDroneBay()).mining,
        combat: active && active.fitting && (active.fitting.combatDrone || []).some((tier) => tier > 0)
          ? active.fitting.combatDrone.filter((tier) => tier > 0)
          : (state.drones || emptyDroneBay()).combat,
      },
      droneBonuses: {
        mining: moduleBonus(active, 'miningDrone', state.skills, multipliers) + droneBonus(state, 'mining'),
        dps: moduleBonus(active, 'combatDrone', state.skills, multipliers) + droneBonus(state, 'combat'),
      },
      loot: (state.loot || []).map((item) => ({
        id: item.id,
        slotType: item.slotType,
        tier: item.tier,
        name: MODULES[item.slotType] ? MODULES[item.slotType].name : item.slotType,
      })),
      blueprints: (state.blueprints || []).map((blueprint) => {
        const definition = blueprint.kind === 'module'
          ? BLUEPRINTS[blueprint.type] && BLUEPRINTS[blueprint.type][blueprint.tier]
          : blueprint.kind === 'ship' ? SHIP_BLUEPRINTS[blueprint.type] : null;
        return { ...blueprint, name: definition ? definition.name : 'Unknown Blueprint' };
      }),
      storage: {
        items: storageItems,
        loot: state.storage && Array.isArray(state.storage.loot) ? state.storage.loot.map((item) => ({ ...item })) : [],
        blueprints: state.storage && Array.isArray(state.storage.blueprints)
          ? state.storage.blueprints.map((blueprint) => ({ ...blueprint }))
          : [],
      },
      combat: state.combat ? combatView(state.combat, state) : null,
      combatLog: state.combatLog.slice(),
      stats: { ...state.stats },
      achievements: Object.values(ACHIEVEMENTS).map((achievement) => {
        const progress = achievement.stat === 'missionsCompleted'
          ? state.mission && state.mission.completed ? state.mission.completed.length : 0
          : state.stats[achievement.stat] || 0;
        return {
          ...achievement,
          progress: Math.min(progress, achievement.target),
          unlocked: progress >= achievement.target,
        };
      }),
      fittingPresets: state.fittingPresets || [],
      world: system
        ? {
            id: system.id,
            name: system.name,
            color: system.color,
            seed: system.seed,
            width: system.width,
            height: system.height,
            star: system.star,
            planets: system.planets,
            moons: system.moons,
            stations: system.stations,
            outposts: system.outposts || [],
            belts: system.belts,
            asteroids: system.asteroids,
            enemies: system.enemies.map((enemy) => {
              const stats = enemyCombatStats(enemy);
              const tier = ENEMY_TIERS[enemy.tier] || ENEMY_TIERS.standard;
              return {
                ...enemy,
                tier: tier.key,
                tierName: tier.name,
                shield: stats.shield,
                hull: stats.hull,
                dps: stats.dps,
                difficulty: active
                  ? estimateCombatDifficulty(state, active, enemy)
                  : { key: 'unknown', label: 'Unknown', ratio: null },
              };
            }),
            gates: system.gates,
            security: system.security,
          }
        : null,
      system: system
        ? { id: system.id, name: system.name, color: system.color, security: system.security, gates: system.gates }
        : null,
      systemNames: Object.values(state.systems).map((item) => {
        const definition = SYSTEM_DEFS.find((def) => def.id === item.id);
        return {
          id: item.id,
          name: item.name,
          color: item.color,
          security: item.security,
          map: definition ? definition.map : null,
          links: (item.gates || []).map((gate) => gate.targetSystemId),
        };
      }),
      ambush: Object.fromEntries(
        Object.values(state.systems).map((item) => [item.id, ambushChance(state, item.id)])
      ),
    };
    result.activeShip = active ? shipView(active, multipliers, drone) : null;
    result.docked = !!dockedAt;
    result.dockedStation = dockedAt ? dockedAt.name : null;
    result.dockTargetId = active ? active.dockTargetId || null : null;
    result.navigation = active && active.navigation ? { ...active.navigation } : null;
    result.autoPilotMode = state.autoPilotMode || null;
    result.autoPilotSequence = state.autoPilotSequence ? { ...state.autoPilotSequence } : null;
    result.autoPilotEfficiency = autoEfficiency(state);
    result.maxSpeed = shipMaxSpeed(active, multipliers) * result.autoPilotEfficiency;
    result.maxAcceleration = shipMaxAcceleration(active, multipliers) * result.autoPilotEfficiency;
    result.skillTraining = skillTrainingView(state);
    result.shipProgression = shipProgressionView(state, progressionMaterials, result.docked);
    result.actionAvailability = actionAvailability(state, progressionMaterials, result.docked, active);
    result.cargoUsed = cargoUsed(state);
    result.cargoCapacity = cargoCapacity(state);
    result.cargoFull = result.cargoCapacity > 0 && result.cargoUsed >= result.cargoCapacity;
    result.manualMining = !!state.manualMining;
    result.manualMiningTargetId = state.manualMiningTargetId || null;
    result.miningPaused = active ? shipInCombat(state, active.id) || result.docked : true;
    result.miningRange = active ? miningRange(active, multipliers, state.skills) : MINING_RANGE;
    result.miningRate = 0;
    result.miningTargetId = null;
    if (active && !result.miningPaused) {
      const target = state.manualMining
        ? system && system.asteroids.find((asteroid) => asteroid.id === state.manualMiningTargetId && asteroid.amount > 0)
        : nearestAsteroidInRange(state, active);
      if (target) {
        result.miningTargetId = target.id;
        if (dist(target.x, target.y, active.x, active.y) <= result.miningRange) {
          result.miningRate = shipMining(active, multipliers, drone.mining, state.skills) * result.autoPilotEfficiency;
        }
      }
    }
    if (active && system) {
      const nearestStation = system.stations
        .map((station) => ({ station, distance: dist(active.x, active.y, station.x, station.y) }))
        .sort((a, b) => a.distance - b.distance)[0];
      const nearestGate = system.gates
        .map((gate) => ({ gate, distance: dist(active.x, active.y, gate.x, gate.y) }))
        .filter((entry) => entry.distance <= GATE_RANGE)
        .sort((a, b) => a.distance - b.distance)[0];
      const nearestEnemy = system.enemies
        .filter((enemy) => enemy.alive)
        .map((enemy) => ({ enemy, distance: dist(active.x, active.y, enemy.x, enemy.y) }))
        .filter((entry) => entry.distance <= ENGAGE_RANGE)
        .sort((a, b) => a.distance - b.distance)[0];
      result.nearby = {
        stationId: nearestStation ? nearestStation.station.id : null,
        stationDistance: nearestStation ? nearestStation.distance : null,
        gateId: nearestGate ? nearestGate.gate.id : null,
        enemyId: nearestEnemy ? nearestEnemy.enemy.id : null,
      };
    } else {
      result.nearby = { stationId: null, stationDistance: null, gateId: null, enemyId: null };
    }
    return result;
  }

  return { shipView, view };
}

module.exports = createView;
