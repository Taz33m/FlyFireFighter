"use client";

import type { CSSProperties } from "react";
import { useEffect, useRef, useState } from "react";
import type { GuardedMotion, MotionSource } from "@/lib/contracts/actions";
import type { ControllerView, MissionView } from "@/lib/mission/protocol";
import type { SentFrame, SentFrameStore } from "@/hooks/mission-stores";
import { limitWord } from "./format";
import styles from "./FlyReflexPanel.module.css";
import type { Callout, HarnessCallout, MoveGeometry, SectorReading } from "./reflex-view";
import {
  describeMove, formatSectorValue, harnessCallouts, MOVE_DIAGRAM, moveGeometry, primaryCallout, provenanceNote, SECTOR_LETTERS,
  sectorBands, sectorMeta, sectorReading, sectorSummary, sectorTitle, speedRadius,
} from "./reflex-view";

const SOURCE_LABEL: Readonly<Record<MotionSource, string>> = {
  fly_readout: "FlyVis trained readout", engineered_readout: "FlyVis engineered readout", flow_baseline: "Optical-flow baseline",
  classical_fallback: "Classical fallback", contingency: "Contingency", operator: "Operator",
};

const NEURAL_STATUS: Readonly<Record<NonNullable<ControllerView["neural"]>["status"], string>> = {
  active: "FlyVis model active", warming_up: "FlyVis warming up", fallback: "Fallback in use; not fly-model output", unavailable: "FlyVis unavailable",
};

/** Paint a display-encoded luminance frame as grey pixels, reusing the ImageData buffer. */
function paintFrame(canvas: HTMLCanvasElement, image: ImageData | null, frame: SentFrame): ImageData | null {
  const context = canvas.getContext("2d");
  if (context === null) return image;
  if (canvas.width !== frame.width || canvas.height !== frame.height) {
    canvas.width = frame.width;
    canvas.height = frame.height;
  }
  const target = image !== null && image.width === frame.width && image.height === frame.height ? image : context.createImageData(frame.width, frame.height);
  const data = target.data;
  for (let i = 0; i < frame.luminance.length; i++) {
    const v = Math.round(Math.min(1, Math.max(0, frame.luminance[i])) * 255);
    data[i * 4] = v;
    data[i * 4 + 1] = v;
    data[i * 4 + 2] = v;
    data[i * 4 + 3] = 255;
  }
  context.putImageData(target, 0, 0);
  return target;
}

/** Draws the display-encoded luminance frame exactly as sent (no contrast stretch). */
function LuminanceCanvas({ frames, inputFrameId, onFrame }: { readonly frames: SentFrameStore; readonly inputFrameId: string | null; readonly onFrame: (frame: SentFrame | null) => void }) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    let raf = 0;
    let image: ImageData | null = null;
    let captionAt = 0;
    let captionId: string | null = null;
    const draw = (now: number) => {
      raf = 0;
      const frame = frames.find(inputFrameId) ?? frames.latest();
      // The caption re-renders React, so it follows the frame at most four times a second.
      if ((frame?.frameId ?? null) !== captionId) {
        if (now - captionAt > 250) {
          captionAt = now;
          captionId = frame?.frameId ?? null;
          onFrame(frame);
        } else {
          schedule(); // Trailing update so the caption never stays behind the last frame.
        }
      }
      if (frame !== null && canvasRef.current !== null) image = paintFrame(canvasRef.current, image, frame);
    };
    const schedule = () => {
      if (raf === 0) raf = requestAnimationFrame(draw);
    };
    schedule();
    const unsubscribe = frames.subscribe(schedule);
    return () => {
      unsubscribe();
      if (raf !== 0) cancelAnimationFrame(raf);
    };
  }, [frames, inputFrameId, onFrame]);
  return <canvas ref={canvasRef} className="reflex-frame" width={320} height={180} role="img" aria-label="Controller input frame (luminance)" />;
}

function frameCaption(frame: SentFrame | null, inputFrameId: string | null): string {
  if (frame === null) return "No camera frame has been sent yet.";
  const base = `${frame.calibrationId}, ${frame.width} × ${frame.height}, t ${(frame.tick / 100).toFixed(2)} s, rendered and read back in ${frame.renderMs.toFixed(1)} ms`;
  if (inputFrameId !== null && frame.frameId === inputFrameId) return `Controller input frame ${frame.frameId}: ${base}.`;
  if (inputFrameId !== null) return `Controller input ${inputFrameId} is no longer buffered; showing the latest frame sent (${frame.frameId}): ${base}.`;
  return `Latest frame sent to the worker (${frame.frameId}); the worker has not named the frame its controller used. ${base}.`;
}

/** A 0..1 intensity as the --level custom property the band and meter styles read. */
function levelStyle(level: number, position?: CSSProperties): CSSProperties {
  return { ...position, "--level": level.toFixed(3) } as CSSProperties;
}

/** The controller input frame with the image columns each sector reads, lit by how strongly that sector moved. */
function FrameWithBands({ frames, inputFrameId, onFrame, frame, reading, showNote }: {
  readonly frames: SentFrameStore; readonly inputFrameId: string | null; readonly onFrame: (frame: SentFrame | null) => void;
  readonly frame: SentFrame | null; readonly reading: SectorReading; readonly showNote: boolean;
}) {
  const bands = reading.source === null ? null : sectorBands(reading.source, frame);
  return <div className={styles.frameBox}>
    <LuminanceCanvas frames={frames} inputFrameId={inputFrameId} onFrame={onFrame} />
    {bands !== null && <div className={styles.bands} data-measured={reading.measured} aria-hidden="true">
      {bands.map((band, i) => <span key={SECTOR_LETTERS[i]} className={styles.band} style={levelStyle(reading.levels[i], { left: `${band.start * 100}%`, width: `${(band.end - band.start) * 100}%` })}>
        <span className={styles.bandLabel}>{SECTOR_LETTERS[i]}</span>
      </span>)}
    </div>}
    {showNote && !reading.measured && reading.note !== null && <span className={styles.frameNote}>{reading.note}</span>}
  </div>;
}

/** Compact left / centre / right meters, the same levels as the bands on the frame. */
function SectorMeters({ reading }: { readonly reading: SectorReading }) {
  const meta = sectorMeta(reading.source);
  return <div className={styles.meters} data-measured={reading.measured} role="img" aria-label={sectorSummary(reading)}>
    <span className={styles.metersTitle}>{meta?.title ?? "Sector motion"}<span className={styles.metersUnit}>{meta?.unit ?? "none reported"}</span></span>
    <span className={styles.meterBars}>
      {reading.levels.map((level, i) => <span key={SECTOR_LETTERS[i]} className={styles.meter} title={sectorTitle(reading, i as 0 | 1 | 2)}><span className={styles.meterFill} style={levelStyle(level)} /></span>)}
    </span>
    <span className={styles.meterLetters}>{SECTOR_LETTERS.map(letter => <span key={letter}>{letter}</span>)}</span>
    <span className={styles.meterValues}>{reading.values.map((value, i) => <span key={SECTOR_LETTERS[i]}>{formatSectorValue(value)}</span>)}</span>
  </div>;
}

function Callouts({ primary, placeholder, harness }: { readonly primary: Callout | null; readonly placeholder: string; readonly harness: readonly HarnessCallout[] }) {
  return <div className={styles.callouts}>
    {primary === null
      ? <span className={styles.chip} data-tone="none">{placeholder}</span>
      : <span className={styles.chip} data-tone={primary.tone} title={primary.detail}>
        <span className={styles.verb}>{primary.verb}</span><span className={styles.sep} aria-hidden="true">·</span><span className={styles.reason}>{primary.reason}</span>
      </span>}
    {harness.map(callout => <span key={callout.limit} className={styles.harness} title={callout.detail}>{callout.text}</span>)}
  </div>;
}

function MoveMarks({ geometry, className }: { readonly geometry: MoveGeometry; readonly className: string }) {
  const { arrow, yaw } = geometry;
  return <g className={className}>
    {arrow !== null && <><line x1={arrow.start.x} y1={arrow.start.y} x2={arrow.shaftEnd.x} y2={arrow.shaftEnd.y} /><polygon points={arrow.head} /></>}
    {yaw !== null && <><path d={yaw.path} /><polygon points={yaw.head} /></>}
  </g>;
}

/** Top-down move, nose up: requested (dashed) behind executed (solid), on rings at half and full speed. */
function MoveDiagram({ motion }: { readonly motion: GuardedMotion | null }) {
  const full = MOVE_DIAGRAM.fullSpeedMps;
  return <svg className={styles.diagram} viewBox="-64 -64 128 128" role="img" aria-label={describeMove(motion)}>
    <circle className={`${styles.ring} ${styles.ringHalf}`} r={speedRadius(full / 2)} />
    <circle className={styles.ring} r={speedRadius(full)} />
    <MoveMarks geometry={moveGeometry(motion?.requested)} className={styles.requested} />
    <MoveMarks geometry={moveGeometry(motion?.executed)} className={styles.executed} />
    <path className={styles.glyph} d="M 0 -10 L 7 8 L 0 4 L -7 8 Z" />
  </svg>;
}

function MoveKey() {
  const full = MOVE_DIAGRAM.fullSpeedMps;
  return <ul className={styles.key}>
    <li><svg viewBox="0 0 22 10" aria-hidden="true"><g className={styles.executed}><line x1={2} y1={5} x2={20} y2={5} /></g></svg>Executed, after harness</li>
    <li><svg viewBox="0 0 22 10" aria-hidden="true"><g className={styles.requested}><line x1={2} y1={5} x2={20} y2={5} /></g></svg>Requested</li>
    <li><svg viewBox="0 0 22 10" aria-hidden="true"><circle className={`${styles.ring} ${styles.ringHalf}`} cx={11} cy={5} r={4} /></svg>Rings {full / 2} and {full} m/s</li>
  </ul>;
}

/** Camera frame and sector meters, then the move: the controller's callout and any harness limits above the diagram. */
function ReflexView({ controller, motion, frames, frame, onFrame }: {
  readonly controller: ControllerView | null; readonly motion: GuardedMotion | null; readonly frames: SentFrameStore;
  readonly frame: SentFrame | null; readonly onFrame: (frame: SentFrame | null) => void;
}) {
  const reading = sectorReading(controller?.features);
  const requestSource = motion?.requested.source ?? null;
  const note = provenanceNote(requestSource ?? controller?.source, controller?.stepLabel);
  return <>
    <div className={styles.view}>
      <div className={styles.grid}>
        <div className={styles.sense}>
          <FrameWithBands frames={frames} inputFrameId={controller?.inputFrameId ?? null} onFrame={onFrame} frame={frame} reading={reading} showNote={controller !== null} />
          <SectorMeters reading={reading} />
        </div>
        <div className={styles.move}>
          <Callouts primary={primaryCallout(controller?.stepLabel, requestSource)} placeholder={controller === null ? "No run yet" : "Mode not reported"} harness={harnessCallouts(motion?.limits)} />
          <div className={styles.diagramRow}>
            <MoveDiagram motion={motion} />
            <MoveKey />
          </div>
        </div>
      </div>
    </div>
    {note !== null && <p className={styles.provenance}>{note}</p>}
  </>;
}

function Motion({ view }: { readonly view: MissionView }) {
  const motion = view.motion;
  if (motion === null) return <p className="empty">No motion request in the current tick.</p>;
  const row = (v: { x: number; y: number; z: number }, yaw: number) => [v.x, v.y, v.z].map(n => n.toFixed(2)).concat(`${((yaw * 180) / Math.PI).toFixed(1)}`);
  const requested = row(motion.requested.velocityBody, motion.requested.yawRateRadps);
  const executed = row(motion.executed.velocityBody, motion.executed.yawRateRadps);
  return <>
    <table className="motion-table num">
      <thead><tr><th scope="col" /><th scope="col">Forward m/s</th><th scope="col">Left m/s</th><th scope="col">Up m/s</th><th scope="col">Yaw °/s</th></tr></thead>
      <tbody>
        <tr><th scope="row">Requested <span className="muted">{SOURCE_LABEL[motion.requested.source]}</span></th>{requested.map((v, i) => <td key={i}>{v}</td>)}</tr>
        <tr><th scope="row">Executed <span className="muted">after the harness</span></th>{executed.map((v, i) => <td key={i} className={v !== requested[i] ? "limited" : undefined}>{v}</td>)}</tr>
      </tbody>
    </table>
    <p className="limits">{motion.limits.length === 0 ? "No harness limit applied." : <>Harness limited the request: {motion.limits.map(l => <span key={l} className="tag warn">{limitWord(l)}</span>)}</>}</p>
  </>;
}

function Features({ features }: { readonly features: ControllerView["features"] }) {
  const entries = Object.entries(features).sort(([a], [b]) => a.localeCompare(b)).slice(0, 14);
  if (entries.length === 0) return <p className="empty">No controller features reported.</p>;
  const scale = Math.max(1e-9, ...entries.map(([, v]) => Math.abs(v)));
  return <ul className="feature-list">
    {entries.map(([name, value]) => <li key={name}>
      <span className="code">{name}</span>
      <span className="feature-bar" aria-hidden="true"><span style={{ width: `${(Math.abs(value) / scale) * 50}%`, [value < 0 ? "right" : "left"]: "50%" }} /></span>
      <span className="num">{value.toFixed(3)}</span>
    </li>)}
  </ul>;
}

function NeuralFacts({ neural }: { readonly neural: ControllerView["neural"] }) {
  if (neural === null) return <dd>Not used by this controller</dd>;
  return <dd>
    {NEURAL_STATUS[neural.status]}
    {neural.model !== null && <> <span className="muted">{neural.model}</span></>}
    {neural.latencyMs !== null && <> <span className="num">{neural.latencyMs.toFixed(1)} ms</span></>}
    {neural.checkpointSha256 !== null && <> <code title={neural.checkpointSha256}>{neural.checkpointSha256.slice(0, 10)}…</code></>}
  </dd>;
}

/** The feature bars and numbers behind the view, rendered only while Details is open. */
function ReflexDetails({ view }: { readonly view: MissionView | null }) {
  if (view === null) return <p className="empty">No run yet.</p>;
  const controller = view.controller;
  return <>
    <dl className="facts">
      <dt>Neural model</dt><NeuralFacts neural={controller.neural} />
      <dt>Controller step</dt><dd><code>{controller.stepLabel ?? "not reported"}</code></dd>
    </dl>
    <h3>Features</h3>
    <Features features={controller.features} />
    <h3>Motion</h3>
    <Motion view={view} />
  </>;
}

function ControllerLine({ controller }: { readonly controller: ControllerView | null }) {
  const neural = controller?.neural ?? null;
  const warn = neural !== null && (neural.status === "fallback" || neural.status === "unavailable");
  return <p className="controller-label">
    {controller?.label ?? "No controller until a run starts."}
    {neural !== null && <> <span className={warn ? "tag warn" : "tag"}>{NEURAL_STATUS[neural.status]}</span></>}
  </p>;
}

export function FlyReflexPanel({ view, frames }: { readonly view: MissionView | null; readonly frames: SentFrameStore }) {
  const [shown, setShown] = useState<SentFrame | null>(null);
  const [detailsOpen, setDetailsOpen] = useState(false);
  const controller = view?.controller ?? null;
  return <section id="fly-reflex" tabIndex={-1} className="panel reflex" aria-label="Fly reflex panel">
    <h2>Fly reflex <span className="muted">camera to motion</span></h2>
    <ControllerLine controller={controller} />
    <ReflexView controller={controller} motion={view?.motion ?? null} frames={frames} frame={shown} onFrame={setShown} />
    <p className="caption">{frameCaption(shown, controller?.inputFrameId ?? null)}</p>
    <details className={styles.details} onToggle={event => setDetailsOpen(event.currentTarget.open)}>
      <summary>Details <span className="muted">features and numbers</span></summary>
      {detailsOpen && <ReflexDetails view={view} />}
    </details>
  </section>;
}
