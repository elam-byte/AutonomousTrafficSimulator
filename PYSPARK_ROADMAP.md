# PySpark Extension Roadmap

Planned extensions to the Autonomous Traffic Simulator using PySpark for large-scale analytics, ML pipelines, and distributed scenario testing.

---

## Why PySpark Here

The simulation generates 20 Hz × N vehicles of structured telemetry continuously. Over any meaningful run this becomes millions of records — positions, headings, speeds, lateral deviations, junction choices, corridor snapshots. This is exactly the scale where pandas breaks down and PySpark becomes the right tool. Beyond volume, PySpark's Structured Streaming layer lets us consume the same NATS data in real time that the visualiser already uses, with no changes to existing services.

---

## Extension 1 — Real-Time Traffic Analytics (Structured Streaming)

### What it does
Bridge NATS → Kafka, then run a Spark Structured Streaming job that consumes `sim.snapshots` and computes sliding-window aggregates in real time.

### Metrics to compute
- Congestion score per road segment: average speed as a fraction of speed limit, per edge, per 10-second window
- Junction throughput: vehicles per minute passing through each fork edge
- Near-collision alerts: any two vehicles on the same lane edge within a configurable distance threshold
- Vehicle density heatmap: count of vehicles per grid cell across the world bounds

### New components needed
- A NATS → Kafka bridge service (thin Node.js or Python process, subscribes to `sim.snapshots` and `sim.obs.>`, publishes to Kafka topics)
- Spark Structured Streaming job reading from Kafka, writing aggregates to a sink (console, Redis, or a dashboard WebSocket)

### Why no existing service changes
The bridge is a pure NATS consumer — it does not publish back. The rest of the stack is unaware it exists.

### Suggested starting point
Start with congestion scoring only. One Spark job, one Kafka topic (`sim-snapshots`), output to console. Expand from there.

---

## Extension 2 — Historical Run Analytics (Batch on Parquet)

### What it does
Add a recorder service that writes all simulation messages to Parquet files (one partition per run). Spark batch jobs then answer questions about simulation quality that real-time cannot.

### Recorder service
- Subscribes to `sim.snapshots` and `sim.obs.>` on NATS
- Buffers and flushes to Parquet every N seconds or M records
- Partitions by `run_id / date / vehicle_id`
- Can be started and stopped independently of the simulation

### Analytics jobs to build
| Job | Question answered |
|-----|------------------|
| Lateral deviation report | What is the p50/p95/p99 lateral deviation per road type (line vs arc) across all runs? Validates controller quality. |
| Speed profile per lap | Plot average speed at each corridor position around a circuit — reveals overshoot, undershoot, oscillation |
| Junction slowdown ranking | Which junctions caused the most average speed reduction? Identifies map geometry problems |
| Dead-end incidents | Did any vehicle lose its corridor (empty lane_corridor in observation)? How often, on which edge? |
| Controller regression detector | Compare lateral deviation distributions between two run sets — flag if a code change made things worse |

### Storage layout
```
data/
  runs/
    {run_id}/
      snapshots/      Parquet partitioned by minute
      observations/   Parquet partitioned by vehicle_id
      meta.json       Map file used, start time, vehicle count
```

### Suggested starting point
Build the recorder first (one Python service, ~100 lines). Run the simulation for 10 minutes, then write a single PySpark notebook that reads the observation Parquet and produces a lateral deviation histogram per road type.

---

## Extension 3 — ML Training Data Pipeline

### What it does
The vehicle agent is currently rule-based (Stanley controller). To replace it with a learned policy, a labelled training dataset must be generated from simulation telemetry. PySpark handles the scale — millions of (observation, command, outcome) tuples require shuffling, filtering, and feature engineering that does not fit in memory with pandas.

### Pipeline stages

**Stage 1 — Raw telemetry collection**
Run the simulation with the existing Stanley controller for many hours across all three maps. Record all observations and commands to Parquet via the recorder from Extension 2.

**Stage 2 — PySpark feature engineering job**
For each (observation, command) pair, compute:
- Lateral deviation at time t and at t+1 (outcome)
- Heading error at t
- Speed relative to speed limit
- Upcoming curvature (min speed_limit in next 20 corridor points)
- Was the command good? (label: did lateral deviation decrease at t+1?)

**Stage 3 — Dataset preparation**
- Join observations with next-tick observations to build (state, action, next_state) triples
- Filter out startup ticks (vehicles accelerating from rest)
- Balance the dataset across road types (arc vs line) to prevent bias toward straight roads
- Shuffle, split train/val/test, write to final Parquet ready for PyTorch DataLoader

**Stage 4 — Model training (outside PySpark)**
The output Parquet feeds a standard PyTorch training loop. The trained model weights are packaged into the vehicle-agent Docker image as a drop-in replacement for `controller.py`.

### Why PySpark specifically
A 10-hour simulation at 20 Hz with 10 vehicles produces ~7.2 million observation records. The join to compute next-state, the balance operation, and the shuffle across vehicle and road type require distributed processing — this is a typical ETL job PySpark is built for.

---

## Extension 4 — Distributed Scenario Testing

### What it does
Use Spark workers to launch and evaluate many parallel simulation instances with different configurations. Each Spark task runs one simulation scenario and returns a summary metrics dict.

### Use cases
- **Controller hyperparameter sweep**: grid search over `K_LATERAL` (1.0–4.0) and `PREBRAKE_HORIZON` (10–30) — find the combination that minimises average lateral deviation across all three maps
- **Vehicle density stress test**: run the 10-vehicle map with 5, 10, 15, 20 vehicles and measure junction throughput degradation
- **A/B controller comparison**: run 500 scenarios with Controller A and 500 with Controller B, compare distributions of lateral deviation, speed profile adherence, and near-collision count
- **Map robustness testing**: introduce small random perturbations to vehicle start positions and measure how often vehicles lose their corridor

### Architecture
Each Spark task:
1. Writes a modified `docker-compose.override.yml` with the scenario parameters
2. Runs `docker compose up` with a timeout
3. Collects output metrics from the recorder Parquet
4. Returns a metrics dict to the Spark driver

The driver aggregates all results into a single DataFrame and writes a summary report.

### Prerequisite
Extension 2 (Parquet recorder) must exist first so each scenario produces measurable output.

---

## Extension 5 — Road Graph Analysis with GraphFrames

### What it does
The lane graph is a directed graph with lane edges as vertices and successor relationships as edges. Spark GraphFrames enables graph-scale algorithms over it.

### Analyses
- **PageRank** on the lane graph: identifies the most-traversed edges under random-walk vehicle routing — useful for predicting traffic hotspots before running a full simulation
- **Shortest path** between any two lane edge IDs: enables explicit route planning rather than random junction choices
- **Strongly connected components**: verifies that all lanes are reachable from all other lanes — automated correctness check for new maps
- **Betweenness centrality**: identifies junction edges that are bottlenecks in the network

### Input
The lane graph produced by `buildGraph()` in `roadGraph.ts` can be exported to JSON (edge list + vertex list) by extending `print-lane-graph.ts`. The PySpark job reads this JSON and constructs a GraphFrame.

---

## Recommended Build Order

| Phase | Extension | Estimated sessions | Dependency |
|-------|-----------|--------------------|------------|
| 1 | Parquet recorder service | 1 | None — build this first |
| 2 | Lateral deviation batch analytics notebook | 1 | Phase 1 |
| 3 | NATS → Kafka bridge | 1 | None |
| 4 | Structured Streaming congestion job | 1 | Phase 3 |
| 5 | ML training data pipeline | 2 | Phase 1 |
| 6 | Distributed scenario testing | 2 | Phase 1 |
| 7 | GraphFrames road graph analysis | 1 | None (standalone) |

---

## Infrastructure to Add

| Component | Purpose | Notes |
|-----------|---------|-------|
| Apache Kafka | Buffer between NATS and Spark Streaming | Use `bitnami/kafka` Docker image |
| NATS→Kafka bridge | Forward sim messages to Kafka topics | New thin service |
| Apache Spark cluster | Batch and streaming jobs | Local mode sufficient for dev; YARN/K8s for prod |
| Delta Lake or plain Parquet | Persistent telemetry store | Delta preferred for schema evolution |
| Parquet recorder service | Write sim telemetry to disk | New Python service, ~100 lines |
| Jupyter notebook server | Interactive PySpark development | Standard `jupyter/pyspark-notebook` image |

All additions plug in as new Docker Compose services. No changes to `ats-env`, `vehicle-agent`, or `viz-gateway`.

---

## Starting Point for Tomorrow

**Session goal:** get one end-to-end PySpark result from real simulation data.

1. Write the Parquet recorder service (Python, subscribes to NATS, writes to `data/runs/`)
2. Run the simulation for 5–10 minutes with `ats-map-v1.json`
3. Open a PySpark notebook, read the observation Parquet
4. Compute and plot lateral deviation per road type (line vs arc)

This validates the full pipeline — recorder → storage → PySpark — and produces a meaningful result (controller quality report) in a single session. Everything else builds on top of it.
