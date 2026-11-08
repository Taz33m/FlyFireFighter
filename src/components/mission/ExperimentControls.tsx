"use client";

import { useState } from "react";
import type { FloorPlanPrior } from "@/lib/contracts/evidence";
import type { Vec3 } from "@/lib/contracts/frames";
import { vec3 } from "@/lib/contracts/frames";
import { representativePoint } from "@/lib/contracts/geometry";
import type { Experiment, MissionView, UiCommand } from "@/lib/mission/protocol";
import { roomName, statusWord } from "./format";
import { challengeTarget } from "./presenter";

const SMOKE_STEPS = [0.3, 0.6, 1.2];

type Run = (experiment: Experiment) => void;

/** Centre of a room's floor polygon at floor level (the floor-plan prior, not simulator truth). */
function roomFloorPoint(prior: FloorPlanPrior, roomId: string): Vec3 | null {
  const room = prior.rooms.find(r => r.id === roomId);
  if (room === undefined) return null;
  const p = representativePoint({ kind: "prism", polygon: room.polygon, zMin: room.zMin, zMax: room.zMax });
  return vec3(p.x, p.y, room.zMin);
}

function RoomExperiments({ prior, run, disabled }: { readonly prior: FloorPlanPrior; readonly run: Run; readonly disabled: boolean }) {
  const [roomId, setRoomId] = useState("");
  const [smoke, setSmoke] = useState(SMOKE_STEPS[1]);
  const room = roomId || prior.rooms[0]?.id || "";
  const none = disabled || room === "";
  const obstruct = () => {
    const at = roomFloorPoint(prior, room);
    if (at !== null) run({ kind: "add_obstruction", min: vec3(at.x - 0.4, at.y - 0.4, at.z), max: vec3(at.x + 0.4, at.y + 0.4, at.z + 1.0) });
  };
  return <>
    <div className="experiment-row">
      <label>Room
        <select value={room} onChange={e => setRoomId(e.target.value)} disabled={disabled}>
          {prior.rooms.map(r => <option key={r.id} value={r.id}>{r.name}</option>)}
        </select>
      </label>
      <label>Smoke
        <select value={smoke} onChange={e => setSmoke(Number(e.target.value))} disabled={disabled}>
          {SMOKE_STEPS.map(s => <option key={s} value={s}>+{s} /m</option>)}
        </select>
      </label>
    </div>
    <div className="experiment-row">
      <button type="button" disabled={none} onClick={() => run({ kind: "add_smoke", roomId: room, extinctionPerM: smoke })}>Add smoke</button>
      <button type="button" disabled={none} onClick={obstruct} title="0.8 × 0.8 × 1.0 m block at the room's floor-plan centre">Add obstruction</button>
      <button type="button" disabled={disabled} onClick={() => run({ kind: "degrade_localization", sigmaIncreaseM: 0.5 })} title="Adds 0.5 m to the localization error model">Degrade localization</button>
    </div>
  </>;
}

function DoorExperiment({ prior, run, disabled }: { readonly prior: FloorPlanPrior; readonly run: Run; readonly disabled: boolean }) {
  const doors = prior.openings.filter(o => o.kind === "door");
  const [doorId, setDoorId] = useState("");
  const door = doorId || doors[0]?.id || "";
  if (doors.length === 0) return null;
  return <div className="experiment-row">
    <label>Door
      <select value={door} onChange={e => setDoorId(e.target.value)} disabled={disabled}>
        {doors.map(d => <option key={d.id} value={d.id}>{d.id}</option>)}
      </select>
    </label>
    <button type="button" disabled={disabled} onClick={() => run({ kind: "set_door", openingId: door, state: "open" })}>Open</button>
    <button type="button" disabled={disabled} onClick={() => run({ kind: "set_door", openingId: door, state: "closed" })}>Close</button>
  </div>;
}

export function ExperimentControls({ view, send }: { readonly view: MissionView | null; readonly send: (command: UiCommand) => void }) {
  if (view === null) return <div className="experiments"><h3>Experiment controls</h3><p className="empty">Available during a run.</p></div>;
  const prior = view.belief.mapPrior;
  const disabled = view.status === "ended";
  const run: Run = experiment => send({ type: "experiment", runId: view.runId, experiment });
  const challenge = challengeTarget(view);
  return <div className="experiments" aria-label="Experiment controls">
    <h3>Experiment controls <span className="muted">change the simulated world; command sees effects only through sensors</span></h3>
    <RoomExperiments prior={prior} run={run} disabled={disabled} />
    <div className="experiment-row">
      <button type="button" disabled={disabled || !challenge.available} onClick={() => challenge.available && run({ kind: "add_occupant", position: challenge.position })} title="Judge challenge: a simulated person steps into the spray's harness-derived affected region; command learns of them only through its sensors">
        Add person in spray region
      </button>
      <span className="muted small">{challenge.available ? `Would stand in ${roomName(prior, challenge.roomId)} while ${challenge.proposalId} is ${statusWord(challenge.proposalStatus).toLowerCase()}.` : challenge.reason}</span>
    </div>
    <DoorExperiment prior={prior} run={run} disabled={disabled} />
  </div>;
}
