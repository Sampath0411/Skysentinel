/**
 * N7: response and authority decision (PRD §10.3, FR-SCR-5).
 *
 * The mandated dimension, and the safety-critical one. Two rules are absolute and
 * are enforced structurally here rather than as weights:
 *
 *   1. `execute_response` is only in the allowed set for the `hostile` band, and
 *      the rubric's schema refuses to load a rubric where that is otherwise true.
 *   2. `execute_response` requires prior granted authority. A violation is
 *      `UNAUTHORISED_ACTION`, a critical error, and scores zero for the node.
 *
 * Neither can be tuned away by editing weights. They are the product's safety
 * boundary (PRD §4) expressed as code, and CLAUDE.md is explicit that no LLM and no
 * rubric author may weaken them.
 */

import type { ClassificationCategory, ResponseAction } from "@skysentinel/shared";

import { criticalPenalty } from "../rubric.js";
import type { CriticalError, Rubric } from "../generated/rubric.js";
import type { TrackFacts } from "../log.js";
import type { CriticalErrorResult, NodeResult } from "../types.js";

const round2 = (v: number): number => Math.round(v * 100) / 100;

/** Actions that constitute a defensive posture rather than mere observation. */
const PROTECTIVE_ACTIONS: ResponseAction[] = [
  "issue_warning",
  "activate_protective_drill",
  "request_support",
];

/** Actions that do nothing to a closing threat. */
const OBSERVATION_ACTIONS: ResponseAction[] = ["continue_observe", "request_sensor_cue", "report"];

/** A category of truth that must never be responded to with force. */
const NEVER_ENGAGE: ClassificationCategory[] = ["friendly", "authorised", "non_uas"];

/**
 * The band a track's truth maps to for response purposes.
 *
 * Truth, not the trainee's declaration: N7 asks what *was* correct, and a
 * mis-declaration is already penalised at N5. Double-penalising the same error
 * here would make the score harder to reason about.
 */
export const truthBand = (f: TrackFacts): ClassificationCategory => {
  const a = f.entity.affiliation_truth;
  return a === "non_uas" ? "non_uas" : a;
};

/** Is `action` permitted against a track in `band`? */
export const isAllowed = (rubric: Rubric, band: ClassificationCategory, action: ResponseAction): boolean =>
  (rubric.response.allowed[band] ?? []).includes(action);

/** The severity of a single critical error raised while scoring N7. */
export interface CriticalFinding {
  kind: CriticalError;
  reason: string;
  seq: number;
}

/**
 * N7: score the response decision for one track.
 *
 * Returns the node and any critical errors it triggered. The two are kept
 * together because an unauthorised action is simultaneously "this track scored
 * zero" and "this run took a 25-point penalty" — computing them apart would let
 * one be reported without the other.
 */
export const scoreResponse = (
  f: TrackFacts,
  rubric: Rubric,
  par_response_s: number | undefined,
): { node: NodeResult; critical: CriticalFinding[] } => {
  const critical: CriticalFinding[] = [];
  const band = truthBand(f);

  // The actions taken, excluding anything issued before the first classification —
  // acting on a track you have not identified is its own failure, scored at N5.
  const relevant = f.actions.filter(
    (a) => a.action !== "report" && a.action !== "assign_track_owner" && a.action !== "handover",
  );

  // --- fratricide: force used against something that was never a threat --------
  const engage = relevant.find((a) => a.action === "execute_response");
  if (engage && NEVER_ENGAGE.includes(band)) {
    critical.push({
      kind: "FRATRICIDE",
      reason: `Response executed against ${f.truth_id}, which was ${f.entity.affiliation_truth} (${f.entity.intent}).`,
      seq: engage.seq,
    });
    return {
      node: {
        id: `N7.${f.truth_id}`,
        label: `Response to ${f.truth_id}`,
        passed: false,
        points: 0,
        max_points: 100,
        reason: `Response executed against a ${f.entity.affiliation_truth} contact. Fratricide — critical.`,
        event_refs: [engage.seq],
      },
      critical,
    };
  }

  // --- unauthorised action: force without authority ---------------------------
  if (engage && rubric.response.authority_required_before_execute_response) {
    const granted_before = f.authority_granted_seq !== undefined && f.authority_granted_seq < engage.seq;
    if (!granted_before) {
      critical.push({
        kind: "UNAUTHORISED_ACTION",
        reason:
          `Response executed on ${f.truth_id} at ${(engage.t_ms / 1000).toFixed(1)}s with no granted authority` +
          (f.authority_granted_seq !== undefined
            ? ` (authority granted later, at seq ${f.authority_granted_seq}).`
            : " (authority was never granted)."),
        seq: engage.seq,
      });
      return {
        node: {
          id: `N7.${f.truth_id}`,
          label: `Response to ${f.truth_id}`,
          passed: false,
          points: 0,
          max_points: 100,
          reason: `Response executed without granted authority (${f.authority_requests} request${f.authority_requests === 1 ? "" : "s"} made). Unauthorised — critical.`,
          event_refs: [engage.seq],
        },
        critical,
      };
    }
  }

  // --- false hostile call on a friendly target --------------------------------
  const hostile_call = f.declarations.find((d) => d.category === "hostile");
  if (hostile_call && NEVER_ENGAGE.includes(band)) {
    critical.push({
      kind: "FALSE_HOSTILE_ON_FRIENDLY",
      reason: `Declared ${f.truth_id} hostile when it was ${f.entity.affiliation_truth}.`,
      seq: hostile_call.seq,
    });
  }

  // --- no defensive action against a closing hostile ---------------------------
  if (band === "hostile") {
    const warned = relevant.some((a) => PROTECTIVE_ACTIONS.includes(a.action));
    const only_observed = relevant.length > 0 && relevant.every((a) => OBSERVATION_ACTIONS.includes(a.action));

    if (relevant.length === 0 || (only_observed && !warned)) {
      return {
        node: {
          id: `N7.${f.truth_id}`,
          label: `Response to ${f.truth_id}`,
          passed: false,
          points: rubric.response.passive_only_score,
          max_points: 100,
          reason:
            `Hostile contact received no protective action — ` +
            `${relevant.length === 0 ? "no response actions at all" : "observation only"}.`,
          // With nothing acted on there is no action event to cite, so cite the cue
          // that established the threat. A partial score with no event behind it is
          // not interrogable, which PRD §10.7 forbids.
          event_refs:
            relevant.length > 0
              ? [relevant[0]!.seq]
              : f.first_cue_seq !== undefined
                ? [f.first_cue_seq]
                : [],
        },
        critical,
      };
    }
  }

  // --- in the allowed set, judged on timing ------------------------------------
  const disallowed = relevant.filter((a) => !isAllowed(rubric, band, a.action));
  if (disallowed.length > 0) {
    return {
      node: {
        id: `N7.${f.truth_id}`,
        label: `Response to ${f.truth_id}`,
        passed: false,
        points: 0,
        max_points: 100,
        reason:
          `Action${disallowed.length > 1 ? "s" : ""} ${disallowed.map((a) => a.action).join(", ")} ` +
          `${disallowed.length > 1 ? "are" : "is"} not permitted against a ${band} contact.`,
        event_refs: disallowed.map((a) => a.seq),
      },
      critical,
    };
  }

  const first = relevant[0];
  if (!first) {
    // Nothing to score against a non-hostile track. Reporting nothing wrong is the
    // correct outcome, so this is a pass with no points — max_points 0 keeps it
    // out of the competency average rather than inflating it with free credit.
    return {
      node: {
        id: `N7.${f.truth_id}`,
        label: `Response to ${f.truth_id}`,
        passed: true,
        points: 0,
        max_points: 0,
        reason: `A ${band} contact required no response. No action taken, which was correct.`,
        event_refs: [],
      },
      critical,
    };
  }

  const refs: number[] = [first.seq];
  let points = 100;
  let timing_note = "";

  if (par_response_s !== undefined) {
    const elapsed_s = first.t_ms / 1000;
    if (elapsed_s <= par_response_s) {
      timing_note = `Acted at ${elapsed_s.toFixed(1)}s (par ${par_response_s.toFixed(1)}s) — timely.`;
    } else if (elapsed_s <= par_response_s * rubric.response.late_after_par) {
      // Between par and the late threshold: interpolate across the rubric's own
      // low/high bounds so the drop is gradual rather than a cliff.
      const span = par_response_s * (rubric.response.late_after_par - 1);
      const t = span === 0 ? 1 : (elapsed_s - par_response_s) / span;
      points = rubric.response.late_score_high +
        t * (rubric.response.late_score_low - rubric.response.late_score_high);
      timing_note = `Acted at ${elapsed_s.toFixed(1)}s, past the ${par_response_s.toFixed(1)}s par — late.`;
    } else {
      points = rubric.response.late_score_low;
      timing_note = `Acted at ${elapsed_s.toFixed(1)}s, more than ${rubric.response.late_after_par}× par — very late.`;
    }
    points = round2(Math.max(0, points));
  } else {
    timing_note = `Acted at ${(first.t_ms / 1000).toFixed(1)}s. The scenario sets no par response time, so timing is not scored.`;
  }

  return {
    node: {
      id: `N7.${f.truth_id}`,
      label: `Response to ${f.truth_id}`,
      passed: points > 0,
      points: round2(points),
      max_points: 100,
      reason: `${timing_note} Permitted against a ${band} contact.`,
      event_refs: refs,
    },
    critical,
  };
};

/** Aggregate response points, averaged over tracks that were scored. */
export const aggregateResponse = (nodes: NodeResult[]): number => {
  const scored = nodes.filter((n) => n.max_points > 0);
  if (scored.length === 0) return 0;
  const sum = scored.reduce((acc, n) => acc + n.points / n.max_points, 0);
  return round2((sum / scored.length) * 100);
};

/** Build the rubric penalties for the critical errors N7 raised. */
export const criticalResults = (
  findings: CriticalFinding[],
  rubric: Rubric,
  byTrack: Map<string, TrackFacts>,
): CriticalErrorResult[] =>
  findings.map((c) => ({
    kind: c.kind,
    penalty: criticalPenalty(rubric, c.kind),
    reason: c.reason,
    event_refs: [c.seq],
    ...(() => {
      const hit = [...byTrack.values()].find((t) => t.actions.some((a) => a.seq === c.seq));
      return hit ? { truth_id: hit.truth_id } : {};
    })(),
  }));