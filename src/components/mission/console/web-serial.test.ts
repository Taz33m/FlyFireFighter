/**
 * Web Serial transport. Scope: the port is opened with a receive buffer large enough for a whole legacy readback
 * (the 255-byte default overruns on a 153,624-byte screen), and a recoverable read error (BufferOverrunError) is
 * reported and reading continues on the fresh stream instead of ending the session; a fatal error still ends it.
 */
import assert from "node:assert/strict";
import { describe, test } from "node:test";
import type { SerialPortLike } from "./web-serial.ts";
import { RECEIVE_BUFFER_BYTES, webSerialTransport } from "./web-serial.ts";

function streamOf(chunks: readonly Uint8Array[], error: Error | null): ReadableStream<Uint8Array> {
  // Chunks are delivered one per read, then the stream errors (as Chrome does after an overrun) or closes.
  const queue = [...chunks];
  return new ReadableStream<Uint8Array>({
    pull(controller) {
      const next = queue.shift();
      if (next !== undefined) controller.enqueue(next);
      else if (error !== null) controller.error(error);
      else controller.close();
    },
  }, { highWaterMark: 0 });
}

function fakePort(streams: ReadableStream<Uint8Array>[]): SerialPortLike & { opened: unknown } {
  const port = {
    opened: null as unknown,
    async open(options: unknown) { port.opened = options; },
    async close() {},
    getInfo: () => ({}),
    get readable() { return streams[0] ?? null; },
    writable: null,
  };
  return port;
}

async function collect(iterable: AsyncIterable<Uint8Array>): Promise<number[]> {
  const out: number[] = [];
  for await (const chunk of iterable) out.push(...chunk);
  return out;
}

describe("web serial transport", () => {
  test("opens with a receive buffer that holds a whole screen readback", async () => {
    const port = fakePort([]);
    await webSerialTransport(port).open({ baudRate: 1_000_000 });
    assert.deepEqual(port.opened, { baudRate: 1_000_000, bufferSize: RECEIVE_BUFFER_BYTES });
    assert.ok(RECEIVE_BUFFER_BYTES >= 153624 * 2);
  });

  test("a buffer overrun is reported and reading continues on the next stream", async () => {
    const streams = [streamOf([Uint8Array.of(1, 2)], new DOMException("overrun", "BufferOverrunError")), streamOf([Uint8Array.of(3)], null)];
    const port = fakePort(streams);
    const errors: string[] = [];
    const transport = webSerialTransport(port, message => { errors.push(message); streams.shift(); });
    const bytes = await collect(transport.chunks());
    assert.deepEqual(bytes, [1, 2, 3]);
    assert.deepEqual(errors, ["BufferOverrunError while reading"]);
  });

  test("a fatal read error (device lost) still ends the session", async () => {
    const port = fakePort([streamOf([], new DOMException("gone", "NetworkError"))]);
    await assert.rejects(collect(webSerialTransport(port).chunks()));
  });
});
