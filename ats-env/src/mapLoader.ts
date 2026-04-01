import { readFileSync } from "fs";
import { z } from "zod";
import type { AtsMap } from "./types.js";

const PointSchema = z.object({ x: z.number(), y: z.number() });

const LaneDefSchema = z.object({
  left: z.number().int().nonnegative(),
  right: z.number().int().nonnegative(),
  laneWidth: z.number().positive(),
});

const LineRoadSchema = z.object({
  id: z.string(),
  kind: z.literal("line"),
  start: PointSchema,
  end: PointSchema,
  lanes: LaneDefSchema,
});

const ArcRoadSchema = z.object({
  id: z.string(),
  kind: z.literal("arc"),
  center: PointSchema,
  radius: z.number().nonnegative(),
  startAngle: z.number(),
  endAngle: z.number(),
  clockwise: z.boolean(),
  lanes: LaneDefSchema,
});

const RoadSchema = z.discriminatedUnion("kind", [LineRoadSchema, ArcRoadSchema]);

const MapVehicleSchema = z.object({
  id: z.string(),
  x: z.number(),
  y: z.number(),
  heading: z.number(),
  length: z.number().positive(),
  width: z.number().positive(),
  color: z.string().optional(),
});

const LaneConnectionSchema = z.object({
  from: z.string(),
  to: z.array(z.string()),
});

const AtsMapSchema = z.object({
  meta: z.object({
    version: z.string(),
    unit: z.string().optional(),
    origin: z.string().optional(),
    world: z.object({ width: z.number(), height: z.number() }),
  }),
  junctions: z.array(z.unknown()).optional(),
  roads: z.array(RoadSchema),
  vehicles: z.array(MapVehicleSchema),
  connections: z.array(LaneConnectionSchema).optional(),
});

export function loadMap(path: string): AtsMap {
  const raw = JSON.parse(readFileSync(path, "utf-8"));
  return parseMap(raw, `file:${path}`);
}

export function parseMap(raw: unknown, source = "upload"): AtsMap {
  const result = AtsMapSchema.safeParse(raw);
  if (!result.success) {
    throw new Error(`Invalid map JSON from ${source}:\n${result.error.message}`);
  }
  return result.data as AtsMap;
}
