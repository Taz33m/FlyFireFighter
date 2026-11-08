/**
 * Console session over a fake serial port (no hardware), speaking OG firmware v024's MAIN protocol. Scope: the
 * port opens at the host libraries' rate and never at 1200 baud; only the identify query is written until the
 * port proves it is OG MAIN v023+, and a display-CPU port, WiLiDoro, an old or foreign identity, or silence get
 * no further writes; after identification only allowlisted bytes are written, buttons are polled; connecting
 * with a button held and reconnecting produce no gesture; the display digest is confirmed only by the
 * acknowledgement of the write that carried it; a port that stops reading stops all writes; a disconnect resets
 * everything. The last test runs session + decide end to end. Identity and acknowledgement frames have the
 * exact shape recorded from the board; frames with a button held are synthetic.
 */
import assert from "node:assert/strict";
import { describe, test } from "node:test";
import type { ProposalRecord } from "../../../lib/contracts/actions.ts";
import type { MissionView } from "../../../lib/mission/protocol.ts";
import { APPROVAL_ARMING_MS, approveCommand, noteDisplayed } from "../approval.ts";
import type { Gesture } from "./buttons.ts";
import { DEBOUNCE_MS } from "./buttons.ts";
import { consoleCommanderId, decideGesture } from "./decide.ts";
import type { ConsoleTransport, DeviceScreen } from "./session.ts";
import { CONSOLE_BAUD_RATE, ConsoleSession, DISPLAY_ACK_TIMEOUT_MS, DISPLAY_REFRESH_MS, IDENTIFY_TIMEOUT_MS, MIN_DISPLAY_INTERVAL_MS, POLL_MS, SLOW_DISPLAY_INTERVAL_MS, assertSafeBaudRate } from "./session.ts";

const enc = (text: string) => new TextEncoder().encode(text);
const ascii = (data: Uint8Array) => String.fromCharCode(...data);
const flush = () => new Promise<void>(resolve => setTimeout(resolve, 0));

const IDENTIFY = "\x02?\n";
const STREAM_ON = "\x02g\\o 50\n";
const READ = "\x02g\\u\n";

/** In-memory port: records writes, delivers pushed chunks, can end (unplug) or hang writes (not reading). */
class FakePort implements ConsoleTransport {
  readonly writes: string[] = [];
  openedAt: number | null = null;
  closed = false;
  hangWrites = false;
  private queue: Uint8Array[] = [];
  private wake: (() => void) | null = null;
  private ended = false;

  async open(options: { readonly baudRate: number }) { this.openedAt = options.baudRate; }
  async *chunks() {
    for (;;) {
      while (this.queue.length > 0) yield this.queue.shift() as Uint8Array;
      if (this.ended) return;
      await new Promise<void>(resolve => { this.wake = resolve; });
    }
  }
  write(bytes: Uint8Array): Promise<void> {
    if (this.hangWrites) return new Promise(() => {});
    this.writes.push(ascii(bytes));
    return Promise.resolve();
  }
  async close() { this.closed = true; this.unplug(); }
  push(text: string) { this.queue.push(enc(text)); this.wake?.(); }
  unplug() { this.ended = true; this.wake?.(); }
}

let seq = 0;
const frame = (path: string, response: string, ok = 1) => `[${path} 0D93A5AC856884B8 ${++seq} ${response} ${ok}]\r\n`;
const identity = (product = "FWOG main ogfw 024") => frame("?", product);
const buttons = (g: number, y: number, r: number) => frame("*button", `0 ${y} ${g} 0 ${r}`);
const polled = (g: number, y: number, r: number) => frame("g\\u", `0 ${y} ${g} 0 ${r}`);
const ack = (ok = true) => frame("g\\p", ok ? "Ok" : "Invalid", ok ? 1 : 0);
const screen = (digest: string | null, text = `screen ${digest}`): DeviceScreen => ({ text, digest });

function harness(options: { writeTimeoutMs?: number } = {}) {
  const port = new FakePort();
  let now = 0;
  const gestures: Gesture[] = [];
  const session = new ConsoleSession(port, { now: () => now, onGesture: g => gestures.push(g), onChange: () => {}, ...options });
  const at = (t: number) => { now = t; };
  /** Deliver one chunk at clock time t and let the read loop process it. */
  const feed = async (t: number, text: string) => { now = t; port.push(text); await flush(); };
  return { port, session, gestures, at, feed };
}

/** A session that has opened and been identified as OG MAIN v024 at t = 0. */
async function identified(options: { writeTimeoutMs?: number } = {}) {
  const h = harness(options);
  await h.session.start();
  await h.feed(0, identity());
  return h;
}

describe("opening and identification", () => {
  test("opens at the host libraries' rate, never at the 1200-baud bootloader trigger", async () => {
    const { port, session } = harness();
    await session.start();
    assert.equal(port.openedAt, CONSOLE_BAUD_RATE);
    assert.throws(() => assertSafeBaudRate(1200), /bootloader/);
    assert.throws(() => assertSafeBaudRate(Number.NaN));
  });

  test("only the identify query is written before the port answers", async () => {
    const { port, session } = harness();
    await session.start();
    session.show(screen("d1"));
    session.tick();
    await flush();
    assert.deepEqual(port.writes, [IDENTIFY]);
  });

  test("once identified as OG MAIN v024: button stream on, then a button read", async () => {
    const { port, session } = await identified();
    await flush();
    assert.deepEqual(port.writes, [IDENTIFY, STREAM_ON, READ]);
    assert.equal(session.snapshot().status, "connected");
    assert.equal(session.snapshot().product, "FWOG main ogfw 024");
  });

  test("the display CPU's port, WiLiDoro, an old or foreign identity, or silence: refused, nothing more written", async () => {
    const cases: [string | null, string, RegExp][] = [
      ["[ogfw_display] alive link=1 ioexp=1 lcd=1 sel=0 evq=0 drop=0\n", "wrong_port", /display CPU/],
      ["[wilidoro] alive (panel=ok leds=ok audio=ok imu=ok) heap free=35200 max_used=28400 frag_pct=1\r\n", "unsupported_firmware", /WiLiDoro/],
      [identity("FWOG main ogfw 022"), "unsupported_firmware", /v023/],
      [identity("FWOG display ogfw 020"), "wrong_port", /not the OG firmware's MAIN/],
      [null, "wrong_port", /did not answer/],
    ];
    for (const [reply, status, detail] of cases) {
      const { port, session, at, feed } = harness();
      await session.start();
      if (reply !== null) await feed(10, reply);
      at(IDENTIFY_TIMEOUT_MS + 1); session.tick();
      assert.equal(session.snapshot().status, status, String(reply));
      assert.match(session.snapshot().detail ?? "", detail);
      session.show(screen("d1"));
      await feed(IDENTIFY_TIMEOUT_MS + 2, identity()); // a late answer does not revive a refused port
      assert.equal(session.snapshot().status, status);
      await session.close();
      assert.deepEqual(port.writes, [IDENTIFY], String(reply));
    }
  });

  test("the refusal says why", async () => {
    const { session, feed } = harness();
    await session.start();
    await feed(10, "[ogfw_display] alive link=1 ioexp=1 lcd=1 sel=0 evq=0 drop=0\n");
    assert.equal(session.snapshot().status, "wrong_port");
    assert.match(session.snapshot().detail ?? "", /Board CDC/);
  });
});

describe("buttons", () => {
  test("levels are polled every POLL_MS, one read in flight at a time", async () => {
    const { port, session, at, feed } = await identified();
    const reads = () => port.writes.filter(w => w === READ).length;
    at(POLL_MS - 1); session.tick(); await flush();
    assert.equal(reads(), 1);
    at(POLL_MS + 1); session.tick(); await flush();
    assert.equal(reads(), 1, "the first read is still unanswered");
    await feed(POLL_MS + 2, polled(0, 0, 0));
    at(POLL_MS * 2 + 2); session.tick(); await flush();
    assert.equal(reads(), 2);
  });

  test("connecting with green held, and repeated frames, approve nothing until a fresh press", async () => {
    const { session, gestures, feed } = await identified();
    await feed(0, polled(1, 0, 0)); // green already held at connect
    await feed(100, buttons(1, 0, 0) + polled(1, 0, 0));
    assert.deepEqual(gestures, []);
    await feed(200, polled(0, 0, 0));
    await feed(200 + DEBOUNCE_MS, polled(1, 0, 0));
    await feed(300, buttons(1, 0, 0));
    assert.deepEqual(gestures, [{ kind: "approve" }]);
    assert.equal(session.snapshot().buttonsLive, true);
  });

  test("polls and events share one sequence counter: an older frame arriving late is ignored", async () => {
    const { session, gestures, feed } = await identified();
    await feed(0, polled(0, 0, 0));
    const stale = `[*button 0D93A5AC856884B8 1 0 0 1 0 0 1]\r\n`; // seq 1 < current
    await feed(300, stale);
    assert.deepEqual(gestures, []);
    assert.equal(session.snapshot().buttonsLive, true);
  });

  test("a reconnect starts from a new baseline: a held button does not press", async () => {
    const first = await identified();
    await first.feed(0, polled(0, 0, 0));
    first.port.unplug();
    await flush();
    const second = await identified();
    await second.feed(10, polled(1, 0, 0));
    await second.feed(500, polled(1, 0, 0));
    assert.deepEqual(second.gestures, []);
  });

  test("holding red is detected by tick", async () => {
    const { session, gestures, at, feed } = await identified();
    await feed(0, polled(0, 0, 0));
    await feed(100, polled(0, 0, 1));
    at(1100); session.tick();
    assert.deepEqual(gestures, [{ kind: "abort_primed" }, { kind: "abort", via: "hold" }]);
  });
});

describe("display confirmation", () => {
  test("the device digest is confirmed only by the acknowledgement of the write that carried it", async () => {
    const { port, session, feed, at } = await identified();
    at(1000); session.show(screen("d1"));
    await flush();
    assert.equal(port.writes.at(-1), "\x02g\\p screen d1\n");
    assert.equal(session.snapshot().device, null);
    await feed(1100, ack());
    assert.deepEqual(session.snapshot().device, { digest: "d1", sinceMs: 1100 });
  });

  test("a new proposal clears the confirmation at once, before its own acknowledgement", async () => {
    const { session, feed, at } = await identified();
    session.show(screen("d1"));
    await feed(100, ack());
    assert.equal(session.snapshot().device?.digest, "d1");
    at(5000); session.show(screen("d2"));
    assert.equal(session.snapshot().device, null);
    await feed(5100, ack());
    assert.deepEqual(session.snapshot().device, { digest: "d2", sinceMs: 5100 });
  });

  test("a refused acknowledgement leaves the display unconfirmed", async () => {
    const { session, feed } = await identified();
    session.show(screen("d1"));
    await feed(100, ack(false));
    assert.equal(session.snapshot().device, null);
    assert.match(session.snapshot().detail ?? "", /refused/);
  });

  test("a missing acknowledgement times out and leaves the display unconfirmed", async () => {
    const { session, feed, at } = await identified();
    session.show(screen("d1"));
    at(DISPLAY_ACK_TIMEOUT_MS + 1); session.tick();
    assert.equal(session.snapshot().device, null);
    assert.match(session.snapshot().detail ?? "", /did not confirm/);
    // The timeout re-sent the screen; that retry is now the one write in flight, and its acknowledgement confirms afresh.
    await feed(DISPLAY_ACK_TIMEOUT_MS + 50, ack());
    assert.equal(session.snapshot().device?.sinceMs, DISPLAY_ACK_TIMEOUT_MS + 50);
  });

  test("countdown refreshes of the same proposal keep its first confirmation time and are rate limited", async () => {
    const { port, session, at, feed } = await identified();
    session.show(screen("d1", "W 12"));
    await feed(10, ack());
    at(500); session.show(screen("d1", "W 11"));
    await flush();
    const textWrites = () => port.writes.filter(w => w.startsWith("\x02g\\p ")).length;
    assert.equal(textWrites(), 1);
    at(DISPLAY_REFRESH_MS + 1); session.tick();
    await flush();
    assert.equal(textWrites(), 2);
    await feed(DISPLAY_REFRESH_MS + 20, ack());
    assert.deepEqual(session.snapshot().device, { digest: "d1", sinceMs: 10 });
  });
});

describe("display rate limit", () => {
  const textWrites = (writes: readonly string[]) => writes.filter(w => w.startsWith("\x02g\\p ")).length;

  test("at most five screen writes per second, even when the screen changes faster", async () => {
    const { port, session, at, feed } = await identified();
    for (let t = 0; t < 1000; t += 20) {
      at(t);
      session.show(screen(null, `S${t}`));
      session.tick();
      await feed(t + 1, ack()); // answered at once
    }
    assert.ok(textWrites(port.writes) <= Math.ceil(1000 / MIN_DISPLAY_INTERVAL_MS), String(textWrites(port.writes)));
    assert.ok(textWrites(port.writes) >= 4);
  });

  test("a slow acknowledgement drops the rate to one write per second for the connection", async () => {
    const { port, session, at, feed } = await identified();
    session.show(screen(null, "A"));
    await feed(300, ack()); // 300 ms: slow
    at(400); session.show(screen(null, "B")); session.tick(); await flush();
    assert.equal(textWrites(port.writes), 1);
    at(SLOW_DISPLAY_INTERVAL_MS - 1); session.tick(); await flush();
    assert.equal(textWrites(port.writes), 1);
    at(SLOW_DISPLAY_INTERVAL_MS); session.tick(); await flush();
    assert.equal(textWrites(port.writes), 2);
  });
});

describe("writes", () => {
  test("every byte written in a full session is one of the allowlisted commands", async () => {
    const { port, session, at, feed } = await identified();
    await feed(0, polled(0, 0, 0));
    session.show(screen("d1", "Spray\nhostile\x02w\\r"));
    await feed(50, ack());
    for (let t = 100; t <= 1000; t += 50) { at(t); session.tick(); await feed(t, polled(0, 0, 0)); }
    await session.close();
    const allowed = /^\x02(\?|g\\o \d+|g\\u|g\\t|g\\p [\x20-\x5b\x5d-\x7e]+)?\n$/;
    for (const write of port.writes) assert.match(write, allowed, JSON.stringify(write));
  });

  test("a port that stops accepting writes is reported, and writing stops instead of queueing", async () => {
    const h = harness({ writeTimeoutMs: 20 });
    h.port.hangWrites = true;
    await h.session.start();
    await new Promise(resolve => setTimeout(resolve, 60));
    assert.equal(h.session.snapshot().status, "not_reading");
  });
});

describe("disconnect", () => {
  test("unplugging reports a disconnect and forgets the confirmed display and button state", async () => {
    const { port, session, feed } = await identified();
    session.show(screen("d1"));
    await feed(10, ack());
    port.unplug();
    await flush();
    const snap = session.snapshot();
    assert.equal(snap.status, "disconnected");
    assert.equal(snap.device, null);
    assert.match(snap.detail ?? "", /Console disconnected/);
  });

  test("a user disconnect stops the button stream, clears the device text, returns to the menu root and closes", async () => {
    const { port, session } = await identified();
    await session.close();
    assert.deepEqual(port.writes.slice(-3), ["\x02g\\o 0\n", "\x02g\\t\n", "\x02\n"]);
    assert.equal(port.closed, true);
    assert.equal(session.snapshot().status, "closed");
  });
});

describe("end to end: session + decide", () => {
  test("green before the device confirms is refused; after confirmation and review it is the card's approve", async () => {
    const digest = "a".repeat(64);
    const record = { proposal: { id: "p-1", digest, action: { kind: "spray" } }, risk: "consequential", status: "awaiting_approval", approval: null, execution: null, findings: [], history: [] } as unknown as ProposalRecord;
    const view = { runId: "run-1", status: "running", tick: 900, config: { commanderId: "cmdr" } as MissionView["config"], pendingApproval: record } as const;
    const { session, gestures, feed } = await identified();
    const decide = (nowMs: number) => decideGesture(gestures.at(-1) as Gesture, { runId: "run-1", view, commanderId: "cmdr", screen: noteDisplayed(null, digest, 0), device: session.snapshot().device, decided: new Set(), dialogOpen: false, nowMs });

    await feed(0, polled(0, 0, 0));
    session.show(screen(digest));
    await feed(2000, polled(1, 0, 0));
    assert.equal(gestures.length, 1);
    assert.match(decide(2000).reason, /console display has not confirmed/);

    await feed(2050, ack());
    await feed(2100, polled(0, 0, 0));
    await feed(2200, polled(1, 0, 0));
    assert.match(decide(2200).reason, /Review delay/);
    await feed(2300, polled(0, 0, 0));
    await feed(2050 + APPROVAL_ARMING_MS, polled(1, 0, 0));
    assert.equal(gestures.length, 3);
    assert.deepEqual(decide(2050 + APPROVAL_ARMING_MS).command, { ...approveCommand(view, record), commanderId: consoleCommanderId("cmdr") });
  });
});
