"""WebSocket service for protocol ``flyfirefighter.neural/1``.

The contract is ``src/lib/contracts/neural.ts``. Run from ``services/flyvis``::

    .venv/bin/python -m flyvis_service.server

Binds ``127.0.0.1:3201`` only. One network instance; one client at a time (a second
connection receives an ``error`` and is closed with code 1013; a client whose connection is
already closing no longer counts, so a client can reconnect at once). A run does not
survive its connection: after reconnecting, send ``reset``. Browser connections must
come from the app origin (``http://localhost:3200`` or ``http://127.0.0.1:3200``);
connections without an ``Origin`` header (local tools, tests) are accepted. This is a
local simulation service, not an authenticated endpoint.

Exchange
    ``reset`` -> ``ready``. The network is reinitialized and the eye mapping is locked to
    the reset's ``width``/``height``/``horizontalFovDeg``: every frame of the run must have
    exactly those dimensions; the central ``min(H, W)`` square is resized to BoxEye's
    417 px canvas (see ``eye.py``). The lock is logged and available as
    ``NeuralService.eye_lock``; the contract's ``ready`` has no field for it.

    ``step`` header (JSON text) followed by exactly one binary message of
    ``width * height`` bytes -> ``features``. Seq must be 0, 1, 2, ... per run. A header
    for another run (``wrong_run``), an unexpected seq (``out_of_order``), a payload of
    the wrong length or any malformed field (``bad_request``) is answered with ``error``
    after its payload is consumed, and the network state does not advance.

    Warm-up happens once per run, on the first step: that frame is held as a static
    stimulus for ``warmupSteps`` (50 = 1 s) Euler steps, which become the run's feature
    baseline, and is then integrated as seq 0. The first step therefore takes ~70 ms
    longer than the others.

Frame encoding
    Bytes are row-major from the top-left pixel (row 0 = top of the image; flipping, for
    example of WebGL ``readPixels`` output, is the client's job). Each byte ``b`` maps to
    luminance ``b / 255`` as float32. The camera's frame values are display-encoded
    luminance (``clamp((gain * L) ** (1 / gamma), 0, 1)``) quantized by the client's
    ``encodeLuminanceU8`` (``round(v * 255)``), so ``b / 255`` restores them to within
    half a quantization step; the networks were trained on PIL ``convert("L") / 255`` of
    sRGB images, i.e. display-encoded values on the same scale.

``latencyMs`` is service compute time from receipt of the binary payload until the
features are ready (decode, eye, network step, pooling); JSON encoding and socket I/O
are excluded.
"""

from __future__ import annotations

import argparse
import asyncio
import contextlib
import json
import logging
import math
import time
from dataclasses import dataclass
from typing import Any, AsyncIterator, Dict, Optional, Tuple

import numpy as np

from . import config

config.configure_flyvis_root()

PROTOCOL = "flyfirefighter.neural/1"
HOST = "127.0.0.1"
PORT = 3201
ALLOWED_ORIGINS = ("http://localhost:3200", "http://127.0.0.1:3200")
MAX_DIMENSION = 4096
MAX_PIXELS = 1 << 22
MAX_MESSAGE_BYTES = MAX_PIXELS + (1 << 16)
BUSY_CLOSE_CODE = 1013  # "try again later"

RESET_FIELDS = frozenset({"type", "protocol", "runId", "calibrationId", "width", "height", "horizontalFovDeg", "dtS"})
STEP_FIELDS = frozenset({"type", "runId", "seq", "tick", "frameId", "width", "height", "encoding"})

logger = logging.getLogger("flyvis_service.server")


class ProtocolError(Exception):
    """A request the service refuses; ``code`` is one of the contract's error codes."""

    def __init__(self, code: str, message: str):
        super().__init__(message)
        self.code = code
        self.message = message


def error_reply(code: str, message: str, run_id: Any = None, seq: Any = None) -> Dict[str, Any]:
    return {
        "type": "error",
        "runId": run_id if isinstance(run_id, str) and 1 <= len(run_id) <= 64 else None,
        "seq": seq if isinstance(seq, int) and not isinstance(seq, bool) else None,
        "code": code,
        "message": message[:500],
    }


def _check_fields(message: Dict[str, Any], fields: frozenset) -> None:
    unknown = sorted(set(message) - fields)
    missing = sorted(fields - set(message))
    if unknown or missing:
        raise ProtocolError("bad_request", f"unknown fields {unknown}, missing fields {missing}")


def _string(message: Dict[str, Any], key: str, max_length: int = 64) -> str:
    value = message[key]
    if not isinstance(value, str) or not 1 <= len(value) <= max_length:
        raise ProtocolError("bad_request", f"{key}: expected a string of 1..{max_length} characters")
    return value


def _integer(message: Dict[str, Any], key: str, low: int, high: int) -> int:
    value = message[key]
    if isinstance(value, bool) or not isinstance(value, int) or not low <= value <= high:
        raise ProtocolError("bad_request", f"{key}: expected an integer in [{low}, {high}]")
    return value


def _number(message: Dict[str, Any], key: str) -> float:
    value = message[key]
    if isinstance(value, bool) or not isinstance(value, (int, float)) or not math.isfinite(value):
        raise ProtocolError("bad_request", f"{key}: expected a finite number")
    return float(value)


@dataclass
class Run:
    run_id: str
    calibration_id: str
    width: int
    height: int
    horizontal_fov_deg: float
    next_seq: int = 0


@dataclass
class PendingStep:
    """A step header waiting for its binary payload; ``error`` is sent instead of stepping."""

    header: Dict[str, Any]
    error: Optional[Dict[str, Any]]


class NeuralService:
    """Protocol state machine around one :class:`StatefulFlyVis` (one client at a time)."""

    def __init__(self, runtime=None, manifest: Optional[Dict[str, Any]] = None, load_error: Optional[str] = None):
        self.runtime = runtime
        self.manifest = manifest
        self.load_error = load_error
        self.run: Optional[Run] = None
        self.eye_lock: Optional[Dict[str, Any]] = None
        self._client = None

    @classmethod
    def load(cls) -> "NeuralService":
        """Load the pinned network; on failure serve ``model_unavailable`` errors."""
        from .model import ChecksumMismatch, WeightsUnavailable, read_manifest
        from .stateful import StatefulFlyVis

        try:
            return cls(runtime=StatefulFlyVis(), manifest=read_manifest())
        except (WeightsUnavailable, ChecksumMismatch) as error:
            logger.error("model unavailable: %s", error)
            return cls(load_error=str(error))

    # -- connection ------------------------------------------------------------

    async def handler(self, connection) -> None:
        from websockets.protocol import State

        current = self._client
        if current is not None and current.state is State.OPEN:
            logger.warning("refusing a second client while one is connected")
            await connection.send(json.dumps(error_reply("bad_request", "service busy: one client at a time")))
            await connection.close(BUSY_CLOSE_CODE, "busy")
            return
        # A previous client that has started closing no longer holds the service: its handler
        # stops at its next message (see _serve), so a client can reconnect immediately.
        self._client = connection
        self.run = None  # a run does not survive its connection
        logger.info("client connected")
        try:
            await self._serve(connection)
        finally:
            if self._client is connection:
                self._client = None
                self.run = None
            logger.info("client disconnected")

    async def _serve(self, connection) -> None:
        pending: Optional[PendingStep] = None
        async for message in connection:
            if self._client is not connection:
                break  # superseded by a newer client after this one began closing
            received = time.perf_counter()
            replies, pending = self._dispatch(message, pending, received)
            for reply in replies:
                try:
                    text = json.dumps(reply, allow_nan=False)
                except ValueError:
                    text = json.dumps(error_reply("internal", "non-finite value in reply", reply.get("runId"), reply.get("seq")))
                await connection.send(text)

    def _dispatch(self, message, pending: Optional[PendingStep], received: float):
        """Return (replies, pending step) for one incoming message; never raises."""
        try:
            if isinstance(message, (bytes, bytearray, memoryview)):
                if pending is None:
                    return [error_reply("bad_request", "binary message without a step header")], None
                return [self._payload(pending, bytes(message), received)], None
            replies = [self._missing_payload(pending)] if pending is not None else []
            reply, pending = self._text(message)
            return replies + ([reply] if reply is not None else []), pending
        except Exception as error:  # report, never crash the connection
            logger.exception("unexpected error while handling a message")
            return [error_reply("internal", f"{type(error).__name__}: {error}")], None

    # -- messages ----------------------------------------------------------------

    def _text(self, text: str) -> Tuple[Optional[Dict[str, Any]], Optional[PendingStep]]:
        try:
            message = json.loads(text)
        except json.JSONDecodeError:
            return error_reply("bad_request", "message is not valid JSON"), None
        if not isinstance(message, dict):
            return error_reply("bad_request", "message must be a JSON object"), None
        kind = message.get("type")
        if kind == "reset":
            try:
                return self._reset(message), None
            except ProtocolError as error:
                return error_reply(error.code, error.message, message.get("runId")), None
        if kind == "step":
            return None, PendingStep(message, self._check_header(message))
        return error_reply("bad_request", f"unknown message type {str(kind)[:32]!r}", message.get("runId")), None

    def _reset(self, message: Dict[str, Any]) -> Dict[str, Any]:
        _check_fields(message, RESET_FIELDS)
        if message["protocol"] != PROTOCOL:
            raise ProtocolError("bad_request", f"protocol must be {PROTOCOL!r}")
        run_id = _string(message, "runId")
        calibration_id = _string(message, "calibrationId")
        width = _integer(message, "width", 2, MAX_DIMENSION)
        height = _integer(message, "height", 2, MAX_DIMENSION)
        hfov = _number(message, "horizontalFovDeg")
        dt_s = _number(message, "dtS")
        if width * height > MAX_PIXELS:
            raise ProtocolError("bad_request", f"width * height exceeds {MAX_PIXELS}")
        if not 0 < hfov < 180:
            raise ProtocolError("bad_request", "horizontalFovDeg must be in (0, 180)")
        if self.runtime is None:
            raise ProtocolError("model_unavailable", self.load_error or "model not loaded")
        if abs(dt_s - self.runtime.dt) > 1e-9:
            raise ProtocolError("bad_request", f"dtS must be {self.runtime.dt} (the service's integration step)")

        self.runtime.reset(first_frame_warmup=True)
        self.run = Run(run_id, calibration_id, width, height, hfov)
        geometry = self.runtime.eye.angular_extent_deg(height, width, hfov)
        self.eye_lock = {
            "width": width,
            "height": height,
            "horizontalFovDeg": hfov,
            "squareCropPx": geometry["square_crop_px"],
            "canvasPx": self.runtime.eye.canvas_px,
            "latticeSpanDeg": geometry["lattice_span_deg"],
            "centerColumnSpacingDeg": geometry["center_column_spacing_deg"],
        }
        logger.info("reset run=%s calibration=%s eye lock %s", run_id, calibration_id, self.eye_lock)
        return self._ready(run_id)

    def _ready(self, run_id: str) -> Dict[str, Any]:
        manifest = self.manifest
        return {
            "type": "ready",
            "protocol": PROTOCOL,
            "runId": run_id,
            "model": {
                "name": manifest["network"]["name"],
                "checkpoint": manifest["network"]["checkpoint"],
                "checkpointSha256": self.runtime.loaded.checkpoint_sha256,
                "upstreamCommit": manifest["upstream"]["commit"],
                "weightsLicenseStatus": manifest["license"]["status"],
            },
            "eye": {"extent": self.runtime.eye.extent, "hexals": self.runtime.eye.hexals},
            "warmupSteps": self.runtime.warmup_steps,
        }

    def _check_header(self, header: Dict[str, Any]) -> Optional[Dict[str, Any]]:
        """Validate a step header; return the error to send after its payload, if any."""
        run_id, seq = header.get("runId"), header.get("seq")
        try:
            if self.runtime is None:
                raise ProtocolError("model_unavailable", self.load_error or "model not loaded")
            _check_fields(header, STEP_FIELDS)
            _string(header, "runId")
            _integer(header, "seq", 0, 2**53 - 1)
            _integer(header, "tick", 0, 2**53 - 1)
            _string(header, "frameId", 128)
            if header["encoding"] != "u8":
                raise ProtocolError("bad_request", "encoding must be 'u8'")
            self._check_run(header)
        except ProtocolError as error:
            return error_reply(error.code, error.message, run_id, seq)
        return None

    def _check_run(self, header: Dict[str, Any]) -> None:
        run = self.run
        if run is None:
            raise ProtocolError("wrong_run", "no active run on this connection; send reset first")
        if header["runId"] != run.run_id:
            raise ProtocolError("wrong_run", f"active run is {run.run_id!r}")
        if header["seq"] != run.next_seq:
            raise ProtocolError("out_of_order", f"expected seq {run.next_seq}")
        if header["width"] != run.width or header["height"] != run.height:
            raise ProtocolError("bad_request", f"frame must be {run.width}x{run.height} as locked at reset")

    def _missing_payload(self, pending: PendingStep) -> Dict[str, Any]:
        return error_reply(
            "bad_request", "expected a binary payload after the step header",
            pending.header.get("runId"), pending.header.get("seq"),
        )

    def _payload(self, pending: PendingStep, payload: bytes, received: float) -> Dict[str, Any]:
        header = pending.header
        if pending.error is not None:
            return pending.error
        run = self.run
        if len(payload) != run.width * run.height:
            return error_reply(
                "bad_request", f"payload has {len(payload)} bytes, expected {run.width * run.height}",
                header["runId"], header["seq"],
            )
        frame = np.frombuffer(payload, dtype=np.uint8).reshape(run.height, run.width).astype(np.float32) / 255.0
        try:
            features = self.runtime.step(frame)
        except Exception as error:  # state is only replaced after a completed step
            logger.exception("step failed")
            return error_reply("internal", f"step failed: {type(error).__name__}: {error}", header["runId"], header["seq"])
        latency_ms = 1e3 * (time.perf_counter() - received)
        run.next_seq += 1
        return {
            "type": "features",
            "runId": run.run_id,
            "seq": header["seq"],
            "tick": header["tick"],
            "frameId": header["frameId"],
            "horizontalMotion": [float(x) for x in features["horizontal_motion"]],
            "expansion": float(features["expansion"]),
            "responses": {name: [float(x) for x in values] for name, values in features["responses"].items()},
            "latencyMs": latency_ms,
        }


@contextlib.asynccontextmanager
async def open_server(service: NeuralService, port: int = PORT) -> AsyncIterator[Any]:
    """Serve ``service`` on 127.0.0.1:``port`` (0 = any free port, for tests)."""
    from websockets.asyncio.server import serve

    async with serve(
        service.handler,
        HOST,
        port,
        origins=[*ALLOWED_ORIGINS, None],
        compression=None,
        max_size=MAX_MESSAGE_BYTES,
    ) as server:
        yield server


async def _serve_forever(service: NeuralService) -> None:
    async with open_server(service) as server:
        logger.info("flyfirefighter.neural/1 listening on ws://%s:%d", HOST, PORT)
        await server.serve_forever()


def main(argv=None) -> int:
    parser = argparse.ArgumentParser(description="FlyVis WebSocket service (flyfirefighter.neural/1) on 127.0.0.1:3201")
    parser.add_argument("--threads", type=int, default=4, help="torch CPU threads (max 4 on the shared Mac)")
    args = parser.parse_args(argv)
    if not 1 <= args.threads <= 4:
        parser.error("--threads must be 1..4")
    import torch

    torch.set_num_threads(args.threads)
    service = NeuralService.load()
    try:
        asyncio.run(_serve_forever(service))
    except KeyboardInterrupt:
        logger.info("stopped")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
