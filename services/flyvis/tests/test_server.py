"""WebSocket service (flyfirefighter.neural/1) end to end over localhost.

Scope: flyvis_service.server.NeuralService served in-process on 127.0.0.1 (ephemeral
port) around the session's single network instance, driven by a websockets client.
Frames are synthetic 320x180 u8 test patterns (the rgb-front calibration size), not
camera or simulator data. Requires the cached weights.
"""

from __future__ import annotations

import asyncio
import json
import time

import numpy as np
import pytest
from websockets.asyncio.client import connect
from websockets.exceptions import ConnectionClosed, InvalidStatus

from flyvis_service import config, synthetic
from flyvis_service.server import MAX_MESSAGE_BYTES, PROTOCOL, NeuralService, open_server

W, H = 320, 180
FEATURE_TOLERANCE = 1e-6
FEATURE_KEYS = {"type", "runId", "seq", "tick", "frameId", "horizontalMotion", "expansion", "responses", "latencyMs"}


@pytest.fixture(scope="module")
def service(runtime):
    return NeuralService(runtime=runtime, manifest=json.loads(config.WEIGHTS_MANIFEST.read_text()))


def frames_u8(n: int, seed: int = 21):
    return [np.round(f * 255).astype(np.uint8) for f in synthetic.iter_random_scene(seed, n, H, W)]


def reset_message(run_id: str, **overrides):
    message = {
        "type": "reset", "protocol": PROTOCOL, "runId": run_id, "calibrationId": "rgb-front/v1",
        "width": W, "height": H, "horizontalFovDeg": 90.0, "dtS": 0.02,
    }
    message.update(overrides)
    return message


def header(run_id: str, seq: int, frame: np.ndarray, **overrides):
    message = {
        "type": "step", "runId": run_id, "seq": seq, "tick": 2 * seq, "frameId": f"{run_id}/f{seq}",
        "width": int(frame.shape[1]), "height": int(frame.shape[0]), "encoding": "u8",
    }
    message.update(overrides)
    return message


async def request(ws, message, payload: bytes | None = None):
    await ws.send(message if isinstance(message, str) else json.dumps(message))  # str: sent raw
    if payload is not None:
        await ws.send(payload)
    return json.loads(await ws.recv())


def client(url: str, **kwargs):
    return connect(url, compression=None, max_size=MAX_MESSAGE_BYTES, **kwargs)


def with_server(service: NeuralService, scenario):
    async def main():
        async with open_server(service, port=0) as server:
            port = server.sockets[0].getsockname()[1]
            return await scenario(f"ws://127.0.0.1:{port}")

    return asyncio.run(main())


async def run_frames(ws, run_id: str, frames):
    ready = await request(ws, reset_message(run_id))
    assert ready["type"] == "ready", ready
    return [await request(ws, header(run_id, i, f), f.tobytes()) for i, f in enumerate(frames)]


def direct_features(runtime, frames):
    """Reference: the adapter stepped directly with the service's u8 -> float conversion."""
    runtime.reset(first_frame_warmup=True)
    return [runtime.step(f.astype(np.float32) / 255.0) for f in frames]


def max_difference(reply, reference) -> float:
    diffs = [abs(a - b) for a, b in zip(reply["horizontalMotion"], reference["horizontal_motion"])]
    diffs.append(abs(reply["expansion"] - reference["expansion"]))
    for name, values in reference["responses"].items():
        diffs.extend(abs(a - b) for a, b in zip(reply["responses"][name], values))
    return max(diffs)


def without_latency(reply):
    return {k: v for k, v in reply.items() if k != "latencyMs"}


def test_ready_reports_manifest_model_and_locks_the_eye(service):
    manifest = json.loads(config.WEIGHTS_MANIFEST.read_text())

    async def scenario(url):
        async with client(url) as ws:
            return await request(ws, reset_message("run-ready"))

    ready = with_server(service, scenario)
    assert set(ready) == {"type", "protocol", "runId", "model", "eye", "warmupSteps"}
    assert (ready["type"], ready["protocol"], ready["runId"]) == ("ready", PROTOCOL, "run-ready")
    assert ready["model"] == {
        "name": manifest["network"]["name"],
        "checkpoint": manifest["network"]["checkpoint"],
        "checkpointSha256": manifest["network"]["checkpoint_sha256"],
        "upstreamCommit": manifest["upstream"]["commit"],
        "weightsLicenseStatus": manifest["license"]["status"],
    }
    assert ready["eye"] == {"extent": 15, "hexals": 721}
    assert ready["warmupSteps"] == 50
    lock = service.eye_lock
    print(f"\n[eye lock] {lock}")
    assert (lock["width"], lock["height"], lock["horizontalFovDeg"]) == (W, H, 90.0)
    assert (lock["squareCropPx"], lock["canvasPx"]) == (180, 417)


def test_features_equal_direct_adapter_stepping_including_first_frame_warmup(service, runtime):
    frames = frames_u8(25)

    async def scenario(url):
        async with client(url) as ws:
            return await run_frames(ws, "run-eq", frames)

    replies = with_server(service, scenario)
    reference = direct_features(runtime, frames)
    worst = 0.0
    for seq, (reply, expected) in enumerate(zip(replies, reference)):
        assert set(reply) == FEATURE_KEYS, reply
        assert (reply["type"], reply["runId"], reply["seq"], reply["tick"]) == ("features", "run-eq", seq, 2 * seq)
        assert reply["frameId"] == f"run-eq/f{seq}"
        worst = max(worst, max_difference(reply, expected))
    print(f"\n[service vs adapter] {len(frames)} frames incl. first-frame warm-up: max |diff| = {worst:.3g}; "
          f"latencyMs seq0 {replies[0]['latencyMs']:.1f}, seq1.. median {np.median([r['latencyMs'] for r in replies[1:]]):.2f}")
    assert worst <= FEATURE_TOLERANCE


def test_out_of_order_and_wrong_run_are_refused_without_advancing_state(service, runtime):
    frames = frames_u8(3)

    async def scenario(url):
        async with client(url) as ws:
            await request(ws, reset_message("run-a"))
            first = await request(ws, header("run-a", 0, frames[0]), frames[0].tobytes())
            skipped = await request(ws, header("run-a", 2, frames[1]), frames[1].tobytes())
            repeated = await request(ws, header("run-a", 0, frames[1]), frames[1].tobytes())
            other_run = await request(ws, header("run-b", 1, frames[1]), frames[1].tobytes())
            second = await request(ws, header("run-a", 1, frames[1]), frames[1].tobytes())
            return first, skipped, repeated, other_run, second

    first, skipped, repeated, other_run, second = with_server(service, scenario)
    assert first["type"] == "features"
    assert (skipped["type"], skipped["code"], skipped["runId"], skipped["seq"]) == ("error", "out_of_order", "run-a", 2)
    assert (repeated["code"], repeated["seq"]) == ("out_of_order", 0)
    assert (other_run["code"], other_run["runId"], other_run["seq"]) == ("wrong_run", "run-b", 1)
    reference = direct_features(runtime, frames[:2])
    assert second["seq"] == 1
    assert max_difference(second, reference[1]) <= FEATURE_TOLERANCE  # rejected steps changed nothing


def test_wrong_payload_length_is_bad_request_and_keeps_the_warmup_frame(service, runtime):
    frames = frames_u8(2)
    narrow = frames[0][:, :-1].copy()

    async def scenario(url):
        async with client(url) as ws:
            await request(ws, reset_message("run-len"))
            short = await request(ws, header("run-len", 0, frames[0]), frames[0].tobytes()[:-1])
            long = await request(ws, header("run-len", 0, frames[0]), frames[0].tobytes() + b"\x00")
            wrong_dims = await request(ws, header("run-len", 0, narrow), narrow.tobytes())
            ok = [await request(ws, header("run-len", i, f), f.tobytes()) for i, f in enumerate(frames)]
            return short, long, wrong_dims, ok

    short, long, wrong_dims, ok = with_server(service, scenario)
    for error in (short, long, wrong_dims):
        assert (error["type"], error["code"], error["runId"], error["seq"]) == ("error", "bad_request", "run-len", 0)
    reference = direct_features(runtime, frames)
    # The rejected first frames did not consume the run's first-frame warm-up.
    assert max(max_difference(r, e) for r, e in zip(ok, reference)) <= FEATURE_TOLERANCE


def test_reconnect_and_reset_reproduce_outputs_exactly(service):
    frames = frames_u8(15, seed=5)

    async def scenario(url):
        async with client(url) as ws:
            first = await run_frames(ws, "run-r", frames)
        async with client(url) as ws:  # new connection: the old run is gone
            stale = await request(ws, header("run-r", 15, frames[0]), frames[0].tobytes())
            second = await run_frames(ws, "run-r", frames)
        return first, stale, second

    first, stale, second = with_server(service, scenario)
    assert stale["code"] == "wrong_run"
    assert [without_latency(r) for r in second] == [without_latency(r) for r in first]


def test_second_client_is_refused_and_first_keeps_working(service):
    frame = frames_u8(1)[0]

    async def scenario(url):
        async with client(url) as first:
            await request(first, reset_message("run-1"))
            async with client(url) as second:
                refusal = json.loads(await second.recv())
                with pytest.raises(ConnectionClosed) as closed:
                    await second.recv()
            reply = await request(first, header("run-1", 0, frame), frame.tobytes())
        return refusal, closed.value.rcvd.code if closed.value.rcvd else None, reply

    refusal, close_code, reply = with_server(service, scenario)
    assert (refusal["type"], refusal["code"], refusal["runId"], refusal["seq"]) == ("error", "bad_request", None, None)
    assert "busy" in refusal["message"]
    assert close_code == 1013
    assert reply["type"] == "features"


def test_protocol_misuse_is_reported(service):
    frame = frames_u8(1)[0]

    async def scenario(url):
        async with client(url) as ws:
            results = {"step_before_reset": await request(ws, header("run-x", 0, frame), frame.tobytes())}
            await ws.send(frame.tobytes())
            results["binary_without_header"] = json.loads(await ws.recv())
            results["wrong_protocol"] = await request(ws, reset_message("run-x", protocol="flyfirefighter.neural/2"))
            results["unknown_field"] = await request(ws, reset_message("run-x", motionCommand={"forward": 9}))
            results["wrong_dt"] = await request(ws, reset_message("run-x", dtS=0.01))
            results["unknown_type"] = await request(ws, {"type": "command", "runId": "run-x"})
            results["not_json"] = await request(ws, "{not json")
            await request(ws, reset_message("run-x"))
            await ws.send(json.dumps(header("run-x", 0, frame)))
            await ws.send(json.dumps(reset_message("run-y")))  # text where the payload belongs
            results["missing_payload"] = json.loads(await ws.recv())
            results["reset_after_missing_payload"] = json.loads(await ws.recv())
            return results

    results = with_server(service, scenario)
    assert (results["step_before_reset"]["code"], results["step_before_reset"]["runId"]) == ("wrong_run", "run-x")
    for key in ("binary_without_header", "wrong_protocol", "unknown_field", "wrong_dt", "unknown_type", "not_json", "missing_payload"):
        assert (results[key]["type"], results[key]["code"]) == ("error", "bad_request"), (key, results[key])
    assert results["reset_after_missing_payload"]["type"] == "ready"


def test_browser_connections_must_come_from_the_app_origin(service):
    async def scenario(url):
        with pytest.raises(InvalidStatus) as refused:
            async with client(url, origin="http://evil.example"):
                pass
        async with client(url, origin="http://localhost:3200") as ws:
            ready = await request(ws, reset_message("run-origin"))
        return refused.value.response.status_code, ready

    status, ready = with_server(service, scenario)
    assert status == 403
    assert ready["type"] == "ready"


def test_round_trip_latency_320x180_over_localhost(service):
    """Measured, not asserted: client-observed round trip per step, in-process server."""
    warm, timed = 50, 300
    frames = frames_u8(warm + timed, seed=9)

    async def scenario(url):
        async with client(url) as ws:
            await request(ws, reset_message("run-lat"))
            round_trips, service_ms, seqs = [], [], []
            for i, f in enumerate(frames):
                t = time.perf_counter()
                reply = await request(ws, header("run-lat", i, f), f.tobytes())
                round_trips.append(1e3 * (time.perf_counter() - t))
                service_ms.append(reply["latencyMs"])
                seqs.append(reply["seq"])
            return round_trips, service_ms, seqs

    round_trips, service_ms, seqs = with_server(service, scenario)
    assert seqs == list(range(warm + timed))
    rt = np.asarray(round_trips[warm:])
    sv = np.asarray(service_ms[warm:])
    print(f"\n[latency] 320x180 u8, {timed} steps after {warm}: round trip median {np.median(rt):.2f} ms, "
          f"p99 {np.percentile(rt, 99):.2f} ms, max {rt.max():.2f} ms; service latencyMs median {np.median(sv):.2f} ms; "
          f"first step (warm-up) round trip {round_trips[0]:.1f} ms")
