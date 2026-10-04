/**
 * N4, N8, N9, N10: coordination, prioritisation and recovery (PRD §10.3).
 *
 * The three non-mandated dimensions, plus the brief-consultation node. They carry
 * 20 of the 100 points between them, so they are deliberately blunt: they measure
 * whether the trainee did the coordination-shaped thing at all, not how elegantly.
 *
 * N8 (prioritisation) is the awkward one. "Did attention go to the main effort"
 * needs an ordering to compare against, and there is no single source of truth for
 * which contact is the main effort in a swarm. The rule here is therefore one the
 * scenario decides: `expected.protect` names the assets that matter, and priority is
 * scored as *which track was engaged first, relative to which one threatened a
 * protected asset*. A trainee who acts on the decoy first and the real one second
 * loses points, and the reason string says which was which.
 */

import type { ClassificationCategory } from "@skysentinel/shared";
import { clamp } from "@skysentinel/shared";

import { criticalPenalty } from "../rubric.js";
import type { Rubric } from "../generated/rubric.js";
import type { ActionFact, RunFacts, TrackFacts } from "../log.js";
import type { CriticalErrorResult, NodeResult } from "../types.js";

const round2 = (v: number): number => Math.round(v * 100) / 100;

/** Does this contact threaten something the scenario told us to protect? */
const threatens_protected = (f: TrackFacts): boolean => {
  if (f.entity.affiliation_truth !== "hostile") return false;
  // With no spatial link in the log between a track and an asset, the defensible
  // test is intent: a `payload` or `strike` intent is what threatens an asset.
  // Declaring everything a threat would make this node meaningless.
  const threatening_intents = ["payload", "strike", "attack", "assault"];
  return threatening_intents.some((i) => f.entity.intent.toLowerCase().includes(i));
};

/**
 * The first action on this track, or `undefined` if it was never acted on.
 *
 * The whole fact rather than just the time: N8 needs the time to order the tracks
 * and the `seq` to reference the event, and returning one without the other is
 * how a `t_ms` ends up being emitted as an `event_ref` — a reference that points at
 * nothing.
 */
const firstAction = (f: TrackFacts): ActionFact | undefined =>
  f.actions.length > 0
    ? f.actions.reduce((a, b) => (b.t_ms < a.t_ms ? b : a))
    : undefined;

const firstActionMs = (f: TrackFacts): number | undefined => firstAction(f)?.t_ms;

/** First classification time, used when a track was judged but never acted on. */
const firstAttentionMs = (f: TrackFacts): number | undefined => {
  const acts = f.actions.map((a) => a.t_ms);
  const decls = f.declarations.map((d) => d.t_ms);
  const all = [...acts, ...decls];
  return all.length > 0 ? Math.min(...all) : undefined;
};

/** N4: was the brief or flight plan consulted before the first classification? */
export const scoreBriefConsulted = (facts: RunFacts): NodeResult => {
  const first_decl_ms = facts.tracks
    .flatMap((f) => f.declarations.map((d) => d.t_ms))
    .sort((a, b) => a - b)[0];

  const viewed = facts.brief_viewed_ms;
  const consulted = viewed !== undefined && (first_decl_ms === undefined || viewed <= first_decl_ms);

  const sections = facts.brief_sections.length;

  return {
    id: "N4",
    label: "Brief and flight plan consulted",
    passed: consulted,
    points: consulted ? 0 : 0,
    max_points: 0,
    reason: consulted
      ? `Brief viewed at ${((viewed ?? 0) / 1000).toFixed(1)}s${sections > 0 ? ` (${sections} section${sections === 1 ? "" : "s"})` : ""}, before the first classification.`
      : viewed === undefined
        ? "Brief was never viewed."
        : first_decl_ms === undefined
          ? "Brief was viewed; no classification was made."
          : `Brief was viewed at ${(viewed / 1000).toFixed(1)}s, after the first classification at ${(first_decl_ms / 1000).toFixed(1)}s.`,
    event_refs: facts.brief_viewed_seq !== undefined ? [facts.brief_viewed_seq] : [],
  };
};

/** N8: did attention go to the real threat first? */
export const scorePrioritisation = (facts: RunFacts, protect: readonly string[]): NodeResult => {
  const engaging = facts.tracks.filter((f) => firstActionMs(f) !== undefined);
  if (engaging.length < 2) {
    return {
      id: "N8",
      label: "Threat prioritisation",
      passed: true,
      points: 0,
      max_points: 0,
      reason:
        engaging.length === 0
          ? "No track was acted on, so there is no action order to judge."
          : "Only one track was acted on, so no prioritisation decision was required.",
      event_refs: [],
    };
  }

  const ordered = [...engaging].sort((a, b) => firstActionMs(a)! - firstActionMs(b)!);
  const first = ordered[0]!;

  // The threat that mattered, as the scenario defines it.
  const real = ordered.find((f) => threatens_protected(f));
  if (!real) {
    return {
      id: "N8",
      label: "Threat prioritisation",
      passed: true,
      points: 0,
      max_points: 0,
      reason: `No acted-on track matched a protected-asset threat, so there was no main effort to prioritise (protected: ${protect.join(", ") || "none named"}).`,
      event_refs: [firstAction(ordered[0]!)!.seq],
    };
  }

  if (first.truth_id === real.truth_id) {
    return {
      id: "N8",
      label: "Threat prioritisation",
      passed: true,
      points: 100,
      max_points: 100,
      reason: `Main-effort track ${real.truth_id} (${real.entity.intent}) was the first acted on, ahead of ${ordered.length - 1} other${ordered.length === 2 ? "" : "s"}.`,
      event_refs: [firstAction(real)!.seq],
    };
  }

  // Wrong first. Partial credit scales with how long the trainee then took to
  // reach the real one — noticing late is better than never.
  const real_ms = firstActionMs(real)!;
  const delay_s = (real_ms - firstActionMs(first)!) / 1000;
  const points = round2(Math.max(0, 100 - delay_s * 2));

  return {
    id: "N8",
    label: "Threat prioritisation",
    passed: points > 0,
    points,
    max_points: 100,
    reason: `${first.truth_id} (${first.entity.intent}) was acted on first; the protected-asset threat ${real.truth_id} came ${delay_s.toFixed(1)}s later.`,
    event_refs: [firstAction(first)!.seq, firstAction(real)!.seq],
  };
};

/**
 * The most points N9 can award, read from the rubric rather than assumed to be 100.
 *
 * The rubric expresses coordination as three independent credits that do not sum to
 * 100 (brief + owner + update). Normalising against a hardcoded 100 would cap every
 * perfectly coordinated run at the ceiling — a rubric author adding a fourth credit
 * would see coordination scores fall without changing any behaviour. So the ceiling
 * is derived from the same data that awards the credits, and the two cannot drift.
 */
export const coordinationCeiling = (rubric: Rubric): number => {
  const c = rubric.coordination;
  return c.brief_credit + c.owner_assigned_credit + c.cop_update_credit;
};

/** N9: was ownership assigned and the picture updated? */
export const scoreCoordination = (facts: RunFacts, rubric: Rubric): NodeResult => {
  const c = rubric.coordination;
  const assigned = facts.tracks.filter((f) => f.actions.some((a) => a.action === "assign_track_owner"));
  const cop_updates = facts.tracks.filter((f) => f.reports.length > 1);
  const brief_ok = facts.brief_viewed_ms !== undefined;

  const parts: string[] = [];
  let raw = 0;

  if (brief_ok) {
    raw += c.brief_credit;
    parts.push("brief viewed");
  } else {
    raw -= c.brief_not_viewed_penalty;
    parts.push("brief not viewed");
  }

  if (assigned.length > 0) {
    raw += c.owner_assigned_credit;
    parts.push(`owner assigned on ${assigned.length} track${assigned.length === 1 ? "" : "s"}`);
  }

  if (cop_updates.length > 0) {
    raw += c.cop_update_credit;
    parts.push(`picture updated on ${cop_updates.length} track${cop_updates.length === 1 ? "" : "s"}`);
  }

  const ceiling = coordinationCeiling(rubric);
  // The not-viewed penalty can drive the raw total negative; that is the rubric's
  // intent, so it clamps at zero rather than being normalised against the ceiling.
  const score = round2(clamp((raw / ceiling) * 100, 0, 100));

  // Cite the events the credits came from, so a non-zero N9 always points at
  // something the AAR can show (PRD §10.7: every score must be interrogable).
  const refs: number[] = [];
  const owner_event = assigned[0]?.actions.find((a) => a.action === "assign_track_owner");
  if (owner_event) refs.push(owner_event.seq);
  const update_report = cop_updates[0]?.reports[1];
  if (update_report) refs.push(update_report.seq);
  if (brief_ok && facts.brief_viewed_seq !== undefined) refs.push(facts.brief_viewed_seq);

  return {
    id: "N9",
    label: "Coordination and deconfliction",
    passed: score > 0,
    points: score,
    max_points: 100,
    reason: `${parts.join("; ")}.`,
    event_refs: refs,
  };
};

/** N10: after a loss or an outage, how quickly was the picture rebuilt? */
export const scoreRecovery = (facts: RunFacts, rubric: Rubric): NodeResult => {
  const a = rubric.adaptation;
  const recoveries = facts.tracks
    .filter((f) => f.track_lost_seq !== undefined && f.track_reacquired_seq !== undefined)
    .map((f) => ({ f, ms: reacquireDelay(f) }))
    .filter((r): r is { f: TrackFacts; ms: number } => r.ms !== undefined);

  const outages = facts.tracks.filter(
    (f) => f.track_lost_seq !== undefined && f.track_reacquired_seq === undefined,
  );

  if (recoveries.length === 0 && outages.length === 0) {
    return {
      id: "N10",
      label: "Adaptation and recovery",
      passed: true,
      points: 0,
      max_points: 0,
      reason: "No track was lost during this run, so there was nothing to recover from.",
      event_refs: [],
    };
  }

  if (recoveries.length === 0) {
    return {
      id: "N10",
      label: "Adaptation and recovery",
      passed: false,
      points: a.reacquire_zero_credit,
      max_points: 100,
      reason: `${outages.length} track${outages.length === 1 ? " was" : "s were"} lost and never reacquired.`,
      event_refs: outages.map((f) => f.track_lost_seq!),
    };
  }

  const worst = recoveries.reduce((a, b) => (b.ms > a.ms ? b : a));
  const t = Math.min(1, worst.ms / a.reacquire_par_ms);
  const points = round2(a.reacquire_full_credit + t * (a.reacquire_zero_credit - a.reacquire_full_credit));

  return {
    id: "N10",
    label: "Adaptation and recovery",
    passed: points >= a.reacquire_full_credit,
    points,
    max_points: 100,
    reason: `Slowest reacquisition took ${(worst.ms / 1000).toFixed(1)}s against a ${(a.reacquire_par_ms / 1000).toFixed(1)}s par.`,
    event_refs: [worst.f.track_lost_seq!, worst.f.track_reacquired_seq!],
  };
};

/** Reacquisition delay in ms, from the events themselves rather than seq spacing. */
const reacquireDelay = (f: TrackFacts): number | undefined => {
  const lost = f.track_lost_ms;
  const regained = f.track_reacquired_ms;
  if (lost === undefined || regained === undefined) return undefined;
  return regained - lost;
};

/**
 * Critical errors that are not N7's: a hostile or suspicious contact that was never
 * marked at all is a MISSED_THREAT, and a hostile that reached an asset without a
 * warning is a NO_WARNING_BEFORE_IMPACT (PRD §10.5).
 */
export const collectCritical = (
  facts: RunFacts,
  rubric: Rubric,
): CriticalErrorResult[] => {
  const out: CriticalErrorResult[] = [];

  for (const f of facts.tracks) {
    const hostile_or_suspicious =
      f.entity.affiliation_truth === "hostile" || f.expected?.correct_category.includes("suspicious");

    if (hostile_or_suspicious && f.marked_ms === undefined && Number.isFinite(f.first_cue_ms)) {
      out.push({
        kind: "MISSED_THREAT",
        penalty: criticalPenalty(rubric, "MISSED_THREAT"),
        reason: `${f.truth_id} (${f.entity.intent}) produced a credible cue at ${(f.first_cue_ms / 1000).toFixed(1)}s that was never marked.`,
        event_refs: f.first_cue_seq !== undefined ? [f.first_cue_seq] : [],
        truth_id: f.truth_id,
      });
    }
  }

  // NO_WARNING_BEFORE_IMPACT: an impact occurred and no track warned for it.
  if (facts.impact_count > 0) {
    const warned = facts.tracks.some((f) =>
      f.actions.some((a) => a.action === "issue_warning" || a.action === "activate_protective_drill"),
    );
    if (!warned) {
      out.push({
        kind: "NO_WARNING_BEFORE_IMPACT",
        penalty: criticalPenalty(rubric, "NO_WARNING_BEFORE_IMPACT"),
        reason: `${facts.impact_count} impact${facts.impact_count === 1 ? "" : "s"} occurred and no warning or protective drill was ever raised.`,
        event_refs: facts.impacts.map((i) => i.seq),
      });
    }
  }

  // IGNORED_FLIGHT_PLAN: a friendly contact was escalated without the brief.
  if (facts.brief_viewed_ms === undefined) {
    const escalated = facts.tracks.find(
      (f) => f.entity.affiliation_truth === "friendly" &&
        f.actions.some((a) => a.action === "execute_response" || a.action === "issue_warning"),
    );
    if (escalated) {
      out.push({
        kind: "IGNORED_FLIGHT_PLAN",
        penalty: criticalPenalty(rubric, "IGNORED_FLIGHT_PLAN"),
        reason: `${escalated.truth_id} was a friendly flight but was escalated, with the brief never consulted.`,
        event_refs: [
          escalated.actions.find(
            (a) => a.action === "execute_response" || a.action === "issue_warning",
          )!.seq,
        ],
        truth_id: escalated.truth_id,
      });
    }
  }

  return out;
};

export { threatens_protected, firstAttentionMs };
export type { ClassificationCategory };