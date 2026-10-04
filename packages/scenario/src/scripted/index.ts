/**
 * The scripted scenario library (PRD §8.3).
 *
 * Each scenario is a TypeScript module rather than a JSON file so it can be parsed
 * through `ScenarioSchema` at load time: a malformed scripted scenario fails the
 * import, not a trainee's run. Generated scenarios (§8.4) come from the generator
 * instead and live behind the same `Scenario` type.
 */

import { nightRecon01 } from "./night-recon-01.js";
import { friendlyDeconflict01 } from "./friendly-deconflict-01.js";
import { urbanSwarmDiversion01 } from "./urban-swarm-diversion-01.js";

export { nightRecon01 } from "./night-recon-01.js";
export { friendlyDeconflict01 } from "./friendly-deconflict-01.js";
export { urbanSwarmDiversion01 } from "./urban-swarm-diversion-01.js";

/** Every shipped scenario, in library order. */
export const SCRIPTED_SCENARIOS = [
  nightRecon01,
  friendlyDeconflict01,
  urbanSwarmDiversion01,
] as const;

/** Scenario ids, for CLI argument matching and error messages. */
export const SCRIPTED_SCENARIO_IDS = SCRIPTED_SCENARIOS.map((s) => s.id);

/**
 * Look up a scripted scenario by id.
 *
 * Returns `undefined` rather than throwing: the CLI wants to print "unknown
 * scenario, here are the ones we have", which is a better failure than a stack
 * trace from a map lookup.
 */
export const scriptedScenarioById = (id: string) =>
  SCRIPTED_SCENARIOS.find((s) => s.id === id);