# PRD — README Feature Backlog

**Status:** Approved — implementation complete; validation recorded in §8  
**Source:** The `TODOs` section of the root `README.md`  
**Approval:** The user approved implementation with “Yes, start implementation.”

## 1. Goal

Deliver the UI, autopilot, terminology, world presentation, map, and test-coverage improvements requested in the README TODO list. Preserve the server-authoritative game model, the current game economy, and existing player saves unless an approved decision requires otherwise.

## 2. Scope and requirements

### 2.1 System and mission information

- In the upper-left system display, show a muted `SYSTEM` label above the current system name.
- Add a horizontal divider below the system name.
- Show `SEC STATUS` and the current system's security value, followed by another divider.
- Show each active mission objective on its own line below the second divider.
- Security is a property of the system, not the player. Do not introduce player security, reputation, money, or currency attributes; progression remains item-based.
- In DEMO or when there is no active mission, show `No active mission` in the objectives area; do not imply that a player security attribute exists.
- Keep this system panel transparent, without a filled card background.

### 2.2 Autopilot station deposit sequence

When autopilot returns a full ship to a station to deposit cargo:

1. Finish the normal docking animation.
2. Leave the station UI visible for a configurable 2-second wait.
3. Animate/highlight the deposit control clearly before activating it.
4. Deposit the cargo and refresh the station view.
5. Keep the station UI visible for another configurable 2-second wait, highlighting the launch control during that wait.
6. Undock and continue the autopilot loop.

Keep the two wait durations and highlight duration in shared server game configuration rather than embedding delay values in the flow. Preserve manual deposit behavior. Test the order and timing through an injectable clock/timer or equivalent deterministic test seam.

### 2.3 Autopilot hotkeys and enemy terminology

- Keep `A` for mining.
- Add `F` for the fight autopilot mode and `B` for the combined mode.
- Replace user-facing `Hunt`/`Rat` terminology with `Fight`/`Enemy`.
- Rename internal identifiers and persisted/API values referring to rats or hunting to enemy/fight terminology, including code that is not displayed in the UI.
- Migrate existing saves and API values so that existing player progress is retained across the rename; do not silently reset saves as a shortcut.
- Use `&` as the combined-mode icon if it renders consistently in the supported UI; otherwise choose a clear two-actions-at-once symbol.
- Review accessible names, titles, help text, activity messages, tests, and developer-facing identifiers as part of the terminology change.

### 2.4 Asteroid visuals and spacing

- Trace the source of the colored triangle outlines and asteroid-center colors, and document whether they represent intended resource/depletion state or are accidental rendering artifacts.
- Make the asteroid face, outline, and center treatment intentional and visually consistent; do not leave a single unexplained colored facet.
- Prevent asteroids from overlapping in generated worlds. Preserve deterministic generation for a given seed and keep positions within their system/belt bounds.
- Validate spacing with deterministic world-generation tests over representative seeds, accounting for each asteroid's rendered radius.

### 2.5 Controls and game-flow test coverage

- Audit current automated coverage for interactive controls and the core player flows before adding tests.
- Cover each applicable UI action with the appropriate level of test: unit tests for isolated logic, API/integration tests for server validation and state changes, and browser tests where rendering or interaction matters.
- Explicitly cover docking/launching, market purchases, and transfers between ship cargo and shared Quantum Storage.
- Include the controls and flows introduced or changed by this PRD, with assertions for disabled/enabled state and resulting game state.
- Record discovered coverage gaps and either close them in this work or list any deliberate exclusions for approval.

### 2.6 Three-mode navigation overview

Replace the single minimap visibility toggle with three controls at the current upper-right overview control:

- **EDGE:** hide the minimap and show a directional edge map.
- **MINI:** show the existing minimap and hide edge indicators.
- **NONE:** hide both the minimap and edge indicators.

The edge map shows directional icons at the viewport edge for all warpable belts, stations, outposts, and gates, with distance text beside each icon. Cluster nearby markers to avoid unreadable overlap. It must remain distinct from the existing overview map, respond to system changes and ship movement, provide accessible labels, and remember the selected mode across reloads. Place marker labels flush to the screen edge, with the rest of the UI inset to leave room for them. Keep the overview map and its controls background-free, and make the three mode buttons half their previous size.

### 2.7 Conditional flight actions

- Keep the mining, engage, and gate-jump actions visible rather than hiding them when the action is unavailable.
- Disable each action unless its corresponding target/action is currently valid and within range; keep the server authoritative for validation.
- Keep labels and disabled-state explanations clear, and ensure targets disappearing or changing cannot leave a stale enabled action.

### 2.8 World labels and enemy readability

- Render belt and other world-object labels above entity sprites and other world graphics.
- Rework enemy name, type/tier, health, and other currently shown annotations to reduce collisions and improve readability without obscuring the ship or nearby interactions.
- Keep label placement stable enough to read while zooming and moving, and verify overlap handling in representative dense scenes.

## 3. Design and implementation constraints

- Keep the server authoritative for system security, movement, docking, cargo transfers, and action availability.
- Keep the existing game economy item-based; do not add currency, player security, or player reputation.
- Preserve seeded world generation and existing mode/save behavior.
- Reuse existing UI, scene-graph, state-view, and test patterns where possible.
- Keep configurable autopilot timing in shared server game configuration.
- Avoid unrelated cleanup and keep the README backlog intact until the user chooses otherwise.

## 4. Suggested implementation phases

| Phase | Scope | Deliverables |
|---|---|---|
| 0 — Baseline | Coverage audit and terminology inventory | Inventory current tests, button actions, rat/hunt identifiers, and affected UI surfaces; capture baseline test results |
| 1 — System panel and actions | System/mission status and always-visible conditional controls | Updated HUD, state wiring, accessibility states, focused client/API/E2E tests |
| 2 — Autopilot UX | Timed deposit sequence and hotkeys/naming | Configurable timings, deposit animation, `A`/`F`/`B`, consistent enemy/fight naming, deterministic timing tests |
| 3 — Asteroids and labels | Rock color/spacing and world annotation readability | Rendering correction, non-overlap generation, label layering/layout, visual and world-generation tests |
| 4 — Overview modes | EDGE/MINI/NONE navigation modes | Edge indicators, distance labels, three-button selector, mode/state/accessibility tests |
| 5 — Coverage closeout | Core game-flow and changed-control coverage | Dock/launch, market, cargo/storage, and changed-button tests; full relevant validation and documented remaining gaps |

Phase order may change if the confirmed decisions reveal dependencies. Each phase should preserve existing behavior outside its stated changes and be independently testable.

## 5. Acceptance criteria

- The system display shows the system label/name/security and active objectives in the specified order; DEMO/no-mission state shows `No active mission`; no player security, reputation, or currency field is added.
- Autopilot completes the ordered dock → 2-second wait → clear deposit animation → deposit → 2-second wait with a matching launch-button animation → undock sequence, with tunable delays and unchanged manual deposit behavior.
- Mining/fight/both autopilot modes use the approved labels, hotkeys, and icons; enemy terminology is consistent across UI, code, saves, and API values, with existing saves migrated.
- Asteroid rendering has intentional and consistent mineral color cues, and generated rocks do not overlap at the tested rendered radii while remaining deterministic.
- The overview selector has working EDGE/MINI/NONE modes; EDGE shows all approved warpable categories with clustered nearby markers and readable distances; selection persists across reloads.
- Mining, engage, and gate-jump controls remain visible and are disabled whenever their action is unavailable.
- World labels draw above world entities; enemy annotations are readable in representative scenes.
- Automated tests cover the changed controls plus the approved core workflows, including docking, market buying, and cargo/storage transfers.
- Focused tests and the repository's full unit/API/client suite pass; relevant browser tests pass, and any unrelated baseline failures are reported rather than silently ignored.

## 6. Confirmed decisions

- **Terminology compatibility:** Rename terminology throughout UI, code, saves, and API values, and migrate existing saves/API values to preserve progress.
- **Autopilot timing:** Use a 2-second wait before deposit and a 2-second wait before undocking; put adjustable timing values in shared server game configuration and animate both relevant controls during their stages.
- **Asteroid style:** Retain mineral colors, but make them intentional and consistent across the asteroid faces, outlines, and centers.
- **Edge-map density:** Show all warpable targets and cluster nearby markers.
- **Overview selection:** Remember EDGE/MINI/NONE across reloads.
- **Test completeness:** Cover core workflows and every control changed by this PRD. Explicitly include docking/launch, market purchases, and ship-cargo/Quantum-Storage transfers.
- **Mission display outside the storyline:** Show `No active mission`.

## 7. Approval gate

The approval gate has been cleared. Implementation began after the user explicitly approved it.

## 8. Implementation and validation

- Implemented the approved system HUD, autopilot deposit sequence and controls, terminology migration, asteroid spacing/rendering, overview modes, conditional flight actions, and world-label layering.
- Added unit/API/client coverage for migration, timing transitions, generated-world spacing, HUD and edge-map rendering, and server action behavior.
- Added browser coverage for the overview modes, disabled flight actions, manual versus autopilot deposits, docking/launch, market purchases, and cargo/storage transfers.
- Cached inventory and station-service render refreshes against their displayed state so routine server ticks do not detach active controls.
- `npm test`: 266 tests passed.
- `npm run test:e2e`: 37 browser tests passed.
- `npm run test:e2e:full`: all 40 browser tests passed, including full cargo recall and the m1–m9 storyline.
- Follow-up HUD/autopilot polish: `npm test` still passes all 266 tests; focused browser coverage for the overview and autopilot sequence passes. The full browser rerun reported a quick-start dismissal timeout because the menu window intercepted the click; a misplaced timing assertion from that run has since been corrected and verified by the focused autopilot test. A clean full-suite rerun remains outstanding.
