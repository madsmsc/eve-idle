# EVE Idle

A tiny idle-game take on EVE Online, rendered as a **2D top-down world**. You
**warp** to where you want to act — no long flights, no manual piloting. Park on
an **asteroid belt** to mine it, dock at a **station** to trade, and warp up to
**rats** to fight them for ISK. Use ISK to buy and upgrade a fleet. The world
keeps running while you're away: a parked ship keeps mining, and a full cargo
hold auto-recalls you home to sell.

Space is split into **systems** (Jita, Placid, Domain), each with its own star,
planets, belts, stations and rats. **Gates** link the systems: warp to a gate and
jump through to travel between them, just like warping in EVE.

The interface is almost entirely the rendered world (a `<canvas>`). The HTML is
a thin HUD — current system, ISK, threat level, ship status, a minimap, warp
buttons, and a Hangar/Market overlay.

## How to play

- **Click** — **warp** to whatever you click (a station, belt, planet, moon,
  gate, the star, or open space). The ship jumps there instantly.
- **⚡ Belt / ⚡ Station / ⚡ Rat** — one-click warp to the *nearest* belt,
  station, or rat in the current system.
- **⇄ Jump** — appears when you're at a **gate**; click it to jump to the
  connected system (you arrive at the paired gate, so you can jump back).
- **E** (or the *Engage* button) — fight the rat you're standing next to. The
  fight runs in **real time**: you and the rat both have live **shield** and
  **hull** bars that drain as you trade blows, and the winner is whoever's hull
  holds longest. Losing is costly: you lose the ship **and everything in its
  cargo hold**, and get back only **insurance** (50% of the ship's purchase
  cost) — so flying off with a full hold is a real gamble. If you lose your last
  ship, your pod brings you home with a free loaner Rifter so you're never stuck.
- **In-fight actions** — while a fight is live you can spend ISK to change the
  odds: **🛡 Boost** restores your shield to full, **⚡ Overload** boosts your
  damage for a few seconds, and **🏃 Disengage** bails out (you keep the ship
   and its cargo, but the rat escapes and you earn nothing).
- **Killboard & death screen** — every fight is logged on the *Killboard* (the
  battle log in the Hangar) with the ship, the enemy, the system, and what you
  won or lost. When your ship is destroyed the screen shakes and a full-screen
  **death screen** appears with the killmail (who killed you, where, and the
  cargo you lost and the insurance you got).
- **Loadout** — before a fight, fit your ship for a role: **🛡 Tank** (more
  shield/hull, less damage), **⚖ Balanced** (stock), or **⚔ DPS** (more damage,
  less shielding). The fit applies to your next fights.
- **Fitting** — in the *Hangar → Fitting* panel, install modules in your active
  ship's slots. Each ship has a fixed number of slots per type (**Weapon**,
  **Shield**, **Armor**, **Mining**, **Cargo**); bigger ships have more. Each
  module comes in three tiers (I/II/III) that add a flat bonus to that stat on
  top of the loadout. Fitting a slot costs ISK; downgrading or removing a module
  refunds the difference, so you can re-fit at any time.
- **Skills** — you earn **skill points** over time (idle) and from every rat you
  destroy. In the *Hangar → Skills* panel, spend them to train skills up a level.
  Skills are player-wide (they apply to every ship) and multiply a stat: **Mining
  Yield** and **Cargo Management** (mining/cargo), **Gunnery**, **Shield
  Upgrades**, **Hull Upgrades** and **Bounty Hunting** (combat damage, defense and
  reward). Training is instant — the gate is the skill points you have to spend.
 - **Markets** — each system has its own mineral prices, so the same ore is worth
   more in one system than another. Mine cheap, haul through a **gate**, and sell
   dear for a hauling profit on top of the mining income.
 - **Factions & standing** — each system is controlled by a faction (**Serpentis**,
   **The Concord**, **The Syndicate**). Your **standing** with a faction (−10…+10)
   rises when you clear its rats and falls when you lose a ship in its space.
   Standing is shown in the HUD and in *Hangar → Factions*. It also nudges that
   faction's market prices in your favour (±10% at the extremes).
 - **Gate ambushes** — jumping a gate is risky: a predator can drop out of the
   other side and attack you the moment you arrive. The **ambush chance** is shown
   on the *⇄ Jump* button and is higher the less you are liked by the destination
   faction's standing.
 - **Drones** — buy **Mining Drones** and **Combat Drones** in the *Hangar →
   Drone Bay*. They are player-level (they assist whichever ship you fly), add a
   flat bonus to your mining yield and combat DPS, and you can own up to 5 of each
   type. They're independent craft, so — unlike ships — they survive a ship loss.
   You'll see them orbit your target while you mine or fight.
 - **Loot** — destroying rats can drop **modules** into your *Hangar → Loot*.
   Hit *Equip* to fit one into the first empty slot of that type on your active
   ship, free of charge. Bigger rats drop better modules, more reliably.
 - **Industry** — every module tier has a **blueprint** that turns raw **minerals**
   into a module. Open *Hangar → Industry* (while docked) and craft — the ore is
   taken from your cargo hold, so haul it to the station first.
 - **▶ Auto** — toggle the **Auto** button to run the whole idle loop hands-free:
   warp to a belt → mine → auto-recall home when the hold is full → sell → warp
   back to a belt. Tap it again to take back control any time.
 - **H** (or the *Hangar* button) — open the Hangar & Market to buy/sell ships,
   upgrade, and sell cargo (only while docked at a station). The market shows the
   *current system's* price for each mineral.
 - **Scroll** — zoom in/out.

The idle loop: warp to a **belt** → it auto-mines until your cargo hold is full →
the ship **auto-recalls** to the nearest station → **sell all** your cargo → warp
back to a belt. Rats get tougher (and pay more) as you earn ISK, so keep
upgrading. When a system runs dry, jump through a **gate** to a new one — and if
a neighbouring system pays more for your ore, haul it there instead.

## Modes & the storyline

Every load starts on a **start menu** with two ways to play, each with its own
save slot (picking a mode resumes that save, or starts fresh — progress in one
mode never clobbers the other):

- **DEMO** — the open sandbox: three systems, 10k ISK, a free Rifter, open gates,
  factions, ambushes, drones, loot and industry. No story.
- **START** — a guided **storyline** in Jita ("rookie space"). You complete a
  linear pilot-training course of **eight missions**, each teaching one mechanic:

  | # | Mission | Lesson |
  |---|---|---|
  | 1 | Under Attack | Combat — destroy the attacker frigate |
  | 2 | Help the Buddies | Range — your Range Amplifier wins the opening volley |
  | 3 | Last Stand | Death — a scripted, unwinnable wave destroys your ship |
  | 4 | A New Clone | Clones & stations — dock in your replacement frigate |
  | 5 | Mining 101 | Mining — mine 40 ore |
  | 6 | Rogue Drones | Drones — destroy the drone hub, earn a mining drone |
  | 7 | The Forge | Industry — craft a Weapon I and a Shield Extender II |
  | 8 | Certification | Gates — finish the course and Jita's gates unlock |

  Missions run in order, are tracked in the HUD, and the gate **jump stays locked
  until you earn your certification** (m8). After that the open sandbox continues
  with all of your progress kept.

## Why the backend matters here

The client owns *smooth movement* locally and reports its position each sync.
Everything else is an **intent** (`buy-ship {type}`, `sell-minerals {mineral,
amount}`, `engage {enemyId}`, `tick {x, y}`, ...). It never sends prices,
yields, rewards, or elapsed time. The server:

- validates every action (enough ISK? ship exists? target in range? already in
  combat?),
- owns the world (the systems, and each system's star, planets, moons, belts,
  stations, rats and gates) and all spatial rules — you only mine what you're
  standing next to, you can only engage what's in range, you can only trade
  while docked at a station, and you can only jump a gate when you're at it,
- computes all quantities from its own clock and the persisted `lastTick`
  (idle gains are capped at 8h so absence can't be exploited),
- clamps reported positions so a tampered client can't teleport to a rich field,
- and **persists** the resulting state to `data/state.json` after each
  mutation (atomic write: temp file + rename).

So a tampered client can't cheat, and your ship, cargo, and the whole world
survive restarts.

## Run it

```bash
npm install          # installs Playwright (dev dependency)
npm start            # serves on http://localhost:3000
```

Open http://localhost:3000. Set `PORT` and `DATA_FILE` env vars to override
the port and save location.

## Test it

```bash
npm run test:unit    # game logic + validation (node:test)
npm run test:api     # HTTP API + persistence (node:test, real server)
npm run test:client  # client core: node tree + camera (node:test)
npm run test:e2e     # browser end-to-end (Playwright)
npm test             # unit + api + client core
npm run test:all     # everything
```

First time you run the E2E tests you'll need the browser:

```bash
npx playwright install chromium
```

## API

| Method | Path                 | Body                              | Effect                          |
| ------ | -------------------- | --------------------------------- | ------------------------------- |
| GET    | `/api/state`         | —                                 | Current state (server view)     |
| GET    | `/api/catalog`       | —                                 | Ships, minerals, enemies, constants |
| POST   | `/api/mode`          | `{mode}`                          | Switch to a mode's save (`demo`/`story`), creating it if absent |
| POST   | `/api/tick`          | `{x, y}`                          | Report position, advance time, collect idle |
| POST   | `/api/buy-ship`      | `{type}`                          | Buy a ship (spawns at the station) |
| POST   | `/api/sell-ship`     | `{shipId}`                        | Sell a ship                     |
| POST   | `/api/upgrade-ship`  | `{shipId}`                        | Level a ship up                 |
| POST   | `/api/set-active`    | `{shipId}`                          | Choose the piloted ship         |
| POST   | `/api/set-loadout`   | `{shipId, loadout}`                 | Fit a ship: `balanced`, `tank`, or `dps` |
| POST   | `/api/fit-module`    | `{shipId, slotType, slotIndex, tier}` | Set a fitting slot to a module tier (0 = empty) |
| POST   | `/api/train-skill`   | `{skill}`                           | Train a skill up one level (spends skill points) |
| POST   | `/api/buy-drone`     | `{type, tier}`                     | Buy a drone (`mining`/`combat`, tier 1-3) |
| POST   | `/api/equip-loot`    | `{lootId}`                         | Fit a looted module into the first empty slot |
| POST   | `/api/craft-module`  | `{slotType, tier}`                 | Craft a module from cargo ore (must be docked) |
| POST   | `/api/sell-minerals` | `{mineral, amount}`               | Sell minerals (amount or `all`) |
| POST   | `/api/sell-all`      | `{}`                              | Dump the whole cargo hold        |
| POST   | `/api/engage`        | `{enemyId}`                       | Attack a hostile you're next to |
| POST   | `/api/combat-action` | `{action}`                        | In-fight action: `shieldBoost`, `overload`, or `disengage` |
| POST   | `/api/warp`          | `{targetId}` or `{x, y}`          | Instantly move to a POI / point in your system |
| POST   | `/api/gate`          | `{gateId}`                        | Jump to the connected system (must be at the gate) |
| POST   | `/api/mission`       | `{action}`                        | Storyline action (e.g. `continue` to accept the next mission) |
| POST   | `/api/reset`         | `{}`                              | Wipe and regenerate the **active mode's** state |

Successful responses return `{ state }` (a computed view). Failures return
`400` and `{ error }`.

## Layout

```
server/
  config.js   # static data: ships, minerals, enemies, spatial constants
  game.js     # pure, validated game logic + world generation (no I/O)
  store.js    # atomic JSON persistence
  index.js    # http server, routing, static file serving
public/
  index.html     # canvas + thin HUD + hangar overlay
  style.css      # dark space theme
  main.js        # entry: builds the App and the node tree, exposes window.__eve
  package.json   # marks public/ as an ES module package
  core/          # App orchestrator, Node base, Player, Camera, input, API sync
  view/          # world + entity render nodes: ship, combat, effects, world
  ui/            # screen-space UI nodes: minimap, HUD, hangar, overlays
tests/
  game.test.js   # unit tests for game logic
  api.test.js    # HTTP + persistence integration tests
  client.test.js # client core tests: node tree + camera
  e2e.spec.js    # Playwright browser tests
```
