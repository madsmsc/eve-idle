# Story-mode verification, autopilot inefficiency penalty + banner, clean-code refactor

## Goal

Four sequential, individually-verifiable steps, each ending with the full test suite green so the user can review and commit one step at a time:

1. **Story mode works with a hangar-based mission lifecycle**: server boots, missions m1–m9 all complete, **turning in a finished mission and accepting the next one must happen at a station hangar while docked** (sole exception: m1 auto-starts when the story boots), certification unlocks gates, and the game continues as an open sandbox after the story.
2. **Autopilot inefficiency penalty**: while autopilot is enabled, ship speed, acceleration, mining speed, weapon damage, and drone rates run at a reduced multiplier defined by **one** named constant (default **1/4**), so manual piloting feels better but AFK autopilot is still worth it.
3. **On-screen banner**: when autopilot is enabled, large centered letters read "due to AI inefficiencies, all systems running at 1/4 capacity".
4. **Clean-code refactor**: split the 2,646-line `server/game.js` into smaller well-named files with small well-named methods; no behavior change; all tests stay green.

## Current state (verified)

- **Data file resolved**: `server/data/enemies.json` was missing (`.gitignore:2` `data/` swallowed it); the user pulled commit `224a09d "added server data"` and it is now present and tracked. Shape matches `loadEnemyData()` (`server/config.js:74-96`): tiers `novice/standard/elite`, types `pirate/gang/faction/dread/dronehub`. Note for the executor: verify it's actually on disk before starting (`Test-Path server/data/enemies.json`); the bare `data/` pattern still ignores any *future* `server/data/` files — optionally change it to `/data/` in Step 1.
- **Mission engine is complete and server-side** (all in `server/game.js`): `MISSIONS`/`MISSION_ORDER` at `server/config.js:266,271-352` (m1 kill attacker, m2 kill 3 shortrange, m3 scripted death, m4 dock, m5 mine 40, m6 kill dronhub, m7 craft weapon I + shield II, m8 dialogue certification, m9 kill 2 placidraiders in `sys_1`). Engine today: `startMission` `game.js:2197-2206`, `spawnMissionEnemies` `2227-2253`, `grantMissionRewards` `2132-2147`, `missionDone` `2256-2270`, `evaluateMission` `2275-2294` (auto-completes + auto-starts the next mission by `MISSION_ORDER` index — **Step 1 replaces this with the hangar turn-in/accept flow**), `missionAction` `2298-2310` (only `continue`), hooks at `game.js:1699-1709` (kill/death), `1507-1512` (mine), `750-758` (craft), `2280` (dock). Gate lock for story pre-cert: `gateJump` `game.js:2063-2102`, check `2069-2071` (rejects until `completed` includes `'m8'`). After m9 today: `active = null` (`2289-2293`) → open sandbox.
- **Client mission UI**: `#mission-tracker`/`#mission-dialogue` (`public/index.html:107,110-116`), rendered in `HudNode.#renderMission()` (`public/ui/hud.js:243-272`), dialogue shows the brief once per mission, `#mission-continue` → `app.doAction('mission',{action:'continue'})` (`public/core/input.js:145-148`); only m8's `dialogue` objective is advanced by it. Mode menu `#mode-menu` → `POST /api/mode` (`server/index.js:448-501`, story save boots into m1 via `missionStartNeeded` → `startMission(…,'m1')` at `493-495`).
- **Autopilot is 100% server-side**: `state.autoPilotMode` (`game.js:1013`), `setAutopilot` `1971-1977`, `runAutopilot` `1284-1369` (called in `tick()` `1559`), auto mining `mineActive` `1166-1194` (called `1566-1568`), combat tick `1586-1604`. Exposed as `v.autoPilotMode` (`game.js:2511`); client stores it as `app.autoPilot` (`public/core/app.js:130-131`).
- **Constants to penalize** (all in `server/config.js`): `MAX_SPEED = 1200` (404), `MAX_ACCELERATION = 180` (405), `MINING_RATE_MULTIPLIER = 0.5` (398) applied in `shipMining()` `game.js:232-235`; DPS via `effectivePlayerDps()` `game.js:856-858`; movement caps in `moveVelocityToward` `1393-1415` and `advanceNavigation` `1417-1495`; drones `droneBonus()` `591-599`. Client interpolation caps: `constants.maxAcceleration` in `public/core/player.js:34-38`, `constants.maxSpeed` in `public/view/ship.js:215-217`, `public/ui/hud.js:171`, `public/ui/inventory.js:161`.
- **Banner pattern to mirror**: `#combat-banner` div (`public/index.html:80`) toggled per frame in `HudNode.#refreshFast()` (`public/ui/hud.js:156-240`), `.combat-banner` CSS `public/style.css:272-285` (top-center pill).
- **Stale test expectations** (ISK-era leftovers that post-date the material economy): `tests/game.test.js` — `cfg.START_ISK` (256/278/587/1237/1360-1372), `cfg.START_STORY_ISK` (284/287), `completion.isk` (350/452), `sellMinerals` (255/613-641/1689/1693/2139), `buyModule` (86), `sys.prices` (236/246/254/619/636/2231), `cfg.FACTIONS`/standing (1632+), `iskReward` (818/2158-2159), `SHIELD_BOOST_COST` (951), `OVERLOAD_COST` (972); `tests/e2e.spec.js` — `.isk` (107/680/686/1186/1193), `/api/sell-all` helper (1334, route doesn't exist), standing tests (553-559).
- **Storyline e2e exists**: `tests/e2e.spec.js:1200-1305` "storyline: pilot training from rookie to certification (m1–m8) unlocks the gates @slow" (420s timeout); stops at gate-button-visible, never tests m9 or post-story.

## Proposed changes

### Step 1 — Story mode works (hangar turn-in/accept lifecycle + stale tests + story coverage)

**1a. Mission lifecycle engine change (`server/game.js`, `server/game/state.js`)**

Current behavior: objective met → `evaluateMission` (`2275-2294`) auto-grants rewards, marks completed, and auto-starts the next mission (`2285-2288`). New lifecycle — *complete/accept at a station hangar while docked, m1 excepted*:

- Add mission state: `m.ready` (objective met, awaiting turn-in) and `m.offered` (next mission id awaiting acceptance). Extend `createInitialState` (`game.js:1011`): story boot still auto-starts **m1 only** (`game.js:1048`, `index.js:493-495` stays).
- Objective hooks stop completing missions; they only record flags and set `m.ready = true` via one helper (`checkMissionObjective(state)`): kill/death (`game.js:1699-1709`), mine (`1507-1512`), craft (`750-758`), dock (`2280`), and the tick call site (`1605`). When a mission becomes ready: toast/event "Objective complete — dock at a station to turn it in".
- `evaluateMission` (or a replacement `turnInMission`) runs **only** when the player turns in: requires `dockedStation(state)` (exists, `state.js:74-93`) → grant completion rewards (`2179-2194`) → push `completed` (`2283`) → `stats.missionsCompleted` (`2284`) → set `m.offered = next` via `MISSION_ORDER` index (`2285-2286`); for m9 (last) → `m.active = null; m.ready = false; m.offered = null` (story complete, open sandbox).
- `missionAction` (`game.js:2298-2310`, endpoint `server/index.js:364-370`) gains actions: `'turnin'` (docked-only; completes `m.ready` mission) and `'accept'` (docked-only; `startMission(state, m.offered)` — `2197-2206`: grant up-front rewards `2132-2147`, grant ships `2151-2176`, spawn `2227-2253`, reset `offered`). Reject both with an error when not docked. Keep `'continue'` only as dialogue acknowledgment (client hides the dialogue), or drop it if unused.
- Special cases to resolve while implementing (verify with the user): **m3 (scripted death)** — death sets `m.ready`; after the death screen the player respawns and must dock to turn in m3. **m4 (dock objective + rifter grant)** — m4 is accepted at the hangar; decide: (a) granted rifter goes into the hangar fleet and the player launches, then docks to satisfy the `dock` objective (keeps the "fly back to the station" lesson, handles the ship-less-after-m3 state), or (b) `dock` objective is satisfied immediately at acceptance while docked (m4 becomes a quick handshake). Recommend (a); confirm before coding. **m8 (certification)** — `dialogue` objective: mission is ready immediately on start/accept; turning it in at the hangar grants certification; `gateJump`'s check on `completed.includes('m8')` (`game.js:2069-2071`) then unlocks gates unchanged. **m9** — kill both placidraiders → ready → turn in at any station → story complete.
- `view()` (`game.js:2390-2552`) + `missionView` (`2313-2343`): expose `mission.ready`, `mission.offered` (id + title + brief for the accept card), and keep `active`/`completed`/objective progress so the tracker can show "Return to station to turn in" (ready) or "Accept the next mission at a station" (offered).

**1b. Client hangar + tracker UI**

- `public/ui/hangar.js`: add a **Storyline** card (rendered only when `state.mode === 'story'` and docked) with one contextual button: "Turn in mission" when `mission.ready`, "Accept mission" (with the brief text) when `mission.offered`. Wire clicks in `public/core/input.js` to `app.doAction('mission', { action: 'turnin'|'accept' })` (pattern: `input.js:145-148`).
- `public/ui/hud.js` `#renderMission()` (`243-272`): keep tracker/dialogue; when `mission.ready` show "Objective complete — return to a station" instead of the progress bar; when `mission.offered` (and docked) the tracker can point at the hangar. The dialogue (`#mission-dialogue`) still shows each mission's brief on start/accept.
- `public/core/app.js` `#notifyProgressCompletions` (`333-363`) keeps celebrating turn-ins.

**1c. Fix stale tests** (ISK-era leftovers) in `tests/game.test.js` (e.g. `cfg.START_ISK` 256/278/587/1237/1360-1372, `START_STORY_ISK` 284/287, `completion.isk` 350/452, `sellMinerals` 255/613-641/1689/1693/2139, `buyModule` 86, `sys.prices` 236/246/254/619/636/2231, `cfg.FACTIONS`/standing 1632+, `iskReward` 818/2158-2159, `SHIELD_BOOST_COST` 951, `OVERLOAD_COST` 972) and `tests/e2e.spec.js` (`.isk` 107/680/686/1186/1193, standing tests 553-559, `/api/sell-all` helper at 1334 → replace with a store/transfer approach). Fix **before** relying on the suite; run the suite first to confirm which are actually broken.

**1d. Rework + extend story tests**

- Rework the `missions` unit tests (`game.test.js:305-455`) for the new lifecycle: objective met → ready (not complete); turn-in requires docked (reject when in space); accept requires docked and starts the next (grants + spawns); m1 auto-starts at boot; m8 turn-in unlocks gates; m9 turn-in → `active === null` and gates stay open; m3 death → ready → turn-in docks into m4 offer.
- `tests/api.test.js`: extend `POST /api/mission` coverage (`675-705` area) for `turnin`/`accept` incl. the 400-when-undocked cases; keep `POST /api/mode` story boot test asserting m1 active.
- Rewrite the e2e storyline (`e2e.spec.js:1200-1305`) to the new flow: after each objective → dock → Turn in → Accept → next mission; finish through m8 (gate unlock) **and m9** (turn in → story complete, gates usable, tracker hidden). Keep the @slow flag + generous timeout.

**1e. Verify**: `npm test`; `npm run test:e2e` (fast); the storyline e2e (`npx playwright test --grep "storyline"`); manual smoke: `npm start`, start a story save, play m1, complete → dock → turn in → accept m2. **STOP → user plays/reviews and commits.**

### Step 2 — Autopilot inefficiency penalty (single constant)

1. `server/config.js`: add near `MINING_RATE_MULTIPLIER` (398):
   `AUTOPILOT_EFFICIENCY = 0.25` — the one knob (0.5 = half; change here only). Add to exports (411-467).
2. `server/game.js`: add tiny helper `autoEfficiency(state)` → `state.autoPilotMode ? cfg.AUTOPILOT_EFFICIENCY : 1`. Apply it at every "system":
   - Mining yield: `shipMining()` (232-235) and/or the budget in `mineActive()` (1173) — also the **offline/parked catch-up mining path** in `server/index.js` so AFK gains are penalized consistently.
   - Speed/acceleration: scale the effective caps inside `moveVelocityToward` (1393-1415) and `advanceNavigation` (1417-1495) when autopilot is active. Keep `cfg.MAX_SPEED`/`cfg.MAX_ACCELERATION` unchanged (tests assert `cfg.MAX_SPEED === 1200`, `game.test.js:1165`).
   - Weapon damage: `effectivePlayerDps()` (856-858) and the `playerDps` captured in `startCombat` (1794-1796) when autopilot active; applies to the combat tick (1602).
   - Drones: scale drone mining/combat rates (consumers of `droneBonus()` 591-599) when autopilot active.
3. `server/game.js` `view()` (near 2511): expose `v.autoPilotEfficiency = autoEfficiency(state)`; expose `v.maxSpeed`/`v.maxAcceleration` effective values so the client interpolates at the same (reduced) caps — client falls back to catalog constants when absent.
4. `public/core/player.js` `Player.setServerState`/`update` (25-99): use `state.maxSpeed`/`state.maxAcceleration` when present; update `client.test.js` interpolation fixtures (668-702) only if affected.
5. **Tests**: add unit tests (mining yield, dps, speed/acceleration caps at `AUTOPILOT_EFFICIENCY` when `autoPilotMode` set, unchanged when not; api test that the view exposes it). Existing autopilot tests (`game.test.js:457-532, 1046-1215`, `api.test.js:154-167`, `e2e.spec.js:1158-1176, 592-607`) must stay green; `592-607` (@slow) may need longer waits since mining is 4× slower.
6. **Verify**: `npm test`, targeted e2e auto-mine spec. **STOP → user reviews and commits.**

### Step 3 — Autopilot banner

1. `public/index.html` (near `#combat-banner`, line 80): add `<div id="auto-banner" class="auto-banner" hidden></div>`.
2. `public/style.css`: `.auto-banner` — centered (mirror `.combat-banner` 272-285), large bold text (~2rem), warning color, `pointer-events: none`, above other banners.
3. `public/ui/hud.js` `#refreshFast()` (156-240): when `this.app.autoPilotMode` is set and not docked → `banner.textContent = "due to AI inefficiencies, all systems running at 1/" + (1 / this.app.state.autoPilotEfficiency) + " capacity"` (or a small exported pure helper `autoBannerText(efficiency)` for testability), unhide; otherwise hide. (Server step 2 guarantees `autoPilotEfficiency` is 1 when off.)
4. **Tests**: `client.test.js` unit test for the text helper; e2e — enable auto-mine (existing `1158-1176`) → banner visible with "1/4"; disable → hidden.
5. **Verify**: `npm test`, e2e auto-pilot spec. **STOP → user reviews and commits.**

### Step 4 — Clean-code refactor (no behavior change)

1. Split `server/game.js` (2,646 lines) into focused modules under `server/game/`, following the existing style (`server/game/state.js`, `world.js`, `inventory.js`):
   - `stats.js` — `shipMining`, `miningRange`, `shipDps`, `shipShield`, `shipHull`, `shipCargo`, `moduleBonus`, `skillMults`, `droneBonus`, `autoEfficiency`.
   - `movement.js` — `moveVelocityToward`, `moveInOrbit`, `advanceNavigation`, arrival/braking logic.
   - `combat.js` — `enemyCombatStats`, `startCombat`, `damagePlayer`/`damageEnemy`, `resolveCombat`, `combatAction`, `effectivePlayerDps`, TTK helpers.
   - `autopilot.js` — `runAutopilot`, `bestBeltTarget`, `nearestSafeRat`, `launchForAutopilot`, `setAutopilotNavigation`, `recordAutomation`, `setAutopilot`.
   - `missions.js` — `startMission`, `grantMissionRewards`/`grantShips`/`fitGrantModule`, `grantCompletionRewards`, `spawnMissionEnemies`, `missionDone`, `evaluateMission`, `missionAction`, `missionView`, `missionStartNeeded`, `clearMissionEnemies`.
   - `view.js` — `view()` (2390-2552) and `shipView()` (2345-2371).
   - Keep `server/game.js` as a thin facade re-exporting the modules (so `server/index.js`'s `require('./game')` and tests stay untouched), or delete it and update the few importers; prefer the facade only if the split leaves it < ~300 lines, otherwise update importers.
   - Decompose any function over ~40 lines into small named helpers while in each module; remove dead code found: `mission.step` (written `game.js:1011,2202,2292`, never read).
2. Doc cleanup: delete stale `TASKS.md` references to a client `AutoPilotNode`/`toggleAutoPilot()` (lines 8, 16, 41, 48, 95) and resolve the empty `README.md` "## TODOs / ### actions and questions" stub (replace with the new "Known design decisions" list or delete).
3. **Verify**: `npm test` and `npm run test:e2e:full` (including @slow storyline). **STOP → user reviews and commits.**

## Risks / open questions

- **m3/m4 edge cases in the new hangar flow** (Step 1a): after m3's scripted death the player has no ship (loaner suppressed, `game.js:1663`) — verify the respawn state (docked vs floating, fleet empty) and that the m4 rifter grant is reachable (grant into the hangar fleet when accepting docked, then launch). m4's `dock` objective: recommend (a) launch + dock again to satisfy it (keeps the lesson), confirm with the user before coding. **Turn-in/accept at any station** (including Placid for m9) — confirm that's the intent.
- **Penalty value**: user confirmed **0.25** (`AUTOPILOT_EFFICIENCY`); one constant, one-line change if rebalanced later.
- **Offline/AFK**: the parked-ship autopilot (offline catch-up, `server/index.js`) is autopilot work — penalty applies there too (Step 2 point 2). Confirm acceptable.
- **e2e storyline is `@slow` (420 s)**: full verification needs `npx playwright install chromium` and ~7 min; Step 1 explicitly runs it (it also gets rewritten for the turn-in/accept flow).
- **Stale test inventory is large** (`tests/game.test.js`, `tests/e2e.spec.js` ISK-era leftovers): run the suite first and fix only what actually fails against the current economy, so Step 1 doesn't balloon.
- **Client interpolation while penalized**: server stays authoritative; the client only needs the effective caps (Step 2, points 3-4) so prediction doesn't overshoot. Manual mode is unaffected.
- **Refactor scope**: server only (per the "biggest files" goal, `server/game.js` is the target). `public/view/world.js` (816 lines) can be a follow-up if desired.