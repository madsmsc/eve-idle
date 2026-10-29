'use strict';

function createCombatMath({
  ENEMIES,
  ENEMY_TIERS,
  OVERLOAD_DPS_MULT,
  skillMults,
  shipShield,
  shipHull,
  shipDps,
  moduleBonus,
  droneBonus,
}) {
  function applyPool(shieldMax, hullMax, damage) {
    const remainingDamage = Math.max(0, damage);
    const shield = Math.max(0, shieldMax - Math.min(shieldMax, remainingDamage));
    const hull = Math.max(0, hullMax - Math.max(0, remainingDamage - shieldMax));
    return { shield, hull };
  }

  function enemyCombatStats(enemy) {
    const def = ENEMIES[enemy.type];
    const tier = ENEMY_TIERS[enemy.tier] || ENEMY_TIERS.standard;
    const multiplier = tier ? tier.multiplier : 1;
    return {
      shield: def ? def.shield * multiplier : 0,
      hull: def ? def.hull * multiplier : 0,
      dps: def ? def.dps * multiplier : 0,
      rangeDelay: enemy.rangeDelay || 0,
    };
  }

  function estimateCombatDifficulty(state, ship, enemy) {
    const enemyStats = enemyCombatStats(enemy);
    const mults = skillMults(state);
    const playerDurability = shipShield(ship, mults) + shipHull(ship, mults);
    const playerDps = shipDps(ship, mults, droneBonus(state, 'combat'));
    if (playerDps <= 0) return { key: 'unknown', label: 'Unknown', ratio: null };

    const timeToKill = (enemyStats.shield + enemyStats.hull) / playerDps;
    const timeToLose = enemyStats.dps > 0
      ? enemyStats.rangeDelay + moduleBonus(ship, 'range') + playerDurability / enemyStats.dps
      : Infinity;
    const ratio = timeToLose / timeToKill;
    if (ratio >= 1.5) return { key: 'favorable', label: 'Favorable', ratio };
    if (ratio >= 0.85) return { key: 'even', label: 'Even', ratio };
    if (ratio >= 0.55) return { key: 'dangerous', label: 'Dangerous', ratio };
    return { key: 'deadly', label: 'Deadly', ratio };
  }

  function effectivePlayerDps(combat) {
    return combat.playerDps * (combat.fightTime < combat.overloadUntil ? OVERLOAD_DPS_MULT : 1);
  }

  function playerTtd(combat) {
    const pool = combat.shipShield + combat.shipHull;
    if (combat.enemyDps <= 0) return Infinity;
    const remainingWindow = Math.max(0, combat.enemyRangeDelay - combat.fightTime);
    return remainingWindow + pool / combat.enemyDps;
  }

  function enemyTtd(combat) {
    const pool = combat.enemyShield + combat.enemyHull;
    const playerDps = effectivePlayerDps(combat);
    return playerDps > 0 ? pool / playerDps : Infinity;
  }

  function damagePlayer(combat, damage) {
    const pool = applyPool(combat.shipShield, combat.shipHull, damage);
    combat.shipShield = pool.shield;
    combat.shipHull = pool.hull;
  }

  function damageEnemy(combat, damage) {
    const pool = applyPool(combat.enemyShield, combat.enemyHull, damage);
    combat.enemyShield = pool.shield;
    combat.enemyHull = pool.hull;
  }

  return {
    applyPool,
    enemyCombatStats,
    estimateCombatDifficulty,
    effectivePlayerDps,
    playerTtd,
    enemyTtd,
    damagePlayer,
    damageEnemy,
  };
}

module.exports = createCombatMath;
