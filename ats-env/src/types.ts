// ─── Map Model (mirrors ats-map ATS Map JSON v1) ────────────────────────────

export interface Point {
  x: number;
  y: number;
}

export interface LaneDef {
  left: number;
  right: number;
  laneWidth: number;
}

export interface LineRoad {
  id: string;
  kind: "line";
  start: Point;
  end: Point;
  lanes: LaneDef;
}

export interface ArcRoad {
  id: string;
  kind: "arc";
  center: Point;
  radius: number;
  startAngle: number;
  endAngle: number;
  clockwise: boolean;
  lanes: LaneDef;
}

export type Road = LineRoad | ArcRoad;

export interface MapVehicle {
  id: string;
  x: number;
  y: number;
  heading: number;
  length: number;
  width: number;
  color?: string;
}

export interface MapMeta {
  version: string;
  unit: string;
  origin: string;
  world: { width: number; height: number };
}

export interface LaneConnection {
  from: string;   // lane edge ID e.g. "r-14:left"
  to: string[];   // successor lane edge IDs
}

export interface AtsMap {
  meta: MapMeta;
  roads: Road[];
  vehicles: MapVehicle[];
  connections?: LaneConnection[]; // explicit lane-to-lane wiring for junctions
}

// ─── Runtime Vehicle State ───────────────────────────────────────────────────

export interface VehicleState {
  id: string;
  x: number;
  y: number;
  heading: number;
  speed: number;
  length: number;
  width: number;
  color?: string;
}

// ─── Wire Types (NATS messages) ──────────────────────────────────────────────

export interface LanePoint {
  x: number;
  y: number;
  heading: number;
  width: number;
  speed_limit: number;
  lane_id: string; // e.g. "r-1:right"
  road_id: string; // e.g. "r-1"
}

export interface JunctionInfo {
  at_edge: string;        // edge ID where the fork occurs
  choices: string[];      // available next edge IDs
  current_choice: string; // the committed next edge ID
}

export interface VehicleObservation {
  t: number;       // Unix ms (wall-clock real time)
  t_iso: string;   // ISO 8601 string e.g. "2024-03-31T12:00:00.050Z"
  id: string;
  x: number;
  y: number;
  heading: number;
  speed: number;
  lane_corridor: LanePoint[];
  junction?: JunctionInfo; // present only when a fork is within the corridor
}

export interface VehicleCommand {
  t: number;
  id: string;
  desired_accel: number;
  desired_steer: number;
  junction_choice?: { at_edge: string; choice: string }; // vehicle selects a fork
}

export interface SnapshotVehicle {
  id: string;
  x: number;
  y: number;
  heading: number;
  length: number;
  width: number;
  color?: string;
}

export interface WorldSnapshot {
  t: number;       // Unix ms (wall-clock real time)
  t_iso: string;   // ISO 8601 string e.g. "2024-03-31T12:00:00.050Z"
  vehicles: SnapshotVehicle[];
}

// ─── Road Graph Internal Types ───────────────────────────────────────────────

export interface SampledPoint {
  x: number;
  y: number;
  heading: number;
  s: number; // arc-length from travel-direction start of this lane edge
}

export interface LaneEdge {
  id: string; // e.g. "r-1:right", "r-1:left"
  roadId: string;
  direction: "right" | "left";
  points: SampledPoint[]; // 1 m spacing, s increases in travel direction
  length: number;
  speedLimit: number;
  width: number;
  next: string[]; // IDs of successor LaneEdges
  prev: string[]; // IDs of predecessor LaneEdges
}

export interface SpatialIndex {
  cellSize: number;
  cells: Map<string, Set<string>>; // "cx,cy" → Set of LaneEdge IDs
}

export interface RoadGraph {
  edges: Map<string, LaneEdge>;
  spatialIndex: SpatialIndex;
}

export interface LaneCursor {
  edgeId: string;
  s: number; // position within the lane edge
}

// ─── NATS message envelopes ───────────────────────────────────────────────────

export interface SimMapMessage {
  mapRef: string; // absolute filesystem path ats-env can read
}

export interface SimVehicleEntry {
  id: string;
  color?: string;
  length: number;
  width: number;
}

export interface SimVehiclesMessage {
  vehicles: SimVehicleEntry[];
}
