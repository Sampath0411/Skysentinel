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
  BRIEF_DISCIPLINE,
  CORROBORATION_DISCIPLINE,
  REACTION_TICKS,
  REPORT_DISCIPLINE,
  WARN_DISCIPLINE,
  type BotRng,
  categoryFor,
  createBotRng,
  isThreatCategory,
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
  /** Track id → whether this bot will report it at all. Drawn once, not per tick. */
  will_report: Map<string, boolean>;
  /** Track id → whether this bot will warn on it. Drawn once, not per tick. */
  will_warn: Map<string, boolean>;
  /** Whether the mission brief has been opened this run. */
  briefed: boolean;
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
  will_report: new Map(),
  will_warn: new Map(),
  briefed: false,
});

/**
 * Draw a bot's willingness to do an obligation on a track — once, and remember it.
 *
 * This was `rng.chance(p)` re-rolled on every tick, which made discipline a
 * per-tick coin flip rather than a property of the operator. The visible symptom:
 * `passive` gets about ten decision ticks on a track it is working, so a
 * probability of 0.35 resolved to "declined" for most tracks it ever touched, and
 * it finished runs having reported nothing at all — which is not passivity, it is
 * muteness, and it made the bot score below the pure-noise control.
 *
 * Drawn once per track instead, the number means what the rubric tables say it
 * means: the share of contacts this operator bothers to pass up the chain. The draw
 * still comes from the seeded RNG, so runs stay reproducible.
 */
const commits = (cache: Map<string, boolean>, m_rng: BotRng, id: string, p: number): boolean => {
  const cached = cache.get(id);
  if (cached !== undefined) return cached;
  const yes = m_rng.chance(p);
  cache.set(id, yes);
  return yes;
};

/** Mark any newly-pending cues. Returns true if anything was marked. */
const takeCues = (turn: BotTurn, m: Memory): void => {
  for (const cue_id of turn.view.pending_cues) {
    if (m.marked.has(cue_id)) continue;
    if (turn.controls.markContact(cue_id)) m.marked.add(cue_id);
  }
};

/**
 * Open the mission brief, if this bot has the discipline to.
 *
 * Attempted once, before any contact is worked. N4 and N9 score whether the brief
 * was read before deciding, so a bot that reads it *after* its first declaration
 * is not credited — and it is worth modelling that ordering, because a brief read
 * after the decision has already been made is exactly the failure the rubric is
 * built to catch.
 */
const takeBrief = (turn: BotTurn, m: Memory, rng: BotRng, p: number): void => {
  if (m.briefed) return;
  if (!rng.chance(p)) return;
  if (turn.controls.viewBrief()) m.briefed = true;
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
 * Has this bot finished with a track, counting a track it has no reason to act on?
 *
 * The obvious reading of "finished" is "acted on", and that is wrong. A competent
 * operator classifies the friendly flight, decides there is nothing to do about it,
 * and moves to the next contact — it does not stand on the friendly for the rest
 * of the mission. Reading it as "acted on" meant `expert` held focus on the
 * deconfliction scenario's friendly from t=0 to t=175 s, and responded to the
 * protected-asset threat 145 s after the rubric's par. The bot that models good
 * practice was teaching bad prioritisation.
 */
const isWorked = (m: Memory, id: string): boolean =>
  m.acted.has(id) || (m.declared.has(id) && !isThreatCategory(m.declared.get(id)));

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
    // Before the cues, not after: the brief is meant to be read first.
    takeBrief(turn, m, rng, BRIEF_DISCIPLINE.expert);
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
    const id = nextTrack(turn.view, m, (x) => refused(x) || isWorked(m, x));
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
      isThreatCategory(m.declared.get(id)) &&
      !m.requested.has(id) &&
      !turn.view.authority.granted.includes(id) &&
      rng.chance(AUTHORITY_DISCIPLINE.expert) &&
      turn.controls.requestAuthority(id)
    ) {
      m.requested.add(id);
    }
    // Granted authority plus a reason to use it. Authority to respond is not a
    // licence to respond to anything: the bot must have concluded the contact is a
    // threat first, or a deconfliction scenario has `expert` engaging listed
    // traffic it just correctly identified as authorised.
    if (
      turn.view.authority.granted.includes(id) &&
      !m.acted.has(id) &&
      isThreatCategory(m.declared.get(id))
    ) {
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
    takeBrief(turn, m, rng, BRIEF_DISCIPLINE.novice);
    takeCues(turn, m);

    /** Requested and neither pending nor granted: the answer was no. */
    const refused = (id: string): boolean =>
      m.requested.has(id) &&
      !turn.view.authority.granted.includes(id) &&
      !turn.view.authority.pending.includes(id);

    if (ticks % REACTION_TICKS.novice !== 0 && !rng.chance(ATTENTION.novice)) return;

    const id = nextTrack(turn.view, m, (x) => refused(x) || isWorked(m, x));
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
      isThreatCategory(m.declared.get(id)) &&
      !m.requested.has(id) &&
      !turn.view.authority.granted.includes(id) &&
      rng.chance(AUTHORITY_DISCIPLINE.novice) &&
      turn.controls.requestAuthority(id)
    ) {
      m.requested.add(id);
    }
    // Acts on the granted authority when it has it, and on nothing when it does not.
    // Gated on the bot's own belief rather than ungated like `trigger_happy`: a
    // novice forgets to corroborate, not to notice what it just called the contact.
    if (
      turn.view.authority.granted.includes(id) &&
      !m.acted.has(id) &&
      isThreatCategory(m.declared.get(id))
    ) {
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
    // `BRIEF_DISCIPLINE.trigger_happy` is 0, so this is a draw that never lands:
    // the profile goes straight to the scope without reading the brief. Attempted
    // rather than skipped so the discipline is expressed as behaviour, not as an
    // absence of code.
    takeBrief(turn, m, rng, BRIEF_DISCIPLINE.trigger_happy);
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

    // Acts on the freshest track it has not yet acted on, authorised or not — and
    // deliberately ungated on its own belief, unlike every other policy. Responding
    // to a contact it cannot justify responding to, before any authority exists, is
    // the whole failure this bot exists to produce (PRD §10.5).
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

    // Contacts are still marked — noticing is not the problem. The brief is read
    // too: passive is careful and slow, which is a different failure from
    // trigger_happy's careless and fast.
    takeBrief(turn, m, rng, BRIEF_DISCIPLINE.passive);
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
    takeBrief(turn, m, rng, BRIEF_DISCIPLINE.random);
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
      isThreatCategory(m.declared.get(id)) &&
      !m.requested.has(id) &&
      !turn.view.authority.granted.includes(id) &&
      rng.chance(AUTHORITY_DISCIPLINE.random) &&
      turn.controls.requestAuthority(id)
    ) {
      m.requested.add(id);
    }
    // Acts on tracks it believes are threats, as the profile's contract says. The
    // randomness that matters is *which* tracks those are and *when*, not that it
    // engages friendly traffic — the latter is trigger_happy's error, and having two
    // bots commit it would make the control condition indistinguishable.
    if (!m.acted.has(id) && isThreatCategory(m.declared.get(id)) && rng.chance(0.4)) {
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
 *
 * `activity` and `description` are derived from what the bot actually concluded, so
 * the report agrees with the declaration it is reporting. A bot that sent a
 * placeholder in those fields would be scored for having withheld a judgement, which
 * is a different (and separately taught) failure from reporting badly.
 */
const report2 = (turn: BotTurn, m: Memory, rng: BotRng, id: string, p: number): void => {
  if (m.reported.has(id)) return;
  if (!commits(m.will_report, rng, id, p)) return;
  const track = turn.view.tracks.find((t) => t.track_id === id);
  const belief = m.declared.get(id) ?? "unknown";
  turn.controls.report({
    track_id: id,
    quantity: 1,
    activity: ACTIVITY_BY_CATEGORY[belief] ?? "unknown",
    description: `single airborne contact, bearing ${Math.round(track?.bearing_deg ?? 0)}`,
    ...(track ? { bearing_deg: track.bearing_deg } : {}),
    ...(track?.range_m !== undefined ? { range_m: track.range_m } : {}),
  });
  m.reported.add(id);
};

/**
 * The activity a bot reports for each category it can declare.
 *
 * Plain functional descriptions rather than the scenarios' `intent` strings: those
 * are the answer key, and a bot that echoed them would be reading truth. The scorer
 * does not check these for correctness (D24) — what it checks is that a judgement
 * was offered rather than passed back up the chain.
 */
const ACTIVITY_BY_CATEGORY: Record<string, string> = {
  hostile: "uncoordinated inbound",
  suspicious: "unidentified, uncoordinated",
  authorised: "published flight plan, authorised",
  friendly: "recognised friendly flight",
  non_uas: "assessed as non-c UAS",
  unknown: "unable to assess",
};

/** Issue a warning on a track the bot believes is a threat. */
const warn2 = (turn: BotTurn, m: Memory, rng: BotRng, id: string, p: number): void => {
  if (m.warned.has(id)) return;
  const belief = m.declared.get(id);
  if (!isThreatCategory(belief)) return;
  if (!commits(m.will_warn, rng, id, p)) return;
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
