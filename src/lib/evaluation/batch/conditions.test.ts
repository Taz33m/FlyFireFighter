/**
 * Pairing of the seeded mission evaluation. Scope: the plan covers every seed × condition; paired arms get
 * identical seeds, scene, aircraft, local planner, commander policy, recall rule and budget, differing only
 * in the stated factor; and the initial simulated worlds of a pair are identical (controller and injection
 * pairs) or differ only in the variant's stated change. Builds options and worlds; does not fly missions.
 */
import assert from "node:assert/strict";
import { describe, test } from "node:test";
import type { JsonValue } from "../../contracts/canonical.ts";
import { createPresetWorld, loadPreset } from "../../mission/scenario.ts";
import { troyMeta } from "../../mission/mission-driver.ts";
import { worldSnapshot } from "../../simulation/hash.ts";
import type { Condition } from "./conditions.ts";
import { BASELINE_ID, conditionById, CONDITIONS, planRuns, runIdFor, seedList } from "./conditions.ts";
import { runtimeOptions } from "./runner.ts";

type Json = { [key: string]: JsonValue };

function initialWorld(variant: Parameters<typeof loadPreset>[1], seed: string, runId: string): Json {
  const snapshot = worldSnapshot(createPresetWorld(loadPreset(troyMeta().meta, variant, seed, runId))) as Json;
  delete snapshot.runId;
  delete snapshot.scenarioId;
  return snapshot;
}

function differingFactors(a: Record<string, unknown>, b: Record<string, unknown>, injectionDiffers: boolean): string[] {
  const ca = a.config as Record<string, unknown>;
  const cb = b.config as Record<string, unknown>;
  const out: string[] = [];
  if (ca.controller !== cb.controller) out.push("controller");
  if (ca.scenarioId !== cb.scenarioId) out.push("variant");
  if ((a.rangeAssist ?? true) !== (b.rangeAssist ?? true)) out.push("rangeAssist");
  if (injectionDiffers) out.push("injection");
  if (a.initialWaterL !== b.initialWaterL) out.push("water");
  return out;
}

function expectedFactors(c: Condition, partner: Condition): string[] {
  if (c.controller !== partner.controller) return ["controller"];
  if (c.variant !== partner.variant) return ["variant"];
  if (!c.rangeAssist) return ["rangeAssist"];
  return c.injection === "payload_exhaustion" ? ["injection", "water"] : ["injection"];
}

describe("paired conditions", () => {
  test("the plan is every seed × condition with distinct, bounded run ids", () => {
    const seeds = seedList(3);
    const ids = CONDITIONS.map(c => c.id);
    const runs = planRuns(seeds, ids);
    assert.equal(runs.length, seeds.length * ids.length);
    assert.equal(new Set(runs.map(r => r.runId)).size, runs.length);
    assert.ok(runs.every(r => r.runId.length <= 64 && /^[A-Za-z0-9_.-]+$/.test(r.runId)));
    assert.throws(() => planRuns(["a", "a"], ids));
    assert.throws(() => planRuns(seeds, ["no-such-condition"]));
    assert.equal(runIdFor(BASELINE_ID, "eval-seed-1"), "ev-main.flow-eval-seed-1");
  });

  test("duplicate conditions are rejected before a repeated run can overwrite its bundle", () => {
    assert.throws(() => planRuns(["eval-seed-1"], [BASELINE_ID, BASELINE_ID]), /Conditions must be distinct/);
  });

  test("distinct seeds that sanitize to the same run id are rejected instead of merging results", () => {
    for (const seeds of [["seed/a", "seed_a"], ["seed a", "seed?a"], ["seed-é", "seed-ø"]]) {
      assert.equal(new Set(seeds).size, seeds.length, "these are different source seeds");
      assert.throws(() => planRuns(seeds, [BASELINE_ID, "main.readout"]), /Run id collision after sanitizing seeds/);
    }
  });

  test("safe punctuation and unique sanitized seeds retain their existing run ids and pairing", () => {
    const seeds = ["seed.a-1", "seed_a-1", "seed/b-1"];
    const runs = planRuns(seeds, [BASELINE_ID, "main.readout"]);
    assert.deepEqual(runs.map(r => [r.seed, r.condition.id, r.runId]), [
      ["seed.a-1", BASELINE_ID, "ev-main.flow-seed.a-1"],
      ["seed.a-1", "main.readout", "ev-main.readout-seed.a-1"],
      ["seed_a-1", BASELINE_ID, "ev-main.flow-seed_a-1"],
      ["seed_a-1", "main.readout", "ev-main.readout-seed_a-1"],
      ["seed/b-1", BASELINE_ID, "ev-main.flow-seed_b-1"],
      ["seed/b-1", "main.readout", "ev-main.readout-seed_b-1"],
    ]);
  });

  test("every pair partner exists and shares everything except the stated factor", () => {
    const seed = "eval-seed-7";
    for (const c of CONDITIONS.filter(x => x.pair !== null)) {
      const partner = conditionById(c.pair?.against ?? "");
      const [a] = planRuns([seed], [c.id]);
      const [b] = planRuns([seed], [partner.id]);
      const oa = runtimeOptions(a, null) as unknown as Record<string, unknown>;
      const ob = runtimeOptions(b, null) as unknown as Record<string, unknown>;
      const ca = oa.config as Record<string, unknown>;
      const cb = ob.config as Record<string, unknown>;
      assert.equal(ca.seed, seed);
      assert.equal(cb.seed, seed);
      for (const key of ["aircraftId", "decider", "commanderId", "speed"]) assert.equal(ca[key], cb[key], `${c.id}: config.${key}`);
      assert.equal(ca.decider, "local", "batch runs never use cloud decisions");
      assert.deepEqual(oa.commander, ob.commander, `${c.id}: commander policy`);
      assert.equal(oa.recallOnArrival, ob.recallOnArrival);
      assert.equal(oa.meta, ob.meta, "same scene metadata");
      const differs = differingFactors(oa, ob, c.injection !== partner.injection);
      const expected = expectedFactors(c, partner);
      assert.deepEqual(differs, expected, `${c.id} vs ${partner.id}`);
    }
  });

  test("a controller or injection pair starts from the identical world on the same seed; a different seed is a different world", () => {
    const a = initialWorld("main", "eval-seed-1", runIdFor(BASELINE_ID, "eval-seed-1"));
    const b = initialWorld("main", "eval-seed-1", runIdFor("main.readout", "eval-seed-1"));
    assert.deepEqual(a, b);
    assert.notDeepEqual(initialWorld("main", "eval-seed-2", "r"), a);
  });

  test("a variant pair differs only in the variant's stated change", () => {
    const seed = "eval-seed-1";
    const main = initialWorld("main", seed, "r");
    const immobile = initialWorld("immobile_occupant", seed, "r");
    const occupants = (immobile.occupants as Json[]).map(o => ({ ...o, mobility: "mobile" }));
    assert.deepEqual({ ...immobile, occupants }, main);
    const blocked = initialWorld("blocked_exit", seed, "r");
    const changed = (blocked.openings as Json[]).filter((o, i) => JSON.stringify(o) !== JSON.stringify((main.openings as Json[])[i]));
    assert.deepEqual(changed.map(o => o.id), ["door-front"]);
    assert.deepEqual({ ...blocked, openings: null, activeColliderIds: null }, { ...main, openings: null, activeColliderIds: null });
    assert.deepEqual(initialWorld("wrong_prior", seed, "r"), main, "wrong_prior changes the planner's map prior, not the world");
  });
});
