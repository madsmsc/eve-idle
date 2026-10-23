# Autopilot Improvements

Agreed scope with player. Items marked [x] are done.

## [x] Skip depleted belts

Autopilot no longer flies to belts with no remaining asteroids.
`bestBeltTarget()` in `public/core/player.js`.

## [x] #1 — Mineral value weighting

Score each belt by `sum(asteroid.amount * mineral.price) / distance`.
Autopilot picks the highest-scoring belt, not just the nearest.
- Formula: `score = totalBeltValue / dist(ship, belt)`
- `totalBeltValue` = sum of `a.amount * prices[a.mineral]` for all `a.amount > 0` in belt
- Implemented as `bestBeltTarget()` in `public/core/player.js`

## [x] #3 — Offline progress report

Track cumulative stats while autopilot runs:
- Ore mined by mineral type (`stats.oreMinedByType`)
- Credits earned from selling (`stats.totalIskEarned`)
- Rats killed (`stats.combatsWon`)
- Belts completed (`stats.beltsCompleted`)
- Distance traveled (`stats.distanceTraveled`)
- Time elapsed

On reconnect (mode selection after 60s+ away), show a full activity log panel
with ore breakdown, credits, kills, belts, distance, and SP.
- Server: `server/index.js` expands `offlineReport`
- Client: `public/ui/overlays.js` renders detailed `<ul>` breakdown
- HTML: `public/index.html` adds `#offline-report-detail` container

## [x] #4 — Rat hunting (safe targets only)

When in space, no asteroid in mining range, and cargo not full:
- Look for enemies where `enemy.totalHP < 0.5 * player.totalHP`
- If in engage range: engage immediately
- If out of range: fly to it (sets `targetEnemyId`)
- If none found, fall through to belt selection
- `nearestSafeRat()` in `public/core/player.js`

## [x] #5 — System empty: dock + stop

When ALL belts are depleted AND no safe rats remain:
- In space: fly to nearest station (sets dock target)
- Docked with no cargo: disable autopilot + toast "System depleted — autopilot stopped"
- `systemDepleted()` in `public/core/player.js`

## [x] #8a — All equipped modules apply

Mining modules now increase BOTH:
- Mining range: `MINING_RANGE + moduleBonus(ship, 'mining')`
- Mining yield: (unchanged, already worked)

- Server: `miningRange(ship)` helper in `server/game.js`
- Applied in `mineActive()`, `nearestAsteroidInRange()`, and state view
- Client uses `state.miningRange` (dynamic) with fallback to `constants.miningRange`

## [x] #8b — Drones visible in ship modules panel

Drones appear as rows in the fitting panel below ship modules,
showing name, tier, and bonus. Same visual style as module rows.
- `public/ui/inventory.js` `renderFitting()` appends drone rows

---

## Round 2

## [x] #8 — Cargo-aware mineral priority

`mineActive()` now sorts in-range asteroids by mineral price descending
(highest value first), then distance. Ship mines the richest ore first.
- `server/game.js` `mineActive()` sort changed

## [x] #3 — Belt progress indicators

Each belt shows a colored progress arc (green > 50%, yellow > 20%, red below)
and a percentage label. Satisfying to watch it deplete.
- `public/view/world.js` `BeltNode.render()` draws arc + `%` label

## [x] #4 — Pre-flight readiness toast

When enabling autopilot, shows a summary: belt count, total ore, estimated
credit value, and safe rat count. Sets player expectations.
- `public/core/app.js` `toggleAutoPilot()` computes and toasts

## [x] #1 — Auto-pilot modes

Button cycles: OFF → Mine → Mine+Hunt → Hunt → OFF.
- `mine`: only mine belts, ignore rats
- `mine_hunt`: mine belts + hunt safe rats (default)
- `hunt`: only hunt rats, ignore belts
- `public/core/app.js` `toggleAutoPilot()` cycles modes
- `public/core/player.js` `AutoPilotNode.#run()` respects `autoPilotMode`

## [x] #5 — Auto-pilot activity log

Running log of last 20 events (mined, earned, killed, belt completed, warp).
Toggle with "☰ Log" button (visible only when autopilot is on).
- `public/core/app.js` `#logAutoEvents()` detects state changes
- `public/core/app.js` `toggleAutoLog()` shows/hides panel
- `public/index.html` adds `#auto-log-panel` + `#auto-log` button
- `public/style.css` adds `.auto-log-panel` styles
