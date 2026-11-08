/**
 * Full-screen console images on legacy FREE-WILi firmware v54 (display CPU), LIFELINE-style: each screen is a
 * content-addressed 320 × 240 .FWI uploaded to /images, verified by reading it back byte for byte, then shown with
 * the firmware's image command by file name only. Pure state machine over a small host interface; session.ts owns
 * the port. The technique follows the author's LIFELINE ambient UI (MHacks, native/freewili/ambient_ui.py).
 *
 * Transfer protocol (freewili 0.0.51 fw_serial.py):
 * - upload: "x\nf\n/images/NAME <size> <crc32>\n" → a response frame (ok) → raw payload in 32 KiB writes → a final
 *   response frame (ok when the firmware's own CRC check passed);
 * - readback: "x\nu\n\images\NAME \n" → a response frame ending in the size → exactly <size> raw bytes → a final
 *   frame "success <N> bytes <crc> crc".
 * During a transfer nothing else is written (no button reads or shows); the button stream is paused and resumed.
 *
 * Timing on hardware (v54, 153,624-byte screen): upload 4.5 s, readback 4.0 s, show 44 ms. So screens are installed
 * at connect in priority order, and a decision shows a pre-installed template rather than waiting for an upload.
 *
 * Safety: only names matching IMAGE_NAME (FF + 6 hex, ours) are ever written, read or shown; nothing is deleted.
 * At most MAX_IMAGES_PER_SESSION new uploads per connection keeps the display filesystem bounded. An image screen is
 * confirmed (onShown with its digest) only when its show command is acknowledged; a text fallback never confirms.
 */
import type { ConsoleMessage, LegacyCommand } from "./stock-protocol.ts";
import { crc32, uploadChunks } from "./stock-protocol.ts";

export interface DeviceImage {
  readonly name: string;
  readonly bytes: Uint8Array;
  /** Read back byte for byte after upload (the approval templates); others trust the firmware's CRC check. */
  readonly verify?: boolean;
  /** Upload order: lower first (0 templates, 1 the screen on display now, 2 the rest). */
  readonly priority?: number;
}

export interface LegacyScreen {
  readonly text: string;
  readonly digest: string | null;
  readonly image: DeviceImage | null;
}

export interface LegacyHost {
  now(): number;
  send(cmd: LegacyCommand): void;
  sendRaw(bytes: Uint8Array): void;
  expectRaw(count: number, magic: string | null): void;
  /** A show was acknowledged: `digest` is the proposal an image showed (null for text or a non-proposal image). */
  onShown(digest: string | null, ok: boolean): void;
  onStatus(detail: string): void;
  /** Connect-time installation progress. */
  onProgress(done: number, total: number): void;
}

export const MAX_IMAGES_PER_SESSION = 36;
export const SHOW_INTERVAL_MS = 200;
export const SLOW_SHOW_INTERVAL_MS = 1000;
export const SLOW_SHOW_MS = 150;
export const SHOW_ACK_TIMEOUT_MS = 2000;
export const TRANSFER_STEP_TIMEOUT_MS = 8000;
/** Consecutive transfer failures after which images are given up for this connection (text only). */
export const MAX_FAILURES = 4;
export const BUTTON_STREAM_MS = 50;

type Phase = "put_handshake" | "put_final" | "get_handshake" | "get_raw" | "get_final";
interface Transfer { readonly image: DeviceImage; phase: Phase; stepAtMs: number }
interface Showing { readonly key: string; readonly digest: string | null; readonly image: boolean; readonly sentAtMs: number }

const endsWith = (command: string, letter: string) => command === letter || command.endsWith(`\\${letter}`);

export class LegacyDriver {
  private readonly host: LegacyHost;
  private readonly verified = new Set<string>();
  private readonly failedNames = new Set<string>();
  private queue: DeviceImage[] = [];
  private transfer: Transfer | null = null;
  private showing: Showing | null = null;
  private shownKey: string | null = null;
  private lastShowMs = -Infinity;
  private intervalMs = SHOW_INTERVAL_MS;
  private failures = 0;
  private uploads = 0;
  private desired: LegacyScreen | null = null;
  private dirty = false;
  private preloadNames = new Set<string>();
  private readonly attempts = new Map<string, number>();
  imagesDisabled = false;

  constructor(host: LegacyHost) {
    this.host = host;
  }

  /** A file transfer owns the port: no button reads or other writes now. */
  get busy(): boolean {
    return this.transfer !== null;
  }

  want(screen: LegacyScreen): void {
    this.desired = screen;
    if (screen.image !== null) this.enqueue({ ...screen.image, priority: Math.min(1, screen.image.priority ?? 1) });
    this.pump();
  }

  /** Images to put on the device ahead of need (the connect-time set), with progress reported. */
  preload(images: readonly DeviceImage[]): void {
    this.preloadNames = new Set(images.map(i => i.name));
    for (const image of images) this.enqueue(image);
    this.progress();
    this.pump();
  }

  private progress(): void {
    if (this.preloadNames.size === 0) return;
    const done = [...this.preloadNames].filter(n => this.verified.has(n) || this.failedNames.has(n)).length;
    this.host.onProgress(done, this.preloadNames.size);
  }

  /** A button edge: the firmware's own GUI may have redrawn, so show the current screen again. */
  resync(): void {
    this.dirty = true;
    this.pump();
  }

  tick(): void {
    const now = this.host.now();
    if (this.transfer !== null && now - this.transfer.stepAtMs > TRANSFER_STEP_TIMEOUT_MS) this.fail(`timed out during ${this.transfer.phase}`);
    if (this.showing !== null && now - this.showing.sentAtMs > SHOW_ACK_TIMEOUT_MS) this.shown(false);
    this.pump();
  }

  /** Consume transfer and show acknowledgements; returns false for messages the session should handle. */
  handle(message: ConsoleMessage): boolean {
    if (message.type === "raw") return this.raw(message.bytes);
    if (message.type !== "response") return false;
    if (this.transfer !== null) return this.transferFrame(message.command, message.ok, message.response);
    if (this.showing !== null && (endsWith(message.command, "l") || endsWith(message.command, "p"))) { this.shown(message.ok); return true; }
    return false;
  }

  private enqueue(image: DeviceImage): void {
    if (this.imagesDisabled || this.verified.has(image.name) || this.failedNames.has(image.name)) return;
    if (this.transfer?.image.name === image.name) return;
    const queued = this.queue.find(q => q.name === image.name);
    const priority = Math.min(image.priority ?? 2, queued?.priority ?? 2);
    if (queued === undefined && this.uploads + this.queue.length >= MAX_IMAGES_PER_SESSION) return;
    const rest = this.queue.filter(q => q.name !== image.name);
    const entry = { ...(queued ?? image), priority };
    const at = rest.findIndex(q => (q.priority ?? 2) > priority);
    this.queue = at === -1 ? [...rest, entry] : [...rest.slice(0, at), entry, ...rest.slice(at)];
  }

  private pump(): void {
    if (this.transfer !== null || this.showing !== null) return;
    if (this.showNext()) return;
    const next = this.queue.shift();
    if (next !== undefined) this.begin(next);
  }

  /** Show the desired screen (its image if verified, else its text) when it changed; true if a show was sent. */
  private showNext(): boolean {
    const screen = this.desired;
    if (screen === null) return false;
    const useImage = screen.image !== null && this.verified.has(screen.image.name);
    // The digest is part of the key: a second proposal of the same kind re-shows its template, and only that
    // acknowledgement confirms it.
    const key = `${useImage && screen.image !== null ? `img:${screen.image.name}` : `txt:${screen.text}`}:${screen.digest ?? ""}`;
    if (key === this.shownKey && !this.dirty) return false;
    const now = this.host.now();
    if (now - this.lastShowMs < this.intervalMs) return false;
    this.dirty = false;
    this.lastShowMs = now;
    // Like the v024 line, a text fallback naming the decision also stands for it until its image is installed.
    this.showing = { key, digest: screen.digest, image: useImage, sentAtMs: now };
    this.host.send(useImage && screen.image !== null ? { kind: "show_image", name: screen.image.name } : { kind: "show_text", text: screen.text });
    return true;
  }

  private shown(ok: boolean): void {
    const sent = this.showing;
    if (sent === null) return;
    this.showing = null;
    if (this.host.now() - sent.sentAtMs > SLOW_SHOW_MS) this.intervalMs = SLOW_SHOW_INTERVAL_MS;
    this.shownKey = ok ? sent.key : null;
    this.host.onShown(ok ? sent.digest : null, ok);
    this.pump();
  }

  private begin(image: DeviceImage): void {
    this.uploads++;
    this.transfer = { image, phase: "put_handshake", stepAtMs: this.host.now() };
    this.host.send({ kind: "button_events", intervalMs: 0 });
    this.host.send({ kind: "put_image", name: image.name, size: image.bytes.length, crc32: crc32(image.bytes) });
  }

  private step(phase: Phase): void {
    if (this.transfer === null) return;
    this.transfer.phase = phase;
    this.transfer.stepAtMs = this.host.now();
  }

  private transferFrame(command: string, ok: boolean, response: string): boolean {
    const t = this.transfer;
    if (t === null) return false;
    if (endsWith(command, "f") && (t.phase === "put_handshake" || t.phase === "put_final")) {
      if (!ok) { this.fail(`upload refused: ${response}`); return true; }
      if (t.phase === "put_handshake") {
        this.step("put_final");
        for (const chunk of uploadChunks(t.image.bytes)) this.host.sendRaw(chunk);
      } else if (t.image.verify === true) {
        this.step("get_handshake");
        this.host.send({ kind: "get_image", name: t.image.name });
      } else {
        this.installed();
      }
      return true;
    }
    if (endsWith(command, "u") && t.phase === "get_handshake") return this.readbackStart(ok, response);
    if (endsWith(command, "u") && t.phase === "get_final") return this.readbackEnd(ok, response);
    return false;
  }

  private readbackStart(ok: boolean, response: string): boolean {
    const size = Number(response.trim().split(" ").at(-1));
    const t = this.transfer;
    if (t === null) return false;
    if (!ok || size !== t.image.bytes.length) { this.fail(`readback refused: ${response}`); return true; }
    this.step("get_raw");
    this.host.expectRaw(size, "FW01IMG");
    return true;
  }

  private raw(bytes: Uint8Array): boolean {
    const t = this.transfer;
    if (t === null || t.phase !== "get_raw") return true;
    if (bytes.length !== t.image.bytes.length || bytes.some((b, i) => b !== t.image.bytes[i])) { this.fail("readback differs from the upload"); return true; }
    this.step("get_final");
    return true;
  }

  private readbackEnd(ok: boolean, response: string): boolean {
    const t = this.transfer;
    if (t === null) return false;
    const tokens = response.trim().split(" ");
    const crc = Number(tokens.at(-2));
    if (!ok || crc !== crc32(t.image.bytes)) { this.fail(`readback checksum: ${response}`); return true; }
    this.installed();
    return true;
  }

  private installed(): void {
    const t = this.transfer;
    if (t === null) return;
    this.verified.add(t.image.name);
    this.failures = 0;
    this.end();
    this.progress();
    this.dirty = true;
    this.pump();
  }

  private end(): void {
    this.transfer = null;
    this.host.send({ kind: "button_events", intervalMs: BUTTON_STREAM_MS });
  }

  private fail(reason: string): void {
    const t = this.transfer;
    if (t === null) return;
    // One retry per screen (a lost burst of bytes is transient); a second failure gives that screen up.
    const tries = (this.attempts.get(t.image.name) ?? 0) + 1;
    this.attempts.set(t.image.name, tries);
    this.failures++;
    if (tries >= 2) this.failedNames.add(t.image.name);
    else this.queue = [t.image, ...this.queue];
    this.host.expectRaw(0, null);
    this.end();
    if (this.failures >= MAX_FAILURES) {
      this.imagesDisabled = true;
      this.queue = [];
      this.host.onStatus(`Images unavailable (${reason}); the device shows text.`);
    } else {
      this.host.onStatus(`Image ${t.image.name} not installed: ${reason}`);
    }
    this.progress();
    this.dirty = true;
  }
}
