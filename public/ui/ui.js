'use strict';

// The screen-space UI layer, drawn/updated after the world so it sits on top:
// minimap, HUD readouts, the hangar overlay, and toasts / death screen.
import { Node } from '../core/node.js';
import { MinimapNode } from './minimap.js';
import { HudNode } from './hud.js';
import { HangarNode } from './hangar.js';
import { CharacterNode } from './character.js';
import { InventoryNode } from './inventory.js';
import { OverlaysNode } from './overlays.js';

const STATION_MENUS = ['fleet', 'shipyard', 'storage', 'market', 'skills', 'achievements', 'missions', 'industry', 'killboard'];

class MenuGroupNode extends Node {
  constructor(app) {
    super(app);
    this.hangar = this.add(new HangarNode());
    this.character = this.add(new CharacterNode());
    this.inventory = this.add(new InventoryNode());
  }
}

class HudGroupNode extends Node {
  constructor(app) {
    super(app);
    this.minimap = this.add(new MinimapNode());
    this.hud = this.add(new HudNode());
    this.overlays = this.add(new OverlaysNode());
  }
}

export class UINode extends Node {
  constructor(app) {
    super(app);
    this.menus = this.add(new MenuGroupNode(app));
    this.screen = this.add(new HudGroupNode(app));
    this.hangar = this.menus.hangar;
    this.character = this.menus.character;
    this.inventory = this.menus.inventory;
    this.hud = this.screen.hud;
    this.overlays = this.screen.overlays;
  }

  refreshPanels() {
    this.hud.refreshPanels();
    if (this.app.hangarOpen) this.hangar.refresh();
    if (this.app.menuPageOpen) this.refreshMenuPage();
  }

  refreshMenuPage() {
    this.inventory.refresh();
    if (this.app.activeMenu === 'pilot') this.character.refresh();
  }

  syncDockedView() {
    const app = this.app;
    const docked = app.state && app.state.docked;
    const wasDocked = document.body.classList.contains('docked');
    if (docked && !wasDocked) {
      app.menuPageOpen = true;
      app.activeMenu = 'cargo';
      document.getElementById('menu-window').hidden = false;
      document.body.classList.add('menu-window-open');
      document.getElementById('menu-window-title').textContent =
        document.querySelector('.menu-card[data-menu="cargo"]').textContent.trim();
      document.querySelectorAll('.menu-page').forEach((page) => {
        const selected = page.dataset.menuPage === 'cargo';
        page.classList.toggle('active', selected);
        page.hidden = !selected;
      });
      this.inventory.refresh();
    } else if (!docked && wasDocked) {
      app.menuPageOpen = false;
      app.activeMenu = 'cargo';
      document.getElementById('menu-window').hidden = true;
      document.body.classList.remove('menu-window-open');
    }
    document.body.classList.toggle('docked', !!docked);
    const view = document.getElementById('station-view');
    if (view) view.hidden = !docked;
    if (docked && view && app.dockBackground) {
      view.style.setProperty('--dock-background', `url("${app.dockBackground}")`);
    }
    if (docked && app.state.dockedStation) {
      const nameElement = document.getElementById('station-view-name');
      if (nameElement) nameElement.textContent = app.state.dockedStation;
    }
    app.hangarOpen = !!docked && STATION_MENUS.includes(app.activeMenu);
    document.getElementById('hangar').hidden = !app.hangarOpen;
    if (app.hangarOpen && (!wasDocked || app.activeMenu !== app.lastHangarTab)) this.hangar.refresh();
    if (app.hangarOpen) this.hangar.showService(app.activeMenu);
    app.lastHangarTab = app.activeMenu;
    document.querySelectorAll('.menu-card').forEach((button) => {
      const selected = app.activeMenu === button.dataset.menu && (app.menuPageOpen || app.hangarOpen);
      button.classList.toggle('active', selected);
      button.setAttribute('aria-current', selected ? 'page' : 'false');
      if (button.hasAttribute('data-station-menu')) button.disabled = !docked;
    });
  }

  openMenu(name, force) {
    const app = this.app;
    const shipMenus = ['cargo', 'fitting', 'pilot'];
    const stationMenus = STATION_MENUS;
    if (!shipMenus.includes(name) && !stationMenus.includes(name)) throw new Error(`Unknown menu: ${name}`);
    if (stationMenus.includes(name) && !(app.state && app.state.docked)) {
      app.toast('Dock at a station to use this service', true);
      return;
    }

    const opening = force !== undefined ? !!force : (!app.menuPageOpen && !app.hangarOpen || app.activeMenu !== name);
    if (!opening) {
      this.closeMenu();
      return;
    }
    app.activeMenu = name;
    app.menuPageOpen = shipMenus.includes(name);
    app.hangarOpen = stationMenus.includes(name);
    document.body.classList.toggle('menu-window-open', app.menuPageOpen);
    document.getElementById('menu-window').hidden = !app.menuPageOpen;
    document.getElementById('hangar').hidden = !app.hangarOpen;
    const page = document.querySelector(`.menu-page[data-menu-page="${name}"]`);
    document.querySelectorAll('.menu-page').forEach((item) => {
      const selected = item === page;
      item.classList.toggle('active', selected);
      item.hidden = !selected;
    });
    const button = document.querySelector(`.menu-card[data-menu="${name}"]`);
    document.getElementById('menu-window-title').textContent = button.textContent.trim();
    document.querySelectorAll('.menu-card').forEach((item) => {
      const selected = item.dataset.menu === name;
      item.classList.toggle('active', selected);
      item.setAttribute('aria-current', selected ? 'page' : 'false');
    });
    if (app.menuPageOpen) this.refreshMenuPage();
    if (app.hangarOpen) {
      this.hangar.showService(name);
      this.hangar.refresh();
    }
  }

  closeMenu() {
    const app = this.app;
    app.menuPageOpen = false;
    app.hangarOpen = false;
    app.activeMenu = 'cargo';
    document.body.classList.remove('menu-window-open');
    document.getElementById('menu-window').hidden = true;
    document.getElementById('hangar').hidden = true;
    document.querySelectorAll('.menu-card').forEach((item) => {
      item.classList.remove('active');
      item.setAttribute('aria-current', 'false');
    });
  }

}
