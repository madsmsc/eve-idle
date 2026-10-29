'use strict';

// The hangar / market overlay: ship tree, skills, and barter. Its DOM is rebuilt when the
// overlay opens or when state changes while it is open.
import { Node } from '../core/node.js';
import { fmt } from '../core/util.js';

const ROMAN = ['—', 'I', 'II', 'III', 'IV'];
const SHIP_LANES = [
  { key: 'drone', label: 'Drone Combat', description: 'Drone-focused combat hulls' },
  { key: 'missile', label: 'Missile Combat', description: 'Missile-focused combat hulls' },
  { key: 'projectile', label: 'Projectile Combat', description: 'Projectile-focused combat hulls' },
  { key: 'laser', label: 'Laser Combat', description: 'Laser-focused combat hulls' },
  { key: 'mining', label: 'Mining', description: 'Dedicated mining hulls' },
  { key: 'legacy', label: 'Legacy', description: 'Versatile hulls outside the specialized lines' },
];
const LEGACY_SHIP_LANES = {
  rifter: 'projectile',
  vexor: 'drone',
  manticore: 'missile',
};

function shipLaneForEntry(entry) {
  if (entry.familyKey === 'legacy') return LEGACY_SHIP_LANES[entry.type] || 'legacy';
  if (entry.role === 'miner') return 'mining';
  return entry.weaponType || 'legacy';
}

function itemName(catalog, key) {
  return (catalog.minerals[key] || catalog.components[key] || {}).name || key;
}

function recipeText(recipe, catalog) {
  return Object.entries(recipe).map(([key, amount]) => `${fmt(amount)} ${itemName(catalog, key)}`).join(' + ');
}

function shipModelMarkup(type) {
  const hulls = {
    rifter: 'M50 4 61 34 56 52 50 46 44 52 39 34Z M39 34 23 43 31 48 45 42 M61 34 77 43 69 48 55 42',
    falcon: 'M50 5 61 34 87 48 68 47 58 57 50 49 42 57 32 47 13 48 39 34Z M50 10 54 37 50 43 46 37Z',
    raptor: 'M50 3 58 29 82 48 61 45 56 56 50 49 44 56 39 45 18 48 42 29Z M50 8 53 36 50 42 47 36Z',
    vexor: 'M50 5 59 34 76 41 70 50 57 46 52 57 48 57 43 46 30 50 24 41 41 34Z M24 41 9 51 29 48 M76 41 91 51 71 48',
    gnosis: 'M50 6 65 22 71 43 59 55 41 55 29 43 35 22Z M35 26 18 36 31 39 M65 26 82 36 69 39 M42 24 50 15 58 24 56 43 50 49 44 43Z',
    manticore: 'M50 3 59 30 94 46 70 48 58 57 50 48 42 57 30 48 6 46 41 30Z M50 9 54 37 50 43 46 37Z',
    brutix: 'M50 5 64 18 70 37 83 48 64 49 58 58 42 58 36 49 17 48 30 37 36 18Z M40 23 50 15 60 23 57 43 50 49 43 43Z M30 37 12 41 23 49 M70 37 88 41 77 49',
  };
  return `<svg viewBox="0 0 100 64" aria-hidden="true"><path class="ship-model-hull" d="${hulls[type] || hulls.rifter}"/><path class="ship-model-core" d="M50 13 55 31 50 40 45 31Z"/></svg>`;
}

export class HangarNode extends Node {
  // PUBLIC
  constructor(app) {
    super(app);
    this.pendingBlueprintPurchases = new Set();
    this.blueprintPurchaseCooldowns = new Map();
    this.lastRefreshKey = null;
  }

  // PUBLIC
  refresh() {
    const state = this.app.state;
    const ship = state.activeShip;
    const refreshKey = JSON.stringify({
      mode: state.mode,
      docked: state.docked,
      dockedStation: state.dockedStation,
      mission: state.mission,
      agentMission: state.agentMission,
      skillPointRate: state.skillPointRate,
      skillTraining: state.skillTraining,
      trainableSkills: Object.entries(state.skillTraining)
        .filter(([, training]) => training.canTrain)
        .map(([key]) => key),
      achievements: state.achievements,
      shipProgression: state.shipProgression,
      ships: state.ships.map(({ id, type }) => ({ id, type })),
      activeShipId: state.activeShipId,
      activeShip: ship && {
        id: ship.id,
        type: ship.type,
        fitting: ship.fitting,
        slots: ship.slots,
      },
      materials: state.materials,
      loot: state.loot,
      blueprints: state.blueprints,
      storage: state.storage,
      actionAvailability: state.actionAvailability,
      systemId: state.system && state.system.id,
      systemNames: state.systemNames,
    });
    document.getElementById('hangar-sp').textContent =
      `${Math.floor(state.skillPoints || 0)} SP · ${state.skillPointRate} SP/s, offline`;
    if (refreshKey === this.lastRefreshKey) return this;

    this.#renderHangar();
    this.app.ui.inventory.renderFitting();
    this.app.ui.inventory.renderStorage();
    if (!this.app.state.docked) {
      document.querySelectorAll('#hangar button[data-action]').forEach((button) => {
        button.disabled = true;
      });
    }
    this.lastRefreshKey = refreshKey;
    return this;
  }
  // Display one station service selected from the persistent menu rail.
  // PUBLIC
  showService(name) {
    const hangar = document.getElementById('hangar');
    hangar.querySelectorAll('.hangar-body section[data-panel]').forEach((section) => {
      section.classList.toggle('active', section.dataset.panel === name);
    });
  }

  // PUBLIC
  async buyBlueprint(type, tier) {
    const key = `${type}:${tier}`;
    if (this.pendingBlueprintPurchases.has(key)) return false;
    const expiresAt = this.blueprintPurchaseCooldowns.get(key) || 0;
    if (expiresAt > Date.now()) return false;

    this.pendingBlueprintPurchases.add(key);
    this.#renderHangar();
    const success = await this.app.doAction('buy-blueprint', { kind: 'module', type, tier });
    this.pendingBlueprintPurchases.delete(key);
    if (!success) {
      this.#renderHangar();
      return false;
    }

    const cooldownEndsAt = Date.now() + 1000;
    this.blueprintPurchaseCooldowns.set(key, cooldownEndsAt);
    this.#renderHangar();
    setTimeout(() => {
      if (this.blueprintPurchaseCooldowns.get(key) !== cooldownEndsAt) return;
      this.blueprintPurchaseCooldowns.delete(key);
      this.#renderHangar();
    }, Math.max(0, cooldownEndsAt - Date.now()));
    return true;
  }

  // PRIVATE
  #renderHangar() {
    const state = this.app.state;
    const catalog = this.app.catalog;

    const shipTree = document.getElementById('hangar-ship-tree');
    shipTree.innerHTML = '';
    const flow = document.createElement('div');
    flow.className = 'ship-tree-flow';
    const header = document.createElement('div');
    header.className = 'ship-tree-header';
    const laneHeader = document.createElement('span');
    laneHeader.textContent = 'Ship progression';
    header.appendChild(laneHeader);
    for (let tierIndex = 0; tierIndex < catalog.shipProgression.length; tierIndex++) {
      const tier = catalog.shipProgression[tierIndex];
      const tierHeader = document.createElement('h3');
      tierHeader.textContent = tier.className || `Tier ${tier.tier}`;
      tierHeader.dataset.testid = `ship-tree-tier-${tier.tier}`;
      header.appendChild(tierHeader);
      if (tierIndex < catalog.shipProgression.length - 1) {
        const spacer = document.createElement('span');
        spacer.className = 'ship-tree-header-spacer';
        spacer.setAttribute('aria-hidden', 'true');
        header.appendChild(spacer);
      }
    }
    flow.appendChild(header);

    for (const lane of SHIP_LANES) {
      const row = document.createElement('section');
      row.className = 'ship-tree-lane';
      row.dataset.lane = lane.key;
      row.dataset.testid = `ship-tree-lane-${lane.key}`;
      const label = document.createElement('div');
      label.className = 'ship-tree-lane-label';
      label.innerHTML = `<strong>${lane.label}</strong><span>${lane.description}</span>`;
      row.appendChild(label);

      for (let tierIndex = 0; tierIndex < catalog.shipProgression.length; tierIndex++) {
        const tier = catalog.shipProgression[tierIndex];
        const cell = document.createElement('div');
        cell.className = 'ship-tree-cell';
        const entries = tier.ships.filter((entry) => shipLaneForEntry(entry) === lane.key);
        for (const entry of entries) {
          const definition = catalog.ships[entry.type];
          const progression = state.shipProgression[entry.type];
          const ownedShips = state.ships.filter((ship) => ship.type === entry.type);
          const missingSkills = progression.missingSkills
            .map(({ skill, level }) => `${catalog.skills[skill].name} ${level} (you have ${state.skillTraining[skill].level})`);
          const card = document.createElement('article');
          card.className = `ship-tree-entry ${progression.skillsReady ? 'skill-ready' : 'skills-locked'}`;
          card.dataset.testid = `ship-tree-${entry.type}`;
          card.dataset.role = entry.role || 'legacy';
          const ownedText = ownedShips.length ? ` · Owned: ${ownedShips.length}` : '';
          const statusText = progression.skillsReady
            ? `Skills ready${progression.blueprintReady ? ' · Blueprint acquired' : ' · Blueprint not acquired'}`
            : `Requires ${missingSkills.join(', ')}`;
          const actions = ownedShips.map((ship) => {
            const isActive = state.activeShipId === ship.id;
            const canUse = progression.skillsReady && !isActive;
            return `<button class="mini" data-action="set-active" data-id="${ship.id}" data-testid="ship-${ship.id}-active" title="${canUse ? 'Switch to this ship.' : statusText}" ${canUse ? '' : 'disabled'}>${isActive ? 'Active' : 'Use ship'}</button>`;
          }).join('');
          card.innerHTML = `
            <div class="ship-tree-model" title="${definition.name} hull model">${shipModelMarkup(entry.type)}</div>
            <div class="ship-tree-info">
              <strong>${definition.name}</strong>
              <span class="sub">${entry.role || 'Existing hull'}${entry.weaponType ? ` · ${entry.weaponType}` : ''} · ${definition.mining}/s mining · ${definition.dps} DPS · ${fmt(definition.cargo)} cargo · ${definition.speedMultiplier || 1}× speed</span>
              <span class="ship-tree-status">${statusText}${ownedText}</span>
              <span class="actions">${actions}</span>
            </div>`;
          cell.appendChild(card);
        }
        if (!entries.length) {
          const empty = document.createElement('span');
          empty.className = 'ship-tree-empty';
          empty.textContent = '—';
          cell.appendChild(empty);
        }
        row.appendChild(cell);
        if (tierIndex < catalog.shipProgression.length - 1) {
          const arrow = document.createElement('div');
          arrow.className = 'ship-tree-arrow';
          const nextTier = catalog.shipProgression[tierIndex + 1];
          const nextEntries = nextTier.ships.filter((entry) => shipLaneForEntry(entry) === lane.key);
          const nextProgression = nextEntries.map((entry) => state.shipProgression[entry.type]);
          const canProgress = nextProgression.some((item) => item.skillsReady);
          const hasLaneShips = entries.length > 0 && nextEntries.length > 0;
          arrow.classList.toggle('not-applicable', !hasLaneShips);
          arrow.classList.toggle('skills-locked', nextEntries.length > 0 && !canProgress);
          arrow.dataset.testid = `ship-tree-arrow-${lane.key}-${tier.tier}-${nextTier.tier}`;
          if (nextEntries.length && !canProgress) {
            const requirements = nextEntries.map((entry, index) => {
              const skills = nextProgression[index].missingSkills
                .map(({ skill, level }) => `${catalog.skills[skill].name} Lv${level}`)
                .join(', ');
              return `${catalog.ships[entry.type].name}: ${skills}`;
            });
            arrow.title = `Unlock ${nextTier.className}: ${requirements.join(', ')}`;
            arrow.setAttribute('aria-label', arrow.title);
          } else if (!hasLaneShips) {
            arrow.title = 'No hull progression in this class';
            arrow.setAttribute('aria-label', arrow.title);
          } else {
            arrow.title = `Progress to ${nextTier.className}`;
            arrow.setAttribute('aria-label', arrow.title);
          }
          arrow.innerHTML = '<svg viewBox="0 0 36 24"><path d="M2 12h27M20 3l9 9-9 9"/></svg>';
          if (nextEntries.length && !canProgress) {
            const gate = document.createElement('span');
            gate.className = 'ship-tree-gate';
            gate.textContent = 'LOCKED';
            arrow.appendChild(gate);
          }
          row.appendChild(arrow);
        }
      }
      flow.appendChild(row);
    }
    shipTree.appendChild(flow);

    const skills = document.getElementById('hangar-skills');
    const spLabel = document.getElementById('hangar-sp');
    const openCategories = new Set(
      [...skills.querySelectorAll('details[data-skill-category][open]')]
        .map((group) => group.dataset.skillCategory)
    );
    skills.innerHTML = '';
    spLabel.textContent = `${Math.floor(state.skillPoints || 0)} SP · ${state.skillPointRate} SP/s, offline`;
    const skillDefinitions = Object.values(catalog.skills);
    const trainedSkills = skillDefinitions.filter((definition) => state.skillTraining[definition.key].level > 0);
    const trainedLevels = trainedSkills.reduce((sum, definition) => sum + state.skillTraining[definition.key].level, 0);
    const bonusNames = {
      mining: 'Mining output',
      miningCycle: 'Mining cycle speed',
      miningRange: 'Mining range',
      miningDrone: 'Mining drone output',
      cargo: 'Cargo capacity',
      dps: 'General weapon damage',
      projectileDps: 'Projectile damage',
      missileDps: 'Missile damage',
      laserDps: 'Laser damage',
      droneDps: 'Drone damage',
      shield: 'Shield capacity',
      hull: 'Hull capacity',
      speed: 'Navigation speed',
      acceleration: 'Acceleration',
      evasion: 'Evasion',
      damageReduction: 'Damage control',
      moduleEffectiveness: 'Module strength',
    };
    const activeBonuses = Object.entries(state.skillMults || {})
      .filter(([, multiplier]) => multiplier > 1)
      .map(([stat, multiplier]) => `<span class="skill-bonus">${bonusNames[stat] || stat}: +${Math.round((multiplier - 1) * 100)}%</span>`)
      .join('');
    const dashboard = document.createElement('section');
    dashboard.className = 'skill-dashboard';
    dashboard.dataset.testid = 'skill-dashboard';
    dashboard.setAttribute('aria-label', 'Skill training overview');
    dashboard.innerHTML = `
      <div class="skill-dashboard-count"><strong>${trainedSkills.length}/${skillDefinitions.length}</strong><span>skills trained</span><span>${trainedLevels} total levels</span></div>
      <div class="skill-dashboard-bonuses"><strong>Current bonuses</strong><div>${activeBonuses || '<span class="sub">Train skills to unlock bonuses.</span>'}</div></div>`;
    skills.appendChild(dashboard);
    const categories = {};
    for (const def of skillDefinitions) {
      (categories[def.category] = categories[def.category] || []).push(def);
    }
    for (const cat of Object.keys(categories)) {
      const definitions = categories[cat];
      const currentLevels = definitions.reduce((sum, def) =>
        sum + state.skillTraining[def.key].level, 0
      );
      const possibleLevels = definitions.reduce((sum, def) => sum + def.maxLevel, 0);
      const group = document.createElement('details');
      group.className = 'skill-theme';
      group.dataset.skillCategory = cat;
      group.dataset.testid = `skill-theme-${cat.toLowerCase().replace(/[^a-z0-9]+/g, '-')}`;
      group.open = openCategories.has(cat);
      const summary = document.createElement('summary');
      summary.innerHTML = `
        <span class="skill-theme-name">${cat}</span>
        <span class="skill-theme-progress">${currentLevels}/${possibleLevels} levels · ${definitions.length} skills</span>`;
      group.appendChild(summary);
      const cards = document.createElement('div');
      cards.className = 'skill-theme-cards';
      group.appendChild(cards);
      for (const def of categories[cat]) {
        const training = state.skillTraining[def.key];
        const lvl = training.level;
        const card = document.createElement('article');
        card.className = `skill-card${lvl > 0 ? ' trained' : ''}${training.requirementsMet ? '' : ' locked'}`;
        card.dataset.testid = `skill-card-${def.key}`;
        const effect = def.effect
          ? `Current bonus +${Math.round(def.effect.pctPerLevel * lvl * 100)}% · +${Math.round(def.effect.pctPerLevel * 100)}% per level`
          : def.description;
        const missingRequirements = training.missingRequirements
          .map(({ skill, level }) => `${catalog.skills[skill].name} Lv${level}`)
          .join(', ');
        const status = training.maxed
          ? 'Maximum level reached'
          : missingRequirements
            ? `Requires ${missingRequirements}`
            : `${fmt(training.cost)} SP to train next level`;
        const progress = lvl / def.maxLevel * 100;
        card.innerHTML = `
          <div class="skill-card-heading"><strong>${def.name}</strong><span class="skill-level-label">Lv ${lvl}/${def.maxLevel}</span></div>
          <div class="skill-level-track" role="img" aria-label="Level ${lvl} of ${def.maxLevel}"><span style="width:${progress}%"></span></div>
          <p>${def.description}</p>
          <span class="skill-effect">${effect}</span>
          <div class="skill-card-footer"><span class="sub">${status}</span>
            <button class="mini" data-action="train-skill" data-skill="${def.key}" data-testid="skill-${def.key}" title="${missingRequirements || status}" ${training.maxed || !training.canTrain ? 'disabled' : ''}>${training.maxed ? 'Max' : 'Train'}</button>
          </div>`;
        cards.appendChild(card);
      }
      skills.appendChild(group);
    }

    const achievementsEl = document.getElementById('hangar-achievements');
    achievementsEl.innerHTML = '';
    for (const achievement of state.achievements || []) {
      const row = document.createElement('div');
      row.className = `row${achievement.unlocked ? ' active' : ''}`;
      row.textContent = `${achievement.unlocked ? '✓' : '○'} ${achievement.name} — ${achievement.description} (${fmt(achievement.progress)}/${fmt(achievement.target)})`;
      achievementsEl.appendChild(row);
    }

    this.#renderStoryline(state);
    this.#renderStarMap(state);
    this.#renderAgentMissions(state, catalog);

    const tradeUp = document.getElementById('market-trade-up');
    const blueprints = document.getElementById('market-blueprints');
    tradeUp.innerHTML = '';
    blueprints.innerHTML = '';
    const exchangeFamilies = [
      ['ore', catalog.oreExchange, catalog.minerals],
      ['components', catalog.componentExchange, catalog.components],
    ];
    for (const [family, ladder, definitions] of exchangeFamilies) {
      const header = document.createElement('div');
      header.className = 'skill-cat';
      header.textContent = family === 'ore' ? 'Ore exchange — 3 lower tier → 1 higher tier' : 'Component exchange — 3 lower tier → 1 higher tier';
      tradeUp.appendChild(header);
      for (let index = 0; index < ladder.length - 1; index++) {
        const item = ladder[index];
        const next = ladder[index + 1];
        const row = document.createElement('div');
        row.className = 'row';
        const availability = state.actionAvailability.exchange[`${family}:${item}`];
        row.innerHTML = `<span class="label">${definitions[item].name} → ${definitions[next].name} <span class="sub">Have ${fmt(availability.count)}</span></span><span class="actions"><button class="mini" data-action="exchange-items" data-family="${family}" data-item="${item}" data-amount="3" data-testid="exchange-${family}-${item}" ${availability.canExchange ? '' : 'disabled'}>3 to 1</button></span>`;
        tradeUp.appendChild(row);
      }
    }
    const blueprintHeader = document.createElement('div');
    blueprintHeader.className = 'sub';
    blueprintHeader.textContent = 'NPC blueprints — available at any station; each is consumed during manufacturing';
    blueprints.appendChild(blueprintHeader);
    for (const key of catalog.npcBlueprints || []) {
      const [, slotType, tierText] = key.split(':');
      const tier = Number(tierText);
      const def = catalog.modules[slotType];
      const cost = catalog.blueprintCosts[key];
      const availability = state.actionAvailability.buyBlueprints[key];
      const purchaseKey = `${slotType}:${tier}`;
      const cooldownActive = (this.blueprintPurchaseCooldowns.get(purchaseKey) || 0) > Date.now();
      const purchasePending = this.pendingBlueprintPurchases.has(purchaseKey);
      const row = document.createElement('div');
      row.className = `row${purchasePending || cooldownActive ? ' market-purchase-flash' : ''}`;
      row.dataset.testid = `market-blueprint-${slotType}-t${tier}`;
      row.innerHTML = `<span class="label">${def.name} ${ROMAN[tier]} Blueprint <span class="sub">${recipeText(cost, catalog)}</span></span><span class="actions"><button class="mini" data-action="buy-blueprint" data-kind="module" data-type="${slotType}" data-tier="${tier}" data-testid="buy-blueprint-${slotType}-t${tier}" ${availability.canBuy && !purchasePending && !cooldownActive ? '' : 'disabled'}>Buy blueprint</button></span>`;
      blueprints.appendChild(row);
    }
    const dropNote = document.createElement('div');
    dropNote.className = 'sub';
    dropNote.textContent = 'Higher-tier module and ship blueprints are recovered from enemy loot; NPCs do not sell them.';
    blueprints.appendChild(dropNote);
  }

  // PRIVATE
  // Systems as security-colored nodes, joined by a line for every gate link.
  #renderStarMap(state) {
    const container = document.getElementById('hangar-star-map');
    if (!container) return;
    const systems = (state.systemNames || []).filter((item) => item.map);
    const byId = new Map(systems.map((item) => [item.id, item]));
    const securityColor = (security) => `hsl(${Math.round(Math.max(0, Math.min(1, security)) * 120)}, 80%, 55%)`;
    const currentId = state.system ? state.system.id : null;
    const drawn = new Set();
    const lines = [];
    for (const system of systems) {
      for (const link of system.links || []) {
        const other = byId.get(link);
        const key = [system.id, link].sort().join('|');
        if (!other || drawn.has(key)) continue;
        drawn.add(key);
        lines.push(`<line x1="${system.map.x}" y1="${system.map.y}" x2="${other.map.x}" y2="${other.map.y}" class="star-map-link" data-testid="star-link-${system.id}-${link}"/>`);
      }
    }
    const nodes = systems.map((system) => {
      const current = system.id === currentId;
      return `<g class="star-map-system${current ? ' current' : ''}" data-testid="star-system-${system.id}" data-security="${system.security}">
        <title>${system.name} — security ${system.security.toFixed(1)}${current ? ' (you are here)' : ''}</title>
        <circle cx="${system.map.x}" cy="${system.map.y}" r="${current ? 3.4 : 2.6}" fill="${securityColor(system.security)}"/>
        ${current ? `<circle cx="${system.map.x}" cy="${system.map.y}" r="5" class="star-map-here"/>` : ''}
        <text x="${system.map.x}" y="${system.map.y + 6.2}" text-anchor="middle">${system.name} ${system.security.toFixed(1)}</text>
      </g>`;
    });
    container.innerHTML = `<svg viewBox="-4 -2 108 102" class="star-map-svg" role="img" aria-label="Star map">${lines.join('')}${nodes.join('')}</svg>`;
  }

  // PRIVATE
  // Storyline (pilot-training) card: turn the completed mission in and accept
  // the next one. The storyline's missions are handed off at a station hangar —
  // the m1 intro is the only one that starts on its own.
  #renderStoryline(state) {
    const panel = document.getElementById('hangar-storyline');
    if (!panel) return;
    panel.innerHTML = '';
    if (!state.mission || state.mode !== 'story') return;

    const card = document.createElement('article');
    card.className = 'agent-card storyline-card';
    card.dataset.testid = 'storyline-card';

    const offered = state.mission.offered;
    if (offered) {
      const name = document.createElement('strong');
      name.textContent = offered.title;
      const npc = document.createElement('span');
      npc.className = 'agent-role';
      npc.textContent = offered.npc;
      const objective = document.createElement('span');
      objective.className = 'sub';
      objective.textContent = offered.brief;
      const accept = document.createElement('button');
      accept.className = 'mini';
      accept.dataset.action = 'accept-mission';
      accept.dataset.testid = 'accept-mission';
      accept.disabled = !state.docked;
      accept.textContent = 'Accept mission';
      card.append(name, npc, objective, accept);
    } else if (state.mission.active) {
      const m = state.mission;
      const name = document.createElement('strong');
      name.textContent = m.title;
      const objective = document.createElement('span');
      objective.className = 'sub';
      let text = m.objective || '';
      if (m.progress != null) {
        text += Array.isArray(m.progress)
          ? ` (${m.progress.map((p, i) => `${p}/${m.target[i]}`).join(', ')})`
          : ` (${m.progress}/${m.target})`;
      }
      objective.textContent = text;
      card.append(name, objective);
      if (m.ready) {
        const hint = document.createElement('span');
        hint.className = 'agent-role';
        hint.textContent = 'Objective complete — turn the mission in.';
        const turnin = document.createElement('button');
        turnin.className = 'mini';
        turnin.dataset.action = 'turnin-mission';
        turnin.dataset.testid = 'turnin-mission';
        turnin.disabled = !state.docked;
        turnin.textContent = 'Turn in mission';
        card.append(hint, turnin);
      }
    } else if (state.mission.completed && state.mission.completed.length) {
      const name = document.createElement('strong');
      name.textContent = 'Story complete';
      const objective = document.createElement('span');
      objective.className = 'sub';
      objective.textContent = 'Your certification is filed. The gates are open — fly where you will.';
      card.append(name, objective);
    } else {
      card.hidden = true;
    }
    panel.appendChild(card);
  }

  // PRIVATE
  #renderAgentMissions(state, catalog) {
    const panel = document.getElementById('hangar-agent-missions');
    const summary = document.getElementById('agent-mission-cooldown');
    const missionView = state.agentMission;
    panel.innerHTML = '';
    summary.textContent = missionView.station
      ? `${missionView.station.name} · Complete contracts to unlock the next offer from each agent.`
      : 'Dock at a station to meet its agents. Accepted contracts continue progressing in space.';

    const localAgentIds = new Set(missionView.agents.map((agent) => agent.id));
    const distantContracts = missionView.active.filter((mission) => !localAgentIds.has(mission.agentId));
    if (distantContracts.length) {
      const heading = document.createElement('h4');
      heading.className = 'agent-section-heading';
      heading.textContent = 'Other active contracts';
      panel.appendChild(heading);
      for (const mission of distantContracts) {
        const row = document.createElement('div');
        row.className = 'agent-active-elsewhere';
        row.textContent = `${mission.agentName} · ${mission.stationName}: ${mission.name} — ${mission.objective} (${fmt(mission.progress)}/${fmt(mission.target)})`;
        panel.appendChild(row);
      }
    }

    if (!missionView.station) {
      if (!missionView.active.length) {
        const empty = document.createElement('p');
        empty.className = 'agent-empty';
        empty.textContent = 'No active contracts. Dock at a station to meet its agents.';
        panel.appendChild(empty);
      }
      return;
    }

    const heading = document.createElement('h4');
    heading.className = 'agent-section-heading';
    heading.textContent = `Agents at ${missionView.station.name}`;
    panel.appendChild(heading);
    for (const agent of missionView.agents) {
      const card = document.createElement('article');
      card.className = 'agent-card';
      card.dataset.testid = `agent-card-${agent.role}`;
      const header = document.createElement('header');
      header.className = 'agent-card-header';
      const identity = document.createElement('div');
      identity.className = 'agent-identity';
      const name = document.createElement('strong');
      name.textContent = agent.name;
      const title = document.createElement('span');
      title.className = 'agent-role';
      title.textContent = agent.title;
      identity.append(name, title);
      const record = document.createElement('span');
      record.className = 'agent-completed';
      record.textContent = `${fmt(agent.completed)} completed`;
      header.append(identity, record);
      card.appendChild(header);

      if (agent.active) {
        const mission = document.createElement('div');
        mission.className = 'agent-mission-current';
        const missionName = document.createElement('strong');
        missionName.textContent = agent.active.name;
        const objective = document.createElement('span');
        objective.className = 'sub';
        objective.textContent = `${agent.active.objective} · reward ${recipeText(agent.active.rewardItems || {}, catalog)}`;
        const progress = document.createElement('div');
        progress.className = 'agent-progress';
        progress.setAttribute('role', 'progressbar');
        progress.setAttribute('aria-valuemin', '0');
        progress.setAttribute('aria-valuemax', String(agent.active.target));
        progress.setAttribute('aria-valuenow', String(agent.active.progress));
        const fill = document.createElement('span');
        fill.style.width = `${Math.min(100, agent.active.progress / agent.active.target * 100)}%`;
        progress.appendChild(fill);
        const footer = document.createElement('div');
        footer.className = 'agent-mission-footer';
        const count = document.createElement('span');
        count.className = 'sub';
        count.textContent = `${fmt(agent.active.progress)} / ${fmt(agent.active.target)}`;
        const cancel = document.createElement('button');
        cancel.className = 'mini danger';
        cancel.dataset.action = 'cancel-agent-mission';
        cancel.dataset.agentId = agent.id;
        cancel.dataset.testid = `cancel-agent-mission-${agent.role}`;
        cancel.textContent = 'Abandon';
        footer.append(count, cancel);
        mission.append(missionName, objective, progress, footer);
        card.appendChild(mission);
      } else {
        const offer = document.createElement('div');
        offer.className = 'agent-mission-offer';
        const missionName = document.createElement('strong');
        missionName.textContent = agent.offer.name;
        const objective = document.createElement('span');
        objective.className = 'sub';
        objective.textContent = `${agent.offer.objective} · reward ${recipeText(agent.offer.rewardItems || {}, catalog)}`;
        const accept = document.createElement('button');
        accept.className = 'mini';
        accept.dataset.action = 'accept-agent-mission';
        accept.dataset.agentId = agent.id;
        accept.dataset.testid = `accept-agent-mission-${agent.role}`;
        accept.disabled = !state.docked;
        accept.textContent = 'Accept contract';
        offer.append(missionName, objective, accept);
        card.appendChild(offer);
      }
      panel.appendChild(card);
    }
  }

}
