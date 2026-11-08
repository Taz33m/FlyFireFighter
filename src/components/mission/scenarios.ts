/**
 * The scenarios the run controls offer. Only rescue scenarios meant for the demo are listed: the other preset
 * variants (immobile occupant, blocked exit, wrong prior, no fire) are batch-evaluation conditions and the
 * staged ones are test tools (lib/mission/scenario.ts); the worker still accepts any preset id. Each carries
 * its preset's default report, so "Use example" fills in the words that scenario is about. The report texts
 * are repeated here rather than imported, so the page does not bundle the simulator; scenarios.test.ts keeps
 * them equal to the presets'.
 */
export interface UiScenario {
  readonly id: string;
  readonly label: string;
  readonly exampleReport: string;
}

export const UI_SCENARIOS: readonly UiScenario[] = [
  { id: "troy-training/main", label: "Main rescue", exampleReport: "Someone may be in the upstairs rear bedroom." },
  { id: "troy-training/kitchen_grease_fire", label: "Kitchen grease fire", exampleReport: "Someone may be in the upstairs rear bedroom. A pan of oil caught fire on the stove in the kitchen." },
];

export const DEFAULT_SCENARIO: UiScenario = UI_SCENARIOS[0];

/** The listed scenario with this id, or the default (main) for any other id. */
export function uiScenario(id: string | null | undefined): UiScenario {
  return UI_SCENARIOS.find(s => s.id === id) ?? DEFAULT_SCENARIO;
}
