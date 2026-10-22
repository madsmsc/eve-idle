'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { performance, monitorEventLoopDelay } = require('node:perf_hooks');
const { chromium } = require('@playwright/test');
const game = require('../server/game');
const { createApp } = require('../server');

const DEFAULT_DURATION_SECONDS = 6;
const SERVER_ITERATIONS = 300;
const API_ITERATIONS = 40;

function durationFromArgs(args) {
  const index = args.indexOf('--duration');
  if (index < 0) return DEFAULT_DURATION_SECONDS;
  const duration = Number(args[index + 1]);
  if (!Number.isFinite(duration) || duration < 3 || duration > 60) {
    throw new Error('--duration must be a number between 3 and 60 seconds');
  }
  return duration;
}

function summarize(samples) {
  if (!samples.length) return { count: 0, mean: 0, p50: 0, p95: 0, max: 0 };
  const sorted = samples.slice().sort((a, b) => a - b);
  const sum = samples.reduce((total, sample) => total + sample, 0);
  return {
    count: samples.length,
    mean: sum / samples.length,
    p50: sorted[Math.floor((sorted.length - 1) * 0.5)],
    p95: sorted[Math.floor((sorted.length - 1) * 0.95)],
    max: sorted[sorted.length - 1],
  };
}

function measureSync(name, iterations, run) {
  for (let i = 0; i < 30; i++) run(i);
  const samples = [];
  for (let i = 0; i < iterations; i++) {
    const start = performance.now();
    run(i);
    samples.push(performance.now() - start);
  }
  return { name, iterations, ...summarize(samples) };
}

async function measureAsync(name, iterations, run) {
  for (let i = 0; i < 5; i++) await run(i);
  const samples = [];
  for (let i = 0; i < iterations; i++) {
    const start = performance.now();
    await run(i);
    samples.push(performance.now() - start);
  }
  return { name, iterations, ...summarize(samples) };
}

function formatMs(value) {
  return `${value.toFixed(3)} ms`;
}

async function responseBody(response) {
  if (!response.ok) throw new Error(`Benchmark request failed with HTTP ${response.status}`);
  await response.arrayBuffer();
}

async function runServerBenchmarks(baseUrl, app) {
  const state = game.createInitialState(Date.now(), 20261022, 'demo');
  const active = state.ships.find((ship) => ship.id === state.activeShipId);
  const asteroid = state.systems[active.systemId].asteroids[0];
  active.x = asteroid.x;
  active.y = asteroid.y;
  active.dockedStationId = null;
  active.dockTargetId = null;
  state.lastTick = Date.now();
  app.setState(state);

  const loopDelay = monitorEventLoopDelay({ resolution: 10 });
  loopDelay.enable();
  const gameView = measureSync('game.view', SERVER_ITERATIONS * 2, () => game.view(state));
  const gameTick = measureSync('game.tick (clone + simulation)', SERVER_ITERATIONS, () =>
    game.tick(state, state.lastTick + 1000, { x: active.x, y: active.y, dockTargetId: null }),
  );
  const apiState = await measureAsync('GET /api/state', API_ITERATIONS, async () =>
    responseBody(await fetch(`${baseUrl}/api/state`)),
  );
  const apiTick = await measureAsync('POST /api/tick (includes save)', API_ITERATIONS, async () =>
    responseBody(await fetch(`${baseUrl}/api/tick`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ x: active.x, y: active.y, dockTargetId: null }),
    })),
  );
  loopDelay.disable();

  return {
    benchmarks: [gameView, gameTick, apiState, apiTick],
    eventLoopDelayMs: {
      mean: Number(loopDelay.mean / 1e6),
      p95: Number(loopDelay.percentile(95) / 1e6),
      max: Number(loopDelay.max / 1e6),
    },
  };
}

async function runClientScenario(page, durationSeconds, minimapVisible) {
  const mapToggle = page.getByTestId('overview-toggle');
  const currentlyVisible = await page.getByTestId('minimap').isVisible();
  if (currentlyVisible !== minimapVisible) await mapToggle.click();
  await page.waitForTimeout(1000);
  await page.evaluate(() => window.__eve.perf.reset());
  await page.waitForTimeout(durationSeconds * 1000);
  const samples = await page.evaluate(() => window.__eve.perf.snapshot());
  const intervals = summarize(samples.frameIntervals);
  const totalFrames = samples.frame.length;
  const dropped = samples.frameIntervals.filter((interval) => interval > 20).length;
  return {
    minimap: minimapVisible ? 'visible' : 'hidden',
    frames: totalFrames,
    estimatedFps: intervals.p50 ? 1000 / intervals.p50 : 0,
    intervalsMs: intervals,
    droppedFramePercent: samples.frameIntervals.length
      ? (100 * dropped) / samples.frameIntervals.length
      : 0,
    cameraMs: summarize(samples.camera),
    updateMs: summarize(samples.update),
    renderMs: summarize(samples.render),
    appFrameMs: summarize(samples.frame),
  };
}

async function runClientBenchmarks(baseUrl, durationSeconds) {
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
    await page.addInitScript(() => {
      window.__EVE_PERF__ = true;
      localStorage.setItem('eve-idle-demo-tutorial-dismissed', 'true');
    });
    await page.goto(baseUrl);
    await page.getByTestId('mode-demo').click();
    await page.waitForFunction(() => window.__eve && window.__eve.state);
    await page.evaluate(async () => {
      const asteroid = window.__eve.state.world.asteroids[0];
      await window.__eve.warp(null, { x: asteroid.x, y: asteroid.y });
    });
    await page.waitForFunction(() => window.__eve.state && !window.__eve.state.docked);
    const world = await page.evaluate(() => ({
      asteroids: window.__eve.state.world.asteroids.length,
      enemies: window.__eve.state.world.enemies.length,
      belts: window.__eve.state.world.belts.length,
    }));
    const scenarios = [];
    for (const visible of [true, false]) {
      scenarios.push(await runClientScenario(page, durationSeconds, visible));
    }
    return { viewport: '1280x720', world, scenarios, chromium: browser.version() };
  } finally {
    await browser.close();
  }
}

function recommendations(report) {
  const suggestions = [];
  for (const scenario of report.client.scenarios) {
    if (scenario.renderMs.p95 >= 4) {
      suggestions.push(`${scenario.minimap} minimap: canvas render p95 is ${formatMs(scenario.renderMs.p95)}; inspect the render flame chart and prioritize the most expensive draw nodes.`);
    }
    if (scenario.updateMs.p95 >= 4) {
      suggestions.push(`${scenario.minimap} minimap: scene update p95 is ${formatMs(scenario.updateMs.p95)}; profile per-frame proximity scans and HUD updates.`);
    }
    if (scenario.droppedFramePercent >= 2) {
      suggestions.push(`${scenario.minimap} minimap: ${scenario.droppedFramePercent.toFixed(1)}% of frame intervals exceed 20 ms; investigate the recorded update/render timings.`);
    }
  }
  const tick = report.server.benchmarks.find((item) => item.name.startsWith('game.tick'));
  const apiTick = report.server.benchmarks.find((item) => item.name.startsWith('POST /api/tick'));
  if (tick.p95 >= 5) {
    suggestions.push(`game.tick p95 is ${formatMs(tick.p95)}; inspect state cloning and full-world simulation scans first.`);
  }
  if (apiTick.p95 >= 25 && apiTick.p95 > tick.p95 * 2) {
    suggestions.push(`API tick p95 (${formatMs(apiTick.p95)}) is much higher than simulation p95 (${formatMs(tick.p95)}); persistence and HTTP serialization are likely contributors.`);
  }
  if (!suggestions.length) {
    suggestions.push('No obvious bottleneck crossed the report thresholds. Increase --duration or profile a heavier combat/world scenario before optimizing.');
  }
  return suggestions;
}

function printReport(report, jsonOutput) {
  if (jsonOutput) {
    console.log(JSON.stringify(report, null, 2));
    return;
  }
  console.log('EVE Idle performance report');
  console.log(`Node ${report.environment.node} · ${report.environment.platform} · Chromium ${report.environment.chromium}`);
  console.log(`Server world: ${report.client.world.belts} belts, ${report.client.world.asteroids} asteroids, ${report.client.world.enemies} enemies`);
  console.log('\nServer (per-operation latency)');
  for (const item of report.server.benchmarks) {
    console.log(`  ${item.name.padEnd(38)} p50 ${formatMs(item.p50)} · p95 ${formatMs(item.p95)} · max ${formatMs(item.max)}`);
  }
  console.log(`  event-loop delay p95                 ${formatMs(report.server.eventLoopDelayMs.p95)}`);
  console.log(`\nFrontend (${report.environment.durationSeconds}s samples per minimap state)`);
  for (const item of report.client.scenarios) {
    console.log(`  Minimap ${item.minimap}: ~${item.estimatedFps.toFixed(1)} FPS · >20ms intervals ${item.droppedFramePercent.toFixed(1)}%`);
    console.log(`    camera p95 ${formatMs(item.cameraMs.p95)} · update p95 ${formatMs(item.updateMs.p95)} · render p95 ${formatMs(item.renderMs.p95)} · app frame p95 ${formatMs(item.appFrameMs.p95)}`);
  }
  console.log('\nOptimization leads');
  for (const [index, suggestion] of report.recommendations.entries()) {
    console.log(`  ${index + 1}. ${suggestion}`);
  }
}

async function main() {
  const durationSeconds = durationFromArgs(process.argv.slice(2));
  const jsonOutput = process.argv.includes('--json');
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'eve-idle-perf-'));
  const app = createApp({ dataFile: path.join(tempDir, 'state.json') });
  try {
    await new Promise((resolve, reject) => {
      app.server.once('error', reject);
      app.server.listen(0, '127.0.0.1', resolve);
    });
    const address = app.server.address();
    const baseUrl = `http://127.0.0.1:${address.port}`;
    const server = await runServerBenchmarks(baseUrl, app);
    const client = await runClientBenchmarks(baseUrl, durationSeconds);
    const report = {
      generatedAt: new Date().toISOString(),
      environment: {
        node: process.version,
        platform: `${process.platform} ${process.arch}`,
        chromium: client.chromium,
        durationSeconds,
      },
      server,
      client,
    };
    report.recommendations = recommendations(report);
    printReport(report, jsonOutput);
  } finally {
    await app.close();
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
