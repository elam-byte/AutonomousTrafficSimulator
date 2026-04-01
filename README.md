# Autonomous Traffic Simulator (ATS)

> **This project is a case study for distributed, real-time orchestration architectures** — the same class of systems that powers autonomous vehicle fleets, robotic warehouse coordination, multi-drone swarm control, gaming NPC simulation at scale, and live financial matching engines. Anywhere you need many independent agents acting simultaneously under a hard real-time deadline, with a central environment enforcing physics and rules, this architecture applies directly.

---

## What This Is

The Autonomous Traffic Simulator is a full-stack, containerised runtime that places multiple autonomous vehicle agents on a road network and simulates their movement in real time at 20 Hz. Each vehicle is an independent Docker container running its own control algorithm. A central environment process owns the world state, distributes personalised observations, integrates physics, and broadcasts live snapshots to a browser visualiser — all over a NATS message bus.

The system is designed to be **extended, not just run**. Swap the vehicle agent for any AI model, rule-based planner, or reinforcement learning policy. Scale to dozens of vehicles by launching more containers. Load any road map exported from the companion map editor. The infrastructure stays the same.

---

## Why This Architecture Matters

Most multi-agent systems face the same set of hard problems:

| Problem | ATS solution |
|---------|-------------|
| Agents must act independently without blocking each other | One container per vehicle; NATS pub/sub decouples everything |
| The environment must be consistent regardless of agent latency | Central tick loop at 20 Hz; stale commands trigger a safe fallback |
| Observations must be personalised per agent | Per-vehicle 100 m lane corridor computed and published individually |
| Visualisation must not block the simulation | Viz-Gateway is a separate process with latest-only, drop-on-slow semantics |
| The road network can be arbitrarily complex | Lane graph built from a declarative map JSON; topology is data, not code |

This pattern — **environment process + message bus + stateless agents + separate visualisation bridge** — scales from a laptop running Docker Compose to a Kubernetes cluster with hundreds of pods with minimal architectural change.

---

## Architecture

### Component Overview

```
┌─────────────────────────────────────────────────────────────────────┐
│                        Docker Compose / K8s                         │
│                                                                     │
│  ┌──────────────┐     NATS JetStream      ┌────────────────────┐   │
│  │  ATS-Env     │──► sim.obs.{id} ───────►│  Vehicle Agent(s)  │   │
│  │  (TypeScript)│◄── sim.cmd.{id} ────────│  (Python, Docker)  │   │
│  │              │                         └────────────────────┘   │
│  │  World State │──► sim.snapshots ──────►┌────────────────────┐   │
│  │  Physics     │                         │  Viz-Gateway       │   │
│  │  Lane Graph  │                         │  (Node.js)         │   │
│  └──────────────┘                         │  WebSocket :8090   │   │
│         ▲                                 └────────┬───────────┘   │
│         │ map JSON at startup                      │               │
│  ┌──────┴──────┐                          ┌────────▼───────────┐   │
│  │  Map File   │                          │   viewer.html      │   │
│  │  (JSON)     │                          │   (Browser)        │   │
│  └─────────────┘                          └────────────────────┘   │
└─────────────────────────────────────────────────────────────────────┘
```

### Services

**ATS Environment (`ats-env`)**
The authoritative world process. It loads the road map once at startup, builds the lane graph, and runs a fixed 20 Hz tick loop. Each tick it sends a `VehicleObservation` (position, heading, speed, 100 m lane corridor) to every vehicle over NATS, waits up to 50 ms for `VehicleCommand` responses, integrates physics for all vehicles, then publishes a `WorldSnapshot`. Agents that miss the deadline receive a safe-stop command automatically.

**Vehicle Agent (`vehicle-agent`)**
A stateless Python service. Each tick it receives one `VehicleObservation` and returns one `VehicleCommand` (desired acceleration and steering angle). The controller implements a **Stanley lane-centering algorithm**: it simultaneously corrects heading error and lateral deviation from the lane centreline, pre-brakes before entering curves by scanning 20 m of upcoming corridor, and reduces speed proportionally when the vehicle drifts off centre. One container can serve a single vehicle or an entire fleet.

**Viz-Gateway (`viz-gateway`)**
A thin Node.js bridge between NATS and the browser. It subscribes to `sim.snapshots`, holds the latest frame, and pushes it to all connected WebSocket clients at 20 Hz. Slow clients are dropped rather than buffered — the simulation never waits for the visualiser.

**NATS**
The message bus. All inter-service communication flows through NATS subjects. No service holds a direct reference to any other, making it trivial to attach new consumers (loggers, recorders, analysis tools) without touching existing components.

---

## Road Map Format

Maps are authored in the companion **MapGenerator** tool and saved as `ATS Map JSON v1` files placed in the `map/` directory. A map describes:

- **Roads** — straight line segments or circular arcs, each with lane count, lane width, and implied speed limit by road type
- **Junctions** — intersection metadata (4-way, T-junction) with explicit lane wiring for cross-road connections that geometry alone cannot resolve
- **Vehicles** — initial positions, headings, dimensions, and colours

The environment builds a directed **lane graph** from the map at startup. Each road produces two lane edges: the right lane travels in the road's authored direction, the left lane travels in reverse. Geometric proximity connects lane endpoints automatically; explicit `connections` entries in the map handle T-junctions and 4-way intersections.

### Included Maps

| File | Description |
|------|-------------|
| `ats-map-1vehicleTestmap.json` | Simple oval, single vehicle — ideal for controller tuning |
| `ats-map-v1.json` | Oval with four vehicles on opposing lanes |
| `ats-map-10VehicleBigMap.json` | Figure-eight grid with 10 vehicles, T-junctions, and interior cross-roads |

---

## Design Principles

**Hard real-time tick loop**
The environment advances the world on a fixed 50 ms schedule regardless of agent behaviour. This mirrors how real embedded control systems work: the world does not pause for a slow controller. Agents that miss a tick get a safe fallback; the simulation stays on schedule.

**Stateless agents**
Vehicle agents carry no persistent world state between ticks. All context they need is in the observation. This makes agents trivially replaceable, horizontally scalable, and independently deployable — swap the algorithm without restarting the environment.

**Data-driven road topology**
The lane graph is built entirely from the map JSON. Road geometry, speed limits, junction wiring, and initial vehicle positions are all configuration, not code. Changing the map file changes the simulation without recompiling anything.

**Speed limits per road type**
Straight roads enforce 20 km/h; arcs enforce 10 km/h. The vehicle agent reads the speed limit from the corridor and pre-brakes before limit transitions, giving smooth, physically plausible cornering behaviour without any explicit curvature detection logic in the agent.

**Separation of concerns**
Environment, agents, visualisation, and messaging are four independent processes with no shared memory. Each can be scaled, replaced, or restarted independently without affecting the others.

**Backpressure by design**
The viz-gateway never blocks the NATS consumer. Latest-only semantics mean the visualiser always shows the most recent frame and never causes the simulation to fall behind, regardless of browser or network conditions.

**Cyclic lane graph convention**
All roads are authored in the anticlockwise direction. The right lane always travels in the road's forward direction; the left lane always travels in reverse. This produces two independent closed circuits per route — one in each direction — with no dead ends, enabling clean cyclic traversal and predictable junction routing.

---

## Coordinate System

All positions and angles use a consistent right-hand coordinate system throughout — map editor, environment, vehicle agents, and visualiser share the same convention with no conversions at component boundaries.

- **Origin** — bottom-left of the world
- **+x** — rightward
- **+y** — upward
- **Heading** — radians, 0 = east, counter-clockwise positive

---

## Performance Targets

| Metric | Target |
|--------|--------|
| Environment tick (p95) | < 40 ms |
| Lane corridor construction per vehicle | < 5 ms |
| Viz-Gateway WebSocket broadcast (p95, ≤ 10 clients) | < 2 ms |
| Vehicle agent response (p95) | < 30 ms |

---

## Prerequisites

- **Docker** and **Docker Compose v2**
- **Node.js 20+** and **pnpm** (for running components outside Docker)
- **Python 3.12+** (for running the vehicle agent or test scripts outside Docker)
- A map file in `map/` — three are included

---

## Running the Full Stack

One command starts everything:

```
docker compose up
```

This starts NATS, the ATS environment, the vehicle-agent, and the viz-gateway. Open `viz-gateway/viewer.html` in a browser and connect to `ws://localhost:8090` to watch the simulation live.

To load a map, POST any of the included map JSON files to `http://localhost:8090/map` with the `X-Map-Filename` header set to the filename. The viz-gateway saves it, notifies ats-env over NATS, and the simulation begins within one tick. To switch maps, POST a different file — no restart required.

---

## Running Individual Components

Each component can be run outside Docker for development and debugging.

**ATS Environment** — install Node dependencies with pnpm from the `ats-env/` directory, then run in watch mode with `pnpm dev:env`. The environment connects to NATS at the address in the `NATS_URL` environment variable (default `nats://localhost:4222`).

**Vehicle Agent** — install the Python package in editable mode with `pip install -e .` inside `vehicle-agent/`, then run with `python -m vehicle_agent`. The agent connects to the same NATS instance and responds to all vehicle observation subjects it receives.

**Viz-Gateway** — run `node viz-gateway.js` from the `viz-gateway/` directory. Exposes the WebSocket server and the map upload HTTP endpoint on port 8090.

---

## Test Scripts

The `scripts/` directory contains standalone test utilities. All require `nats-py` (`pip install nats-py`).

| Script | Purpose |
|--------|---------|
| `test-ats-env.py` | Acts as a mock vehicle agent — sends simple commands and prints observations tick by tick |
| `test-vehicle-agent.py` | Sends a synthetic observation directly to the vehicle agent HTTP endpoint |
| `test-viz-gateway.py` | Connects to the WebSocket and prints incoming snapshots |
| `spy-nats.py` | Subscribes to all `sim.*` subjects and prints raw NATS traffic |

A dedicated diagnostic script is also available inside `ats-env/`:

```
cd ats-env && npx tsx scripts/print-lane-graph.ts
```

This loads all three maps and prints the complete lane graph — every edge, its endpoints, successors, predecessors, cross-side connections, and cycle reachability — without starting any services.

---

## Extending the System

**Swap the controller**
Edit `vehicle-agent/vehicle_agent/controller.py`. The interface is a single function: receive a `VehicleObservation`, return a `VehicleCommand`. Replace the Stanley controller with an MPC solver, a neural network policy, or a rule-based planner without touching anything else.

**Add more vehicles**
Add vehicle entries to the map JSON and scale the `vehicle-agent` service in Docker Compose. Each agent instance handles all vehicle IDs it receives observations for.

**Add new consumers**
Subscribe to `sim.snapshots` or `sim.obs.>` on NATS to attach loggers, recorders, analytics pipelines, or secondary visualisers without modifying any existing service.

**Author a new map**
Use the companion MapGenerator tool to draw roads and junctions, export as `ATS Map JSON v1`, drop the file into `map/`, and upload it via the viz-gateway endpoint.

**Deploy to Kubernetes**
Each service maps cleanly to a Deployment. NATS runs as a StatefulSet. The environment and viz-gateway are single-replica services; vehicle agents can be scaled horizontally. The only required change is pointing `NATS_URL` at the cluster-internal NATS service address.

---

## Repository Layout

```
AutonomousTrafficSimulator/
├── ats-env/                   TypeScript environment process
│   ├── src/
│   │   ├── roadGraph.ts       Lane graph construction, walking, connectivity
│   │   ├── corridorBuilder.ts Per-vehicle 100 m corridor builder
│   │   ├── physics.ts         Kinematic bicycle model integration
│   │   ├── tickLoop.ts        20 Hz world tick and NATS orchestration
│   │   ├── mapLoader.ts       Map JSON parsing and validation (Zod)
│   │   └── vehicleState.ts    In-memory vehicle store and route choices
│   └── scripts/
│       └── print-lane-graph.ts  Diagnostic: full graph dump for any map
├── vehicle-agent/             Python vehicle controller
│   └── vehicle_agent/
│       ├── controller.py      Stanley lane-centering controller
│       └── types.py           Pydantic message schemas
├── viz-gateway/               Node.js NATS→WebSocket bridge + viewer
├── shared/                    Shared TypeScript map type definitions
├── map/                       ATS Map JSON v1 files
│   ├── ats-map-1vehicleTestmap.json
│   ├── ats-map-v1.json
│   └── ats-map-10VehicleBigMap.json
├── scripts/                   Integration test and diagnostic utilities
└── docker-compose.yml
```
