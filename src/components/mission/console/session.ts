/**
 * One connection to the Free-WiLi OG's MAIN "Board CDC" port (official OG firmware v023+): serial bytes in,
 * button gestures and display confirmations out. Transport-agnostic (Web Serial in the browser, a fake port in
 * tests); no React, no mission logic.
 *
 * Handshake: after opening, the session sends only the identify query (`?`). Nothing else is written until the
 * port answers "FWOG main ogfw NNN" with NNN ≥ MIN_OGFW_VERSION. A port that answers otherwise, prints the
 * display CPU's heartbeat, prints WiLiDoro's, or says nothing within IDENTIFY_TIMEOUT_MS gets no further writes.
 * Then: button stream on, and a read of all buttons every POLL_MS (the v024 stream reports about once a second
 * whatever interval is asked for, too slowly to see a press, so the levels are polled as well).
 *
 * Safety:
 * - The port is always opened at CONSOLE_BAUD_RATE. Opening an RP2040 CDC port at 1200 baud reboots that CPU
 *   into its UF2 bootloader, so 1200 is refused outright.
 * - Every write goes through encodeCommand's allowlist (Ctrl-B, identify, button stream, read buttons, show
 *   and clear text). MAIN also carries the radios, IR and GPIO; none of their commands can be expressed.
 * - Gestures come only from parsed button frames, through ButtonGestures (baseline, edges, debounce). Every
 *   (re)connect starts a fresh baseline and an unconfirmed display, so connecting approves nothing.
 * - The display is confirmed only by the firmware's acknowledgement of the show-text write that carried the
 *   digest; one show-text is in flight at a time, so an acknowledgement cannot be credited to the wrong screen.
 * - A write that does not complete within WRITE_TIMEOUT_MS stops all further writes for this connection.
 */
import type { DisplayedDigest } from "../approval.ts";
import { noteDisplayed } from "../approval.ts";
import type { Gesture } from "./buttons.ts";
import { ButtonGestures } from "./buttons.ts";
import type { DeviceImage, LegacyHost } from "./legacy-driver.ts";
import { LegacyDriver } from "./legacy-driver.ts";
import type { ConsoleCommand, ConsoleMessage, LegacyCommand } from "./stock-protocol.ts";
import { BUTTON_EVENT_INTERVAL_MS, ConsoleParser, encodeCommand, encodeLegacy } from "./stock-protocol.ts";

/** Matches the official host libraries. USB CDC ignores the rate, except that 1200 means "reboot to bootloader". */
export const CONSOLE_BAUD_RATE = 1_000_000;
/** Opening at this rate reboots an RP2040 into BOOTSEL. Never used. */
export const BOOTLOADER_BAUD_RATE = 1200;
export const WRITE_TIMEOUT_MS = 2000;
/** The identify query must be answered within this time. */
export const IDENTIFY_TIMEOUT_MS = 2000;
/** The shared menu (and with it host button reads) arrived in OG firmware v023. */
export const MIN_OGFW_VERSION = 23;
/** Button levels are read this often. */
export const POLL_MS = 100;
/** A button read not answered within this time is given up, and the next one may be sent. */
export const POLL_TIMEOUT_MS = 1000;
/** A show-text write not acknowledged within this time leaves the display unconfirmed. */
export const DISPLAY_ACK_TIMEOUT_MS = 2000;
/** Same-proposal screen refreshes (the countdown) are sent at most this often. */
export const DISPLAY_REFRESH_MS = 1000;
/** At most five screen writes per second... */
export const MIN_DISPLAY_INTERVAL_MS = 200;
/** ...and one per second for the rest of the connection once an acknowledgement takes longer than this. */
export const SLOW_ACK_MS = 150;
export const SLOW_DISPLAY_INTERVAL_MS = 1000;

/** What the device should show: its one line of text, and the proposal digest that text stands for (or null). */
export interface DeviceScreen {
  readonly text: string;
  readonly digest: string | null;
  /** The full 320 × 240 screen as an .FWI, for legacy firmware that shows images (null when not rendered). */
  readonly image?: DeviceImage | null;
}

const OGFW_MAIN = /^FWOG main ogfw (\d{3})$/;
/** Legacy FREE-WILi firmware's display CPU, e.g. "DisplayCPU v54": full-screen images, LIFELINE-style. */
const LEGACY_DISPLAY = /DisplayCPU\D*?(\d+)/i;
const LEGACY_MAIN = /MainCPU/i;
/** Raw upload chunks can take longer than a command line to drain. */
const RAW_WRITE_TIMEOUT_MS = 10_000;

export function assertSafeBaudRate(baudRate: number): number {
  if (!Number.isFinite(baudRate) || baudRate <= 2400 || baudRate === BOOTLOADER_BAUD_RATE) {
    throw new RangeError(`Refusing to open the console at ${baudRate} baud: 1200 baud reboots the board into its bootloader.`);
  }
  return baudRate;
}

/** The minimum a serial port must offer. Web Serial is adapted to this in web-serial.ts. */
export interface ConsoleTransport {
  open(options: { readonly baudRate: number }): Promise<void>;
  /** Chunks as they arrive; ends when the port closes or the device disconnects; throws on a read error. */
  chunks(): AsyncIterable<Uint8Array>;
  write(bytes: Uint8Array): Promise<void>;
  close(): Promise<void>;
}

export type ConsoleStatus =
  | "connecting"
  /** Open; waiting for the identify answer. */
  | "waiting"
  /** Identified as OG firmware MAIN; buttons and display in use. */
  | "connected"
  /** The chosen port is not MAIN's command port (display CPU, binary events port, or silent). */
  | "wrong_port"
  /** The board runs firmware that cannot be a console (WiLiDoro, or OG firmware older than v023). */
  | "unsupported_firmware"
  /** The device stopped reading writes. */
  | "not_reading"
  | "disconnected"
  | "closed";

export interface ConsoleSnapshot {
  readonly status: ConsoleStatus;
  /** The identify answer, e.g. "FWOG main ogfw 024"; null until answered. */
  readonly product: string | null;
  /** A button frame has arrived on this connection. */
  readonly buttonsLive: boolean;
  /** The digest the device display confirmed, and since when. */
  readonly device: DisplayedDigest | null;
  readonly abortPrimed: boolean;
  readonly detail: string | null;
  /** "images" on legacy firmware that shows full screens, "text" for the one-line overlay; null until identified. */
  readonly display: "text" | "images" | null;
  /** Connect-time screen installation on image firmware, or null. */
  readonly loading: { readonly done: number; readonly total: number } | null;
}

export interface SessionOptions {
  readonly now: () => number;
  readonly onGesture: (gesture: Gesture) => void;
  readonly onChange: (snapshot: ConsoleSnapshot) => void;
  /** Defaults to WRITE_TIMEOUT_MS. */
  readonly writeTimeoutMs?: number;
}

interface InFlight {
  readonly text: string;
  readonly digest: string | null;
  readonly sentAtMs: number;
}

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T | "timeout"> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<"timeout">(resolve => { timer = setTimeout(() => resolve("timeout"), ms); });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

const WRONG_PORT_DISPLAY = "This is the display CPU's port. Choose the FWOG main port named \"Board CDC\" instead.";
const WRONG_PORT_SILENT = "This port did not answer as the OG command port. Choose the FWOG main port named \"Board CDC\" (not \"binary events\").";

export class ConsoleSession {
  private readonly parser = new ConsoleParser();
  private readonly gestures = new ButtonGestures();
  private status: ConsoleStatus = "connecting";
  private product: string | null = null;
  private buttonsLive = false;
  private device: DisplayedDigest | null = null;
  private detail: string | null = null;
  private writing: Promise<void> = Promise.resolve();
  private writesStopped = false;
  private closing = false;
  private openedAtMs = 0;
  private pollSentAtMs: number | null = null;
  private lastPollMs = -Infinity;
  private inFlight: InFlight | null = null;
  private shownText: string | null = null;
  private lastWriteMs = -Infinity;
  private desired: DeviceScreen | null = null;
  private displayIntervalMs = MIN_DISPLAY_INTERVAL_MS;
  /** Set once identified: OG v024 MAIN (text line) or legacy v54 DISPLAY (images). */
  private mode: "ogfw" | "legacy" | null = null;
  private legacy: LegacyDriver | null = null;
  private lastLevels: string | null = null;
  private loading: { readonly done: number; readonly total: number } | null = null;
  private readonly transport: ConsoleTransport;
  private readonly options: SessionOptions;

  // Explicit fields, not parameter properties: Node's type stripping runs this file in tests.
  constructor(transport: ConsoleTransport, options: SessionOptions) {
    this.transport = transport;
    this.options = options;
  }

  snapshot(): ConsoleSnapshot {
    return { status: this.status, product: this.product, buttonsLive: this.buttonsLive, device: this.device, abortPrimed: this.gestures.abortPrimed(this.options.now()), detail: this.detail, display: this.displayMode(), loading: this.loading };
  }

  /** Open the port, start reading, and ask the port who it is. Nothing else is written until it answers. */
  async start(): Promise<void> {
    await this.transport.open({ baudRate: assertSafeBaudRate(CONSOLE_BAUD_RATE) });
    this.openedAtMs = this.options.now();
    this.setStatus("waiting", null);
    void this.readLoop();
    this.send({ kind: "identify" });
  }

  /** User disconnect: stop the button stream, clear the text overlay, return to the menu root, close. Best effort. */
  async close(): Promise<void> {
    if (this.closing) return;
    this.closing = true;
    if (this.status === "connected" && this.mode === "legacy") {
      this.sendLegacy({ kind: "button_events", intervalMs: 0 });
      this.sendLegacy({ kind: "clear_text" });
      this.sendLegacy({ kind: "reset" });
    } else if (this.status === "connected") {
      this.send({ kind: "button_events", intervalMs: 0 });
      // Leave no proposal on the device once it no longer speaks for the commander.
      this.send({ kind: "clear_text" });
      this.send({ kind: "reset" });
    }
    await withTimeout(this.writing, this.options.writeTimeoutMs ?? WRITE_TIMEOUT_MS);
    try { await this.transport.close(); } catch { /* already gone */ }
    this.lost("closed", null);
  }

  /** The screen the device should show now. */
  show(screen: DeviceScreen): void {
    this.desired = screen;
    if (this.legacy !== null && this.status === "connected") this.legacy.want({ text: screen.text, digest: screen.digest, image: screen.image ?? null });
    else this.pump();
  }

  /** Static screens to install ahead of need (legacy image firmware only). */
  preload(images: readonly DeviceImage[]): void {
    this.legacy?.preload(images);
  }

  /** Which display path this connection uses, once identified. */
  displayMode(): "text" | "images" | null {
    if (this.mode === null) return null;
    return this.mode === "legacy" && this.legacy !== null && !this.legacy.imagesDisabled ? "images" : "text";
  }

  /** Call every ~50–100 ms: identify timeout, button polling, red-hold detection, display acknowledgement. */
  tick(): void {
    const now = this.options.now();
    if (this.status === "waiting" && now - this.openedAtMs > IDENTIFY_TIMEOUT_MS) {
      this.refuse("wrong_port", WRONG_PORT_SILENT);
      return;
    }
    if (this.status !== "connected") return;
    this.poll(now);
    for (const gesture of this.gestures.tick(now)) this.options.onGesture(gesture);
    if (this.legacy !== null) { this.legacy.tick(); return; }
    if (this.inFlight !== null && now - this.inFlight.sentAtMs > DISPLAY_ACK_TIMEOUT_MS) {
      this.inFlight = null;
      this.device = null;
      this.shownText = null;
      this.detail = "The console display did not confirm the last screen";
      this.changed();
    }
    this.pump();
  }

  /** Feed received bytes (exposed for tests; the read loop calls it). */
  receive(bytes: Uint8Array): void {
    for (const message of this.parser.push(bytes)) this.handle(message);
  }

  private poll(now: number): void {
    if (this.pollSentAtMs !== null && now - this.pollSentAtMs < POLL_TIMEOUT_MS) return;
    if (now - this.lastPollMs < POLL_MS) return;
    if (this.legacy?.busy === true) return;
    this.pollSentAtMs = now;
    this.lastPollMs = now;
    if (this.mode === "legacy") this.sendLegacy({ kind: "read_buttons" });
    else this.send({ kind: "read_buttons" });
  }

  private handle(message: ConsoleMessage): void {
    if (message.type === "line") return this.banner(message.banner);
    if (message.type === "identity") return this.identified(message.product);
    if (this.status !== "connected") return;
    if (this.legacy !== null && this.legacy.handle(message)) return;
    if (message.type === "buttons") return this.levels(message);
    if (message.type === "response" && message.command === "g\\p") this.acknowledged(message.ok);
  }

  private banner(banner: "wilidoro" | "ogfw_display" | null): void {
    if (this.status !== "waiting") return;
    if (banner === "ogfw_display") this.refuse("wrong_port", WRONG_PORT_DISPLAY);
    if (banner === "wilidoro") this.refuse("unsupported_firmware", "The board runs the WiLiDoro app, which accepts no host commands. Install the official FreeWili OG firmware (v023 or later).");
  }

  private identified(product: string): void {
    if (this.status !== "waiting") return;
    this.product = product;
    if (LEGACY_DISPLAY.test(product)) return this.startLegacy();
    if (LEGACY_MAIN.test(product)) return this.refuse("wrong_port", `This is the legacy firmware's MAIN CPU ("${product}"). Choose the DisplayCPU port instead.`);
    const match = OGFW_MAIN.exec(product);
    if (match === null) return this.refuse("wrong_port", `This port answered "${product}", not the OG firmware's MAIN CPU.`);
    if (Number(match[1]) < MIN_OGFW_VERSION) return this.refuse("unsupported_firmware", `${product} predates host button reads (v023). Install the current FreeWili OG firmware.`);
    this.mode = "ogfw";
    this.setStatus("connected", null);
    this.send({ kind: "button_events", intervalMs: BUTTON_EVENT_INTERVAL_MS });
    this.poll(this.options.now());
    this.pump();
  }

  private startLegacy(): void {
    this.mode = "legacy";
    const host: LegacyHost = {
      now: () => this.options.now(),
      send: cmd => this.sendLegacy(cmd),
      sendRaw: bytes => this.sendBytes(bytes, RAW_WRITE_TIMEOUT_MS),
      expectRaw: (count, magic) => this.parser.expectRaw(count, magic),
      onShown: (digest, ok) => {
        this.device = ok && digest !== null ? noteDisplayed(this.device, digest, this.options.now()) : null;
        if (!ok) this.detail = "The console display refused the last screen";
        this.changed();
      },
      onStatus: detail => { this.detail = detail; this.changed(); },
      onProgress: (done, total) => { this.loading = { done, total }; this.changed(); },
    };
    this.legacy = new LegacyDriver(host);
    this.setStatus("connected", null);
    this.sendLegacy({ kind: "button_events", intervalMs: BUTTON_EVENT_INTERVAL_MS });
    this.poll(this.options.now());
    if (this.desired !== null) this.show(this.desired);
  }

  private levels(message: Extract<ConsoleMessage, { type: "buttons" }>): void {
    if (message.source === "poll") this.pollSentAtMs = null;
    if (!this.buttonsLive) { this.buttonsLive = true; this.changed(); }
    // On legacy firmware a button press also drives its own GUI: redraw our screen after any edge.
    const key = JSON.stringify(message.levels);
    if (this.legacy !== null && this.lastLevels !== null && key !== this.lastLevels) this.legacy.resync();
    this.lastLevels = key;
    // Responses and events share one sequence counter, so both are ordered by it.
    const gestures = this.gestures.update(message.levels, message.seq, this.options.now());
    for (const gesture of gestures) this.options.onGesture(gesture);
    if (gestures.length > 0) this.changed();
  }

  private acknowledged(ok: boolean): void {
    const sent = this.inFlight;
    if (sent === null) return;
    this.inFlight = null;
    if (this.options.now() - sent.sentAtMs > SLOW_ACK_MS) this.displayIntervalMs = SLOW_DISPLAY_INTERVAL_MS;
    if (ok) {
      this.shownText = sent.text;
      this.device = sent.digest === null ? null : noteDisplayed(this.device, sent.digest, this.options.now());
      this.detail = null;
    } else {
      this.shownText = null;
      this.device = null;
      this.detail = "The console display refused the last screen";
    }
    this.changed();
    this.pump();
  }

  /** This port cannot be the console: say why and never write to it again. */
  private refuse(status: "wrong_port" | "unsupported_firmware", detail: string): void {
    this.writesStopped = true;
    this.setStatus(status, detail);
  }

  private pump(): void {
    const screen = this.desired;
    if (screen === null || this.inFlight !== null || this.writesStopped || this.closing || this.status !== "connected") return;
    if (screen.text === this.shownText) return;
    const now = this.options.now();
    if (now - this.lastWriteMs < this.displayIntervalMs) return;
    const sameProposal = this.device !== null && this.device.digest === screen.digest;
    if (sameProposal && now - this.lastWriteMs < DISPLAY_REFRESH_MS) return;
    // A different proposal is going on screen: until the firmware confirms it, nothing is confirmed.
    if (!sameProposal && this.device !== null) { this.device = null; this.changed(); }
    this.inFlight = { text: screen.text, digest: screen.digest, sentAtMs: now };
    this.lastWriteMs = now;
    this.send({ kind: "show_text", text: screen.text });
  }

  private send(command: ConsoleCommand): void {
    if (this.writesStopped) return;
    this.sendBytes(encodeCommand(command));
  }

  private sendLegacy(command: LegacyCommand): void {
    if (this.writesStopped) return;
    this.sendBytes(encodeLegacy(command));
  }

  private sendBytes(bytes: Uint8Array, timeout?: number): void {
    if (this.writesStopped) return;
    const timeoutMs = timeout ?? this.options.writeTimeoutMs ?? WRITE_TIMEOUT_MS;
    this.writing = this.writing.then(async () => {
      if (this.writesStopped) return;
      const result = await withTimeout(this.transport.write(bytes).then(() => "ok" as const, () => "failed" as const), timeoutMs);
      if (result === "ok") return;
      this.writesStopped = true;
      if (!this.closing && result === "timeout") this.setStatus("not_reading", "The console stopped accepting data.");
    });
  }

  private async readLoop(): Promise<void> {
    try {
      for await (const chunk of this.transport.chunks()) this.receive(chunk);
      if (!this.closing) this.lost("disconnected", "Console disconnected");
    } catch (error) {
      if (!this.closing) this.lost("disconnected", `Console disconnected: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  private lost(status: ConsoleStatus, detail: string | null): void {
    this.gestures.reset();
    this.legacy = null;
    this.device = null;
    this.inFlight = null;
    this.desired = null;
    this.writesStopped = true;
    this.setStatus(status, detail);
  }

  private setStatus(status: ConsoleStatus, detail: string | null): void {
    if (this.status === "closed" || (this.status === "disconnected" && status !== "closed")) return;
    this.status = status;
    this.detail = detail;
    this.changed();
  }

  private changed(): void {
    this.options.onChange(this.snapshot());
  }
}
