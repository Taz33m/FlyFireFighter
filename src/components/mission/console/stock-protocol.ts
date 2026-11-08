/**
 * FREE-WILi OG serial protocol, as the official OG firmware v024 (MAIN 024 / DISPLAY 020) speaks it on MAIN's
 * "Board CDC" port. Pure and browser-safe.
 *
 * Source: probed on the connected board on 2026-11-08 (frames below are recordings), matching the shared-menu
 * wire format documented by the official OneWili host library (github.com/freewili/onewili, transport.py and
 * framing.py). Since v023 the OG firmware uses that shared menu; host commands go to MAIN, which reaches the
 * display CPU over its internal link. The display CPU's own port only prints a heartbeat.
 *
 * Wire format:
 * - command: Ctrl-B (reset to the menu root, quiet mode) + backslash path + optional argument + newline,
 *   e.g. `\x02g\u\n` (read all buttons) or `\x02g\p Hello\n` (show text).
 * - response frame: `[g\u 0D93A5B3B0BEC940 2 0 0 0 0 0 1]` = path, hex timestamp (ns), sequence, response…,
 *   success. The sequence counter is shared by responses and events.
 * - button event: `[*button 0D93A5BA4AE84630 4 0 0 0 0 0 1]` = the five levels gray yellow green blue red
 *   (OneWili owGUIButton order), then success. Levels, not presses: edges are ours to find.
 * - identity: `?` answers `[? 0D93A5AC856884B8 1 FWOG main ogfw 024 1]`.
 *
 * Writes are an allowlist. `encodeCommand` can produce only: Ctrl-B, identify (`?`), button stream (`g\o`),
 * read all buttons (`g\u`), show text (`g\p`) and clear the text overlay (`g\t`). There is no encoder for radio, IR, GPIO, LED, keypress
 * simulation, file, settings or firmware commands, and display text is sanitised to one line of printable ASCII
 * without backslashes, so harness text cannot carry a newline, Ctrl-B or path separator into another command.
 */

export interface ButtonLevels {
  readonly gray: boolean;
  readonly yellow: boolean;
  readonly green: boolean;
  readonly blue: boolean;
  readonly red: boolean;
}

export const BUTTON_NAMES = ["gray", "yellow", "green", "blue", "red"] as const;
export type ButtonName = (typeof BUTTON_NAMES)[number];

export type ConsoleMessage =
  /** A button event frame or a read-all-buttons response: every button's level. */
  | { readonly type: "buttons"; readonly levels: ButtonLevels; readonly seq: number; readonly source: "event" | "poll" }
  /** Any other standard response frame (e.g. the acknowledgement of a show-text command). */
  | { readonly type: "response"; readonly command: string; readonly ok: boolean; readonly response: string; readonly seq: number }
  /** An event frame we do not use (accelerometer, IR, battery…). Parsed so it is not mistaken for text. */
  | { readonly type: "event"; readonly name: string; readonly seq: number }
  /** The answer to `?`: the product string, e.g. "FWOG main ogfw 024", and its version number when present. */
  | { readonly type: "identity"; readonly product: string; readonly version: number | null; readonly seq: number }
  /** A plain text line: menu text, or another firmware's or CPU's banner. */
  | { readonly type: "line"; readonly text: string; readonly banner: "wilidoro" | "ogfw_display" | null }
  /** Raw file bytes requested with ConsoleParser.expectRaw (legacy readback). */
  | { readonly type: "raw"; readonly bytes: Uint8Array };

/** A partial frame or line longer than this is junk and is dropped. */
export const MAX_PENDING_CHARS = 1024;

const FRAME = /^\[(\*[A-Za-z0-9_]+|[A-Za-z0-9?](?:\\[A-Za-z0-9])*) ([0-9A-Fa-f]+) (\d+) (.+) ([01])\]$/;
// Stock OG v024 sends 0/1; legacy v54 answers read-all-buttons as hex bytes (SDK response_as_bytes).
const LEVELS = /^[0-9A-Fa-f]{1,2}( [0-9A-Fa-f]{1,2}){4}$/;
const WILIDORO = /^\[wilidoro\]/;
const OGFW_DISPLAY = /^\[ogfw_display\]/;

function levelsFrom(response: string): ButtonLevels | null {
  const text = response.trim();
  if (!LEVELS.test(text)) return null;
  const [gray, yellow, green, blue, red] = text.split(" ").map(v => parseInt(v, 16) !== 0);
  return { gray, yellow, green, blue, red };
}

/** Parse one complete `[...]` frame; null when it is not a well-formed stock frame. */
export function parseFrame(raw: string): ConsoleMessage | null {
  const match = FRAME.exec(raw.trim());
  if (match === null) return null;
  const [, kind, , seqText, response, success] = match;
  const seq = Number(seqText);
  if (!Number.isSafeInteger(seq)) return null;
  if (kind === "*button") {
    const levels = success === "1" ? levelsFrom(response) : null;
    return levels === null ? null : { type: "buttons", levels, seq, source: "event" };
  }
  if (kind.startsWith("*")) return { type: "event", name: kind.slice(1), seq };
  if (kind === "?" && success === "1") {
    const version = /v?(\d{2,3})$/.exec(response.trim());
    return { type: "identity", product: response.trim(), version: version === null ? null : Number(version[1]), seq };
  }
  if ((kind === "g\\u" || kind === "u") && success === "1") {
    const levels = levelsFrom(response);
    if (levels !== null) return { type: "buttons", levels, seq, source: "poll" };
  }
  return { type: "response", command: kind, ok: success === "1", response, seq };
}

function lineMessage(text: string): ConsoleMessage | null {
  // Drop control bytes (menu escape sequences) and surrounding whitespace.
  const clean = text.replace(/[\x00-\x08\x0b-\x1f\x7f]/g, "").trim();
  if (clean === "") return null;
  return { type: "line", text: clean, banner: WILIDORO.test(clean) ? "wilidoro" : OGFW_DISPLAY.test(clean) ? "ogfw_display" : null };
}

/**
 * Incremental parser: feed raw serial bytes as they arrive, get complete messages back. Frames need not end
 * with a newline; text lines do. Bounded: a runaway partial frame or line is discarded, never grown forever.
 */
export class ConsoleParser {
  private pending = "";
  /** Raw bytes still expected for a legacy readback, and those collected so far. */
  private rawWanted = 0;
  private rawMagic: string | null = null;
  private raw: number[] = [];

  /**
   * The next `count` bytes are file payload, not text. With `magic`, bytes before the payload's known first bytes
   * (a line ending after the handshake frame) are skipped, at most 4 of them.
   */
  expectRaw(count: number, magic: string | null = null): void {
    this.rawWanted = count;
    this.rawMagic = magic;
    this.raw = [];
  }

  push(bytes: Uint8Array): ConsoleMessage[] {
    // Byte-for-byte (true Latin-1), so raw file bytes survive the text buffer unchanged.
    for (let i = 0; i < bytes.length; i += 4096) this.pending += String.fromCharCode(...bytes.subarray(i, i + 4096));
    const out: ConsoleMessage[] = [];
    const raw = this.takeRaw();
    if (raw !== null) out.push(raw);
    for (;;) {
      const step = this.next();
      if (step === null) break;
      if (step.message !== null) out.push(step.message);
    }
    if (this.pending.length > MAX_PENDING_CHARS && this.rawWanted === 0) this.pending = "";
    return out;
  }

  private takeRaw(): ConsoleMessage | null {
    if (this.rawWanted === 0) return null;
    if (this.raw.length === 0 && this.rawMagic !== null) {
      const at = this.pending.indexOf(this.rawMagic);
      if (at === -1) return null;
      if (at > 4) { this.rawWanted = 0; return null; }
      this.pending = this.pending.slice(at);
      this.rawMagic = null;
    }
    const take = Math.min(this.rawWanted - this.raw.length, this.pending.length);
    for (let i = 0; i < take; i++) this.raw.push(this.pending.charCodeAt(i) & 0xff);
    this.pending = this.pending.slice(take);
    if (this.raw.length < this.rawWanted) return null;
    this.rawWanted = 0;
    return { type: "raw", bytes: Uint8Array.from(this.raw) };
  }

  /** Consume one item from the front of the buffer; null when more bytes are needed. */
  private next(): { readonly message: ConsoleMessage | null } | null {
    if (this.rawWanted > 0) return null;
    const open = this.pending.indexOf("[");
    const newline = this.pending.indexOf("\n");
    if (newline !== -1 && (open === -1 || newline < open)) return this.takeLine(newline);
    if (open === -1) return null;
    if (open > 0) {
      // Text before a frame start with no newline: keep it only if it is just whitespace.
      const before = this.pending.slice(0, open);
      this.pending = this.pending.slice(open);
      return { message: lineMessage(before) };
    }
    const close = this.pending.indexOf("]");
    if (close === -1) return null;
    const frame = parseFrame(this.pending.slice(0, close + 1));
    if (frame !== null) {
      this.pending = this.pending.slice(close + 1);
      return { message: frame };
    }
    // Not a stock frame (e.g. "[wilidoro] alive …"): it is a text line; wait for its newline.
    const end = this.pending.indexOf("\n");
    return end === -1 ? null : this.takeLine(end);
  }

  private takeLine(index: number): { readonly message: ConsoleMessage | null } {
    const text = this.pending.slice(0, index);
    this.pending = this.pending.slice(index + 1);
    return { message: lineMessage(text) };
  }
}

/* Writes. */

/** Longest display text sent in one command (a previous project used 450 characters on this board). */
export const MAX_DISPLAY_TEXT = 450;
/** Button event interval requested from the firmware, ms. */
export const BUTTON_EVENT_INTERVAL_MS = 50;

export type ConsoleCommand =
  /** Ctrl-B alone: back to the menu root, quiet mode. */
  | { readonly kind: "reset" }
  | { readonly kind: "identify" }
  | { readonly kind: "button_events"; readonly intervalMs: number }
  | { readonly kind: "read_buttons" }
  | { readonly kind: "show_text"; readonly text: string }
  /** Remove the text overlay (Reset Display), so a closed console leaves no stale proposal on the device. */
  | { readonly kind: "clear_text" };

/**
 * Printable ASCII only, one line, bounded. Non-ASCII becomes "?", every control byte and line break becomes a
 * space, so harness text can never smuggle a menu command onto the device.
 */
/** ASCII stand-ins for typographic characters the harness uses, by code point. */
const ASCII_FOR: ReadonlyMap<number, string> = new Map([
  [0x2026, "..."], [0x2013, "-"], [0x2014, "-"], [0x2018, "'"], [0x2019, "'"], [0x201c, '"'], [0x201d, '"'],
  [0x00b0, " deg"], [0x2265, ">="], [0x2264, "<="], [0x00d7, "x"],
  // A backslash separates menu path segments on the wire; keep it out of display text.
  [0x5c, "/"],
]);

export function sanitizeDisplayText(text: string, limit: number = MAX_DISPLAY_TEXT): string {
  let out = "";
  for (const ch of text.normalize("NFKD")) {
    const code = ch.codePointAt(0) ?? 0;
    if (code >= 0x300 && code <= 0x36f) continue; // combining accents left by NFKD
    const mapped = ASCII_FOR.get(code);
    if (mapped !== undefined) out += mapped;
    else out += code >= 0x20 && code <= 0x7e ? ch : code < 0x20 || code === 0x7f ? " " : "?";
  }
  return out.replace(/ {2,}/g, " ").trim().slice(0, limit);
}

const CTRL_B = "\x02";

function encodeText(cmd: ConsoleCommand): string {
  switch (cmd.kind) {
    case "reset": return `${CTRL_B}\n`;
    case "identify": return `${CTRL_B}?\n`;
    case "button_events": {
      const ms = cmd.intervalMs === 0 ? 0 : Math.min(1000, Math.max(20, Math.round(cmd.intervalMs)));
      return `${CTRL_B}g\\o ${Number.isFinite(ms) ? ms : 0}\n`;
    }
    case "read_buttons": return `${CTRL_B}g\\u\n`;
    case "show_text": return `${CTRL_B}g\\p ${sanitizeDisplayText(cmd.text) || "-"}\n`;
    case "clear_text": return `${CTRL_B}g\\t\n`;
  }
}

/** The bytes for one allowed command. The only way this module produces anything to write to the device. */
export function encodeCommand(cmd: ConsoleCommand): Uint8Array {
  const text = encodeText(cmd);
  const bytes = new Uint8Array(text.length);
  for (let i = 0; i < text.length; i++) bytes[i] = text.charCodeAt(i) & 0x7f;
  return bytes;
}

/* Legacy FREE-WILi firmware v54 (display CPU port), as the freewili 0.0.51 SDK drives it: multi-line menu commands
 * after Ctrl-B, and the raw file transfer of fw_serial.py send_file / get_file. Images are content-addressed
 * FF<6 hex>.FWI files in /images (8.3 names, as the firmware requires); nothing else on the filesystem is touched. */

/** Our image names: "FF" + 6 hex digits + ".FWI" (8.3). */
export const IMAGE_NAME = /^FF[0-9A-F]{6}\.FWI$/;
/** Payload chunk size for uploads (the SDK default; below 1024 the SDK saw firmware resets). */
export const UPLOAD_CHUNK = 32768;

export type LegacyCommand =
  | { readonly kind: "reset" }
  | { readonly kind: "identify" }
  | { readonly kind: "button_events"; readonly intervalMs: number }
  | { readonly kind: "read_buttons" }
  | { readonly kind: "show_text"; readonly text: string }
  | { readonly kind: "clear_text" }
  | { readonly kind: "show_image"; readonly name: string }
  | { readonly kind: "put_image"; readonly name: string; readonly size: number; readonly crc32: number }
  | { readonly kind: "get_image"; readonly name: string };

function imageName(name: string): string {
  if (!IMAGE_NAME.test(name)) throw new RangeError(`Refusing an image name outside the console's own set: ${name}`);
  return name;
}

function putHeader(name: string, size: number, crc: number): string {
  const sizeOk = Number.isSafeInteger(size) && size > 0 && size <= 1_000_000;
  const crcOk = Number.isSafeInteger(crc) && crc >= 0 && crc <= 0xffffffff;
  if (!sizeOk || !crcOk) throw new RangeError("Invalid upload size or checksum");
  return `x\nf\n/images/${imageName(name)} ${size} ${crc}\n`;
}

function legacyText(cmd: LegacyCommand): string {
  switch (cmd.kind) {
    case "reset": return `${CTRL_B}\n`;
    case "identify": return `${CTRL_B}?\n`;
    case "button_events": {
      const ms = cmd.intervalMs === 0 ? 0 : Math.min(1000, Math.max(20, Math.round(cmd.intervalMs)));
      return `g\no\n${Number.isFinite(ms) ? ms : 0}\n`;
    }
    case "read_buttons": return "g\nu\n";
    case "show_text": return `g\np\n${sanitizeDisplayText(cmd.text) || "-"}\n`;
    case "clear_text": return "g\nt\n";
    case "show_image": return `g\nl\n${imageName(cmd.name)}\n`;
    case "put_image": return putHeader(cmd.name, cmd.size, cmd.crc32);
    case "get_image": return `x\nu\n\\images\\${imageName(cmd.name)} \n`;
  }
}

/**
 * The bytes for one allowed legacy command (payload bytes of an accepted upload are written separately). Each menu
 * command starts with Ctrl-B, as the SDK sends before every call: legacy menus stay in the last submenu otherwise,
 * and the next command would be read in the wrong menu.
 */
export function encodeLegacy(cmd: LegacyCommand): Uint8Array {
  const text = cmd.kind === "reset" || cmd.kind === "identify" ? legacyText(cmd) : `${CTRL_B}\n${legacyText(cmd)}`;
  const bytes = new Uint8Array(text.length);
  for (let i = 0; i < text.length; i++) bytes[i] = text.charCodeAt(i) & 0x7f;
  return bytes;
}

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

/** zlib.crc32, as the SDK computes the upload checksum. */
export function crc32(bytes: Uint8Array): number {
  let c = 0xffffffff;
  for (const b of bytes) c = CRC_TABLE[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

/** Split an upload payload into the chunks the SDK writes. */
export function uploadChunks(bytes: Uint8Array, chunk: number = UPLOAD_CHUNK): Uint8Array[] {
  const out: Uint8Array[] = [];
  for (let i = 0; i < bytes.length; i += chunk) out.push(bytes.subarray(i, i + chunk));
  return out;
}
