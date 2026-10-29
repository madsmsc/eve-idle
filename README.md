# EVE Idle

A small idle game rendered as a 2D top-down world. Fly to asteroid belts to
mine, stations to barter, and hostile ships to fight. Trade ore and components
for blueprints, then manufacture ships and modules. A ship's stats are its base
stats plus its equipped modules. A parked ship keeps mining while you are away,
and a full cargo hold recalls it to a station to store its materials.

## How to play

- Navigate by steering to a destination over time: click the overview map or a
  visible object, or use the nearest belt, station, and rat buttons. Fly to a
  gate and jump to another
  system. Navigation is single-click: every belt, station, rat, moon, planet and
  gate is reachable by clicking it (or its dot on the overview map), so systems
  stay large and open instead of being split into small "pockets".
- Engage nearby enemies to fight. Use shield boost, weapon overload, or
  disengage. Ship loss destroys the ship's cargo.
- Docking unlocks station services. Their menus remain visible and inspectable
  while undocked, but actions are disabled until you dock. Manage ships,
  modules, fittings, skills, inventory, achievements, and agent contracts.
  Each station has security, mining, and industry agents with repeatable
  randomized contracts. Accept one contract per agent; matching actions
  advance all active contracts, including contracts from other stations.
  Completing missions and unlocking achievements
  triggers an automatic celebration toast. NPCs at every station exchange
  three items of a tier for one of the next tier. The Market separates NPC
  blueprints from the ore/component trade-up exchanges. NPCs sell basic Tier I module blueprints;
  higher-tier module and ship blueprints drop as rat loot. Blueprints are
  consumed to manufacture ships or modules; select one in Cargo and click
  Craft. The Ship Tree shows every hull, highlighting ships whose skill
  prerequisites you meet and listing missing skills. Launch leaves the ship
  floating outside the station; it does not steer back automatically, even if
  the hold is full.
  Cargo shows the ship's inventory with shared Quantum Storage always listed
  beneath it. Storage is view-only while undocked and supports transfers while
  docked. The separate Fitting menu shows the active
  ship's loadout and available modules, including modules held in storage.
  Equip or remove modules while docked; larger ship tiers have more total
  fitting slots while hulls keep their role-specific slot layouts.
- Press I (or Cargo) to view the cargo hold and Quantum Storage. Storage is
  shared across stations and safe from ship loss; retrieve stored items from
  the Cargo menu while docked. Use the
  cargo filters with Store filtered to transfer only the visible item types.
- Rats drop a small amount of Scrap and may drop modules or higher-tier
  blueprints. The target readout estimates combat difficulty from your fitted
  ship and the target's stats; it is a guide, not a guarantee. Salvage unwanted
  modules into components; ore and components each have their own 3:1 tier
  exchange ladder. There is no currency balance or faction standing system.
- Skill points accrue continuously in real time, whether or not you are logged
  in. Offline skill-point accrual is not capped; mining and combat catch-up are.
- Systems have two asteroid belts with larger rock fields, two outposts with
  clustered pirate groups, and navigational sites spaced apart. The HUD shows
  cargo used versus capacity while mining; base mining yield is halved.
- Auto repeats the mining loop: mine, recall when full, store materials, and return to a
  belt. Tutorial hints introduce DEMO play; an offline report summarizes gains
  after a break.

## Modes and storyline

Each mode has its own save:

- **DEMO** is an open sandbox with three systems and the game economy.
- **START** is a guided Jita pilot-training course. Complete eight missions to
  learn combat, range, ship loss and recovery, mining, drones, industry, and
  gate travel. Gates unlock after certification; a further mission opens in
  Placid, alongside the continuing sandbox.

## Run

```bash
npm install
npm start
```

### Development with automatic reload

Stop any currently running server with `Ctrl+C`, then run:

```bash
npm run dev
```

This restarts the Node process when server-side JavaScript changes and refreshes
the browser when files under `public/` change. Use `npm start` for normal runs
without development reloads.

## Performance benchmark

Run `npm run perf` to benchmark the browser renderer and server using an isolated,
temporary save. The report compares scene update/render timings with the
minimap visible and hidden, and measures game view/tick plus HTTP state/tick
latency. It prints optimization leads when measurements cross the report
thresholds; use the numbers to decide what to profile next rather than treating
the suggestions as automatic fixes.

```bash
npm run perf
npm run perf -- --duration 12
npm run perf -- --json
```

The duration is 6 seconds per frontend scenario by default and can be set from
3 to 60 seconds. Close other CPU-intensive applications for more comparable
runs. Results depend on the machine and browser and should be compared across
repeated runs on the same setup.

Open http://localhost:3000. Set `PORT` and `DATA_FILE` environment variables to
override the port and save location.

## Tests

```bash
npm run test:unit       # game logic and validation
npm run test:api        # HTTP API and persistence
npm run test:client     # client core and rendering tree
npm run test:e2e        # fast Playwright browser checks
npm run test:e2e:full   # complete browser suite, including real-time gameplay
npm test                # unit, API, and client tests
npm run test:all        # complete suite
```

Install the Playwright browser the first time you run E2E tests:

```bash
npx playwright install chromium
```

## Architecture

The server owns validated game state, world rules, economy, combat, ship
movement, autopilot decisions, and save files. The browser renders the world
and HUD, interpolates server positions for smooth motion, and sends player
intents such as destinations and actions. Derived progression readiness,
offers, and cooldowns are included in the server state view.

The render/update tree is rooted at `App.root`. Child order is the update and
render order:

```text
root: Node
├── WorldNode
│   ├── StarNode
│   ├── BeltNode
│   ├── PlanetNode
│   ├── MoonNode
│   ├── AsteroidNode
│   ├── StationNode
│   ├── GateNode
│   ├── EnemyNode
│   ├── ShipNode
│   ├── CombatNode
│   └── EffectsNode
└── UINode
    ├── HangarNode
    ├── InventoryNode
    ├── MinimapNode
    ├── HudNode
    └── OverlaysNode
```

The scene graph is flat and keyed by entity type: one node per kind of thing
(e.g. `BeltNode`, `AsteroidNode`), each iterating that kind from the current
state. Asteroids carry a `beltId` back to their belt rather than being nested
under it, which keeps rendering O(types) and keeps the tree stable across syncs.

Key files/folders:

```text
server/       Game configuration, rules, persistence, and HTTP API
public/
  core/       App orchestration, input, player motion, camera, and API sync
  view/       World, ship, combat, and effects rendering
  ui/         Minimap, HUD, Hangar, character sheet, inventory, and overlays
  main.js     Browser entry point
tests/        Unit, API, client, and Playwright E2E tests
```

## TODOs

in the upper left hand corner, please place a "system" text in grey above the actual system name (like "placid"). and under the system name please put a horizontal line. under that, please place "sec status" and under that the current system security status (not the player's! the player should not have their own sec status. sec status is an attribute of systems and characters should not have any attributes like that, or rep, or money/gold/currency, etc... progression should all be items - ships, modules, ore, components...). under the sec status number line, please put another horizontal line, and under that list all the current mission objectives on their own lines.

when using autopilot and dropping off loot, please wait for the docking animation, let the station show for 1 sec, then show a brief animation around the deposit button before actually depositing, show the station ui for another 1sec to allow the player to see everything was deposited, and the undock. this will take a little longer (which is fine because auto-pilot shouldn't be optimal - there should be an opportunity cost associated with choosing to not pilot manually). and please dont hard-code these delays. we will probably want to change them slightly depending on how it feels.

for hotkeys, mining already has "a". please add "f" for fight (i want to remove all mentions of hunt and rat, throughout all ui, and all code, even if it's just an identifier that never gets shown in the game, i want to code to refer to them as enemies, not rats) - add "b" for both. please change the icons for the "both" auto item to a unicode ampersand if it exists - otherwise some other cool symbol showing it's doing "both" or 2 things at the same time.

the asteroids have some weirdness in their graphics. they appear to be faceted grey but theres a single triangle that has its outline either colored green, blue, or purple, and the same with the asteroid centers. what's going on there? also, asteroids seem to sometimes overlap, that shouldn't happen.

do you have unit tests for all buttons and main functionality like docking, buying from market, moving between cargo/storage?

i would like to try showing the minimap more like it's done in eve online. let's do both for now and see what works best. to implement the eve online way, please show small icons at the edges of the view in the direction of belts/stations/outposts/gates - those are the only 4 warpables in space, right? and let's try to show the distance in text next to the icon. we'll play around with it to see what works. let's be able to switch between the views by having 3 buttons at the top right where the current "x" button is that minimizes the minimap. the X button should be called "none" and not show the edge map (our name for the eve online way) or the minimap. to the left of it should be "mini" which should show the minimap (kinda what the "v" menu button does now), and to the left of that should be a "edge" button which hides the minimap and shows the new edge map you're implementing.

please always show the conditional actions like jumping, engaging and mining (i don't think mining is currently hidden so keep it as is). but of course keep them disabled if the player isn't close enough to do that particular thing.

belts and other things in space have their text labels under other things. please make sure labels are always above other things. enemies in particular are suffering from this. please see what you can do to minimize and space out the info above enemy ships. it's pretty unreadable as is.

