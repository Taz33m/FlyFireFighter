# CloudBreak harness draft review

> Design input for [FlyFireFighter](../../PRD.md), the current project name. These findings remain relevant when implementing the active-rescue harness; the linked PRD defines current scope and authority.

Reviewed November 7, 2026 against [harness-spec.md](harness-draft.md) and the [prior-art comparison](prior-art.md). These are design findings, not failures observed in running harness code. The shared action contract has not been changed by this review.

The draft already establishes useful boundaries: capability profiles, no all-clear state, human abort, simulated intervention limits, and evaluation of both prevented unsafe actions and wrongly blocked useful actions. The following semantics need resolution before implementation.

## 1. Bind approval to the entire immutable proposal

`Approval.bound` copies parameters, map version and evidence IDs but does not explicitly include the aircraft, command, target, profile version, envelope version or policy version. `proposalId` can cover these only if the stored proposal is immutable and the executor always resolves that exact record. State this invariant, or bind approval to a canonical proposal digest containing all relevant fields and dependencies. The harness must compute risk and mandatory stop conditions itself.

Acceptance case: approve a request, then change only its aircraft, command, target or applicable profile/envelope revision. Execution must not inherit the old approval. Retrying an execution request must not discharge the payload twice.

## 2. Revalidate against new evidence, not only cited evidence

H4 checks superseded cited observations and target-region map changes. A newly detected possible person might supersede nothing and leave geometry unchanged. Make H6 and H11 explicitly consult the latest relevant observations throughout the action's affected volume, approach and return dependencies. A previously sufficient scan must also age out. Use a defined mission clock, coordinate frame and freshness policy; do not derive reliability from hidden simulator truth.

Acceptance case: approve spray, add an independent possible-person observation in its discharge region, and attempt execution with the original evidence IDs. The action must be invalidated. Repeat after execution starts and verify the defined abort latency and bounded additional discharge.

## 3. Specify a contingency when return is infeasible

H9 says `return` preempts everything when return becomes infeasible. Preemption does not supply a feasible path. Separate an approaching reserve limit, where a validated return still exists, from a blocked route or lost localization. Define bounded contingencies such as a verified alternative route, validated holding interval or simulated landing site, and explicit mission failure when no supported maneuver remains. Do not label an arbitrary backtrack or hover safe.

Acceptance case: block the sole known exit while localization is degraded. The harness must neither claim a valid return nor fly the obsolete route. It must log the selected contingency, its evidence and termination condition.

## 4. Resolve the envelope exception

H3 is listed as non-overridable, while the lifecycle lists leaving the envelope as an approvable consequential action. Define hard aircraft limits separately from the commander-approved mission envelope. An envelope change should be an explicit mission revision followed by fresh action validation; an ordinary action approval must not silently change the envelope.

Acceptance case: approve a movement outside the current envelope. It remains non-executable until an allowed envelope revision is committed and the action is revalidated; the revision cannot exceed aircraft hard limits.

## 5. Define headcount reconciliation and the remaining data types

`possible` currently contains observations, so two sightings may refer to one person. `expected` lacks stable report IDs, report times and correction/retraction links; `crewLocated` lacks its link to supporting reports or tracks. Define distinct tracks, merge/split behavior, crew confirmation provenance and unresolved identity associations. Do not subtract detections from a caller's uncertain count and label the difference as a known missing-person count.

Also define `Region`, the mission envelope and `HarnessLog`, plus units, coordinate transforms, timestamp semantics and localization uncertainty. The current TypeScript snippets refer to these without supplying a complete serializable contract.

Acceptance case: one person is observed twice, a caller revises an estimated count, and a crew confirms a location. The display must preserve the reports, show one candidate track where association is supported, and retain uncertainty about who remains inside.

## Evidence needed for the pitch

Safety supervisors, stale-control rejection and adaptive sensing have prior art. Evaluate this implementation on held-out layouts and injected failures, with equal observations and budgets across comparison policies. Score harmful actions prevented and useful actions blocked using an evaluator independent of the harness's own verdicts. A zero on the tested suite is a scoped test result, not a general safety guarantee.
