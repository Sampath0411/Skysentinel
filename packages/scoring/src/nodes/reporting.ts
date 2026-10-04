/**
 * N6: reporting quality (PRD §10.3, FR-SCR-4).
 *
 * Every threshold — which fields matter, how far a bearing may be wrong, how long
 * after classifying a report is still prompt — comes from `reporting` in the
 * rubric. This module only decides *whether* each criterion was met.
 *
 * Scoring is best-of per track. A trainee who corrects a bad first report with a
 * good one has reported well; scoring only the first would punish the correction
 * that is the behaviour being taught (PRD §10.6, "Good decision / Bad outcome").
 */

import { bearingDeltaDeg } from "@skysentinel/shared";

import type { Rubric } from "../generated/rubric.js";
import type { PositionFact, ReportFact, TrackFacts } from "../log.js";
import type { NodeResult } from "../types.js";

const round2 = (v: number): number => Math.round(v * 100) / 100;

/** The report fields the rubric cares about. */
const REQUIRED_FIELDS = ["quantity", "activity", "bearing_deg", "range_m", "description"] as const;

/** Does the reported bearing sit inside the rubric's tolerance of the true one? */
const bearing_ok = (reported: unknown, actual: number | undefined, tol_deg: number): boolean => {
  if (typeof reported !== "number" || actual === undefined) return false;
  return bearingDeltaDeg(reported, actual) <= tol_deg;
};

/**
 * Does the reported range sit inside tolerance?
 *
 * The rubric gives both a fractional and an absolute tolerance and takes whichever
 * is *looser*, so the same rubric works for a 200 m and a 20 km engagement. A
 * trainee is not penalised for the scale of the scenario.
 */
const range_ok = (reported: unknown, actual: number | undefined, frac: number, abs_m: number): boolean => {
  if (typeof reported !== "number" || actual === undefined) return false;
  const tolerance = Math.max(Math.abs(actual) * frac, abs_m);
  return Math.abs(reported - actual) <= tolerance;
};

const number_or_undefined = (v: unknown): number | undefined => (typeof v === "number" ? v : undefined);

/**
 * Words that mean "the trainee declined to say".
 *
 * A short, closed list on purpose. This is not a natural-language classifier and
 * must not grow into one — scoring is deterministic rules only, and a fuzzy
 * synonym list would make the rubric's behaviour depend on phrasing it never
 * declared. Anything not on this list counts as an assessment, because a trainee
 * who is wrong about activity is handled by N5, not here.
 */
const PLACEHOLDERS = new Set([
  "unknown",
  "unsure",
  "uncertain",
  "unclear",
  "n/a",
  "na",
  "none",
  "tbd",
  "no idea",
  "not known",
  "cannot determine",
  "?",
  "-",
  "tbc",
]);

/** Did the trainee commit to a description, rather than pass the question back? */
const is_substantive = (v: unknown): boolean => {
  if (typeof v !== "string") return false;
  const trimmed = v.trim().toLowerCase();
  return trimmed.length > 0 && !PLACEHOLDERS.has(trimmed);
};

/**
 * The position the trainee could legitimately have reported for `report`.
 *
 * This is the latest genuine sensor measurement at or before the report, not the
 * truth and not the final picture. Judging against truth would penalise a correct
 * report for a contact the sensors had not yet located; judging against the last
 * measurement in the run would penalise it for the contact having flown on. What the
 * trainee could see is the only defensible yardstick, and it is the same yardstick
 * for everyone scored against the same run.
 */
const positionAt = (f: TrackFacts, t_ms: number): { bearing_deg: number; range_m: number } | undefined => {
  let latest: PositionFact | undefined;
  for (const o of f.observations) {
    if (o.t_ms > t_ms) continue;
    if (latest === undefined || o.t_ms >= latest.t_ms) latest = o;
  }
  return latest === undefined ? undefined : { bearing_deg: latest.bearing_deg, range_m: latest.range_m };
};

/**
 * Score one report against one track. Returns the points earned and the reasons.
 */
const scoreOneReport = (
  report: ReportFact,
  f: TrackFacts,
  rubric: Rubric,
): { points: number; parts: string[] } => {
  const r = rubric.reporting;
  const parts: string[] = [];

  const present = REQUIRED_FIELDS.filter((k) => {
    const v = report.fields[k];
    return v !== undefined && v !== null && v !== "";
  });
  const presence_points = (present.length / REQUIRED_FIELDS.length) * r.field_presence_points;
  parts.push(`${present.length}/${REQUIRED_FIELDS.length} required fields`);

  const actual = positionAt(f, report.t_ms);
  const bearing_good = bearing_ok(report.fields["bearing_deg"], actual?.bearing_deg, r.bearing_tolerance_deg);
  const range_good = range_ok(report.fields["range_m"], actual?.range_m, r.range_tolerance_frac, r.range_tolerance_abs_m);
  const position_points = bearing_good && range_good ? r.position_tolerance_points : bearing_good || range_good ? r.position_tolerance_points / 2 : 0;
  parts.push(
    actual === undefined
      ? "no sensor measurement to judge the position against"
      : bearing_good && range_good
        ? "position within tolerance"
        : `position off (bearing ${bearing_good ? "ok" : "miss"}, range ${range_good ? "ok" : "miss"})`,
  );

  // Quantity correct to ±1: an off-by-one is a rounding error in a spoken report,
  // not a miscount. Beyond that the trainee lost track of how many there were.
  const qty = number_or_undefined(report.fields["quantity"]);
  const expected_qty = 1;
  const qty_good = qty !== undefined && Math.abs(qty - expected_qty) <= 1;
  const quantity_points = qty_good ? r.quantity_points : 0;
  parts.push(qty_good ? "quantity correct" : qty === undefined ? "quantity missing" : `quantity ${qty} vs ${expected_qty}`);

  // Activity earns its points for being a real assessment, not for naming the
  // right one.
  //
  // This used to require the reported activity to contain the entity's `intent` —
  // which is truth, and truth the trainee cannot see (PRD §4, §9.4). A trainee who
  // correctly described what they could observe was marked down for not guessing
  // the word in the answer key, and a trainee who guessed it was rewarded for
  // knowing something they had no way of knowing.
  //
  // Whether the activity was *correct* is already scored, and against evidence:
  // N5 grades the declaration, and N6's own `presence_points` reward carrying the
  // field at all. So this checks the one thing the log can fairly check — that the
  // trainee committed to a description rather than passing the question back up the
  // chain. A placeholder is a real failure: it tells the chain operator nothing, and
  // withholding a judgement is not the same as being wrong.
  const activity = report.fields["activity"];
  const activity_good = is_substantive(activity);
  const activity_points = activity_good ? r.activity_points : 0;
  parts.push(
    activity_good
      ? "activity stated"
      : typeof activity === "string"
        ? "activity is a placeholder"
        : "activity missing",
  );

  // Promptness is measured from the first classification, per PRD §10.3 N6.
  const first_decl_ms = f.declarations[0]?.t_ms;
  const prompt = first_decl_ms === undefined ? 0 : report.t_ms - first_decl_ms <= r.promptness_window_s * 1000;
  const promptness_points = prompt ? r.promptness_points : 0;
  parts.push(prompt ? "sent promptly" : "sent late");

  let points = presence_points + position_points + quantity_points + activity_points + promptness_points;

  // The update bonus requires a report *after* a material change — a re-report
  // that repeats the first one is not a COP update.
  if (report.after_material_change) {
    points += r.update_after_change_bonus;
    parts.push(`+${r.update_after_change_bonus} for updating after a change`);
  }

  return { points: clampPoints(points, 0, 100), parts };
};

const clampPoints = (v: number, lo: number, hi: number): number => Math.max(lo, Math.min(hi, v));

/** N6: best reporting score for this track. */
export const scoreReporting = (f: TrackFacts, rubric: Rubric): NodeResult => {
  if (f.reports.length === 0) {
    return {
      id: `N6.${f.truth_id}`,
      label: `Reporting for ${f.truth_id}`,
      passed: false,
      points: 0,
      max_points: 100,
      reason: `No report was sent for ${f.truth_id}.`,
      event_refs: [],
    };
  }

  let best = 0;
  let best_seq = f.reports[0]!.seq;
  let best_parts: string[] = [];
  for (const r of f.reports) {
    const { points, parts } = scoreOneReport(r, f, rubric);
    if (points > best) {
      best = points;
      best_seq = r.seq;
      best_parts = parts;
    }
  }

  return {
    id: `N6.${f.truth_id}`,
    label: `Reporting for ${f.truth_id}`,
    passed: best > 0,
    points: round2(best),
    max_points: 100,
    reason: `Best of ${f.reports.length} report${f.reports.length > 1 ? "s" : ""}: ${best_parts.join("; ")}.`,
    event_refs: [best_seq],
  };
};

/** Aggregate reporting points, averaged over tracks that required a report. */
export const aggregateReporting = (nodes: NodeResult[]): number => {
  const scored = nodes.filter((n) => n.max_points > 0);
  if (scored.length === 0) return 0;
  const sum = scored.reduce((acc, n) => acc + n.points / n.max_points, 0);
  return round2((sum / scored.length) * 100);
};