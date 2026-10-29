'use strict';

import { fmt, dist } from '../core/util.js';

const REFRESH_MS = 200;
const CLUSTER_DISTANCE = 54;
const DIRECTIONS = ['→', '↘', '↓', '↙', '←', '↖', '↑', '↗'];

export function renderEdgeMap(app, now) {
  if (app.overviewMode !== 'edge' || !app.state || now - (app.lastEdgeMapRender || 0) < REFRESH_MS) return;
  app.lastEdgeMapRender = now;
  const container = document.getElementById('edge-map');
  const width = app.canvas.width;
  const height = app.canvas.height;
  const world = app.state.world;
  const locations = [
    ...(world.belts || []).map((item) => ({ ...item, type: 'B', kind: 'belt' })),
    ...(world.stations || []).map((item) => ({ ...item, type: 'S', kind: 'station' })),
    ...(world.outposts || []).map((item) => ({ ...item, type: 'O', kind: 'outpost' })),
    ...(world.gates || []).map((item) => ({ ...item, type: 'G', kind: 'gate' })),
  ];
  const candidates = [];
  for (const location of locations) {
    const point = app.camera.worldToScreen(location.x, location.y);
    if (point.x >= 0 && point.x <= width && point.y >= 0 && point.y <= height) continue;
    const dx = point.x - width / 2;
    const dy = point.y - height / 2;
    const directionIndex = (Math.round((Math.atan2(dy, dx) + Math.PI * 2) / (Math.PI / 4)) % 8);
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
      type: location.type,
      direction: DIRECTIONS[directionIndex],
      distance: dist(app.player.x, app.player.y, location.x, location.y),
    });
  }

  const groups = [];
  for (const candidate of candidates) {
    const group = groups.find((item) =>
      item.edgeX === candidate.edgeX && item.edgeY === candidate.edgeY &&
      item.members.some((member) =>
        Math.hypot(member.x - candidate.x, member.y - candidate.y) <= CLUSTER_DISTANCE
      )
    );
    if (group) {
      group.members.push(candidate);
      group.x = group.members.reduce((sum, item) => sum + item.x, 0) / group.members.length;
      group.y = group.members.reduce((sum, item) => sum + item.y, 0) / group.members.length;
    } else {
      groups.push({
        x: candidate.x,
        y: candidate.y,
        edgeX: candidate.edgeX,
        edgeY: candidate.edgeY,
        members: [candidate],
      });
    }
  }

  container.replaceChildren();
  for (const group of groups) {
    const nearest = group.members.reduce((best, item) => item.distance < best.distance ? item : best);
    const wrapper = document.createElement('div');
    wrapper.className = 'edge-marker-group';
    wrapper.style.left = `${group.x}px`;
    wrapper.style.top = `${group.y}px`;
    wrapper.style.transform = `translate(${
      group.edgeX === 'start' ? '0%' : group.edgeX === 'end' ? '-100%' : '-50%'
    }, ${
      group.edgeY === 'start' ? '0%' : group.edgeY === 'end' ? '-100%' : '-50%'
    })`;
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'edge-marker';
    const detail = group.members.length === 1
      ? `${nearest.type} ${nearest.name}`
      : `${group.members.length} destinations`;
    const distances = group.members.map((item) => item.distance).sort((a, b) => a - b);
    const distanceLabel = group.members.length === 1
      ? `${fmt(nearest.distance)} m`
      : `${fmt(distances[0])}–${fmt(distances[distances.length - 1])} m`;
    button.setAttribute('aria-label', `${detail}, ${distanceLabel}`);
    button.title = group.members.map((item) =>
      `${item.type} ${item.name} · ${fmt(item.distance)} m`
    ).join('\n');
    if (group.members.length === 1) {
      button.dataset.targetId = nearest.id;
    } else {
      button.dataset.clusterToggle = 'true';
      button.setAttribute('aria-expanded', 'false');
    }
    const direction = document.createElement('span');
    direction.className = 'edge-direction';
    direction.textContent = nearest.direction;
    const icon = document.createElement('span');
    icon.className = 'edge-marker-icon';
    icon.textContent = nearest.type;
    const label = document.createElement('span');
    label.textContent = detail;
    const distance = document.createElement('span');
    distance.className = 'edge-marker-distance';
    distance.textContent = distanceLabel;
    button.append(direction, icon, label, distance);
    wrapper.appendChild(button);
    if (group.members.length > 1) {
      const options = document.createElement('div');
      options.className = 'edge-marker-options';
      options.hidden = true;
      if (group.y > height * 0.68) options.classList.add('edge-marker-options-up');
      for (const member of group.members) {
        const option = document.createElement('button');
        option.type = 'button';
        option.className = 'edge-destination-option';
        option.dataset.targetId = member.id;
        option.textContent = `${member.type} ${member.name} · ${fmt(member.distance)} m`;
        options.appendChild(option);
      }
      wrapper.appendChild(options);
    }
    container.appendChild(wrapper);
  }
}
