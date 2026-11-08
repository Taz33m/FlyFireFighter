/**
 * Fly reflex view derivations (reflex-view.ts): the words, levels and geometry FlyReflexPanel draws. Scope: the pure
 * functions; two real controller paths into them (the shared cue → command mapper's mode, and a ControllerSlot step
 * label reaching ControllerView); and drift guards against the controller source and constants they mirror. The
 * panel's layout and rendering are checked in a headed browser, not here.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, test } from "node:test";
import { fileURLToPath } from "node:url";
import type { GuardedMotion, MotionLimit, MotionSource } from "../../lib/contracts/actions.ts";
import { SCOUT_S1 } from "../../lib/contracts/aircraft.ts";
import { calibrationFromSensor } from "../../lib/contracts/camera.ts";
import { ControllerSlot, controllerInput } from "../../lib/mission/controller-slot.ts";
import { DEFAULT_COMMAND_CONFIG, ReflexCommandMapper } from "../../lib/navigation/reflex/command.ts";
import { FRAME_STATUS } from "../../lib/navigation/reflex/flow-baseline.ts";
import {
  calloutText, describeMove, harnessCallouts, MOVE_DIAGRAM, modeCallout, moveGeometry, primaryCallout, provenanceNote,
  REFLEX_MODES, WAITING_FOR_FRAME, sectorBands, sectorReading, sectorSummary, sectorTitle, speedRadius, stepMode,
} from "./reflex-view.ts";

const source = (relative: string) => readFileSync(fileURLToPath(new URL(relative, import.meta.url)), "utf8");
const COMMAND_SOURCE = source("../../lib/navigation/reflex/command.ts");
const TRAINED_SOURCE = source("../../lib/navigation/reflex/trained-readout.ts");

/** Every quoted snake_case word in command.ts outside comments, except typeof names: the modes the mapper returns. */
function commandModes(): Set<string> {
  const code = COMMAND_SOURCE.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
  const typeofNames = new Set(["number", "string", "boolean", "object", "undefined", "function", "bigint", "symbol"]);
  return new Set([...code.matchAll(/"([a-z]+(?:_[a-z]+)*)"/g)].map(m => m[1]).filter(word => !typeofNames.has(word)));
}

const close = (actual: number, expected: number, message?: string) => assert.ok(Math.abs(actual - expected) < 1e-3, `${message ?? ""} ${actual} ≈ ${expected}`);
const command = (x: number, y: number, yaw: number) => ({ velocityBody: { x, y, z: 0 }, yawRateRadps: yaw });
const length = (p: { x: number; y: number }) => Math.hypot(p.x, p.y);

describe("controller mode callouts", () => {
  test("every mode the shared mapper can report has its own callout, and no listed mode is stale", () => {
    const modes = commandModes();
    assert.ok(modes.size >= 15, `the source scan found the mapper's modes: ${[...modes].join(", ")}`);
    for (const mode of modes) {
      assert.ok((REFLEX_MODES as readonly string[]).includes(mode), `command.ts reports "${mode}" but the panel has no callout for it`);
      assert.notEqual(modeCallout(mode)?.tone, "other", mode);
    }
    for (const mode of REFLEX_MODES) assert.ok(COMMAND_SOURCE.includes(`"${mode}"`) || TRAINED_SOURCE.includes(`"${mode}"`), `"${mode}" is reported by no controller`);
  });

  test("every listed mode reads as a short 'Verb · reason' phrase with a sentence behind it", () => {
    for (const mode of REFLEX_MODES) {
      const callout = modeCallout(mode);
      assert.ok(callout !== null, mode);
      const text = calloutText(callout);
      assert.match(text, /^[A-Z][a-z]+( [a-z]+)? · [a-zA-Z]/, `${mode}: ${text}`);
      assert.ok(!text.includes("_") && text.length <= 32, `${mode}: ${text}`);
      assert.match(callout.detail, /^[A-Z].*\.$/, mode);
    }
  });

  test("the requested wording holds for the range, looming, flank and facing modes", () => {
    const text = (mode: string) => calloutText(modeCallout(mode) ?? assert.fail(mode));
    assert.equal(text("slow_range"), "Slowed · range limit");
    assert.equal(text("brake_looming"), "Braking · looming");
    assert.equal(text("slow_flank"), "Slowed · flank close");
    assert.equal(text("hold_face"), "Holding · facing target");
    assert.equal(text("range_turn"), "Turning away · obstacle ahead");
  });

  test("modes are read only from '<source>/<mode>' step labels", () => {
    assert.equal(stepMode("engineered_readout/slow_flank"), "slow_flank");
    assert.equal(stepMode("flow_baseline/range_turn"), "range_turn");
    assert.equal(stepMode("FlyVis flow/0000/000 + engineered readout"), null, "the slot's display label is not a step label");
    assert.equal(stepMode("slow_range"), null, "no source");
    assert.equal(stepMode("flow_baseline/"), null);
    assert.equal(stepMode(""), null);
    assert.equal(stepMode(null), null);
    assert.equal(stepMode(undefined), null);
  });

  test("an unknown mode still reads, marked as undescribed; inherited object keys are not modes", () => {
    assert.deepEqual(modeCallout("hover_drift"), { verb: "Reflex", reason: "hover drift", tone: "other", detail: 'The controller reported mode "hover_drift", which this panel does not describe yet.' });
    assert.equal(modeCallout("constructor")?.tone, "other");
    assert.equal(modeCallout("toString")?.verb, "Reflex");
    assert.equal(modeCallout(null), null);
  });

  test("a request the reflex did not make is not described as a reflex mode", () => {
    assert.equal(calloutText(primaryCallout("flow_baseline/goal", "contingency") ?? assert.fail()), "Contingency · not the reflex");
    assert.equal(calloutText(primaryCallout("flow_baseline/goal", "operator") ?? assert.fail()), "Operator · not the reflex");
    assert.equal(calloutText(primaryCallout("flow_baseline/goal", "classical_fallback") ?? assert.fail()), "Flying · toward goal");
    assert.equal(primaryCallout(undefined, "engineered_readout"), null, "no step label yet: no mode claimed");
  });
});

describe("real controller decisions read as callouts", () => {
  test("a forward range reading that binds the mapper's speed reads 'Slowed · range limit'", () => {
    const mapper = new ReflexCommandMapper("flow_baseline", DEFAULT_COMMAND_CONFIG);
    const result = mapper.map(
      { tick: 2, frame: null, goal: { bearingRad: 0, distanceM: 5, heightErrorM: 0 }, previous: command(0, 0, 0), quality: { frame: 1, poseSigmaM: 0.1 }, ranges: { forwardM: 1, leftM: null, rightM: null, downM: null } },
      { visualConfidence: 1, centering: 0, centeringWeight: 0, loomingRateHz: 0, avoidTurn: 0 },
    );
    assert.equal(result.mode, "slow_range");
    assert.equal(calloutText(primaryCallout(`flow_baseline/${result.mode}`, result.request.source) ?? assert.fail()), "Slowed · range limit");
  });

  test("a ControllerSlot step label reaches ControllerView and reads as its callout", async () => {
    const spec = SCOUT_S1.sensors.find(sensor => sensor.id === "rgb-front") ?? assert.fail("rgb-front");
    const calibration = calibrationFromSensor(spec, 1);
    const { slot } = await ControllerSlot.create("flow_baseline", "run-reflex-view", calibration, null);
    assert.equal(slot.view().stepLabel, null, "no step yet");
    const frame = { frameId: "f-1", captureTick: 2, calibrationId: calibration.id, width: 80, height: 45, luminance: new Float32Array(80 * 45).fill(0.5) };
    const step = await slot.step(controllerInput({ tick: 2, frame, goal: null, previous: command(0, 0, 0), frameQuality: 1, poseSigmaM: 0.1, ranges: null }), frame);
    const view = slot.view();
    assert.equal(view.stepLabel, step.output.label);
    assert.equal(view.stepLabel, "flow_baseline/hold_no_vision", "first frame of a pair: no flow, so no usable vision");
    assert.equal(calloutText(primaryCallout(view.stepLabel, view.source) ?? assert.fail()), "Holding · no usable vision");
    assert.equal(sectorReading(view.features).measured, false, "and the sectors say nothing was measured");
    slot.close();
  });
});

describe("harness limit callouts", () => {
  const ALL_LIMITS: Readonly<Record<MotionLimit, true>> = {
    speed: true, person_clearance: true, vertical_speed: true, yaw_rate: true, acceleration: true,
    no_active_goal: true, localization: true, envelope_boundary: true, mission_aborted: true,
  };

  test("every harness limit is worded 'Harness · <limit>' with its own sentence", () => {
    const texts = new Set<string>();
    for (const limit of Object.keys(ALL_LIMITS) as MotionLimit[]) {
      const [callout, ...rest] = harnessCallouts([limit]);
      assert.equal(rest.length, 0);
      assert.equal(callout.limit, limit);
      assert.match(callout.text, /^Harness · [a-z][a-z -]+$/, callout.text);
      assert.match(callout.detail, /^[A-Z].*\.$/, limit);
      texts.add(callout.text);
    }
    assert.equal(texts.size, Object.keys(ALL_LIMITS).length, "no two limits read the same");
    assert.equal(harnessCallouts(["acceleration"])[0].text, "Harness · acceleration limit");
  });

  test("repeated limits collapse in the harness's order; no limits, no callouts", () => {
    assert.deepEqual(harnessCallouts(["speed", "acceleration", "speed"]).map(c => c.text), ["Harness · speed limit", "Harness · acceleration limit"]);
    assert.deepEqual(harnessCallouts([]), []);
    assert.deepEqual(harnessCallouts(null), []);
    assert.deepEqual(harnessCallouts(undefined), []);
  });
});

describe("left / centre / right sector readings", () => {
  test("FlyVis sectors: magnitudes of signed motion, the strongest sector full and the others in proportion", () => {
    const reading = sectorReading({ featuresPresent: 1, leftMotion: -0.2, centerMotion: 0.05, rightMotion: 0.4, expansion: 0.3 });
    assert.equal(reading.source, "flyvis");
    assert.deepEqual(reading.values, [0.2, 0.05, 0.4]);
    assert.deepEqual(reading.signed, [-0.2, 0.05, 0.4]);
    assert.deepEqual(reading.levels, [0.5, 0.125, 1]);
    assert.equal(sectorTitle(reading, 0), "Left sector: 0.20 model units, leftward image motion.");
  });

  test("optical flow: outward flow at the sides and the looming rate ahead", () => {
    const reading = sectorReading({ frameStatus: 4, flowLeftHz: 0.6, flowRightHz: 0.3, loomingRateHz: 0.9, loomingValid: 1, divergenceHz: 1.8 });
    assert.equal(reading.source, "flow");
    assert.deepEqual(reading.values, [0.6, 0.9, 0.3]);
    reading.levels.forEach((level, i) => close(level, [2 / 3, 1, 1 / 3][i], `sector ${i}`));
    assert.equal(sectorSummary(reading), "Optical flow (s⁻¹): left 0.60, centre 0.90, right 0.30.");
  });

  test("weak motion stays dim rather than filling the strongest band", () => {
    assert.deepEqual(sectorReading({ featuresPresent: 1, leftMotion: 0.01, centerMotion: 0, rightMotion: -0.02 }).levels.map(l => Math.round(l * 100) / 100), [0.1, 0, 0.2]);
    close(sectorReading({ frameStatus: 4, flowLeftHz: 0.03, flowRightHz: 0, loomingRateHz: 0, loomingValid: 1 }).levels[0], 0.2);
  });

  test("looming that was not measured leaves the centre empty, not zero", () => {
    const reading = sectorReading({ frameStatus: 4, flowLeftHz: 0.4, flowRightHz: 0.2, loomingRateHz: 0, loomingValid: 0 });
    assert.equal(reading.measured, true);
    assert.equal(reading.values[1], null);
    assert.equal(reading.levels[1], 0);
    assert.equal(sectorTitle(reading, 1), "Looming ahead (1/τ): not measured this step.");
  });

  test("missing features give no reading and no bands, whatever else the controller reports", () => {
    const cases: (Readonly<Record<string, number>> | null | undefined)[] = [undefined, null, {}, { modelForwardMps: 0.5, speedCeilingMps: 1 }];
    for (const features of cases) {
      const reading = sectorReading(features);
      assert.equal(reading.source, null);
      assert.equal(reading.measured, false);
      assert.deepEqual(reading.levels, [0, 0, 0]);
      assert.ok(reading.note);
    }
  });

  test("before any features arrive the panel says it is waiting for a frame; features without sectors are a gap", () => {
    for (const features of [undefined, null, {}]) assert.equal(sectorReading(features).note, WAITING_FOR_FRAME);
    const gap = sectorReading({ modelForwardMps: 0.5 });
    assert.equal(gap.note, "No sector motion reported.");
    assert.equal(sectorSummary(sectorReading(null)), WAITING_FOR_FRAME);
    assert.equal(sectorTitle(sectorReading(null), 0), WAITING_FOR_FRAME);
  });

  test("NaN and infinite values never light a sector", () => {
    const partial = sectorReading({ featuresPresent: 1, leftMotion: Number.NaN, centerMotion: Number.POSITIVE_INFINITY, rightMotion: 0.2 });
    assert.deepEqual(partial.values, [null, null, 0.2]);
    assert.deepEqual(partial.levels, [0, 0, 1]);
    const none = sectorReading({ frameStatus: 4, flowLeftHz: Number.NaN, flowRightHz: Number.NEGATIVE_INFINITY, loomingRateHz: Number.NaN, loomingValid: 1 });
    assert.equal(none.measured, false);
    assert.deepEqual(none.levels, [0, 0, 0]);
    assert.match(none.note ?? "", /No finite sector values/);
    assert.equal(sectorReading({ frameStatus: Number.NaN, flowLeftHz: 0.3, flowRightHz: 0.3 }).measured, false, "an unreadable frame status is not a measurement");
  });

  test("steps without a measurement say why", () => {
    assert.match(sectorReading({ frameStatus: FRAME_STATUS.firstOfPair, flowLeftHz: 0, flowRightHz: 0 }).note ?? "", /First frame of a pair/);
    assert.match(sectorReading({ frameStatus: FRAME_STATUS.duplicate, flowLeftHz: 0, flowRightHz: 0 }).note ?? "", /Same frame again/);
    assert.match(sectorReading({ featuresPresent: 0, leftMotion: 0, centerMotion: 0, rightMotion: 0 }).note ?? "", /No FlyVis features/);
  });

  test("only the baseline's own 'flow computed' status counts as measured", () => {
    for (const [name, status] of Object.entries(FRAME_STATUS)) {
      const reading = sectorReading({ frameStatus: status, flowLeftHz: 0.3, flowRightHz: 0.2, loomingRateHz: 0.1, loomingValid: 1 });
      assert.equal(reading.measured, name === "flow", name);
    }
  });
});

describe("sector bands over the camera frame", () => {
  test("optical-flow bands sit where the baseline reads: beyond ±25° and within ±12° of a 90° camera", () => {
    const [left, centre, right] = sectorBands("flow", { width: 320, height: 180 });
    const at = (degrees: number) => 0.5 + Math.tan((degrees * Math.PI) / 180) / 2;
    close(left.start, 0);
    close(left.end, at(-25));
    close(centre.start, at(-12));
    close(centre.end, at(12));
    close(right.start, at(25));
    close(right.end, 1);
  });

  test("FlyVis bands split the central square crop 10 | 11 | 10 columns", () => {
    const [left, centre, right] = sectorBands("flyvis", { width: 320, height: 180 });
    const cropHalf = 180 / 320 / 2;
    assert.ok(left.start > 0.5 - cropHalf && right.end < 0.5 + cropHalf, "inside the square crop");
    assert.equal(left.end, centre.start);
    assert.equal(centre.end, right.start);
    close(left.start + right.end, 1, "symmetric");
    close((centre.end - centre.start) / (left.end - left.start), 11 / 10, "11 centre columns to 10 side columns");
    close((0.5 - left.start) / cropHalf, 201.5 / 208.5, "the lattice spans 403 of the 417 px canvas");
  });

  test("a squarer frame widens the FlyVis crop; a missing or degenerate frame assumes 16:9", () => {
    const wide = sectorBands("flyvis", { width: 320, height: 180 });
    const square = sectorBands("flyvis", { width: 160, height: 120 });
    assert.ok(square[0].start < wide[0].start && square[2].end > wide[2].end);
    for (const frame of [null, { width: 0, height: 0 }, { width: Number.NaN, height: 90 }]) assert.deepEqual(sectorBands("flyvis", frame), wide);
  });
});

describe("move diagram geometry", () => {
  test("forward points up, leftward points left and rightward points right", () => {
    const forward = moveGeometry(command(1, 0, 0)).arrow ?? assert.fail();
    assert.ok(forward.tip.y < 0 && Math.abs(forward.tip.x) < 1e-9);
    assert.ok((moveGeometry(command(0, 0.5, 0)).arrow ?? assert.fail()).tip.x < 0, "body +y is the aircraft's left");
    assert.ok((moveGeometry(command(0, -0.5, 0)).arrow ?? assert.fail()).tip.x > 0);
    const back = moveGeometry(command(-0.15, 0, 0)).arrow ?? assert.fail();
    assert.ok(back.tip.y > 0, "backing off points down");
    assert.ok(length(back.shaftEnd) < length(back.tip), "the shaft stops under the head");
  });

  test("turning left sweeps counter-clockwise from the nose; turning right sweeps clockwise", () => {
    const left = moveGeometry(command(0, 0, 0.6)).yaw ?? assert.fail();
    assert.ok(left.sweepRad > 0 && left.end.x < 0);
    assert.match(left.path, /^M 0 -54 A 54 54 0 0 0 /, "SVG sweep-flag 0: counter-clockwise on screen");
    const right = moveGeometry(command(0, 0, -0.6)).yaw ?? assert.fail();
    assert.ok(right.sweepRad < 0 && right.end.x > 0);
    assert.match(right.path, /^M 0 -54 A 54 54 0 0 1 /, "SVG sweep-flag 1: clockwise on screen");
    close(left.end.x, -right.end.x, "mirror images");
  });

  test("no motion, NaN or a missing command draws nothing", () => {
    for (const c of [command(0, 0, 0), command(0.01, -0.01, 0.01), command(Number.NaN, 0, Number.NaN), command(Number.POSITIVE_INFINITY, 0, Number.NEGATIVE_INFINITY)]) assert.deepEqual(moveGeometry(c), { arrow: null, yaw: null });
    assert.deepEqual(moveGeometry(null), { arrow: null, yaw: null });
    assert.deepEqual(moveGeometry(undefined), { arrow: null, yaw: null });
  });

  test("arrows leave the aircraft glyph instead of starting under it", () => {
    for (const c of [command(0.15, 0, 0), command(-0.15, 0, 0), command(0.3, -0.4, 0)]) {
      const arrow = moveGeometry(c).arrow ?? assert.fail();
      close(length(arrow.start), MOVE_DIAGRAM.innerRadius);
      close(arrow.start.x * arrow.tip.y - arrow.start.y * arrow.tip.x, 0, "start and tip lie on one ray");
      assert.ok(arrow.start.x * arrow.tip.x + arrow.start.y * arrow.tip.y > 0, "on the same side");
    }
  });

  test("large moves stay inside the diagram and small ones stay visible", () => {
    close(length((moveGeometry(command(10, 0, 0)).arrow ?? assert.fail()).tip), MOVE_DIAGRAM.radius);
    close(length((moveGeometry(command(0.03, 0, 0)).arrow ?? assert.fail()).tip), MOVE_DIAGRAM.innerRadius + MOVE_DIAGRAM.minLength);
    close(Math.abs((moveGeometry(command(0, 0, 9)).yaw ?? assert.fail()).sweepRad), MOVE_DIAGRAM.maxSweepRad);
    close(Math.abs((moveGeometry(command(0, 0, -0.03)).yaw ?? assert.fail()).sweepRad), MOVE_DIAGRAM.minSweepRad);
  });

  test("requested and executed share one scale, so a limited move is visibly shorter", () => {
    const reach = (x: number) => length((moveGeometry(command(x, 0, 0)).arrow ?? assert.fail()).tip) - MOVE_DIAGRAM.innerRadius;
    close(reach(1.8) / reach(0.6), Math.sqrt(3), "square-root scale");
    assert.ok(reach(0.3) > reach(0.2) && reach(0.2) > reach(0.1), "monotonic");
    assert.ok(reach(0.4) >= 0.4 * (MOVE_DIAGRAM.radius - MOVE_DIAGRAM.innerRadius), "an indoor 0.4 m/s move keeps a visible shaft");
    close(length((moveGeometry(command(0, MOVE_DIAGRAM.fullSpeedMps / 2, 0)).arrow ?? assert.fail()).tip), speedRadius(MOVE_DIAGRAM.fullSpeedMps / 2), "half speed ends on the half ring");
    assert.equal(speedRadius(0), MOVE_DIAGRAM.innerRadius);
    assert.equal(speedRadius(MOVE_DIAGRAM.fullSpeedMps), MOVE_DIAGRAM.radius);
  });
});

describe("who chose the move", () => {
  const ALL_SOURCES: Readonly<Record<MotionSource, true>> = { fly_readout: true, engineered_readout: true, flow_baseline: true, classical_fallback: true, contingency: true, operator: true };

  test("every motion source names what chose the move, and none but a readout credits FlyVis", () => {
    const stepped = (s: MotionSource) => provenanceNote(s, "flow_baseline/goal") ?? assert.fail(s);
    for (const s of Object.keys(ALL_SOURCES) as MotionSource[]) {
      if (s !== "engineered_readout" && s !== "fly_readout") assert.ok(!/FlyVis (motion )?features/.test(stepped(s)), `${s}: ${stepped(s)}`);
    }
    assert.match(stepped("engineered_readout"), /hand-set weights/);
    assert.match(stepped("engineered_readout"), /does not decide/);
    assert.match(stepped("classical_fallback"), /not fly-model output/);
    assert.match(stepped("flow_baseline"), /No fly model/);
    assert.equal(provenanceNote(null, "flow_baseline/goal"), null);
  });

  test("no reflex is credited before a controller has reported a step, as in the UI fixture", () => {
    assert.equal(provenanceNote("flow_baseline", undefined), null, "fixture motion carries a controller source but no controller ran");
    assert.equal(provenanceNote("engineered_readout", null), null);
    assert.equal(provenanceNote("flow_baseline", "FlyVis flow/0000/000 + engineered readout"), null, "a display label is not a step");
    assert.match(provenanceNote("contingency", null) ?? "", /not the reflex/, "who else asked is always worth saying");
  });

  test("the diagram's description names directions for executed and requested moves", () => {
    const motion: GuardedMotion = {
      requested: { source: "engineered_readout", tick: 10, velocityBody: { x: 1.2, y: 0, z: 0.1 }, yawRateRadps: 0.3 },
      executed: { velocityBody: { x: 0.4, y: -0.1, z: 0 }, yawRateRadps: -0.2 },
      limits: ["acceleration"],
    };
    assert.equal(describeMove(motion), "Executed after the harness: 0.40 m/s forward, 0.10 m/s right, 0.00 m/s up, turning right 11°/s. Requested: 1.20 m/s forward, 0.00 m/s left, 0.10 m/s up, turning left 17°/s.");
    assert.equal(describeMove(null), "No motion request this tick.");
  });
});
