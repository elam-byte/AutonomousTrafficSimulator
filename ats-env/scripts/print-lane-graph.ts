/**
 * Diagnostic script: print full lane graph for all 3 maps.
 *
 * Run:
 *   cd ats-env
 *   npx tsx scripts/print-lane-graph.ts
 *
 * No NATS, no Docker needed — reads map JSON and runs the road graph builder directly.
 */

import { resolve, dirname } from "path";
import { fileURLToPath } from "url";
import { loadMap } from "../src/mapLoader.js";
import { buildGraph } from "../src/roadGraph.js";
import type { LaneEdge } from "../src/types.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const MAP_DIR = resolve(__dirname, "../../map");

const MAPS = [
  "ats-map-1vehicleTestmap.json",
  "ats-map-v1.json",
  "ats-map-10VehicleBigMap.json",
];

// ANSI colours
const RED    = "\x1b[31m";
const GREEN  = "\x1b[32m";
const YELLOW = "\x1b[33m";
const CYAN   = "\x1b[36m";
const BOLD   = "\x1b[1m";
const RESET  = "\x1b[0m";

function fmt(n: number, d = 2) { return n.toFixed(d); }

function checkCycle(edges: Map<string, LaneEdge>, startId: string): { cyclic: boolean; steps: number; path: string[] } {
  const path: string[] = [startId];
  let cur = startId;
  const maxSteps = edges.size * 2 + 10;
  for (let i = 0; i < maxSteps; i++) {
    const edge = edges.get(cur);
    if (!edge || edge.next.length === 0) return { cyclic: false, steps: i, path };
    // Follow first successor
    const next = edge.next[0];
    if (next === startId) return { cyclic: true, steps: i + 1, path };
    if (path.includes(next)) return { cyclic: false, steps: i + 1, path }; // hit a different cycle
    path.push(next);
    cur = next;
  }
  return { cyclic: false, steps: maxSteps, path };
}

for (const mapFile of MAPS) {
  const mapPath = resolve(MAP_DIR, mapFile);
  console.log();
  console.log(`${BOLD}${"═".repeat(70)}${RESET}`);
  console.log(`${BOLD}${CYAN}MAP: ${mapFile}${RESET}`);
  console.log(`${"═".repeat(70)}`);

  let map, graph;
  try {
    map = loadMap(mapPath);
    // buildGraph prints its own dead-end warnings — suppress by temporarily overriding console.warn
    const warnings: string[] = [];
    const origWarn = console.warn;
    console.warn = (...args: unknown[]) => warnings.push(args.join(" "));
    graph = buildGraph(map);
    console.warn = origWarn;
  } catch (e) {
    console.error(`  ERROR loading map: ${e}`);
    continue;
  }

  const edges = Array.from(graph.edges.values()).sort((a, b) => a.id.localeCompare(b.id));

  // ── Per-edge table ──────────────────────────────────────────────────────────
  console.log(`\n${BOLD}Lane Edges (${edges.length} total):${RESET}`);
  console.log(
    "  " +
    "Edge ID".padEnd(18) +
    "Dir  ".padEnd(7) +
    "Len(m)".padEnd(9) +
    "Start (x, y, h°)".padEnd(26) +
    "End (x, y, h°)".padEnd(26) +
    "Successors".padEnd(30) +
    "Predecessors"
  );
  console.log("  " + "─".repeat(130));

  let deadEnds = 0;
  let crossSide = 0;

  for (const edge of edges) {
    const start = edge.points[0];
    const end   = edge.points[edge.points.length - 1];

    const startStr = `(${fmt(start.x)}, ${fmt(start.y)}, ${fmt((start.heading * 180) / Math.PI, 1)}°)`;
    const endStr   = `(${fmt(end.x)},   ${fmt(end.y)},   ${fmt((end.heading * 180) / Math.PI, 1)}°)`;

    const isDeadEnd = edge.next.length === 0;
    if (isDeadEnd) deadEnds++;

    // Cross-side check: does any successor have a different direction?
    const crossSuccessors = edge.next.filter(nid => {
      const ne = graph.edges.get(nid);
      return ne && ne.direction !== edge.direction;
    });
    if (crossSuccessors.length > 0) crossSide++;

    const nextStr = isDeadEnd
      ? `${RED}[DEAD END]${RESET}`
      : edge.next.map(nid => {
          const ne = graph.edges.get(nid);
          const cross = ne && ne.direction !== edge.direction;
          return cross ? `${YELLOW}${nid}${RESET}` : nid;
        }).join(", ");

    const prevStr = edge.prev.length === 0 ? `${YELLOW}[no prev]${RESET}` : edge.prev.join(", ");

    const dirColor = edge.direction === "right" ? GREEN : YELLOW;

    console.log(
      "  " +
      edge.id.padEnd(18) +
      `${dirColor}${edge.direction.padEnd(6)}${RESET} ` +
      `${fmt(edge.length, 1).padEnd(9)}` +
      startStr.padEnd(26) +
      endStr.padEnd(26) +
      nextStr.padEnd(30) +
      prevStr
    );
  }

  // ── Summary ─────────────────────────────────────────────────────────────────
  console.log();
  console.log(`${BOLD}Summary:${RESET}`);
  console.log(`  Total edges  : ${edges.length}`);
  console.log(`  Dead ends    : ${deadEnds === 0 ? `${GREEN}0 ✓${RESET}` : `${RED}${deadEnds} ✗${RESET}`}`);
  console.log(`  Cross-side   : ${crossSide === 0 ? `${GREEN}0 ✓${RESET}` : `${YELLOW}${crossSide} (right↔left connections exist)${RESET}`}`);

  // ── Cycle checks ────────────────────────────────────────────────────────────
  console.log();
  console.log(`${BOLD}Cycle reachability:${RESET}`);

  const rightEdges = edges.filter(e => e.direction === "right");
  const leftEdges  = edges.filter(e => e.direction === "left");

  if (rightEdges.length > 0) {
    const { cyclic, steps, path } = checkCycle(graph.edges, rightEdges[0].id);
    const status = cyclic ? `${GREEN}CYCLIC in ${steps} hops ✓${RESET}` : `${RED}NOT cyclic ✗${RESET}`;
    console.log(`  Right lanes (from ${rightEdges[0].id}): ${status}`);
    if (!cyclic) {
      console.log(`    Path walked: ${path.slice(0, 10).join(" → ")}${path.length > 10 ? " ..." : " [stopped]"}`);
    }
  }

  if (leftEdges.length > 0) {
    const { cyclic, steps, path } = checkCycle(graph.edges, leftEdges[0].id);
    const status = cyclic ? `${GREEN}CYCLIC in ${steps} hops ✓${RESET}` : `${RED}NOT cyclic ✗${RESET}`;
    console.log(`  Left lanes  (from ${leftEdges[0].id}): ${status}`);
    if (!cyclic) {
      console.log(`    Path walked: ${path.slice(0, 10).join(" → ")}${path.length > 10 ? " ..." : " [stopped]"}`);
    }
  }

  // ── Fork/junction edges ──────────────────────────────────────────────────────
  const forks = edges.filter(e => e.next.length > 1);
  if (forks.length > 0) {
    console.log();
    console.log(`${BOLD}Forks / Junctions (${forks.length}):${RESET}`);
    for (const f of forks) {
      console.log(`  ${f.id}  →  ${f.next.join(", ")}`);
    }
  }
}

console.log();
console.log(`${BOLD}Done.${RESET}`);
