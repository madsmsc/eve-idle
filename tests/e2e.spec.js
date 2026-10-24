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
  // Reset the selected demo save, then reload so each test boots from that clean save.
  await page.request.post('/api/reset');
  await page.goto('/');
  await page.getByTestId('mode-demo').click();
  await page.request.post('/api/reset');
  await page.reload();
  await page.getByTestId('mode-demo').click();
  // the status box is only filled once the app has booted.
  await expect(page.getByTestId('context-state')).toHaveText(/\S/, { timeout: 15000 });
});

test('demo quick-start hint appears once and remembers dismissal', async ({ page }) => {
  const hint = page.getByTestId('tutorial-hint');
  await expect(hint).toBeVisible();
  await page.getByTestId('tutorial-dismiss').click();
  await expect(hint).toBeHidden();
  await page.reload();
  await page.getByTestId('mode-demo').click();
  await expect(page.getByTestId('context-state')).toHaveText(/\S/, { timeout: 15000 });
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

  expect((await getState(page)).isk).toBe(10000);
  await expect(page.getByTestId('context-state')).toHaveText(/\S/);
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
  // The redundant lower-left mining indicator is gone; the status box covers it.
  await expect(page.getByTestId('mining-indicator')).toHaveCount(0);
  await expect(page.getByTestId('threat')).toHaveCount(0);
  await expect(page.getByTestId('context-state')).not.toBeEmpty();
  await expect(page.getByTestId('security')).toHaveCount(0);
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
  await expect(page.getByTestId('auto-mine')).toHaveAttribute('data-shortcut', 'A');
  await expect(page.getByTestId('navigate-belt')).toHaveAttribute('data-shortcut', 'B');
  await expect(page.getByTestId('navigate-station')).toHaveAttribute('data-shortcut', 'S');
  await expect(page.getByTestId('navigate-rat')).toHaveAttribute('data-shortcut', 'R');
  await expect(page.getByTestId('engage-btn')).toHaveAttribute('data-shortcut', 'E');
  await expect(page.getByTestId('menu-pilot')).toHaveCount(0);
  await expect(page.getByTestId('menu-cargo')).toHaveAttribute('data-shortcut', 'I');

  await undock(page);
  await expect(page.getByTestId('context-state')).toHaveText(/\S/);
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
  await expect(page.getByTestId('auto-mine')).toHaveClass(/auto-mode-selected/);
  await page.keyboard.press('a');
  await expect(page.getByTestId('auto-mine')).not.toHaveClass(/auto-mode-selected/);
  await page.evaluate(() => window.__eve.setAutoPilot(false));
  await expect(page.getByTestId('auto-mine')).not.toHaveClass(/auto-mode-selected/);
});

test('right-side Actions and Auto panels stay visible beside ship status', async ({ page }) => {
  await undock(page);
  await expect(page.getByTestId('navigation-actions')).toBeVisible();
  await expect(page.getByTestId('actions-panel')).toBeVisible();
  await expect(page.getByTestId('auto-panel')).toBeVisible();
  for (const testId of ['engage-btn', 'navigate-belt', 'navigate-station', 'navigate-rat', 'auto-mine', 'auto-mine-hunt', 'auto-hunt']) {
    await expect(page.getByTestId(testId)).toBeVisible();
  }
  const layout = await page.evaluate(() => {
    const bounds = (selector) => {
      const { x, y, width, height } = document.querySelector(selector).getBoundingClientRect();
      return { x, y, width, height };
    };
    return {
      context: bounds('[data-testid="context"]'),
      status: bounds('[data-testid="ship-status"]'),
      actions: bounds('[data-testid="flight-actions"]'),
      auto: bounds('[data-testid="auto-panel"]'),
      actionPanel: bounds('[data-testid="actions-panel"]'),
      menu: bounds('[data-testid="left-menu"]'),
      system: bounds('.hud-tl'),
      viewportWidth: window.innerWidth,
    };
  });
  expect(Math.abs(layout.context.x + layout.context.width / 2 - layout.viewportWidth / 2)).toBeLessThanOrEqual(1);
  expect(layout.context.y).toBeLessThan(30);
  expect(layout.actions.x).toBeGreaterThanOrEqual(layout.status.x + layout.status.width);
  expect(layout.actionPanel.x).toBeGreaterThan(layout.auto.x);
  expect(layout.actionPanel.x + layout.actionPanel.width).toBeCloseTo(layout.viewportWidth - 16, 0);
  expect(layout.actions.width).toBeLessThanOrEqual(300);
  expect(layout.menu.x).toBeLessThan(layout.actions.x);
  expect(layout.menu.y).toBeGreaterThan(100);
  expect(layout.menu.y + layout.menu.height).toBeCloseTo(708, 0);
  expect(layout.system.x).toBe(14);

  await page.setViewportSize({ width: 390, height: 844 });
  const mobileLayout = await page.evaluate(() => {
    const bounds = (selector) => {
      const { x, y, width, height } = document.querySelector(selector).getBoundingClientRect();
      return { x, y, width, height };
    };
    return {
      status: bounds('[data-testid="ship-status"]'),
      actions: bounds('[data-testid="flight-actions"]'),
      auto: bounds('[data-testid="auto-panel"]'),
      actionPanel: bounds('[data-testid="actions-panel"]'),
      menu: bounds('[data-testid="left-menu"]'),
    };
  });
  expect(mobileLayout.actionPanel.x).toBeGreaterThan(mobileLayout.auto.x);
  expect(mobileLayout.status.y + mobileLayout.status.height).toBeLessThan(mobileLayout.actions.y);
  expect(mobileLayout.menu.x + mobileLayout.menu.width).toBeLessThan(mobileLayout.status.x);
  await page.setViewportSize({ width: 1280, height: 720 });

  await expect(page.getByTestId('navigate-toggle')).toHaveCount(0);
  await expect(page.getByTestId('menu-cargo')).toHaveText('Cargo');
  await expect(page.getByTestId('menu-pilot')).toHaveCount(0);
  await expect(page.getByTestId('menu-achievements')).toHaveText('Achieve');
  await expect(page.locator('.menu-icon, .menu-copy small')).toHaveCount(0);
  await expect(page.getByTestId('menu-fleet')).toBeVisible();
  await expect(page.getByTestId('menu-fleet')).toBeDisabled();

  await expect(page.getByTestId('minimap')).toBeVisible();
  const minimapBounds = await page.getByTestId('minimap').boundingBox();
  const toggleBounds = await page.getByTestId('overview-toggle').boundingBox();
  expect(toggleBounds.x + toggleBounds.width).toBeCloseTo(minimapBounds.x + minimapBounds.width - 4, 0);
  expect(toggleBounds.y).toBeCloseTo(minimapBounds.y + 4, 0);
  await expect(page.getByTestId('overview-toggle')).toHaveText('X');
  await page.getByTestId('overview-toggle').click();
  await expect(page.getByTestId('minimap')).toBeHidden();
  await expect(page.getByTestId('overview-toggle')).toHaveText('V');
  await expect(page.getByTestId('overview-toggle')).toHaveAttribute('aria-label', 'Show minimap');
  await page.keyboard.press('m');
  await expect(page.getByTestId('minimap')).toBeVisible();
  await expect(page.getByTestId('overview-toggle')).toHaveText('X');
});

test('cargo combines loadout and inventory while storage remains separate', async ({ page }) => {
  await expect(page.getByTestId('menu-cargo')).toBeVisible();
  await expect(page.getByTestId('menu-fitting')).toHaveCount(0);
  await expect(page.getByTestId('menu-window')).toBeVisible();
  await expect(page.getByTestId('inventory')).toBeVisible();
  await expect(page.getByTestId('inventory')).toHaveAttribute('data-menu-page', 'cargo');
  await expect(page.locator('.menu-window .panel-header')).toHaveCount(0);
  await expect(page.getByTestId('menu-window-close')).toHaveCount(0);
  const cargoBackgrounds = await page.evaluate(() => ({
    workspace: getComputedStyle(document.getElementById('menu-window')).backgroundColor,
    loadout: getComputedStyle(document.querySelector('.ship-loadout')).backgroundColor,
  }));
  expect(cargoBackgrounds.workspace).toBe('rgba(0, 0, 0, 0)');
  expect(cargoBackgrounds.loadout).not.toBe('rgba(0, 0, 0, 0)');
  await expect.poll(() => page.getByTestId('cargo-layout').evaluate((element) =>
    getComputedStyle(element).gridTemplateColumns.split(' ').length
  )).toBe(3);
  await expect(page.getByTestId('inv-fitting')).toBeVisible();
  await expect(page.getByTestId('inv-grid')).toBeVisible();
  await page.getByTestId('cargo-filter-loot').click();
  await expect(page.getByTestId('cargo-filter-loot')).toHaveClass(/active/);
  await page.getByTestId('menu-storage').click();
  await expect(page.getByTestId('storage-panel')).toBeVisible();
  await expect(page.getByTestId('inventory')).toBeHidden();
  await expect(page.getByTestId('menu-pilot')).toHaveCount(0);
  await page.getByTestId('menu-killboard').click();
  await expect(page.getByTestId('killboard-stats')).toContainText('Battles Won');
  await expect(page.getByTestId('killboard-stats')).toContainText('Ships Lost');
  await expect(page.getByTestId('hangar')).toBeVisible();
});

test('inventory stacks ore without a slot cap and scrolls when item count grows', async ({ page }) => {
  const metrics = await page.evaluate(() => {
    window.__eve.state.loot = Array.from({ length: 100 }, (_, index) => ({
      id: `overflow-${index}`,
      name: `Module ${index}`,
      slotType: 'weapon',
      tier: 1,
    }));
    document.querySelector('[data-cargo-filter="loot"]').click();
    const grid = document.getElementById('inv-grid');
    return {
      count: grid.querySelectorAll('.inv-cell').length,
      scrollable: grid.scrollHeight > grid.clientHeight,
      overflowY: getComputedStyle(grid).overflowY,
    };
  });
  expect(metrics.count).toBeGreaterThanOrEqual(100);
  expect(metrics.scrollable).toBe(true);
  expect(metrics.overflowY).toBe('auto');
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
  // Approaching a belt targets its closest asteroid, not the belt centre.
  const rock = nearest(state.world.asteroids.filter((a) => a.beltId === belt.id && a.amount > 0), start);
  await page.getByTestId('navigate-belt').click();
  await expect.poll(() => page.evaluate(() => window.__eve.getDestination())).toMatchObject({ x: rock.x, y: rock.y });
  await page.waitForTimeout(700);
  let moving = await page.evaluate(() => window.__eve.getShip());
  expect(dist(moving, start)).toBeGreaterThan(10);
  expect(dist(moving, rock)).toBeLessThan(dist(start, rock));

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
  await page.getByTestId('menu-factions').click();
  const factions = page.getByTestId('hangar-factions');
  for (const f of st.factions) {
    await expect(factions).toContainText(f.name);
  }
});

test('mining: fly to an asteroid and cargo grows', async ({ page }) => {
  await expect(page.getByTestId('cargo')).toHaveCount(0);
  await undock(page);
  const st = await getState(page);
  const ast = nearest(st.world.asteroids.filter((a) => a.amount > 0), st.activeShip);
  expect(await page.evaluate(({ x, y }) => window.__eve.setDestination(x, y), ast)).toBe(true);
  const navigation = (await getState(page)).navigation;
  expect(navigation).toBeTruthy();
  const start = st.activeShip;
  await expect.poll(async () => dist((await getState(page)).activeShip, start), { timeout: 5000 })
    .toBeGreaterThan(5);

  // The HUD flips to "Mining" once the ship is within range of the asteroid.
  await expect(page.getByTestId('context-state')).toContainText('Mining', { timeout: 30000 });
  await expect(page.getByTestId('context-detail')).toContainText(/Cargo \d+\/\d+/);

  // And the server actually credits cargo.
  await expect(async () => {
    const s = await getState(page);
    const total = Object.values(s.minerals).reduce((a, b) => a + b, 0);
    expect(total).toBeGreaterThan(0);
  }).toPass({ timeout: 30000 });
});

test('belt mining grows cargo and auto-recalls on a full hold @slow', async ({ page }) => {
  await undock(page);
  const st = await getState(page);
  const belt = st.world.belts[0];
  await page.evaluate(({ x, y }) => window.__eve.setDestination(x, y), belt);
  await expect(page.getByTestId('context')).toContainText('Mining', { timeout: 30000 });
  await expect(page.getByTestId('context-state')).toContainText('Mining', { timeout: 5000 });
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

test('death screen shows the killmail when a ship is destroyed', async ({ page }) => {
  // Jita only spawns rats the starter ship beats, so a real loss isn't possible
  // here (the server-side loss path is covered in game.test.js); drive the overlay.
  await page.evaluate(() => window.__eve.showDeath({ ship: 'Rifter', enemy: 'Faction Destroyer', system: 'Jita', cargoLost: 5, insurance: 0 }));
  await expect(page.getByTestId('death-screen')).toBeVisible();
  await expect(page.getByTestId('death-detail')).toContainText(/Rifter lost to Faction Destroyer/i);
  await expect(page.getByTestId('death-detail')).toContainText('5 units of cargo lost');
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
  await expect(page.getByTestId('context-log')).toContainText('Shield boosted');
  await expect(page.getByTestId('toast')).toHaveCount(0);
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

test('cargo fitting column is read-only; inventory equips modules and ship loadout unequips all', async ({ page }) => {
  await expect(page.getByTestId('inv-fitting')).toBeVisible();
  await expect(page.getByTestId('save-fitting-preset')).toHaveCount(0);
  await expect(page.locator('#fitting-presets')).toBeHidden();
  await expect(page.getByTestId('unequip-all')).toBeDisabled();
  await expect(page.getByTestId('unequip-all-hint')).toHaveText('No fitted modules to return.');
  await expect(page.getByTestId('inv-ship-stats')).toContainText(/Mining/);
  await expect(page.getByTestId('inv-ship-stats')).toContainText(/Speed/);
  await expect(page.getByTestId('inv-ship-stats')).toContainText(/Shield/);
  await expect(page.getByTestId('inv-ship-stats')).toContainText(/Hull/);
  await expect(page.getByTestId('fit-slot-weapon-0')).toContainText('Empty');
  await page.getByTestId('fit-slot-weapon-0').click();
  await expect(page.getByTestId('fit-select-weapon-0')).toHaveCount(0);

  await page.getByTestId('menu-market').click();
  await page.getByTestId('buy-blueprint-weapon-t1').click();
  await page.getByTestId('menu-industry').click();
  await page.getByTestId('craft-weapon-t1').click();
  await expect(async () => {
    const state = await getState(page);
    expect(state.loot).toHaveLength(1);
    expect(state.loot[0].slotType).toBe('weapon');
  }).toPass({ timeout: 5000 });

  await page.getByTestId('menu-cargo').click();
  const lootId = (await getState(page)).loot[0].id;
  await page.getByTestId('cargo-filter-loot').click();
  await page.getByTestId(`inv-cell-${lootId}`).click();
  await expect(page.getByTestId(`inv-equip-${lootId}`)).toBeEnabled();
  await page.getByTestId(`inv-equip-${lootId}`).click();
  await expect(async () => {
    const state = await getState(page);
    expect(state.activeShip.fitting.weapon[0]).toBe(1);
    expect(state.loot).toHaveLength(0);
  }).toPass({ timeout: 5000 });
  await expect(page.getByTestId('fit-slot-weapon-0')).toContainText('Tier I');

  await expect(page.getByTestId('unequip-all')).toBeEnabled();
  await expect(page.getByTestId('unequip-all-hint')).toHaveText('Returns all fitted modules to inventory.');
  await page.getByTestId('unequip-all').click();
  await expect(async () => {
    const state = await getState(page);
    expect(state.activeShip.fitting.weapon[0]).toBe(0);
    expect(state.loot).toHaveLength(1);
  }).toPass({ timeout: 5000 });
  await expect(page.getByTestId('fit-slot-weapon-0')).toContainText('Empty');
  await expect(page.getByTestId('unequip-all')).toBeDisabled();
  await expect(page.getByTestId('unequip-all-hint')).toHaveText('No fitted modules to return.');
});

test('skills: the hangar shows the skill tree and SP', async ({ page }) => {
  await page.getByTestId('menu-skills').click();
  await expect(page.getByTestId('hangar-skills')).toBeVisible();
  // A fresh account has no skill points, so training is unavailable.
  await expect(page.getByTestId('hangar-sp')).toContainText('0 SP');
  await expect(page.getByTestId('skill-gunnery')).toBeDisabled();
});

test('station services open independently from the persistent menu', async ({ page }) => {
  await expect(page.getByTestId('left-menu').locator('.menu-card')).toHaveCount(10);
  await expect(page.getByTestId('menu-fleet')).toBeVisible();
  await expect(page.getByTestId('menu-fleet')).toBeEnabled();
  await expect(page.getByTestId('menu-industry')).toBeVisible();
  await expect(page.getByTestId('menu-industry')).toBeEnabled();
  await page.getByTestId('menu-fleet').click();
  await expect(page.getByTestId('hangar')).toBeVisible();
  await expect(page.getByTestId('hangar-fleet')).toBeVisible();
  await expect(page.locator('.hangar-header')).toHaveCount(0);
  await expect(page.locator('.hangar-body section[data-panel="fleet"] > h3')).toBeHidden();
  const fleetPanelBackground = await page.locator('.hangar-body section[data-panel="fleet"]').evaluate((element) =>
    getComputedStyle(element).backgroundColor
  );
  expect(fleetPanelBackground).not.toBe('rgba(0, 0, 0, 0)');

  await page.getByTestId('menu-shipyard').click();
  await expect(page.getByTestId('hangar-shop')).toBeVisible();
});

test('shipyard shows progression requirements and NPCs only sell basic blueprints', async ({ page }) => {
  await page.getByTestId('menu-shipyard').click();
  await expect(page.getByTestId('hangar-shop')).toContainText('Tier 1');
  await expect(page.getByTestId('hangar-shop')).toContainText('Tier 4');
  await expect(page.getByTestId('hangar-shop')).toContainText('Mining Yield 0/1 (missing)');
  await expect(page.getByTestId('craft-ship-falcon')).toBeDisabled();

  await page.getByTestId('menu-market').click();
  await expect(page.getByTestId('buy-blueprint-weapon-t1')).toBeVisible();
  await expect(page.getByTestId('buy-blueprint-weapon-t2')).toHaveCount(0);
  await expect(page.getByTestId('buy-blueprint-ship-falcon')).toHaveCount(0);
});

test('hangar: open it and buy a ship', async ({ page }) => {
  await page.getByTestId('menu-shipyard').click();
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

test('shows an unaffordable purchase message in the action log', async ({ page }) => {
  await page.getByTestId('menu-shipyard').click();
  await page.evaluate(() => document.querySelector('[data-testid="buy-brutix"]').click()); // 250000 ISK, we have 10000
  await expect(page.getByTestId('context-log')).toContainText(/Not enough ISK/i);
  const s = await getState(page);
  expect(s.ships.length).toBe(1);
});

test('station services overlay a blurred world capture and launching returns to space', async ({ page }) => {
  await expect(page.getByTestId('station-view')).toBeVisible();
  await expect(page.getByTestId('station-view-name')).toContainText('Station A');
  await page.getByTestId('menu-fleet').click();
  await expect(page.getByTestId('hangar')).toBeVisible();
  const dockBackground = await page.getByTestId('station-view').evaluate((el) => el.style.getPropertyValue('--dock-background'));
  expect(dockBackground).toMatch(/^url\("data:image\/png;base64,/);
  const backgroundFilter = await page.getByTestId('station-view').evaluate((el) => getComputedStyle(el, '::before').filter);
  expect(backgroundFilter).toBe('blur(6px)');
  const hangarNav = await page.getByTestId('left-menu').boundingBox();
  const viewport = await page.evaluate(() => ({ height: window.innerHeight, width: window.innerWidth }));
  expect(hangarNav.x).toBeLessThan(30);
  expect(Math.abs(hangarNav.y + hangarNav.height - viewport.height)).toBeLessThanOrEqual(20);
  const stationWidth = await page.getByTestId('hangar').evaluate((el) => el.getBoundingClientRect().width);
  const viewportWidth = await page.evaluate(() => window.innerWidth);
  expect(stationWidth).toBe(viewportWidth);

  const initial = await getState(page);
  const station = initial.world.stations[0];
  const asteroid = initial.world.asteroids[0];
  await page.evaluate(({ x, y }) => window.__eve.warp(null, { x, y }), asteroid);
  await expect.poll(async () => (await getState(page)).cargoFull, { timeout: 30000 }).toBe(true);
  await page.evaluate((id) => window.__eve.warp(id), station.id);
  await expect.poll(async () => (await getState(page)).docked, { timeout: 5000 }).toBe(true);

  await page.getByTestId('station-launch').click();
  await expect(async () => {
    const s = await getState(page);
    expect(s.docked).toBe(false);
    expect(s.activeShip.x).toBeGreaterThan(station.x + 260);
  }).toPass({ timeout: 5000 });
  await expect(page.getByTestId('station-view')).toBeHidden();
  const launched = await getState(page);
  expect(dist(launched.activeShip, station)).toBeLessThan(450);
  const target = { x: Math.min(launched.world.width, station.x + 1000), y: station.y + 400 };
  await page.evaluate(({ x, y }) => window.__eve.setDestination(x, y), target);
  await expect.poll(async () => dist(await page.evaluate(() => window.__eve.getShip()), launched.activeShip))
    .toBeGreaterThan(5);
  const afterLaunch = await getState(page);
  expect(afterLaunch.docked).toBe(false);
  expect(dist(afterLaunch.activeShip, station)).toBeLessThan(600);
});

test('the hangar is only available while docked', async ({ page }) => {
  await expect(page.getByTestId('menu-fleet')).toBeVisible();

  // Fly to open space (far from every station); the hangar closes and can't reopen.
  await undock(page);
  await page.evaluate(() => window.__eve.setDestination(600, 600));
  await page.waitForFunction(() => window.__eve.state && window.__eve.state.docked === false);
  await expect(page.getByTestId('hangar')).toBeHidden();
  await page.keyboard.press('h');
  await expect(page.getByTestId('hangar')).toBeHidden();
  await expect(page.getByTestId('context-log')).toContainText(/Dock at a station/i);
});

test('docking flies into the station and fades to black before the hangar shows', async ({ page }) => {
  await undock(page);
  const station = (await getState(page)).world.stations[0];
  await page.evaluate((id) => window.__eve.warp(id), station.id);
  await expect(page.getByTestId('dock-fade')).toHaveClass(/\bon\b/, { timeout: 10000 });
  await expect(page.getByTestId('hangar')).toBeHidden();
  await expect(page.getByTestId('inventory')).toBeVisible({ timeout: 10000 });
  await expect(page.getByTestId('menu-window')).toBeVisible();
  await expect(page.getByTestId('dock-fade')).not.toHaveClass(/\bon\b/);
});

test('skill points and combat totals are shown in their respective menus', async ({ page }) => {
  await expect(page.getByTestId('isk')).toHaveCount(0);
  await page.getByTestId('menu-skills').click();
  await expect(page.getByTestId('hangar-sp')).toContainText('SP');
  await page.getByTestId('menu-killboard').click();
  await expect(page.getByTestId('killboard-stats')).toContainText('Battles Won');
  await expect(page.getByTestId('killboard-stats')).toContainText('Ships Lost');
  await expect(page.getByTestId('menu-pilot')).toHaveCount(0);
  await expect(page.getByTestId('security')).toHaveCount(0);
});

test('the same left-side menu remains available docked and in space', async ({ page }) => {
  await expect(page.getByTestId('menu-window')).toBeVisible();
  await expect(page.getByTestId('inventory')).toBeVisible();
  const initialMenu = await page.getByTestId('left-menu').boundingBox();
  expect(initialMenu.x).toBeLessThan(20);
  await page.getByTestId('menu-skills').click();
  await expect(page.getByTestId('hangar-skills')).toBeVisible();
  await expect(page.getByTestId('left-menu')).toBeVisible();
  await page.getByTestId('menu-killboard').click();
  await expect(page.getByTestId('combat-log')).toBeVisible();

  await undock(page);
  await page.evaluate(() => window.__eve.setDestination(600, 600));
  await page.waitForFunction(() => window.__eve.state && window.__eve.state.docked === false);
  await expect(page.getByTestId('left-menu')).toBeVisible();
  const spaceMenu = await page.getByTestId('left-menu').boundingBox();
  expect(spaceMenu.x).toBeCloseTo(initialMenu.x, 0);
  expect(spaceMenu.width).toBeCloseTo(initialMenu.width, 0);
  await expect(page.getByTestId('menu-fleet')).toBeDisabled();
  await expect(page.getByTestId('hangar')).toBeHidden();
  await page.getByTestId('menu-cargo').click();
  await expect(page.getByTestId('inventory')).toBeVisible();
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
  await expect(page.getByTestId('inventory')).toBeVisible();

  const mined = await getState(page);
  const mineral = Object.keys(mined.minerals).find((k) => mined.minerals[k] > 0);
  expect(mineral).toBeTruthy();
  const deposited = mined.minerals[mineral];

  // The hold is a grid of squares: select the ore stack, then deposit it all.
  await expect(page.getByTestId(`inv-cell-${mineral}`)).toBeVisible();
  await page.evaluate((k) => document.querySelector(`[data-testid="inv-cell-${k}"]`).click(), mineral);
  await expect(page.getByTestId('inv-grid')).toBeVisible();
  await page.evaluate((k) => document.querySelector(`[data-testid="inv-deposit-${k}-all"]`).click(), mineral);
  await expect(async () => {
    const s = await getState(page);
    expect(s.storage.minerals[mineral]).toBe(deposited);
    expect(s.minerals[mineral]).toBe(0);
  }).toPass({ timeout: 5000 });

  // Quantum storage is a separate menu page.
  await page.keyboard.press('q');
  await expect(page.getByTestId('storage-panel')).toBeVisible();
  await expect(page.getByTestId('inventory')).toBeHidden();
  const takeBtn = deposited >= 100 ? '100' : 'all';
  const taken = Math.min(100, deposited);
  await page.waitForSelector(`[data-testid="inv-withdraw-${mineral}-${takeBtn}"]`, { timeout: 5000 });
  await page.evaluate(({ k, btn }) => document.querySelector(`[data-testid="inv-withdraw-${k}-${btn}"]`).click(), { k: mineral, btn: takeBtn });
  await expect(async () => {
    const s = await getState(page);
    expect(s.storage.minerals[mineral]).toBe(deposited - taken);
    expect(s.minerals[mineral]).toBe(taken);
  }).toPass({ timeout: 5000 });

  // Mineral selling moved from the hangar Cargo tab to the cargo inventory.
  await page.keyboard.press('i');
  await expect(page.getByTestId('inventory')).toBeVisible();
  await expect(page.getByTestId(`inv-cell-${mineral}`)).toBeVisible();
  const sellAllButton = page.getByTestId(`inv-sell-${mineral}-all`);
  if (!(await sellAllButton.count())) {
    await page.getByTestId(`inv-cell-${mineral}`).click();
  }
  await expect(sellAllButton).toBeEnabled();
  const iskBefore = (await getState(page)).isk;
  await page.getByTestId(`inv-sell-${mineral}-all`).click();
  await expect(async () => {
    const s = await getState(page);
    expect(s.minerals[mineral]).toBe(0);
    expect(s.isk).toBeGreaterThan(iskBefore);
  }).toPass({ timeout: 5000 });
});

test('cargo loadout retains ship stats and the item grid', async ({ page }) => {
  await expect(page.getByTestId('inventory')).toBeVisible();
  const cells = await page.getByTestId('inv-grid').locator('.inv-cell').count();
  expect(cells).toBeGreaterThanOrEqual(24);
  await expect(page.getByTestId('inv-fitting')).toBeVisible();
  await expect(page.getByTestId('inv-ship-stats')).toContainText(/Mining/);
  await expect(page.getByTestId('inv-ship-stats')).toContainText(/Speed/);
  await expect(page.getByTestId('inv-ship-stats')).toContainText(/Shield/);
  await expect(page.getByTestId('inv-ship-stats')).toContainText(/Hull/);
  await expect(page.getByTestId('inv-fitting')).toContainText('Weapon');

  await page.keyboard.press('q');
  await expect(page.getByTestId('storage-panel')).toBeVisible();
  await expect(page.getByTestId('inventory')).toBeHidden();
  await page.keyboard.press('Escape');
  await expect(page.getByTestId('storage-panel')).toBeHidden();
});

test('reset returns to a fresh game', async ({ page }) => {
  // Buy a ship so the reset has something to undo.
  await page.getByTestId('menu-shipyard').click();
  await page.evaluate(() => document.querySelector('[data-testid="buy-falcon"]').click());
  await expect(async () => {
    const s = await getState(page);
    expect(s.ships.length).toBe(2);
  }).toPass({ timeout: 5000 });

  await page.request.post('/api/reset');
  await page.reload();
  await page.getByTestId('mode-demo').click();
  await expect(page.getByTestId('context-state')).toHaveText(/\S/, { timeout: 15000 });
  expect((await getState(page)).isk).toBe(10000);
  const s = await getState(page);
  expect(s.ships.length).toBe(1);
});

test('market: buy and fit a mining drone control module', async ({ page }) => {
  await page.getByTestId('menu-market').click();
  await expect(page.getByTestId('hangar')).toBeVisible();
  await page.getByTestId('buy-module-miningDrone-t1').click();
  await expect(async () => {
    const s = await getState(page);
    expect(s.loot).toHaveLength(1);
    expect(s.loot[0].slotType).toBe('miningDrone');
    expect(s.isk).toBe(8500); // 10000 - 1500
  }).toPass({ timeout: 5000 });
  const state = await getState(page);
  await page.getByTestId('menu-cargo').click();
  await page.getByTestId(`inv-cell-${state.loot[0].id}`).click();
  await page.getByTestId(`inv-equip-${state.loot[0].id}`).click();
  await expect(async () => {
    const s = await getState(page);
    expect(s.activeShip.fitting.miningDrone[0]).toBe(1);
  }).toPass({ timeout: 5000 });
});

test('industry: the hangar lists module blueprints craftable from ore', async ({ page }) => {
  await page.getByTestId('menu-industry').click();
  await expect(page.getByTestId('hangar')).toBeVisible();
  await expect(page.getByTestId('hangar-industry')).toBeVisible();
  // A weapon blueprint with a mineral recipe is listed (not craftable: no ore).
  await expect(page.getByTestId('craft-weapon-t1')).toBeVisible();
  await expect(page.getByTestId('craft-weapon-t1')).toBeDisabled();
});

test('auto-pilot modes are selected directly and the active mode toggles off', async ({ page }) => {
  // The ship starts docked at the home station with an empty hold.
  await undock(page);
  await page.getByTestId('auto-mine').click();
  await expect(page.getByTestId('auto-mine')).toHaveClass(/auto-mode-selected/);
  await expect(page.getByTestId('auto-mine-hunt')).not.toHaveClass(/auto-mode-selected/);
  await expect(page.getByTestId('auto-log')).toHaveCount(0);
  await expect(page.getByTestId('auto-log-panel')).toHaveCount(0);
  // Auto flies to the nearest belt, where it starts mining.
  await expect(page.getByTestId('context')).toContainText('Mining', { timeout: 30000 });
  await expect(page.getByTestId('context-state')).toContainText('Mining', { timeout: 5000 });
  await expect(page.getByTestId('context-log')).toContainText(/Mined \d+ ore/);
  await page.getByTestId('auto-mine-hunt').click();
  await expect(page.getByTestId('auto-mine-hunt')).toHaveClass(/auto-mode-selected/);
  await expect(page.getByTestId('auto-mine')).not.toHaveClass(/auto-mode-selected/);
  await page.getByTestId('auto-mine-hunt').click();
  await expect(page.getByTestId('auto-mine-hunt')).not.toHaveClass(/auto-mode-selected/);
});

test('mode menu: START boots the storyline with zero ISK, DEMO resumes the sandbox', async ({ page }) => {
  await page.request.post('/api/reset');
  await page.goto('/');
  await expect(page.getByTestId('mode-menu')).toBeVisible();
  await page.getByTestId('mode-story').click();
  await expect(page.getByTestId('context-state')).toHaveText(/\S/, { timeout: 15000 });
  let st = await getState(page);
  expect(st.mode).toBe('story');
  expect(st.isk).toBe(0);
  // Switching back to demo returns the 10k sandbox start.
  await page.reload();
  await page.getByTestId('mode-demo').click();
  await expect(page.getByTestId('context-state')).toHaveText(/\S/, { timeout: 15000 });
  st = await getState(page);
  expect(st.mode).toBe('demo');
  expect(st.isk).toBeGreaterThan(0);
});

// Play the whole storyline in one pass (m1â†’m8), asserting each mission's lesson
// as the course advances and ending at certification with the jump gates open.
// A single chain replaces five per-mission tests that each replayed the opening
// missions, so the browser suite covers the same ground in a fraction of the time.
test('storyline: pilot training from rookie to certification (m1â€“m8) unlocks the gates @slow', async ({ page }) => {
  test.setTimeout(420000);
  await page.request.post('/api/reset');
  await page.goto('/');
  await page.getByTestId('mode-story').click();
  await expect(page.getByTestId('context-state')).toHaveText(/\S/, { timeout: 15000 });

  // m1 â€” Under Attack: the handed-out weapon beats the attacker.
  await expect(page.getByTestId('mission-tracker')).toContainText('Under Attack');
  await expect(page.getByTestId('mission-dialogue')).toBeVisible();
  await page.getByTestId('mission-continue').click();
  await expect(page.getByTestId('mission-dialogue')).toBeHidden();
  await killMissionEnemy(page, 'attacker');

  // m2 â€” Help the Buddies: three short-range frigates; the first fight shows the
  // free-fire window the Range Amplifier grants.
  await expect(page.getByTestId('mission-tracker')).toContainText('Help the Buddies');
  const frigates = (await getState(page)).world.enemies.filter((e) => e.missionTag === 'shortrange' && e.alive);
  expect(frigates.length).toBe(3);
  await killMissionEnemy(page, 'shortrange', true);
  await killMissionEnemy(page, 'shortrange');
  await killMissionEnemy(page, 'shortrange');

  // m3 â€” Last Stand: the unwinnable wave destroys the ship (scripted death).
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

  // m4 â€” A New Clone: dock at the station, which hands off to m5.
  await expect(page.getByTestId('mission-tracker')).toContainText('A New Clone');
  await warpUntil(page, (await getState(page)).world.stations[0].id, (s) => s.mission.active === 'm5');

  // m5 â€” Mining 101: warp to a belt and mine 40 ore.
  await expect(page.getByTestId('mission-tracker')).toContainText('Mining 101');
  await warpUntil(page, (await getState(page)).world.belts[0].id, (s) => s.mission.active === 'm6');

  // m6 â€” Rogue Drones: destroy the drone hub and earn a mining drone.
  await killMissionEnemy(page, 'dronhub');
  await expect(async () => {
    const s = await getState(page);
    expect(s.mission.active).toBe('m7');
  }).toPass({ timeout: 45000 });
  const afterM6 = await getState(page);
  expect(afterM6.activeShip.fitting.miningDrone[0]).toBe(1);

  // m7 â€” The Forge: mine the ore both recipes need, dock, and craft them.
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
  await page.getByTestId('menu-industry').click();
  await expect(page.getByTestId('hangar-industry')).toBeVisible();
  await page.getByTestId('craft-weapon-t1').click();
  await page.getByTestId('craft-shield-t2').click();

  // m8 â€” Certification: accept it and the jump gates unlock.
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

// Warp to a POI and wait until `done(state)` is true â€” used for handoffs that
// complete automatically once you arrive (docking, mission progression).
async function warpUntil(page, targetId, done) {
  await page.evaluate((id) => window.__eve.warp(id), targetId);
  await expect(async () => {
    const s = await getState(page);
    expect(done(s)).toBe(true);
  }).toPass({ timeout: 45000 });
  // Docking plays a fly-in + fade; let it finish before the next scripted move.
  if ((await getState(page)).world.stations.some((st) => st.id === targetId)) {
    await expect(page.getByTestId('hangar')).toBeVisible({ timeout: 10000 });
  }
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
