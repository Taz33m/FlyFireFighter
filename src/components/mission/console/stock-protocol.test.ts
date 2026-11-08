/**
 * Free-WiLi OG serial protocol (official OG firmware v024): bytes → messages, and the write allowlist.
 *
 * Scope: parsing of the identify answer, button reads, button events and show-text acknowledgements RECORDED
 * from the connected board's MAIN "Board CDC" port on 2026-11-08, split across arbitrary chunk boundaries; the
 * display CPU and WiLiDoro heartbeats recorded from the same board; junk and overflow handling; and that every
 * encodable write is one of the allowed commands, with display text that cannot inject another command.
 * Frames with a button held are not recordings (nobody pressed a button during the probe).
 */
import assert from "node:assert/strict";
import { describe, test } from "node:test";
import type { ConsoleMessage } from "./stock-protocol.ts";
import { ConsoleParser, MAX_DISPLAY_TEXT, MAX_PENDING_CHARS, encodeCommand, parseFrame, sanitizeDisplayText } from "./stock-protocol.ts";

const bytes = (text: string) => new TextEncoder().encode(text);
const ascii = (data: Uint8Array) => String.fromCharCode(...data);

/** Recorded from /dev/cu.usbmodem11201 (display CPU, "FWOG display wilidoro 001") on 2026-11-08, before the reflash. */
const WILIDORO_HEARTBEAT = "[wilidoro] alive (panel=ok leds=ok audio=ok imu=ok) heap free=35200 max_used=28400 frag_pct=1\r\n";
/** Recorded from the display CPU port under OG firmware v024 (DISPLAY 020). */
const OGFW_DISPLAY_HEARTBEAT = "[ogfw_display] alive link=1 ioexp=1 lcd=1 sel=0 evq=0 drop=0\n";
/** Recorded from MAIN "Board CDC" (/dev/cu.usbmodem11101, "FWOG main ogfw 024"): answers to ?, g\u, g\o 100 and g\p. */
const REC_IDENTITY = "[? 0D93A5AC856884B8 1 FWOG main ogfw 024 1]\r\n";
const REC_READ_BUTTONS = "[g\\u 0D93A5B3B0BEC940 2 0 0 0 0 0 1]\r\n";
const REC_STREAM = "[g\\o 0D93A5BA44EB6438 3 Ok 1]\r\n[*button 0D93A5BA4AE84630 4 0 0 0 0 0 1]\r\n[*button 0D93A5BA8C7AF8B8 5 0 0 0 0 0 1]\r\n";
const REC_SHOW_TEXT_ACK = "[g\\p 0D93A5BB5320CAD8 8 Ok 1]\r\n";

function parseAll(chunks: readonly string[]): ConsoleMessage[] {
  const parser = new ConsoleParser();
  return chunks.flatMap(chunk => parser.push(bytes(chunk)));
}

describe("frame parsing", () => {
  test("a button event frame gives every button's level and the sequence number", () => {
    assert.deepEqual(parseFrame("[*button 0E027CA91437D2F5 7450 0 0 1 0 0 1]"), {
      type: "buttons", seq: 7450, source: "event", levels: { gray: false, yellow: false, green: true, blue: false, red: false },
    });
  });

  test("the read-all-buttons response is a poll of the same five levels", () => {
    assert.deepEqual(parseFrame("[g\\u 0E027CA91437D2F5 12 0 0 0 0 1 1]"), {
      type: "buttons", seq: 12, source: "poll", levels: { gray: false, yellow: false, green: false, blue: false, red: true },
    });
  });

  test("the show-text acknowledgement is a response frame for g\\p with its success flag", () => {
    assert.deepEqual(parseFrame("[g\\p 0DE8F442FBC41063 14 Ok 1]"), { type: "response", command: "g\\p", ok: true, response: "Ok", seq: 14 });
    assert.equal((parseFrame("[g\\p 0DE8F442FBC41063 15 Invalid 0]") as { ok: boolean }).ok, false);
  });

  test("malformed or failed button frames are not button levels", () => {
    for (const raw of ["[*button 0E02 1 0 0 0 0 1]", "[*button 0E02 1 0 0 G 0 0 1]", "[*button 0E02 1 0 0 1 0 0 0]", "[*button zz 1 0 0 1 0 0 1]", "[*button 0E02 -1 0 0 1 0 0 1]"]) {
      assert.equal(parseFrame(raw)?.type === "buttons", false, raw);
    }
  });

  test("other events are recognised and ignored", () => {
    assert.deepEqual(parseFrame("[*accel 0E00CC80AEF767E4 6166 1 2 3 1]"), { type: "event", name: "accel", seq: 6166 });
  });
});

describe("recorded v024 traffic", () => {
  test("identify, read buttons, stream and show-text answers parse as recorded", () => {
    const messages = parseAll([REC_IDENTITY, REC_READ_BUTTONS, REC_STREAM, REC_SHOW_TEXT_ACK]);
    const released = { gray: false, yellow: false, green: false, blue: false, red: false };
    assert.deepEqual(messages, [
      { type: "identity", product: "FWOG main ogfw 024", version: 24, seq: 1 },
      { type: "buttons", levels: released, seq: 2, source: "poll" },
      { type: "response", command: "g\\o", ok: true, response: "Ok", seq: 3 },
      { type: "buttons", levels: released, seq: 4, source: "event" },
      { type: "buttons", levels: released, seq: 5, source: "event" },
      { type: "response", command: "g\\p", ok: true, response: "Ok", seq: 8 },
    ]);
  });

  test("the display CPU's heartbeat is a banner line, not a frame", () => {
    assert.deepEqual(parseAll([OGFW_DISPLAY_HEARTBEAT]), [{ type: "line", text: OGFW_DISPLAY_HEARTBEAT.trim(), banner: "ogfw_display" }]);
  });
});

describe("incremental parser", () => {
  test("a frame split at every byte still parses once", () => {
    const frame = "[*button 0E027CA91437D2F5 7450 0 1 0 0 0 1]";
    const messages = parseAll([...frame]);
    assert.equal(messages.length, 1);
    assert.equal(messages[0].type, "buttons");
  });

  test("back-to-back frames without newlines, mixed with text lines", () => {
    const messages = parseAll(["Enter Letter: \r\n[g\\o 0E02 3 Ok 1][*button 0E02 4 0 0 0", " 0 0 1]\r\n[*button 0E02 5 1 0 0 0 0 1]"]);
    assert.deepEqual(messages.map(m => m.type), ["line", "response", "buttons", "buttons"]);
  });

  test("the recorded WiLiDoro heartbeat is a text line that identifies the firmware, not a frame", () => {
    const messages = parseAll([WILIDORO_HEARTBEAT.slice(0, 20), WILIDORO_HEARTBEAT.slice(20) + WILIDORO_HEARTBEAT]);
    assert.equal(messages.length, 2);
    for (const m of messages) assert.deepEqual(m.type === "line" && m.banner, "wilidoro");
  });

  test("a runaway partial frame is discarded instead of growing without bound", () => {
    const parser = new ConsoleParser();
    parser.push(bytes("[" + "x".repeat(MAX_PENDING_CHARS + 10)));
    const after = parser.push(bytes("\n[*button 0E02 9 0 0 0 0 0 1]"));
    assert.deepEqual(after.map(m => m.type), ["buttons"]);
  });
});

describe("write allowlist", () => {
  test("the only encodable commands are Ctrl-B, identify, button stream, read buttons, show and clear text", () => {
    assert.equal(ascii(encodeCommand({ kind: "reset" })), "\x02\n");
    assert.equal(ascii(encodeCommand({ kind: "identify" })), "\x02?\n");
    assert.equal(ascii(encodeCommand({ kind: "button_events", intervalMs: 50 })), "\x02g\\o 50\n");
    assert.equal(ascii(encodeCommand({ kind: "button_events", intervalMs: 0 })), "\x02g\\o 0\n");
    assert.equal(ascii(encodeCommand({ kind: "read_buttons" })), "\x02g\\u\n");
    assert.equal(ascii(encodeCommand({ kind: "show_text", text: "Hello" })), "\x02g\\p Hello\n");
    assert.equal(ascii(encodeCommand({ kind: "clear_text" })), "\x02g\\t\n");
  });

  test("the stream interval is clamped, never an arbitrary value", () => {
    assert.equal(ascii(encodeCommand({ kind: "button_events", intervalMs: 1 })), "\x02g\\o 20\n");
    assert.equal(ascii(encodeCommand({ kind: "button_events", intervalMs: 1e9 })), "\x02g\\o 1000\n");
    assert.equal(ascii(encodeCommand({ kind: "button_events", intervalMs: Number.NaN })), "\x02g\\o 0\n");
  });

  test("display text cannot inject another command (radio, IR, GPIO) through newlines, Ctrl-B or backslashes", () => {
    const hostile = "Spray\n\x02w\\r\\t file.sub\r\x02i\\a 1234\nz";
    const wire = ascii(encodeCommand({ kind: "show_text", text: hostile }));
    // One leading Ctrl-B, one terminating newline, one path separator (the show-text path's own), nothing else.
    assert.equal(wire.split("\x02").length - 1, 1);
    assert.equal(wire.split("\n").length - 1, 1);
    assert.equal(wire.split("\\").length - 1, 1);
    assert.ok(wire.startsWith("\x02g\\p ") && wire.endsWith("\n"));
    assert.equal(/[\x00-\x09\x0b-\x1f\x7f]/.test(wire.slice(1, -1)), false);
  });

  test("sanitised text is printable ASCII, bounded, and keeps the harness's meaning", () => {
    const text = sanitizeDisplayText("Debris region coverage: 82% … quality ≥ 0.50, 3–4 m, “inside”, 45°, café");
    assert.equal(text, "Debris region coverage: 82% ... quality >= 0.50, 3-4 m, \"inside\", 45 deg, cafe");
    assert.ok(sanitizeDisplayText("x".repeat(2000)).length <= MAX_DISPLAY_TEXT);
    assert.ok(/^[\x20-\x7e]*$/.test(sanitizeDisplayText("日本語\u0000\u202e")));
    assert.equal(sanitizeDisplayText("a\\b"), "a/b");
  });

  test("an empty text still sends a single printable character", () => {
    assert.equal(ascii(encodeCommand({ kind: "show_text", text: "\n\n" })), "\x02g\\p -\n");
  });
});
