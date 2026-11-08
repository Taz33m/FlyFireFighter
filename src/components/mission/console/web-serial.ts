/**
 * Web Serial adapter for the console session. Browser only (Chrome and Edge ship Web Serial; it needs a
 * secure context such as http://127.0.0.1 and a user gesture to choose the port).
 *
 * The chooser lists only the Free-WiLi OG MAIN CPU (Intrepid VID 0x093C, PID 0x2054). Under the official OG
 * firmware (v023+) MAIN is where host commands go; it reaches the buttons and screen over its link to the display
 * CPU. MAIN shows two serial ports, "Board CDC" (commands) and "FWOG binary events"; Web Serial cannot filter by
 * interface, so the session identifies the port with `?` before writing anything else (session.ts). MAIN also
 * carries the radios, IR and GPIO; the session's write allowlist cannot express any of their commands.
 * TypeScript's DOM library has no Web Serial types, so the small subset used here is declared locally.
 */
import type { ConsoleTransport } from "./session.ts";

export const FREEWILI_USB_VENDOR_ID = 0x093c;
export const FREEWILI_DISPLAY_PRODUCT_ID = 0x2055;
export const FREEWILI_MAIN_PRODUCT_ID = 0x2054;

export interface SerialPortInfoLike {
  readonly usbVendorId?: number;
  readonly usbProductId?: number;
}

export interface SerialPortLike {
  open(options: { readonly baudRate: number; readonly bufferSize?: number }): Promise<void>;
  close(): Promise<void>;
  getInfo(): SerialPortInfoLike;
  readonly readable: ReadableStream<Uint8Array> | null;
  readonly writable: WritableStream<Uint8Array> | null;
}

export interface SerialLike {
  requestPort(options?: { readonly filters: readonly SerialPortInfoLike[] }): Promise<SerialPortLike>;
}

export function webSerial(): SerialLike | null {
  if (typeof navigator === "undefined") return null;
  const serial = (navigator as Navigator & { readonly serial?: SerialLike }).serial;
  return serial ?? null;
}

/**
 * Ask the user to choose the console port: MAIN's "Board CDC" under OG firmware v024, or the DisplayCPU port under
 * the legacy FREE-WILi firmware (full-screen images). The session's identify step refuses any other port.
 */
export async function requestConsolePort(serial: SerialLike): Promise<SerialPortLike> {
  const port = await serial.requestPort({ filters: [FREEWILI_MAIN_PRODUCT_ID, FREEWILI_DISPLAY_PRODUCT_ID].map(usbProductId => ({ usbVendorId: FREEWILI_USB_VENDOR_ID, usbProductId })) });
  const info = port.getInfo();
  if (info.usbVendorId !== FREEWILI_USB_VENDOR_ID || (info.usbProductId !== FREEWILI_MAIN_PRODUCT_ID && info.usbProductId !== FREEWILI_DISPLAY_PRODUCT_ID)) {
    throw new Error("That port is not a Free-WiLi OG CPU.");
  }
  return port;
}

/**
 * Web Serial's default receive buffer is 255 bytes. A legacy readback streams a 153,624-byte screen at USB speed,
 * which overruns it: Chrome then fails the read with BufferOverrunError. The Node relay used for the hardware check
 * had a large OS buffer, so it never saw this. 1 MiB holds several whole screens.
 */
export const RECEIVE_BUFFER_BYTES = 1 << 20;

/** Read errors after which Web Serial keeps the port open and offers a fresh readable stream. */
const RECOVERABLE_READ_ERRORS = new Set(["BufferOverrunError", "BreakError", "FramingError", "ParityError"]);

export function webSerialTransport(port: SerialPortLike, onReadError?: (message: string) => void): ConsoleTransport {
  let reader: ReadableStreamDefaultReader<Uint8Array> | null = null;
  return {
    open: options => port.open({ ...options, bufferSize: RECEIVE_BUFFER_BYTES }),
    async *chunks() {
      while (port.readable !== null) {
        reader = port.readable.getReader();
        try {
          for (;;) {
            const { value, done } = await reader.read();
            if (done) return;
            if (value !== undefined) yield value;
          }
        } catch (error) {
          // A non-fatal error loses some bytes but not the port: report it and keep reading (a transfer in
          // progress then fails its own checks and is retried or falls back), instead of ending the session.
          const name = error instanceof DOMException ? error.name : "";
          if (!RECOVERABLE_READ_ERRORS.has(name)) throw error;
          onReadError?.(`${name} while reading`);
        } finally {
          reader.releaseLock();
          reader = null;
        }
      }
    },
    async write(bytes) {
      if (port.writable === null) throw new Error("The console port is not writable.");
      const writer = port.writable.getWriter();
      try {
        await writer.write(bytes);
      } finally {
        writer.releaseLock();
      }
    },
    async close() {
      try { await reader?.cancel(); } catch { /* already released */ }
      await port.close();
    },
  };
}
