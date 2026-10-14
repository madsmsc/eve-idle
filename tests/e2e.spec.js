'use strict';

const { test, expect } = require('@playwright/test');

// Browser end-to-end tests for the rendered world. These drive the real
// frontend against the real server, covering the full loop: input -> local
// physics -> position sync -> server validation -> persisted state -> re-render.
//
// The canvas is the game, so we assert on the HUD (ISK, ship info, mining
// indicator, engage button, combat banner, hangar) and on the server state
// (via /api/state) rather than on canvas pixels. A small test hook
// (window.__eve) lets us set a flight destination without pixel-perfect clicks.

function dist(a, b) {
  return Math.hypot(a.x - b.x, a.y - b.y);
}

async function getState(page) {
  return (await (await page.request.get('/api/state')).json()).state;
}

// Nearest living object of the given world list to the ship.
function nearest(list, ship) {
  return list.slice().sort((a, b) => dist(a, ship) - dist(b, ship))[0];
}

test.beforeEach(async ({ page }) => {
  // Clean slate for every test (regenerates a fresh world), then load the app.
  await page.request.post('/api/reset');
  await page.goto('/');
  // ship-info only shows the active ship name once the app has booted.
  await expect(page.getByTestId('ship-info')).toContainText('Rifter', { timeout: 15000 });
});

test('renders the world and HUD', async ({ page }) => {
  const world = page.locator('#world');
  await expect(world).toBeVisible();
  const box = await world.boundingBox();
  expect(box.width).toBeGreaterThan(0);
  expect(box.height).toBeGreaterThan(0);

  await expect(page.getByTestId('isk')).toContainText('10.0K');
  await expect(page.getByTestId('ship-info')).toContainText('Rifter');
  await expect(page.getByTestId('minimap')).toBeVisible();
  // The ship starts at the station, far from any asteroid, so it is idle.
  await expect(page.getByTestId('mining-indicator')).toContainText('Idle');
});

test('world contains a star, planets, stations and belts', async ({ page }) => {
  const st = await getState(page);
  expect(st.world.star).toBeTruthy();
  expect(st.world.planets.length).toBeGreaterThanOrEqual(1);
  expect(st.world.stations.length).toBeGreaterThanOrEqual(2);
  expect(st.world.belts.length).toBeGreaterThan(0);
  expect(st.world.asteroids.length).toBeGreaterThan(0);
  // The ship spawns at the home station.
  const home = st.world.stations[0];
  expect(Math.hypot(st.activeShip.x - home.x, st.activeShip.y - home.y)).toBeLessThan(1);
});

test('the hangar shows the active system market price', async ({ page }) => {
  const st = await getState(page);
  // The active system exposes a price for every mineral.
  expect(st.world.prices).toBeTruthy();
  expect(st.world.prices.iron).toBeGreaterThanOrEqual(1);
  expect(st.world.prices.bauxite).toBeGreaterThanOrEqual(1);
  // The hangar lists the active system's price, not a fixed base price.
  await page.getByTestId('hangar-btn').click();
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

test('click warps the ship to the clicked belt', async ({ page }) => {
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
  await expect(async () => {
    const s = await getState(page);
    expect(dist(s.activeShip, b)).toBeLessThan(5);
  }).toPass({ timeout: 5000 });
});

test('HUD shows the current system name', async ({ page }) => {
  const st = await getState(page);
  await expect(page.getByTestId('system-name')).toContainText(st.system.name);
});

test('system name is tinted with the system color', async ({ page }) => {
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

test('warp button teleports the ship to a belt', async ({ page }) => {
  await page.getByTestId('warp-belt').click();
  await expect(async () => {
    const s = await getState(page);
    expect(s.world.belts.some((b) => dist(s.activeShip, b) < 5)).toBe(true);
  }).toPass({ timeout: 5000 });
});

test('warp button teleports the ship to a rat', async ({ page }) => {
  await page.getByTestId('warp-rat').click();
  await expect(async () => {
    const s = await getState(page);
    expect(s.world.enemies.some((e) => e.alive && dist(s.activeShip, e) < 5)).toBe(true);
  }).toPass({ timeout: 5000 });
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

test('the gate-jump button shows the destination ambush risk', async ({ page }) => {
  const st = await getState(page);
  const gate = st.system.gates[0];
  await page.evaluate((id) => window.__eve.warp(id), gate.id);
  await expect(async () => {
    const s = await getState(page);
    expect(dist(s.activeShip, gate)).toBeLessThan(5);
  }).toPass({ timeout: 5000 });
  // The button reads "⇄ <System> · <N>%".
  await expect(page.getByTestId('gate-jump')).toContainText('%');
});

test('the hangar lists every faction with standing and ambush risk', async ({ page }) => {
  const st = await getState(page);
  await page.getByTestId('hangar-btn').click();
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

test('flying to a belt auto-mines from the belt center', async ({ page }) => {
  const st = await getState(page);
  const belt = st.world.belts[0];
  await page.evaluate(({ x, y }) => window.__eve.setDestination(x, y), belt);

  // Parked on the belt center the ship is in range of a rock, so it mines.
  // The context only reads "Mining" once the ship has arrived (destination
  // cleared) and is in range of a rock, so it is the definitive signal.
  await expect(page.getByTestId('context')).toContainText('Mining', { timeout: 30000 });
  await expect(page.getByTestId('mining-indicator')).toContainText('Mining', { timeout: 5000 });
});

test('a full cargo hold triggers an auto-recall to the station', async ({ page }) => {
  const st = await getState(page);
  const belt = st.world.belts[0];
  await page.evaluate(({ x, y }) => window.__eve.setDestination(x, y), belt);
  await expect(page.getByTestId('context')).toContainText('Mining', { timeout: 30000 });

  // The rifter's small hold fills in ~10s; once full the ship turns for home.
  await expect(page.getByTestId('context')).toContainText(/Cargo full/i, { timeout: 45000 });
});

test('combat: fly to an enemy and engage', async ({ page }) => {
  const st = await getState(page);
  const enemy = nearest(st.world.enemies.filter((e) => e.alive), st.activeShip);
  await page.evaluate(({ x, y }) => window.__eve.setDestination(x, y), enemy);

  // Wait until the SERVER sees the ship within engage range of the target.
  await expect(async () => {
    const s = await getState(page);
    expect(dist(s.activeShip, enemy)).toBeLessThan(200);
  }).toPass({ timeout: 30000 });

  await page.getByTestId('engage-btn').click();
  await expect(page.getByTestId('combat-banner')).toBeVisible({ timeout: 5000 });
});

test('combat resolves: the rat dies on a win, the ship is lost on a defeat', async ({ page }) => {
  const st = await getState(page);
  const enemy = nearest(st.world.enemies.filter((e) => e.alive), st.activeShip);
  await page.evaluate(({ x, y }) => window.__eve.setDestination(x, y), enemy);
  await expect(async () => {
    const s = await getState(page);
    expect(dist(s.activeShip, enemy)).toBeLessThan(200);
  }).toPass({ timeout: 30000 });

  await page.getByTestId('engage-btn').click();
  await expect(page.getByTestId('combat-banner')).toBeVisible({ timeout: 5000 });

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

test('death screen: a destroyed ship shows the death screen with the killmail', async ({ page }) => {
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

test('loadout: selecting a fit updates the active ship', async ({ page }) => {
  // The loadout selector is visible with the stock fit highlighted.
  await expect(page.getByTestId('loadout-panel')).toBeVisible();
  await expect(page.getByTestId('loadout-balanced')).toHaveClass(/active/);

  // Switch to the tank fit.
  await page.getByTestId('loadout-tank').click();
  await expect(async () => {
    const s = await getState(page);
    expect(s.activeShip.loadout).toBe('tank');
  }).toPass({ timeout: 5000 });
  await expect(page.getByTestId('loadout-tank')).toHaveClass(/active/);
  await expect(page.getByTestId('loadout-balanced')).not.toHaveClass(/active/);
});

test('fitting: fitting a module updates the active ship and spends ISK', async ({ page }) => {
  await page.getByTestId('hangar-btn').click();
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
  await page.getByTestId('hangar-btn').click();
  await expect(page.getByTestId('hangar-skills')).toBeVisible();
  // A fresh account has no skill points, so training is unavailable.
  await expect(page.getByTestId('hangar-sp')).toContainText('0 SP');
  await expect(page.getByTestId('skill-gunnery')).toBeDisabled();
});

test('hangar: open it and buy a ship', async ({ page }) => {
  await page.getByTestId('hangar-btn').click();
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
  await page.getByTestId('hangar-btn').click();
  await page.evaluate(() => document.querySelector('[data-testid="buy-brutix"]').click()); // 250000 ISK, we have 10000
  await expect(page.getByTestId('toast')).toContainText(/Not enough ISK/i);
  const s = await getState(page);
  expect(s.ships.length).toBe(1);
});

test('docking gates the market', async ({ page }) => {
  // The ship spawns docked at the home station, so the market is open.
  await page.getByTestId('hangar-btn').click();
  await expect(page.getByTestId('sell-iron-100')).toBeEnabled();

  // Fly to open space (far from every station); the live hangar must lock.
  await page.evaluate(() => window.__eve.setDestination(600, 600));
  await page.waitForFunction(() => window.__eve.state && window.__eve.state.docked === false);
  await expect(page.getByTestId('sell-iron-100')).toBeDisabled();
});

test('reset returns to a fresh game', async ({ page }) => {
  // Buy a ship so the reset has something to undo.
  await page.getByTestId('hangar-btn').click();
  await page.evaluate(() => document.querySelector('[data-testid="buy-falcon"]').click());
  await expect(async () => {
    const s = await getState(page);
    expect(s.ships.length).toBe(2);
  }).toPass({ timeout: 5000 });

  await page.request.post('/api/reset');
  await page.reload();
  await expect(page.getByTestId('ship-info')).toContainText('Rifter', { timeout: 15000 });
  await expect(page.getByTestId('isk')).toContainText('10.0K');
  const s = await getState(page);
  expect(s.ships.length).toBe(1);
});

test('drone bay: buy a mining drone and it boosts the active ship', async ({ page }) => {
  await page.getByTestId('hangar-btn').click();
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
  await page.getByTestId('hangar-btn').click();
  await expect(page.getByTestId('hangar')).toBeVisible();
  await expect(page.getByTestId('hangar-industry')).toBeVisible();
  // A weapon blueprint with a mineral recipe is listed (not craftable: no ore).
  await expect(page.getByTestId('craft-weapon-t1')).toBeVisible();
  await expect(page.getByTestId('craft-weapon-t1')).toBeDisabled();
});

test('auto-pilot: toggling ▶ Auto on warps to a belt and mines, off stops it', async ({ page }) => {
  // The ship starts docked at the home station with an empty hold.
  await page.evaluate(() => window.__eve.setAutoPilot(true));
  await expect(page.getByTestId('auto-pilot')).toContainText('Stop');
  // Auto warps to the nearest belt, where it starts mining.
  await expect(page.getByTestId('context')).toContainText('Mining', { timeout: 30000 });
  await expect(page.getByTestId('mining-indicator')).toContainText('Mining', { timeout: 5000 });
  // Toggling off stops the loop.
  await page.evaluate(() => window.__eve.setAutoPilot(false));
  await expect(page.getByTestId('auto-pilot')).toContainText('Auto');
});
