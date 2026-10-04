/**
 * Headless run: scenario + bot → event log + summary (PRD §5.4 FR-SCN-2, §14 M3).
 *
 * `sim:run` is the trainer's regression harness. Everything a trainee would do is
 * driven by a bot policy through the same `TraineeControls` a socket client uses,
 * so a green run here means the loop a trainee will meet is intact.
 */

import type { AnySimEvent } from "@skysentinel/shared";
import type { Session } from "@skysentinel/sim-core";
import { fingerprint, validateScenario, type Scenario } from "@skysentinel/scenario";
import type { Correlation, TruthEntity } from "@skysentinel/scoring";

import { buildSession } from "./build.js";
import { POLICIES } from "./policies.js";
import type { BotName } from "./policy.js";

export interface RunOptions {
  scenario: Scenario;
  bot: BotName;
  /** Bot seed. Defaults to the scenario seed so a run is reproducible from the id. */
  seed?: number;
  /** Stop after this many ticks. For the fuzz and perf harnesses, not `sim:run`. */
  max_ticks?: number;
}

/** What a run produced. Sufficient for the CLI summary and the M3 assertions. */
export interface RunResult {
  scenario_id: string;
  bot: BotName;
  seed: number;
  fingerprint: string;
  ticks: number;
  t_ms: number;
  log_hash: string;
  /** Every event, in order. This is what `sim:run` writes as JSONL. */
  events: readonly AnySimEvent[];
  /** Event counts by type, for the summary and the M3 assertions. */
  counts: Record<string, number>;
  /** Scenario validation issues found before the run. Empty for shipped scenarios. */
  validation_issues: readonly string[];
  /**
   * Ground truth and the cue/track correlation, in the shape the scorer needs.
   *
   * Server-side only. `toJsonl` names the fields it writes and does not include
   * this one, so a `sim:run` log is safe to hand to a trainee-facing client — the
   * trainer's rule is that truth never leaves the server (PRD §4, §6.4), and the
   * M4 ordering assertion needs the correlation to score a run at all.
   */
  server_side: ServerSideTruth;
}

/**
 * What only the server may see: the entities that existed and how each cue and
 * track resolves back to one of them.
 */
export interface ServerSideTruth {
  truth: ReadonlyMap<string, TruthEntity>;
  correlation: Correlation;
}

const countByType = (events: readonly AnySimEvent[]): Record<string, number> => {
  const counts: Record<string, number> = {};
  for (const e of events) counts[e.type] = (counts[e.type] ?? 0) + 1;
  return counts;
};

/**
 * Read the truth back out of a finished session.
 *
 * Entities come from the `entity_spawned` events rather than from live drone
 * objects, because the log is what an archived session is scored from months
 * later — the server must be able to re-score a stored run without re-running the
 * simulation, and a truth table that only existed in memory could not survive the
 * session that produced it.
 */
const readServerSide = (session: Session, events: readonly AnySimEvent[]): ServerSideTruth => {
  const truth = new Map<string, TruthEntity>();

  for (const e of events) {
    if (e.type !== "entity_spawned") continue;
    // Protected assets spawn through the same event with `authorised` truth. They
    // are not contacts and never appear in a report or an action, so they are not
    // correlation targets; keeping them would make `truth` claim a contact exists
    // where only a building does.
    if (e.payload.archetype === "protected_asset") continue;
    truth.set(e.payload.id, {
      id: e.payload.id,
      affiliation_truth: e.payload.affiliation_truth,
      intent: e.payload.intent,
    });
  }

  // `session.correlation()` accumulates every id the run produced. Reading
  // `session.tracks()` here instead would correlate only the contacts still alive
  // at the end of the session, and every action on a contact that had already been
  // retired would fail to resolve — which reads as a scorer bug, not a harness one.
  //
  // A track id mapped to null was fused from clutter alone: there is no entity to
  // score it against, and the map is explicitly nullable so the scorer can tell
  // "unresolved" from "never seen".
  return { truth, correlation: session.correlation() };
};

/**
 * Run one scenario with one bot to completion.
 *
 * Validation runs first and its issues are reported rather than thrown on: a
 * scenario that would be unfair is worth *running* precisely to see how unfair.
 * A scenario that fails to parse cannot run at all, and that is the caller's error.
 */
export const runScenario = (options: RunOptions): RunResult => {
  const { scenario, bot } = options;
  const seed = options.seed ?? scenario.seed;
  const validation = validateScenario(scenario);

  const session: Session = buildSession(scenario);
  const policy = POLICIES[bot](seed);

  let ticks = 0;
  const cap = options.max_ticks ?? Number.POSITIVE_INFINITY;
  // `session.run` and this loop are the same steps in the same order. The capped
  // form exists only so the fuzz harness can bound a bad scenario's runtime.
  while (ticks < cap && session.tick()) {
    policy({ view: session.traineeView(), controls: session.controls() });
    ticks++;
  }

  const events = session.log();

  return {
    scenario_id: scenario.id,
    bot,
    seed,
    fingerprint: fingerprint(scenario),
    ticks,
    t_ms: session.t_ms(),
    log_hash: session.logHash(),
    events,
    counts: countByType(events),
    validation_issues: validation.issues.map((i) => `${i.code}: ${i.message}`),
    server_side: readServerSide(session, events),
  };
};
