# Plan: eve-idle status check — is there a todo/plan, and what's missing

## Goal

Answer: is there a current todo/plan for the eve-idle repo, and what outstanding work
("what is missing") remains to consider the PRD done?

## Current state (findings)

- **No dedicated todo/plan file exists.** There is no `.opencode/plans/` directory
  (this file is being created), no `TODO.md`, no `PLAN.md`, and no other `todo*`/`plan*`
  files anywhere in the repo. There is also no persisted todo list from a prior session
  visible on disk.
- **The de-facto plan is `PRD.md`** ("DEMO Mode vs START (Storyline) Mode", Status:
  APPROVED, decisions locked). It defines the phased rollout:
  - **P0** Modes & boot (per-mode save container `{demo, story}`, `POST /api/mode`,
    start menu, `STATE_VERSION` 12)
  - **P1** Mission framework + M1
  - **P2** Range advantage + M2
  - **P3** M3 scripted death + M4 clone/dock
  - **P4** M5 mining, M6 drone hub, M7 crafting
  - **P5** M8 certification + gate unlock + full-suite green
- **By code inspection, all P0–P5 appear implemented:**
  - `server/config.js` — `MODES`, `STATE_VERSION = 12`, `MISSION_ORDER` (m1–m8),
    `MISSIONS` with all 8 definitions, `MISSION_ENEMIES` (attacker, shortrange,
    waveship, dronhub), range/cargo/mining/weapon modules.
  - `server/index.js` — per-mode save container, `POST /api/mode`, `mission` action,
    legacy-save migration, `missionStartNeeded` boot.
  - `server/game.js` — `createInitialState(..., mode)`, mission engine (start / done /
    advance / action), kill/mine/craft/dock hooks, m3 loaner suppression, gate lock
    until `m8` completed, range free-fire window.
  - `public/index.html` + `public/app.js` — `#mode-menu` (mode-demo/mode-story),
    `#mission-tracker`, `#mission-dialogue`, craft buttons (`craft-weapon-t1`,
    `craft-shield-t2`).
  - Tests exist for every phase: unit (`tests/game.test.js`), API (`tests/api.test.js`),
    E2E (`tests/e2e.spec.js`, story chain m1→m8).
- **`data/state.json`** is at version 12 with only a fresh `demo` save (10k ISK, no active
  mission); no `story` slot persisted yet.

## What is missing / outstanding

1. **The full suite is not green — the `story m7` E2E test is failing.**
   `test-results/.last-run.json` → `status: failed`, 1 failed test
   (`e2e.spec.js >> story m7: hauling the forge ore home to craft a Weapon I and a
   Shield Extender II reaches certification`, line 665). The `error-context.md` shows a
   30s timeout in the `killMissionEnemy` helper waiting for
   `dist(activeShip, enemy) < 200` (received **780**). Curiously the page snapshot
   shows **M2** state ("Help the Buddies … 1/3" + "Engaged!" banner), i.e. the failure
   happened *inside the m7 test's `reachMission` prelude* while killing the short-range
   frigates — likely flaky timing / a warp issued while a fight is still live
   (the ship ignores position moves while in combat), or stale shared-server state
   across story tests.
2. **Working tree is uncommitted.** `git status` shows all server/public/test files
   modified and `PRD.md` untracked (only `f60b76c first commit` exists). None of the
   P0–P5 work is committed.
3. **README is stale.** `README.md` documents the old API table (no `/api/mode`,
   `/api/mission`, `/api/craft-module`) and has no mention of START/storyline mode,
   missions, or certification.

## Proposed changes (ordered)

1. **Investigate & fix the failing `story m7` E2E test** (highest priority — it is the
   only red item against the PRD's "full suite green" gate):
   - Reproduce: `npm run test:e2e` (story tests only if possible via `-g "story m7"`).
   - Root-cause the `dist < 200` timeout in `killMissionEnemy` (suspect: a warp request
     issued while a prior combat is still resolving, so the ship never moves). Likely
     fix in the test helper (e.g. explicitly wait for combat to clear / combat banner to
     hide before issuing the next warp) or in the client (ignore/queue warp only when not
     in combat). Confirm the real cause before changing code.
   - Verify: m7 test passes repeatedly, then full `npm run test:all` is green.
2. **Run the full suite** (`npm run test:all`) and confirm unit + API + E2E all pass.
3. **Commit the work** (when the user asks): stage server/, public/, tests/, PRD.md,
   `data/state.json`; write a message matching the repo (single "first commit" style).
4. **Update `README.md`** (optional cleanup): add `/api/mode`, `/api/mission`,
   `/api/craft-module` to the API table and a short "Storyline / missions" section.
5. **Optional**: keep a lightweight todo doc here (`todo.md`) to track remaining items
   going forward — only if the user wants a persistent checklist.

## Risks / open questions

- The m7 failure may be a real gameplay bug rather than test flakiness; a fix belongs in
  `app.js` (client warp/combat handling) if the client is issuing warps that the server
  correctly rejects. Needs reproduction before editing.
- Whether to commit the in-progress changes (I will only commit if explicitly asked).
- Whether the user wants README updates now or later.
- `test-results/` should not be committed (it is generated; confirm it is in
  `.gitignore` before the commit).
