/**
 * Console renderer against a recording Canvas 2D stand-in (no browser). Scope: every screen kind draws without
 * error; the pending card names the action, target, coverage %, unseen line, countdown and digest, with the
 * legend chips (approve held during review); confirmations and the abort screen say what happened; and every
 * piece of text, measured with an approximate glyph width, lies inside the 320 × 240 panel. Pixel output itself
 * is checked by eye on the contact sheet, not here.
 */
import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { rgb565 } from "./fwi.ts";
import { CONSOLE_COLOURS, SCREEN_H, SCREEN_W, renderScreen } from "./render.ts";
import type { ScreenSpec } from "./screens.ts";

interface Drawn { readonly text: string; readonly left: number; readonly right: number; readonly y: number; readonly size: number }
interface Rect { readonly x: number; readonly y: number; readonly w: number; readonly h: number }

/**
 * A Canvas 2D stand-in: methods are no-ops, text is recorded with an approximate width of `em` per glyph
 * (0.6 by default; 0.72 approximates the wide heavy fallback face headless Chrome used for the contact sheet).
 */
function recorder(em = 0.6): { readonly ctx: CanvasRenderingContext2D; readonly drawn: Drawn[]; readonly fills: string[]; readonly rects: Rect[] } {
  const drawn: Drawn[] = [];
  const fills: string[] = [];
  const rects: Rect[] = [];
  const state: Record<string, unknown> = { font: "12px sans-serif", textAlign: "left", fillStyle: "#000", letterSpacing: "0px" };
  const size = () => Number(/(\d+(?:\.\d+)?)px/.exec(String(state.font))?.[1] ?? 12);
  const width = (text: string) => [...text].length * size() * em;
  const methods: Record<string, unknown> = {
    measureText: (text: string) => ({ width: width(text) }),
    fillText: (text: string, x: number, y: number) => {
      const w = width(text);
      const align = state.textAlign;
      const left = align === "center" ? x - w / 2 : align === "right" ? x - w : x;
      drawn.push({ text, left, right: left + w, y, size: size() });
    },
    fillRect: () => fills.push(String(state.fillStyle)),
    roundRect: (x: number, y: number, w: number, h: number) => rects.push({ x, y, w, h }),
  };
  const ctx = new Proxy(state, {
    get: (target, key: string) => (key in methods ? methods[key] : key in target ? target[key] : () => {}),
    set: (target, key: string, value) => { target[key] = value; return true; },
    has: (target, key: string) => key in target || key in methods,
  }) as unknown as CanvasRenderingContext2D;
  return { ctx, drawn, fills, rects };
}

function draw(spec: ScreenSpec, em = 0.6) {
  const r = recorder(em);
  renderScreen(r.ctx, spec);
  return { ...r, all: r.drawn.map(d => d.text).join(" | ") };
}

const PENDING: ScreenSpec = {
  kind: "pending", action: "breach_opening", title: "BREAK GLASS", target: "Rear bedroom window, a very long opening name that must be clipped", coverage: 0.82,
  note: "Unseen: inside under the sill", secondsLeft: 12, ring: 0.5, digestPrefix: "1a2b3c4d", armed: true,
};

const ALL: ScreenSpec[] = [
  PENDING, { ...PENDING, armed: false }, { ...PENDING, action: "spray", title: "SPRAY WATER", coverage: null }, { ...PENDING, action: "release_payload", title: "RELEASE PAYLOAD" },
  { kind: "phase", phase: "access", index: 3, label: "WINDOW ACCESS", caption: "Waiting for your approval to break the rear-bedroom window, with a caption long enough to wrap twice", steps: ["done", "done", "current", "upcoming", "upcoming", "upcoming", "upcoming", "upcoming"], halt: null },
  { kind: "phase", phase: "search", index: 4, label: "SEARCH", caption: "", steps: ["done", "done", "skipped", "current", "upcoming", "upcoming", "upcoming", "upcoming"], halt: "REROUTE" },
  { kind: "approved", action: "spray", title: "SPRAY WATER", by: "commander-1 (Free-WiLi console)", viaConsole: true },
  { kind: "rejected", action: "breach_opening", title: "BREAK GLASS", by: "commander-1", viaConsole: false },
  { kind: "aborted", caption: "Remaining actuation stops; the harness selects a contingency." },
  { kind: "standby", caption: "Waiting for the caller's report" }, { kind: "no_run" }, { kind: "disconnected" },
];

describe("console renderer", () => {
  test("every screen draws, and all text lies inside the 320 × 240 panel", () => {
    for (const spec of ALL) {
      const { drawn } = draw(spec);
      assert.ok(drawn.length > 0, spec.kind);
      for (const d of drawn) {
        assert.ok(d.left >= -1 && d.right <= SCREEN_W + 1 && d.y > 0 && d.y < SCREEN_H, `${spec.kind}: "${d.text}" at ${d.left.toFixed(0)}..${d.right.toFixed(0)}, ${d.y}`);
      }
    }
  });

  test("the pending card names action, target, coverage, unseen place, countdown and digest, with three chips", () => {
    const { all } = draw(PENDING);
    for (const part of ["PENDING APPROVAL", "BREAK GLASS", "Rear bedroom", "82%", "Unseen: inside under the sill", "12", "#1a2b3c4d", "✕ REJECT", "✓ APPROVE", "⏹ ABORT ×2"]) assert.ok(all.includes(part), part);
    assert.ok(!all.includes("a very long opening name that must be clipped"), "the target is clipped");
  });

  test("during the review delay approve is shown held", () => {
    const { all } = draw({ ...PENDING, armed: false });
    assert.ok(all.includes("HOLD…") && !all.includes("✓ APPROVE"));
  });

  test("confirmations say who decided and through what; abort fills the screen in the ember accent", () => {
    const approved = draw(ALL[6]).all;
    assert.ok(approved.includes("APPROVED") && approved.includes("by commander-1") && approved.includes("via Free-WiLi console"));
    assert.ok(draw(ALL[7]).all.includes("via command screen"));
    const aborted = draw(ALL[8]);
    assert.ok(aborted.all.includes("MISSION ABORTED"));
    assert.equal(aborted.fills[1], CONSOLE_COLOURS.ember);
  });
});

describe("titles and chips are never cut off", () => {
  const WIDE = 0.72;
  const LONGEST_TARGET = "Second-floor rear bedroom casement window at (12.5, -10.5, 4.2)";
  const kinds = [["breach_opening", "BREAK GLASS"], ["spray", "SPRAY WATER"], ["release_payload", "RELEASE PAYLOAD"]] as const;
  const CHIP_LABELS = ["✕ REJECT", "✓ APPROVE", "⏹ ABORT ×2", "HOLD…"];

  test("every action title is drawn whole (shrunk or wrapped, never ellipsised); BREAK GLASS keeps full size", () => {
    for (const [action, title] of kinds) {
      for (const em of [0.6, WIDE]) {
        const { drawn } = draw({ ...PENDING, action, title, target: LONGEST_TARGET }, em);
        const titleRows = drawn.filter(d => title.split(" ").some(word => d.text.split(" ").includes(word)));
        assert.equal(titleRows.map(d => d.text).join(" "), title, `${title} at ${em} em`);
        for (const row of titleRows) assert.ok(row.size >= 14 && row.right <= 74 + 174 + 0.5, `${row.text} ${row.size}px`);
        if (action === "breach_opening" && em === 0.6) assert.equal(titleRows[0].size, 23);
      }
    }
  });

  test("chip labels are whole, chips sit centred over their buttons, inside the panel, and never overlap", () => {
    const columns = [32, 96, 160, 224, 288];
    const screens: ScreenSpec[] = [PENDING, { ...PENDING, armed: false }, ...ALL.filter(s => s.kind !== "pending")];
    for (const spec of screens) {
      for (const em of [0.6, WIDE]) {
        const { drawn, rects } = draw(spec, em);
        const chipRects = rects.filter(r => r.y === 208).sort((a, b) => a.x - b.x);
        const labels = drawn.filter(d => d.y === 220.5).map(d => d.text);
        for (const label of labels) assert.ok(CHIP_LABELS.includes(label), `${spec.kind}: chip label "${label}" at ${em} em`);
        chipRects.forEach((r, i) => {
          assert.ok(r.x >= 0 && r.x + r.w <= 320, `${spec.kind}: chip ${r.x}..${r.x + r.w}`);
          assert.ok(columns.some(c => Math.abs(r.x + r.w / 2 - c) < 0.01), `${spec.kind}: chip not centred on a button`);
          if (i > 0) assert.ok(chipRects[i - 1].x + chipRects[i - 1].w <= r.x, `${spec.kind}: chips overlap`);
        });
        for (const d of drawn.filter(d => d.y === 220.5)) {
          const rect = chipRects.find(r => d.left >= r.x - 0.01 && d.right <= r.x + r.w + 0.01);
          assert.ok(rect !== undefined, `${spec.kind}: "${d.text}" spills out of its chip at ${em} em`);
        }
      }
    }
  });
});

describe("palette", () => {
  test("follows the app tokens, and no solid colour encodes to RGB565 0 (transparent in .FWI)", () => {
    assert.equal(CONSOLE_COLOURS.bg, "#090909");
    assert.equal(CONSOLE_COLOURS.ember, "#ff6b35");
    const solids = JSON.stringify(CONSOLE_COLOURS).match(/#[0-9a-f]{6}/gi) ?? [];
    assert.ok(solids.length >= 12);
    for (const hex of solids) {
      const [r, g, b] = [1, 3, 5].map(i => parseInt(hex.slice(i, i + 2), 16));
      assert.notEqual(rgb565(r, g, b), 0, hex);
    }
  });
});
