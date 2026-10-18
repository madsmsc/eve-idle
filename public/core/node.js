'use strict';

// Base scene-graph node. Every node owns its own update/render behavior AND a
// list of children; update/render recurse into the children and return `this`
// so the tree can be driven with a single chained call:
//
//   root.update(dt).render(now);
//
// The `app` reference is injected once at construction (and propagated to
// children added via `add`) and is stable even though `app.state` is swapped
// out on every server sync. Subclasses override update/render, do their own
// work, then call super to recurse into their children (drawn on top).
export class  Node {
  constructor(app) {
    this.app = app;
    this.children = [];
  }

  add(child) {
    if (!child.app) child.app = this.app;
    this.children.push(child);
    return child;
  }

  update(dt) {
    for (const child of this.children) child.update(dt);
    return this;
  }

  render(now) {
    for (const child of this.children) child.render(now);
    return this;
  }
}
