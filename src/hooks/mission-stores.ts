/**
 * Small subscription stores for high-rate mission data, kept outside React state so 50 Hz traffic never
 * re-renders the command panels:
 * - RenderSnapshotStore: the latest privileged RenderSnapshot, read only by the 3D renderer.
 * - SentFrameStore: copies of the luminance frames actually posted back to the worker as camera_frame
 *   messages (the controller's input), for the fly reflex panel.
 */
import type { RenderSnapshot } from "@/lib/mission/protocol";

type Listener = () => void;

class Subscribable {
  private readonly listeners = new Set<Listener>();

  subscribe = (listener: Listener): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  protected emit(): void {
    for (const listener of this.listeners) listener();
  }
}

export class RenderSnapshotStore extends Subscribable {
  private snapshot: RenderSnapshot | null = null;

  get(): RenderSnapshot | null {
    return this.snapshot;
  }

  set(snapshot: RenderSnapshot | null): void {
    this.snapshot = snapshot;
    this.emit();
  }
}

export interface SentFrame {
  readonly runId: string;
  readonly frameId: string;
  readonly tick: number;
  readonly calibrationId: string;
  readonly width: number;
  readonly height: number;
  /** A copy of the transferred luminance (row 0 at the top, display-encoded [0, 1]). */
  readonly luminance: Float32Array;
  /** Wall-clock milliseconds spent rendering and reading back this frame. */
  readonly renderMs: number;
}

const RING = 8;

export class SentFrameStore extends Subscribable {
  private readonly frames: SentFrame[] = [];
  private readonly buffers: Float32Array[] = [];
  private next = 0;
  private sent = 0;

  /** Copy a frame into a reused buffer before its luminance is transferred to the worker. */
  record(frame: Omit<SentFrame, "luminance">, luminance: Float32Array): void {
    const slot = this.next;
    let buffer = this.buffers[slot];
    if (buffer === undefined || buffer.length !== luminance.length) {
      buffer = new Float32Array(luminance.length);
      this.buffers[slot] = buffer;
    }
    buffer.set(luminance);
    this.frames[slot] = { ...frame, luminance: buffer };
    this.next = (slot + 1) % RING;
    this.sent += 1;
    this.emit();
  }

  /** The most recently sent frame, or the one with `frameId` if it is still in the ring. */
  find(frameId: string | null): SentFrame | null {
    if (frameId !== null) return this.frames.find(f => f !== undefined && f.frameId === frameId) ?? null;
    return this.latest();
  }

  latest(): SentFrame | null {
    return this.frames[(this.next + RING - 1) % RING] ?? null;
  }

  count(): number {
    return this.sent;
  }

  clear(): void {
    this.frames.length = 0;
    this.next = 0;
    this.sent = 0;
    this.emit();
  }
}
