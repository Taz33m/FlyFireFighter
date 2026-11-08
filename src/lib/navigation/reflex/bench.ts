/**
 * Compute benchmark for the reflex controllers (not a test). Run: node src/lib/navigation/reflex/bench.ts
 *
 * Times FlowBaselineController.step on pre-rendered 320×180 synthetic frames (80×45 flow grid): area
 * resampling, pyramid, efference-aided Lucas–Kanade, cue extraction and the command mapping. Rendering the
 * fixture frames is excluded. Also times the flow solve alone and the engineered readout step. Results are
 * wall-clock milliseconds for this machine and Node process; one heavy command at a time on the shared Mac.
 */
import { vec3 } from "../../contracts/frames.ts";
import { EngineeredReadoutController } from "./engineered-readout.ts";
import { FlowBaselineController } from "./flow-baseline.ts";
import { DenseFlow } from "./flow.ts";
import { buildPyramid, resampleToGrid } from "./image.ts";
import { approachSequence } from "./scenarios.ts";

function summarise(label: string, samples: number[]): void {
  const sorted = [...samples].sort((a, b) => a - b);
  const at = (q: number) => sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))];
  const mean = samples.reduce((sum, value) => sum + value, 0) / samples.length;
  console.log(`${label.padEnd(36)} mean ${mean.toFixed(3)} ms  p50 ${at(0.5).toFixed(3)}  p95 ${at(0.95).toFixed(3)}  max ${sorted[sorted.length - 1].toFixed(3)}  (n=${samples.length})`);
}

const frames = approachSequence({ frames: 120, speedMps: 1.2, wallDistanceM: 6, noiseSigma: 0.01 }).map(s => s.frame);
const previous = { velocityBody: vec3(1.2, 0, 0), yawRateRadps: 0.3 };
const goal = { bearingRad: 0.1, distanceM: 10, heightErrorM: 0 };

const controller = new FlowBaselineController();
const stepTimes: number[] = [];
for (let pass = 0; pass < 5; pass++) {
  controller.reset();
  frames.forEach((frame, k) => {
    const start = performance.now();
    controller.step({ tick: frame.captureTick, frame, goal, previous, quality: { frame: 1, poseSigmaM: 0.1 }, ranges: null });
    if (pass > 0 && k > 0) stepTimes.push(performance.now() - start);
  });
}
summarise("flow_baseline step (320×180 → 80×45)", stepTimes);

const pyramids = frames.map(frame => buildPyramid(resampleToGrid(frame, 80, 45), 80, 45, 3));
const solver = new DenseFlow();
const flowTimes: number[] = [];
for (let pass = 0; pass < 5; pass++) {
  for (let k = 1; k < pyramids.length; k++) {
    const start = performance.now();
    solver.compute(pyramids[k - 1], pyramids[k]);
    if (pass > 0) flowTimes.push(performance.now() - start);
  }
}
summarise("Lucas–Kanade solve only (80×45)", flowTimes);

const readout = new EngineeredReadoutController({ features: () => ({ leftMotion: -0.3, centerMotion: 0.02, rightMotion: 0.35, expansion: 0.33 }) });
const readoutTimes: number[] = [];
for (let k = 0; k < 2000; k++) {
  const start = performance.now();
  readout.step({ tick: 2 * k, frame: null, goal, previous, quality: { frame: 1, poseSigmaM: 0.1 }, ranges: null });
  if (k >= 200) readoutTimes.push(performance.now() - start);
}
summarise("engineered_readout step", readoutTimes);
