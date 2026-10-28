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

async function manualMine(page) {
  const responsePromise = page.waitForResponse((response) =>
    response.url().endsWith('/api/mine') && response.request().method() === 'POST'
  );
  await page.keyboard.press('m');
  const response = await responsePromise;
  expect(response.ok(), await response.text()).toBe(true);
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
    expect(s.nearby.enemyId).toBe(e.id);
  }).toPass({ timeout: 30000 });
  await expect(page.getByTestId('engage-btn')).toBeVisible();
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

  expect((await getState(page)).isk).toBeUndefined();
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

test('offline report is modal above game UI and blocks game actions until continued', async ({ page }) => {
  await page.evaluate(() => window.__eve.showOfflineReport({
    elapsedSeconds: 7200,
    capped: true,
    mined: 42,
    skillPoints: 1800,
  }));

  const report = page.getByTestId('offline-report');
  await expect(report).toBeVisible();
  expect(await report.evaluate((dialog) => dialog.matches(':modal'))).toBe(true);
  await expect(page.getByTestId('offline-report-close')).toBeFocused();

  await page.keyboard.press('Escape');
  await expect(report).toBeVisible();
  await page.keyboard.press('i');
  await expect(page.getByTestId('menu-window')).toBeVisible();

  await page.getByTestId('offline-report-close').click();
  await expect(report).toBeHidden();
});

test('space status bars persist, docked status is hidden, and shortcuts are labeled', async ({ page }) => {
  await expect(page.getByTestId('ship-status')).toBeHidden();
  await expect(page.locator('#controls-hint')).toHaveCount(0);
  await expect(page.getByTestId('auto-mine')).toHaveAttribute('data-shortcut', 'A');
  await expect(page.getByTestId('navigate-belt')).toHaveAttribute('data-shortcut', 'B');
  await expect(page.getByTestId('navigate-station')).toHaveAttribute('data-shortcut', 'S');
  await expect(page.getByTestId('navigate-rat')).toHaveAttribute('data-shortcut', 'R');
  await expect(page.getByTestId('engage-btn')).toHaveAttribute('data-shortcut', 'E');
  await expect(page.getByTestId('mine-btn')).toHaveAttribute('data-shortcut', 'M');
  await expect(page.getByTestId('gate-jump')).toHaveAttribute('data-shortcut', 'J');
  await expect(page.getByTestId('menu-pilot')).toHaveCount(0);
  await expect(page.getByTestId('menu-cargo')).toHaveAttribute('data-shortcut', 'I');

  await undock(page);
  await expect(page.getByTestId('context-state')).toHaveText(/\S/);
  await expect(page.getByTestId('status-shield-value')).toContainText('/');
  await expect(page.getByTestId('status-hull-value')).toContainText('/');
  await expect(page.getByTestId('status-speed-value')).toContainText('m/s');
  for (const name of ['speed', 'shield', 'hull']) {
    const geometry = await page.getByTestId(`status-${name}`).evaluate((element) => {
      const label = element.querySelector('.status-label').getBoundingClientRect();
      const bar = element.querySelector('.status-track').getBoundingClientRect();
      const value = element.querySelector('.status-value').getBoundingClientRect();
      const labelCenter = label.top + label.height / 2;
      return {
        sameLine: Math.abs(labelCenter - bar.top - bar.height / 2) < 3 &&
          Math.abs(labelCenter - value.top - value.height / 2) < 3,
        order: label.left < bar.left && bar.right < value.left,
      };
    });
    expect(geometry).toEqual({ sameLine: true, order: true });
  }

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
  await expect(page.getByTestId('engage-btn')).toBeHidden();
  for (const testId of ['navigate-belt', 'navigate-station', 'navigate-rat', 'mine-btn', 'auto-mine', 'auto-mine-hunt', 'auto-hunt']) {
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
  expect(layout.status.height).toBeLessThan(65);
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
  expect(mobileLayout.status.height).toBeLessThan(55);
  expect(mobileLayout.status.y + mobileLayout.status.height).toBeLessThan(mobileLayout.actions.y);
  expect(mobileLayout.menu.x + mobileLayout.menu.width).toBeLessThan(mobileLayout.status.x);
  await page.setViewportSize({ width: 1280, height: 720 });

  await expect(page.getByTestId('navigate-toggle')).toHaveCount(0);
  await expect(page.getByTestId('menu-cargo')).toHaveText('Cargo');
  await expect(page.getByTestId('menu-pilot')).toHaveCount(0);
  await expect(page.getByTestId('menu-achievements')).toHaveText('Achieve');
  await expect(page.locator('.menu-icon, .menu-copy small')).toHaveCount(0);
  await expect(page.getByTestId('menu-ship-tree')).toBeVisible();
  await expect(page.getByTestId('menu-ship-tree')).toBeEnabled();
  await expect(page.getByTestId('menu-fitting')).toBeEnabled();
  await expect(page.getByTestId('menu-market')).toBeEnabled();
  await expect(page.locator('#left-menu h2')).toHaveText('Menus');

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
  await expect(page.getByTestId('minimap')).toBeHidden();
  await expect(page.getByTestId('overview-toggle')).toHaveText('V');
});

test('cargo shows the hold alone and fitting is a separate ship menu', async ({ page }) => {
  await expect(page.getByTestId('menu-cargo')).toBeVisible();
  await expect(page.getByTestId('menu-fitting')).toBeVisible();
  await expect(page.getByTestId('menu-fitting')).toBeEnabled();
  await expect(page.getByTestId('menu-window')).toBeVisible();
  await expect(page.getByTestId('inventory')).toBeVisible();
  await expect(page.getByTestId('inventory')).toHaveAttribute('data-menu-page', 'cargo');
  await expect(page.locator('.menu-window .panel-header')).toHaveCount(0);
  await expect(page.getByTestId('menu-window-close')).toHaveCount(0);
  const cargoBackgrounds = await page.evaluate(() => ({
    workspace: getComputedStyle(document.getElementById('menu-window')).backgroundColor,
    cargo: getComputedStyle(document.querySelector('.inventory-column')).backgroundColor,
  }));
  expect(cargoBackgrounds.workspace).toBe('rgba(0, 0, 0, 0)');
  expect(cargoBackgrounds.cargo).not.toBe('rgba(0, 0, 0, 0)');
  await expect.poll(() => page.getByTestId('cargo-layout').evaluate((element) =>
    getComputedStyle(element).gridTemplateColumns.split(' ').length
  )).toBe(1);
  await expect(page.getByTestId('inv-fitting')).toBeHidden();
  await expect(page.getByTestId('inv-grid')).toBeVisible();
  await expect(page.getByTestId('inv-deposit-filtered')).toHaveText('Store filtered');
  const capacity = page.getByTestId('cargo-capacity');
  await expect(capacity).toHaveAttribute('role', 'progressbar');
  const controls = await page.getByTestId('inventory-column').evaluate((column) => {
    const row = column.querySelector('.cargo-controls');
    const filters = row.querySelector('.cargo-filters');
    const store = row.querySelector('[data-testid="inv-deposit-filtered"]');
    return {
      sameRow: filters.parentElement === row && store.parentElement === row,
      storeOnRight: store.getBoundingClientRect().left > filters.getBoundingClientRect().left,
    };
  });
  expect(controls).toEqual({ sameRow: true, storeOnRight: true });
  await expect(capacity).toHaveAttribute('aria-valuenow', '0');
  await page.evaluate(() => {
    window.__eve.state.cargoUsed = 250;
    window.__eve.state.cargoCapacity = 1000;
    document.querySelector('[data-cargo-filter="ore"]').click();
  });
  await expect(capacity).toHaveAttribute('aria-valuenow', '25');
  await expect(page.locator('#inv-cargo-capacity-fill')).toHaveAttribute('style', 'width: 25%;');
  await page.getByTestId('cargo-filter-loot').click();
  await expect(page.getByTestId('cargo-filter-loot')).toHaveClass(/active/);
  await page.getByTestId('menu-fitting').click();
  await expect(page.getByTestId('fitting-layout')).toBeVisible();
  await expect(page.getByTestId('inv-fitting')).toBeVisible();
  await expect(page.getByTestId('fitting-items')).toBeVisible();
  await expect(page.getByTestId('fit-slot-weapon-0')).toBeVisible();
  await page.getByTestId('menu-fitting').click();
  await expect(page.getByTestId('fitting-layout')).toBeHidden();
  await page.getByTestId('menu-cargo').click();
  await expect(page.getByTestId('storage-panel')).toBeVisible();
  await expect(page.getByTestId('cargo-tab')).toHaveCount(0);
  await expect(page.getByTestId('inventory')).toBeVisible();
  await expect(page.getByTestId('menu-pilot')).toHaveCount(0);
  await expect(page.getByTestId('menu-killboard')).toHaveCount(0);
  await expect(page.locator('[data-panel="killboard"]')).toHaveCount(0);
});

test('station services stay visible as read-only menus while undocked', async ({ page }) => {
  for (const menu of ['fitting', 'ship-tree', 'skills', 'achievements', 'market', 'missions']) {
    await expect(page.getByTestId(`menu-${menu}`)).toBeEnabled();
  }
  await page.getByTestId('menu-market').click();
  await expect(page.getByTestId('hangar')).toBeVisible();
  await undock(page);
  await expect(page.getByTestId('service-readonly-notice')).toBeVisible();
  await expect(page.getByTestId('market-layout')).toBeVisible();
  const serviceActions = page.locator('#hangar button[data-action]');
  await expect.poll(() => serviceActions.evaluateAll((buttons) =>
    buttons.length > 0 && buttons.every((button) => button.disabled)
  )).toBe(true);
  await page.getByTestId('menu-missions').click();
  await expect(page.getByTestId('hangar-agent-missions')).toBeVisible();
  await expect(page.getByTestId('service-readonly-notice')).toBeVisible();
});

test('station agents offer concurrent contracts with independent progress', async ({ page }) => {
  await page.getByTestId('menu-missions').click();
  await expect(page.getByTestId('agent-card-security')).toBeVisible();
  await expect(page.getByTestId('agent-card-mining')).toBeVisible();
  await expect(page.getByTestId('agent-card-industry')).toBeVisible();
  await page.getByTestId('accept-agent-mission-security').click();
  await page.getByTestId('accept-agent-mission-mining').click();
  await expect(async () => {
    const state = await getState(page);
    expect(state.agentMission.active).toHaveLength(2);
  }).toPass({ timeout: 5000 });
  await expect(page.getByTestId('cancel-agent-mission-security')).toBeVisible();
  await expect(page.getByTestId('cancel-agent-mission-mining')).toBeVisible();
});

test('inventory stacks ore and expands to fit more items without an inner scrollbar', async ({ page }) => {
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
      cellWidth: grid.querySelector('.inv-cell').getBoundingClientRect().width,
      cellHeight: grid.querySelector('.inv-cell').getBoundingClientRect().height,
      scrollable: grid.scrollHeight > grid.clientHeight,
      overflowY: getComputedStyle(grid).overflowY,
    };
  });
  expect(metrics.count).toBeGreaterThanOrEqual(100);
  expect(metrics.cellWidth).toBeLessThanOrEqual(52);
  expect(metrics.cellHeight).toBeLessThanOrEqual(52);
  expect(metrics.scrollable).toBe(false);
  expect(metrics.overflowY).toBe('visible');
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
  await expect(page.getByTestId('gate-jump')).toHaveAttribute('data-shortcut', 'J');
  await page.keyboard.press('j');
  await expect(async () => {
    const s = await getState(page);
    expect(s.system.id).toBe(gate.targetSystemId);
  }).toPass({ timeout: 5000 });
});

test('manual mining: fly to an asteroid, press M, and cargo grows', async ({ page }) => {
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

  await expect(page.getByTestId('context-state')).toContainText('Ore in range', { timeout: 30000 });
  await expect(page.getByTestId('context-detail')).toContainText(/Cargo \d+\/\d+/);
  await expect(page.getByTestId('mine-btn')).toBeEnabled();

  await manualMine(page);
  await expect(async () => {
    const s = await getState(page);
    const total = Object.values(s.minerals).reduce((a, b) => a + b, 0);
    expect(total).toBeGreaterThan(0);
  }).toPass({ timeout: 30000 });
});

test('belt mining grows cargo and auto-recalls on a full hold @slow', async ({ page }) => {
  await undock(page);
  await page.getByTestId('auto-mine').click();
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

  await expect(page.getByTestId('engage-btn')).toBeVisible();
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

test('in-fight actions: boost costs scrap, disengage bails out and keeps the ship', async ({ page }) => {
  // Boost and overload consume one scrap from the cargo hold; the demo save
  // starts with scrap in quantum storage, so withdraw a unit before undocking.
  const withdrawn = await page.request.post('/api/withdraw', { mineral: 'scrap', amount: 1 });
  expect(withdrawn.ok(), await withdrawn.text()).toBe(true);
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

  await expect(page.getByTestId('engage-btn')).toBeVisible();
  await page.getByTestId('engage-btn').click();
  await expect(page.getByTestId('combat-banner')).toBeVisible({ timeout: 5000 });

  // The in-fight action buttons appear in the combat HUD.
  await expect(page.getByTestId('act-boost')).toBeVisible();
  await expect(page.getByTestId('act-overload')).toBeVisible();
  await expect(page.getByTestId('act-disengage')).toBeVisible();

  // Boosting the shield costs one scrap. (The HUD re-renders every frame, so
  // click via evaluate to avoid Playwright's element-stability wait.)
  const scrapBefore = (await getState(page)).materials.scrap;
  await page.evaluate(() => document.querySelector('[data-testid="act-boost"]').click());
  await expect(page.getByTestId('context-log')).toContainText('Shield boosted');
  await expect(page.getByTestId('toast')).toHaveCount(0);
  await expect(async () => {
    const s = await getState(page);
    expect(s.materials.scrap).toBeLessThan(scrapBefore);
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

test('fitting lists equippable modules and ship loadout unequips all', async ({ page }) => {
  await page.getByTestId('menu-fitting').click();
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
  const blueprintId = (await getState(page)).blueprints[0].id;
  await page.getByTestId('menu-cargo').click();
  await page.getByTestId('cargo-filter-blueprints').click();
  await page.getByTestId(`inv-cell-${blueprintId}`).click();
  await page.getByTestId(`inv-store-blueprint-${blueprintId}`).click();
  await expect(async () => {
    const state = await getState(page);
    expect(state.storage.blueprints.some((item) => item.id === blueprintId)).toBe(true);
  }).toPass({ timeout: 5000 });
  await page.getByTestId(`inv-storage-cell-${blueprintId}`).click();
  await expect(page.getByTestId(`inv-crafting-panel-${blueprintId}`)).toBeVisible();
  await expect(page.getByTestId(`inv-storage-detail`)).toContainText('Crafting');
  await expect(page.getByTestId(`craft-blueprint-${blueprintId}`)).toBeEnabled();
  await page.getByTestId(`craft-blueprint-${blueprintId}`).click();
  await expect(async () => {
    const state = await getState(page);
    expect(state.loot).toHaveLength(1);
    expect(state.loot[0].slotType).toBe('weapon');
  }).toPass({ timeout: 5000 });
  const lootId = (await getState(page)).loot[0].id;
  await page.getByTestId('cargo-filter-loot').click();
  await page.getByTestId(`inv-cell-${lootId}`).click();
  await page.getByTestId(`inv-store-loot-${lootId}`).click();
  await expect(async () => {
    const state = await getState(page);
    expect(state.storage.loot.some((item) => item.id === lootId)).toBe(true);
  }).toPass({ timeout: 5000 });
  await page.getByTestId('menu-fitting').click();
  await expect(page.locator(`[data-testid="fitting-retrieve-${lootId}"]`)).toHaveCount(0);
  await page.getByTestId('menu-cargo').click();
  await page.getByTestId(`inv-storage-cell-${lootId}`).click();
  await expect(page.getByTestId(`storage-equip-loot-${lootId}`)).toBeEnabled();
  await expect(page.getByTestId(`storage-salvage-loot-${lootId}`)).toBeEnabled();
  await page.getByTestId(`storage-equip-loot-${lootId}`).click();
  await expect(async () => {
    const state = await getState(page);
    expect(state.activeShip.fitting.weapon[0]).toBe(1);
    expect(state.storage.loot).toHaveLength(0);
  }).toPass({ timeout: 5000 });
  await page.getByTestId('menu-fitting').click();
  await expect(page.getByTestId('fit-slot-weapon-0')).toContainText('Tier I');
  await page.getByTestId('unequip-all').click();
  await expect(async () => {
    const state = await getState(page);
    expect(state.activeShip.fitting.weapon[0]).toBe(0);
    expect(state.loot).toHaveLength(1);
    expect(state.loot[0].slotType).toBe('weapon');
  }).toPass({ timeout: 5000 });
  await page.getByTestId('menu-cargo').click();
  await page.getByTestId('cargo-filter-loot').click();
  const cargoLootId = (await getState(page)).loot[0].id;
  await page.getByTestId(`inv-cell-${cargoLootId}`).click();
  await expect(page.getByTestId(`inv-equip-loot-${cargoLootId}`)).toBeEnabled();
  await page.getByTestId(`inv-equip-loot-${cargoLootId}`).dispatchEvent('click');
  await expect(async () => {
    const state = await getState(page);
    expect(state.activeShip.fitting.weapon[0]).toBe(1);
    expect(state.loot).toHaveLength(0);
  }).toPass({ timeout: 5000 });
  await page.getByTestId('menu-fitting').click();
  await page.getByTestId('unequip-all').click();
  await expect(async () => {
    const state = await getState(page);
    expect(state.loot).toHaveLength(1);
  }).toPass({ timeout: 5000 });
  await page.getByTestId('menu-cargo').click();
  await page.getByTestId('cargo-filter-loot').click();
  const salvagedLootId = (await getState(page)).loot[0].id;
  await page.getByTestId(`inv-cell-${salvagedLootId}`).click();
  await page.getByTestId(`inv-store-loot-${salvagedLootId}`).click();
  await page.getByTestId(`inv-storage-cell-${salvagedLootId}`).click();
  await expect(page.getByTestId(`storage-salvage-loot-${salvagedLootId}`)).toBeEnabled();
  await page.getByTestId(`storage-salvage-loot-${salvagedLootId}`).dispatchEvent('click');
  await expect(async () => {
    const state = await getState(page);
    expect(state.storage.loot).toHaveLength(0);
    expect(state.storage.items.scrap).toBeGreaterThan(0);
  }).toPass({ timeout: 5000 });
});

test('skills: the hangar shows the skill tree and SP', async ({ page }) => {
  await page.getByTestId('menu-skills').click();
  await expect(page.getByTestId('hangar-skills')).toBeVisible();
  // A fresh account has no skill points, so training is unavailable.
  await expect(page.getByTestId('hangar-sp')).toContainText('0 SP');
  await expect(page.getByTestId('skill-gunnery')).toBeDisabled();
});

test('mission and achievement completions show temporary celebration toasts', async ({ page }) => {
  await page.evaluate(() => {
    const previous = window.__eve.state;
    previous.mission = { ...previous.mission, active: 'm1', title: 'Under Attack', completed: [] };
    const next = structuredClone(previous);
    next.mission = { ...next.mission, active: 'm2', title: 'Help the Buddies', completed: ['m1'] };
    next.agentMission = {
      ...next.agentMission,
      completed: [{ id: 'agent-test:1', name: 'Pirate Hunt', agentName: 'Ari Venn' }],
    };
    next.achievements[0].unlocked = true;
    window.__eve.applyServerState(next);
  });
  const toasts = page.getByTestId('celebration-toast');
  await expect(toasts).toHaveCount(3);
  await expect(page.getByTestId('celebration-toast-label')).toHaveText([
    'Achievement Unlocked',
    'Mission Complete',
    'Mission Complete',
  ]);
  await expect(page.getByTestId('celebration-toast-title')).toHaveText([
    'Prospector',
    'Under Attack',
    'Pirate Hunt',
  ]);
  await expect(toasts).toHaveCount(0, { timeout: 5000 });
});

test('ship tree replaces fleet and crafting services', async ({ page }) => {
  await expect(page.getByTestId('left-menu').locator('.menu-card')).toHaveCount(7);
  await expect(page.getByTestId('menu-ship-tree')).toBeVisible();
  await expect(page.getByTestId('menu-ship-tree')).toBeEnabled();
  await expect(page.getByTestId('menu-fleet')).toHaveCount(0);
  await expect(page.getByTestId('menu-storage')).toHaveCount(0);
  await expect(page.getByTestId('menu-shipyard')).toHaveCount(0);
  await expect(page.getByTestId('menu-industry')).toHaveCount(0);
  await page.getByTestId('menu-ship-tree').click();
  await expect(page.getByTestId('hangar')).toBeVisible();
  await expect(page.getByTestId('hangar-ship-tree')).toBeVisible();
  await expect(page.locator('.hangar-header')).toHaveCount(0);
  await expect(page.locator('.hangar-body section[data-panel="ship-tree"] > h3')).toBeHidden();
  const treePanelBackground = await page.locator('.hangar-body section[data-panel="ship-tree"]').evaluate((element) =>
    getComputedStyle(element).backgroundColor
  );
  expect(treePanelBackground).not.toBe('rgba(0, 0, 0, 0)');
  await expect(page.getByTestId('hangar-ship-tree').locator('.ship-tree-entry')).toHaveCount(Object.keys(cfg.SHIPS).length);
  await expect(page.getByTestId('hangar-ship-tree').locator('.ship-tree-model svg')).toHaveCount(Object.keys(cfg.SHIPS).length);
  await expect(page.getByTestId('ship-tree-arrow-1-2')).toBeVisible();
  await expect(page.getByTestId('ship-tree-arrow-3-4')).toBeVisible();
  await expect(page.getByTestId('ship-tree-falcon')).toContainText('Requires Mining Yield 1');
  await expect(page.getByTestId('ship-tree-falcon')).toHaveClass(/skills-locked/);
  await expect(page.getByTestId('ship-tree-rifter')).toHaveClass(/skill-ready/);
  await page.getByTestId('ship-tree-rifter').hover();
  await expect(page.getByTestId('ship-tree-rifter')).toHaveCSS('transform', 'none');
});

test('NPC market sells basic module blueprints only', async ({ page }) => {
  await page.getByTestId('menu-market').click();
  await expect(page.getByTestId('buy-blueprint-weapon-t1')).toBeVisible();
  await expect(page.getByTestId('buy-blueprint-weapon-t2')).toHaveCount(0);
  await expect(page.getByTestId('buy-blueprint-ship-falcon')).toHaveCount(0);
});

test('station services overlay a blurred world capture and launching returns to space', async ({ page }) => {
  await expect(page.getByTestId('station-view')).toBeVisible();
  await expect(page.getByTestId('station-view-name')).toContainText('Station A');
  await page.getByTestId('menu-ship-tree').click();
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
  await expect(page.getByTestId('menu-ship-tree')).toBeVisible();

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

test('skill points remain available and the unused Killboard is removed', async ({ page }) => {
  await expect(page.getByTestId('isk')).toHaveCount(0);
  await page.getByTestId('menu-skills').click();
  await expect(page.getByTestId('hangar-sp')).toContainText('SP');
  await expect(page.getByTestId('menu-killboard')).toHaveCount(0);
  await expect(page.getByTestId('combat-log')).toHaveCount(0);
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
  await expect(page.getByTestId('menu-killboard')).toHaveCount(0);

  await undock(page);
  await page.evaluate(() => window.__eve.setDestination(600, 600));
  await page.waitForFunction(() => window.__eve.state && window.__eve.state.docked === false);
  await expect(page.getByTestId('left-menu')).toBeVisible();
  const spaceMenu = await page.getByTestId('left-menu').boundingBox();
  expect(spaceMenu.x).toBeCloseTo(initialMenu.x, 0);
  expect(spaceMenu.width).toBeCloseTo(initialMenu.width, 0);
  await expect(page.getByTestId('menu-ship-tree')).toBeDisabled();
  await expect(page.getByTestId('hangar')).toBeHidden();
  await page.getByTestId('menu-cargo').click();
  await expect(page.getByTestId('inventory')).toBeVisible();
});

test('inventory: deposit mined cargo into quantum storage and withdraw it back', async ({ page }) => {
  // Mine a bit of ore so the hold has something to deposit.
  const st = await getState(page);
  const ast = st.world.asteroids.find((a) => a.amount > 0);
  await page.evaluate(([x, y]) => window.__eve.warp(null, { x, y }), [ast.x, ast.y]);
  await expect(page.getByTestId('mine-btn')).toBeEnabled();
  await manualMine(page);
  await expect(async () => {
    const s = await getState(page);
    expect(Object.values(s.minerals).reduce((a, b) => a + b, 0)).toBeGreaterThanOrEqual(1);
  }).toPass({ timeout: 15000 });

  // Dock again and open the inventory.
  await page.evaluate((id) => window.__eve.warp(id), st.world.stations[0].id);
  await page.waitForFunction(() => window.__eve.state && window.__eve.state.docked === true);
  await expect(page.getByTestId('inventory')).toBeVisible();

  const mined = await getState(page);
  const mineral = Object.keys(mined.minerals).find((k) => mined.minerals[k] > 0);
  expect(mineral).toBeTruthy();
  const deposited = mined.minerals[mineral];
  const storedBefore = mined.storage.items[mineral] || 0;
  const storedAfterDeposit = storedBefore + deposited;

  // The hold is a grid of squares: select the ore stack, then deposit it all.
  await page.getByTestId('cargo-filter-all').click();
  await expect(page.getByTestId(`inv-cell-${mineral}`)).toBeVisible();
  await page.evaluate((k) => document.querySelector(`[data-testid="inv-cell-${k}"]`).click(), mineral);
  await expect(page.getByTestId('inv-grid')).toBeVisible();
  await page.evaluate((k) => document.querySelector(`[data-testid="inv-deposit-${k}-all"]`).click(), mineral);
  await expect(async () => {
    const s = await getState(page);
    expect(s.storage.items[mineral]).toBe(storedAfterDeposit);
    expect(s.minerals[mineral]).toBe(0);
  }).toPass({ timeout: 5000 });

  // Quantum Storage is always shown below Cargo.
  await expect(page.getByTestId('storage-panel')).toBeVisible();
  await expect(page.getByTestId('inventory')).toBeVisible();
  await page.getByTestId(`inv-storage-cell-${mineral}`).click();
  const takeBtn = deposited >= 100 ? '100' : 'all';
  const taken = takeBtn === '100' ? Math.min(100, storedAfterDeposit) : storedAfterDeposit;
  await page.waitForSelector(`[data-testid="inv-withdraw-${mineral}-${takeBtn}"]`, { timeout: 5000 });
  await page.evaluate(({ k, btn }) => document.querySelector(`[data-testid="inv-withdraw-${k}-${btn}"]`).click(), { k: mineral, btn: takeBtn });
  await expect(async () => {
    const s = await getState(page);
    expect(s.storage.items[mineral]).toBe(storedAfterDeposit - taken);
    expect(s.minerals[mineral]).toBe(taken);
  }).toPass({ timeout: 5000 });

  await undock(page);
  await page.getByTestId('menu-cargo').click();
  await expect(page.getByTestId('storage-panel')).toBeVisible();
  await expect(page.getByTestId('storage-readonly-note')).toBeVisible();
  await expect(page.getByTestId('inv-storage-detail')).toContainText('Select an item to view its details');
  await expect(page.getByTestId(`inv-withdraw-${mineral}-all`)).toHaveCount(0);
});

test('quantum storage items remain viewable but read-only while undocked', async ({ page }) => {
  await undock(page);
  await page.evaluate(() => {
    const state = window.__eve.state;
    state.storage.items.iron = 42;
    window.__eve.applyServerState(state);
  });
  await page.getByTestId('menu-cargo').click();

  await expect(page.getByTestId('storage-panel')).toBeVisible();
  await expect(page.getByTestId('storage-readonly-note')).toBeVisible();
  const storedOre = page.getByTestId('inv-storage-cell-iron');
  await expect(storedOre).toBeVisible();
  await expect(storedOre).toHaveAttribute('title', /Iron.*Quantum Storage.*Select/);
  await storedOre.click();
  await expect(page.getByTestId('inv-storage-detail')).toContainText(/Iron/);
  await expect(page.getByTestId('inv-withdraw-iron-all')).toHaveCount(0);
});

test('cargo contains items while fitting retains ship stats and loadout', async ({ page }) => {
  await expect(page.getByTestId('inventory')).toBeVisible();
  const cells = await page.getByTestId('inv-grid').locator('.inv-cell').count();
  expect(cells).toBeGreaterThanOrEqual(24);
  await expect(page.getByTestId('inv-fitting')).toBeHidden();
  await page.getByTestId('menu-fitting').click();
  await expect(page.getByTestId('inv-fitting')).toBeVisible();
  await expect(page.getByTestId('inv-ship-stats')).toContainText(/Mining/);
  await expect(page.getByTestId('inv-ship-stats')).toContainText(/Speed/);
  await expect(page.getByTestId('inv-ship-stats')).toContainText(/Shield/);
  await expect(page.getByTestId('inv-ship-stats')).toContainText(/Hull/);
  await expect(page.getByTestId('inv-fitting')).toContainText('Weapon');
  const fittingBackgrounds = await page.locator('.hangar-body > section[data-panel="fitting"]').evaluate((panel) => ({
    panel: getComputedStyle(panel).backgroundColor,
    subpanel: getComputedStyle(panel.querySelector('.cargo-column')).backgroundColor,
  }));
  expect(fittingBackgrounds.panel).toBe('rgba(0, 0, 0, 0)');
  expect(fittingBackgrounds.subpanel).not.toBe('rgba(0, 0, 0, 0)');
  const fittingColumns = await page.getByTestId('fitting-layout').evaluate((layout) => {
    const bounds = (selector) => {
      const { x, width } = layout.querySelector(selector).getBoundingClientRect();
      return { x, width };
    };
    return {
      fitted: bounds('[data-testid="fitting-column"]'),
      available: bounds('[data-testid="fitting-items-column"]'),
      ship: bounds('[data-testid="ship-loadout"]'),
      slotHeight: parseFloat(getComputedStyle(layout.querySelector('.loadout-slot')).minHeight),
    };
  });
  expect(fittingColumns.ship.x).toBeGreaterThan(fittingColumns.available.x);
  expect(fittingColumns.ship.width).toBeLessThan(fittingColumns.fitted.width);
  expect(fittingColumns.slotHeight).toBeLessThanOrEqual(27);

  await expect(page.getByTestId('storage-panel')).toBeHidden();
  await page.keyboard.press('Escape');
  await expect(page.getByTestId('storage-panel')).toBeHidden();
});

test('reset returns to a fresh game', async ({ page }) => {
  // Acquire a blueprint so the reset has progression to undo.
  await page.getByTestId('menu-market').click();
  await page.getByTestId('buy-blueprint-weapon-t1').click();
  await expect(async () => {
    const s = await getState(page);
    expect(s.blueprints).toHaveLength(1);
  }).toPass({ timeout: 5000 });

  await page.request.post('/api/reset');
  await page.reload();
  await page.getByTestId('mode-demo').click();
  await expect(page.getByTestId('context-state')).toHaveText(/\S/, { timeout: 15000 });
  const s = await getState(page);
  expect(s.ships.length).toBe(1);
  expect(s.blueprints).toHaveLength(0);
});

test('market: buy and fit a mining drone control module', async ({ page }) => {
  await page.getByTestId('menu-market').click();
  await expect(page.getByTestId('hangar')).toBeVisible();
  await expect(page.getByTestId('market-layout')).toBeVisible();
  const marketBackgrounds = await page.locator('.hangar-body > section[data-panel="market"]').evaluate((panel) => ({
    panel: getComputedStyle(panel).backgroundColor,
    subpanel: getComputedStyle(panel.querySelector('.market-column')).backgroundColor,
  }));
  expect(marketBackgrounds.panel).toBe('rgba(0, 0, 0, 0)');
  expect(marketBackgrounds.subpanel).not.toBe('rgba(0, 0, 0, 0)');
  await expect(page.getByTestId('market-blueprints')).toBeVisible();
  await expect(page.getByTestId('market-trade-up')).toBeVisible();
  await expect.poll(() => page.getByTestId('market-layout').evaluate((element) =>
    getComputedStyle(element).gridTemplateColumns.split(' ').length
  )).toBe(2);
  const purchaseRow = page.getByTestId('market-blueprint-miningDrone-t1');
  const purchaseButton = page.getByTestId('buy-blueprint-miningDrone-t1');
  const otherPurchaseButton = page.getByTestId('buy-blueprint-weapon-t1');
  await expect(otherPurchaseButton).toBeEnabled();
  await purchaseButton.click();
  await expect(purchaseRow).toHaveClass(/market-purchase-flash/);
  await expect(purchaseButton).toBeDisabled();
  await expect(otherPurchaseButton).toBeEnabled();
  await expect(async () => {
    const s = await getState(page);
    expect(s.blueprints.some((blueprint) => blueprint.type === 'miningDrone' && blueprint.tier === 1)).toBe(true);
  }).toPass({ timeout: 5000 });
  await expect(purchaseRow).not.toHaveClass(/market-purchase-flash/, { timeout: 2000 });
  await expect(purchaseButton).toBeEnabled();
  const blueprint = (await getState(page)).blueprints.find((item) => item.type === 'miningDrone');
  await page.getByTestId('menu-cargo').click();
  await page.getByTestId('cargo-filter-blueprints').click();
  await page.getByTestId(`inv-cell-${blueprint.id}`).click();
  await expect(page.getByTestId(`inv-crafting-panel-${blueprint.id}`)).toBeVisible();
  await page.getByTestId(`craft-blueprint-${blueprint.id}`).click();
  await expect(async () => {
    const s = await getState(page);
    expect(s.loot).toHaveLength(1);
    expect(s.loot[0].slotType).toBe('miningDrone');
  }).toPass({ timeout: 5000 });
  const state = await getState(page);
  await page.getByTestId('menu-fitting').click();
  await page.getByTestId(`fitting-equip-${state.loot[0].id}`).click();
  await expect(async () => {
    const s = await getState(page);
    expect(s.activeShip.fitting.miningDrone[0]).toBe(1);
  }).toPass({ timeout: 5000 });
});

test('cargo shows crafting actions only for owned blueprints', async ({ page }) => {
  await page.getByTestId('cargo-filter-blueprints').click();
  await expect(page.getByTestId('inv-detail')).toContainText('Select an item');
  await expect(page.getByTestId('menu-industry')).toHaveCount(0);
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
  await expect.poll(async () => (await getState(page)).stats.totalMineralsMined, { timeout: 30000 })
    .toBeGreaterThan(0);
  await expect(page.getByTestId('context')).toContainText('Mining', { timeout: 30000 });
  await expect(page.getByTestId('context-state')).toContainText('Mining', { timeout: 5000 });
  await page.getByTestId('auto-mine-hunt').click();
  await expect(page.getByTestId('auto-mine-hunt')).toHaveClass(/auto-mode-selected/);
  await expect(page.getByTestId('auto-mine')).not.toHaveClass(/auto-mode-selected/);
  await page.getByTestId('auto-mine-hunt').click();
  await expect(page.getByTestId('auto-mine-hunt')).not.toHaveClass(/auto-mode-selected/);
});

test('mode menu: START boots the storyline with m1, DEMO resumes the sandbox', async ({ page }) => {
  await page.request.post('/api/reset');
  await page.goto('/');
  await expect(page.getByTestId('mode-menu')).toBeVisible();
  await page.getByTestId('mode-story').click();
  await expect(page.getByTestId('context-state')).toHaveText(/\S/, { timeout: 15000 });
  let st = await getState(page);
  expect(st.mode).toBe('story');
  expect(st.isk).toBeUndefined();
  expect(st.mission.active).toBe('m1');
  // Switching back to demo returns the material-supplied sandbox.
  await page.reload();
  await page.getByTestId('mode-demo').click();
  await expect(page.getByTestId('context-state')).toHaveText(/\S/, { timeout: 15000 });
  st = await getState(page);
  expect(st.mode).toBe('demo');
  expect(st.isk).toBeUndefined();
  expect(st.mission.active).toBe(null);
});

// Play the whole storyline in one pass (m1 to m9), turning each completed mission
// in at the station hangar and accepting the next, ending with certification (m8),
// the m9 raiders in Placid, and the jump gates open for the sandbox. A single
// chain replaces five per-mission tests that each replayed the opening missions,
// so the browser suite covers the same ground in a fraction of the time.
test('storyline: pilot training from rookie to certification (m1-m9) unlocks the gates @slow', async ({ page }) => {
  test.setTimeout(600000);
  await page.request.post('/api/reset');
  await page.goto('/');
  await page.getByTestId('mode-story').click();
  await expect(page.getByTestId('context-state')).toHaveText(/\S/, { timeout: 15000 });

  // m1 - Under Attack: the handed-out weapon beats the attacker, then a docked
  // hangar turn-in offers m2.
  await expect(page.getByTestId('mission-tracker')).toContainText('Under Attack');
  await expect(page.getByTestId('mission-dialogue')).toBeVisible();
  await page.getByTestId('mission-continue').click();
  await expect(page.getByTestId('mission-dialogue')).toBeHidden();
  await killMissionEnemy(page, 'attacker');
  await warpUntil(page, (await getState(page)).world.stations[0].id, (s) => s.docked === true);
  await turnInAndAccept(page);

  // m2 - Help the Buddies: three short-range frigates; the first fight shows the
  // free-fire window the Range Amplifier grants.
  await expect(page.getByTestId('mission-tracker')).toContainText('Help the Buddies');
  const frigates = (await getState(page)).world.enemies.filter((e) => e.missionTag === 'shortrange' && e.alive);
  expect(frigates.length).toBe(3);
  await killMissionEnemy(page, 'shortrange', true);
  await killMissionEnemy(page, 'shortrange');
  await killMissionEnemy(page, 'shortrange');
  await warpUntil(page, (await getState(page)).world.stations[0].id, (s) => s.docked === true);
  await turnInAndAccept(page);

  // m3 - Last Stand: the unwinnable wave destroys the ship (scripted death).
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
  await turnInAndAccept(page);

  // m4 - A New Clone: the replacement frigate waits outside the dock; warp home,
  // dock, and the hangar turn-in hands off to m5.
  await expect(page.getByTestId('mission-tracker')).toContainText('A New Clone');
  await page.getByTestId('mission-continue').click();
  await warpUntil(page, (await getState(page)).world.stations[0].id, (s) => s.mission.ready === true);
  await turnInAndAccept(page);

  // m5 - Mining 101: warp to a belt and mine 40 ore.
  await expect(page.getByTestId('mission-tracker')).toContainText('Mining 101');
  await page.getByTestId('mission-continue').click();
  const belt = (await getState(page)).world.belts[0];
  await page.evaluate((id) => window.__eve.warp(id), belt.id);
  await expect(page.getByTestId('mine-btn')).toBeEnabled({ timeout: 30000 });
  for (let i = 0; i < 30 && !(await getState(page)).mission.ready; i++) {
    await manualMine(page);
  }
  await expect(async () => {
    const s = await getState(page);
    expect(s.mission.ready).toBe(true);
  }).toPass({ timeout: 10000 });
  await warpUntil(page, (await getState(page)).world.stations[0].id, (s) => s.docked === true);
  await turnInAndAccept(page);

  // m6 - Rogue Drones: destroy the drone hub and earn a mining drone.
  await expect(page.getByTestId('mission-tracker')).toContainText('Rogue Drones');
  await page.getByTestId('mission-continue').click();
  await killMissionEnemy(page, 'dronhub');
  await warpUntil(page, (await getState(page)).world.stations[0].id, (s) => s.docked === true);
  await turnInAndAccept(page);

  // m7 - The Forge: the grant ships both recipes' ore, so train the shield skill
  // and craft both modules in the hangar.
  await expect(page.getByTestId('mission-tracker')).toContainText('The Forge');
  await page.getByTestId('mission-continue').click();
  await page.getByTestId('menu-skills').click();
  await expect(page.getByTestId('skill-shieldUpgrades')).toBeEnabled({ timeout: 30000 });
  await page.getByTestId('skill-shieldUpgrades').click();
  const blueprints = (await getState(page)).blueprints;
  await page.getByTestId('menu-cargo').click();
  await page.getByTestId('cargo-filter-blueprints').click();
  for (const type of ['weapon', 'shield']) {
    const blueprint = blueprints.find((item) => item.kind === 'module' && item.type === type);
    expect(blueprint).toBeTruthy();
    await page.getByTestId(`inv-cell-${blueprint.id}`).click();
    await page.getByTestId(`craft-blueprint-${blueprint.id}`).click();
  }
  await expect(async () => {
    const s = await getState(page);
    expect(s.mission.ready).toBe(true);
  }).toPass({ timeout: 10000 });
  await turnInAndAccept(page);

  // m8 - Certification: acknowledge the dialogue, turn it in, and accept m9.
  await expect(page.getByTestId('mission-tracker')).toContainText('Certification');
  await page.getByTestId('mission-continue').click();
  await turnInAndAccept(page);

  // m9 - Beyond the Gates: the gates are open, so jump, clear the two raiders and
  // turn the course in. The storyline ends and the sandbox opens.
  await expect(page.getByTestId('mission-tracker')).toContainText('Beyond the Gates');
  await page.getByTestId('mission-continue').click();
  const gate = (await getState(page)).world.gates[0];
  await page.evaluate((id) => window.__eve.warp(id), gate.id);
  await expect(async () => {
    const s = await getState(page);
    expect(dist(s.activeShip, gate)).toBeLessThan(400);
  }).toPass({ timeout: 30000 });
  await expect(page.getByTestId('gate-jump')).toBeVisible({ timeout: 10000 });
  await page.getByTestId('gate-jump').click();
  await expect(async () => {
    const s = await getState(page);
    expect(s.system.id).toBe('sys_1');
  }).toPass({ timeout: 15000 });
  await killMissionEnemy(page, 'placidraider');
  await killMissionEnemy(page, 'placidraider');
  await warpUntil(page, (await getState(page)).world.stations[0].id, (s) => s.docked === true);
  await page.getByTestId('turnin-mission').click();
  await expect(page.getByTestId('storyline-card')).toContainText('Story complete', { timeout: 10000 });
  const finished = await getState(page);
  expect(finished.mission.active).toBe(null);
  expect(finished.mission.offered).toBe(null);
  expect(finished.mission.completed).toEqual(cfg.MISSION_ORDER);
});

// Warp to a POI and wait until `done(state)` is true — used for handoffs that
// complete automatically once you arrive (docking, mission progression).
async function warpUntil(page, targetId, done) {
  await page.evaluate((id) => window.__eve.warp(id), targetId);
  await expect(async () => {
    const s = await getState(page);
    expect(done(s)).toBe(true);
  }).toPass({ timeout: 45000 });
  // Docking plays a fly-in + fade; let it finish before the next scripted move.
  if ((await getState(page)).world.stations.some((st) => st.id === targetId)) {
    await expect(page.getByTestId('station-view')).toBeVisible({ timeout: 10000 });
  }
}

// Turn the completed mission in at the hangar and accept the offered one.
async function turnInAndAccept(page) {
  await page.getByTestId('menu-missions').click();
  await expect(page.getByTestId('turnin-mission')).toBeVisible({ timeout: 10000 });
  await page.getByTestId('turnin-mission').click();
  await expect(page.getByTestId('accept-mission')).toBeVisible({ timeout: 10000 });
  await page.getByTestId('accept-mission').click();
  await expect(async () => {
    const s = await getState(page);
    expect(s.mission.active).toBeTruthy();
  }).toPass({ timeout: 10000 });
}