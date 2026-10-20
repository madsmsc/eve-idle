'use strict';

const { test, expect } = require('@playwright/test');
const cfg = require('../server/config');

// Browser end-to-end tests for the rendered world. These drive the real
// frontend against the real server, covering the full loop: input -> local
// physics -> position sync -> server validation -> persisted state -> re-render.
//
// Assert on rendered canvas pixels, the HUD, and server state (via /api/state).
// A small test hook (window.__eve) lets us set a flight destination without
// pixel-perfect clicks.

function dist(a, b) {
  return Math.hypot(a.x - b.x, a.y - b.y);
}

async function getState(page) {
  return (await (await page.request.get('/api/state')).json()).state;
}

// The ship spawns docked at the home station; warp off the pad so combat and
// other space-only actions are possible.
async function undock(page) {
  await page.evaluate(() => window.__eve.warp(null, { x: 200, y: 200 }));
  await page.waitForFunction(() => window.__eve.state && window.__eve.state.docked === false);
}

// Nearest living object of the given world list to the ship.
function nearest(list, ship) {
  return list.slice().sort((a, b) => dist(a, ship) - dist(b, ship))[0];
}

// Warp to the first living enemy with the given missionTag, engage it, and wait
// for the fight to resolve as a win. With `expectFreeFire` it also asserts the
// combat banner advertises the opening-volley window.
async function killMissionEnemy(page, tag, expectFreeFire = false) {
  const st = await getState(page);
  const e = st.world.enemies.find((x) => x.missionTag === tag && x.alive);
  expect(e).toBeTruthy();
  await page.evaluate((id) => window.__eve.warp(id), e.id);
  await expect(async () => {
    const s = await getState(page);
    expect(dist(s.activeShip, e)).toBeLessThan(200);
  }).toPass({ timeout: 30000 });
  await page.getByTestId('engage-btn').click();
  await expect(page.getByTestId('combat-banner')).toBeVisible({ timeout: 5000 });
  if (expectFreeFire) {
    await expect(page.getByTestId('combat-banner')).toContainText('free fire');
  }
  await expect(async () => {
    const s = await getState(page);
    expect(s.combat).toBeFalsy();
    expect(s.world.enemies.find((x) => x.id === e.id).alive).toBe(false);
  }).toPass({ timeout: 45000 });
}

test.beforeEach(async ({ page }) => {
  // Clean slate for every test (regenerates a fresh world), then load the app.
  await page.request.post('/api/reset');
  await page.goto('/');
  // The mode menu shows on every load; the suite runs in DEMO mode.
  await page.getByTestId('mode-demo').click();
  // ship-info only shows the active ship name once the app has booted.
  await expect(page.getByTestId('ship-info')).toContainText('Rifter', { timeout: 15000 });
});

test('demo quick-start hint appears once and remembers dismissal', async ({ page }) => {
  const hint = page.getByTestId('tutorial-hint');
  await expect(hint).toBeVisible();
  await page.getByTestId('tutorial-dismiss').click();
  await expect(hint).toBeHidden();
  await page.reload();
  await page.getByTestId('mode-demo').click();
  await expect(page.getByTestId('ship-info')).toContainText('Rifter', { timeout: 15000 });
  await expect(hint).toBeHidden();
});

test('renders the world, minimap and HUD', async ({ page }) => {
  const st = await getState(page);
  const world = page.locator('#world');
  await expect(world).toBeVisible();
  const box = await world.boundingBox();
  expect(box.width).toBeGreaterThan(0);
  expect(box.height).toBeGreaterThan(0);
  await expect.poll(() => world.evaluate((canvas) => {
    const pixels = canvas.getContext('2d').getImageData(0, 0, canvas.width, canvas.height).data;
    const colors = new Set();
    for (let i = 0; i < pixels.length; i += 64) {
      colors.add(`${pixels[i]},${pixels[i + 1]},${pixels[i + 2]}`);
    }
    return colors.size;
  })).toBeGreaterThan(1);

  await expect(page.getByTestId('isk')).toContainText('10.0K');
  await expect(page.getByTestId('ship-info')).toContainText('Rifter');
  const minimap = page.locator('#minimap');
  await expect(minimap).toBeVisible();
  await expect.poll(() => minimap.evaluate((canvas) => {
    const pixels = canvas.getContext('2d').getImageData(0, 0, canvas.width, canvas.height).data;
    const colors = new Set();
    for (let i = 0; i < pixels.length; i += 16) {
      colors.add(`${pixels[i]},${pixels[i + 1]},${pixels[i + 2]}`);
    }
    return colors.size;
  })).toBeGreaterThan(1);
  // The ship starts at the station, far from any asteroid, so it is idle.
  await expect(page.getByTestId('mining-indicator')).toContainText('Idle');
  expect(st.world.star).toBeTruthy();
  expect(st.world.planets.length).toBeGreaterThanOrEqual(1);
  expect(st.world.stations.length).toBeGreaterThanOrEqual(2);
  expect(st.world.belts.length).toBeGreaterThan(0);
  expect(st.world.asteroids.length).toBeGreaterThan(0);
  // The ship spawns at the home station.
  const home = st.world.stations[0];
  expect(Math.hypot(st.activeShip.x - home.x, st.activeShip.y - home.y)).toBeLessThan(1);
});

test('space status bars persist, docked status is hidden, and shortcuts are labeled', async ({ page }) => {
  await expect(page.getByTestId('ship-status')).toBeHidden();
  await expect(page.locator('#controls-hint')).toHaveCount(0);
  await expect(page.getByTestId('auto-pilot')).toHaveAttribute('data-shortcut', 'A');
  await expect(page.getByTestId('navigate-belt')).toHaveAttribute('data-shortcut', 'B');
  await expect(page.getByTestId('navigate-station')).toHaveAttribute('data-shortcut', 'S');
  await expect(page.getByTestId('navigate-rat')).toHaveAttribute('data-shortcut', 'R');
  await expect(page.getByTestId('engage-btn')).toHaveAttribute('data-shortcut', 'E');
  await expect(page.getByTestId('character-btn')).toHaveAttribute('data-shortcut', 'C');
  await expect(page.getByTestId('inventory-btn')).toHaveAttribute('data-shortcut', 'I');

  await undock(page);
  await expect(page.getByTestId('ship-status')).toBeVisible();
  await expect(page.getByTestId('status-shield-value')).toContainText('/');
  await expect(page.getByTestId('status-hull-value')).toContainText('/');
  await expect(page.getByTestId('status-speed-value')).toContainText('m/s');

  const state = await getState(page);
  const destinationX = state.activeShip.x < 7000
    ? state.activeShip.x + 500
    : state.activeShip.x - 500;
  await page.evaluate((x) => window.__eve.setDestination(x, window.__eve.state.activeShip.y), destinationX);
  await expect.poll(async () => {
    const speed = await page.getByTestId('status-speed-value').textContent();
    return Number.parseInt(speed, 10);
  }).toBeGreaterThan(0);

  await page.keyboard.press('r');
  await expect.poll(() => page.evaluate(() => window.__eve.getDestination())).not.toBeNull();
  await page.keyboard.press('a');
  await expect(page.getByTestId('auto-pilot')).toHaveClass(/on/);
  await page.keyboard.press('a');
  await expect(page.getByTestId('auto-pilot')).not.toHaveClass(/on/);
});

test('the hangar shows the active system market price', async ({ page }) => {
  const st = await getState(page);
  // The active system exposes a price for every mineral.
  expect(st.world.prices).toBeTruthy();
  expect(st.world.prices.iron).toBeGreaterThanOrEqual(1);
  expect(st.world.prices.bauxite).toBeGreaterThanOrEqual(1);
  // Station services list the active system's price, not a fixed base price.
  const localPrice = st.world.prices.iron;
  await expect(page.getByTestId('hangar-cargo')).toContainText(`${localPrice} ISK/u`);
});

test('manual keys no longer pilot the ship', async ({ page }) => {
  const before = await page.evaluate(() => window.__eve.getShip());
  await page.keyboard.down('w');
  await page.keyboard.down('d');
  await page.waitForTimeout(1500);
  await page.keyboard.up('w');
  await page.keyboard.up('d');
  const after = await page.evaluate(() => window.__eve.getShip());
  // With no destination set, the ship stays put (no manual piloting).
  expect(Math.abs(after.x - before.x)).toBeLessThan(1);
  expect(Math.abs(after.y - before.y)).toBeLessThan(1);
});

test('clicking a belt sets a flight path instead of teleporting', async ({ page }) => {
  await undock(page);
  const st = await getState(page);
  const box = await page.locator('#world').boundingBox();
  const ship = st.activeShip;
  // Pick the nearest belt that is on-screen at zoom 1, then click its centre.
  const onScreen = st.world.belts
    .map((b) => ({ b, sx: (b.x - ship.x) + box.width / 2, sy: (b.y - ship.y) + box.height / 2 }))
    .filter((o) => o.sx > 40 && o.sx < box.width - 40 && o.sy > 40 && o.sy < box.height - 40)
    .sort((a, b) => dist(a.b, ship) - dist(b.b, ship));
  if (!onScreen.length) return; // no belt on screen; nothing to assert
  const { b, sx, sy } = onScreen[0];
  await page.mouse.click(box.x + sx, box.y + sy);
  await expect.poll(() => page.evaluate(() => window.__eve.getDestination())).toMatchObject({ x: b.x, y: b.y });
  const start = await page.evaluate(() => window.__eve.getShip());
  await page.waitForTimeout(700);
  const moving = await page.evaluate(() => window.__eve.getShip());
  expect(dist(moving, start)).toBeGreaterThan(10);
  expect(dist(moving, b)).toBeLessThan(dist(start, b));
});

test('overview map sets a flight path and empty world clicks leave it unchanged', async ({ page }) => {
  await undock(page);
  const before = await getState(page);
  const map = page.getByTestId('minimap');
  const mapBox = await map.boundingBox();
  const x = mapBox.x + mapBox.width * 0.72;
  const y = mapBox.y + mapBox.height * 0.28;
  await page.mouse.click(x, y);
  const target = { x: 0.72 * cfg.WORLD_SIZE, y: 0.28 * cfg.WORLD_SIZE };
  await expect.poll(async () => {
    const destination = await page.evaluate(() => window.__eve.getDestination());
    return Math.hypot(destination.x - target.x, destination.y - target.y);
  }).toBeLessThan(50);
  const destinationBeforeEmptyClick = await page.evaluate(() => window.__eve.getDestination());
  await page.waitForTimeout(700);
  const moving = await page.evaluate(() => window.__eve.getShip());
  expect(dist(moving, before.activeShip)).toBeGreaterThan(10);
  expect(dist(moving, target)).toBeGreaterThan(10);

  const traveling = await getState(page);
  const worldBox = await page.locator('#world').boundingBox();
  const world = traveling.world;
  const hitTargets = [
    ...world.enemies.filter((enemy) => enemy.alive).map((enemy) => ({ ...enemy, radius: 22 })),
    ...world.stations.map((station) => ({ ...station, radius: 86 })),
    ...world.belts.map((belt) => ({ ...belt, radius: 316 })),
    ...world.planets.map((planet) => ({ ...planet, radius: planet.size + 66 })),
    ...world.moons.map((moon) => ({ ...moon, radius: moon.size + 46 })),
    ...world.gates.map((gate) => ({ ...gate, radius: 106 })),
    { ...world.star, radius: world.star.size + 66 },
  ].map((target) => ({
    x: target.x - traveling.activeShip.x + worldBox.width / 2,
    y: target.y - traveling.activeShip.y + worldBox.height / 2,
    radius: target.radius,
  }));
  let emptyPoint = null;
  for (let x = 12; x < worldBox.width - 12 && !emptyPoint; x += 12) {
    for (let y = 12; y < worldBox.height - 12; y += 12) {
      if (hitTargets.every((target) => Math.hypot(target.x - x, target.y - y) > target.radius + 8)) {
        emptyPoint = { x, y };
        break;
      }
    }
  }
  expect(emptyPoint).toBeTruthy();
  await page.mouse.click(worldBox.x + emptyPoint.x, worldBox.y + emptyPoint.y);
  expect(await page.evaluate(() => window.__eve.getDestination())).toEqual(destinationBeforeEmptyClick);
  expect(await map.getAttribute('aria-label')).toContain('overview map');
});

test('system HUD shows the system name and color', async ({ page }) => {
  const st = await getState(page);
  expect(st.world.color).toMatch(/^#[0-9a-f]{6}$/i);
  const nameEl = page.getByTestId('system-name');
  await expect(nameEl).toContainText(st.system.name);
  // The client applies the system's hue as an inline color on the HUD label.
  await expect(async () => {
    const color = await nameEl.evaluate((el) => el.style.color);
    expect(color).toBeTruthy();
  }).toPass({ timeout: 5000 });
});

test('navigation buttons route the ship to belts, hostiles, and stations', async ({ page }) => {
  await undock(page);
  let state = await getState(page);
  const start = await page.evaluate(() => window.__eve.getShip());
  const belt = nearest(state.world.belts, start);
  await page.getByTestId('navigate-belt').click();
  await expect.poll(() => page.evaluate(() => window.__eve.getDestination())).toMatchObject({ x: belt.x, y: belt.y });
  await page.waitForTimeout(700);
  let moving = await page.evaluate(() => window.__eve.getShip());
  expect(dist(moving, start)).toBeGreaterThan(10);
  expect(dist(moving, belt)).toBeLessThan(dist(start, belt));

  state = await getState(page);
  const rat = nearest(state.world.enemies.filter((enemy) => enemy.alive), moving);
  await page.getByTestId('navigate-rat').click();
  await expect.poll(() => page.evaluate(() => window.__eve.getDestination())).toMatchObject({ x: rat.x, y: rat.y });
  const ratRouteStart = await page.evaluate(() => window.__eve.getShip());
  await page.waitForTimeout(700);
  moving = await page.evaluate(() => window.__eve.getShip());
  expect(dist(moving, ratRouteStart)).toBeGreaterThan(10);

  state = await getState(page);
  const station = nearest(state.world.stations, moving);
  await page.getByTestId('navigate-station').click();
  await expect.poll(() => page.evaluate(() => window.__eve.getDestination())).toMatchObject({ x: station.x, y: station.y });
  await expect.poll(() => page.evaluate(() => window.__eve.state.docked), { timeout: 30000 }).toBe(true);
});

test('gate jump moves the ship to the connected system', async ({ page }) => {
  const st = await getState(page);
  const gate = st.system.gates[0];
  // Warp to the gate first so the jump button appears.
  await page.evaluate((id) => window.__eve.warp(id), gate.id);
  await expect(async () => {
    const s = await getState(page);
    expect(dist(s.activeShip, gate)).toBeLessThan(5);
  }).toPass({ timeout: 5000 });
  await expect(page.getByTestId('gate-jump')).toContainText('%');
  await page.getByTestId('gate-jump').click();
  await expect(async () => {
    const s = await getState(page);
    expect(s.system.id).toBe(gate.targetSystemId);
  }).toPass({ timeout: 5000 });
});

test('HUD shows the controlling faction and standing', async ({ page }) => {
  const st = await getState(page);
  expect(st.activeFaction && st.activeFaction.name).toBeTruthy();
  await expect(page.getByTestId('faction')).toContainText(st.activeFaction.name);
});

test('the hangar lists every faction with standing and ambush risk', async ({ page }) => {
  const st = await getState(page);
  const factions = page.getByTestId('hangar-factions');
  for (const f of st.factions) {
    await expect(factions).toContainText(f.name);
  }
});

test('mining: fly to an asteroid and cargo grows', async ({ page }) => {
  const st = await getState(page);
  const ast = nearest(st.world.asteroids.filter((a) => a.amount > 0), st.activeShip);
  await page.evaluate(({ x, y }) => window.__eve.setDestination(x, y), ast);

  // The HUD flips to "Mining" once the ship is within range of the asteroid.
  await expect(page.getByTestId('mining-indicator')).toContainText('Mining', { timeout: 30000 });

  // And the server actually credits cargo.
  await expect(async () => {
    const s = await getState(page);
    const total = Object.values(s.minerals).reduce((a, b) => a + b, 0);
    expect(total).toBeGreaterThan(0);
  }).toPass({ timeout: 30000 });
});

test('belt mining grows cargo and auto-recalls on a full hold @slow', async ({ page }) => {
  const st = await getState(page);
  const belt = st.world.belts[0];
  await page.evaluate(({ x, y }) => window.__eve.setDestination(x, y), belt);
  await expect(page.getByTestId('context')).toContainText('Mining', { timeout: 30000 });
  await expect(page.getByTestId('mining-indicator')).toContainText('Mining', { timeout: 5000 });
  await expect(async () => {
    const s = await getState(page);
    expect(Object.values(s.minerals).reduce((total, amount) => total + amount, 0)).toBeGreaterThan(0);
  }).toPass({ timeout: 10000 });

  // The rifter's small hold fills in ~10s; once full the ship turns for home.
  await expect(page.getByTestId('context')).toContainText(/Cargo full/i, { timeout: 45000 });
});

test('combat engages and resolves as a win or loss @slow', async ({ page }) => {
  await undock(page);
  const st = await getState(page);
  const enemy = nearest(st.world.enemies.filter((e) => e.alive), st.activeShip);
  await page.evaluate(({ x, y }) => window.__eve.setDestination(x, y), enemy);
  await expect(async () => {
    const s = await getState(page);
    expect(dist(s.activeShip, enemy)).toBeLessThan(200);
  }).toPass({ timeout: 30000 });

  await expect(page.getByTestId('engage-btn')).toHaveText('Engage');
  await page.getByTestId('engage-btn').click();
  await expect(page.getByTestId('combat-banner')).toBeVisible({ timeout: 5000 });
  await expect(page.locator('#combat-hud .chud-row')).toHaveCount(0);
  await expect(page.getByTestId('act-boost')).toBeVisible();

  // Wait for the server to resolve the fight (up to ~20s for a dreadnought).
  await expect(async () => {
    const s = await getState(page);
    expect(s.combat).toBeNull();
    expect(s.combatLog.length).toBeGreaterThan(0);
  }).toPass({ timeout: 40000 });

  const s = await getState(page);
  const log = s.combatLog[0];
  if (log.won) {
    expect(s.world.enemies.find((e) => e.id === enemy.id).alive).toBe(false);
  } else if (log.shipLost) {
    expect(s.ships.some((sh) => sh.id === st.activeShipId)).toBe(false);
  } else {
    throw new Error('unexpected combat outcome');
  }
});

test('death screen shows the killmail when a ship is destroyed @slow', async ({ page }) => {
  await undock(page);
  const st = await getState(page);
  // Engage the strongest rat. The stock rifter can't beat a faction/dread, so
  // the ship is destroyed and the death screen appears.
  const strength = { pirate: 1, gang: 2, faction: 3, dread: 4 };
  const enemy = st.world.enemies
    .filter((e) => e.alive)
    .sort((a, b) => strength[b.type] - strength[a.type])[0];
  await page.evaluate(({ x, y }) => window.__eve.setDestination(x, y), enemy);
  await expect(async () => {
    const s = await getState(page);
    expect(dist(s.activeShip, enemy)).toBeLessThan(200);
  }).toPass({ timeout: 30000 });

  await page.getByTestId('engage-btn').click();
  await expect(page.getByTestId('death-screen')).toBeVisible({ timeout: 40000 });
  await expect(page.getByTestId('death-detail')).toContainText(/lost to/i);

  // Dismiss it.
  await page.getByTestId('death-dismiss').click();
  await expect(page.getByTestId('death-screen')).toBeHidden();
});

test('in-fight actions: boost costs ISK, disengage bails out and keeps the ship', async ({ page }) => {
  await undock(page);
  const st = await getState(page);
  // Prefer a pirate (a long fight for the starting rifter) so we have time to act.
  const pirates = st.world.enemies.filter((e) => e.alive && e.type === 'pirate');
  const pool = pirates.length ? pirates : st.world.enemies.filter((e) => e.alive);
  const enemy = nearest(pool, st.activeShip);
  await page.evaluate(({ x, y }) => window.__eve.setDestination(x, y), enemy);
  await expect(async () => {
    const s = await getState(page);
    expect(dist(s.activeShip, enemy)).toBeLessThan(200);
  }).toPass({ timeout: 30000 });

  await page.getByTestId('engage-btn').click();
  await expect(page.getByTestId('combat-banner')).toBeVisible({ timeout: 5000 });

  // The in-fight action buttons appear in the combat HUD.
  await expect(page.getByTestId('act-boost')).toBeVisible();
  await expect(page.getByTestId('act-overload')).toBeVisible();
  await expect(page.getByTestId('act-disengage')).toBeVisible();

  // Boosting the shield costs ISK. (The HUD re-renders every frame, so click
  // via evaluate to avoid Playwright's element-stability wait.)
  const iskBefore = (await getState(page)).isk;
  await page.evaluate(() => document.querySelector('[data-testid="act-boost"]').click());
  await expect(async () => {
    const s = await getState(page);
    expect(s.isk).toBeLessThan(iskBefore);
  }).toPass({ timeout: 5000 });

  // Disengaging ends the fight immediately and keeps the ship.
  const shipsBefore = (await getState(page)).ships.length;
  await page.evaluate(() => document.querySelector('[data-testid="act-disengage"]').click());
  await expect(async () => {
    const s = await getState(page);
    expect(s.combat).toBeNull();
  }).toPass({ timeout: 5000 });
  const s = await getState(page);
  expect(s.ships.length).toBe(shipsBefore);
  expect(s.combatLog[0].disengaged).toBe(true);
});

test('fitting: fitting a module updates the active ship and spends ISK', async ({ page }) => {
  await expect(page.getByTestId('hangar-fitting')).toBeVisible();
  // The stock rifter has one weapon slot, empty (tier 0) by default.
  await expect(page.getByTestId('fit-weapon-0-t0')).toHaveClass(/active/);

  const iskBefore = (await getState(page)).isk;
  // The hangar re-renders on every sync, so click via evaluate to avoid
  // Playwright's element-stability wait.
  await page.evaluate(() => document.querySelector('[data-testid="fit-weapon-0-t1"]').click());
  await expect(async () => {
    const s = await getState(page);
    expect(s.activeShip.fitting.weapon[0]).toBe(1);
    expect(s.isk).toBeLessThan(iskBefore);
  }).toPass({ timeout: 5000 });
  await expect(page.getByTestId('fit-weapon-0-t1')).toHaveClass(/active/);
  await expect(page.getByTestId('fit-weapon-0-t0')).not.toHaveClass(/active/);
});

test('skills: the hangar shows the skill tree and SP', async ({ page }) => {
  await expect(page.getByTestId('hangar-skills')).toBeVisible();
  // A fresh account has no skill points, so training is unavailable.
  await expect(page.getByTestId('hangar-sp')).toContainText('0 SP');
  await expect(page.getByTestId('skill-gunnery')).toBeDisabled();
});

test('hangar: open it and buy a ship', async ({ page }) => {
  await expect(page.getByTestId('hangar')).toBeVisible();

  // The hangar re-renders on every sync, so click via evaluate to avoid
  // Playwright's element-stability wait on the (now lower) buy button.
  await page.evaluate(() => document.querySelector('[data-testid="buy-falcon"]').click());
  await expect(async () => {
    const s = await getState(page);
    expect(s.ships.length).toBe(2);
    expect(s.isk).toBe(5000);
  }).toPass({ timeout: 5000 });
});

test('rejects an unaffordable purchase with a toast', async ({ page }) => {
  await page.evaluate(() => document.querySelector('[data-testid="buy-brutix"]').click()); // 250000 ISK, we have 10000
  await expect(page.getByTestId('toast')).toContainText(/Not enough ISK/i);
  const s = await getState(page);
  expect(s.ships.length).toBe(1);
});

test('station services replace the world and launching leaves a full ship in space', async ({ page }) => {
  // Docking replaces the flight HUD with full-screen station services.
  await expect(page.getByTestId('station-view')).toBeVisible();
  await expect(page.getByTestId('station-view-name')).toContainText('Station A');
  await expect(page.getByTestId('hangar')).toBeVisible();
  const stationWidth = await page.getByTestId('hangar').evaluate((el) => el.getBoundingClientRect().width);
  const viewportWidth = await page.evaluate(() => window.innerWidth);
  expect(stationWidth).toBe(viewportWidth);

  const initial = await getState(page);
  const station = initial.world.stations[0];
  const asteroid = initial.world.asteroids[0];
  await page.evaluate(({ x, y }) => window.__eve.warp(null, { x, y }), asteroid);
  await expect.poll(async () => (await getState(page)).cargoFull, { timeout: 20000 }).toBe(true);
  await page.evaluate((id) => window.__eve.warp(id), station.id);
  await expect.poll(async () => (await getState(page)).docked, { timeout: 5000 }).toBe(true);

  await page.getByTestId('station-launch').click();
  await expect(async () => {
    const s = await getState(page);
    expect(s.docked).toBe(false);
    expect(s.activeShip.x).toBeGreaterThan(station.x + 300);
  }).toPass({ timeout: 5000 });
  await expect(page.getByTestId('station-view')).toBeHidden();
  const launched = await getState(page);
  await page.waitForTimeout(1200);
  const afterLaunch = await getState(page);
  expect(dist(launched.activeShip, afterLaunch.activeShip)).toBeLessThan(5);
});

test('the hangar is only available while docked', async ({ page }) => {
  // Station services are available immediately while docked.
  await expect(page.getByTestId('sell-iron-100')).toBeEnabled();

  // Fly to open space (far from every station); the hangar closes and can't reopen.
  await page.evaluate(() => window.__eve.setDestination(600, 600));
  await page.waitForFunction(() => window.__eve.state && window.__eve.state.docked === false);
  await expect(page.getByTestId('hangar')).toBeHidden();
  await page.keyboard.press('h');
  await expect(page.getByTestId('hangar')).toBeHidden();
  await expect(page.getByTestId('toast')).toContainText(/Dock at a station/i);
});

test('character sheet shows standings for every faction, in space and docked', async ({ page }) => {
  // In space: open via the keyboard shortcut.
  await undock(page);
  await page.keyboard.press('c');
  await expect(page.getByTestId('character-sheet')).toBeVisible();
  let st = await getState(page);
  for (const f of st.factions) {
    await expect(page.getByTestId(`standing-${f.key}`)).toContainText(f.standing.toFixed(1));
  }
  await page.getByTestId('character-close').click();
  await expect(page.getByTestId('character-sheet')).toBeHidden();

  // In space: the HUD button opens the same sheet.
  await page.getByTestId('character-btn').click();
  await expect(page.getByTestId('character-sheet')).toBeVisible();
  st = await getState(page);
  await expect(page.getByTestId('character-pilot')).toContainText('Battles Won');
});

test('inventory: deposit mined cargo into quantum storage and withdraw it back', async ({ page }) => {
  // Mine a bit of ore so the hold has something to deposit.
  const st = await getState(page);
  const ast = st.world.asteroids.find((a) => a.amount > 0);
  await page.evaluate(([x, y]) => window.__eve.warp(null, { x, y }), [ast.x, ast.y]);
  await expect(async () => {
    const s = await getState(page);
    expect(Object.values(s.minerals).reduce((a, b) => a + b, 0)).toBeGreaterThan(0);
  }).toPass({ timeout: 15000 });

  // Dock again and open the inventory.
  await page.evaluate((id) => window.__eve.warp(id), st.world.stations[0].id);
  await page.waitForFunction(() => window.__eve.state && window.__eve.state.docked === true);
  await page.keyboard.press('i');
  await expect(page.getByTestId('inventory')).toBeVisible();

  const mined = await getState(page);
  const mineral = Object.keys(mined.minerals).find((k) => mined.minerals[k] > 0);
  expect(mineral).toBeTruthy();
  const deposited = mined.minerals[mineral];

  // Deposit the whole hold into storage (the panel re-renders on sync, so click
  // via evaluate to avoid Playwright's element-stability wait).
  await page.evaluate((k) => document.querySelector(`[data-testid="inv-deposit-${k}-all"]`).click(), mineral);
  await expect(async () => {
    const s = await getState(page);
    expect(s.storage.minerals[mineral]).toBe(deposited);
    expect(s.minerals[mineral]).toBe(0);
  }).toPass({ timeout: 5000 });

  // Withdraw some back into the hold (the storage row only appears once the
  // inventory re-renders after the deposit sync, so wait for the button first).
  const takeBtn = deposited >= 100 ? '100' : 'all';
  const taken = Math.min(100, deposited);
  await page.waitForSelector(`[data-testid="inv-withdraw-${mineral}-${takeBtn}"]`, { timeout: 5000 });
  await page.evaluate(({ k, btn }) => document.querySelector(`[data-testid="inv-withdraw-${k}-${btn}"]`).click(), { k: mineral, btn: takeBtn });
  await expect(async () => {
    const s = await getState(page);
    expect(s.storage.minerals[mineral]).toBe(deposited - taken);
    expect(s.minerals[mineral]).toBe(taken);
  }).toPass({ timeout: 5000 });
});

test('reset returns to a fresh game', async ({ page }) => {
  // Buy a ship so the reset has something to undo.
  await page.evaluate(() => document.querySelector('[data-testid="buy-falcon"]').click());
  await expect(async () => {
    const s = await getState(page);
    expect(s.ships.length).toBe(2);
  }).toPass({ timeout: 5000 });

  await page.request.post('/api/reset');
  await page.reload();
  await page.getByTestId('mode-demo').click();
  await expect(page.getByTestId('ship-info')).toContainText('Rifter', { timeout: 15000 });
  await expect(page.getByTestId('isk')).toContainText('10.0K');
  const s = await getState(page);
  expect(s.ships.length).toBe(1);
});

test('drone bay: buy a mining drone and it boosts the active ship', async ({ page }) => {
  await expect(page.getByTestId('hangar')).toBeVisible();
  // The ship spawns docked, so the buy button is live; click via evaluate.
  await page.evaluate(() => document.querySelector('[data-testid="buy-drone-mining-t1"]').click());
  await expect(async () => {
    const s = await getState(page);
    expect(s.drones.mining).toEqual([1]);
    expect(s.isk).toBe(8500); // 10000 - 1500
  }).toPass({ timeout: 5000 });
});

test('industry: the hangar lists module blueprints craftable from ore', async ({ page }) => {
  await expect(page.getByTestId('hangar')).toBeVisible();
  await expect(page.getByTestId('hangar-industry')).toBeVisible();
  // A weapon blueprint with a mineral recipe is listed (not craftable: no ore).
  await expect(page.getByTestId('craft-weapon-t1')).toBeVisible();
  await expect(page.getByTestId('craft-weapon-t1')).toBeDisabled();
});

test('auto-pilot: toggling ▶ Auto flies to a belt and mines, off stops it', async ({ page }) => {
  // The ship starts docked at the home station with an empty hold.
  await page.evaluate(() => window.__eve.setAutoPilot(true));
  await expect(page.getByTestId('auto-pilot')).toContainText('Stop');
  // Auto flies to the nearest belt, where it starts mining.
  await expect(page.getByTestId('context')).toContainText('Mining', { timeout: 30000 });
  await expect(page.getByTestId('mining-indicator')).toContainText('Mining', { timeout: 5000 });
  // Toggling off stops the loop.
  await page.evaluate(() => window.__eve.setAutoPilot(false));
  await expect(page.getByTestId('auto-pilot')).toContainText('Auto');
});

test('mode menu: START boots the storyline with zero ISK, DEMO resumes the sandbox', async ({ page }) => {
  await page.request.post('/api/reset');
  await page.goto('/');
  await expect(page.getByTestId('mode-menu')).toBeVisible();
  await page.getByTestId('mode-story').click();
  await expect(page.getByTestId('ship-info')).toContainText('Rifter', { timeout: 15000 });
  let st = await getState(page);
  expect(st.mode).toBe('story');
  expect(st.isk).toBe(0);
  // Switching back to demo returns the 10k sandbox start.
  await page.reload();
  await page.getByTestId('mode-demo').click();
  await expect(page.getByTestId('ship-info')).toContainText('Rifter', { timeout: 15000 });
  st = await getState(page);
  expect(st.mode).toBe('demo');
  expect(st.isk).toBeGreaterThan(0);
});

// Play the whole storyline in one pass (m1→m8), asserting each mission's lesson
// as the course advances and ending at certification with the jump gates open.
// A single chain replaces five per-mission tests that each replayed the opening
// missions, so the browser suite covers the same ground in a fraction of the time.
test('storyline: pilot training from rookie to certification (m1–m8) unlocks the gates @slow', async ({ page }) => {
  test.setTimeout(420000);
  await page.request.post('/api/reset');
  await page.goto('/');
  await page.getByTestId('mode-story').click();
  await expect(page.getByTestId('ship-info')).toContainText('Rifter', { timeout: 15000 });

  // m1 — Under Attack: the handed-out weapon beats the attacker.
  await expect(page.getByTestId('mission-tracker')).toContainText('Under Attack');
  await expect(page.getByTestId('mission-dialogue')).toBeVisible();
  await page.getByTestId('mission-continue').click();
  await expect(page.getByTestId('mission-dialogue')).toBeHidden();
  await killMissionEnemy(page, 'attacker');

  // m2 — Help the Buddies: three short-range frigates; the first fight shows the
  // free-fire window the Range Amplifier grants.
  await expect(page.getByTestId('mission-tracker')).toContainText('Help the Buddies');
  const frigates = (await getState(page)).world.enemies.filter((e) => e.missionTag === 'shortrange' && e.alive);
  expect(frigates.length).toBe(3);
  await killMissionEnemy(page, 'shortrange', true);
  await killMissionEnemy(page, 'shortrange');
  await killMissionEnemy(page, 'shortrange');

  // m3 — Last Stand: the unwinnable wave destroys the ship (scripted death).
  await expect(page.getByTestId('mission-tracker')).toContainText('Last Stand');
  const wave = (await getState(page)).world.enemies.find((e) => e.missionTag === 'waveship' && e.alive);
  expect(wave).toBeTruthy();
  await page.evaluate((id) => window.__eve.warp(id), wave.id);
  await expect(async () => {
    const s = await getState(page);
    expect(dist(s.activeShip, wave)).toBeLessThan(200);
  }).toPass({ timeout: 30000 });
  await page.getByTestId('engage-btn').click();
  await expect(page.getByTestId('death-screen')).toBeVisible({ timeout: 45000 });
  await page.getByTestId('death-dismiss').click();
  await expect(async () => {
    const s = await getState(page);
    expect(s.mission.active).toBe('m4');
  }).toPass({ timeout: 15000 });

  // m4 — A New Clone: dock at the station, which hands off to m5.
  await expect(page.getByTestId('mission-tracker')).toContainText('A New Clone');
  await warpUntil(page, (await getState(page)).world.stations[0].id, (s) => s.mission.active === 'm5');

  // m5 — Mining 101: warp to a belt and mine 40 ore.
  await expect(page.getByTestId('mission-tracker')).toContainText('Mining 101');
  await warpUntil(page, (await getState(page)).world.belts[0].id, (s) => s.mission.active === 'm6');

  // m6 — Rogue Drones: destroy the drone hub and earn a mining drone.
  await killMissionEnemy(page, 'dronhub');
  await expect(async () => {
    const s = await getState(page);
    expect(s.mission.active).toBe('m7');
  }).toPass({ timeout: 45000 });
  const afterM6 = await getState(page);
  expect((afterM6.drones.mining || []).some((d) => d.tier === 1)).toBe(true);

  // m7 — The Forge: mine the ore both recipes need, dock, and craft them.
  await expect(page.getByTestId('mission-tracker')).toContainText('The Forge');
  const w = cfg.BLUEPRINTS.weapon[1].recipe;
  const sh = cfg.BLUEPRINTS.shield[2].recipe;
  await mineNeededOre(page, {
    iron: w.iron + sh.iron,
    bauxite: w.bauxite + sh.bauxite,
    gadolinium: w.gadolinium + sh.gadolinium,
    megacyte: w.megacyte + sh.megacyte,
  });
  await warpUntil(page, (await getState(page)).world.stations[0].id, (s) => s.docked === true);
  await expect(page.getByTestId('hangar-industry')).toBeVisible();
  await page.getByTestId('craft-weapon-t1').click();
  await page.getByTestId('craft-shield-t2').click();

  // m8 — Certification: accept it and the jump gates unlock.
  await expect(async () => {
    const s = await getState(page);
    expect(s.mission.active).toBe('m8');
  }).toPass({ timeout: 15000 });
  await expect(page.getByTestId('mission-tracker')).toContainText('Certification');
  await page.getByTestId('mission-continue').click();
  await expect(async () => {
    const s = await getState(page);
    expect(s.mission.completed).toContain('m8');
  }).toPass({ timeout: 15000 });
  const certified = await getState(page);
  const gate = certified.world.gates[0];
  await page.evaluate((id) => window.__eve.warp(id), gate.id);
  await expect(async () => {
    const s = await getState(page);
    expect(dist(s.activeShip, gate)).toBeLessThan(400);
  }).toPass({ timeout: 30000 });
  await expect(page.getByTestId('gate-jump')).toBeVisible({ timeout: 10000 });
});

// Warp to a POI and wait until `done(state)` is true — used for handoffs that
// complete automatically once you arrive (docking, mission progression).
async function warpUntil(page, targetId, done) {
  await page.evaluate((id) => window.__eve.warp(id), targetId);
  await expect(async () => {
    const s = await getState(page);
    expect(done(s)).toBe(true);
  }).toPass({ timeout: 45000 });
}

// Warp the active ship onto a living asteroid of each still-missing mineral and
// mine until its target is met. Parking directly on the rock (rather than a belt)
// is deterministic: mining always takes the nearest asteroid in range, so a belt's
// layout can never starve a mineral. Polls tightly so the ~444 units of recipe ore
// fits the granted 510-unit hold; if it ever fills we dock and sell, then continue.
async function mineNeededOre(page, needs) {
  for (let iter = 0; iter < 200; iter++) {
    const st = await getState(page);
    const c = st.minerals || {};
    const missing = Object.entries(needs).filter(([k, n]) => (c[k] || 0) < n);
    if (!missing.length) return st;
    if (st.cargoFull) {
      await warpUntil(page, st.world.stations[0].id, (s) => s.docked === true);
      await page.request.post('/api/sell-all');
      continue;
    }
    const rock = st.world.asteroids.find((a) => a.mineral === missing[0][0] && a.amount > 0);
    if (!rock) throw new Error('No asteroid for missing mineral: ' + missing[0][0]);
    await page.evaluate(([x, y]) => window.__eve.warp(null, { x, y }), [rock.x, rock.y]);
    await page.waitForTimeout(300);
  }
  throw new Error('gave up mining the forge ore');
}
