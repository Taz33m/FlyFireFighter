/**
 * The course runner's connection to the real FlyVis service (services/flyvis, one network instance on
 * 127.0.0.1:3201), through the committed NeuralClient and WebSocket transport. One connection is reused for
 * every run of a batch; each run starts with reset(runId, calibration), which reinitializes the network and
 * warms up on the run's first frame. The batch runner waits for every step (frames are never skipped); the
 * per-step deadline is set generously so a slow step is COUNTED as a missed deadline by the metrics rather
 * than desynchronizing the run.
 */
import type { CameraCalibration, CameraFrame } from "../../contracts/camera.ts";
import type { NeuralReady } from "../../contracts/neural.ts";
import { NeuralClient } from "../../navigation/neural/client.ts";
import { connectWebSocketTransport } from "../../navigation/neural/transport.ts";
import type { NeuralSource } from "./runner.ts";

export class ServiceNeuralSource implements NeuralSource {
  private readonly client: NeuralClient;
  ready: NeuralReady | null = null;

  private constructor(client: NeuralClient) {
    this.client = client;
  }

  static async connect(url?: string): Promise<ServiceNeuralSource> {
    const transport = await connectWebSocketTransport(url === undefined ? {} : { url });
    return new ServiceNeuralSource(new NeuralClient(transport, { stepDeadlineMs: 2000, firstStepDeadlineMs: 5000, resetDeadlineMs: 10000 }));
  }

  async reset(runId: string, calibration: CameraCalibration): Promise<void> {
    this.ready = await this.client.reset(runId.slice(0, 64), calibration);
  }

  async step(frame: CameraFrame, tick: number): Promise<{ features: Awaited<ReturnType<NeuralClient["step"]>>; roundTripMs: number }> {
    const started = performance.now();
    const features = await this.client.step(frame, tick);
    return { features, roundTripMs: performance.now() - started };
  }

  async close(): Promise<void> {
    this.client.close();
    await this.client.closed;
  }
}
