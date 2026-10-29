'use strict';

const {
  MINERALS,
  WORLD_SIZE,
  ASTEROID_FIELDS,
  ASTEROIDS_PER_FIELD,
  ASTEROID_AMOUNT,
  PLANET_COUNT,
} = require('../config');

const SYSTEM_DEFS = [
  { id: 'sys_0', name: 'Jita', color: '#ff9f45', security: 1.0, stationCount: 2 },
  { id: 'sys_1', name: 'Placid', color: '#3fd6a0', security: 0.5, stationCount: 2 },
  { id: 'sys_2', name: 'Domain', color: '#a970ff', security: 0.1, stationCount: 1 },
];
const GATE_LINKS = [[0, 1], [1, 2], [2, 0]];

function clamp(value, minimum, maximum) {
  return Math.max(minimum, Math.min(maximum, value));
}

function dist(ax, ay, bx, by) {
  return Math.hypot(ax - bx, ay - by);
}

function mulberry32(seed) {
  let value = seed >>> 0;
  return function nextRandom() {
    value |= 0;
    value = (value + 0x6d2b79f5) | 0;
    let result = Math.imul(value ^ (value >>> 15), 1 | value);
    result = (result + Math.imul(result ^ (result >>> 7), 61 | result)) ^ result;
    return ((result ^ (result >>> 14)) >>> 0) / 4294967296;
  };
}

function hashStr(value) {
  let hash = 2166136261;
  for (let i = 0; i < value.length; i++) {
    hash = Math.imul(hash ^ value.charCodeAt(i), 16777619) >>> 0;
  }
  return hash >>> 0;
}

function recoverWorldSeed(homeSystemSeed) {
  return (homeSystemSeed - hashStr(SYSTEM_DEFS[0].id)) >>> 0;
}

function gateSlot(index) {
  const center = WORLD_SIZE / 2;
  return index === 0
    ? { x: center - 1700, y: center - 500 }
    : { x: center + 1700, y: center + 500 };
}

function generateWorld(seed, profile, rollEnemy) {
  const random = mulberry32(seed);
  const size = WORLD_SIZE;
  const centerX = size / 2;
  const centerY = size / 2;
  const mineralKeys = Object.keys(MINERALS);
  const planets = [];
  const moons = [];
  const stations = [];
  const outposts = [];
  const belts = [];
  const asteroids = [];
  const enemies = [];
  let asteroidId = 1;

  const star = { id: 'star_1', x: centerX, y: centerY, size: 130 + random() * 60, name: 'Sol' };
  const home = { id: 'stn_1', x: centerX + 520, y: centerY, name: 'Station A' };
  stations.push(home);
  const placedSites = [home, gateSlot(0), gateSlot(1)];
  const placeSite = () => {
    for (let attempt = 0; attempt < 500; attempt++) {
      const x = 600 + random() * (size - 1200);
      const y = 600 + random() * (size - 1200);
      if (placedSites.every((site) => dist(x, y, site.x, site.y) >= 1000)) {
        const site = { x, y };
        placedSites.push(site);
        return site;
      }
    }
    throw new Error(`Could not place a spaced site in ${profile.name}`);
  };

  for (let i = 1; i < profile.stationCount; i++) {
    const site = placeSite();
    stations.push({ id: `stn_${i + 1}`, ...site, name: `Station ${String.fromCharCode(66 + i)}` });
  }
  for (let i = 0; i < 2; i++) {
    const site = placeSite();
    outposts.push({ id: `outpost_${i + 1}`, ...site, name: `Outpost ${String.fromCharCode(65 + i)}` });
  }

  const planetColors = ['#e0894c', '#5c9ce0', '#9ce05c', '#c95ce0', '#e05c7a', '#5ce0c8'];
  for (let i = 0; i < PLANET_COUNT; i++) {
    let x;
    let y;
    let attempts = 0;
    do {
      x = 1000 + random() * (size - 2000);
      y = 1000 + random() * (size - 2000);
      attempts++;
    } while (dist(x, y, centerX, centerY) < 1400 && attempts < 40);
    planets.push({
      id: `pl_${i + 1}`,
      x,
      y,
      size: 70 + random() * 90,
      color: planetColors[i % planetColors.length],
      name: `Planet ${String.fromCharCode(65 + i)}`,
      ring: random() < 0.45,
    });
  }

  for (const planet of planets) {
    if (random() < 0.6) {
      const angle = random() * Math.PI * 2;
      const radius = planet.size + 140 + random() * 140;
      moons.push({
        id: `mn_${planet.id}`,
        x: clamp(planet.x + Math.cos(angle) * radius, 60, size - 60),
        y: clamp(planet.y + Math.sin(angle) * radius, 60, size - 60),
        size: 18 + random() * 14,
        name: `${planet.name} Moon`,
      });
    }
  }

  for (let field = 0; field < ASTEROID_FIELDS; field++) {
    const { x: fieldX, y: fieldY } = placeSite();
    const fieldMineral = mineralKeys[Math.floor(random() * mineralKeys.length)];
    const beltId = `belt_${field + 1}`;
    belts.push({
      id: beltId,
      x: fieldX,
      y: fieldY,
      name: `Belt ${String.fromCharCode(65 + field)}`,
      mineral: fieldMineral,
    });
    const count = ASTEROIDS_PER_FIELD[0] +
      Math.floor(random() * (ASTEROIDS_PER_FIELD[1] - ASTEROIDS_PER_FIELD[0] + 1));
    for (let i = 0; i < count; i++) {
      const asteroidSize = 14 + random() * 22;
      const minRadius = i === 0 ? 40 : 60;
      const maxRadius = i === 0 ? 90 : 320;
      const isSeparated = (x, y) => asteroids
        .filter((asteroid) => asteroid.beltId === beltId)
        .every((asteroid) =>
          Math.hypot(asteroid.x - x, asteroid.y - y) >= (asteroid.size + asteroidSize) * 1.04 + 4
        );
      let position = null;
      for (let attempt = 0; attempt < 120; attempt++) {
        const angle = random() * Math.PI * 2;
        const radius = minRadius + random() * (maxRadius - minRadius);
        const x = fieldX + Math.cos(angle) * radius;
        const y = fieldY + Math.sin(angle) * radius;
        if (x >= 60 && x <= size - 60 && y >= 60 && y <= size - 60 && isSeparated(x, y)) {
          position = { x, y };
          break;
        }
      }
      if (!position) {
        for (let radius = minRadius; radius <= maxRadius && !position; radius += 8) {
          for (let angle = 0; angle < Math.PI * 2 && !position; angle += Math.PI / 18) {
            const x = fieldX + Math.cos(angle) * radius;
            const y = fieldY + Math.sin(angle) * radius;
            if (x >= 60 && x <= size - 60 && y >= 60 && y <= size - 60 && isSeparated(x, y)) {
              position = { x, y };
            }
          }
        }
      }
      if (!position) throw new Error(`Unable to place asteroid in ${beltId} without overlap`);
      const mineral = random() < 0.8
        ? fieldMineral
        : mineralKeys[Math.floor(random() * mineralKeys.length)];
      const amount = ASTEROID_AMOUNT[0] +
        Math.floor(random() * (ASTEROID_AMOUNT[1] - ASTEROID_AMOUNT[0] + 1));
      asteroids.push({
        id: `ast_${asteroidId++}`,
        x: position.x,
        y: position.y,
        mineral,
        amount,
        maxAmount: amount,
        seed: Math.floor(random() * 1e9),
        size: asteroidSize,
        beltId,
      });
    }
  }

  for (const outpost of outposts) {
    const count = 3 + Math.floor(random() * 3);
    for (let i = 0; i < count; i++) {
      const angle = random() * Math.PI * 2;
      const radius = 180 + random() * 260;
      const { type, tier } = rollEnemy(profile.security, random);
      enemies.push({
        id: `en_${enemies.length + 1}`,
        x: clamp(outpost.x + Math.cos(angle) * radius, 60, size - 60),
        y: clamp(outpost.y + Math.sin(angle) * radius, 60, size - 60),
        type,
        tier,
        outpostId: outpost.id,
        alive: true,
        seed: Math.floor(random() * 1e9),
      });
    }
  }

  return {
    id: profile.id,
    name: profile.name,
    color: profile.color,
    security: profile.security,
    width: size,
    height: size,
    star,
    planets,
    moons,
    stations,
    outposts,
    belts,
    asteroids,
    enemies,
    gates: [],
    seed,
  };
}

function generateSystems(seed, rollEnemy) {
  const systems = {};
  for (const definition of SYSTEM_DEFS) {
    systems[definition.id] = generateWorld((seed + hashStr(definition.id)) >>> 0, definition, rollEnemy);
  }
  for (const [a, b] of GATE_LINKS) {
    const definitionA = SYSTEM_DEFS[a];
    const definitionB = SYSTEM_DEFS[b];
    const systemA = systems[definitionA.id];
    const systemB = systems[definitionB.id];
    const positionA = gateSlot(systemA.gates.length);
    const positionB = gateSlot(systemB.gates.length);
    systemA.gates.push({
      id: `gate_${a}_${b}`,
      x: positionA.x,
      y: positionA.y,
      targetSystemId: definitionB.id,
      targetGateId: `gate_${b}_${a}`,
      name: `Gate to ${definitionB.name}`,
    });
    systemB.gates.push({
      id: `gate_${b}_${a}`,
      x: positionB.x,
      y: positionB.y,
      targetSystemId: definitionA.id,
      targetGateId: `gate_${a}_${b}`,
      name: `Gate to ${definitionA.name}`,
    });
  }
  return systems;
}

module.exports = { SYSTEM_DEFS, generateSystems, recoverWorldSeed };
