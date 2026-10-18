'use strict';

// The screen-space UI layer, drawn/updated after the world so it sits on top:
// minimap, live health bars, HUD readouts, the hangar overlay, and toasts /
// death screen.
import { Node } from '../core/node.js';
import { MinimapNode } from './minimap.js';
import { HealthBarNode } from '../view/combat.js';
import { HudNode } from './hud.js';
import { HangarNode } from './hangar.js';
import { OverlaysNode } from './overlays.js';

export class UINode extends Node {
  constructor(app) {
    super(app);
    this.hangar = this.add(new HangarNode());
    this.add(new MinimapNode());
    this.add(new HealthBarNode());
    this.hud = this.add(new HudNode());
    this.overlays = this.add(new OverlaysNode());
  }
}
