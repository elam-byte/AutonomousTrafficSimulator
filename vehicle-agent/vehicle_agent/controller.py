import math
import random
from .types import VehicleObservation, VehicleCommand, LanePoint, JunctionChoice

# Speed control
SPEED_KP         = 1.2    # proportional gain for speed tracking
ACCEL_MIN        = -4.0
ACCEL_MAX        = 2.0

# Steering limits (rad/s — bicycle model)
STEER_MIN        = -0.5
STEER_MAX        = 0.5

# Stanley controller gains
# Higher K_LATERAL → more aggressive lateral centering (recommended 1.5–3.0)
K_LATERAL        = 2.5
# Softening constant: prevents division-by-zero at standstill
K_SOFT           = 0.3

# Pre-braking: scan this many corridor points ahead for upcoming speed limits.
# At 1 m/point this is a ~20 m lookahead — enough to pre-slow before an arc.
PREBRAKE_HORIZON = 20

# Lateral speed penalty: reduce target speed when off-centre.
# 0.5 means: at 1 m off-centre → 50 % speed reduction; at 0.5 m → 25 %.
K_LAT_SPEED      = 0.5

# In-process sticky junction choices: at_edge → chosen next edge ID
_junction_choices: dict[str, str] = {}


def _normalize_angle(a: float) -> float:
    """Map angle to (-π, π]."""
    r = a % (2 * math.pi)
    if r > math.pi:
        r -= 2 * math.pi
    if r <= -math.pi:
        r += 2 * math.pi
    return r


def _clamp(v: float, lo: float, hi: float) -> float:
    return max(lo, min(hi, v))


def _find_nearest(
    obs: VehicleObservation, corridor: list[LanePoint]
) -> tuple[LanePoint, float]:
    """Return the nearest corridor point and the signed lateral error.

    Lateral error convention (matches Stanley paper):
      > 0  →  vehicle is to the RIGHT of the lane centreline
      < 0  →  vehicle is to the LEFT
    """
    best_sq  = float("inf")
    best_pt  = corridor[0]
    best_lat = 0.0

    for pt in corridor:
        dx = obs.x - pt.x
        dy = obs.y - pt.y
        sq = dx * dx + dy * dy
        if sq < best_sq:
            best_sq  = sq
            best_pt  = pt
            # right-of-heading unit vector: (sin h, −cos h)
            best_lat = dx * math.sin(pt.heading) - dy * math.cos(pt.heading)

    return best_pt, best_lat


def compute_command(obs: VehicleObservation) -> VehicleCommand:
    corridor = obs.lane_corridor

    if not corridor:
        # No corridor — brake gently and hold heading
        return VehicleCommand(t=obs.t, id=obs.id, desired_accel=-2.0, desired_steer=0.0)

    # ── Junction routing ──────────────────────────────────────────────────────
    junction_choice: JunctionChoice | None = None
    if obs.junction is not None:
        j = obs.junction
        if j.at_edge not in _junction_choices:
            _junction_choices[j.at_edge] = random.choice(j.choices)
        committed = _junction_choices[j.at_edge]
        junction_choice = JunctionChoice(at_edge=j.at_edge, choice=committed)

    # ── Stanley lane-centering steering ──────────────────────────────────────
    # Find nearest corridor point and compute lateral deviation
    nearest, lateral_error = _find_nearest(obs, corridor)

    # Heading error: how much we need to rotate to match the lane heading
    # Positive → need to turn left (CCW), negative → need to turn right
    heading_error = _normalize_angle(nearest.heading - obs.heading)

    # Stanley cross-track correction:
    #   δ_ct = atan(K_LATERAL * e / (v + K_SOFT))
    # Positive e (vehicle right of centre) → positive correction → steer left ✓
    steer_ct = math.atan2(K_LATERAL * lateral_error, obs.speed + K_SOFT)

    desired_steer = _clamp(heading_error + steer_ct, STEER_MIN, STEER_MAX)

    # ── Speed control with pre-braking ───────────────────────────────────────
    # Scan upcoming corridor for minimum speed limit (pre-slow before arcs/junctions)
    horizon     = corridor[:PREBRAKE_HORIZON]
    ahead_limit = min(pt.speed_limit for pt in horizon)

    # Reduce target speed when laterally displaced — slowing improves cornering
    lat_factor  = max(0.4, 1.0 - K_LAT_SPEED * abs(lateral_error))

    target_speed  = ahead_limit * lat_factor
    desired_accel = _clamp((target_speed - obs.speed) * SPEED_KP, ACCEL_MIN, ACCEL_MAX)

    return VehicleCommand(
        t=obs.t,
        id=obs.id,
        desired_accel=desired_accel,
        desired_steer=desired_steer,
        junction_choice=junction_choice,
    )
