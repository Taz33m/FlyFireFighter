/**
 * The run controls' scenario list (scenarios.ts) against the mission presets: every listed id starts a real
 * rescue preset on the Troy scene (the same lookup the worker and runtime use), test-only variants stay out, and
 * each example report is that preset's default report word for word.
 */
import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { troyMeta } from "../../lib/mission/mission-driver.ts";
import { isStagedVariant, loadPreset, variantOfScenarioId } from "../../lib/mission/scenario.ts";
import { DEFAULT_SCENARIO, UI_SCENARIOS, uiScenario } from "./scenarios.ts";

describe("run controls scenario list", () => {
  test("offers the main rescue (the default) and the kitchen grease fire, nothing test-only", () => {
    assert.deepEqual(UI_SCENARIOS.map(s => [s.id, s.label]), [["troy-training/main", "Main rescue"], ["troy-training/kitchen_grease_fire", "Kitchen grease fire"]]);
    assert.equal(DEFAULT_SCENARIO.id, "troy-training/main");
    for (const scenario of UI_SCENARIOS) {
      const variant = variantOfScenarioId(scenario.id);
      assert.ok(variant !== null && scenario.id.startsWith(`${troyMeta().meta.sceneId}/`), `${scenario.id} names a Troy preset`);
      assert.equal(isStagedVariant(variant), false, `${scenario.id} is not a staged test tool`);
    }
  });

  test("each example report is its preset's default report, and an unlisted id falls back to the main rescue", () => {
    for (const scenario of UI_SCENARIOS) {
      const variant = variantOfScenarioId(scenario.id);
      assert.ok(variant !== null);
      assert.equal(scenario.exampleReport, loadPreset(troyMeta().meta, variant, "seed-1", "run-1").defaultReport, scenario.id);
    }
    assert.equal(uiScenario("troy-training/staged_spray"), DEFAULT_SCENARIO);
    assert.equal(uiScenario(null), DEFAULT_SCENARIO);
  });
});
