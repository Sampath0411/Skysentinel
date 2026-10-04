/**
 * The five bot policies (PRD §14 M3).
 *
 * Each is a *competence profile* over the same loop rather than a different loop:
 * all of them use the same `TraineeControls` and the same truth-free view, so a
 * difference in the resulting score is always attributable to a difference in
 * decision-making. That is the property M4's score-ordering assertion relies on.
 *
 * Every policy is a factory: `(seed) => BotPolicy`. The seed makes even the erratic
 * `random` policy reproducible, which is what lets bot sessions be regression
 * fixtures (DECISIONS.md D18).
 */

import type { Millis } from "@skysentinel/shared";
import type { BotPolicy, BotTurn, TraineeView } from "@skysentinel/sim-core";

import {
  ATTENTION,
  AUTHORITY_DISCIPLINE,
  CORROBORATION_DISCIPLINE,
  REACTION_TICKS,
  REPORT_DISCIPLINE,
  WARN_DISCIPLINE,
  type BotRng,
  categoryFor,
  createBotRng,
  type BotName,
} from "./policy.js";

/**
 * Per-bot working state.
 *
 * A bot needs to remember what it has already done — a cue marked twice is a
 * spurious contact, and a track classified twice is a reclassification, which the
 * scorer penalises differently. So each policy closes over this rather than
 * recomputing from the log every tick.
 */
interface Memory {
  /** Cue ids already marked. */
  marked: Set<string>;
  /** Track ids already classified, mapped to the category declared. */
  declared: Map<string, string>;
  /** Track ids warned. */
  warned: Set<string>;
  /** Track ids acted on with a response. */
  acted: Set<string>;
  /** Track ids reported. */
  reported: Set<string>;
  /** Track ids authority was requested for. One request per track, by design. */
  requested: Set<string>;
  /** Track id → sim time it was first acted on, for latency. */
  first_action: Map<string, Millis>;
  /** The track currently being worked. Held until the bot is done with it. */
  focus?: string;
}

const memory = (): Memory => ({
  marked: new Set(),
  declared: new Map(),
  warned: new Set(),
  acted: new Set(),
  reported: new Set(),
  requested: new Set(),
  first_action: new Map(),
});

/** Mark any newly-pending cues. Returns true if anything was marked. */
const takeCues = (turn: BotTurn, m: Memory): void => {
  for (const cue_id of turn.view.pending_cues) {
    if (m.marked.has(cue_id)) continue;
    if (turn.controls.markContact(cue_id)) m.marked.add(cue_id);
  }
};

/**
 * Choose the track to work on: one already in hand, else the best-supported new one.
 *
 * The `focus` field is what makes a bot behave like an operator rather than a
 * breadth-first queue. Picking only ever-new tracks means a bot never finishes the
 * job on any of them — an earlier version requested authority fifteen times and
 * never once acted on the grant, because every tick it moved to a fresher track.
 * Holding focus until the track is acted on (or is gone) is what makes the
 * request-then-respond sequence observable at all.
 */
const nextTrack = (
  view: TraineeView,
  m: Memory,
  isFinished: (id: string) => boolean,
): string | undefined => {
  // Stay on the current track while it still exists and is unfinished.
  if (m.focus && view.tracks.some((t) => t.track_id === m.focus) && !isFinished(m.focus)) {
    return m.focus;
  }
  const candidates = view.tracks.filter((t) => !isFinished(t.track_id));
  if (candidates.length === 0) return undefined;
  m.focus = [...candidates].sort(
    (a, b) => b.sources.length - a.sources.length || b.confidence - a.confidence,
  )[0]!.track_id;
  return m.focus;
};

/**
 * `expert` — the reference competent trainee.
 *
 * Behaviour, in the order a competent operator actually works:
 *   1. Mark contacts.
 *   2. Wait for corroboration before calling, so declarations are supportable.
 *   3. Declare confidence that matches the evidence rather than the pressure.
 *   4. Report, warn, then request authority — never the reverse.
 *   5. Act only once authority has actually been granted.
 *
 * It still takes a couple of ticks to react. A bot that classified in the same
 * tick a cue appeared would score a detection time of zero and make the par in the
 * rubric meaningless.
 */
export const expertPolicy = (seed: number): BotPolicy => {
  const m = memory();
  const rng = createBotRng(seed);
  let ticks = 0;

  return (turn: BotTurn): void => {
    ticks++;
    if (turn.view.over) return;
    takeCues(turn, m);

    /** Requested and neither pending nor granted: the answer was no. */
    const refused = (id: string): boolean =>
      m.requested.has(id) &&
      !turn.view.authority.granted.includes(id) &&
      !turn.view.authority.pending.includes(id);

    // One decision per `REACTION_TICKS` — attention gating stands in for the
    // human working rhythm, and keeps the loop from being a per-tick automaton.
    if (ticks % REACTION_TICKS.expert !== 0 && !rng.chance(ATTENTION.expert)) return;

    // Hold the track while authority is outstanding, but let it go once the request
    // has come back refused: an operator who has been denied does not stand and
    // re-request every tick, and a bot that did would flood the event log and
    // never get to the next track.
    const id = nextTrack(turn.view, m, (x) => m.acted.has(x) || refused(x));
    if (!id) return;
    const track = turn.view.tracks.find((t) => t.track_id === id);
    if (!track) return;

    // Withhold a call until two sources agree, unless the track is already strong.
    const corroborated = track.sources.length >= 2 || track.confidence >= 0.6;
    if (!corroborated) return;

    if (!m.declared.has(id)) {
      const call = categoryFor(turn.view, id, rng, CORROBORATION_DISCIPLINE.expert);
      turn.controls.classify({ track_id: id, category: call.category, confidence: call.confidence });
      m.declared.set(id, call.category);
      m.first_action.set(id, turn.view.t_ms);
    }

    // Every obligation runs, every tick. They are independent duties on one track,
    // not a sequence to be short-circuited: an earlier version returned after the
    // first one that fired, which starved the authority request for most of the run
    // and left the most rule-respecting bot as the least rule-abiding.
    report2(turn, m, rng, id, REPORT_DISCIPLINE.expert);
    warn2(turn, m, rng, id, WARN_DISCIPLINE.expert);

    // Ask for authority once, then wait for it. `authority.pending` and `granted`
    // come from the harness, so the bot cannot assume its own request was granted.
    if (
      !m.requested.has(id) &&
      !turn.view.authority.granted.includes(id) &&
      rng.chance(AUTHORITY_DISCIPLINE.expert) &&
      turn.controls.requestAuthority(id)
    ) {
      m.requested.add(id);
    }
    if (turn.view.authority.granted.includes(id) && !m.acted.has(id)) {
      turn.controls.act("execute_response", { track_id: id });
      m.acted.add(id);
    }
  };
};

/**
 * `novice` — plausible but unrehearsed.
 *
 * Acts on the first cue it sees, declares at whatever the evidence feels like, and
 * forgets to corroborate. Crucially it *usually* asks for authority: a novice who
 * breaks rules is a different lesson from one who is merely slow, and having only
 * the latter makes `trigger_happy` a caricature.
 */
export const novicePolicy = (seed: number): BotPolicy => {
  const m = memory();
  const rng = createBotRng(seed);
  let ticks = 0;

  return (turn: BotTurn): void => {
    ticks++;
    if (turn.view.over) return;
    takeCues(turn, m);

    /** Requested and neither pending nor granted: the answer was no. */
    const refused = (id: string): boolean =>
      m.requested.has(id) &&
      !turn.view.authority.granted.includes(id) &&
      !turn.view.authority.pending.includes(id);

    if (ticks % REACTION_TICKS.novice !== 0 && !rng.chance(ATTENTION.novice)) return;

    const id = nextTrack(turn.view, m, (x) => m.acted.has(x) || refused(x));
    if (!id) return;

    if (!m.declared.has(id)) {
      const call = categoryFor(turn.view, id, rng, CORROBORATION_DISCIPLINE.novice);
      turn.controls.classify({ track_id: id, category: call.category, confidence: call.confidence });
      m.declared.set(id, call.category);
      m.first_action.set(id, turn.view.t_ms);
    }

    report2(turn, m, rng, id, REPORT_DISCIPLINE.novice);
    warn2(turn, m, rng, id, WARN_DISCIPLINE.novice);

    if (
      !m.requested.has(id) &&
      !turn.view.authority.granted.includes(id) &&
      rng.chance(AUTHORITY_DISCIPLINE.novice) &&
      turn.controls.requestAuthority(id)
    ) {
      m.requested.add(id);
    }
    // Acts on the granted authority when it has it, and on nothing when it does not.
    if (turn.view.authority.granted.includes(id) && !m.acted.has(id)) {
      turn.controls.act("execute_response", { track_id: id });
      m.acted.add(id);
    }
  };
};

/**
 * `trigger_happy` — the deliberate failure case (M3 DoD).
 *
 * It never corroborates and never asks for authority, so on any scenario with a
 * friendly or civil entity in the flight plan it produces FRATRICIDE or
 * UNAUTHORISED events. That is the point: these are the two critical errors a
 * counter-UAS operator can make that no amount of correct classification excuses,
 * and they are only teachable if the trainer can reproduce them reliably.
 *
 * SAFETY: "trigger happy" here means *acting without the required authority and
 * without corroboration*. It resolves through `resolveResponse` like any other
 * action, with fictional effectiveness numbers. It encodes no real tactic.
 */
export const triggerHappyPolicy = (seed: number): BotPolicy => {
  const m = memory();
  const rng = createBotRng(seed);
  let ticks = 0;

  return (turn: BotTurn): void => {
    ticks++;
    if (turn.view.over) return;
    takeCues(turn, m);
    if (ticks % REACTION_TICKS.trigger_happy !== 0) return;

    const id = nextTrack(turn.view, m, (x) => m.acted.has(x));
    if (!id) return;

    // No authority request, ever. This is the error being taught.
    if (!m.declared.has(id)) {
      const call = categoryFor(turn.view, id, rng, CORROBORATION_DISCIPLINE.trigger_happy);
      turn.controls.classify({ track_id: id, category: call.category, confidence: call.confidence });
      m.declared.set(id, call.category);
      m.first_action.set(id, turn.view.t_ms);
    }

    report2(turn, m, rng, id, REPORT_DISCIPLINE.trigger_happy);
    warn2(turn, m, rng, id, WARN_DISCIPLINE.trigger_happy);

    // Acts on the freshest track it has not yet acted on, authorised or not.
    turn.controls.act("execute_response", { track_id: id });
    m.acted.add(id);
  };
};

/**
 * `passive` — observes, reports little, acts almost never.
 *
 * Not a strawman: this is the most common real failure mode in the field, and the
 * trainer exists to make its cost legible. A passive operator scores near zero on
 * response while scoring respectably on detection, which is precisely the profile
 * an assessment should surface rather than hide behind a single total.
 */
export const passivePolicy = (seed: number): BotPolicy => {
  const m = memory();
  const rng = createBotRng(seed);
  let ticks = 0;

  return (turn: BotTurn): void => {
    ticks++;
    if (turn.view.over) return;
    if (!rng.chance(ATTENTION.passive)) return;
    if (ticks % REACTION_TICKS.passive !== 0) return;

    // Contacts are still marked — noticing is not the problem.
    takeCues(turn, m);

    const id = nextTrack(turn.view, m, (x) => m.declared.has(x));
    if (!id) return;
    if (!m.declared.has(id)) {
      // Declares `unknown`, which the knowability model rewards as the honest call
      // on weak evidence. Passive is not dishonest; it is slow.
      turn.controls.classify({ track_id: id, category: "unknown", confidence: "low" });
      m.declared.set(id, "unknown");
      m.first_action.set(id, turn.view.t_ms);
    }

    report2(turn, m, rng, id, REPORT_DISCIPLINE.passive);
    warn2(turn, m, rng, id, WARN_DISCIPLINE.passive);
    // No response action. By design.
  };
};

/**
 * `random` — actions uncorrelated with evidence.
 *
 * Not a coin-flip parody: it declares a *random* category and confidence, reports
 * at random, and acts on tracks it believes are threats. This is the control
 * condition for the trainer — it establishes the score floor, so any real signal
 * in a score has to clear a baseline of pure noise.
 */
export const randomPolicy = (seed: number): BotPolicy => {
  const m = memory();
  const rng = createBotRng(seed);
  let ticks = 0;

  return (turn: BotTurn): void => {
    ticks++;
    if (turn.view.over) return;
    if (ticks % REACTION_TICKS.random !== 0) return;
    takeCues(turn, m);

    /** Requested and neither pending nor granted: the answer was no. */
    const refused = (id: string): boolean =>
      m.requested.has(id) &&
      !turn.view.authority.granted.includes(id) &&
      !turn.view.authority.pending.includes(id);

    const id = nextTrack(turn.view, m, (x) => m.declared.has(x) || refused(x));
    if (!id) return;

    if (!m.declared.has(id)) {
      const category = rng.pick(["friendly", "authorised", "unknown", "suspicious", "hostile", "non_uas"] as const);
      const confidence = rng.pick(["low", "medium", "high"] as const);
      turn.controls.classify({ track_id: id, category, confidence });
      m.declared.set(id, category);
      m.first_action.set(id, turn.view.t_ms);
    }

    report2(turn, m, rng, id, REPORT_DISCIPLINE.random);
    warn2(turn, m, rng, id, WARN_DISCIPLINE.random);

    if (
      !m.requested.has(id) &&
      !turn.view.authority.granted.includes(id) &&
      rng.chance(AUTHORITY_DISCIPLINE.random) &&
      turn.controls.requestAuthority(id)
    ) {
      m.requested.add(id);
    }
    if (!m.acted.has(id) && rng.chance(0.4)) {
      turn.controls.act("execute_response", { track_id: id });
      m.acted.add(id);
    }
  };
};

/**
 * Report a track up the chain.
 *
 * Returns nothing on purpose. These obligations are independent per tick, and an
 * earlier version returned a boolean the caller used to `return` early — which
 * meant a high-discipline step like reporting silently starved every step after it.
 */
const report2 = (turn: BotTurn, m: Memory, rng: BotRng, id: string, p: number): void => {
  if (m.reported.has(id)) return;
  if (!rng.chance(p)) return;
  const track = turn.view.tracks.find((t) => t.track_id === id);
  turn.controls.report({
    track_id: id,
    quantity: 1,
    ...(track ? { bearing_deg: track.bearing_deg } : {}),
    ...(track?.range_m !== undefined ? { range_m: track.range_m } : {}),
  });
  m.reported.add(id);
};

/** Issue a warning on a track the bot believes is a threat. */
const warn2 = (turn: BotTurn, m: Memory, rng: BotRng, id: string, p: number): void => {
  if (m.warned.has(id)) return;
  const belief = m.declared.get(id);
  if (belief !== "hostile" && belief !== "suspicious") return;
  if (!rng.chance(p)) return;
  turn.controls.act("issue_warning", { track_id: id });
  m.warned.add(id);
};

/** Factory table, keyed by the CLI's `--bot` value. */
export const POLICIES: Record<BotName, (seed: number) => BotPolicy> = {
  expert: expertPolicy,
  novice: novicePolicy,
  trigger_happy: triggerHappyPolicy,
  passive: passivePolicy,
  random: randomPolicy,
};

export const isBotName = (v: string): v is BotName =>
  (Object.keys(POLICIES) as string[]).includes(v);
