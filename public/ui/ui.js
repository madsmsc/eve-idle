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

export class UINode extends Node {
  constructor(app) {
    super(app);
    this.hangar = this.add(new HangarNode());
    this.character = this.add(new CharacterNode());
    this.inventory = this.add(new InventoryNode());
    this.add(new MinimapNode());
    this.hud = this.add(new HudNode());
    this.overlays = this.add(new OverlaysNode());
  }

  refreshPanels() {
    this.hud.refreshPanels();
    if (this.app.hangarOpen) this.hangar.refresh();
    if (this.app.characterOpen) this.character.refresh();
    if (this.app.inventoryOpen) this.inventory.refresh();
  }
}
