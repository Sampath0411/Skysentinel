/**
 * Log reading: events → the facts the decision tree evaluates (PRD §10.1).
 *
 * This is the only place that reads the raw event stream. Everything downstream
 * works from the `RunFacts` built here, which buys two things:
 *
 *   - The tree modules are pure functions of already-extracted facts, so they can
 *     be unit-tested without synthesising a plausible-looking event log.
 *   - The truth correlation happens once, in one file, rather than at each `N*`
 *     node where a track might silently fail to resolve.
 *
 * A track that cannot be resolved to a truth entity is *not* dropped. It becomes
 * an untracked observation and is excluded from scoring with a stated reason —
 * silently ignoring it would make the log look cleaner than the run was.
 */

import type { ClassificationCategory, Confidence, ResponseAction } from "@skysentinel/shared";

import type { ScoreInput, TruthEntity } from "./types.js";
import type { ExpectedTrack } from "@skysentinel/scenario";

/** A declaration as the scorer reads it from the log. */
export interface DeclarationFact {
  track_id: string;
  category: ClassificationCategory;
  confidence: Confidence;
  is_reclassification: boolean;
  t_ms: number;
  seq: number;
}

/** An action as the scorer reads it from the log. */
export interface ActionFact {
  action: ResponseAction;
  track_id?: string;
  t_ms: number;
  seq: number;
}

/** One truth entity's view of the run: what happened and when. */
export interface TrackFacts {
  truth_id: string;
  entity: TruthEntity;
  expected?: ExpectedTrack;

  /** track ids that resolved to this entity, in first-seen order. */
  track_ids: string[];
  /** cue ids that resolved to this entity, in presentation order. */
  cue_ids: string[];
  /**
   * Union of the sensors that contributed to this entity's tracks.
   *
   * Multi-source corroboration is the strongest evidence signal in the knowability
   * model (PRD §9.4), and the scorer needs it to know how confident a declaration
   * could defensibly have been. It is accumulated from `track_update` events, which
   * carry the full `sources` list each time.
   */
  sources: Set<string>;

  first_cue_ms: number;
  /** `seq` of the first cue, or `undefined` if the entity never produced one. */
  first_cue_seq?: number;
  marked_ms?: number;
  marked_seq?: number;

  /**
   * Every genuine sensor measurement of this entity, in time order.
   *
   * N6 compares a reported position against the most recent measurement *at or
   * before that report*, not the last one in the run: a contact that keeps moving
   * would otherwise make an accurate report look wrong simply because the drone
   * flew on afterwards. False (clutter) observations are excluded here rather than
   * downstream — a decoy's bearing is not a position to be judged against.
   */
  observations: PositionFact[];

  declarations: DeclarationFact[];
  actions: ActionFact[];
  reports: ReportFact[];
  authority_requests: number;
  /** `seq` of the authority resolution granting this track response authority. */
  authority_granted_seq?: number;

  /** Tracks that reached `lost` and later `reacquired`. */
  track_lost_seq?: number;
  track_reacquired_seq?: number;
  /** Sim time of the loss and the reacquisition, for N10's reacquire latency. */
  track_lost_ms?: number;
  track_reacquired_ms?: number;

  /** Tracks that were classified at more than one point in the run. */
  reclassified: boolean;
}

/** A single sensor measurement of a contact, as the log saw it. */
export interface PositionFact {
  t_ms: number;
  bearing_deg: number;
  range_m: number;
}

export interface ReportFact {
  seq: number;
  t_ms: number;
  track_id?: string;
  fields: Record<string, unknown>;
  /** True when this report follows a change in the trainee's own declaration. */
  after_material_change: boolean;
}

/** Cue→track timing that N8 (prioritisation) and N10 (recovery) need. */
export interface RunFacts {
  tracks: TrackFacts[];
  /** Events with no resolvable truth entity, by type. */
  unattributed: Record<string, number>;
  brief_viewed_ms?: number;
  /** `seq` of the brief view, so N9 can cite the event its credit came from. */
  brief_viewed_seq?: number;
  brief_sections: string[];
  impact_count: number;
  impacts: { seq: number; asset_id: string; damage: number }[];
  neutralised: string[];
  engaged: string[];
  session_end_reason: string;
  /** Events that carried no trainee action — the raw material for N6 best-of. */
  report_count: number;
}

const trackKey = (truth_id: string): string => `truth:${truth_id}`;

/**
 * Build the facts for one run.
 *
 * Truth is read from the instructor-visibility `entity_spawned` events plus the
 * caller's correlation maps. The scorer is a server-side component; it is allowed
 * to see truth, and it is the server's job to keep truth away from the client.
 */
export const readRun = (input: ScoreInput): RunFacts => {
  const { events, correlation } = input;

  const truth = new Map(input.truth);
  const expectedById = new Map(input.expected.tracks.map((t) => [t.truth_id, t]));

  const tracks = new Map<string, TrackFacts>();
  const unattributed: Record<string, number> = {};
  const note_unattributed = (type: string): void => {
    unattributed[type] = (unattributed[type] ?? 0) + 1;
  };

  const ensure = (truth_id: string): TrackFacts | undefined => {
    const existing = tracks.get(truth_id);
    if (existing) return existing;
    const entity = truth.get(truth_id);
    if (!entity) return undefined;
    const facts: TrackFacts = {
      truth_id,
      entity,
      ...(expectedById.has(truth_id) ? { expected: expectedById.get(truth_id)! } : {}),
      track_ids: [],
      cue_ids: [],
      sources: new Set<string>(),
      observations: [],
      first_cue_ms: Number.POSITIVE_INFINITY,
      declarations: [],
      actions: [],
      reports: [],
      authority_requests: 0,
      reclassified: false,
    };
    tracks.set(truth_id, facts);
    return facts;
  };

  // Track ids seen so far, so a later action on a track can find its truth.
  const trackToTruth = new Map<string, string>();

  let brief_viewed_ms: number | undefined;
  let brief_viewed_seq: number | undefined;
  const brief_sections: string[] = [];
  const impacts: { seq: number; asset_id: string; damage: number }[] = [];
  const neutralised: string[] = [];
  const engaged: string[] = [];
  let session_end_reason = "duration";
  let report_count = 0;

  const factsForTrack = (track_id: string): TrackFacts | undefined => {
    const truth_id = correlation.track_truth.get(track_id) ?? trackToTruth.get(track_id);
    return truth_id ? ensure(truth_id) : undefined;
  };

  for (const ev of events) {
    switch (ev.type) {
      case "session_ended":
        session_end_reason = ev.payload.end_reason;
        break;

      case "brief_viewed":
        brief_viewed_ms = ev.t_ms;
        brief_viewed_seq = ev.seq;
        brief_sections.push(...ev.payload.sections_viewed);
        break;

      case "cue_presented": {
        const truth_id = correlation.cue_truth.get(ev.payload.cue_id);
        const f = truth_id ? ensure(truth_id) : undefined;
        if (!f) {
          note_unattributed(ev.type);
          break;
        }
        f.cue_ids.push(ev.payload.cue_id);
        // A cue only counts if it is the first for this entity; re-presented cues
        // for the same truth must not shorten the measured detection latency.
        if (ev.payload.first_for_truth && ev.t_ms < f.first_cue_ms) {
          f.first_cue_ms = ev.t_ms;
          f.first_cue_seq = ev.seq;
        }
        break;
      }

      case "sensor_observation": {
        // `truth_ref` is documented on the event as internal-only, for exactly this
        // correlation, and is stripped from every trainee-facing view (PRD §4). The
        // scorer is server-side, so reading it here is what that field is for. A
        // decoy has no truth to point at, and `is_false` covers the clutter
        // presentations that borrow an entity's identity.
        const truth_id = ev.payload.truth_ref;
        const f = truth_id ? ensure(truth_id) : undefined;
        if (!f || ev.payload.is_false) break;
        f.observations.push({
          t_ms: ev.t_ms,
          bearing_deg: ev.payload.bearing_deg,
          range_m: ev.payload.range_m,
        });
        break;
      }

      case "track_update": {
        const { track_id } = ev.payload;
        const f = factsForTrack(track_id);
        if (!f) {
          note_unattributed(ev.type);
          break;
        }
        if (!f.track_ids.includes(track_id)) f.track_ids.push(track_id);
        for (const s of ev.payload.sources) f.sources.add(s);
        break;
      }

      case "contact_marked": {
        const key = ev.payload.cue_or_track_id;
        const truth_id = correlation.cue_truth.get(key) ?? correlation.track_truth.get(key) ?? null;
        const f = truth_id ? ensure(truth_id) : undefined;
        if (!f) {
          note_unattributed(ev.type);
          break;
        }
        // First mark only: detection latency is measured to the first one, and a
        // trainee who marks twice has not detected anything sooner.
        if (f.marked_ms === undefined) {
          f.marked_ms = ev.t_ms;
          f.marked_seq = ev.seq;
        }
        break;
      }

      case "classification_submitted": {
        const { track_id, category, confidence, is_reclassification } = ev.payload;
        const f = factsForTrack(track_id);
        if (!f) {
          note_unattributed(ev.type);
          break;
        }
        const decl: DeclarationFact = {
          track_id,
          category,
          confidence,
          is_reclassification,
          t_ms: ev.t_ms,
          seq: ev.seq,
        };
        f.declarations.push(decl);
        if (f.declarations.length > 1) f.reclassified = true;
        if (!f.track_ids.includes(track_id)) f.track_ids.push(track_id);
        trackToTruth.set(track_id, f.truth_id);
        break;
      }

      case "report_sent": {
        report_count++;
        const f = ev.payload.linked_track_id ? factsForTrack(ev.payload.linked_track_id) : undefined;
        if (!f) {
          // An unattached report is still a real report; it just cannot be scored
          // against a track, so it counts only toward the global report tally.
          note_unattributed(ev.type);
          break;
        }
        // A COP update is a report that carries *new* information: a declaration
        // landed after the previous report on this track. Comparing against the
        // previous declaration instead would call a report an update even when
        // nothing had changed since the trainee last reported, which is precisely
        // the behaviour the bonus is meant to discourage.
        const last_report = f.reports.at(-1);
        const changed_since_last =
          last_report !== undefined &&
          f.declarations.some((d) => d.seq > last_report.seq && d.seq < ev.seq);

        f.reports.push({
          seq: ev.seq,
          t_ms: ev.t_ms,
          ...(ev.payload.linked_track_id ? { track_id: ev.payload.linked_track_id } : {}),
          fields: ev.payload.fields as Record<string, unknown>,
          after_material_change: changed_since_last,
        });
        break;
      }

      case "action_taken": {
        const { action, target_track_id } = ev.payload;
        const f = target_track_id ? factsForTrack(target_track_id) : undefined;
        if (!f) {
          note_unattributed(ev.type);
          break;
        }
        const act: ActionFact = {
          action,
          ...(target_track_id ? { track_id: target_track_id } : {}),
          t_ms: ev.t_ms,
          seq: ev.seq,
        };
        f.actions.push(act);
        // Track owner assignment is the §10.3 N9 signal, but it is a normal action.
        if (action === "assign_track_owner" && !engaged.includes(f.truth_id)) {
          engaged.push(f.truth_id);
        }
        if (target_track_id) trackToTruth.set(target_track_id, f.truth_id);
        break;
      }

      case "authority_requested": {
        const f = factsForTrack(ev.payload.track_id);
        if (!f) {
          note_unattributed(ev.type);
          break;
        }
        f.authority_requests++;
        break;
      }

      case "authority_resolved": {
        const f = factsForTrack(ev.payload.track_id);
        if (!f) break;
        if (ev.payload.granted && f.authority_granted_seq === undefined) {
          f.authority_granted_seq = ev.seq;
        }
        break;
      }

      case "response_effect_resolved": {
        neutralised.push(ev.payload.truth_id);
        break;
      }

      case "impact":
        impacts.push({ seq: ev.seq, asset_id: ev.payload.asset_id, damage: ev.payload.damage });
        break;

      case "track_lost": {
        const f = factsForTrack(ev.payload.track_id);
        if (f && f.track_lost_seq === undefined) {
          f.track_lost_seq = ev.seq;
          f.track_lost_ms = ev.t_ms;
        }
        break;
      }

      case "track_reacquired": {
        const f = factsForTrack(ev.payload.track_id);
        if (f) {
          f.track_reacquired_seq = ev.seq;
          f.track_reacquired_ms = ev.t_ms;
        }
        break;
      }

      default:
        // Remaining types (entity_*, sensor_*, inject_*, annotation, cue repeats)
        // carry nothing the tree scores on.
        break;
    }
  }

  const list = [...tracks.values()].sort((a, b) =>
    a.first_cue_ms === b.first_cue_ms ? a.truth_id.localeCompare(b.truth_id) : a.first_cue_ms - b.first_cue_ms,
  );

  return {
    tracks: list,
    unattributed,
    ...(brief_viewed_ms !== undefined ? { brief_viewed_ms } : {}),
    ...(brief_viewed_seq !== undefined ? { brief_viewed_seq } : {}),
    brief_sections,
    impact_count: impacts.length,
    impacts,
    neutralised,
    engaged,
    session_end_reason,
    report_count,
  };
};

/** Did the trainee ever declare this category on this track? */
export const declared = (f: TrackFacts, category: ClassificationCategory): DeclarationFact | undefined =>
  f.declarations.find((d) => d.category === category);

/** Every distinct category declared, for "did they move toward truth" checks. */
export const declaredCategories = (f: TrackFacts): ClassificationCategory[] => {
  const seen: ClassificationCategory[] = [];
  for (const d of f.declarations) if (!seen.includes(d.category)) seen.push(d.category);
  return seen;
};

/** Confidence of the final declaration, or `undefined` if none was made. */
export const finalConfidence = (f: TrackFacts): Confidence | undefined => f.declarations.at(-1)?.confidence;

export const tookAction = (f: TrackFacts, action: ResponseAction): ActionFact | undefined =>
  f.actions.find((a) => a.action === action);

/** Actions are per-track, so N7 needs this to be true for a *sequence* too. */
export const tookActionBefore = (
  f: TrackFacts,
  action: ResponseAction,
  t_ms: number,
): ActionFact | undefined => f.actions.find((a) => a.action === action && a.t_ms <= t_ms);

export { trackKey };