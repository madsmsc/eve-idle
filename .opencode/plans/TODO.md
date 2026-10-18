# TODO

Backlog of candidate features for EVE Idle. Not in progress unless checked.
Items marked *(PRD §13)* were explicitly out of scope for the current pass.

## High value / low effort

- [ ] **Achievements** *(PRD §13)* — hook into existing stats (`totalMineralsMined`,
      kills, ISK earned, missions completed) and add a `Hangar → Achievements` panel.
- [ ] **Sell / refine unwanted modules** — loot can currently only be equipped
      (`equipLoot`); let players sell a module for ISK or refine it back to ore in the
      hangar, reusing the existing `sell-*` pattern.
- [ ] **First-time tutorial overlay / tooltips** — the storyline teaches mechanics;
      a lightweight in-world hint system would help DEMO-mode players too.

## Medium value / medium effort

- [ ] **Post-certification storyline** *(PRD §13)* — reuse the mission framework
      (`MISSIONS`, scripted spawns, objectives) for a small arc in Placid/Domain after m8.
- [ ] **Repeatable "agent missions" in the sandbox** — daily-style side missions
      (kill X rats, haul Y ore) that reuse the mission engine and keep the post-cert
      world active.
- [ ] **Security levels** *(PRD §13)* — per-system security rating driving rat
      difficulty, gate-ambush odds, and market prices; fits the existing `threat`,
      `standing`, and `ambushChance` systems.
- [ ] **Offline progress report** — a "While you were away" screen (ore mined, ISK
      earned, rats killed) built on the existing capped offline `tick` math.

## Lower priority / bigger scope

- [ ] **Blueprint expansion** — faction modules and ship blueprints so industry has
      more to build.
- [ ] **Fitting presets** — save and apply named loadouts.
- [ ] **Multiplayer / instancing** *(PRD §13)* — large; probably not worth it for a
      single-player idle game.

## Housekeeping

- [ ] Commit the current P0–P5 work (user is handling).
