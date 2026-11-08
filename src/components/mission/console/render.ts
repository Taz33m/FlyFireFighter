/**
 * Draws a console ScreenSpec at 320 × 240 with Canvas 2D, in FlyFireFighter's visual language: the app's black
 * surfaces and ember accent (globals.css tokens), with the fly mark from the logo. Browser only; no runtime
 * imports, so the same file renders the scratch contact sheet.
 *
 * Layout follows the Free-WiLi OG: five buttons under the screen, gray · yellow · green · blue · red from left to
 * right, so each legend chip sits above its button. The legend is drawn only for the buttons that do something.
 * Rendering technique (a fixed 320 × 240 vocabulary of calm full-screen states with labels above the buttons) is
 * adapted from the author's LIFELINE ambient UI (MHacks, docs/wili-ambient-ui.md), redrawn for this product.
 */
import type { GateAction, ScreenSpec } from "./screens.ts";

export const SCREEN_W = 320;
export const SCREEN_H = 240;

/**
 * The app's tokens (src/app/globals.css): black surfaces, ember accent, warm alert. `warm` is --warm-panel (9% ember
 * over --panel), the pending action card's background. None is pure black, which .FWI treats as transparent.
 * `button` holds the physical buttons' colours, used only for the small tick that joins a chip to its button.
 */
export const CONSOLE_COLOURS = {
  bg: "#090909", panel: "#121212", raised: "#1c1c1c", line: "#303030", ink: "#f7f7f7", muted: "#a8a8a8",
  ember: "#ff6b35", emberInk: "#120905", emberSoft: "rgba(255,107,53,0.32)", warm: "#271a15", alert: "#ff946d", light: "#dedede",
  button: { yellow: "#f2c94c", green: "#3fbf5f", red: "#e2412f" },
} as const;
const C = CONSOLE_COLOURS;
const FONT = '"Avenir Next", Avenir, "Helvetica Neue", system-ui, sans-serif';
const MONO = 'ui-monospace, "SF Mono", Menlo, monospace';
/** Button columns (centre x) for gray, yellow, green, blue, red. */
const COLUMNS = [32, 96, 160, 224, 288] as const;

type Ctx = CanvasRenderingContext2D;

function font(ctx: Ctx, size: number, weight = 600, family = FONT): void {
  ctx.font = `${weight} ${size}px ${family}`;
}

/** Text clipped with an ellipsis to maxWidth. */
function fitted(ctx: Ctx, text: string, maxWidth: number): string {
  if (ctx.measureText(text).width <= maxWidth) return text;
  let out = text;
  while (out.length > 1 && ctx.measureText(`${out}…`).width > maxWidth) out = out.slice(0, -1);
  return `${out.trimEnd()}…`;
}

function text(ctx: Ctx, value: string, x: number, y: number, opts: { size: number; color: string; weight?: number; align?: CanvasTextAlign; max?: number; spacing?: number; family?: string }): void {
  font(ctx, opts.size, opts.weight ?? 600, opts.family);
  ctx.fillStyle = opts.color;
  ctx.textAlign = opts.align ?? "left";
  ctx.textBaseline = "middle";
  if ("letterSpacing" in ctx) (ctx as Ctx & { letterSpacing: string }).letterSpacing = `${opts.spacing ?? 0}px`;
  ctx.fillText(opts.max === undefined ? value : fitted(ctx, value, opts.max), x, y);
  if ("letterSpacing" in ctx) (ctx as Ctx & { letterSpacing: string }).letterSpacing = "0px";
}

/** Word-wrapped lines within maxWidth, at most maxLines (the last one ellipsised). */
function wrapped(ctx: Ctx, value: string, maxWidth: number, maxLines: number): string[] {
  const lines: string[] = [];
  let line = "";
  for (const word of value.split(/\s+/).filter(Boolean)) {
    const next = line === "" ? word : `${line} ${word}`;
    if (ctx.measureText(next).width <= maxWidth || line === "") line = next;
    else { lines.push(line); line = word; }
  }
  if (line !== "") lines.push(line);
  if (lines.length <= maxLines) return lines;
  const kept = lines.slice(0, maxLines);
  kept[maxLines - 1] = fitted(ctx, `${kept[maxLines - 1]} ${lines[maxLines]}`, maxWidth);
  return kept;
}

function roundRect(ctx: Ctx, x: number, y: number, w: number, h: number, r: number): void {
  ctx.beginPath();
  ctx.roundRect(x, y, w, h, r);
}

/** The fly mark from the logo: two swept wings, a head and a water drop. */
function flyMark(ctx: Ctx, cx: number, cy: number, size: number, color: string): void {
  const s = size / 100;
  ctx.save();
  ctx.translate(cx, cy);
  ctx.scale(s, s);
  ctx.fillStyle = color;
  for (const dir of [-1, 1]) {
    ctx.beginPath();
    ctx.moveTo(dir * 8, -14);
    ctx.quadraticCurveTo(dir * 40, -26, dir * 50, 10);
    ctx.quadraticCurveTo(dir * 30, 4, dir * 10, 6);
    ctx.closePath();
    ctx.fill();
  }
  ctx.beginPath();
  ctx.arc(0, -26, 9, 0, Math.PI * 2);
  ctx.fill();
  ctx.beginPath();
  ctx.moveTo(0, -14);
  ctx.bezierCurveTo(6, -4, 13, 4, 13, 12);
  ctx.arc(0, 12, 13, 0, Math.PI);
  ctx.bezierCurveTo(-13, 4, -6, -4, 0, -14);
  ctx.fill();
  ctx.restore();
}

function topBar(ctx: Ctx, right: string | null): void {
  flyMark(ctx, 20, 16, 26, C.ember);
  text(ctx, "FLYFIREFIGHTER", 38, 15, { size: 9, color: C.muted, weight: 700, spacing: 1.6 });
  if (right !== null) text(ctx, right, 308, 15, { size: 9, color: C.muted, weight: 700, align: "right", spacing: 1 });
  ctx.fillStyle = C.line;
  ctx.fillRect(12, 28, 296, 1);
}

export interface Chip { readonly column: 1 | 2 | 4; readonly label: string; readonly fill: string; readonly ink: string; readonly tick: string; readonly border?: string; readonly dim?: boolean }

/** Chip label sizes tried in order: the largest that fits the whole label wins. */
const CHIP_FONT_STEPS = [9.5, 9, 8.5, 8, 7.5, 7, 6.5, 6] as const;
const CHIP_PAD = 6;
const CHIP_MIN_W = 46;

/** The widest a chip may be: centred on its button, inside the panel, and clear of the other chips. */
function chipMaxWidth(column: number, list: readonly Chip[]): number {
  const centre = COLUMNS[column];
  let half = Math.min(centre, SCREEN_W - centre);
  for (const other of list) if (other.column !== column) half = Math.min(half, Math.abs(COLUMNS[other.column] - centre) / 2 - 1);
  return Math.floor(half * 2);
}

/** Where a chip goes and at what size, so its whole label fits (exported for tests). */
export function chipLayout(ctx: Ctx, chip: Chip, list: readonly Chip[]): { readonly x: number; readonly width: number; readonly size: number } {
  const max = chipMaxWidth(chip.column, list);
  let size: number = CHIP_FONT_STEPS[CHIP_FONT_STEPS.length - 1];
  for (const step of CHIP_FONT_STEPS) {
    font(ctx, step, 800);
    if (ctx.measureText(chip.label).width + 2 * CHIP_PAD <= max) { size = step; break; }
  }
  font(ctx, size, 800);
  const width = Math.min(max, Math.max(CHIP_MIN_W, Math.ceil(ctx.measureText(chip.label).width) + 2 * CHIP_PAD));
  return { x: COLUMNS[chip.column] - width / 2, width, size };
}

function chips(ctx: Ctx, list: readonly Chip[]): void {
  for (const chip of list) {
    const { x, width, size } = chipLayout(ctx, chip, list);
    ctx.globalAlpha = chip.dim === true ? 0.45 : 1;
    roundRect(ctx, x, 208, width, 24, 7);
    ctx.fillStyle = chip.fill;
    ctx.fill();
    if (chip.border !== undefined) { ctx.strokeStyle = chip.border; ctx.lineWidth = 1.5; ctx.stroke(); }
    text(ctx, chip.label, COLUMNS[chip.column], 220.5, { size, color: chip.ink, weight: 800, align: "center", max: width - 4 });
    ctx.globalAlpha = 1;
    // A small tick, in the physical button's colour, from the chip to the button below it.
    ctx.fillStyle = chip.tick;
    ctx.fillRect(COLUMNS[chip.column] - 1, 233, 2, 5);
  }
}

const ABORT_CHIP: Chip = { column: 4, label: "⏹ ABORT ×2", fill: C.raised, ink: C.alert, border: C.alert, tick: C.button.red };

function iconGlass(ctx: Ctx, cx: number, cy: number): void {
  ctx.strokeStyle = C.light;
  ctx.lineWidth = 2.2;
  roundRect(ctx, cx - 13, cy - 15, 26, 30, 2);
  ctx.stroke();
  ctx.beginPath();
  ctx.moveTo(cx - 2, cy - 15); ctx.lineTo(cx + 3, cy - 3); ctx.lineTo(cx - 4, cy + 4); ctx.lineTo(cx + 2, cy + 15);
  ctx.moveTo(cx + 3, cy - 3); ctx.lineTo(cx + 13, cy - 6);
  ctx.moveTo(cx - 4, cy + 4); ctx.lineTo(cx - 13, cy + 8);
  ctx.stroke();
}

function iconDrop(ctx: Ctx, cx: number, cy: number): void {
  ctx.fillStyle = C.light;
  ctx.beginPath();
  ctx.moveTo(cx, cy - 17);
  ctx.bezierCurveTo(cx + 8, cy - 5, cx + 13, cy + 1, cx + 13, cy + 6);
  ctx.arc(cx, cy + 6, 13, 0, Math.PI);
  ctx.bezierCurveTo(cx - 13, cy + 1, cx - 8, cy - 5, cx, cy - 17);
  ctx.fill();
}

function iconPayload(ctx: Ctx, cx: number, cy: number): void {
  ctx.strokeStyle = C.ember;
  ctx.lineWidth = 2.2;
  ctx.beginPath();
  ctx.moveTo(cx, cy - 15); ctx.lineTo(cx + 14, cy - 8); ctx.lineTo(cx + 14, cy + 8); ctx.lineTo(cx, cy + 15); ctx.lineTo(cx - 14, cy + 8); ctx.lineTo(cx - 14, cy - 8); ctx.closePath();
  ctx.moveTo(cx - 14, cy - 8); ctx.lineTo(cx, cy - 1); ctx.lineTo(cx + 14, cy - 8);
  ctx.moveTo(cx, cy - 1); ctx.lineTo(cx, cy + 15);
  ctx.stroke();
}

function actionIcon(ctx: Ctx, action: GateAction, cx: number, cy: number): void {
  ctx.fillStyle = C.raised;
  ctx.beginPath();
  ctx.arc(cx, cy, 25, 0, Math.PI * 2);
  ctx.fill();
  ctx.strokeStyle = C.ember;
  ctx.lineWidth = 2;
  ctx.stroke();
  if (action === "breach_opening") iconGlass(ctx, cx, cy);
  else if (action === "spray") iconDrop(ctx, cx, cy);
  else iconPayload(ctx, cx, cy);
}

function countdownRing(ctx: Ctx, cx: number, cy: number, fraction: number, seconds: number): void {
  const urgent = seconds <= 5;
  ctx.lineCap = "round";
  ctx.lineWidth = 5;
  ctx.strokeStyle = C.line;
  ctx.beginPath();
  ctx.arc(cx, cy, 24, 0, Math.PI * 2);
  ctx.stroke();
  if (fraction > 0) {
    ctx.strokeStyle = urgent ? C.alert : C.ember;
    ctx.beginPath();
    ctx.arc(cx, cy, 24, -Math.PI / 2, -Math.PI / 2 + fraction * Math.PI * 2);
    ctx.stroke();
  }
  ctx.lineCap = "butt";
  text(ctx, String(Math.min(999, seconds)), cx, cy - 2, { size: seconds >= 100 ? 15 : 19, color: urgent ? C.alert : C.ink, weight: 800, align: "center" });
  text(ctx, "SEC", cx, cy + 12, { size: 7, color: C.muted, weight: 700, align: "center", spacing: 1 });
}

function coverageBar(ctx: Ctx, coverage: number | null, y: number): void {
  text(ctx, "COVERAGE", 12, y, { size: 8, color: C.muted, weight: 700, spacing: 1.4 });
  roundRect(ctx, 12, y + 8, 236, 10, 5);
  ctx.fillStyle = C.raised;
  ctx.fill();
  if (coverage !== null && coverage > 0) {
    roundRect(ctx, 12, y + 8, Math.max(10, 236 * coverage), 10, 5);
    ctx.fillStyle = coverage >= 0.9 ? C.light : C.ember;
    ctx.fill();
  }
  text(ctx, coverage === null ? "—" : `${Math.round(coverage * 100)}%`, 308, y + 11, { size: 18, color: coverage === null ? C.muted : C.ink, weight: 800, align: "right" });
}

/** The card title runs from the icon to the countdown ring. */
const TITLE_MAX_W = 174;
const TITLE_SIZE = 23;
/** Titles shrink to 60% of full size before wrapping, and never get an ellipsis unless a word alone is too wide. */
const TITLE_MIN_SIZE = 14;

/** The largest title size that fits on one line, else on two lines (exported for tests). */
export function fitTitle(ctx: Ctx, title: string, maxWidth: number): { readonly size: number; readonly lines: readonly string[] } {
  for (let size = TITLE_SIZE; size >= TITLE_MIN_SIZE; size--) {
    font(ctx, size, 800);
    if (ctx.measureText(title).width <= maxWidth) return { size, lines: [title] };
  }
  for (let size = 18; size >= TITLE_MIN_SIZE; size--) {
    font(ctx, size, 800);
    const lines = wrapped(ctx, title, maxWidth, 2);
    if (lines.every(line => !line.endsWith("…") && ctx.measureText(line).width <= maxWidth)) return { size, lines };
  }
  return { size: TITLE_MIN_SIZE, lines: [title] };
}

function drawPending(ctx: Ctx, s: Extract<ScreenSpec, { kind: "pending" }>): void {
  // The pending action card's look: warm panel with an ember edge.
  ctx.fillStyle = C.warm;
  ctx.fillRect(0, 0, SCREEN_W, SCREEN_H);
  ctx.fillStyle = C.ember;
  ctx.fillRect(0, 0, 3, SCREEN_H);
  topBar(ctx, "DECISION");
  text(ctx, s.armed ? "PENDING APPROVAL" : "REVIEW · APPROVE IN A MOMENT", 12, 41, { size: 9, color: C.ember, weight: 800, spacing: 1.6 });
  actionIcon(ctx, s.action, 40, 82);
  const title = fitTitle(ctx, s.title, TITLE_MAX_W);
  title.lines.forEach((line, i) => text(ctx, line, 74, title.lines.length === 1 ? 74 : 64 + i * (title.size + 2), { size: title.size, color: C.ink, weight: 800, max: TITLE_MAX_W }));
  text(ctx, s.template === true ? "Decision waiting" : s.target, 74, title.lines.length === 1 ? 96 : 104, { size: 12, color: C.muted, weight: 500, max: TITLE_MAX_W });
  if (s.template === true) {
    // The device template: per-proposal facts live on the action card, which the approval binds to.
    text(ctx, "Target, coverage, window and digest:", 12, 140, { size: 12, color: C.ink, weight: 500, max: 296 });
    text(ctx, "see the action card on the command screen.", 12, 158, { size: 12, color: C.ink, weight: 500, max: 296 });
    text(ctx, "Approve arms after the review delay.", 12, 184, { size: 10, color: C.muted, weight: 500, max: 296 });
  } else {
    countdownRing(ctx, 280, 82, s.ring, s.secondsLeft);
    coverageBar(ctx, s.coverage, 126);
    text(ctx, s.note, 12, 166, { size: 12, color: C.ink, weight: 500, max: 296 });
    text(ctx, `#${s.digestPrefix} · this approval binds to it`, 12, 188, { size: 9, color: C.muted, weight: 500, family: MONO, max: 296 });
  }
  chips(ctx, [
    { column: 1, label: "✕ REJECT", fill: C.raised, ink: C.ink, border: C.muted, tick: C.button.yellow },
    s.armed ? { column: 2, label: "✓ APPROVE", fill: C.ember, ink: C.emberInk, tick: C.button.green } : { column: 2, label: "HOLD…", fill: C.raised, ink: C.muted, tick: C.button.green, dim: true },
    ABORT_CHIP,
  ]);
}

function progressDots(ctx: Ctx, steps: readonly string[], y: number): void {
  const gap = 30;
  const x0 = 160 - ((steps.length - 1) * gap) / 2;
  steps.forEach((state, i) => {
    const x = x0 + i * gap;
    if (i > 0) { ctx.fillStyle = state === "upcoming" ? C.line : C.muted; ctx.fillRect(x - gap + 6, y - 0.5, gap - 12, 1); }
    ctx.beginPath();
    ctx.arc(x, y, state === "current" ? 6 : 4, 0, Math.PI * 2);
    if (state === "done") { ctx.fillStyle = C.light; ctx.fill(); }
    else if (state === "current") { ctx.fillStyle = C.ember; ctx.fill(); ctx.strokeStyle = C.emberSoft; ctx.lineWidth = 4; ctx.beginPath(); ctx.arc(x, y, 9, 0, Math.PI * 2); ctx.stroke(); }
    else { ctx.strokeStyle = state === "skipped" ? C.muted : C.line; ctx.lineWidth = 1.5; ctx.stroke(); }
  });
}

function drawPhase(ctx: Ctx, s: Extract<ScreenSpec, { kind: "phase" }>): void {
  topBar(ctx, `PHASE ${s.index}/${s.steps.length || 8}`);
  if (s.halt !== null) {
    roundRect(ctx, 160 - 34, 40, 68, 18, 9);
    ctx.fillStyle = s.halt === "ABORTED" || s.halt === "FAILED" ? C.alert : C.ember;
    ctx.fill();
    text(ctx, s.halt, 160, 49.5, { size: 9, color: C.emberInk, weight: 800, align: "center", spacing: 1 });
  } else {
    text(ctx, `STEP ${s.index} OF ${s.steps.length || 8}`, 160, 50, { size: 9, color: C.ember, weight: 800, align: "center", spacing: 2 });
  }
  text(ctx, s.label, 160, 86, { size: 28, color: C.ink, weight: 800, align: "center", max: 296 });
  progressDots(ctx, s.steps, 124);
  font(ctx, 12, 500);
  wrapped(ctx, s.caption, 280, 2).forEach((line, i) => text(ctx, line, 160, 156 + i * 16, { size: 12, color: C.muted, weight: 500, align: "center" }));
  chips(ctx, [ABORT_CHIP]);
}

function badge(ctx: Ctx, cy: number, fill: string, draw: () => void): void {
  ctx.fillStyle = fill;
  ctx.beginPath();
  ctx.arc(160, cy, 34, 0, Math.PI * 2);
  ctx.fill();
  draw();
}

function drawDecision(ctx: Ctx, s: Extract<ScreenSpec, { kind: "approved" | "rejected" }>): void {
  const approved = s.kind === "approved";
  topBar(ctx, "DECISION");
  badge(ctx, 84, approved ? C.light : C.raised, () => {
    ctx.strokeStyle = approved ? C.emberInk : C.alert;
    ctx.lineWidth = 6;
    ctx.lineCap = "round";
    ctx.beginPath();
    if (approved) { ctx.moveTo(144, 85); ctx.lineTo(155, 97); ctx.lineTo(177, 72); }
    else { ctx.moveTo(148, 72); ctx.lineTo(172, 96); ctx.moveTo(172, 72); ctx.lineTo(148, 96); }
    ctx.stroke();
    ctx.lineCap = "butt";
  });
  text(ctx, approved ? "APPROVED" : "REJECTED", 160, 144, { size: 26, color: approved ? C.light : C.alert, weight: 800, align: "center", spacing: 1 });
  if (s.title === "") {
    text(ctx, approved ? "The harness executes and monitors it" : "Nothing is executed", 160, 170, { size: 12, color: C.ink, weight: 500, align: "center", max: 296 });
  } else {
    text(ctx, `${s.title} · by ${s.by.replace(/ \(Free-WiLi console\)$/, "")}`, 160, 170, { size: 12, color: C.ink, weight: 500, align: "center", max: 296 });
    text(ctx, s.viaConsole ? "via Free-WiLi console" : "via command screen", 160, 188, { size: 11, color: C.muted, weight: 500, align: "center" });
  }
  chips(ctx, [ABORT_CHIP]);
}

function drawAborted(ctx: Ctx, s: Extract<ScreenSpec, { kind: "aborted" }>): void {
  ctx.fillStyle = C.ember;
  ctx.fillRect(0, 0, SCREEN_W, SCREEN_H);
  flyMark(ctx, 20, 16, 26, C.emberInk);
  text(ctx, "FLYFIREFIGHTER", 38, 15, { size: 9, color: C.emberInk, weight: 700, spacing: 1.6 });
  badge(ctx, 86, C.emberInk, () => { ctx.fillStyle = C.ember; roundRect(ctx, 146, 72, 28, 28, 4); ctx.fill(); });
  text(ctx, "MISSION ABORTED", 160, 146, { size: 25, color: C.emberInk, weight: 800, align: "center", spacing: 0.5 });
  font(ctx, 12, 500);
  wrapped(ctx, s.caption, 280, 2).forEach((line, i) => text(ctx, line, 160, 172 + i * 16, { size: 12, color: C.emberInk, weight: 500, align: "center" }));
}

function drawCentered(ctx: Ctx, title: string, caption: string, mark: string, live: boolean): void {
  topBar(ctx, null);
  flyMark(ctx, 160, 92, 92, mark);
  text(ctx, title, 160, 150, { size: 22, color: C.ink, weight: 800, align: "center", spacing: 1 });
  font(ctx, 12, 500);
  wrapped(ctx, caption, 280, 2).forEach((line, i) => text(ctx, line, 160, 174 + i * 16, { size: 12, color: C.muted, weight: 500, align: "center" }));
  if (live) chips(ctx, [ABORT_CHIP]);
}

/** Draw one screen into a 320 × 240 context (scale the context first for a sharper mirror). */
export function renderScreen(ctx: Ctx, spec: ScreenSpec): void {
  ctx.save();
  ctx.fillStyle = C.bg;
  ctx.fillRect(0, 0, SCREEN_W, SCREEN_H);
  switch (spec.kind) {
    case "pending": drawPending(ctx, spec); break;
    case "phase": drawPhase(ctx, spec); break;
    case "approved":
    case "rejected": drawDecision(ctx, spec); break;
    case "aborted": drawAborted(ctx, spec); break;
    case "standby": drawCentered(ctx, "STANDING BY", spec.caption, C.ember, true); break;
    case "no_run": drawCentered(ctx, "NO RUN", "Start a run on the command screen", C.line, false); break;
    case "disconnected": drawCentered(ctx, "CONSOLE DISCONNECTED", "On-screen controls keep working", C.line, false); break;
  }
  ctx.restore();
}
