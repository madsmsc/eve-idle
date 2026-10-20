# EVE Idle implementation status

The project includes DEMO sandbox mode and the guided START storyline, with
server-owned simulation and per-mode saves. The storyline covers missions m1
through m9; completing certification unlocks gate travel and post-course
progression.

The sandbox includes faction standing, system security, gate ambushes, drones,
loot, module and ship crafting, achievements, fitting presets, agent contracts,
and capped offline progression with a resume report. The current persisted
state schema is version 14. A save from an older version is rejected and
replaced with a fresh state on startup.

The current user-facing overview and render/update hierarchy are documented in
the root README. Candidate feature decisions are recorded in
`completed-features.md`; multiplayer remains deliberately deferred. The
accumulated changes have not been committed.
