'use strict';

// All DOM/input wiring: keyboard, canvas clicks + wheel, the HUD buttons and the
// delegated hangar / inventory / combat handlers. Wired up once in finishBoot.
// Input is a wiring class — the same class of exception as app/api/cam/util, so
// it does not need to be a scene-graph node.
export class Input {
  constructor(app) {
    this.app = app;
  }

  wire() {
    const app = this.app;
    window.addEventListener('keydown', (e) => {
      const tag = e.target && e.target.tagName;
      if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return;
      const k = e.key.toLowerCase();
      if (['arrowup', 'arrowdown', 'arrowleft', 'arrowright', ' '].includes(k)) e.preventDefault();
      if (k === 'e') app.doEngage();
      if (k === 'h') app.toggleHangar();
      if (k === 'c') app.toggleCharacter();
      if (k === 'i') app.toggleInventory();
      if (k === 'f') app.toggleFitting();
      if (k === 'l') app.toggleLoot();
      if (k === 'q') app.toggleStorage();
      if (k === 'a') app.toggleAutoPilot();
      if (k === 'm') app.toggleOverview();
      if (k === 'b') app.navigateToNearest('belt');
      if (k === 's') app.navigateToNearest('station');
      if (k === 'r') app.navigateToNearest('rat');
      if (k === 'escape') {
        app.closeMenu();
      }
    });

    const canvas = app.canvas;
    canvas.addEventListener('click', (ev) => {
      const rect = canvas.getBoundingClientRect();
      const sx = ev.clientX - rect.left;
      const sy = ev.clientY - rect.top;
      // 1) clicking a rat sets a flight destination and marks it as the target
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
        app.navigate(hit.id, null, { silent: true });
        return;
      }
      // 2) clicking a POI sets a flight destination
      const w = app.state.world;
      const pois = [];
      for (const st of w.stations) pois.push({ id: st.id, x: st.x, y: st.y, r: 70 });
      for (const outpost of w.outposts || []) pois.push({ id: outpost.id, x: outpost.x, y: outpost.y, r: 55 });
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
        app.navigate(best.id, null, { silent: true });
        return;
      }
    });

    const minimap = app.minimap;
    const navigateOverview = (clientX, clientY) => {
      const rect = minimap.getBoundingClientRect();
      const x = Math.max(0, Math.min(1, (clientX - rect.left) / rect.width)) * app.constants.worldSize;
      const y = Math.max(0, Math.min(1, (clientY - rect.top) / rect.height)) * app.constants.worldSize;
      app.navigate(null, { x, y }, { silent: true });
    };
    minimap.addEventListener('click', (ev) => navigateOverview(ev.clientX, ev.clientY));
    minimap.addEventListener('keydown', (ev) => {
      if (ev.key === 'Enter' || ev.key === ' ') {
        ev.preventDefault();
        const rect = minimap.getBoundingClientRect();
        navigateOverview(rect.left + rect.width / 2, rect.top + rect.height / 2);
      }
    });

    canvas.addEventListener('wheel', (e) => {
      e.preventDefault();
      app.camera.scale(e.deltaY < 0 ? 1.1 : 0.9);
    }, { passive: false });

    document.getElementById('engage').addEventListener('click', () => app.doEngage());
    document.getElementById('overview-toggle').addEventListener('click', () => app.toggleOverview());
    document.getElementById('menu-window-close').addEventListener('click', () => app.closeMenu());
    document.getElementById('left-menu').addEventListener('click', (ev) => {
      const button = ev.target.closest('.menu-card');
      if (button) app.openMenu(button.dataset.menu);
    });
    document.getElementById('death-dismiss').addEventListener('click', () => app.overlays.hideDeath());
    document.getElementById('navigate-belt').addEventListener('click', () => app.navigateToNearest('belt'));
    document.getElementById('navigate-station').addEventListener('click', () => app.navigateToNearest('station'));
    document.getElementById('navigate-rat').addEventListener('click', () => app.navigateToNearest('rat'));
    document.getElementById('gate-jump').addEventListener('click', () => app.doGateJump());
    document.getElementById('auto-pilot').addEventListener('click', () => app.toggleAutoPilot());
    document.getElementById('auto-log').addEventListener('click', () => app.toggleAutoLog());
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

    // event delegation for all hangar buttons
    const onHangarAction = (ev) => {
      const el = ev.target.closest('[data-action]');
      if (!el) return;
      const a = el.dataset.action;
      if (a === 'set-active') app.doAction('set-active', { shipId: el.dataset.id });
      else if (a === 'fit-module') app.doAction('fit-module', { shipId: el.dataset.ship, slotType: el.dataset.slot, slotIndex: Number(el.dataset.index), tier: Number(el.dataset.tier) });
      else if (a === 'save-fitting-preset') app.doAction('save-fitting-preset', { name: document.getElementById('fitting-preset-name').value });
      else if (a === 'apply-fitting-preset' || a === 'delete-fitting-preset') {
        const name = document.getElementById('fitting-preset-select').value;
        if (name) app.doAction(a, { name });
      }
      else if (a === 'train-skill') app.doAction('train-skill', { skill: el.dataset.skill });
      else if (a === 'buy-blueprint') app.doAction('buy-blueprint', { kind: el.dataset.kind, type: el.dataset.type, tier: el.dataset.tier ? Number(el.dataset.tier) : null });
      else if (a === 'exchange-items') app.doAction('exchange-items', { family: el.dataset.family, item: el.dataset.item, amount: Number(el.dataset.amount) });
      else if (a === 'equip-loot') app.doAction('equip-loot', { lootId: el.dataset.loot });
      else if (a === 'refine-loot') app.doAction('refine-loot', { lootId: el.dataset.loot });
      else if (a === 'craft-module') app.doAction('craft-module', { slotType: el.dataset.slot, tier: Number(el.dataset.tier) });
      else if (a === 'craft-ship') app.doAction('craft-ship', { type: el.dataset.type });
      else if (a === 'accept-agent-mission') app.doAction('agent-mission', { action: 'accept' });
      else if (a === 'cancel-agent-mission') app.doAction('agent-mission', { action: 'cancel' });
    };
    document.getElementById('hangar').addEventListener('click', onHangarAction);
    document.getElementById('fitting-panel').addEventListener('click', onHangarAction);

    // inventory grid selection + equip, and quantum-storage transfers
    const onInventoryClick = (ev) => {
      const filter = ev.target.closest('[data-cargo-filter]');
      if (filter) {
        app.ui.inventory.setFilter(filter.dataset.cargoFilter);
        return;
      }
      const cell = ev.target.closest('[data-cell]');
      if (cell) {
        app.ui.inventory.select(cell.dataset.cell);
        return;
      }
      const el = ev.target.closest('button[data-action]');
      if (!el || el.disabled) return;
      const a = el.dataset.action;
      if (a === 'deposit-all') app.doAction('deposit-all', {});
      else if (a === 'deposit') app.doAction('deposit', { mineral: el.dataset.mineral, amount: el.dataset.amount });
      else if (a === 'withdraw') app.doAction('withdraw', { mineral: el.dataset.mineral, amount: el.dataset.amount });
      else if (a === 'equip-loot') app.doAction('equip-loot', { lootId: el.dataset.loot });
      else if (a === 'refine-loot') app.doAction('refine-loot', { lootId: el.dataset.loot });
    };
    document.getElementById('inventory').addEventListener('click', onInventoryClick);
    document.getElementById('storage-panel').addEventListener('click', onInventoryClick);
    document.getElementById('fitting-preset-select').addEventListener('change', (ev) => {
      document.querySelector('[data-action="delete-fitting-preset"]').disabled = !ev.target.value;
    });

    window.addEventListener('resize', () => app.resize());
    document.getElementById('station-launch').addEventListener('click', () => app.launch());
  }
}
