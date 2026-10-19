'use strict';

// All DOM/input wiring: keyboard, canvas clicks + wheel, the HUD buttons and the
// delegated hangar / combat / loadout handlers. Wired up once in finishBoot.
export function initInput(app) {
  window.addEventListener('keydown', (e) => {
    const k = e.key.toLowerCase();
    if (['arrowup', 'arrowdown', 'arrowleft', 'arrowright', ' '].includes(k)) e.preventDefault();
    if (k === 'e') app.doEngage();
    if (k === 'h') app.toggleHangar();
    if (k === 'escape') app.toggleHangar(false);
  });

  // TODO: clicking must not nagivate - you can click warpables/enemies/belts/etc
  // and move like that - that means we need some other good way to navigate
  // around a system because it currently doesn't fit on a screen
  // - in eve online you have an "overview" window showing all objects in the system
  // maybe we need a similar "overview" panel to facilitate navigation
  // or implement a mini-map that allows quick navigation within the system, which we already
  // have in the upper right corner of the screen (the mini-map), how could
  // that be integrated with the click-to-warp functionality?
  // in eve online you also have the "icons" at the edges of the screen indicating nearby objects and points of interest
  // maybe we could implement something similar to help players quickly locate important objects without having to scroll around the system manually
  // let's plan some demos of these and try them out to see if they're fun.
  // and whne we remove the click to warp, all the references in the ui to it must also be cleaned up.
  

  const canvas = app.canvas;
  canvas.addEventListener('click', (ev) => {
    const rect = canvas.getBoundingClientRect();
    const sx = ev.clientX - rect.left;
    const sy = ev.clientY - rect.top;
    // 1) clicking a rat warps to it and marks it as the target
    let hit = null;
    let bd = 22;
    for (const e of app.state.world.enemies) {
      if (!e.alive) continue;
      const p = app.camera.worldToScreen(e.x, e.y);
      const d = Math.hypot(p.x - sx, p.y - sy);
      if (d < bd) {
        bd = d;
        hit = e;
      }
    }
    if (hit) {
      app.targetEnemyId = hit.id;
      app.doWarp(hit.id, { silent: true });
      return;
    }
    // 2) clicking a POI (station/belt/planet/moon/gate/star) warps to it
    const w = app.state.world;
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
      const p = app.camera.worldToScreen(poi.x, poi.y);
      const d = Math.hypot(p.x - sx, p.y - sy);
      if (d < poi.r * app.camera.zoom + 16 && d < bestD) {
        bestD = d;
        best = poi;
      }
    }
    if (best) {
      app.doWarp(best.id, { silent: true });
      return;
    }
    // 3) otherwise warp to the clicked point
    const wpt = app.camera.screenToWorld(sx, sy);
    if (wpt.x >= 0 && wpt.x <= app.constants.worldSize && wpt.y >= 0 && wpt.y <= app.constants.worldSize) {
      app.doWarp(null, { x: wpt.x, y: wpt.y, silent: true });
    }
  });

  canvas.addEventListener('wheel', (e) => {
    e.preventDefault();
    app.camera.scale(e.deltaY < 0 ? 1.1 : 0.9);
  }, { passive: false });

  document.getElementById('engage').addEventListener('click', () => app.doEngage());
  document.getElementById('hangar-btn').addEventListener('click', () => app.toggleHangar());
  document.getElementById('hangar-close').addEventListener('click', () => app.toggleHangar(false));
  document.getElementById('death-dismiss').addEventListener('click', () => app.overlays.hideDeath());
  document.getElementById('warp-belt').addEventListener('click', () => app.warpToNearest('belt'));
  document.getElementById('warp-station').addEventListener('click', () => app.warpToNearest('station'));
  document.getElementById('warp-rat').addEventListener('click', () => app.warpToNearest('rat'));
  document.getElementById('gate-jump').addEventListener('click', () => app.doGateJump());
  document.getElementById('auto-pilot').addEventListener('click', () => app.toggleAutoPilot());
  document.getElementById('mission-continue').addEventListener('click', async () => {
    await app.doAction('mission', { action: 'continue' });
    document.getElementById('mission-dialogue').hidden = true;
  });

  // in-fight actions (delegated — the combat HUD is re-rendered every frame)
  document.getElementById('combat-hud').addEventListener('click', (ev) => {
    const btn = ev.target.closest('button[data-action]');
    if (!btn || btn.disabled) return;
    app.doCombatAction(btn.dataset.action);
  });

  // loadout selector (static buttons, delegated)
  document.getElementById('loadout-panel').addEventListener('click', (ev) => {
    const btn = ev.target.closest('button[data-loadout]');
    if (!btn) return;
    app.doSetLoadout(btn.dataset.loadout);
  });

  // event delegation for all hangar buttons
  document.getElementById('hangar').addEventListener('click', (ev) => {
    const el = ev.target.closest('[data-action]');
    if (!el) return;
    const a = el.dataset.action;
    if (a === 'sell-mineral') app.doAction('sell-minerals', { mineral: el.dataset.mineral, amount: el.dataset.amount });
    else if (a === 'sell-all') app.doAction('sell-all', {});
    else if (a === 'buy-ship') app.doAction('buy-ship', { type: el.dataset.type });
    else if (a === 'set-active') app.doAction('set-active', { shipId: el.dataset.id });
    else if (a === 'upgrade') app.doAction('upgrade-ship', { shipId: el.dataset.id });
    else if (a === 'sell-ship') app.doAction('sell-ship', { shipId: el.dataset.id });
    else if (a === 'fit-module') app.doAction('fit-module', { shipId: el.dataset.ship, slotType: el.dataset.slot, slotIndex: Number(el.dataset.index), tier: Number(el.dataset.tier) });
    else if (a === 'train-skill') app.doAction('train-skill', { skill: el.dataset.skill });
    else if (a === 'buy-drone') app.doAction('buy-drone', { type: el.dataset.type, tier: Number(el.dataset.tier) });
    else if (a === 'equip-loot') app.doAction('equip-loot', { lootId: el.dataset.loot });
    else if (a === 'craft-module') app.doAction('craft-module', { slotType: el.dataset.slot, tier: Number(el.dataset.tier) });
  });

  window.addEventListener('resize', () => app.resize());
}
