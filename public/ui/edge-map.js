'use strict';

import { fmt, dist } from '../core/util.js';

const REFRESH_MS = 200;

export function renderEdgeMap(app, now) {
  if (app.overviewMode !== 'edge' || !app.state || app.edgeMapPointerDown || now - (app.lastEdgeMapRender || 0) < REFRESH_MS) return;
  app.lastEdgeMapRender = now;
  const container = document.getElementById('edge-map');
  const width = app.canvas.width;
  const height = app.canvas.height;
  const world = app.state.world;
  const locations = [
    ...(world.belts || []).map((item) => ({ ...item, kind: 'belt' })),
    ...(world.stations || []).map((item) => ({ ...item, kind: 'station' })),
    ...(world.outposts || []).map((item) => ({ ...item, kind: 'outpost' })),
    ...(world.gates || []).map((item) => ({ ...item, kind: 'gate' })),
  ];
  const candidates = [];
  for (const location of locations) {
    const point = app.camera.worldToScreen(location.x, location.y);
    if (point.x >= 0 && point.x <= width && point.y >= 0 && point.y <= height) continue;
    const dx = point.x - width / 2;
    const dy = point.y - height / 2;
    const edgeScale = Math.min(
      (width / 2) / Math.max(Math.abs(dx), 1),
      (height / 2) / Math.max(Math.abs(dy), 1),
    );
    const edgePoint = { x: width / 2 + dx * edgeScale, y: height / 2 + dy * edgeScale };
    const edgeX = edgePoint.x <= 1 ? 'start' : edgePoint.x >= width - 1 ? 'end' : 'center';
    const edgeY = edgePoint.y <= 1 ? 'start' : edgePoint.y >= height - 1 ? 'end' : 'center';
    candidates.push({
      ...edgePoint,
      edgeX,
      edgeY,
      id: location.id,
      name: location.name || location.kind,
      kind: location.kind,
      distance: dist(app.player.x, app.player.y, location.x, location.y),
    });
  }

  container.replaceChildren();
  const markersBySide = new Map([
    ['top', []],
    ['right', []],
    ['bottom', []],
    ['left', []],
  ]);
  for (const candidate of candidates) {
    const wrapper = document.createElement('div');
    wrapper.className = 'edge-marker-group';
    const side = candidate.edgeY === 'start' ? 'top'
      : candidate.edgeY === 'end' ? 'bottom'
        : candidate.edgeX === 'start' ? 'left' : 'right';
    wrapper.dataset.edgeSide = side;
    if (side === 'top' || side === 'bottom') {
      wrapper.style.left = `${candidate.x}px`;
      wrapper.style.top = side === 'top' ? '0px' : `${height}px`;
      wrapper.style.transform = `translate(-50%, ${side === 'top' ? '0%' : '-100%'})`;
    } else {
      wrapper.style.left = side === 'left' ? '0px' : `${width}px`;
      wrapper.style.top = `${candidate.y}px`;
      wrapper.style.transform = `translate(${side === 'left' ? '0%' : '-100%'}, -50%)`;
    }
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'edge-marker';
    const distanceLabel = `${fmt(candidate.distance)} m`;
    button.dataset.targetId = candidate.id;
    button.setAttribute('aria-label', `${candidate.name}, ${distanceLabel}`);
    button.title = `${candidate.kind} ${candidate.name} · ${distanceLabel}`;
    const label = document.createElement('span');
    label.className = `edge-marker-name edge-marker-name--${candidate.kind}`;
    label.textContent = candidate.name;
    const distance = document.createElement('span');
    distance.className = 'edge-marker-distance';
    distance.textContent = distanceLabel;
    button.append(label, distance);
    wrapper.appendChild(button);
    container.appendChild(wrapper);
    markersBySide.get(side).push({ candidate, wrapper, button });
  }

  for (const [side, markers] of markersBySide) {
    const horizontal = side === 'top' || side === 'bottom';
    const axisLength = horizontal ? width : height;
    const measured = markers.map((marker) => {
      const bounds = marker.button.getBoundingClientRect();
      return {
        ...marker,
        size: horizontal ? bounds.width : bounds.height,
        center: horizontal ? bounds.left + bounds.width / 2 : bounds.top + bounds.height / 2,
      };
    }).sort((a, b) => a.center - b.center);
    const gap = 8;
    const total = measured.reduce((sum, marker) => sum + marker.size, 0) + gap * Math.max(0, measured.length - 1);
    const targetCenter = measured.length
      ? measured.reduce((sum, marker) => sum + marker.center, 0) / measured.length
      : 0;
    let cursor = Math.max(0, Math.min(axisLength - total, targetCenter - total / 2));
    for (const marker of measured) {
      const position = cursor + marker.size / 2;
      if (horizontal) marker.wrapper.style.left = `${position}px`;
      else marker.wrapper.style.top = `${position}px`;
      cursor += marker.size + gap;
    }
  }
}
