# PRD — DEMO Mode vs START (Storyline) Mode

**Status:** APPROVED — decisions locked (see Section 12)
**Owner:** OpenCode for Feniks
**Target:** `C:\Users\mped\dawn\eve-idle` (JS idle EVE Online game; server-authoritative Node, 2D canvas client)
**Current STATE_VERSION:** 11 → 12 (this PRD)

---

## 1. Goal

Add two entry modes:

- **DEMO mode** — exactly the current sandbox: 3 systems (Jita/Placid/Domain), 10k ISK, free Rifter, open gates, factions/ambush/threat/drones/loot/crafting. Untouched behavior.
- **START mode** — a guided storyline: the player begins in **Jita** (the "rookie space" for the course) with gates locked, and completes a linear pilot-training mission chain (#1–#8). Each mission teaches a mechanic. Certification (M8) unlocks the gates and the open sandbox continues with all progress kept.

Both modes share one engine. START adds a mission layer; DEMO does not activate it.

## 2. Mission list

| # | Name | Given | Lesson | Objective |
|---|---|---|---|---|
| 1 | Under Attack | Frigate + Weapon I | Engage / weapons | Destroy 1 attacker frigate |
| 2 | Help the Buddies | Passive **range** module | Passive modules, range | Kill 3 short-range frigates; your range module gives an opening volley before their short-range guns bite ("kite" = stay at range) |
| 3 | Last Stand | Nothing | Death | Survive a scripted unwinnable wave; you die, standard death screen |
| 4 | A New Clone | Replacement frigate + weapons | Clones / stations | Take the replacement, dock at the station |
| 5 | Mining 101 | Mining module | Mining | Mine a target amount of ore |
| 6 | Rogue Drones | (drone access unlocked) | Drones | Destroy the rogue drone hub |
| 7 | Crafting ×2 | (blueprints) | Blueprint crafting | (a) craft a Weapon I; (b) craft a Shield Extender II |
| 8 | Certification | — | Gates / systems | Complete the course; gates to Placid/Domain unlock |

## 3. Design principles

- **Server is the source of truth.** Mission state, objectives, spawns, rewards, completion all server-side; client renders mission log/dialogue and sends intents.
- **Missions reuse existing mechanics.** Only genuinely new mechanic: **range advantage** (M2), kept deliberately simple (Decision D2).
- **Linear and unskippable.** Missions complete in order; next starts when the current objective is met.
- **Jita is the training ground.** No new system (D1). Gates inside Jita are locked ("not authorized") until certification.
- **Progress carries forward.** Everything earned in the storyline (ISK, minerals, drones, skills, loot, fitted modules, ships) persists into the open sandbox after certification (D5).
- **DEMO remains as-is.** No mission UI or gating in demo mode.

## 4. Mode & boot flow (Phase 0)

- **Menu on every load** (D4): the client always shows a start menu (DEMO / START) before entering the world.
- **Per-mode save slots**: the save file stores a container `{ demo: <state>|null, story: <state>|null }`. Picking a mode resumes that mode's save if present, else creates a fresh one. Progress in one mode is never clobbered by the other.
- `state.mode: 'demo' | 'story'`. `STATE_VERSION` = **12** (old single saves reset).
- New API: `POST /api/mode { mode }` — switches the server's active state to that mode's save (create if absent), returns `{ state }`.
- `/api/reset` resets the **active** mode's state (default `demo`, so the existing suite keeps working).
- `/api/state` returns `game.view(state)` for the active mode (default `demo`).

### Client (Phase 0)
- `#mode-menu` overlay on load: two buttons (`data-testid="mode-demo"`, `data-testid="mode-story"`). Clicking POSTs `/api/mode` and boots the world.
- E2E `beforeEach` clicks `mode-demo` after `goto('/')`.

## 5. Mission framework (Phase 1)

### Mission state (server)
```js
state.mode            // 'demo' | 'story'
state.mission = {
  active: 'm1' | ... | 'm8' | null,
  step: 0,
  flags: {},          // per-mission bookkeeping (kills, ore, crafted, ...)
  completed: [],      // ordered finished ids
};
```

### Mission definitions (config `MISSIONS`)
```js
m1: {
  id: 'm1', title: 'Under Attack', npc: 'Station A',
  brief: '"We\'re under attack... take out this frigate by flying to them, and firing your guns."',
  gives: { ships: ['frigate'], modules: [{ slot: 'weapon', tier: 1 }], isk: 0 },
  objective: { type: 'kill', enemyType: 'attacker', count: 1 },
  completion: { isk: 500, next: 'm2' },
}
```
- Objective types: `kill` (destroy N of a type), `mine` (mine N ore into cargo), `craft` (craft N of a slot/tier), `dock` (dock at a station), `survive` (M3 special), `certify` (M8 special).
- Mission engine hooks into existing events: combat resolution (kill), mining tick (mine), `craftModule` (craft), docking (dock).
- Scripted spawns: combat missions spawn their targets in Jita on mission start (M1 attacker, M2 three short-range frigates, M3 wave, M6 drone hub). Between missions the space is quiet.

### Client (Phase 1)
- `#mission-tracker` (HUD, story only): current objective + progress.
- `#mission-dialogue`: NPC brief on start, congrats on completion, "Continue" to accept next.

## 6. New mechanic: range advantage (Phase 2, D2)

- **Keep combat stationary** (no movement-in-fight). Kiting is taught in dialogue ("their guns are short-range — your range module lets you hit them before they can hit you").
- Add `range` module to `MODULES`: `{ key: 'range', name: 'Range Amplifier', stat: 'range', tiers: [{ tier:1, cost, bonus: 3 }, ...] }` where `bonus` = **opening volley seconds** added per module tier.
- Enemies get `rangeDelay` (seconds of fight time before their guns start dealing damage). "Short-range" M2 frigates have a base `rangeDelay` (e.g. 2s); normal rats `0`.
- Combat applies: enemy damage starts only after `enemy.rangeDelay + playerRangeBonus` seconds (player's fitted range modules extend the free-fire window). Player damage always applies immediately.
- M2: player is given the frigate with a Range Amplifier I; the 3 frigates are short-range → a clear free-fire window, teaching that range wins the opening.

## 7. Scripted death (Phase 3, D3)

- M3: NPC warns no escape (warp drive down); an unwinnable wave spawns. Fight runs on the normal combat loop; the wave is balanced so the player loses.
- Uses the standard death path (death screen, killmail, insurance). The free-loaner-Rifter respawn is **suppressed** for this scripted death (the fleet ends empty); M4's grant **is** the clone respawn.
- M4 explains clones/stations, grants a replacement frigate fitted with weapons, objective = dock at the station.

## 8. Crafting missions (Phase 4, D6)

- M7 has **two** objectives: (a) craft a Weapon I from a blueprint; (b) craft a Shield Extender II. Both require mining ore → haul home → dock → craft (reuses existing blueprint flow; recipes taken from `BLUEPRINTS`).

## 9. Certification & handoff (Phase 5, D5)

- M8: NPC congratulates; pilot certification; gates in Jita unlock to Placid and Domain.
- After M8 the storyline's "campaign" is complete; the open sandbox (factions, ambush, threat, all systems, full market) continues with all progress kept. Future PRDs can extend the story.

## 10. Phases (implementation order)

| Phase | Scope | Key deliverables | Tests |
|---|---|---|---|
| **P0** | Modes & boot | `STATE_VERSION` 12; `state.mode`; per-mode save container; `POST /api/mode`; start menu; `createInitialState(now, seed, mode)`; E2E beforeEach clicks `mode-demo` | unit (mode/version/save container), API (`/api/mode`, reset), E2E (menu → both modes) |
| **P1** | Mission framework + M1 | `MISSIONS` schema; `mission` state; engine hooks (kill/mine/craft/dock); tracker + dialogue UI; gate lock scaffolding; M1 end-to-end | unit (engine, order, kill objective), API, E2E (M1) |
| **P2** | Range + M2 | `range` module, enemy `rangeDelay`, combat free-fire window, M2 end-to-end | unit (range math), API, E2E (M2) |
| **P3** | M3 + M4 | Scripted wave, loaner suppression, replacement grant, M4 dock | unit (M3 loss, M4), API, E2E |
| **P4** | M5 + M6 + M7 | mine objective, drone hub, craft objectives, drone unlock | unit, API, E2E (M5–M7) |
| **P5** | M8 + handoff + full pass | Certification, gate unlock, open-world continue; final full suite | E2E full chain m1→m8 → sandbox; all suites green |

## 11. Testing strategy

- **Unit** (`tests/game.test.js`): mode creation, version gating, save container, mission engine (linear order, objective types, rewards, scripted death + loaner suppression), range free-fire math.
- **API** (`tests/api.test.js`): `/api/mode` (create/resume per mode), `/api/reset` (per active mode), mission state exposure, gate rejection pre-cert.
- **E2E** (`tests/e2e.spec.js`): menu renders + both modes boot; beforeEach clicks `mode-demo`; new story tests play m1→m8; certification unlocks gates.
- Full suite green at each phase.

## 12. Decisions (locked)

- **D1** Missions run in **Jita** (no new system). Gates locked until certification.
- **D2** **Simplified range advantage**: stationary combat; `range` module grants opening volley seconds; enemies have `rangeDelay`; kiting taught via dialogue.
- **D3** **Scripted unwinnable wave** in M3; standard death path; loaner suppressed; M4 = clone respawn + station lesson.
- **D4** **Menu on every load**; **per-mode save slots** (`demo`, `story`) in one file.
- **D5** Certification **unlocks the open sandbox, progress kept**; storyline ends there for now.
- **D6** **Two craft missions** (Weapon I, Shield Extender II).

## 13. Out of scope (this pass)

- Story content after certification; multiplayer/instancing; security levels; achievements; changes to DEMO behavior.
