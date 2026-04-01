import type { NatsConnection } from "nats";
import type { RoadGraph, VehicleState, VehicleCommand, WorldSnapshot } from "./types.js";
import { VehicleStore } from "./vehicleState.js";
import { buildCorridor } from "./corridorBuilder.js";
import { integrate } from "./physics.js";
import { publishObservation, publishSnapshot } from "./natsClient.js";

const TICK_MS = 50; // 20 Hz
const CMD_STALE_MS = 250;
const DEFAULT_SPEED_LIMIT = 20 / 3.6; // 20 km/h fallback when no corridor
const SAFE_CMD = { desired_accel: -2, desired_steer: 0 } as const;

interface CommandEntry {
  cmd: VehicleCommand;
  arrivedAt: number;
}

// Module-level command buffer — written by recordCommand(), read by tick()
const commandBuffer = new Map<string, CommandEntry>();

// Handle to the running tick loop timeout (null when stopped)
let tickHandle: ReturnType<typeof setTimeout> | null = null;

export function recordCommand(cmd: VehicleCommand): void {
  commandBuffer.set(cmd.id, { cmd, arrivedAt: Date.now() });
}

/** Stop any currently running tick loop (call before re-initialising with a new map). */
export function stopTickLoop(): void {
  if (tickHandle !== null) {
    clearTimeout(tickHandle);
    tickHandle = null;
    commandBuffer.clear();
    console.log("[tick] Tick loop stopped.");
  }
}

export function startTickLoop(
  nc: NatsConnection,
  graph: RoadGraph,
  store: VehicleStore
): void {
  // Guard: stop any previous loop
  stopTickLoop();

  let nextTickAt = Date.now();

  function schedule(): void {
    nextTickAt += TICK_MS;
    const delay = Math.max(0, nextTickAt - Date.now());
    tickHandle = setTimeout(() => {
      // Only continue if this loop hasn't been cancelled
      if (tickHandle !== null) {
        tick();
        schedule();
      }
    }, delay);
  }

  function tick(): void {
    const t = Date.now();
    const t_iso = new Date(t).toISOString();
    const tickStart = performance.now();
    const snapshotVehicles: WorldSnapshot["vehicles"] = [];

    for (const vehicle of store.getAll()) {
      // Resolve command — fall back to gentle safe-stop if stale
      const entry = commandBuffer.get(vehicle.id);
      const cmd: VehicleCommand =
        !entry || t - entry.arrivedAt > CMD_STALE_MS
          ? { t, id: vehicle.id, ...SAFE_CMD }
          : entry.cmd;

      // Apply any junction choice carried by the command
      if (cmd.junction_choice) {
        const { at_edge, choice } = cmd.junction_choice;
        store.setRouteChoice(vehicle.id, at_edge, choice);
      }

      // Build lane corridor for this vehicle (respecting its route choices)
      const { corridor, junction } = buildCorridor(
        graph,
        vehicle,
        store.getRouteChoices(vehicle.id)
      );
      const speedLimit = corridor.length > 0 ? corridor[0].speed_limit : DEFAULT_SPEED_LIMIT;

      // Physics integration
      const next = integrate(vehicle, cmd, TICK_MS / 1000, speedLimit);
      store.apply(vehicle.id, next);

      const updated: VehicleState = { ...vehicle, ...next };

      // Publish per-vehicle observation (includes junction info when at a fork)
      publishObservation(nc, {
        t,
        t_iso,
        id: vehicle.id,
        x: updated.x,
        y: updated.y,
        heading: updated.heading,
        speed: updated.speed,
        lane_corridor: corridor,
        junction,
      });

      snapshotVehicles.push({
        id: vehicle.id,
        x: updated.x,
        y: updated.y,
        heading: updated.heading,
        length: vehicle.length,
        width: vehicle.width,
        color: vehicle.color,
      });
    }

    // Publish world snapshot (includes t_iso for human readability)
    publishSnapshot(nc, { t, t_iso, vehicles: snapshotVehicles });

    const elapsed = performance.now() - tickStart;
    if (elapsed > 40) {
      console.warn(`[tick] Slow tick: ${elapsed.toFixed(1)}ms (target <40ms)`);
    }
  }

  schedule();
  console.log("[tick] 20 Hz tick loop started");
}
