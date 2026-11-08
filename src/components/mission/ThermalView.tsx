"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { secondsFromTicks } from "@/lib/contracts/clock";
import type { ThermalFrame, SpanMode } from "@/lib/render/thermal-camera";
import { EXTERIOR_AMBIENT_C, FIXED_SPAN, PALETTE_STOPS, THERMAL_SMOKE_RATIO, ThermalPass, thermalCalibration } from "@/lib/render/thermal-camera";
import type { TwinRenderer } from "@/lib/render/twin-renderer";

interface Props {
  /** The twin's single renderer; the thermal view adds a pass to it and never creates its own context. */
  readonly renderer: TwinRenderer | null;
  readonly aircraftId: string;
}

const GRADIENT = `linear-gradient(to right, ${PALETTE_STOPS.map(([p, r, g, b]) => `rgb(${r} ${g} ${b}) ${(p * 100).toFixed(0)}%`).join(", ")})`;

const formatC = (c: number) => (Number.isFinite(c) ? `${c.toFixed(c >= 100 ? 0 : 1)} °C` : "—");

/** Synthetic thermal view of the drone's thermal camera, rendered from the same RenderSnapshot as the twin. */
export function ThermalView({ renderer, aircraftId }: Props) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const passRef = useRef<ThermalPass | null>(null);
  const clockRef = useRef<HTMLSpanElement>(null);
  const spotRef = useRef<HTMLElement>(null);
  const maxRef = useRef<HTMLElement>(null);
  const minLabelRef = useRef<HTMLSpanElement>(null);
  const maxLabelRef = useRef<HTMLSpanElement>(null);
  const [mode, setMode] = useState<SpanMode>("auto");
  const [hasFrame, setHasFrame] = useState(false);
  const [format, setFormat] = useState<ThermalFrame["format"] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const calibration = useMemo(() => thermalCalibration(aircraftId), [aircraftId]);

  useEffect(() => {
    if (renderer === null || calibration === null) return;
    const canvas = canvasRef.current;
    const context = canvas?.getContext("2d") ?? null;
    let image: ImageData | null = null;
    let seen = false;
    const onFrame = (frame: ThermalFrame) => {
      if (context === null) return;
      if (image === null || image.width !== frame.width || image.height !== frame.height) image = context.createImageData(frame.width, frame.height);
      image.data.set(frame.rgba);
      context.putImageData(image, 0, 0);
      if (clockRef.current !== null) clockRef.current.textContent = `t ${secondsFromTicks(frame.tick).toFixed(2)} s · tick ${frame.tick}`;
      if (spotRef.current !== null) spotRef.current.textContent = formatC(frame.centreC);
      if (maxRef.current !== null) maxRef.current.textContent = formatC(frame.maxC);
      if (minLabelRef.current !== null) minLabelRef.current.textContent = formatC(frame.span.minC);
      if (maxLabelRef.current !== null) maxLabelRef.current.textContent = formatC(frame.span.maxC);
      if (!seen) {
        seen = true;
        setHasFrame(true);
        setFormat(frame.format);
      }
    };
    const pass = new ThermalPass(calibration, onFrame, message => setError(message));
    passRef.current = pass;
    const remove = renderer.addPass(pass);
    return () => {
      remove();
      passRef.current = null;
      setHasFrame(false);
      setError(null);
    };
  }, [renderer, calibration]);

  useEffect(() => passRef.current?.setSpanMode(mode), [mode, renderer]);

  const size = calibration === null ? null : `${calibration.width} × ${calibration.height}`;
  return <section id="thermal-view" tabIndex={-1} className="panel thermal" aria-label="Synthetic thermal view">
    <h2>Thermal camera <span className="muted">{calibration === null ? "not fitted" : `${calibration.id}, ${size}, true pose`}</span></h2>
    {calibration === null ? <p className="empty">This aircraft profile has no thermal camera.</p> : <>
      <div className="thermal-stage">
        <canvas ref={canvasRef} className="thermal-frame" width={calibration.width} height={calibration.height} role="img" aria-label="Synthetic thermal image from the drone's thermal camera; temperatures are simulated" />
        <span className="thermal-badge">Synthetic thermal view (simulation)</span>
        <span className="thermal-clock num" ref={clockRef} />
        <span className="thermal-spot" aria-hidden="true" />
        {!hasFrame && <p className="thermal-wait">{error !== null ? `Thermal view stopped: ${error}` : renderer === null ? "Waiting for the 3D view" : "Waiting for a simulation snapshot"}</p>}
      </div>
      <div className="thermal-scale" aria-label="Colour scale">
        <span className="thermal-bar" style={{ backgroundImage: GRADIENT }} />
        <span className="thermal-scale-labels num"><span ref={minLabelRef}>{mode === "fixed" ? formatC(FIXED_SPAN.minC) : "—"}</span><span ref={maxLabelRef}>{mode === "fixed" ? formatC(FIXED_SPAN.maxC) : "—"}</span></span>
      </div>
      <div className="thermal-readout">
        <dl className="facts">
          <dt>Centre spot</dt><dd className="num"><strong ref={spotRef}>—</strong></dd>
          <dt>Frame maximum</dt><dd className="num" ref={maxRef}>—</dd>
        </dl>
        <div className="segmented small" role="radiogroup" aria-label="Colour span">
          <button type="button" role="radio" aria-checked={mode === "auto"} onClick={() => setMode("auto")}>Auto span</button>
          <button type="button" role="radio" aria-checked={mode === "fixed"} onClick={() => setMode("fixed")}>Fixed {FIXED_SPAN.minC}–{FIXED_SPAN.maxC} °C</button>
        </div>
      </div>
      {error !== null && hasFrame && <p className="warn small" role="alert">Thermal view stopped: {error}</p>}
      <p className="caption">
        Simulated temperatures, not a radiometric sensor model and not a controller input. Surfaces take their room&apos;s simulated temperature (outside: an assumed {EXTERIOR_AMBIENT_C} °C); fire and occupants come from the simulation. Walls and glass are opaque to thermal; smoke attenuates it weakly ({Math.round(THERMAL_SMOKE_RATIO * 100)}% of the visible extinction, an assumption).{format === "rgba8" && " 8-bit fallback target: about 4 °C quantisation."}
      </p>
    </>}
  </section>;
}
