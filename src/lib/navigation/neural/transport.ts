/**
 * Message channel between the mission worker and the FlyVis service. The client depends only on this
 * interface, so tests inject a fake (Node has no built-in WebSocket server) and the worker uses
 * `connectWebSocketTransport`, built on the global WebSocket.
 */
import { NeuralClientError } from "./errors.ts";
import { NEURAL_SERVICE_URL } from "./messages.ts";

/** A received message: JSON text, or binary data as an ArrayBuffer. */
export type NeuralWireMessage = string | ArrayBuffer;

export interface NeuralTransportEvents {
  readonly onMessage: (message: NeuralWireMessage) => void;
  readonly onClose: (event: { readonly code: number; readonly reason: string }) => void;
}

/** An open, ordered, message-framed duplex channel. */
export interface NeuralTransport {
  /** Send one text (JSON) or binary message. Throws if the channel is not open. */
  send(message: string | Uint8Array): void;
  /** Install the receiver. Called once; messages that arrived earlier are delivered first. */
  listen(events: NeuralTransportEvents): void;
  close(): void;
}

export interface WebSocketTransportOptions {
  readonly url?: string;
  readonly connectTimeoutMs?: number;
  /** Defaults to the global WebSocket (browsers, workers, Node ≥ 22). */
  readonly WebSocketImpl?: typeof WebSocket;
}

/** Open a WebSocket to the service (default ws://127.0.0.1:3201) with binaryType "arraybuffer". */
export function connectWebSocketTransport(options: WebSocketTransportOptions = {}): Promise<NeuralTransport> {
  const url = options.url ?? NEURAL_SERVICE_URL;
  const timeoutMs = options.connectTimeoutMs ?? 5000;
  const Impl = options.WebSocketImpl ?? globalThis.WebSocket;
  return new Promise((resolve, reject) => {
    const socket = new Impl(url);
    socket.binaryType = "arraybuffer";
    const transport = new WebSocketTransport(socket);
    const fail = (reason: string) => {
      clearTimeout(timer);
      socket.onopen = null;
      reject(new NeuralClientError("closed", `could not open ${url}: ${reason}`));
    };
    const timer = setTimeout(() => {
      fail(`no connection within ${timeoutMs} ms`);
      socket.close();
    }, timeoutMs);
    socket.onopen = () => {
      clearTimeout(timer);
      transport.onEarlyClose = null;
      resolve(transport);
    };
    socket.onerror = () => {
      if (socket.readyState !== socket.OPEN) fail("connection error");
    };
    transport.onEarlyClose = event => fail(`closed with code ${event.code}`);
  });
}

class WebSocketTransport implements NeuralTransport {
  readonly #socket: WebSocket;
  readonly #early: NeuralWireMessage[] = [];
  #events: NeuralTransportEvents | null = null;
  #closed: { readonly code: number; readonly reason: string } | null = null;
  /** Used by connectWebSocketTransport until the socket opens. */
  onEarlyClose: ((event: { readonly code: number; readonly reason: string }) => void) | null = null;

  constructor(socket: WebSocket) {
    this.#socket = socket;
    socket.onmessage = (event: MessageEvent<NeuralWireMessage>) => this.#receive(event.data);
    socket.onclose = (event: CloseEvent) => this.#close({ code: event.code, reason: event.reason });
  }

  send(message: string | Uint8Array): void {
    if (this.#socket.readyState !== this.#socket.OPEN) throw new NeuralClientError("closed", "WebSocket is not open");
    this.#socket.send(message);
  }

  listen(events: NeuralTransportEvents): void {
    if (this.#events !== null) throw new Error("transport already has a listener");
    this.#events = events;
    for (const message of this.#early.splice(0)) events.onMessage(message);
    if (this.#closed !== null) events.onClose(this.#closed);
  }

  close(): void {
    this.#socket.close(1000, "client closed");
  }

  #receive(message: NeuralWireMessage): void {
    if (this.#events === null) this.#early.push(message);
    else this.#events.onMessage(message);
  }

  #close(event: { readonly code: number; readonly reason: string }): void {
    this.#closed = event;
    this.onEarlyClose?.(event);
    this.onEarlyClose = null;
    this.#events?.onClose(event);
  }
}
