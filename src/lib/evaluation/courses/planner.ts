/**
 * Truth-side grid planner over collider boxes, for the course TEACHER and for checking that a generated
 * course is solvable. It reads true colliders, so it lives in evaluation and is never given to a deployed
 * controller: the trained readout only ever sees the teacher's command labels (architecture §3).
 *
 * The plane is the flight band: boxes that overlap [flightZ − bandM, flightZ + bandM] become 2-D obstacles.
 * Clearance is the exact distance from each cell centre to the nearest obstacle rectangle. Cost-to-go from
 * the goal is an 8-connected Dijkstra over cells whose clearance is at least `minClearanceM`, with a step
 * cost that grows as clearance falls below `preferredClearanceM`, so paths keep away from walls where
 * there is room and still thread a doorway that is just wide enough.
 */
export interface PlanBox {
  readonly minX: number;
  readonly minY: number;
  readonly maxX: number;
  readonly maxY: number;
}

export interface GridBounds {
  readonly minX: number;
  readonly minY: number;
  readonly maxX: number;
  readonly maxY: number;
}

export interface PlannerConfig {
  readonly resolutionM: number;
  readonly minClearanceM: number;
  readonly preferredClearanceM: number;
  /** Extra cost per metre at zero clearance margin (relative to 1 for open space). */
  readonly clearancePenalty: number;
}

export const DEFAULT_PLANNER: PlannerConfig = Object.freeze({ resolutionM: 0.05, minClearanceM: 0.36, preferredClearanceM: 0.8, clearancePenalty: 3 });

export function boxesInBand(colliders: readonly { readonly min: { x: number; y: number; z: number }; readonly max: { x: number; y: number; z: number } }[], flightZ: number, bandM: number): PlanBox[] {
  return colliders.filter(c => c.max.z > flightZ - bandM && c.min.z < flightZ + bandM).map(c => ({ minX: c.min.x, minY: c.min.y, maxX: c.max.x, maxY: c.max.y }));
}

function rectDistance(b: PlanBox, x: number, y: number): number {
  const dx = Math.max(b.minX - x, 0, x - b.maxX);
  const dy = Math.max(b.minY - y, 0, y - b.maxY);
  return Math.hypot(dx, dy);
}

export class PlanGrid {
  readonly bounds: GridBounds;
  readonly config: PlannerConfig;
  readonly nx: number;
  readonly ny: number;
  readonly clearance: Float32Array;
  readonly boxes: readonly PlanBox[];
  private costToGo: Float64Array | null = null;
  private goalKey = "";

  constructor(bounds: GridBounds, boxes: readonly PlanBox[], config: PlannerConfig = DEFAULT_PLANNER) {
    this.bounds = bounds;
    this.config = config;
    this.boxes = boxes;
    this.nx = Math.max(1, Math.ceil((bounds.maxX - bounds.minX) / config.resolutionM));
    this.ny = Math.max(1, Math.ceil((bounds.maxY - bounds.minY) / config.resolutionM));
    this.clearance = new Float32Array(this.nx * this.ny);
    const near = boxes.filter(b => b.maxX > bounds.minX - 2 && b.minX < bounds.maxX + 2 && b.maxY > bounds.minY - 2 && b.minY < bounds.maxY + 2);
    for (let j = 0; j < this.ny; j++) {
      for (let i = 0; i < this.nx; i++) {
        const [x, y] = this.center(i, j);
        let best = Infinity;
        for (const b of near) {
          const d = rectDistance(b, x, y);
          if (d < best) best = d;
        }
        this.clearance[j * this.nx + i] = best;
      }
    }
  }

  center(i: number, j: number): [number, number] {
    const r = this.config.resolutionM;
    return [this.bounds.minX + (i + 0.5) * r, this.bounds.minY + (j + 0.5) * r];
  }

  cellOf(x: number, y: number): [number, number] | null {
    const i = Math.floor((x - this.bounds.minX) / this.config.resolutionM);
    const j = Math.floor((y - this.bounds.minY) / this.config.resolutionM);
    return i >= 0 && j >= 0 && i < this.nx && j < this.ny ? [i, j] : null;
  }

  /** Exact clearance at a point (distance to the nearest obstacle rectangle). */
  clearanceAt(x: number, y: number): number {
    let best = Infinity;
    for (const b of this.boxes) best = Math.min(best, rectDistance(b, x, y));
    return best;
  }

  free(index: number): boolean {
    return this.clearance[index] >= this.config.minClearanceM;
  }

  /** Cost-to-go field toward (gx, gy); cached per goal. Unreachable and blocked cells are Infinity. */
  field(gx: number, gy: number): Float64Array {
    const key = `${gx.toFixed(3)},${gy.toFixed(3)}`;
    if (this.costToGo && this.goalKey === key) return this.costToGo;
    const n = this.nx * this.ny;
    const cost = new Float64Array(n).fill(Infinity);
    const goal = this.cellOf(gx, gy);
    if (goal) {
      const start = goal[1] * this.nx + goal[0];
      cost[start] = 0;
      dijkstra(this, cost, start);
    }
    this.costToGo = cost;
    this.goalKey = key;
    return cost;
  }

  /** Step cost multiplier of a cell: 1 in open space, rising toward 1 + penalty at the minimum clearance. */
  stepWeight(index: number): number {
    const c = this.config;
    const margin = Math.max(0, c.preferredClearanceM - this.clearance[index]) / (c.preferredClearanceM - c.minClearanceM);
    return 1 + c.clearancePenalty * Math.min(1, margin);
  }
}

const NEIGHBOURS: readonly (readonly [number, number, number])[] = [
  [1, 0, 1], [-1, 0, 1], [0, 1, 1], [0, -1, 1], [1, 1, Math.SQRT2], [1, -1, Math.SQRT2], [-1, 1, Math.SQRT2], [-1, -1, Math.SQRT2],
];

function dijkstra(grid: PlanGrid, cost: Float64Array, start: number): void {
  const heap = new MinHeap();
  heap.push(start, 0);
  const r = grid.config.resolutionM;
  while (heap.size > 0) {
    const [index, value] = heap.pop();
    if (value > cost[index]) continue;
    const i = index % grid.nx;
    const j = (index - i) / grid.nx;
    for (const [di, dj, len] of NEIGHBOURS) {
      const ni = i + di;
      const nj = j + dj;
      if (ni < 0 || nj < 0 || ni >= grid.nx || nj >= grid.ny) continue;
      const next = nj * grid.nx + ni;
      if (!grid.free(next)) continue;
      const candidate = value + len * r * 0.5 * (grid.stepWeight(index) + grid.stepWeight(next));
      if (candidate < cost[next]) {
        cost[next] = candidate;
        heap.push(next, candidate);
      }
    }
  }
}

class MinHeap {
  private readonly keys: number[] = [];
  private readonly values: number[] = [];

  get size(): number {
    return this.keys.length;
  }

  push(key: number, value: number): void {
    this.keys.push(key);
    this.values.push(value);
    let at = this.keys.length - 1;
    while (at > 0) {
      const parent = (at - 1) >> 1;
      if (this.values[parent] <= this.values[at]) break;
      this.swap(at, parent);
      at = parent;
    }
  }

  pop(): [number, number] {
    const top: [number, number] = [this.keys[0], this.values[0]];
    const lastKey = this.keys.pop() as number;
    const lastValue = this.values.pop() as number;
    if (this.keys.length > 0) {
      this.keys[0] = lastKey;
      this.values[0] = lastValue;
      let at = 0;
      for (;;) {
        const l = 2 * at + 1;
        const rr = l + 1;
        let m = at;
        if (l < this.keys.length && this.values[l] < this.values[m]) m = l;
        if (rr < this.keys.length && this.values[rr] < this.values[m]) m = rr;
        if (m === at) break;
        this.swap(at, m);
        at = m;
      }
    }
    return top;
  }

  private swap(a: number, b: number): void {
    [this.keys[a], this.keys[b]] = [this.keys[b], this.keys[a]];
    [this.values[a], this.values[b]] = [this.values[b], this.values[a]];
  }
}

/** True when a collision-free path (at the planner's minimum clearance) joins the two points. */
export function reachable(grid: PlanGrid, from: { x: number; y: number }, to: { x: number; y: number }): boolean {
  const field = grid.field(to.x, to.y);
  const cell = grid.cellOf(from.x, from.y);
  return cell !== null && Number.isFinite(field[cell[1] * grid.nx + cell[0]]);
}

/**
 * Point `lookaheadM` along the steepest descent of the cost-to-go from (x, y). When (x, y) itself is blocked
 * or unreachable, the walk starts from the cheapest reachable cell within `searchM`; null when there is none.
 */
export function lookaheadPoint(grid: PlanGrid, field: Float64Array, x: number, y: number, lookaheadM: number, searchM = 0.8): { x: number; y: number; remainingM: number } | null {
  const cell = grid.cellOf(x, y);
  if (!cell) return null;
  const index0 = cell[1] * grid.nx + cell[0];
  let index = Number.isFinite(field[index0]) ? index0 : nearestReachable(grid, field, cell, searchM);
  if (index < 0) return null;
  const steps = Math.max(1, Math.round(lookaheadM / grid.config.resolutionM));
  for (let s = 0; s < steps; s++) {
    const next = steepestNeighbour(grid, field, index);
    if (next === index) break;
    index = next;
  }
  const i = index % grid.nx;
  const [px, py] = grid.center(i, (index - i) / grid.nx);
  return { x: px, y: py, remainingM: field[index] };
}

/** The cheapest reachable cell within searchM of `cell` (cost-to-go plus a distance penalty), or −1. */
function nearestReachable(grid: PlanGrid, field: Float64Array, cell: readonly [number, number], searchM: number): number {
  const reach = Math.ceil(searchM / grid.config.resolutionM);
  let best = Infinity;
  let index = -1;
  for (let dj = -reach; dj <= reach; dj++) {
    for (let di = -reach; di <= reach; di++) {
      const i = cell[0] + di;
      const j = cell[1] + dj;
      if (i < 0 || j < 0 || i >= grid.nx || j >= grid.ny) continue;
      const k = j * grid.nx + i;
      const value = field[k] + Math.hypot(di, dj) * grid.config.resolutionM * 4;
      if (value < best) [best, index] = [value, k];
    }
  }
  return index;
}

function steepestNeighbour(grid: PlanGrid, field: Float64Array, index: number): number {
  const i = index % grid.nx;
  const j = (index - i) / grid.nx;
  let next = index;
  for (const [di, dj] of NEIGHBOURS) {
    const ni = i + di;
    const nj = j + dj;
    if (ni < 0 || nj < 0 || ni >= grid.nx || nj >= grid.ny) continue;
    const k = nj * grid.nx + ni;
    if (field[k] < field[next]) next = k;
  }
  return next;
}
