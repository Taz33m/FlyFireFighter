/**
 * Calibrated drone camera for render_request → camera_frame.
 *
 * Renders the TRUE aircraft pose from the request with the locked calibration (rgb-front/v1: 320 × 180,
 * fx = fy = 160, cx = 159.5, cy = 89.5, mount pitched 10° down) into a fixed-size render target, reads it
 * back and converts it to display-encoded luminance with row 0 at the top. The projection comes from the
 * intrinsics, not from a field-of-view guess (see camera-math.ts, which is unit-tested against the
 * contracts' pinhole model).
 *
 * Colour management: the target is RGBA32F when EXT_color_buffer_float is available (otherwise RGBA8),
 * with 4× MSAA resolved on the GPU to approximate pixel-area integration. Three.js r186 renders non-XR
 * render targets in linear-sRGB working space without tone mapping, so readback is linear light;
 * luminance = Rec. 709 weights, then clamp((gain · L)^(1/gamma)) from the calibration exposure. No noise
 * is added here: the worker's sensor model owns noise. The caller must put the request's world snapshot
 * into the scene and hide presentation-only objects before calling capture().
 */
import type { Scene, WebGLRenderer } from "three";
import { FloatType, Matrix4, NearestFilter, PerspectiveCamera, RGBAFormat, UnsignedByteType, Vector3, WebGLRenderTarget } from "three";
import type { CameraCalibration } from "../contracts/camera.ts";
import { verticalFovDeg } from "../contracts/camera.ts";
import type { Pose } from "../contracts/frames.ts";
import type { CameraFrameMessage, RenderRequest } from "../mission/protocol.ts";
import { SENSOR_FAR_M, SENSOR_NEAR_M, luminanceFrameFromReadback, projectionFromIntrinsics, renderCameraPose } from "./camera-math.ts";
import { TEXTURE_SET_VERSION } from "./procedural-textures.ts";

/** Identity of the renderer that produced controller input frames, recorded with every frame. */
export const CAMERA_RENDERER = `three-glb/${TEXTURE_SET_VERSION}`;

export class DroneCamera {
  readonly calibration: CameraCalibration;
  readonly camera: PerspectiveCamera;
  readonly pixelFormat: "rgba32f" | "rgba8";
  private readonly target: WebGLRenderTarget;
  private readonly readback: Float32Array | Uint8Array;
  private readonly basis = new Matrix4();

  constructor(renderer: WebGLRenderer, calibration: CameraCalibration) {
    this.calibration = calibration;
    const { width, height } = calibration;
    const float = renderer.extensions.has("EXT_color_buffer_float");
    this.pixelFormat = float ? "rgba32f" : "rgba8";
    this.target = new WebGLRenderTarget(width, height, {
      type: float ? FloatType : UnsignedByteType,
      format: RGBAFormat,
      samples: 4,
      depthBuffer: true,
      minFilter: NearestFilter,
      magFilter: NearestFilter,
      generateMipmaps: false,
    });
    this.readback = float ? new Float32Array(width * height * 4) : new Uint8Array(width * height * 4);
    this.camera = new PerspectiveCamera(verticalFovDeg(calibration), width / height, SENSOR_NEAR_M, SENSOR_FAR_M);
    this.applyIntrinsics(this.camera);
  }

  /** Replace a camera's projection with the calibrated pinhole projection (also used for the preview). */
  applyIntrinsics(camera: PerspectiveCamera): void {
    camera.projectionMatrix.fromArray(projectionFromIntrinsics(this.calibration));
    camera.projectionMatrixInverse.copy(camera.projectionMatrix).invert();
  }

  /** Place a camera at the calibrated mount for a true aircraft pose. */
  placeAt(camera: PerspectiveCamera, pose: Pose): void {
    const p = renderCameraPose(this.calibration, pose);
    camera.position.set(p.position.x, p.position.y, p.position.z);
    this.basis.makeBasis(new Vector3(p.right.x, p.right.y, p.right.z), new Vector3(p.up.x, p.up.y, p.up.z), new Vector3(p.back.x, p.back.y, p.back.z));
    camera.quaternion.setFromRotationMatrix(this.basis);
    camera.updateMatrixWorld(true);
  }

  capture(renderer: WebGLRenderer, scene: Scene, request: RenderRequest): CameraFrameMessage {
    if (request.calibrationId !== this.calibration.id) {
      throw new Error(`render request asks for calibration ${request.calibrationId}, but the locked camera is ${this.calibration.id}`);
    }
    const { width, height } = this.calibration;
    this.placeAt(this.camera, request.pose);
    const previous = renderer.getRenderTarget();
    try {
      renderer.setRenderTarget(this.target);
      renderer.render(scene, this.camera);
      renderer.readRenderTargetPixels(this.target, 0, 0, width, height, this.readback);
    } finally {
      renderer.setRenderTarget(previous);
    }
    const luminance = luminanceFrameFromReadback(this.readback, width, height, this.calibration.exposure);
    return { type: "camera_frame", runId: request.runId, tick: request.tick, frameId: request.frameId, calibrationId: this.calibration.id, width, height, renderer: CAMERA_RENDERER, luminance };
  }

  dispose(): void {
    this.target.dispose();
  }
}
