/**
 * Command overlays in the simulation view. Presentation only: never rendered into the drone camera.
 *
 * From the truth-free MissionView: the pending action's affected region, the estimated aircraft position
 * with its one-sigma uncertainty ring, and route assessments (supported, unsupported, unknown). From the
 * privileged RenderSnapshot: the drone's true trail. Overlays draw through walls so command can see them.
 */
import type { Material } from "three";
import { BoxGeometry, BufferGeometry, ConeGeometry, DoubleSide, EdgesGeometry, Float32BufferAttribute, Group, Line, LineBasicMaterial, LineSegments, Mesh, MeshBasicMaterial, RingGeometry, SphereGeometry, Vector3, WireframeGeometry } from "three";
import type { Region } from "../contracts/geometry.ts";
import { regionBounds } from "../contracts/geometry.ts";
import type { MissionView, RenderSnapshot } from "../mission/protocol.ts";
import { disposeObject } from "./dispose.ts";

const toRender = (v: { x: number; y: number; z: number }, out = new Vector3()) => out.set(v.x, v.z, -v.y);
const UP = new Vector3(0, 1, 0);
const TRAIL_POINTS = 600;
const ROUTE_COLORS = { supported: 0xd2f484, unsupported: 0xff8070, unknown: 0xa3b1a6 } as const;

function overlayMaterial<T extends Material>(material: T): T {
  material.depthTest = false;
  material.transparent = true;
  return material;
}

/** Wireframe for a region: exact for spheres, sectors (as a cone) and boxes; bounds for prisms and unions. */
function regionWire(region: Region, material: LineBasicMaterial): LineSegments {
  if (region.kind === "sphere") {
    const wire = new LineSegments(new WireframeGeometry(new SphereGeometry(region.radiusM, 16, 10)), material);
    toRender(region.center, wire.position);
    return wire;
  }
  if (region.kind === "sector") {
    const radius = region.rangeM * Math.tan(region.halfAngleRad);
    // Cone apex at the sector apex, opening along the axis (ConeGeometry's apex is at +height/2).
    const geometry = new ConeGeometry(radius, region.rangeM, 24, 1, true).translate(0, -region.rangeM / 2, 0).rotateX(Math.PI);
    const wire = new LineSegments(new EdgesGeometry(geometry, 1), material);
    geometry.dispose();
    toRender(region.apex, wire.position);
    wire.quaternion.setFromUnitVectors(UP, toRender(region.axis).normalize());
    return wire;
  }
  const b = region.kind === "box" ? { min: region.min, max: region.max } : regionBounds(region);
  const size = new Vector3(b.max.x - b.min.x, b.max.z - b.min.z, b.max.y - b.min.y);
  const geometry = new BoxGeometry(Math.max(size.x, 0.01), Math.max(size.y, 0.01), Math.max(size.z, 0.01));
  const wire = new LineSegments(new EdgesGeometry(geometry), material);
  geometry.dispose();
  toRender({ x: (b.min.x + b.max.x) / 2, y: (b.min.y + b.max.y) / 2, z: (b.min.z + b.max.z) / 2 }, wire.position);
  return wire;
}

function pendingRegion(view: MissionView): Region | null {
  const pending = view.pendingApproval;
  return pending === null ? null : view.affectedRegions.find(r => r.proposalId === pending.proposal.id)?.region ?? null;
}

export class BeliefOverlays {
  readonly object = new Group();
  private readonly dynamic = new Group();
  private readonly regionMaterial = overlayMaterial(new LineBasicMaterial({ color: 0xffa25c, opacity: 0.9 }));
  private readonly ringMaterial = overlayMaterial(new MeshBasicMaterial({ color: 0xd2f484, opacity: 0.55, side: DoubleSide }));
  private readonly routeMaterials = {
    supported: overlayMaterial(new LineBasicMaterial({ color: ROUTE_COLORS.supported, opacity: 0.95 })),
    unsupported: overlayMaterial(new LineBasicMaterial({ color: ROUTE_COLORS.unsupported, opacity: 0.95 })),
    unknown: overlayMaterial(new LineBasicMaterial({ color: ROUTE_COLORS.unknown, opacity: 0.8 })),
  };
  private readonly trailMaterial = overlayMaterial(new LineBasicMaterial({ color: 0xeef3e9, opacity: 0.45 }));
  private readonly trailGeometry = new BufferGeometry();
  private readonly trailPositions = new Float32Array(TRAIL_POINTS * 3);
  private trailCount = 0;
  private readonly last = new Vector3(Number.NaN, 0, 0);
  private lastView: MissionView | null = null;
  private runId: string | null = null;

  constructor() {
    this.object.name = "command-overlays";
    this.object.renderOrder = 10;
    this.trailGeometry.setAttribute("position", new Float32BufferAttribute(this.trailPositions, 3));
    this.trailGeometry.setDrawRange(0, 0);
    const trail = new Line(this.trailGeometry, this.trailMaterial);
    trail.frustumCulled = false;
    this.object.add(trail, this.dynamic);
  }

  /** Rebuild view-derived overlays when the MissionView object changes. */
  setView(view: MissionView | null): void {
    if (view === this.lastView) return;
    this.lastView = view;
    if ((view?.runId ?? null) !== this.runId) this.clearTrail(view?.runId ?? null);
    for (const child of [...this.dynamic.children]) {
      child.removeFromParent();
      (child as Mesh).geometry?.dispose(); // Materials are shared and owned by this class.
    }
    if (view === null) return;
    const region = pendingRegion(view);
    if (region !== null) this.dynamic.add(regionWire(region, this.regionMaterial));
    this.addPoseRing(view);
    this.addRoutes(view);
  }

  private addPoseRing(view: MissionView): void {
    const pose = view.belief.pose;
    const ring = new Mesh(new RingGeometry(Math.max(0.05, pose.sigmaM * 0.85), Math.max(0.08, pose.sigmaM), 40).rotateX(-Math.PI / 2), this.ringMaterial);
    toRender(pose.position, ring.position);
    this.dynamic.add(ring);
  }

  private addRoutes(view: MissionView): void {
    for (const route of view.belief.routes) {
      if (route.waypoints.length < 2) continue;
      const points = route.waypoints.map(p => toRender(p).add(new Vector3(0, 0.15, 0)));
      this.dynamic.add(new Line(new BufferGeometry().setFromPoints(points), this.routeMaterials[route.status]));
    }
  }

  /** Append the drone's true position to its trail when it has moved more than 5 cm. */
  updateTrail(snapshot: RenderSnapshot | null): void {
    if (snapshot === null) return;
    const p = toRender(snapshot.drone.position);
    if (!Number.isNaN(this.last.x) && p.distanceTo(this.last) < 0.05) return;
    this.last.copy(p);
    if (this.trailCount === TRAIL_POINTS) this.trailPositions.copyWithin(0, 3);
    const index = Math.min(this.trailCount, TRAIL_POINTS - 1);
    this.trailPositions.set([p.x, p.y, p.z], index * 3);
    this.trailCount = Math.min(this.trailCount + 1, TRAIL_POINTS);
    this.trailGeometry.setDrawRange(0, this.trailCount);
    this.trailGeometry.attributes.position.needsUpdate = true;
  }

  private clearTrail(runId: string | null): void {
    this.runId = runId;
    this.trailCount = 0;
    this.last.set(Number.NaN, 0, 0);
    this.trailGeometry.setDrawRange(0, 0);
  }

  dispose(): void {
    disposeObject(this.object);
    for (const material of [this.regionMaterial, this.ringMaterial, this.trailMaterial, ...Object.values(this.routeMaterials)]) material.dispose();
  }
}
