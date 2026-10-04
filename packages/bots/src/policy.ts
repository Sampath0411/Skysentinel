/**
 * Bot policy framework (PRD §14 M3, §11.1).
 *
 * Bots exist for two reasons, and both matter for the trainer's credibility:
 *
 *   1. **Regression.** A scripted trainee makes the sim reproducible end to end,
 *      so a change to scoring or fusion that alters a bot's behaviour is caught by
 *      a test rather than by a trainee noticing.
 *   2. **Population.** M9's `seed:demo` fills the AAR with sessions from bots with
 *      known skill curves and known weaknesses, so the adaptive recommender and the
 *      cohort views have something honest to chew on.
 *
 * ## What a bot may see
 *
 * A policy receives only `BotTurn.view`, which is the truth-free trainee view. If a
 * bot could read `truth_ref` the M4 ordering assertion would be measuring oracle
 * access instead of skill, and every score derived from bot sessions would be
 * meaningless. This is enforced by the type, not by convention: `view` has no
 * truth fields to read.
 *
 * ## Determinism
 *
 * Bot "skill" and "noise" are parameters, not coin flips. Every stochastic choice a
 * policy makes is driven by a counter derived from the tick index, so the same
 * scenario and bot always produce the same session — including a bot with a
 * deliberately erratic `random` policy. `Math.random()` is banned here for the same
 * reason it is banned in sim-core (CLAUDE.md).
 */

import type { BotTurn, TraineeView } from "@skysentinel/sim-core";

/** A deterministic, replayable draw sequence for one bot. */
export interface BotRng {
  /** Next uniform in [0,1). Same sequence for the same seed and tick count. */
  next(): number;
  /** True with probability `p`. */
  chance(p: number): boolean;
  /** Uniform integer in [min, max]. */
  intBetween(min: number, max: number): number;
  pick<T>(items: readonly T[]): T;
  /** Draws consumed so far — part of a bot's identity in the log. */
  readonly draws: number;
}

/**
 * Bot RNG: a small integer hash rather than a PRNG object.
 *
 * A bot's decisions are sparse — one or two draws per action, not thousands per
 * tick — so a stateful PRNG would be pure overhead. A stateless hash of
 * (seed, counter) gives the same guarantees for a fraction of the code, and makes
 * a bot's behaviour reproducible from its draw count alone, which is what lets the
 * regression tests assert on it.
 */
export const createBotRng = (seed: number): BotRng => {
  let counter = 0;
  const hash = (n: number): number => {
    let h = (seed ^ Math.imul(n + 1, 0x9e3779b9)) >>> 0;
    h = Math.imul(h ^ (h >>> 16), 0x2545f491) >>> 0;
    h = Math.imul(h ^ (h >>> 15), 0x27d4eb2f) >>> 0;
    return ((h ^ (h >>> 15)) >>> 0) / 4294967296;
  };

  return {
    get draws() {
      return counter;
    },
    next() {
      return hash(counter++);
    },
    chance: (p) => hash(counter++) < p,
    intBetween(min, max) {
      return min + Math.floor(hash(counter++) * (max - min + 1));
    },
    pick<T>(items: readonly T[]): T {
      if (items.length === 0) throw new Error("createBotRng.pick called with no candidates");
      return items[Math.floor(hash(counter++) * items.length)]!;
    },
  };
};

/**
 * The five policies required by M3.
 *
 * The spread is deliberate and is the reason these exist: M4 asserts a score
 * ordering `expert > novice > passive ≈ random > trigger_happy`, and that
 * assertion is only meaningful if the bots genuinely differ in the *behaviours*
 * the scorer rewards — multi-sensor confirmation before classification, honest
 * confidence, report-before-engage, waiting for authority.
 */
export const BOT_NAMES = ["expert", "novice", "trigger_happy", "passive", "random"] as const;
export type BotName = (typeof BOT_NAMES)[number];

/**
 * Reaction latency in ticks, per bot.
 *
 * A trainee who classifies in the same tick the cue appears has not looked at it.
 * These are deliberately coarse — the scorer measures detection latency in seconds
 * against a par, so what matters is that the spread brackets the pars rather than
 * that it is finely tuned.
 */
export const REACTION_TICKS: Record<BotName, number> = {
  expert: 2,
  novice: 10,
  trigger_happy: 2,
  passive: 40,
  random: 8,
};

/** Fraction of the time a bot checks its scope instead of acting on the last cue. */
export const ATTENTION: Record<BotName, number> = {
  expert: 0.95,
  novice: 0.7,
  trigger_happy: 1,
  passive: 0.25,
  random: 0.5,
};

/**
 * Probability a bot honours a track's multi-sensor requirement before calling it.
 *
 * The single most important skill difference in the trainer: a call on one weak
 * source is an unsupported claim, and the knowability model (§9.4) exists precisely
 * to penalise it.
 */
export const CORROBORATION_DISCIPLINE: Record<BotName, number> = {
  expert: 0.95,
  novice: 0.45,
  trigger_happy: 0.1,
  passive: 0.2,
  random: 0.25,
};

/**
 * Probability a bot asks for authority before acting.
 *
 * `trigger_happy` is 0 by design — that is what makes it produce UNAUTHORISED
 * events, which the M3 DoD requires.
 */
export const AUTHORITY_DISCIPLINE: Record<BotName, number> = {
  expert: 0.98,
  novice: 0.5,
  trigger_happy: 0,
  passive: 0.3,
  random: 0.3,
};

/** Probability a bot reports a track up the chain after classifying it. */
export const REPORT_DISCIPLINE: Record<BotName, number> = {
  expert: 0.9,
  novice: 0.55,
  trigger_happy: 0.4,
  passive: 0.15,
  random: 0.3,
};

/** Probability a bot issues a warning before an expected impact. */
export const WARN_DISCIPLINE: Record<BotName, number> = {
  expert: 0.85,
  novice: 0.35,
  trigger_happy: 0.2,
  passive: 0.05,
  random: 0.15,
};

/**
 * How a bot picks a category from what it can see.
 *
 * The bots never read `correct_category` — that is the answer key. They reason
 * from the view exactly as a trainee would, which is what makes their scores
 * meaningful. `expert` reads the corroboration the track actually has; the weaker
 * bots guess, more often.
 */
export const categoryFor = (
  view: TraineeView,
  track_id: string,
  rng: BotRng,
  discipline: number,
): { category: "unknown" | "suspicious" | "hostile"; confidence: "low" | "medium" | "high" } => {
  const track = view.tracks.find((t) => t.track_id === track_id);
  if (!track) return { category: "unknown", confidence: "low" };

  if (rng.chance(discipline)) {
    // Reasoned path: a corroborated, measured, confident track supports a call.
    const strong = track.sources.length >= 2 && track.confidence >= 0.5;
    if (strong) return { category: "hostile", confidence: "high" };
    if (track.confidence >= 0.3) return { category: "suspicious", confidence: "medium" };
    return { category: "unknown", confidence: "low" };
  }

  // Undisciplined path: guess. Overconfident guessing is the error the
  // knowability model is built to catch, so it is worth a bot doing it.
  return rng.chance(0.5)
    ? { category: "hostile", confidence: "high" }
    : { category: "unknown", confidence: "low" };
};

/** Tracks a bot has not yet classified, in stable id order. */
export const unclassified = (view: TraineeView, done: ReadonlySet<string>): string[] =>
  view.tracks.filter((t) => !done.has(t.track_id)).map((t) => t.track_id);

/** Tracks the bot believes are threats: classified hostile or suspicious. */
export const believedThreats = (view: TraineeView, belief: ReadonlyMap<string, string>): string[] =>
  view.tracks
    .filter((t) => belief.get(t.track_id) === "hostile" || belief.get(t.track_id) === "suspicious")
    .map((t) => t.track_id);

/** True once every cue has been acted on. */
export const cuesCleared = (turn: BotTurn): boolean => turn.view.pending_cues.length === 0;

/** Build a policy that defers to a per-tick function. Keeps tests small. */
export const policy = (fn: (turn: BotTurn, rng: BotRng) => void) => (seed: number) => {
  const rng = createBotRng(seed);
  return (turn: BotTurn): void => fn(turn, rng);
};
