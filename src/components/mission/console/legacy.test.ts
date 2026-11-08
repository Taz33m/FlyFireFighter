/**
 * Legacy FREE-WILi v54 image path (no hardware). Scope: the legacy command allowlist (only our FF??????.FWI names, no
 * newline injection), zlib-compatible CRC and the SDK's 32 KiB upload chunking; raw readback framing in the parser;
 * the driver's upload → readback → show sequence, refusing to show an image whose readback differs, giving up to text
 * after repeated failures, rate-limited shows, confirmation only for an acknowledged image; and the session choosing
 * the image path by identity ("DisplayCPU v54") and the text path for OG v024. Frame shapes follow fw_serial.py; they
 * are not recordings from a v54 board.
 */
import assert from "node:assert/strict";
import { describe, test } from "node:test";
import type { LegacyHost, LegacyScreen } from "./legacy-driver.ts";
import { LegacyDriver, MAX_FAILURES, SLOW_SHOW_INTERVAL_MS } from "./legacy-driver.ts";
import type { LegacyCommand } from "./stock-protocol.ts";
import { ConsoleParser, UPLOAD_CHUNK, crc32, encodeLegacy, uploadChunks } from "./stock-protocol.ts";
import type { ConsoleTransport } from "./session.ts";
import { ConsoleSession } from "./session.ts";

const ascii = (b: Uint8Array) => String.fromCharCode(...b);
const enc = (t: string) => Uint8Array.from(t, c => c.charCodeAt(0));

describe("legacy commands", () => {
  test("encode as the SDK's multi-line menu commands", () => {
    // Each starts with Ctrl-B (back to the menu root), as recorded working on the v54 board.
    assert.equal(ascii(encodeLegacy({ kind: "read_buttons" })), "\x02\ng\nu\n");
    assert.equal(ascii(encodeLegacy({ kind: "button_events", intervalMs: 50 })), "\x02\ng\no\n50\n");
    assert.equal(ascii(encodeLegacy({ kind: "show_image", name: "FF1A2B3C.FWI" })), "\x02\ng\nl\nFF1A2B3C.FWI\n");
    assert.equal(ascii(encodeLegacy({ kind: "put_image", name: "FF1A2B3C.FWI", size: 153624, crc32: 123 })), "\x02\nx\nf\n/images/FF1A2B3C.FWI 153624 123\n");
    assert.equal(ascii(encodeLegacy({ kind: "get_image", name: "FF1A2B3C.FWI" })), "\x02\nx\nu\n\\images\\FF1A2B3C.FWI \n");
  });

  test("refuse any file outside the console's own FF??????.FWI names, and keep text to one line", () => {
    for (const name of ["settings.txt", "../FF1A2B3C.FWI", "FF1A2B3C.FWI\nx", "L1234567.FWI", "ff1a2b3c.fwi"]) {
      assert.throws(() => encodeLegacy({ kind: "show_image", name }), RangeError, name);
      assert.throws(() => encodeLegacy({ kind: "put_image", name, size: 10, crc32: 1 }), RangeError, name);
    }
    const wire = ascii(encodeLegacy({ kind: "show_text", text: "a\nx\nr\nz" }));
    assert.equal(wire.split("\n").length - 1, 4);
  });

  test("crc32 matches zlib, and uploads are cut into the SDK's 32 KiB writes", () => {
    assert.equal(crc32(enc("123456789")), 0xcbf43926);
    const chunks = uploadChunks(new Uint8Array(153624));
    assert.deepEqual(chunks.map(c => c.length), [UPLOAD_CHUNK, UPLOAD_CHUNK, UPLOAD_CHUNK, UPLOAD_CHUNK, 153624 - 4 * UPLOAD_CHUNK]);
  });
});

describe("raw readback framing", () => {
  test("the parser hands over exactly the expected payload, skipping a line ending before the file magic", () => {
    const parser = new ConsoleParser();
    parser.push(enc("[x\\u 0D 5 RxFile 12 1]"));
    parser.expectRaw(12, "FW01IMG");
    const payload = "FW01IMG\0\x80\x9f\xff]";
    const messages = [...parser.push(enc(`\r\n${payload.slice(0, 5)}`)), ...parser.push(enc(`${payload.slice(5)}[u 0D 6 success 12 bytes 99 crc 1]`))];
    assert.equal(messages[0].type, "raw");
    assert.deepEqual(Array.from((messages[0] as { bytes: Uint8Array }).bytes), Array.from(enc(payload)));
    assert.equal(messages[1].type === "response" && messages[1].response, "success 12 bytes 99 crc");
  });
});

/** A host that records commands and lets the test answer. */
function driverHarness() {
  let now = 0;
  const sent: LegacyCommand[] = [];
  const raw: number[] = [];
  const shown: (string | null)[] = [];
  const status: string[] = [];
  const expected: number[] = [];
  const host: LegacyHost = {
    now: () => now, send: c => sent.push(c), sendRaw: b => raw.push(b.length), expectRaw: c => expected.push(c),
    onShown: digest => shown.push(digest), onStatus: s => status.push(s), onProgress: () => {},
  };
  const driver = new LegacyDriver(host);
  const frame = (command: string, response: string, ok = true) => driver.handle({ type: "response", command, ok, response, seq: 1 });
  return { driver, sent, raw, shown, status, expected, frame, at: (t: number) => { now = t; } };
}

const IMAGE = { name: "FF1A2B3C.FWI", bytes: Uint8Array.from([0x46, 0x57, 0x30, 0x31, 0x49, 0x4d, 0x47, 0, 1, 2, 3, 4]), verify: true };
const SCREEN: LegacyScreen = { text: "GLASS 12", digest: "d".repeat(64), image: IMAGE };

/** Run the whole upload and readback for IMAGE with well-behaved answers. */
/** Frame bodies as recorded on the v54 board (2026-11-08): Send File Now, success N bytes, RxFile N, success N bytes CRC crc. */
function install(h: ReturnType<typeof driverHarness>, readback = IMAGE.bytes) {
  h.frame("x\\f", "Send File Now");
  h.frame("x\\f", "success 12 bytes");
  h.frame("x\\u", "RxFile 12");
  h.driver.handle({ type: "raw", bytes: readback });
  h.frame("x\\u", `success 12 bytes ${crc32(IMAGE.bytes)} crc`);
}

describe("legacy driver", () => {
  test("upload, readback, then show by file name; the image confirms the proposal only once acknowledged", () => {
    const h = driverHarness();
    h.driver.want(SCREEN);
    // First the text fallback goes up (nothing shown yet), then the transfer starts after its acknowledgement.
    assert.deepEqual(h.sent[0], { kind: "show_text", text: "GLASS 12" });
    h.frame("g\\p", "Ok");
    // The text fallback names the decision and confirms it, like the v024 line.
    assert.deepEqual(h.shown, [SCREEN.digest]);
    assert.deepEqual(h.sent.slice(1), [{ kind: "button_events", intervalMs: 0 }, { kind: "put_image", name: IMAGE.name, size: 12, crc32: crc32(IMAGE.bytes) }]);
    install(h);
    assert.equal(h.raw.length, 1);
    assert.deepEqual(h.expected, [12]);
    h.at(1000); h.driver.tick();
    assert.deepEqual(h.sent.at(-1), { kind: "show_image", name: IMAGE.name });
    h.frame("g\\l", "Ok");
    assert.deepEqual(h.shown, [SCREEN.digest, SCREEN.digest]);
  });

  test("images without verify skip the readback; a second proposal of the same kind re-shows the template", () => {
    const h = driverHarness();
    const template = { ...IMAGE, verify: false };
    h.driver.want({ ...SCREEN, image: template });
    h.frame("g\\p", "Ok");
    h.frame("x\\f", "Send File Now");
    h.frame("x\\f", "success 12 bytes");
    assert.ok(!h.sent.some(c => c.kind === "get_image"));
    h.at(1000); h.driver.tick();
    h.frame("g\\l", "Ok");
    h.driver.want({ ...SCREEN, image: template, digest: "e".repeat(64) });
    h.at(2000); h.driver.tick();
    assert.equal(h.sent.filter(c => c.kind === "show_image").length, 2);
    h.frame("g\\l", "Ok");
    assert.equal(h.shown.at(-1), "e".repeat(64));
  });

  test("the connect-time set uploads in priority order: templates before the rest", () => {
    const h = driverHarness();
    h.driver.preload([{ ...IMAGE, name: "FF000001.FWI", priority: 2 }, { ...IMAGE, name: "FF000002.FWI", priority: 0 }]);
    assert.deepEqual(h.sent.find(c => c.kind === "put_image"), { kind: "put_image", name: "FF000002.FWI", size: 12, crc32: crc32(IMAGE.bytes) });
  });

  test("a readback that differs from the upload is never shown", () => {
    const h = driverHarness();
    h.driver.want(SCREEN);
    h.frame("g\\p", "Ok");
    install(h, Uint8Array.from([...IMAGE.bytes.slice(0, 11), 9]));
    h.at(1000); h.driver.tick();
    assert.ok(!h.sent.some(c => c.kind === "show_image"));
    assert.match(h.status.at(-1) ?? "", /differs/);
  });

  test("after repeated failures the driver gives up on images and keeps showing text", () => {
    const h = driverHarness();
    for (let i = 0; i < MAX_FAILURES; i++) {
      h.driver.want({ ...SCREEN, image: { ...IMAGE, name: `FF00000${i}.FWI` } });
      h.frame("g\\p", "Ok");
      h.frame("x\\f", "Invalid", false);
      h.at((i + 1) * 2000); h.driver.tick();
    }
    assert.equal(h.driver.imagesDisabled, true);
    assert.match(h.status.at(-1) ?? "", /device shows text/);
  });

  test("a slow show acknowledgement slows shows to one per second", () => {
    const h = driverHarness();
    h.driver.want({ ...SCREEN, image: null, text: "A" });
    h.at(400); h.frame("g\\p", "Ok"); // 400 ms: slow
    h.driver.want({ ...SCREEN, image: null, text: "B" });
    h.at(SLOW_SHOW_INTERVAL_MS - 1); h.driver.tick();
    assert.equal(h.sent.filter(c => c.kind === "show_text").length, 1);
    h.at(SLOW_SHOW_INTERVAL_MS); h.driver.tick();
    assert.equal(h.sent.filter(c => c.kind === "show_text").length, 2);
  });
});

class FakePort implements ConsoleTransport {
  readonly writes: string[] = [];
  private queue: Uint8Array[] = [];
  private wake: (() => void) | null = null;
  async open() {}
  async *chunks() { for (;;) { while (this.queue.length > 0) yield this.queue.shift() as Uint8Array; await new Promise<void>(r => { this.wake = r; }); } }
  write(b: Uint8Array) { this.writes.push(ascii(b)); return Promise.resolve(); }
  async close() {}
  push(t: string) { this.queue.push(enc(t)); this.wake?.(); }
}
const flush = () => new Promise<void>(r => setTimeout(r, 0));

describe("session: image path by identity", () => {
  test("a legacy DisplayCPU answer selects images, with legacy button commands", async () => {
    const port = new FakePort();
    const session = new ConsoleSession(port, { now: () => 0, onGesture: () => {}, onChange: () => {} });
    await session.start();
    port.push("[? 0D 1 DisplayCPU v54 1]\r\n");
    await flush();
    assert.equal(session.snapshot().status, "connected");
    assert.equal(session.snapshot().display, "images");
    assert.ok(port.writes.includes("\x02\ng\no\n50\n") && port.writes.includes("\x02\ng\nu\n"));
  });

  test("the legacy MAIN CPU is refused; OG v024 MAIN keeps the text line", async () => {
    const main = new FakePort();
    const s1 = new ConsoleSession(main, { now: () => 0, onGesture: () => {}, onChange: () => {} });
    await s1.start();
    main.push("[? 0D 1 MainCPU v54 1]\r\n");
    await flush();
    assert.equal(s1.snapshot().status, "wrong_port");
    const og = new FakePort();
    const s2 = new ConsoleSession(og, { now: () => 0, onGesture: () => {}, onChange: () => {} });
    await s2.start();
    og.push("[? 0D 1 FWOG main ogfw 024 1]\r\n");
    await flush();
    assert.equal(s2.snapshot().display, "text");
  });
});
