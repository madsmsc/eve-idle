'use strict';

// All DOM/input wiring: keyboard, canvas clicks + wheel, the HUD buttons and the
// delegated hangar / inventory / combat handlers. Wired up once in finishBoot.
// Input is a wiring class — the same class of exception as app/api/cam/util, so
// it does not need to be a scene-graph node.
export class Input {
  // PUBLIC
  constructor(app) {
    this.app = app;
  }

  // PUBLIC
  wire() {
    const app = this.app;
    const activeUiPointers = new Set();
    document.addEventListener('pointerdown', (ev) => {
      if (!(ev.target instanceof Element) || !ev.target.closest('#menu-window, #hangar, #left-menu, #hud')) return;
      activeUiPointers.add(ev.pointerId);
      app.uiInteractionActive = true;
    }, true);
    const finishUiPointer = (ev) => {
      if (!activeUiPointers.delete(ev.pointerId) || activeUiPointers.size) return;
      setTimeout(() => {
        if (activeUiPointers.size) return;
        app.uiInteractionActive = false;
        if (!app.uiRefreshPending) return;
        app.uiRefreshPending = false;
        app.ui.refreshPanels();
        app.syncDockedView();
      }, 0);
    };
    document.addEventListener('pointerup', finishUiPointer, true);
    document.addEventListener('pointercancel', finishUiPointer, true);

    window.addEventListener('keydown', (e) => {
      const tag = e.target && e.target.tagName;
      if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return;
      if (document.querySelector('#offline-report:modal')) return;
      const k = e.key.toLowerCase();
      if (e.repeat && ['j', 'm'].includes(k)) return;
      if (['arrowup', 'arrowdown', 'arrowleft', 'arrowright', ' '].includes(k)) e.preventDefault();
      if (k === 'e') app.doEngage();
      if (k === 'h') app.toggleHangar();
      if (k === 'i') app.toggleInventory();
      if (k === 'l') app.toggleLoot();
      if (k === 'q') app.toggleStorage();
      if (k === 'a') app.setAutoPilotMode('mine');
      if (k === 'f') app.setAutoPilotMode('fight');
      if (k === 'b') app.setAutoPilotMode('mine_fight');
      if (k === 'm' && app.state.miningTargetId && !app.state.miningPaused && !app.state.cargoFull && !app.state.docked) {
        app.doAction('mine', {});
      }
      if (k === 'j' && app.state.nearby.gateId && !app.state.combat) app.doGateJump();
      if (k === 's') app.navigateToNearest('station');
      if (k === 'r') app.navigateToNearest('enemy');
      if (k === 'escape') {
        app.closeMenu();
      }
    });

    const canvas = app.canvas;
    canvas.addEventListener('click', (ev) => {
      const rect = canvas.getBoundingClientRect();
      const sx = ev.clientX - rect.left;
      const sy = ev.clientY - rect.top;
      // 1) clicking an enemy sets a flight destination and marks it as the target
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
    document.getElementById('mine').addEventListener('click', () => app.doAction('mine', {}));
    document.querySelectorAll('[data-overview-mode]').forEach((button) => {
      button.addEventListener('click', () => app.setOverviewMode(button.dataset.overviewMode));
    });
    document.getElementById('edge-map').addEventListener('click', (ev) => {
      const toggle = ev.target.closest('[data-cluster-toggle]');
      if (toggle) {
        const options = toggle.nextElementSibling;
        options.hidden = !options.hidden;
        toggle.setAttribute('aria-expanded', String(!options.hidden));
        return;
      }
      const marker = ev.target.closest('[data-target-id]');
      if (!marker) return;
      app.navigate(marker.dataset.targetId, null, { silent: true });
    });
    document.getElementById('left-menu').addEventListener('click', (ev) => {
      const button = ev.target.closest('.menu-card');
      if (button) app.openMenu(button.dataset.menu);
    });
    document.getElementById('death-dismiss').addEventListener('click', () => app.overlays.hideDeath());
    document.getElementById('navigate-belt').addEventListener('click', () => app.navigateToNearest('belt'));
    document.getElementById('navigate-station').addEventListener('click', () => app.navigateToNearest('station'));
    document.getElementById('navigate-enemy').addEventListener('click', () => app.navigateToNearest('enemy'));
    document.getElementById('gate-jump').addEventListener('click', () => app.doGateJump());
    document.querySelectorAll('[data-auto-mode]').forEach((button) => {
      button.addEventListener('click', () => app.setAutoPilotMode(button.dataset.autoMode));
    });
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
      else if (a === 'train-skill') app.doAction('train-skill', { skill: el.dataset.skill });
      else if (a === 'buy-blueprint') app.ui.hangar.buyBlueprint(el.dataset.type, Number(el.dataset.tier));
      else if (a === 'exchange-items') app.doAction('exchange-items', { family: el.dataset.family, item: el.dataset.item, amount: Number(el.dataset.amount) });
      else if (a === 'craft-module') app.doAction('craft-module', { slotType: el.dataset.slot, tier: Number(el.dataset.tier), blueprintId: el.dataset.blueprint });
      else if (a === 'craft-ship') app.doAction('craft-ship', { type: el.dataset.type, blueprintId: el.dataset.blueprint });
      else if (a === 'accept-agent-mission') app.doAction('agent-mission', { action: 'accept', agentId: el.dataset.agentId });
      else if (a === 'cancel-agent-mission') app.doAction('agent-mission', { action: 'cancel', agentId: el.dataset.agentId });
      else if (a === 'turnin-mission') app.doAction('mission', { action: 'turnin' });
      else if (a === 'accept-mission') app.doAction('mission', { action: 'accept' });
      else if (a === 'equip-loot') app.doAction('equip-loot', { lootId: el.dataset.loot });
      else if (a === 'refine-loot') app.doAction('refine-loot', { lootId: el.dataset.loot });
      else if (a === 'retrieve-item') app.doAction('retrieve-item', { kind: el.dataset.kind, id: el.dataset.id });
      else if (a === 'unequip-all') app.doAction('unequip-all', {});
    };
    document.getElementById('hangar').addEventListener('click', onHangarAction);

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
      if (a === 'deposit-filtered') app.doAction('deposit-filtered', { filter: app.ui.inventory.filter });
      else if (a === 'deposit-all') app.doAction('deposit-all', {});
      else if (a === 'craft-module') app.doAction('craft-module', { slotType: el.dataset.slot, tier: Number(el.dataset.tier), blueprintId: el.dataset.blueprint });
      else if (a === 'craft-ship') app.doAction('craft-ship', { type: el.dataset.type, blueprintId: el.dataset.blueprint });
      else if (a === 'deposit') app.doAction('deposit', { mineral: el.dataset.mineral, amount: el.dataset.amount });
      else if (a === 'withdraw') app.doAction('withdraw', { mineral: el.dataset.mineral, amount: el.dataset.amount });
      else if (a === 'store-item') app.doAction('store-item', { kind: el.dataset.kind, id: el.dataset.id });
      else if (a === 'retrieve-item') app.doAction('retrieve-item', { kind: el.dataset.kind, id: el.dataset.id });
      else if (a === 'equip-loot') app.doAction('equip-loot', { lootId: el.dataset.loot });
      else if (a === 'refine-loot') app.doAction('refine-loot', { lootId: el.dataset.loot });
    };
    document.getElementById('inventory').addEventListener('click', onInventoryClick);

    window.addEventListener('resize', () => app.resize());
    document.getElementById('station-launch').addEventListener('click', () => app.launch());
  }
}
