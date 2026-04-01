import type {
  AtsMap,
  Road,
  LineRoad,
  ArcRoad,
  LaneEdge,
  SampledPoint,
  RoadGraph,
  SpatialIndex,
  LaneCursor,
  LanePoint,
  JunctionInfo,
} from "./types.js";

const SPEED_LIMIT_STRAIGHT = 20 / 3.6; // 20 km/h → ~5.56 m/s
const SPEED_LIMIT_ARC     = 10 / 3.6; // 10 km/h → ~2.78 m/s
const SAMPLE_STEP = 1.0; // meters between samples
const CONNECT_TOLERANCE = 1.0; // meters for endpoint matching
const CONNECT_ANGLE_DEG = 30; // degrees max heading difference for connection
const CELL_SIZE = 5; // meters for spatial index grid

// ─── Angle utilities ──────────────────────────────────────────────────────────

function normalizeAngle(a: number): number {
  // Maps to (-π, π]
  let r = a % (2 * Math.PI);
  if (r > Math.PI) r -= 2 * Math.PI;
  if (r <= -Math.PI) r += 2 * Math.PI;
  return r;
}

function angleDiff(a: number, b: number): number {
  return Math.abs(normalizeAngle(a - b));
}

function dist2(ax: number, ay: number, bx: number, by: number): number {
  const dx = ax - bx;
  const dy = ay - by;
  return Math.sqrt(dx * dx + dy * dy);
}

// ─── Centerline sampling ──────────────────────────────────────────────────────

function sampleLine(road: LineRoad, side: "right" | "left"): SampledPoint[] {
  const dx = road.end.x - road.start.x;
  const dy = road.end.y - road.start.y;
  const roadLen = Math.sqrt(dx * dx + dy * dy);
  if (roadLen < 0.01) return [];

  const roadHeading = Math.atan2(dy, dx);
  const offset = road.lanes.laneWidth / 2;

  // Perpendicular: right of forward direction = (sin(h), -cos(h))
  // right lane offset: -laneWidth/2 in left direction = +offset in right direction
  // left lane offset: +laneWidth/2 in left direction
  const perpX = side === "right" ? Math.sin(roadHeading) : -Math.sin(roadHeading);
  const perpY = side === "right" ? -Math.cos(roadHeading) : Math.cos(roadHeading);
  const laneHeading = side === "right" ? roadHeading : normalizeAngle(roadHeading + Math.PI);

  const points: SampledPoint[] = [];
  const numSteps = Math.ceil(roadLen / SAMPLE_STEP);

  // Right lane: start→end (s increases from 0)
  // Left lane: end→start (s increases from 0 but position is reversed)
  for (let i = 0; i <= numSteps; i++) {
    const t = side === "right" ? i / numSteps : 1 - i / numSteps;
    const cx = road.start.x + dx * t;
    const cy = road.start.y + dy * t;
    points.push({
      x: cx + perpX * offset,
      y: cy + perpY * offset,
      heading: laneHeading,
      s: (i * roadLen) / numSteps,
    });
  }
  return points;
}

function sampleArc(road: ArcRoad, side: "right" | "left"): SampledPoint[] {
  if (road.radius < 0.01) return []; // degenerate arc (r-12), skip

  // Angular span — use the raw start/endAngle values as-is from the map.
  // The map was authored with CCW positive (standard math convention).
  // clockwise=false means the arc is traversed from startAngle to endAngle
  // in the CCW direction (angles increase if endAngle > startAngle).
  // We compute the signed span:
  let angSpan = road.endAngle - road.startAngle;

  // Wrap to shortest path consistent with the clockwise flag.
  if (!road.clockwise) {
    // CCW: span should be positive
    if (angSpan < 0) angSpan += 2 * Math.PI;
    if (angSpan > 2 * Math.PI) angSpan -= 2 * Math.PI;
  } else {
    // CW: span should be negative
    if (angSpan > 0) angSpan -= 2 * Math.PI;
    if (angSpan < -2 * Math.PI) angSpan += 2 * Math.PI;
  }

  const arcLen = road.radius * Math.abs(angSpan);
  if (arcLen < 0.01) return [];

  // Lane radius offset:
  // For a CCW arc (traversed CCW), right side = outside (larger radius), left side = inside.
  // Physical reasoning: facing forward along the arc, your right hand points outward.
  // For a CW arc, it is the opposite.
  const sign = road.clockwise ? -1 : 1; // +1 for CCW, -1 for CW
  const rightRadius = road.radius + sign * (road.lanes.laneWidth / 2);
  const leftRadius = road.radius - sign * (road.lanes.laneWidth / 2);

  const laneRadius = side === "right" ? rightRadius : leftRadius;
  if (laneRadius <= 0) return []; // degenerate

  // Right lane samples startAngle→endAngle (forward direction)
  // Left lane samples endAngle→startAngle (reverse direction)
  const numSteps = Math.ceil(arcLen / SAMPLE_STEP);
  const points: SampledPoint[] = [];

  for (let i = 0; i <= numSteps; i++) {
    const t = side === "right" ? i / numSteps : 1 - i / numSteps;
    const theta = road.startAngle + angSpan * t;

    // Position on the lane
    const x = road.center.x + laneRadius * Math.cos(theta);
    const y = road.center.y + laneRadius * Math.sin(theta);

    // Tangent direction:
    // For CCW arc (sign=+1): tangent = theta + π/2
    // For CW arc (sign=-1): tangent = theta - π/2
    let tangent = theta + sign * (Math.PI / 2);
    if (side === "left") tangent = normalizeAngle(tangent + Math.PI); // reversed

    points.push({
      x,
      y,
      heading: normalizeAngle(tangent),
      s: (i * arcLen) / numSteps,
    });
  }
  return points;
}

function sampleRoad(road: Road, side: "right" | "left"): SampledPoint[] {
  if (road.kind === "line") return sampleLine(road as LineRoad, side);
  return sampleArc(road as ArcRoad, side);
}

// ─── Spatial index ────────────────────────────────────────────────────────────

function cellKey(x: number, y: number, cellSize: number): string {
  return `${Math.floor(x / cellSize)},${Math.floor(y / cellSize)}`;
}

function buildSpatialIndex(edges: Map<string, LaneEdge>): SpatialIndex {
  const cells = new Map<string, Set<string>>();
  for (const edge of edges.values()) {
    for (const p of edge.points) {
      const key = cellKey(p.x, p.y, CELL_SIZE);
      let set = cells.get(key);
      if (!set) {
        set = new Set();
        cells.set(key, set);
      }
      set.add(edge.id);
    }
  }
  return { cellSize: CELL_SIZE, cells };
}

function candidateEdges(idx: SpatialIndex, x: number, y: number): string[] {
  const cx = Math.floor(x / idx.cellSize);
  const cy = Math.floor(y / idx.cellSize);
  const ids = new Set<string>();
  for (let dx = -1; dx <= 1; dx++) {
    for (let dy = -1; dy <= 1; dy++) {
      const key = `${cx + dx},${cy + dy}`;
      const set = idx.cells.get(key);
      if (set) for (const id of set) ids.add(id);
    }
  }
  return [...ids];
}

// ─── Graph connectivity ───────────────────────────────────────────────────────

function buildConnectivity(edges: Map<string, LaneEdge>): void {
  const ends: Array<{ edgeId: string; p: SampledPoint }> = [];
  const starts: Array<{ edgeId: string; p: SampledPoint }> = [];

  for (const edge of edges.values()) {
    if (edge.points.length === 0) continue;
    starts.push({ edgeId: edge.id, p: edge.points[0] });
    ends.push({ edgeId: edge.id, p: edge.points[edge.points.length - 1] });
  }

  const maxAngle = (CONNECT_ANGLE_DEG * Math.PI) / 180;

  for (const endPt of ends) {
    for (const startPt of starts) {
      if (endPt.edgeId === startPt.edgeId) continue;
      const d = dist2(endPt.p.x, endPt.p.y, startPt.p.x, startPt.p.y);
      if (d > CONNECT_TOLERANCE) continue;
      if (angleDiff(endPt.p.heading, startPt.p.heading) > maxAngle) continue;

      const edgeA = edges.get(endPt.edgeId)!;
      const edgeB = edges.get(startPt.edgeId)!;
      if (!edgeA.next.includes(startPt.edgeId)) edgeA.next.push(startPt.edgeId);
      if (!edgeB.prev.includes(endPt.edgeId)) edgeB.prev.push(endPt.edgeId);
    }
  }
}

// ─── Build graph ──────────────────────────────────────────────────────────────

export function buildGraph(map: AtsMap): RoadGraph {
  const edges = new Map<string, LaneEdge>();

  for (const road of map.roads) {
    for (const side of ["right", "left"] as const) {
      const count = side === "right" ? road.lanes.right : road.lanes.left;
      if (count === 0) continue;

      const points = sampleRoad(road, side);
      if (points.length === 0) continue; // skip degenerate (r-12)

      const len = points[points.length - 1].s;
      const id = `${road.id}:${side}`;
      edges.set(id, {
        id,
        roadId: road.id,
        direction: side,
        points,
        length: len,
        speedLimit: road.kind === "arc" ? SPEED_LIMIT_ARC : SPEED_LIMIT_STRAIGHT,
        width: road.lanes.laneWidth,
        next: [],
        prev: [],
      });
    }
  }

  buildConnectivity(edges);

  // Apply explicit lane connections from map (e.g. junction wiring)
  for (const conn of map.connections ?? []) {
    const fromEdge = edges.get(conn.from);
    if (!fromEdge) {
      console.warn(`[roadGraph] Explicit connection: source edge "${conn.from}" not found`);
      continue;
    }
    for (const toId of conn.to) {
      const toEdge = edges.get(toId);
      if (!toEdge) {
        console.warn(`[roadGraph] Explicit connection: target edge "${toId}" not found`);
        continue;
      }
      if (!fromEdge.next.includes(toId)) fromEdge.next.push(toId);
      if (!toEdge.prev.includes(conn.from)) toEdge.prev.push(conn.from);
    }
  }

  // Log connectivity summary
  for (const edge of edges.values()) {
    if (edge.next.length === 0) {
      console.warn(`[roadGraph] Lane edge ${edge.id} has no successors (dead end)`);
    }
  }

  const spatialIndex = buildSpatialIndex(edges);
  return { edges, spatialIndex };
}

// ─── Lane lookup ──────────────────────────────────────────────────────────────

export function findLaneAtPoint(
  graph: RoadGraph,
  x: number,
  y: number,
  heading: number
): LaneCursor | null {
  const candidates = candidateEdges(graph.spatialIndex, x, y);

  let bestEdgeId: string | null = null;
  let bestS = 0;
  let bestLateralDist = Infinity;

  for (const edgeId of candidates) {
    const edge = graph.edges.get(edgeId)!;
    const halfWidth = edge.width / 2 + 0.5; // small tolerance

    for (const p of edge.points) {
      const d = dist2(x, y, p.x, p.y);
      if (d > halfWidth + 1) continue; // quick reject

      // Check heading alignment
      if (angleDiff(heading, p.heading) > Math.PI / 4) continue; // > 45°

      // Lateral distance: project (vehicle - point) onto point's normal
      // Normal = perpendicular to heading
      const nx = -Math.sin(p.heading);
      const ny = Math.cos(p.heading);
      const lateral = Math.abs((x - p.x) * nx + (y - p.y) * ny);

      if (lateral < halfWidth && lateral < bestLateralDist) {
        bestLateralDist = lateral;
        bestEdgeId = edgeId;
        bestS = p.s;
      }
    }
  }

  if (bestEdgeId) return { edgeId: bestEdgeId, s: bestS };

  // Fallback: find nearest point ignoring heading (vehicle may be slightly off-lane at startup)
  let fallbackEdgeId: string | null = null;
  let fallbackS = 0;
  let fallbackDist = Infinity;

  for (const edgeId of candidates) {
    const edge = graph.edges.get(edgeId)!;
    for (const p of edge.points) {
      const d = dist2(x, y, p.x, p.y);
      if (d < fallbackDist) {
        fallbackDist = d;
        fallbackEdgeId = edgeId;
        fallbackS = p.s;
      }
    }
  }

  if (fallbackEdgeId && fallbackDist < 5) {
    console.warn(
      `[roadGraph] Vehicle at (${x.toFixed(1)}, ${y.toFixed(1)}) heading=${heading.toFixed(2)} ` +
        `not precisely on lane — snapping to nearest point on ${fallbackEdgeId} (dist=${fallbackDist.toFixed(2)}m)`
    );
    return { edgeId: fallbackEdgeId, s: fallbackS };
  }

  return null;
}

// ─── Walk forward ─────────────────────────────────────────────────────────────

export function walkForward(
  graph: RoadGraph,
  cursor: LaneCursor,
  distanceM: number,
  routeChoices?: Map<string, string> // edgeId → committed nextEdgeId at a junction
): { points: LanePoint[]; junction?: JunctionInfo } {
  const points: LanePoint[] = [];
  let remaining = distanceM;
  let currentEdgeId = cursor.edgeId;
  let currentS = cursor.s;
  let junction: JunctionInfo | undefined;
  const visited = new Set<string>();

  while (remaining > 0) {
    if (visited.has(currentEdgeId)) break; // loop guard (shouldn't trigger on clean circuits)
    visited.add(currentEdgeId);

    const edge = graph.edges.get(currentEdgeId);
    if (!edge) break;

    // Walk points in this edge starting from currentS
    for (const p of edge.points) {
      if (p.s < currentS - 0.01) continue;
      points.push({
        x: p.x,
        y: p.y,
        heading: p.heading,
        width: edge.width,
        speed_limit: edge.speedLimit,
        lane_id: edge.id,
        road_id: edge.roadId,
      });
      const step = p.s - currentS;
      remaining -= step > 0 ? step : 0;
      currentS = p.s;
      if (remaining <= 0) break;
    }

    if (remaining <= 0 || points.length >= distanceM) break;

    if (edge.next.length === 0) break; // dead end

    // Junction detection — record the first fork encountered
    if (edge.next.length > 1) {
      const committed = routeChoices?.get(edge.id);
      const chosen =
        committed && edge.next.includes(committed) ? committed : edge.next[0];
      if (!junction) {
        junction = { at_edge: edge.id, choices: edge.next, current_choice: chosen };
      }
      currentEdgeId = chosen;
    } else {
      currentEdgeId = edge.next[0];
    }

    currentS = 0;
    // Allow re-visiting on closed loops — remove from visited so we can lap
    visited.delete(currentEdgeId);
  }

  return { points: points.slice(0, Math.ceil(distanceM)), junction };
}
