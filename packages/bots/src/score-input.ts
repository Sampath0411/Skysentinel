/**
 * Run artifacts → `ScoreInput` (PRD §14 M4).
 *
 * The scorer deliberately takes its truth correlation as a separate argument
 * (D20) so a bare event log cannot be scored and so nothing downstream has to
 * reach back into the simulation. That leaves one job for whoever holds both: the
 * harness. `runScenario` keeps the server-side truth on the result, and this turns
 * the pair into the shape `scoreRun` accepts.
 *
 * It lives in the bots package rather than in scoring because this is the only
 * place that legitimately holds a log *and* the answer key at the same time.
 */

import type { Scenario } from "@skysentinel/scenario";
import type { ScoreInput } from "@skysentinel/scoring";

import type { RunResult } from "./run.js";

/**
 * Build the scorer's input from a completed run.
 *
 * The scenario supplies the authored expectations — including the `correct_category`
 * sets the knowability model is measured against (PRD §9.4) — and the run supplies
 * everything the trainee actually did. Neither alone is a score.
 */
export const scoreInputFor = (scenario: Scenario, result: RunResult): ScoreInput => ({
  scenario_id: result.scenario_id,
  seed: result.seed,
  duration_ms: result.t_ms,
  events: result.events,
  expected: scenario.expected,
  correlation: result.server_side.correlation,
  truth: result.server_side.truth,
});