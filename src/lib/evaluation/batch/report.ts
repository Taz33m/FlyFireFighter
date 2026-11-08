/**
 * Markdown tables of a batch summary (written next to summary.json as report.md), so published numbers
 * are copied from the artifact rather than retyped. Every rate is shown as "k/n"; no improvement wording.
 */
import type { BatchSummary, ConditionSummary, Distribution, RunRecord } from "./aggregate.ts";

function dist(d: Distribution): string {
  if (d.available === 0) return `— (0/${d.of})`;
  return `${d.median} [${d.min}–${d.max}] (${d.available}/${d.of})`;
}

function outcomeRow(c: ConditionSummary): string {
  const r = c.completedRescue;
  const ci = r.wilson95 === null ? "—" : `${r.wilson95[0]}–${r.wilson95[1]}`;
  const returns = Object.entries(c.droneReturn).map(([k, n]) => `${k} ${n}`).join(", ") || "—";
  return `| ${c.conditionId} | ${c.planned} | ${c.ran} | ${c.notRun.length} | ${c.invalid.length} | ${c.errors.length} | ${r.completed}/${r.of} | ${ci} | ${c.unscored.length} | ${returns} |`;
}

function safetyRow(c: ConditionSummary): string {
  return `| ${c.conditionId} | ${c.runsWithCollision}/${c.ran} | ${c.constraintViolations} | ${c.unauthorizedActions} | ${c.missionAborts} | ${c.recalls} | ${c.stallAborts}/${c.proposalAborts} | ${c.contingencies} | ${c.blockedInterventions} | ${c.injectionsApplied}/${c.ran} (${c.injectionsEffective} effective) |`;
}

function timingRow(c: ConditionSummary): string {
  return `| ${c.conditionId} | ${dist(c.timeToFirstOccupantEvidenceS)} | ${dist(c.timeToExteriorArrivalS)} | ${dist(c.waterDischargedL)} | ${dist(c.wallS)} | ${dist(c.simToWall)} |`;
}

export function renderReport(summary: BatchSummary, runs: readonly RunRecord[]): string {
  const lines = [
    `# Mission evaluation batch`,
    "",
    `${summary.label}. Claims: ${summary.claims}.`,
    "",
    `Seeds (${summary.seeds.length}): ${summary.seeds.join(", ")}. Totals: planned ${summary.totals.planned}, ran ${summary.totals.ran}, not run ${summary.totals.notRun}, invalid ${summary.totals.invalid}, errors ${summary.totals.errors}.`,
    "",
    "## Outcomes (primary metric: evaluator-verified arrival within budget, no violation)",
    "",
    "| Condition | Planned | Ran | Not run | Invalid | Errors | Completed rescue | 95% CI | Unscored | Drone return |",
    "| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |",
    ...summary.conditions.map(outcomeRow),
    "",
    "## Safety and execution",
    "",
    "| Condition | Runs with collision | Violations | Unauthorized | Mission aborts | Recalls | Stall/proposal aborts | Contingencies | Blocked interventions | Injection applied |",
    "| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |",
    ...summary.conditions.map(safetyRow),
    "",
    "## Times (simulated s from authorization; median [min–max] (available/ran)) and wall time",
    "",
    "| Condition | First possible-occupant track | Exterior arrival | Water discharged (L) | Wall s per run | Sim:wall |",
    "| --- | --- | --- | --- | --- | --- |",
    ...summary.conditions.map(timingRow),
    "",
    "## Pairs (seeds where both arms ran; descriptive counts)",
    "",
    "| Condition | Against | Factor | Pairs | Both completed | Only condition | Only reference | Neither | Unpaired seeds |",
    "| --- | --- | --- | --- | --- | --- | --- | --- | --- |",
    ...summary.pairs.map(p => `| ${p.condition} | ${p.against} | ${p.factor} | ${p.pairs} | ${p.bothCompleted} | ${p.onlyCondition} | ${p.onlyReference} | ${p.neither} | ${p.unpairedSeeds.join(", ") || "—"} |`),
    "",
    "## Runs not run, invalid or errored",
    "",
    ...(runs.filter(r => r.status !== "ran").map(r => `- ${r.runId} — ${r.status}: ${r.reason ?? ""}`)),
    ...(runs.every(r => r.status === "ran") ? ["- none"] : []),
    "",
    "## Injections",
    "",
    ...runs.filter(r => r.injection !== null).map(r => `- ${r.runId} — ${r.injection?.applied ? `applied at tick ${r.injection.tick}` : "not applied"}: ${r.injection?.detail ?? ""}`),
    "",
  ];
  return lines.join("\n");
}
