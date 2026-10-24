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
- Docking replaces the world and flight HUD with full-screen station services.
  Manage ships, modules, fittings, skills, inventory, industry, achievements,
  and agent contracts there. NPCs at every station exchange three items of a
  tier for one of the next tier. NPCs sell basic Tier I module blueprints;
  higher-tier module and ship blueprints drop as rat loot. Blueprints are
  consumed to manufacture ships or modules; the shipyard progression tree shows
  skill prerequisites, blueprint status, and material requirements for every
  hull. Launch leaves the ship floating outside the
  station; it does not steer back automatically, even if the hold is full.
  Fitting consumes a module from inventory; un-fitting returns it.
- Press C (or the Char button) any time to open the character sheet. Press I
  (or Inventory) to see ship cargo plus **quantum storage** — a shared
  warehouse for ore and components, accessible at every station and safe from
  ship loss. Blueprints and modules are also inventory items.
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

The server owns validated game state, world rules, economy, combat, and save
files. The browser renders the world and HUD, handles local smooth movement,
and sends player actions to the server.

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
    ├── CharacterNode
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

### actions (parallel)

more interesting geometric shapes for the in-space elements.

### questions



what are the 5 biggest files (most lines)? i would like to make sure files are mostly classes and split down reasonbly, so they aren't too big and have too much responsibility. also make sure methods are generally small and well-named. many smaller well-named methods is better then few complex ones. please try to follow "clean code" principles.
