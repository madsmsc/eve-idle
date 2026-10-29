'use strict';

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
    MAX_SPEED,
    MAX_ACCELERATION,
    MINING_RANGE,
    ENGAGE_RANGE,
    GATE_RANGE,
  } = config;
  const {
    skillMults,
    droneBonus,
    emptyMaterials,
    dockedStation,
    missionView,
    agentMissionView,
    emptySkills,
    emptyDroneBay,
    moduleBonus,
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
  const { SHIPS } = config;

  function shipView(ship, mults, drone) {
    const definition = SHIPS[ship.type];
    const bonuses = drone || { mining: 0, dps: 0 };
    return {
      id: ship.id,
      type: ship.type,
      name: definition.name,
      x: ship.x,
      y: ship.y,
      vx: ship.vx || 0,
      vy: ship.vy || 0,
      heading: ship.heading || 0,
      speed: Math.hypot(ship.vx || 0, ship.vy || 0),
      systemId: ship.systemId,
      mining: shipMining(ship, mults, bonuses.mining),
      combat: definition.combat,
      dps: (definition.dps + moduleBonus(ship, 'weapon') + moduleBonus(ship, 'combatDrone') + bonuses.dps) *
        (mults ? mults.dps : 1),
      shield: (definition.shield + moduleBonus(ship, 'shield')) * (mults ? mults.shield : 1),
      hull: (definition.hull + moduleBonus(ship, 'armor')) * (mults ? mults.hull : 1),
      cargo: shipCargo(ship, mults),
      slots: definition.slots,
      fitting: ship.fitting || helpers.emptyFitting(ship.type),
    };
  }

  function combatView(combat) {
    const timeToDeath = Math.min(helpers.playerTtd(combat), helpers.enemyTtd(combat));
    return {
      ...combat,
      remaining: Math.max(0, timeToDeath),
      overloaded: combat.fightTime < combat.overloadUntil,
      boostReady: combat.fightTime >= combat.boostReadyAt,
      overloadReady: combat.fightTime >= combat.overloadReadyAt,
      boostCooldown: Math.max(0, combat.boostReadyAt - combat.fightTime),
      overloadCooldown: Math.max(0, combat.overloadReadyAt - combat.fightTime),
      boostItem: COMPONENTS[SHIELD_BOOST_ITEM].name,
      overloadItem: COMPONENTS[OVERLOAD_ITEM].name,
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
      ships: state.ships.map((ship) => shipView(ship, multipliers, drone)),
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
        mining: moduleBonus(active, 'miningDrone') + droneBonus(state, 'mining'),
        dps: moduleBonus(active, 'combatDrone') + droneBonus(state, 'combat'),
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
      combat: state.combat ? combatView(state.combat) : null,
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
      systemNames: Object.values(state.systems).map((item) => ({
        id: item.id,
        name: item.name,
        color: item.color,
        security: item.security,
      })),
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
    result.maxSpeed = MAX_SPEED * result.autoPilotEfficiency;
    result.maxAcceleration = MAX_ACCELERATION * result.autoPilotEfficiency;
    result.skillTraining = skillTrainingView(state);
    result.shipProgression = shipProgressionView(state, progressionMaterials, result.docked);
    result.actionAvailability = actionAvailability(state, progressionMaterials, result.docked, active);
    result.cargoUsed = cargoUsed(state);
    result.cargoCapacity = cargoCapacity(state);
    result.cargoFull = result.cargoCapacity > 0 && result.cargoUsed >= result.cargoCapacity;
    result.miningPaused = active ? shipInCombat(state, active.id) : true;
    result.miningRange = active ? miningRange(active) : MINING_RANGE;
    result.miningRate = 0;
    result.miningTargetId = null;
    if (active && !result.miningPaused) {
      const target = nearestAsteroidInRange(state, active);
      if (target) {
        result.miningRate = shipMining(active, multipliers, drone.mining) * result.autoPilotEfficiency;
        result.miningTargetId = target.id;
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
