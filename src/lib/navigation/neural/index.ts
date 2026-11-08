/**
 * Worker-side client for the local FlyVis service (protocol flyfirefighter.neural/1). The service
 * (services/flyvis, `python -m flyvis_service.server`) runs the pinned pretrained network statefully
 * and returns named T4/T5 features; readouts that turn features into motion requests live elsewhere.
 */
export type { NeuralClientOptions, NeuralClientPhase, NeuralScheduler } from "./client.ts";
export { NEURAL_CLIENT_DEFAULTS, NeuralClient } from "./client.ts";
export type { NeuralClientErrorCode, NeuralClientErrorDetails } from "./errors.ts";
export { NeuralClientError, NeuralTimeoutError } from "./errors.ts";
export { horizontalFovDeg, NEURAL_ERROR_CODES, NEURAL_SERVICE_URL, parseNeuralError, parseNeuralReady, resetRequestFor } from "./messages.ts";
export type { NeuralTransport, NeuralTransportEvents, NeuralWireMessage, WebSocketTransportOptions } from "./transport.ts";
export { connectWebSocketTransport } from "./transport.ts";
