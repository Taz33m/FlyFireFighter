# CloudBreak mission harness: action interface and safety rules

> Earlier technical draft, retained November 7, 2026. The current product requirements are [FlyFireFighter](../../PRD.md). Apply the [review findings](harness-review.md) and reconcile this draft with the current glass-action, ultrasound and active-evacuation requirements before implementing its contract. These types are not a completed implementation.

> CloudBreak helps rescue drones search through smoke, track who may still be inside, and execute only the actions their evidence, capabilities and commander authorize.

Everything below runs in a digital twin. Aircraft, houses, occupants and sensor readings are simulated. The aircraft profiles are fictional. Nothing here establishes real-world arrival times, detection rates or suppression effectiveness.

## 1. Parts and who owns them

| Part | Writes | Reads |
|---|---|---|
| **Twin** (sim, smoke, heat, sensors) | `Observation`, ground truth (hidden) | Executed actions |
| **Navigation** (classical and learned) | `ActionProposal` (move, scan, return) | Observations, `SceneMap` |
| **Harness** | Lifecycle transitions, `HarnessLog` | Everything except ground truth |
| **Command dashboard** | `Approval`, `Abort`, crew confirmations | `SceneMap`, `SearchState`, proposals, log |

The planner never reads ground truth. Only the evaluator does, after the run.

The contract is JSON. The TypeScript types below are the reference. A Python sim or policy mirrors them with dataclasses and exchanges the same JSON.

## 2. Aircraft profiles

Software can't make a drone fire-capable. Each profile states exactly what one aircraft can do. Approval can never exceed a profile.

```ts
type Command = "move" | "scan" | "hover" | "return" | "speak" | "drop" | "spray";
type SensorKind = "camera" | "lidar" | "thermal" | "radar" | "imu";

interface AircraftProfile {
  id: string;                      // "scout-s1-fictional"
  commands: Command[];
  sensors: SensorKind[];
  payloads: { kind: "supply" | "water"; capacity: number; unit: "kg" | "L" }[];
  maxAmbientC: number;             // hard limit
  maxExposureS: number;            // seconds allowed above warnC
  warnC: number;
  enduranceS: number;
  returnReserveS: number;          // battery kept for the return route
  maxThrustN: number;
  hoverThrustN: number;            // thrust margin = maxThrustN - hoverThrustN
  spray?: { maxFlowLps: number; nozzleDiameterMm: number; coneHalfAngleDeg: number; rangeM: number };
}
```

Demo profiles: **Scout S1** (search; no `spray`) and **Tender T1** (adds a bounded water module). The same `spray` request must be rejected on Scout by rule H1 and evaluated on Tender.

## 3. Shared world state

```ts
interface Observation {
  id: string; at: number; aircraftId: string; sensor: SensorKind;
  region: Region;                  // what this reading covered
  reliability: number;             // 0..1, measured for current conditions, not assumed per sensor
  kind: "geometry" | "heat" | "possible_person" | "smoke" | "door_state";
  value: unknown;                  // e.g. { confidence: 0.62, position } for possible_person
  supersedes?: string;
}

interface SceneMap {
  version: number;                 // increments on any geometry change
  source: "floor_plan_prior" | "observed";
  rooms: { id: string; polygon: [number, number][]; floor: number }[];
  blocked: Region[];               // corrections to the prior ("plan says hallway; lidar says blocked")
}

type RoomSearch = "unsearched" | "partial" | "searched";   // there is no "clear"
interface SearchState {
  rooms: Record<string, { state: RoomSearch; coverage: number; bestSensor?: SensorKind; lastObservedAt?: number }>;
  expected: { source: "911_caller" | "roster"; text: string; count?: number }[];   // who may be inside
  possible: { observationId: string; roomId: string; confidence: number }[];       // drone detections
  crewLocated: { personLabel: string; at: number }[];                               // only crew writes this
}
```

## 4. The action contract

```ts
type Risk = "routine" | "consequential";

interface ActionProposal {
  id: string;
  aircraftId: string;
  command: Command;
  target: Region | { roomId: string };
  params: Record<string, number | string>;   // e.g. { flowLps: 0.2, durationS: 4 }
  proposer: "classical_nav" | "learned_nav" | "operator";
  rationale: string;                         // shown to the commander
  evidence: string[];                        // supporting Observation ids
  mapVersion: number;                        // the map this relies on
  risk: Risk;                                // set by the harness, not the proposer
  stopConditions: StopCondition[];
}

type StopCondition =
  | { kind: "person_in_region"; region: Region; minConfidence: number }
  | { kind: "ambient_above"; c: number }
  | { kind: "thrust_margin_below"; n: number }
  | { kind: "localization_error_above"; m: number }
  | { kind: "map_changed_in"; region: Region }
  | { kind: "comms_lost_s"; s: number }
  | { kind: "approval_expired" };

interface Approval {
  proposalId: string;
  by: string;                      // commander identity in the drill
  at: number;
  expiresAt: number;               // short, e.g. 20 s
  bound: { params: ActionProposal["params"]; mapVersion: number; evidence: string[] };
}
```

### Lifecycle

```
proposed ─▶ validated ─▶ needs_approval ─▶ approved ─▶ revalidating ─▶ executing ─▶ completed
    │           │              │               │             │              │
    └▶ rejected └▶ rejected    └▶ expired      └▶ expired    └▶ invalidated └▶ aborted / invalidated
```

Every transition writes a `HarnessLog` entry: state, time, the rule IDs that decided it, the evidence IDs, and a plain-language reason. **Routine** actions (move, scan, hover, return) skip `needs_approval` when inside the approved mission envelope. **Consequential** actions always need a specific `Approval`:
- `drop`, `spray`, and `speak` beyond the template set
- entering a region marked hazardous
- leaving the envelope

## 5. Rules

Hard rules (H1–H3, H9, H13) cannot be overridden by approval.

| ID | Rule |
|---|---|
| **H1 Capability** | Reject if the aircraft profile lacks the command, sensor or payload. |
| **H2 Limits** | Reject or abort when an action would exceed temperature, exposure time, endurance or thrust margin, or break the return reserve. |
| **H3 Envelope** | Routine actions run only inside the commander-approved mission envelope: rooms, altitude band, ambient ceiling and time box. |
| **H4 Fresh evidence** | At revalidation, if any cited observation is superseded, or the map version changed within the target region, mark the action `invalidated`. Explain what changed. The planner may re-propose. |
| **H5 Approval binding** | An approval covers one proposal, its exact parameters, map version and evidence, until it expires. Any change requires a new approval. |
| **H6 Discharge safety** | `spray` requires the whole discharge cone plus margin to have been observed within *N* seconds. Observations must meet reliability ≥ *r* and coverage ≥ *c*. Any possible person ≥ *p* inside blocks the spray. **No detection is not evidence of safety:** unobserved or low-quality coverage also blocks. |
| **H7 Never clear** | No room, floor or house can become "clear." Rooms report state, coverage, best sensor and time. Only the crew can record a person as located. |
| **H8 Truthful speech** | `speak` uses templates selected by dispatch status. It never says help is coming unless dispatch is confirmed, and it gives no instructions beyond the approved safety scripts. |
| **H9 Return first** | The return route is rechecked whenever smoke, heat or the map changes. If return becomes infeasible within the reserve, `return` preempts everything. |
| **H10 Degraded sensing** | If localization error exceeds the threshold, hold or backtrack to the last confident pose. No consequential action while degraded. |
| **H11 Monitored execution** | Stop conditions are checked every tick during execution. A trip aborts the action and logs which condition fired. |
| **H12 Immutable log** | Log entries are append-only. The dashboard and evaluator read the same log. |
| **H13 Human abort** | The commander can abort any action or the mission at any time. No action can disable abort. |

## 6. Water module (simulated, bounded)

The module tracks four quantities:
- **Water remaining:** `tank − flowLps × t`.
- **Reaction force:** `F = ρ·Q·v`, with `v = Q / A_nozzle`. Example: 0.2 L/s through a 4 mm nozzle gives v ≈ 16 m/s and F ≈ 3.2 N.
- **Stability:** reject or abort if `F` exceeds a fraction of the thrust margin (H2), and trip `thrust_margin_below` during execution.
- **Permitted discharge region:** the cone from the nozzle pose, range-limited and clipped by map geometry. H6 runs against this cone.

The module claims no suppression effectiveness. It exists to exercise the harness under real engineering constraints. Reference: [aerial firefighting reaction-force research](https://www.mdpi.com/2076-3417/13/3/1965).

## 7. Navigation contract

- **Sensor weights come from measured reliability** for current conditions (residuals against the map and other sensors), not a fixed "smoke means trust thermal" rule.
- **The floor plan is a prior.** The twin deliberately corrupts it (closed doors, moved walls, furniture). The navigator must detect and correct this, and record each correction in `SceneMap.blocked`.
- **Classical and learned navigators** propose through the same harness, with the same sensors and mission budget.

## 8. Evaluation

**The question CloudBreak must answer:** can a rescue drone find and localize people more effectively when its floor plan is wrong and its sensors deteriorate during the mission?

Prior work already has autonomous building search (AeroNav), approval gates with stale-command rejection (Overwatch) and flood triage (FlyBy); see `docs/reference/prior-art.md`. CloudBreak's claim is only the measured improvement under wrong maps and failing sensors.

Each condition runs across seeds on **unseen houses**, crossing map-error types with smoke schedules:
- **Map errors:** a closed door, a missing wall, an added obstruction, a moved stair.
- **Smoke schedules:** clear, thickening, dense.

| Comparison | Purpose |
|---|---|
| CloudBreak vs **fixed room-by-room sweep** | Floor: does adaptive search help at all? |
| CloudBreak vs **competent exploration planner** (frontier-based, same sensors, same wrong map, same budget) | The real test: is our map-prior correction and reliability-weighted sensing better than a good standard planner? |
| Each CloudBreak component removed in turn (no map correction; fixed sensor weights) | Which part produces the gain? |
| CloudBreak with vs without the harness (sim only) | What the harness prevents, and what it costs |

Report losses as well as wins. If the competent planner matches CloudBreak, say so.

**Metrics:**
- **Navigation:** mission completion, return success, localization error, collisions.
- **Search:** search recall (people found / people present), time to first detection.
- **Harness:** unsafe actions executed (target 0 with the harness), and **useful actions incorrectly blocked**. A harness that refuses everything fails the second metric.

## 9. Demo sequence

1. **911 caller report:** "A kid at a second-floor window, maybe his parents." This becomes `expected`. The commander approves the mission envelope.
2. **Search under changing conditions.** Smoke thickens and lidar reliability drops. The navigator reweights its sensors, finds the floor plan wrong (a closed door) and replans.
3. **Detection.** A possible person appears in the 2nd-floor rear bedroom. The room is marked `partial` and the drone speaks the safety template.
4. **Capability.** A hallway-cooling `spray` is proposed. It is rejected on Scout (H1) and evaluated on Tender.
5. **Approved, then invalidated.** A judge approves the spray. Before execution, a new thermal observation puts a possible person in the discharge cone, and H6 and H4 cancel the approval. The dashboard shows exactly which observation changed.
6. **Refusal.** A judge tries to mark the house clear. No such action exists. The dashboard shows the unsearched rooms.
7. **Evidence.** Show the metrics on unseen houses, including the actions the harness blocked that it shouldn't have.
