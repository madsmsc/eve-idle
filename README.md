# EVE Idle

A small idle game rendered as a 2D top-down world. Warp to asteroid belts to
mine, stations to trade, and hostile ships to fight. Use your earnings to
upgrade ships, modules, skills, and drones. A parked ship keeps mining while
you are away, and a full cargo hold recalls it to a station to sell.

## How to play

- Navigate with the system overview map, click visible objects, or use the
  nearest belt, station, and rat buttons. Warp to a gate and jump to another
  system.
// TODO: this navigation does not work well - maybe we need to change the world to smaller "pockets"
// like in eve online and those are smaller and easily navigable by clicking things.
// but that leaves the navigation between pockets in the same system - do you have an idea?
- Engage nearby enemies to fight. Use shield boost, weapon overload, or
  disengage. Ship loss costs your cargo; insurance covers part of the ship's
  purchase price.
- Use the Hangar to manage ships, modules, fitting presets, skills, drones,
  loot, industry, achievements, and agent contracts. Module tier changes have
  a cost or refund. Selling loot and refining modules require docking.
- Each system has its own security level, faction, and market prices. Faction
  standing affects prices and gate ambush risk. Drones add mining or combat
  support. Modules and ships can be crafted from ore while docked.
- Auto repeats the mining loop: mine, recall when full, sell, and return to a
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
    ├── MinimapNode
    ├── HealthBarNode
    ├── HudNode
    └── OverlaysNode
```

// TODO: i was expecting deeper nesting, so for example asteroid being a child of belt, and a best containing many asteroids.
// but maybe thats not how you envisioned it. please let me know.

Key files/folders:

```text
server/       Game configuration, rules, persistence, and HTTP API
public/
  core/       App orchestration, input, player motion, camera, and API sync
  view/       World, ship, combat, and effects rendering
  ui/         Minimap, HUD, Hangar, and overlays
  main.js     Browser entry point
tests/        Unit, API, client, and Playwright E2E tests
```
