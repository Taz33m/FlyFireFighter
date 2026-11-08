"""Modular quad placeholder (fictional rescue drone), authored for this scene.

Body frame: X forward, Y left, Z up, origin at the body centre. All geometry fits
inside a 0.55 m diameter circle (rotor guards) and a 0.2 m tall envelope.
Dynamics come from the aircraft capability profile, not from this mesh.
"""

import math

SPAN_M, HEIGHT_M = 0.55, 0.20
CAMERA_POSITION_BODY = (0.135, 0.0, 0.01)
CAMERA_PITCH_RAD = 0.0          # level, forward-looking
CAMERA_HFOV_DEG = 90.0
MOTOR = 0.12                    # motor offset along X and Y (diagonal radius 0.170 m)
GUARD_R, PROP_R = 0.10, 0.09


def build_drone(spec, position, yaw):
    spec.empty("drone", "DRONE", position, (0.0, 0.0, yaw), props={
        "simKind": "aircraft", "bodyFrame": "X forward, Y left, Z up", "spanM": SPAN_M, "heightM": HEIGHT_M,
        "note": "Fictional modular placeholder; visual only."}, size=0.3)
    m = spec.mesh("drone-frame", "DRONE", {"simKind": "visual"}, parent="drone")
    m.box((-0.10, -0.06, -0.035), (0.10, 0.06, 0.035), "drone_body")
    m.box((-0.07, -0.045, 0.035), (0.06, 0.045, 0.05), "drone_accent", skip=("-z",))
    motors = [(MOTOR, MOTOR), (MOTOR, -MOTOR), (-MOTOR, -MOTOR), (-MOTOR, MOTOR)]
    for mx, my in motors:
        m.oriented_box((0.0, 0.0, 0.0), (mx, my, 0.0), 0.022, 0.016, "drone_arm")
        m.cylinder((mx, my), 0.018, 0.0, 0.036, "metal_dark", segments=10)
        segs = 12
        for k in range(segs):
            a0, a1 = 2 * math.pi * k / segs, 2 * math.pi * (k + 1) / segs
            p0 = (mx + GUARD_R * math.cos(a0), my + GUARD_R * math.sin(a0), 0.045)
            p1 = (mx + GUARD_R * math.cos(a1), my + GUARD_R * math.sin(a1), 0.045)
            m.oriented_box(p0, p1, 0.008, 0.012, "drone_accent")
    for sy in (-0.07, 0.07):
        m.oriented_box((-0.09, sy, -0.095), (0.09, sy, -0.095), 0.012, 0.012, "drone_arm")
        for sx in (-0.06, 0.06):
            m.box((sx - 0.005, sy - 0.005, -0.095), (sx + 0.005, sy + 0.005, -0.035), "drone_arm")
    m.cylinder_x((0.0, -0.06), 0.028, -0.07, 0.06, "drone_tank")          # water payload tank
    m.cylinder_x((0.0, -0.06), 0.008, 0.06, 0.12, "metal")                 # jet nozzle
    m.box((0.10, -0.025, -0.01), (0.125, 0.025, 0.03), "black")            # camera pod
    m.cylinder_x((0.0, 0.01), 0.011, 0.125, 0.135, "lens")
    g = spec.mesh("drone-guide-light", "DRONE", {"simKind": "visual", "role": "guide light"}, parent="drone")
    g.box((0.092, -0.04, -0.047), (0.104, 0.04, -0.035), "guide_light")
    for k, (mx, my) in enumerate(motors):
        p = spec.mesh("drone-prop-%d" % (k + 1), "DRONE", {"simKind": "visual", "role": "propeller"},
                      parent="drone", location=(mx, my, 0.04))
        p.oriented_box((-PROP_R, 0.0, 0.0), (PROP_R, 0.0, 0.0), 0.018, 0.004, "drone_arm")
        p.cylinder((0.0, 0.0), 0.01, -0.004, 0.006, "metal_dark", segments=8)
    spec.empty("drone-camera-mount", "DRONE", CAMERA_POSITION_BODY, (0.0, 0.0, 0.0), parent="drone", props={
        "simKind": "sensorMount", "sensor": "rgb_camera", "frame": "body: X forward, Y left, Z up",
        "pitchRad": CAMERA_PITCH_RAD, "horizontalFovDeg": CAMERA_HFOV_DEG}, size=0.05)
