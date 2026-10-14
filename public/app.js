'use strict';

// Frontend for the rendered world. The canvas is the game; the HTML is a thin
// HUD. The client owns smooth ship movement locally and reports its position to
// the server on each sync; the server stays authoritative for resources, the
// world (asteroids/enemies), and combat outcomes.

const canvas = document.getElementById('world');
const ctx = canvas.getContext('2d');
const minimap = document.getElementById('minimap');
const mctx = minimap.getContext('2d');

let catalog = null;
let C = null; // spatial constants from the server
let state = null;

// Local (client-authoritative) state for the active ship.
const ship = { x: 0, y: 0, vx: 0, vy: 0, heading: 0 };
let keys = {};
let destination = null;
let targetEnemyId = null;
// Client-only battle animation state. The server is authoritative for the
// outcome; this just makes the fight lively (drones, shots, explosions).
let combatFx = { enemyId: null, enemyX: 0, enemyY: 0, battleStartPerf: 0, explosions: [] };
let zoom = 1.0;
let hangarOpen = false;
let autoPilot = false; // "Auto" toggle: automates the idle mining loop
let lastAutoTick = 0;
let stars = [];
let warpFx = 0; // perf.now() of the last warp/jump, drives the flash effect
let warpPending = false; // true while a warp/jump request is in flight
let systemColor = { r: 120, g: 120, b: 160 }; // current system's background hue

// Screen shake: a decaying intensity that jitters the world, triggered when the
// ship takes damage in combat or is destroyed.
let shake = 0;
let shakeX = 0;
let shakeY = 0;
// The player's shield/hull pool on the previous frame, to detect damage taken.
let lastCombatPool = null;

// Re-read the active system's hue so the background/starfield can be tinted to
// match it. Each system has a persistent, unique color, so you can tell them
// apart by their shade even if you forget the name.
function applySystemColor() {
  const hex =
    (state && state.world && state.world.color) ||
    (state && state.system && state.system.color) ||
    null;
  if (hex) systemColor = hexToRgb(hex);
}

const STAR_TILE = 1500;
const STAR_COUNT = 170;
const SYNC_MS = 400;

let lastFrame = performance.now();
let lastSync = 0;
let toastTimer = null;

// ---------- helpers ----------
function fmt(n) {
  if (!Number.isFinite(n)) return '0';
  const abs = Math.abs(n);
  if (abs >= 1e9) return (n / 1e9).toFixed(2) + 'B';
  if (abs >= 1e6) return (n / 1e6).toFixed(2) + 'M';
  if (abs >= 1e3) return (n / 1e3).toFixed(1) + 'K';
  return Math.floor(n).toString();
}
function pseudo(n) {
  const x = Math.sin(n * 127.1) * 43758.5453;
  return x - Math.floor(x);
}
function clamp(v, lo, hi) {
  return Math.max(lo, Math.min(hi, v));
}
function dist(ax, ay, bx, by) {
  return Math.hypot(ax - bx, ay - by);
}
function hexToRgb(hex) {
  const h = (hex || '').replace('#', '');
  return {
    r: parseInt(h.slice(0, 2), 16) || 0,
    g: parseInt(h.slice(2, 4), 16) || 0,
    b: parseInt(h.slice(4, 6), 16) || 0,
  };
}
function mixRgb(a, b, t) {
  return {
    r: Math.round(a.r + (b.r - a.r) * t),
    g: Math.round(a.g + (b.g - a.g) * t),
    b: Math.round(a.b + (b.b - a.b) * t),
  };
}
function rgbStr(c, a) {
  return a === undefined ? `rgb(${c.r},${c.g},${c.b})` : `rgba(${c.r},${c.g},${c.b},${a})`;
}

async function api(path, body) {
  const opts = { method: body ? 'POST' : 'GET', headers: {} };
  if (body) {
    opts.headers['Content-Type'] = 'application/json';
    opts.body = JSON.stringify(body);
  }
  const res = await fetch(path, opts);
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
  return data;
}

function toast(msg, isError) {
  const el = document.getElementById('toast');
  el.textContent = msg;
  el.className = 'toast show' + (isError ? ' error' : '');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { el.className = 'toast'; }, 2600);
}

// ---------- coordinates ----------
function worldToScreen(wx, wy) {
  return {
    x: (wx - ship.x) * zoom + canvas.width / 2 + shakeX,
    y: (wy - ship.y) * zoom + canvas.height / 2 + shakeY,
  };
}
function screenToWorld(sx, sy) {
  return {
    x: (sx - canvas.width / 2) / zoom + ship.x,
    y: (sy - canvas.height / 2) / zoom + ship.y,
  };
}
function getViewBounds() {
  const hw = canvas.width / 2 / zoom;
  const hh = canvas.height / 2 / zoom;
  return { minX: ship.x - hw, maxX: ship.x + hw, minY: ship.y - hh, maxY: ship.y + hh };
}

// ---------- starfield ----------
function genStars() {
  stars = [];
  for (let i = 0; i < STAR_COUNT; i++) {
    stars.push({
      x: Math.random() * STAR_TILE,
      y: Math.random() * STAR_TILE,
      size: 0.5 + Math.random() * 1.6,
      bright: 0.25 + Math.random() * 0.6,
    });
  }
}
function drawStars() {
  const parallax = 0.3;
  const offX = (((ship.x * parallax) % STAR_TILE + STAR_TILE) % STAR_TILE) - shakeX;
  const offY = (((ship.y * parallax) % STAR_TILE + STAR_TILE) % STAR_TILE) - shakeY;
  const cols = Math.ceil(canvas.width / STAR_TILE) + 1;
  const rows = Math.ceil(canvas.height / STAR_TILE) + 1;
  const starCol = rgbStr(mixRgb({ r: 207, g: 224, b: 255 }, systemColor, 0.5));
  for (let tx = -1; tx < cols; tx++) {
    for (let ty = -1; ty < rows; ty++) {
      const baseX = tx * STAR_TILE - offX;
      const baseY = ty * STAR_TILE - offY;
      for (const s of stars) {
        const sx = baseX + s.x;
        const sy = baseY + s.y;
        if (sx < -2 || sy < -2 || sx > canvas.width + 2 || sy > canvas.height + 2) continue;
        ctx.globalAlpha = s.bright;
        ctx.fillStyle = starCol;
        ctx.fillRect(sx, sy, s.size, s.size);
      }
    }
  }
  ctx.globalAlpha = 1;
}

// ---------- physics ----------
function clampToWorld() {
  ship.x = clamp(ship.x, 0, C.worldSize);
  ship.y = clamp(ship.y, 0, C.worldSize);
}
function updateShip(dt) {
  const inCombat = !!state.combat;
  if (inCombat) {
    ship.vx *= 0.9;
    ship.vy *= 0.9;
    ship.x += ship.vx * dt;
    ship.y += ship.vy * dt;
    clampToWorld();
    return;
  }

  if (destination) {
    const dx = destination.x - ship.x;
    const dy = destination.y - ship.y;
    const d = Math.hypot(dx, dy);
    if (d < C.arriveRadius) {
      destination = null;
    } else {
      const desired = Math.min(C.maxSpeed, d * 0.6);
      const steer = Math.min(1, dt * 2.2);
      ship.vx += ((dx / d) * desired - ship.vx) * steer;
      ship.vy += ((dy / d) * desired - ship.vy) * steer;
    }
  }

  const damp = Math.pow(C.damping, dt * 60);
  ship.vx *= damp;
  ship.vy *= damp;
  const sp = Math.hypot(ship.vx, ship.vy);
  if (sp > C.maxSpeed) {
    ship.vx = (ship.vx / sp) * C.maxSpeed;
    ship.vy = (ship.vy / sp) * C.maxSpeed;
  }
  ship.x += ship.vx * dt;
  ship.y += ship.vy * dt;
  clampToWorld();
  if (sp > 4) ship.heading = Math.atan2(ship.vy, ship.vx);
}

// ---------- rendering ----------
function drawGrid() {
  const view = getViewBounds();
  const step = 500;
  ctx.lineWidth = 1;
  ctx.strokeStyle = 'rgba(80, 120, 200, 0.08)';
  const startX = Math.floor(view.minX / step) * step;
  const endX = Math.ceil(view.maxX / step) * step;
  const startY = Math.floor(view.minY / step) * step;
  const endY = Math.ceil(view.maxY / step) * step;
  ctx.beginPath();
  for (let gx = startX; gx <= endX; gx += step) {
    const p = worldToScreen(gx, 0);
    ctx.moveTo(p.x, 0);
    ctx.lineTo(p.x, canvas.height);
  }
  for (let gy = startY; gy <= endY; gy += step) {
    const p = worldToScreen(0, gy);
    ctx.moveTo(0, p.y);
    ctx.lineTo(canvas.width, p.y);
  }
  ctx.stroke();
}

function drawWorldBounds() {
  const tl = worldToScreen(0, 0);
  const br = worldToScreen(C.worldSize, C.worldSize);
  ctx.lineWidth = 2;
  ctx.strokeStyle = 'rgba(255, 92, 122, 0.35)';
  ctx.strokeRect(tl.x, tl.y, br.x - tl.x, br.y - tl.y);
}

function drawAsteroid(sx, sy, a) {
  const r = a.size * zoom;
  if (r < 1.5) {
    ctx.fillStyle = catalog.minerals[a.mineral].color;
    ctx.globalAlpha = 0.7;
    ctx.fillRect(sx - 1, sy - 1, 2, 2);
    ctx.globalAlpha = 1;
    return;
  }
  const color = catalog.minerals[a.mineral].color;
  const n = 8;
  ctx.beginPath();
  for (let i = 0; i < n; i++) {
    const ang = (i / n) * Math.PI * 2;
    const wobble = 0.72 + 0.34 * pseudo(a.seed + i * 7);
    const px = sx + Math.cos(ang) * r * wobble;
    const py = sy + Math.sin(ang) * r * wobble;
    if (i === 0) ctx.moveTo(px, py);
    else ctx.lineTo(px, py);
  }
  ctx.closePath();
  ctx.fillStyle = 'rgba(52, 58, 76, 0.92)';
  ctx.fill();
  ctx.lineWidth = Math.max(1, 2 * zoom);
  ctx.strokeStyle = color;
  ctx.stroke();
  ctx.globalAlpha = 0.85;
  ctx.beginPath();
  ctx.arc(sx, sy, r * 0.32, 0, Math.PI * 2);
  ctx.fillStyle = color;
  ctx.fill();
  ctx.globalAlpha = 1;
}

function drawAsteroids() {
  const view = getViewBounds();
  for (const a of state.world.asteroids) {
    if (a.amount <= 0) continue;
    if (a.x < view.minX - 50 || a.x > view.maxX + 50 || a.y < view.minY - 50 || a.y > view.maxY + 50) continue;
    const p = worldToScreen(a.x, a.y);
    drawAsteroid(p.x, p.y, a);
  }
}

function enemySize(type) {
  return type === 'dread' ? 26 : type === 'faction' ? 20 : type === 'gang' ? 16 : 13;
}
function drawEnemyShip(sx, sy, e) {
  const r = enemySize(e.type) * zoom;
  ctx.save();
  ctx.translate(sx, sy);
  ctx.rotate(pseudo(e.seed) * Math.PI * 2);
  ctx.beginPath();
  ctx.moveTo(0, -r);
  ctx.lineTo(r * 0.8, r * 0.7);
  ctx.lineTo(0, r * 0.3);
  ctx.lineTo(-r * 0.8, r * 0.7);
  ctx.closePath();
  ctx.fillStyle = 'rgba(120, 20, 40, 0.9)';
  ctx.fill();
  ctx.lineWidth = Math.max(1, 1.5 * zoom);
  ctx.strokeStyle = '#ff5c7a';
  ctx.stroke();
  ctx.restore();
}

function drawEnemies() {
  const view = getViewBounds();
  for (const e of state.world.enemies) {
    if (!e.alive) continue;
    if (e.x < view.minX - 60 || e.x > view.maxX + 60 || e.y < view.minY - 60 || e.y > view.maxY + 60) continue;
    const p = worldToScreen(e.x, e.y);
    drawEnemyShip(p.x, p.y, e);
    if (e.id === targetEnemyId) {
      const r = (enemySize(e.type) + 8) * zoom;
      ctx.strokeStyle = '#ff5c7a';
      ctx.lineWidth = 1.5;
      ctx.strokeRect(p.x - r, p.y - r, r * 2, r * 2);
    }
  }
}

function drawStar() {
  const s = state.world.star;
  const p = worldToScreen(s.x, s.y);
  const r = s.size * zoom;
  const g = ctx.createRadialGradient(p.x, p.y, 0, p.x, p.y, r * 2.2);
  g.addColorStop(0, 'rgba(255, 244, 214, 0.95)');
  g.addColorStop(0.3, 'rgba(255, 200, 90, 0.5)');
  g.addColorStop(1, 'rgba(255, 160, 40, 0)');
  ctx.fillStyle = g;
  ctx.beginPath();
  ctx.arc(p.x, p.y, r * 2.2, 0, Math.PI * 2);
  ctx.fill();
  ctx.fillStyle = '#fff4d6';
  ctx.beginPath();
  ctx.arc(p.x, p.y, r * 0.5, 0, Math.PI * 2);
  ctx.fill();
}

function drawPlanet(pl) {
  const p = worldToScreen(pl.x, pl.y);
  const r = pl.size * zoom;
  if (r < 2) {
    ctx.fillStyle = pl.color;
    ctx.fillRect(p.x - 1, p.y - 1, 2, 2);
    return;
  }
  ctx.save();
  ctx.translate(p.x, p.y);
  if (pl.ring) {
    ctx.strokeStyle = 'rgba(220, 220, 240, 0.5)';
    ctx.lineWidth = Math.max(1, r * 0.12);
    ctx.beginPath();
    ctx.ellipse(0, 0, r * 1.7, r * 0.5, -0.4, 0, Math.PI * 2);
    ctx.stroke();
  }
  const g = ctx.createRadialGradient(-r * 0.3, -r * 0.3, r * 0.2, 0, 0, r);
  g.addColorStop(0, pl.color);
  g.addColorStop(1, 'rgba(0,0,0,0.55)');
  ctx.fillStyle = g;
  ctx.beginPath();
  ctx.arc(0, 0, r, 0, Math.PI * 2);
  ctx.fill();
  ctx.restore();
}

function drawMoons() {
  for (const m of state.world.moons) {
    const p = worldToScreen(m.x, m.y);
    ctx.fillStyle = 'rgba(180, 190, 210, 0.85)';
    ctx.beginPath();
    ctx.arc(p.x, p.y, Math.max(1.5, m.size * zoom), 0, Math.PI * 2);
    ctx.fill();
  }
}

function drawBelts() {
  for (const b of state.world.belts) {
    const p = worldToScreen(b.x, b.y);
    const r = 300 * zoom;
    ctx.strokeStyle = 'rgba(120, 150, 200, 0.18)';
    ctx.lineWidth = 1;
    ctx.setLineDash([6, 10]);
    ctx.beginPath();
    ctx.arc(p.x, p.y, r, 0, Math.PI * 2);
    ctx.stroke();
    ctx.setLineDash([]);
    ctx.fillStyle = 'rgba(150, 175, 220, 0.7)';
    ctx.font = `${Math.max(9, 11 * zoom)}px sans-serif`;
    ctx.textAlign = 'center';
    ctx.fillText(b.name, p.x, p.y - r - 6);
  }
}

function drawStations() {
  for (const st of state.world.stations) {
    const p = worldToScreen(st.x, st.y);
    const r = 34 * zoom;
    ctx.save();
    ctx.translate(p.x, p.y);
    ctx.strokeStyle = 'rgba(120, 200, 255, 0.7)';
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.arc(0, 0, r, 0, Math.PI * 2);
    ctx.stroke();
    ctx.strokeStyle = 'rgba(120, 200, 255, 0.35)';
    ctx.beginPath();
    ctx.arc(0, 0, r * 0.6, 0, Math.PI * 2);
    ctx.stroke();
    ctx.strokeStyle = 'rgba(120, 200, 255, 0.6)';
    for (let i = 0; i < 4; i++) {
      const a = (i / 4) * Math.PI * 2 + Math.PI / 4;
      ctx.beginPath();
      ctx.moveTo(Math.cos(a) * r * 0.6, Math.sin(a) * r * 0.6);
      ctx.lineTo(Math.cos(a) * r * 1.15, Math.sin(a) * r * 1.15);
      ctx.stroke();
    }
    ctx.fillStyle = 'rgba(120, 200, 255, 0.9)';
    ctx.font = `${Math.max(10, 12 * zoom)}px sans-serif`;
    ctx.textAlign = 'center';
    ctx.fillText(st.name, 0, r + 18 * zoom);
    ctx.restore();
  }
}

function drawGates() {
  const view = getViewBounds();
  for (const g of state.world.gates || []) {
    if (g.x < view.minX - 120 || g.x > view.maxX + 120 || g.y < view.minY - 120 || g.y > view.maxY + 120) continue;
    const p = worldToScreen(g.x, g.y);
    const r = 60 * zoom;
    const pulse = 0.6 + 0.4 * Math.sin(performance.now() / 500);
    ctx.save();
    ctx.translate(p.x, p.y);
    const glow = ctx.createRadialGradient(0, 0, 0, 0, 0, r * 1.8);
    glow.addColorStop(0, `rgba(124, 92, 255, ${0.5 * pulse})`);
    glow.addColorStop(1, 'rgba(124, 92, 255, 0)');
    ctx.fillStyle = glow;
    ctx.beginPath();
    ctx.arc(0, 0, r * 1.8, 0, Math.PI * 2);
    ctx.fill();
    ctx.strokeStyle = `rgba(180, 150, 255, ${0.8 * pulse})`;
    ctx.lineWidth = 3 * zoom;
    ctx.beginPath();
    ctx.arc(0, 0, r, 0, Math.PI * 2);
    ctx.stroke();
    ctx.strokeStyle = 'rgba(220, 200, 255, 0.9)';
    ctx.lineWidth = 1.5 * zoom;
    ctx.beginPath();
    ctx.arc(0, 0, r * 0.7, 0, Math.PI * 2);
    ctx.stroke();
    const target = (state.systemNames || []).find((s) => s.id === g.targetSystemId);
    ctx.fillStyle = target && target.color ? target.color : 'rgba(200, 180, 255, 0.9)';
    ctx.font = `${Math.max(9, 11 * zoom)}px sans-serif`;
    ctx.textAlign = 'center';
    ctx.fillText('Gate → ' + (target ? target.name : '?'), 0, r + 18 * zoom);
    ctx.restore();
  }
}

function drawWarpFlash(now) {
  if (!warpFx) return;
  const t = (now - warpFx) / 350;
  if (t >= 1) {
    warpFx = 0;
    return;
  }
  ctx.save();
  ctx.fillStyle = `rgba(120, 200, 255, ${(1 - t) * 0.5})`;
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.restore();
}

function drawDestination() {
  if (!destination) return;
  const p = worldToScreen(destination.x, destination.y);
  const cx = canvas.width / 2;
  const cy = canvas.height / 2;
  ctx.save();
  ctx.strokeStyle = 'rgba(79, 209, 255, 0.5)';
  ctx.lineWidth = 1;
  ctx.setLineDash([4, 8]);
  ctx.lineDashOffset = -performance.now() / 40;
  ctx.beginPath();
  ctx.moveTo(cx, cy);
  ctx.lineTo(p.x, p.y);
  ctx.stroke();
  ctx.restore();
  ctx.strokeStyle = 'rgba(79, 209, 255, 0.8)';
  ctx.lineWidth = 1.5;
  const r = 12;
  ctx.beginPath();
  ctx.arc(p.x, p.y, r, 0, Math.PI * 2);
  ctx.stroke();
  ctx.beginPath();
  ctx.moveTo(p.x - r - 5, p.y);
  ctx.lineTo(p.x + r + 5, p.y);
  ctx.moveTo(p.x, p.y - r - 5);
  ctx.lineTo(p.x, p.y + r + 5);
  ctx.stroke();
}

function nearestAsteroidLocal() {
  let best = null;
  let bd = Infinity;
  for (const a of state.world.asteroids) {
    if (a.amount <= 0) continue;
    const d = dist(a.x, a.y, ship.x, ship.y);
    if (d <= C.miningRange && d < bd) {
      bd = d;
      best = a;
    }
  }
  return best;
}

function drawBeam(now) {
  const a = nearestAsteroidLocal();
  if (!a || state.combat) return;
  const p = worldToScreen(a.x, a.y);
  const cx = canvas.width / 2;
  const cy = canvas.height / 2;
  const pulse = 0.5 + 0.5 * Math.sin(now / 120);
  ctx.save();
  ctx.strokeStyle = catalog.minerals[a.mineral].color;
  ctx.globalAlpha = 0.5 + 0.4 * pulse;
  ctx.lineWidth = 2 + pulse * 2;
  ctx.setLineDash([10, 6]);
  ctx.lineDashOffset = -now / 20;
  ctx.beginPath();
  ctx.moveTo(cx, cy);
  ctx.lineTo(p.x, p.y);
  ctx.stroke();
  ctx.restore();
}

// Mining drones orbit the asteroid you are mining (one per owned mining drone).
function drawMiningDrones(now) {
  const n = state.drones && state.drones.mining ? state.drones.mining.length : 0;
  if (!n || state.combat) return;
  const a = nearestAsteroidLocal();
  if (!a) return;
  const p = worldToScreen(a.x, a.y);
  const orbitR = 42 * zoom;
  const ang = -now / 700;
  for (let i = 0; i < Math.min(n, 6); i++) {
    const t = ang + (i / Math.max(1, n)) * Math.PI * 2;
    const dx = p.x + Math.cos(t) * orbitR;
    const dy = p.y + Math.sin(t) * orbitR;
    ctx.save();
    ctx.translate(dx, dy);
    ctx.rotate(t);
    const r = 5 * zoom;
    ctx.beginPath();
    ctx.moveTo(0, -r);
    ctx.lineTo(r * 0.8, r * 0.7);
    ctx.lineTo(-r * 0.8, r * 0.7);
    ctx.closePath();
    ctx.fillStyle = 'rgba(60, 200, 140, 0.9)';
    ctx.fill();
    ctx.strokeStyle = '#7ff0c0';
    ctx.lineWidth = 1;
    ctx.stroke();
    ctx.restore();
  }
}

function drawShip() {
  const cx = canvas.width / 2;
  const cy = canvas.height / 2;
  const s = 22 * zoom;
  ctx.save();
  ctx.translate(cx, cy);
  ctx.rotate(ship.heading + Math.PI / 2);
  // engine glow
  const sp = Math.hypot(ship.vx, ship.vy);
  if (sp > 10) {
    ctx.globalAlpha = clamp(sp / C.maxSpeed, 0.2, 0.9);
    ctx.fillStyle = '#4fd1ff';
    ctx.beginPath();
    ctx.moveTo(-s * 0.25, s * 0.7);
    ctx.lineTo(0, s * (0.9 + 0.5 * (sp / C.maxSpeed)));
    ctx.lineTo(s * 0.25, s * 0.7);
    ctx.closePath();
    ctx.fill();
    ctx.globalAlpha = 1;
  }
  // hull
  ctx.beginPath();
  ctx.moveTo(0, -s);
  ctx.lineTo(s * 0.7, s * 0.7);
  ctx.lineTo(0, s * 0.35);
  ctx.lineTo(-s * 0.7, s * 0.7);
  ctx.closePath();
  ctx.fillStyle = 'rgba(30, 60, 90, 0.95)';
  ctx.fill();
  ctx.lineWidth = 2;
  ctx.strokeStyle = '#4fd1ff';
  ctx.stroke();
  // cockpit
  ctx.beginPath();
  ctx.arc(0, -s * 0.2, s * 0.22, 0, Math.PI * 2);
  ctx.fillStyle = '#bfefff';
  ctx.fill();
  ctx.restore();
}

// ---------- combat FX ----------
// Animate the fight the server is resolving: drones orbit the ship, lasers and
// rockets fly at the target, the enemy's integrity bar falls, and an explosion
// plays when the server reports the outcome.
function drawCombatFx(now) {
  combatFx.explosions = combatFx.explosions.filter((ex) => now - ex.at < 1100);
  for (const ex of combatFx.explosions) drawExplosion(ex, now);

  const c = state.combat;
  if (!c) return;
  const e = state.world.enemies.find((x) => x.id === c.enemyId);
  if (!e) return;
  const ep = worldToScreen(e.x, e.y);
  const cx = canvas.width / 2;
  const cy = canvas.height / 2;

  // Drones orbit the ship and fire at the target. The number scales with your
  // owned combat drones (at least a few decorative ones).
  const combatDrones = state.drones && state.drones.combat ? state.drones.combat.length : 0;
  const nDrones = combatDrones > 0 ? Math.min(combatDrones, 6) : 3;
  const orbitR = 48 * zoom;
  const orbitAng = now / 850;
  for (let i = 0; i < nDrones; i++) {
    const a = orbitAng + (i / nDrones) * Math.PI * 2;
    const dx = cx + Math.cos(a) * orbitR;
    const dy = cy + Math.sin(a) * orbitR;
    drawDrone(dx, dy, a + Math.PI / 2);
    if (pseudo(i * 31 + Math.floor(now / 130)) > 0.3) {
      drawLaser(dx, dy, ep.x, ep.y, now, i * 7 + 1);
    }
  }
  // The ship's own main gun.
  drawLaser(cx, cy, ep.x, ep.y, now, 42);
  drawRockets(cx, cy, ep.x, ep.y, now);

  // Live shield + hull for the target (above it) and your ship (below center),
  // straight from the server's real-time simulation.
  const er = enemySize(e.type) * zoom;
  drawShipBars(ep.x, ep.y - er - 24 * zoom, 66 * zoom, c.enemyShield, c.enemyShieldMax, c.enemyHull, c.enemyHullMax);
  drawShipBars(cx, cy + 40 * zoom, 74 * zoom, c.shipShield, c.shipShieldMax, c.shipHull, c.shipHullMax);

  // Hit flash on the enemy.
  const flash = Math.max(0, Math.sin(now / 80));
  if (flash > 0.35) {
    ctx.save();
    ctx.globalAlpha = (flash - 0.35) * 0.7;
    ctx.fillStyle = '#fff';
    ctx.beginPath();
    ctx.arc(ep.x, ep.y, er, 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();
  }
}

// Two stacked bars (shield on top, hull below) centered on (x, y).
function drawShipBars(x, y, w, shield, shieldMax, hull, hullMax) {
  const h = 5;
  const gap = 2;
  drawBar(x, y, w, h, shieldMax > 0 ? shield / shieldMax : 0, '#4fd1ff');
  drawBar(x, y + h + gap, w, h, hullMax > 0 ? hull / hullMax : 0, '#35d07f');
}
function drawBar(x, y, w, h, frac, color) {
  ctx.save();
  ctx.fillStyle = 'rgba(0,0,0,0.6)';
  ctx.fillRect(x - w / 2, y, w, h);
  ctx.fillStyle = color;
  ctx.fillRect(x - w / 2, y, w * clamp(frac, 0, 1), h);
  ctx.strokeStyle = 'rgba(255,255,255,0.35)';
  ctx.lineWidth = 1;
  ctx.strokeRect(x - w / 2, y, w, h);
  ctx.restore();
}

function drawDrone(x, y, angle) {
  const r = 7 * zoom;
  ctx.save();
  ctx.translate(x, y);
  ctx.rotate(angle);
  ctx.beginPath();
  ctx.moveTo(0, -r);
  ctx.lineTo(r * 0.8, r * 0.7);
  ctx.lineTo(-r * 0.8, r * 0.7);
  ctx.closePath();
  ctx.fillStyle = 'rgba(40, 180, 200, 0.9)';
  ctx.fill();
  ctx.lineWidth = 1;
  ctx.strokeStyle = '#7fe7f0';
  ctx.stroke();
  ctx.restore();
}

function drawLaser(x1, y1, x2, y2, now, seed) {
  const pulse = 0.5 + 0.5 * Math.sin(now / 60 + seed);
  ctx.save();
  ctx.globalAlpha = 0.35 + 0.5 * pulse;
  ctx.strokeStyle = '#ffd24a';
  ctx.lineWidth = 1.5 + pulse * 1.5;
  ctx.shadowColor = '#ffb020';
  ctx.shadowBlur = 8;
  ctx.beginPath();
  ctx.moveTo(x1, y1);
  ctx.lineTo(x2, y2);
  ctx.stroke();
  ctx.restore();
}

function drawRockets(cx, cy, ex, ey, now) {
  const period = 900;
  for (let i = 0; i < 2; i++) {
    const t = (now / period + i * 0.5) % 1;
    const mx = (cx + ex) / 2;
    const my = (cy + ey) / 2 - 40 * zoom;
    const bx = (1 - t) * (1 - t) * cx + 2 * (1 - t) * t * mx + t * t * ex;
    const by = (1 - t) * (1 - t) * cy + 2 * (1 - t) * t * my + t * t * ey;
    ctx.save();
    ctx.fillStyle = '#9fd8ff';
    ctx.shadowColor = '#5ab0ff';
    ctx.shadowBlur = 6;
    ctx.beginPath();
    ctx.arc(bx, by, 2.5 * zoom, 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();
  }
}

function drawExplosion(ex, now) {
  const t = (now - ex.at) / 1100;
  if (t < 0 || t > 1) return;
  const p = worldToScreen(ex.x, ex.y);
  const maxR = (ex.kind === 'ship' ? 60 : 46) * zoom;
  const r = maxR * (0.2 + 0.8 * t);
  const alpha = 1 - t;
  ctx.save();
  ctx.globalAlpha = alpha;
  const g = ctx.createRadialGradient(p.x, p.y, 0, p.x, p.y, r);
  g.addColorStop(0, ex.kind === 'ship' ? 'rgba(150,210,255,0.95)' : 'rgba(255,225,130,0.95)');
  g.addColorStop(0.5, 'rgba(255,140,40,0.8)');
  g.addColorStop(1, 'rgba(255,60,20,0)');
  ctx.fillStyle = g;
  ctx.beginPath();
  ctx.arc(p.x, p.y, r, 0, Math.PI * 2);
  ctx.fill();
  ctx.fillStyle = '#fff';
  for (let i = 0; i < 8; i++) {
    const a = pseudo(i * 17 + ex.at) * Math.PI * 2;
    const sr = r * (0.5 + 0.7 * t) * pseudo(i * 3 + ex.at);
    ctx.globalAlpha = alpha * 0.8;
    ctx.beginPath();
    ctx.arc(p.x + Math.cos(a) * sr, p.y + Math.sin(a) * sr, 1.5, 0, Math.PI * 2);
    ctx.fill();
  }
  ctx.restore();
}

function renderBackground() {
  // Near-black base, subtly tinted toward the system's hue.
  const base = mixRgb({ r: 4, g: 6, b: 12 }, systemColor, 0.12);
  ctx.fillStyle = rgbStr(base);
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  // A few large, soft nebula glows in the system color so the whole space reads
  // as that system's shade (the "green system", the "purple system").
  const blobs = [
    { fx: 0.22, fy: 0.28, r: 0.55 },
    { fx: 0.8, fy: 0.5, r: 0.65 },
    { fx: 0.5, fy: 0.85, r: 0.5 },
  ];
  for (const b of blobs) {
    const cx = b.fx * canvas.width;
    const cy = b.fy * canvas.height;
    const rad = b.r * Math.max(canvas.width, canvas.height);
    const g = ctx.createRadialGradient(cx, cy, 0, cx, cy, rad);
    g.addColorStop(0, rgbStr(systemColor, 0.11));
    g.addColorStop(1, rgbStr(systemColor, 0));
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, canvas.width, canvas.height);
  }
}

function render(now) {
  renderBackground();
  drawStars();
  drawGrid();
  drawWorldBounds();
  drawStar();
  drawBelts();
  for (const pl of state.world.planets) drawPlanet(pl);
  drawMoons();
  drawAsteroids();
  drawStations();
  drawGates();
  drawEnemies();
  drawDestination();
  drawBeam(now);
  drawMiningDrones(now);
  drawShip();
  drawCombatFx(now);
  drawWarpFlash(now);
}

// ---------- minimap ----------
function renderMinimap() {
  const w = minimap.width;
  const h = minimap.height;
  const sc = w / C.worldSize;
  mctx.clearRect(0, 0, w, h);
  mctx.fillStyle = rgbStr(mixRgb({ r: 6, g: 10, b: 20 }, systemColor, 0.2), 0.9);
  mctx.fillRect(0, 0, w, h);
  // star
  const star = state.world.star;
  mctx.fillStyle = '#ffd27a';
  mctx.beginPath();
  mctx.arc(star.x * sc, star.y * sc, 3, 0, Math.PI * 2);
  mctx.fill();
  // planets
  for (const pl of state.world.planets) {
    mctx.fillStyle = pl.color;
    mctx.beginPath();
    mctx.arc(pl.x * sc, pl.y * sc, 2.5, 0, Math.PI * 2);
    mctx.fill();
  }
  // moons
  mctx.fillStyle = '#b4bed2';
  for (const m of state.world.moons) mctx.fillRect(m.x * sc - 1, m.y * sc - 1, 2, 2);
  // asteroids
  for (const a of state.world.asteroids) {
    if (a.amount <= 0) continue;
    mctx.fillStyle = catalog.minerals[a.mineral].color;
    mctx.globalAlpha = 0.8;
    mctx.fillRect(a.x * sc - 1, a.y * sc - 1, 2, 2);
  }
  mctx.globalAlpha = 1;
  // stations
  mctx.fillStyle = '#78c8ff';
  for (const st of state.world.stations) mctx.fillRect(st.x * sc - 2, st.y * sc - 2, 4, 4);
  // gates
  mctx.fillStyle = '#7c5cff';
  for (const g of state.world.gates || []) {
    mctx.save();
    mctx.translate(g.x * sc, g.y * sc);
    mctx.rotate(Math.PI / 4);
    mctx.fillRect(-2.5, -2.5, 5, 5);
    mctx.restore();
  }
  // rats
  for (const e of state.world.enemies) {
    if (!e.alive) continue;
    mctx.fillStyle = '#ff5c7a';
    mctx.fillRect(e.x * sc - 1.5, e.y * sc - 1.5, 3, 3);
  }
  // ship
  mctx.fillStyle = '#4fd1ff';
  mctx.beginPath();
  mctx.arc(ship.x * sc, ship.y * sc, 3, 0, Math.PI * 2);
  mctx.fill();
}

// ---------- HUD ----------
function renderCargo() {
  const el = document.getElementById('cargo');
  el.innerHTML = '';
  for (const key of Object.keys(catalog.minerals)) {
    const def = catalog.minerals[key];
    const amt = state.minerals[key];
    if (amt < 0.5) continue;
    const chip = document.createElement('span');
    chip.className = 'chip';
    chip.innerHTML = `<span class="dot" style="background:${def.color}"></span>${def.name} <span class="amt">${fmt(amt)}</span>`;
    el.appendChild(chip);
  }
}

function renderPanels() {
  document.getElementById('isk').textContent = `${fmt(state.isk)} ISK`;
  const sysNameEl = document.getElementById('system-name');
  if (state.system) {
    sysNameEl.textContent = state.system.name;
    sysNameEl.style.color = state.system.color;
    sysNameEl.style.textShadow = `0 0 10px ${state.system.color}80`;
  } else {
    sysNameEl.textContent = '';
    sysNameEl.style.color = '';
    sysNameEl.style.textShadow = '';
  }
  // The faction that controls this system and your standing with it.
  const factionEl = document.getElementById('faction');
  if (state.activeFaction) {
    const st = state.activeFaction.standing;
    const sign = st > 0 ? '+' : '';
    factionEl.textContent = `${state.activeFaction.name} · ${sign}${st.toFixed(1)}`;
    factionEl.hidden = false;
  } else {
    factionEl.hidden = true;
  }
  renderCargo();

  const active = state.activeShip;
  const info = document.getElementById('ship-info');
  if (active) {
    const cargo = `Cargo ${fmt(state.cargoUsed)}/${fmt(state.cargoCapacity)}${state.cargoFull ? ' (FULL)' : ''}`;
    const drones = state.drones || { mining: [], combat: [] };
    const droneTxt = drones.mining.length + drones.combat.length
      ? ` · 🤖${drones.mining.length}⛏/${drones.combat.length}⚔`
      : '';
    info.innerHTML = `<span class="name">${active.name}</span> <span class="meta">Lv${active.level} · ⛏${active.mining.toFixed(0)}/s · ⚔${active.combat.toFixed(0)}${droneTxt} · ${cargo}</span>`;
  } else {
    info.innerHTML = `<span class="meta">No ship — open the Hangar to buy one</span>`;
  }
  updateLoadoutUI();

  renderHangar();
  renderCombatLog();
}

// Highlight the loadout button matching the active ship's current fit.
function updateLoadoutUI() {
  const current = state && state.activeShip ? state.activeShip.loadout : 'balanced';
  for (const btn of document.querySelectorAll('#loadout-panel .loadout-btn')) {
    btn.classList.toggle('active', btn.dataset.loadout === current);
  }
}

function updateHUDFast() {
  document.getElementById('isk').textContent = `${fmt(state.isk)} ISK`;
  document.getElementById('threat').textContent = `Threat ${state.threat || 0}`;
  document.getElementById('context').textContent = getContext();

  const ind = document.getElementById('mining-indicator');
  const a = nearestAsteroidLocal();
  const active = state.activeShip;
  if (state.combat) {
    ind.textContent = '⚔ In combat';
    ind.className = 'mining-indicator';
  } else if (a && active) {
    ind.textContent = `⛏ Mining ${catalog.minerals[a.mineral].name} +${active.mining.toFixed(1)}/s`;
    ind.className = 'mining-indicator';
  } else {
    ind.textContent = 'Idle — fly to an asteroid to mine';
    ind.className = 'mining-indicator idle';
  }

  // engage button
  const btn = document.getElementById('engage');
  const target = nearestEnemyInRange();
  if (target && !state.combat) {
    btn.disabled = false;
    btn.classList.add('engage-ready');
    btn.textContent = `Engage ${catalog.enemies[target.type].name}`;
  } else {
    btn.disabled = true;
    btn.classList.remove('engage-ready');
    btn.textContent = 'Engage';
  }

  // gate-jump button: visible only when the ship is at a gate
  const gateBtn = document.getElementById('gate-jump');
  const atGate = nearestGateInRange();
  if (atGate && !state.combat) {
    gateBtn.hidden = false;
    const targetName = (state.systemNames || []).find((s) => s.id === atGate.targetSystemId);
    const chance = state.ambush ? state.ambush[atGate.targetSystemId] : null;
    const risk = chance != null ? ` · ${Math.round(chance * 100)}%` : '';
    gateBtn.textContent = '⇄ ' + (targetName ? targetName.name : 'Jump') + risk;
  } else {
    gateBtn.hidden = true;
  }

  // combat banner + live shield/hull readout
  const banner = document.getElementById('combat-banner');
  const chud = document.getElementById('combat-hud');
  if (state.combat) {
    const c = state.combat;
    // The ship took a hit if its shield+hull pool dropped since the last frame.
    const pool = c.shipShield + c.shipHull;
    if (lastCombatPool !== null && pool < lastCombatPool - 0.5) addShake(0.3);
    lastCombatPool = pool;
    const e = state.world.enemies.find((x) => x.id === c.enemyId);
    const edef = e ? catalog.enemies[e.type] : null;
    const active = state.activeShip;
    const remain = Math.max(0, Math.ceil(c.remaining));
    banner.hidden = false;
    banner.textContent = `⚔ ${active ? active.name : 'Ship'} vs ${edef ? edef.name : 'target'} — ${remain}s`;
    chud.hidden = false;
    chud.innerHTML = `
      <div class="chud-row you">
        <span class="chud-name">${active ? active.name : 'Ship'}</span>
        <span class="chud-bars">
          <span class="chud-bar shield"><i style="width:${pct(c.shipShield, c.shipShieldMax)}"></i></span>
          <span class="chud-bar hull"><i style="width:${pct(c.shipHull, c.shipHullMax)}"></i></span>
        </span>
        <span class="chud-num">${Math.ceil(c.shipShield)}/${Math.ceil(c.shipHull)}</span>
      </div>
      <div class="chud-row foe">
        <span class="chud-name">${edef ? edef.name : 'Target'}</span>
        <span class="chud-bars">
          <span class="chud-bar shield"><i style="width:${pct(c.enemyShield, c.enemyShieldMax)}"></i></span>
          <span class="chud-bar hull"><i style="width:${pct(c.enemyHull, c.enemyHullMax)}"></i></span>
        </span>
        <span class="chud-num">${Math.ceil(c.enemyShield)}/${Math.ceil(c.enemyHull)}</span>
      </div>
      <div class="chud-actions">
        <button class="chud-btn" data-action="shieldBoost" data-testid="act-boost" ${c.boostReady ? '' : 'disabled'}>
          🛡 Boost${c.boostReady ? ` · ${c.boostCost}` : ` · ${Math.ceil(c.boostCooldown)}s`}
        </button>
        <button class="chud-btn" data-action="overload" data-testid="act-overload" ${c.overloadReady ? '' : 'disabled'}>
          ⚡ Overload${c.overloadReady ? ` · ${c.overloadCost}` : ` · ${Math.ceil(c.overloadCooldown)}s`}${c.overloaded ? ' ✦' : ''}
        </button>
        <button class="chud-btn disengage" data-action="disengage" data-testid="act-disengage">🏃 Disengage</button>
      </div>`;
  } else {
    banner.hidden = true;
    chud.hidden = true;
    lastCombatPool = null;
  }
}

function pct(v, max) {
  return max > 0 ? Math.max(0, Math.min(100, (v / max) * 100)) + '%' : '0%';
}

function nearestEnemyInRange() {
  let best = null;
  let bd = Infinity;
  for (const e of state.world.enemies) {
    if (!e.alive) continue;
    const d = dist(e.x, e.y, ship.x, ship.y);
    if (d <= C.engageRange && d < bd) {
      bd = d;
      best = e;
    }
  }
  return best;
}

// Name the POI nearest to a world point (used to label travel destinations).
function poiLabel(x, y) {
  const w = state.world;
  const cands = [{ x: w.star.x, y: w.star.y, name: w.star.name }];
  for (const pl of w.planets) cands.push({ x: pl.x, y: pl.y, name: pl.name });
  for (const m of w.moons) cands.push({ x: m.x, y: m.y, name: m.name });
  for (const st of w.stations) cands.push({ x: st.x, y: st.y, name: st.name });
  for (const b of w.belts) cands.push({ x: b.x, y: b.y, name: b.name });
  for (const a of w.asteroids) if (a.amount > 0) cands.push({ x: a.x, y: a.y, name: `${catalog.minerals[a.mineral].name} asteroid` });
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

function nearestStation() {
  let best = null;
  let bd = Infinity;
  for (const st of state.world.stations) {
    const d = dist(ship.x, ship.y, st.x, st.y);
    if (d < bd) {
      bd = d;
      best = st;
    }
  }
  return best ? { station: best, d: bd } : null;
}

// Idle convenience: when the cargo hold is full, automatically fly home to the
// nearest station to dump it. Skipped during combat and while already inbound.
function maybeAutoRecall() {
  if (state.combat) return;
  if (!state.cargoFull) return;
  const ns = nearestStation();
  if (!ns) return;
  if (ns.d < C.dockRange) return; // already at a station
  if (destination) {
    const inbound = state.world.stations.some((st) => dist(st.x, st.y, destination.x, destination.y) < 80);
    if (inbound) return;
  }
  destination = { x: ns.station.x, y: ns.station.y };
}

function toggleAutoPilot() {
  autoPilot = !autoPilot;
  const btn = document.getElementById('auto-pilot');
  btn.textContent = autoPilot ? '■ Stop' : '▶ Auto';
  btn.classList.toggle('on', autoPilot);
  toast(autoPilot ? 'Auto-pilot ON — belt → mine → sell → repeat' : 'Auto-pilot OFF');
  if (autoPilot) lastAutoTick = 0; // act on the very next frame
}

// The idle auto-loop: keep the ship mining the nearest belt, fly home to sell
// when the hold is full, then go back to a belt. It only sends the same intents
// a player would (warp / sell), so the server stays authoritative. Toggle with
// the ▶ Auto button; it never interferes with an active fight.
function updateAutoPilot(now) {
  if (!autoPilot || !state || !state.activeShip) return;
  if (now - lastAutoTick < 800) return;
  lastAutoTick = now;
  if (state.combat) return;
  if (state.docked) {
    if (state.cargoUsed > 0) {
      doAction('sell-all', {});
    } else {
      const belt = nearestPoiOf('belt');
      if (belt) doWarp(belt.id, { silent: true });
    }
    return;
  }
  if (state.cargoFull) {
    maybeAutoRecall();
    return;
  }
  if (!nearestAsteroidLocal()) {
    const belt = nearestPoiOf('belt');
    if (belt) doWarp(belt.id, { silent: true });
  }
}

// A one-line "where am I / what can I do" prompt for the idle player.
function getContext() {
  if (state.combat) return '⚔ In combat';
  const ns = nearestStation();
  if (state.docked) {
    if (state.cargoFull) return `Cargo full at ${state.dockedStation} — sell it (H)`;
    return `Docked at ${state.dockedStation} — press H to trade`;
  }
  if (destination) {
    const label = poiLabel(destination.x, destination.y);
    if (state.cargoFull) return `Cargo full — returning to ${label || 'station'}…`;
    return 'Traveling to ' + (label || 'your destination') + '…';
  }
  if (ns && ns.d < 240) return `Approaching ${ns.station.name}…`;
  const a = nearestAsteroidLocal();
  if (a) {
    const belt = state.world.belts.find((b) => b.id === a.beltId);
    return `Mining ${catalog.minerals[a.mineral].name}${belt ? ' · ' + belt.name : ''}`;
  }
  if (nearestEnemyInRange()) return 'Rat nearby — press E to engage';
  return 'Idle — click to warp, or use the ⚡ buttons';
}

// ---------- hangar ----------
function renderHangar() {
  const docked = !!state.docked;
  // cargo
  const cargo = document.getElementById('hangar-cargo');
  cargo.innerHTML = '';
  if (!docked) {
    const note = document.createElement('div');
    note.className = 'row';
    note.innerHTML = '<span class="sub">Dock at a station to trade.</span>';
    cargo.appendChild(note);
  } else {
    const dump = document.createElement('div');
    dump.className = 'row';
    dump.innerHTML = `
      <span class="label">Cargo hold <span class="sub">${fmt(state.cargoUsed)}/${fmt(state.cargoCapacity)}</span></span>
      <span class="actions"><button class="mini" data-action="sell-all" data-testid="sell-all" ${state.cargoUsed > 0 ? '' : 'disabled'}>Sell all</button></span>`;
    cargo.appendChild(dump);
  }
  for (const key of Object.keys(catalog.minerals)) {
    const def = catalog.minerals[key];
    const amt = state.minerals[key];
    const price = (state.world && state.world.prices && state.world.prices[key]) || def.price;
    const row = document.createElement('div');
    row.className = 'row';
    row.innerHTML = `
      <span class="label"><span class="dot" style="width:9px;height:9px;border-radius:50%;background:${def.color};display:inline-block"></span>${def.name} <span class="sub">${fmt(amt)} · ${price} ISK/u</span></span>
      <span class="actions">
        <button class="mini" data-action="sell-mineral" data-mineral="${key}" data-amount="100" data-testid="sell-${key}-100" ${docked ? '' : 'disabled'}>Sell 100</button>
        <button class="mini" data-action="sell-mineral" data-mineral="${key}" data-amount="all" data-testid="sell-${key}-all" ${docked ? '' : 'disabled'}>All</button>
      </span>`;
    cargo.appendChild(row);
  }

  // fleet
  const fleet = document.getElementById('hangar-fleet');
  fleet.innerHTML = '';
  if (!state.ships.length) {
    fleet.innerHTML = '<div class="row"><span class="sub">No ships in fleet.</span></div>';
  }
  for (const s of state.ships) {
    const isActive = state.activeShipId === s.id;
    const inCombat = state.combat && state.combat.shipId === s.id;
    const row = document.createElement('div');
    row.className = 'row' + (isActive ? ' active' : '');
    row.innerHTML = `
      <span class="label">${s.name} <span class="sub">Lv${s.level} · ⛏${s.mining.toFixed(0)}/s · ⚔${s.combat.toFixed(0)}${isActive ? ' · active' : ''}${inCombat ? ' · in combat' : ''}</span></span>
      <span class="actions">
        <button class="mini" data-action="set-active" data-id="${s.id}" data-testid="ship-${s.id}-active" ${isActive ? 'disabled' : ''}>Active</button>
        <button class="mini" data-action="upgrade" data-id="${s.id}" data-testid="ship-${s.id}-upgrade" ${inCombat ? 'disabled' : ''}>Up ${fmt(s.upgradeCost)}</button>
        <button class="mini danger" data-action="sell-ship" data-id="${s.id}" data-testid="ship-${s.id}-sell" ${inCombat ? 'disabled' : ''}>Sell ${fmt(s.sellValue)}</button>
      </span>`;
    fleet.appendChild(row);
  }

  // fitting (the active ship's slots)
  const fitting = document.getElementById('hangar-fitting');
  fitting.innerHTML = '';
  const activeShip = state.activeShip;
  if (!activeShip) {
    fitting.innerHTML = '<div class="row"><span class="sub">No active ship.</span></div>';
  } else {
    const ROMAN = ['—', 'I', 'II', 'III'];
    const stats = document.createElement('div');
    stats.className = 'row fitting-stats';
    stats.innerHTML = `<span class="label">${activeShip.name} <span class="sub">⚔${Math.round(activeShip.dps)} · 🛡${Math.round(activeShip.shield)} · 🧱${Math.round(activeShip.hull)} · ⛏${activeShip.mining.toFixed(1)}/s · 📦${Math.round(activeShip.cargo)}</span></span>`;
    fitting.appendChild(stats);
    for (const slotType of Object.keys(catalog.modules)) {
      const mod = catalog.modules[slotType];
      const slotCount = activeShip.slots[slotType] || 0;
      if (!slotCount) continue;
      const tiers = activeShip.fitting[slotType] || [];
      for (let i = 0; i < slotCount; i++) {
        const current = tiers[i] || 0;
        const btns = [0, 1, 2, 3].map((t) => {
          const active = current === t ? ' active' : '';
          return `<button class="mini fit-btn${active}" data-action="fit-module" data-ship="${activeShip.id}" data-slot="${slotType}" data-index="${i}" data-tier="${t}" data-testid="fit-${slotType}-${i}-t${t}">${ROMAN[t]}</button>`;
        }).join('');
        const row = document.createElement('div');
        row.className = 'row';
        row.innerHTML = `<span class="label">${mod.name} <span class="sub">slot ${i + 1}</span></span><span class="actions">${btns}</span>`;
        fitting.appendChild(row);
      }
    }
  }

  // skills
  const skills = document.getElementById('hangar-skills');
  const spLabel = document.getElementById('hangar-sp');
  skills.innerHTML = '';
  spLabel.textContent = `${Math.floor(state.skillPoints || 0)} SP`;
  const categories = {};
  for (const key of Object.keys(catalog.skills)) {
    const def = catalog.skills[key];
    (categories[def.category] = categories[def.category] || []).push(def);
  }
  for (const cat of Object.keys(categories)) {
    const head = document.createElement('div');
    head.className = 'skill-cat';
    head.textContent = cat;
    skills.appendChild(head);
    for (const def of categories[cat]) {
      const lvl = (state.skills && state.skills[def.key]) || 0;
      const maxed = lvl >= def.maxLevel;
      const cost = maxed ? 0 : Math.round(def.baseCost * Math.pow(def.costGrowth, lvl));
      const affordable = !maxed && (state.skillPoints || 0) >= cost;
      const row = document.createElement('div');
      row.className = 'row';
      row.innerHTML = `
        <span class="label">${def.name} <span class="sub">Lv${lvl}/${def.maxLevel} · +${Math.round(def.effect.pctPerLevel * 100)}% ${def.effect.stat}/lv</span></span>
        <span class="actions"><button class="mini" data-action="train-skill" data-skill="${def.key}" data-testid="skill-${def.key}" ${maxed || !affordable ? 'disabled' : ''}>${maxed ? 'Max' : `Train ${fmt(cost)} SP`}</button></span>`;
      skills.appendChild(row);
    }
  }

  // factions: standing with each faction and the gate-ambush risk in their system
  const factions = document.getElementById('hangar-factions');
  factions.innerHTML = '';
  for (const f of state.factions || []) {
    const st = f.standing;
    const sign = st > 0 ? '+' : '';
    const sysId = catalog.factions && catalog.factions[f.key] ? catalog.factions[f.key].systemId : null;
    const chance = sysId && state.ambush ? state.ambush[sysId] : null;
    const risk = chance != null ? ` · ${Math.round(chance * 100)}% ambush` : '';
    const row = document.createElement('div');
    row.className = 'row';
    row.innerHTML = `<span class="label">${f.name} <span class="sub">${sign}${st.toFixed(1)}${risk}</span></span>`;
    factions.appendChild(row);
  }

  // drone bay: buy combat/mining drones to boost the active ship (player-level)
  const droneBay = document.getElementById('hangar-drones');
  const droneCount = document.getElementById('drone-bay-count');
  droneBay.innerHTML = '';
  const ownedDrones = state.drones || { mining: [], combat: [] };
  const totalDrones = ownedDrones.mining.length + ownedDrones.combat.length;
  droneCount.textContent = totalDrones ? `${totalDrones} owned` : '';
  if (!docked) {
    const note = document.createElement('div');
    note.className = 'row';
    note.innerHTML = '<span class="sub">Dock at a station to buy drones.</span>';
    droneBay.appendChild(note);
  }
  const ROMAN = ['—', 'I', 'II', 'III'];
  for (const type of Object.keys(catalog.drones)) {
    const def = catalog.drones[type];
    const count = (ownedDrones[type] || []).length;
    const bonus = state.droneBonuses[def.stat] || 0;
    const head = document.createElement('div');
    head.className = 'skill-cat';
    head.textContent = `${def.name} — ${count}/${C.droneMaxPerType} · +${bonus} ${def.stat}`;
    droneBay.appendChild(head);
    for (const t of def.tiers) {
      const atCap = count >= C.droneMaxPerType;
      const row = document.createElement('div');
      row.className = 'row';
      row.innerHTML = `
        <span class="label">Tier ${ROMAN[t.tier]} <span class="sub">+${t.bonus} ${def.stat}</span></span>
        <span class="actions"><button class="mini" data-action="buy-drone" data-type="${type}" data-tier="${t.tier}" data-testid="buy-drone-${type}-t${t.tier}" ${docked && !atCap ? '' : 'disabled'}>${fmt(t.cost)} ISK</button></span>`;
      droneBay.appendChild(row);
    }
  }

  // loot: modules dropped by rats, equippable into empty ship slots
  const lootEl = document.getElementById('hangar-loot');
  lootEl.innerHTML = '';
  const loot = state.loot || [];
  if (!loot.length) {
    const note = document.createElement('div');
    note.className = 'row';
    note.innerHTML = '<span class="sub">Destroy rats to loot modules.</span>';
    lootEl.appendChild(note);
  }
  for (const l of loot) {
    const row = document.createElement('div');
    row.className = 'row';
    row.innerHTML = `
      <span class="label">${l.name} <span class="sub">Tier ${ROMAN[l.tier] || l.tier}</span></span>
      <span class="actions"><button class="mini" data-action="equip-loot" data-loot="${l.id}" data-testid="equip-loot-${l.id}">Equip</button></span>`;
    lootEl.appendChild(row);
  }

  // industry: craft module blueprints from ore in the active ship's cargo hold
  const industry = document.getElementById('hangar-industry');
  industry.innerHTML = '';
  const minerals = state.minerals || {};
  if (!docked) {
    const note = document.createElement('div');
    note.className = 'row';
    note.innerHTML = '<span class="sub">Dock at a station to craft.</span>';
    industry.appendChild(note);
  }
  for (const slotType of Object.keys(catalog.blueprints)) {
    for (const tier of Object.keys(catalog.blueprints[slotType])) {
      const bp = catalog.blueprints[slotType][tier];
      const recipe = Object.keys(bp.recipe)
        .filter((k) => bp.recipe[k] > 0)
        .map((k) => `${bp.recipe[k]} ${catalog.minerals[k].name}`)
        .join(' + ');
      const have = Object.keys(bp.recipe).every((k) => (minerals[k] || 0) >= bp.recipe[k]);
      const row = document.createElement('div');
      row.className = 'row';
      row.innerHTML = `
        <span class="label">${bp.name} <span class="sub">${recipe}</span></span>
        <span class="actions"><button class="mini" data-action="craft-module" data-slot="${bp.slotType}" data-tier="${bp.tier}" data-testid="craft-${slotType}-t${bp.tier}" ${docked && have ? '' : 'disabled'}>Craft</button></span>`;
      industry.appendChild(row);
    }
  }

  // shop
  const shop = document.getElementById('hangar-shop');
  shop.innerHTML = '';
  if (!docked) {
    const note = document.createElement('div');
    note.className = 'row';
    note.innerHTML = '<span class="sub">Dock at a station to buy ships.</span>';
    shop.appendChild(note);
  }
  for (const key of Object.keys(catalog.ships)) {
    const def = catalog.ships[key];
    const row = document.createElement('div');
    row.className = 'row';
    row.innerHTML = `
      <span class="label">${def.name} <span class="sub">⛏${def.mining}/s · ⚔${def.combat}</span></span>
      <span class="actions"><button class="mini" data-action="buy-ship" data-type="${key}" data-testid="buy-${key}" ${docked ? '' : 'disabled'}>${def.cost ? fmt(def.cost) + ' ISK' : 'Free'}</button></span>`;
    shop.appendChild(row);
  }
}

function renderCombatLog() {
  const log = document.getElementById('combat-log');
  log.innerHTML = '';
  if (!state.combatLog.length) {
    log.innerHTML = '<li class="empty">No battles yet.</li>';
    return;
  }
  for (const e of state.combatLog) {
    const li = document.createElement('li');
    li.className = e.won ? 'win' : 'lose';
    const tag = e.won ? '<span class="win-tag">VICTORY</span>' : '<span class="lose-tag">DEFEAT</span>';
    const sysName = e.system ? ` · ${e.system}` : '';
    let loot;
    if (e.won) {
      loot = `+${fmt(e.isk)} ISK`;
      if (e.loot && catalog.modules[e.loot.slotType]) {
        loot += ` · loot: ${catalog.modules[e.loot.slotType].name} ${['—', 'I', 'II', 'III'][e.loot.tier] || ''}`;
      }
    } else if (e.shipLost) {
      const parts = ['ship lost'];
      if (e.cargoLost > 0) parts.push(`${e.cargoLost} cargo`);
      if (e.insurance > 0) parts.push(`+${fmt(e.insurance)} insurance`);
      loot = parts.join(' · ');
    } else {
      loot = 'disengaged';
    }
    li.innerHTML = `${tag} ${e.ship} vs ${e.enemy}${sysName} — ${loot}`;
    log.appendChild(li);
  }
}

function toggleHangar(force) {
  hangarOpen = force !== undefined ? force : !hangarOpen;
  document.getElementById('hangar').hidden = !hangarOpen;
  if (hangarOpen) renderHangar();
}

// ---------- actions ----------
async function doAction(action, payload) {
  try {
    const data = await api(`/api/${action}`, payload);
    onServerState(data.state);
    return true;
  } catch (e) {
    toast(e.message, true);
    return false;
  }
}

function onServerState(newState) {
  const prevActive = state ? state.activeShipId : null;
  const prevShipPos = { x: ship.x, y: ship.y };
  const prevSystem = state ? state.system.id : null;
  state = newState;
  applySystemColor();
  const active = state.ships.find((s) => s.id === state.activeShipId);
  if (active) {
    // A warp or gate jump moves the ship a large distance (or changes system)
    // instantly on the server; snap the local ship and play the flash.
    const jumped =
      dist(active.x, active.y, prevShipPos.x, prevShipPos.y) > 1500 ||
      prevSystem !== state.system.id;
    if (prevActive !== state.activeShipId || jumped) {
      ship.x = active.x;
      ship.y = active.y;
      ship.vx = 0;
      ship.vy = 0;
      destination = null;
      if (jumped) {
        warpFx = performance.now();
        if (prevSystem !== state.system.id) genStars();
      }
    }
  }
  updateCombatFx(prevShipPos);
  renderPanels();
}

// Detect combat start/resolution so we can play the right explosion. The
// server is authoritative for the outcome (combatLog[0]); we just react to it.
function updateCombatFx(prevShipPos) {
  const c = state.combat;
  if (c) {
    if (combatFx.enemyId !== c.enemyId) {
      combatFx.enemyId = c.enemyId;
      combatFx.battleStartPerf = performance.now();
    }
    const e = state.world.enemies.find((x) => x.id === c.enemyId);
    if (e) {
      combatFx.enemyX = e.x;
      combatFx.enemyY = e.y;
    }
  } else if (combatFx.enemyId !== null) {
    const last = state.combatLog[0];
    if (last) {
      if (last.won) {
        combatFx.explosions.push({ x: combatFx.enemyX, y: combatFx.enemyY, at: performance.now(), kind: 'enemy' });
      } else if (last.shipLost) {
        combatFx.explosions.push({ x: prevShipPos.x, y: prevShipPos.y, at: performance.now(), kind: 'ship' });
        addShake(2); // a big shake when your ship is destroyed
        showDeathScreen(last);
      }
    }
    combatFx.enemyId = null;
    combatFx.battleStartPerf = 0;
  }
}

// Show the full-screen death screen with the killmail details, and let the
// player dismiss it (click, or it auto-clears after a few seconds).
let deathTimer = null;
function showDeathScreen(mail) {
  const el = document.getElementById('death-screen');
  const detail = document.getElementById('death-detail');
  const lines = [`${mail.ship} lost to ${mail.enemy}`];
  if (mail.system) lines.push(`in ${mail.system}`);
  if (mail.cargoLost > 0) lines.push(`${mail.cargoLost} units of cargo lost`);
  if (mail.insurance > 0) lines.push(`insurance paid ${fmt(mail.insurance)} ISK`);
  detail.innerHTML = lines.map((l) => `<div>${l}</div>`).join('');
  el.hidden = false;
  if (deathTimer) clearTimeout(deathTimer);
  deathTimer = setTimeout(() => { el.hidden = true; }, 6000);
}

// Warp the active ship to a POI (by id) or to raw coordinates. The server moves
// the ship instantly; onServerState detects the big position change and snaps +
// plays the flash. `silent` skips the toast (used for click-to-warp).
async function doWarp(targetId, opts) {
  opts = opts || {};
  if (state.combat) {
    if (!opts.silent) toast('Cannot warp while in combat', true);
    return false;
  }
  const payload = targetId ? { targetId } : { x: opts.x, y: opts.y };
  warpPending = true; // hold the position sync so a stale report can't undo the warp
  const ok = await doAction('warp', payload);
  warpPending = false;
  if (ok && !opts.silent) toast('Warping…');
  return ok;
}

function nearestPoiOf(kind) {
  const w = state.world;
  let list = [];
  if (kind === 'belt') list = w.belts;
  else if (kind === 'station') list = w.stations;
  else if (kind === 'rat') list = w.enemies.filter((e) => e.alive);
  let best = null;
  let bd = Infinity;
  for (const p of list) {
    const d = dist(p.x, p.y, ship.x, ship.y);
    if (d < bd) {
      bd = d;
      best = p;
    }
  }
  return best;
}

function warpToNearest(kind) {
  const poi = nearestPoiOf(kind);
  if (!poi) {
    toast(`No ${kind} in this system`, true);
    return;
  }
  doWarp(poi.id);
}

function nearestGateInRange() {
  const w = state.world;
  let best = null;
  let bd = Infinity;
  for (const g of w.gates || []) {
    const d = dist(g.x, g.y, ship.x, ship.y);
    if (d <= (C.gateRange || 320) && d < bd) {
      bd = d;
      best = g;
    }
  }
  return best;
}

async function doGateJump() {
  const g = nearestGateInRange();
  if (!g) {
    toast('Not at a gate', true);
    return;
  }
  const targetName = (state.systemNames || []).find((s) => s.id === g.targetSystemId);
  warpPending = true;
  const ok = await doAction('gate', { gateId: g.id });
  warpPending = false;
  if (ok) {
    if (state.combat) {
      // A predator dropped out of the gate the moment you arrived.
      toast('⚠ Ambushed at the gate!', true);
      addShake(1);
    } else {
      toast('Jumping to ' + (targetName ? targetName.name : 'system') + '…');
    }
  }
}

async function doEngage() {
  let target = null;
  if (targetEnemyId) {
    const e = state.world.enemies.find((x) => x.id === targetEnemyId && x.alive);
    if (e && dist(e.x, e.y, ship.x, ship.y) <= C.engageRange) target = e;
  }
  if (!target) target = nearestEnemyInRange();
  if (!target) {
    toast('No target in range', true);
    return;
  }
  const ok = await doAction('engage', { enemyId: target.id });
  if (ok) toast('Engaged!');
}

// Fire an in-fight action (shieldBoost / overload / disengage).
async function doCombatAction(action) {
  const ok = await doAction('combat-action', { action });
  if (ok) {
    if (action === 'disengage') toast('Disengaged — rat escaped');
    else if (action === 'shieldBoost') toast('Shield boosted');
    else if (action === 'overload') toast('Weapons overloaded');
  }
}

// Fit the active ship for a combat role (tank / balanced / dps).
async function doSetLoadout(loadout) {
  if (!state || !state.activeShipId) return;
  const ok = await doAction('set-loadout', { shipId: state.activeShipId, loadout });
  if (ok) toast('Loadout: ' + loadout);
}

// ---------- sync ----------
async function sync() {
  if (!state || !state.activeShip) return;
  try {
    const data = await api('/api/tick', { x: ship.x, y: ship.y });
    onServerState(data.state);
  } catch (e) {
    /* transient; keep going */
  }
}

// ---------- input ----------
function resize() {
  canvas.width = window.innerWidth;
  canvas.height = window.innerHeight;
}

function initInput() {
  window.addEventListener('keydown', (e) => {
    const k = e.key.toLowerCase();
    if (['arrowup', 'arrowdown', 'arrowleft', 'arrowright', ' '].includes(k)) e.preventDefault();
    keys[k] = true;
    if (k === 'e') doEngage();
    if (k === 'h') toggleHangar();
    if (k === 'escape') toggleHangar(false);
  });
  window.addEventListener('keyup', (e) => {
    keys[e.key.toLowerCase()] = false;
  });

  canvas.addEventListener('click', (ev) => {
    const rect = canvas.getBoundingClientRect();
    const sx = ev.clientX - rect.left;
    const sy = ev.clientY - rect.top;
    // 1) clicking a rat warps to it and marks it as the target
    let hit = null;
    let bd = 22;
    for (const e of state.world.enemies) {
      if (!e.alive) continue;
      const p = worldToScreen(e.x, e.y);
      const d = Math.hypot(p.x - sx, p.y - sy);
      if (d < bd) {
        bd = d;
        hit = e;
      }
    }
    if (hit) {
      targetEnemyId = hit.id;
      doWarp(hit.id, { silent: true });
      return;
    }
    // 2) clicking a POI (station/belt/planet/moon/gate/star) warps to it
    const w = state.world;
    const pois = [];
    for (const st of w.stations) pois.push({ id: st.id, x: st.x, y: st.y, r: 70 });
    for (const b of w.belts) pois.push({ id: b.id, x: b.x, y: b.y, r: 300 });
    for (const pl of w.planets) pois.push({ id: pl.id, x: pl.x, y: pl.y, r: pl.size + 50 });
    for (const m of w.moons) pois.push({ id: m.id, x: m.x, y: m.y, r: m.size + 30 });
    for (const g of w.gates || []) pois.push({ id: g.id, x: g.x, y: g.y, r: 90 });
    pois.push({ id: w.star.id, x: w.star.x, y: w.star.y, r: w.star.size + 50 });
    let best = null;
    let bestD = Infinity;
    for (const poi of pois) {
      const p = worldToScreen(poi.x, poi.y);
      const d = Math.hypot(p.x - sx, p.y - sy);
      if (d < poi.r * zoom + 16 && d < bestD) {
        bestD = d;
        best = poi;
      }
    }
    if (best) {
      doWarp(best.id, { silent: true });
      return;
    }
    // 3) otherwise warp to the clicked point
    const wpt = screenToWorld(sx, sy);
    if (wpt.x >= 0 && wpt.x <= C.worldSize && wpt.y >= 0 && wpt.y <= C.worldSize) {
      doWarp(null, { x: wpt.x, y: wpt.y, silent: true });
    }
  });

  canvas.addEventListener('wheel', (e) => {
    e.preventDefault();
    zoom = clamp(zoom * (e.deltaY < 0 ? 1.1 : 0.9), 0.4, 2.2);
  }, { passive: false });

  document.getElementById('engage').addEventListener('click', doEngage);
  document.getElementById('hangar-btn').addEventListener('click', () => toggleHangar());
  document.getElementById('hangar-close').addEventListener('click', () => toggleHangar(false));
  document.getElementById('death-dismiss').addEventListener('click', () => {
    document.getElementById('death-screen').hidden = true;
    if (deathTimer) clearTimeout(deathTimer);
  });
  document.getElementById('warp-belt').addEventListener('click', () => warpToNearest('belt'));
  document.getElementById('warp-station').addEventListener('click', () => warpToNearest('station'));
  document.getElementById('warp-rat').addEventListener('click', () => warpToNearest('rat'));
  document.getElementById('gate-jump').addEventListener('click', doGateJump);
  document.getElementById('auto-pilot').addEventListener('click', toggleAutoPilot);

  // in-fight actions (delegated — the combat HUD is re-rendered every frame)
  document.getElementById('combat-hud').addEventListener('click', (ev) => {
    const btn = ev.target.closest('button[data-action]');
    if (!btn || btn.disabled) return;
    doCombatAction(btn.dataset.action);
  });

  // loadout selector (static buttons, delegated)
  document.getElementById('loadout-panel').addEventListener('click', (ev) => {
    const btn = ev.target.closest('button[data-loadout]');
    if (!btn) return;
    doSetLoadout(btn.dataset.loadout);
  });

  // event delegation for all hangar buttons
  document.getElementById('hangar').addEventListener('click', (ev) => {
    const el = ev.target.closest('[data-action]');
    if (!el) return;
    const a = el.dataset.action;
    if (a === 'sell-mineral') doAction('sell-minerals', { mineral: el.dataset.mineral, amount: el.dataset.amount });
    else if (a === 'sell-all') doAction('sell-all', {});
    else if (a === 'buy-ship') doAction('buy-ship', { type: el.dataset.type });
    else if (a === 'set-active') doAction('set-active', { shipId: el.dataset.id });
    else if (a === 'upgrade') doAction('upgrade-ship', { shipId: el.dataset.id });
    else if (a === 'sell-ship') doAction('sell-ship', { shipId: el.dataset.id });
    else if (a === 'fit-module') doAction('fit-module', { shipId: el.dataset.ship, slotType: el.dataset.slot, slotIndex: Number(el.dataset.index), tier: Number(el.dataset.tier) });
    else if (a === 'train-skill') doAction('train-skill', { skill: el.dataset.skill });
    else if (a === 'buy-drone') doAction('buy-drone', { type: el.dataset.type, tier: Number(el.dataset.tier) });
    else if (a === 'equip-loot') doAction('equip-loot', { lootId: el.dataset.loot });
    else if (a === 'craft-module') doAction('craft-module', { slotType: el.dataset.slot, tier: Number(el.dataset.tier) });
  });

  window.addEventListener('resize', resize);
}

// ---------- boot ----------
async function boot() {
  resize();
  genStars();
  try {
    const [cat, st] = await Promise.all([api('/api/catalog'), api('/api/state')]);
    catalog = cat;
    C = cat.constants;
    state = st.state;
    applySystemColor();
    const active = state.ships.find((s) => s.id === state.activeShipId);
    if (active) {
      ship.x = active.x;
      ship.y = active.y;
    }
    initInput();
    renderPanels();
    lastFrame = performance.now();
    requestAnimationFrame(frame);
  } catch (e) {
    toast('Failed to load: ' + e.message, true);
  }
}

// Decay the screen shake and compute this frame's jitter offset.
function updateShake(dt) {
  if (shake > 0) {
    shake = Math.max(0, shake - dt * 3);
    const a = shake * 10;
    shakeX = (Math.random() * 2 - 1) * a;
    shakeY = (Math.random() * 2 - 1) * a;
  } else {
    shakeX = 0;
    shakeY = 0;
  }
}
function addShake(amount) {
  shake = Math.min(2, shake + amount);
}

function frame(now) {
  const dt = Math.min(0.05, (now - lastFrame) / 1000);
  lastFrame = now;
  updateShake(dt);
  if (state) {
    maybeAutoRecall();
    updateShip(dt);
    render(now);
    renderMinimap();
    updateHUDFast();
    updateAutoPilot(now);
    if (now - lastSync > SYNC_MS && !warpPending) {
      lastSync = now;
      sync();
    }
  }
  requestAnimationFrame(frame);
}

// Test hook used by the E2E suite to navigate without pixel-perfect clicking.
window.__eve = {
  setDestination: (x, y) => {
    destination = { x, y };
  },
  warp: (targetId) => doWarp(targetId, { silent: true }),
  combatAction: (action) => doCombatAction(action),
  setLoadout: (loadout) => doSetLoadout(loadout),
  setAutoPilot: (on) => {
    if (autoPilot !== !!on) toggleAutoPilot();
  },
  getShip: () => ({ x: ship.x, y: ship.y }),
  get state() {
    return state;
  },
};

boot();
