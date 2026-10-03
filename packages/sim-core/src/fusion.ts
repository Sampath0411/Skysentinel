/**
 * Track fusion (PRD §9.2 FR-SEN-7, §9.3).
 *
 * Correlates observations into tracks using a fixed gate, then fuses the evidence
 * on each track. Gate: bearing ±8°, range ±15% or ±150 m (PRD §9.3).
 *
 * Fused confidence is `1 − Π(1 − c_i)` — independent sources combining, so more
 * sensors seeing the same thing raises confidence and a fourth source helps less
 * than the second. That property is what makes multi-sensor work worth doing.
 *
 * A track carries `truth_ref` internally for scoring. It is never part of a
 * trainee-facing view (PRD §4); `toTraineeTrack` is the single place that projects.
 */

import { bearingDeltaDeg, type Millis, type SensorId, type TrackStatus } from "@skysentinel/shared";

import type { Observation } from "./sensors/types.js";

export const GATE_BEARING_DEG = 8;
export const GATE_RANGE_FRAC = 0.15;
export const GATE_RANGE_ABS_M = 150;

/** How long a track survives with no new observation before it is lost, ms. */
export const TRACK_TIMEOUT_MS = 3000;

/** How many recent observations a track retains for explanation. */
export const EVIDENCE_WINDOW = 32;

export interface Track {
  track_id: string;
  status: TrackStatus;
  bearing_deg: number;
  range_m?: number;
  speed_mps?: number;
  /** Fused confidence, 0..1. */
  confidence: number;
  /** Sensors contributing to this track. */
  sources: SensorId[];
  first_seen_ms: Millis;
  last_seen_ms: Millis;
  /** TRUTH: correlated entity id. Internal only. */
  truth_ref: string | null;
  /** A bounded window of recent observations, for explaining the track in the AAR. */
  evidence: Observation[];
  /** Best confidence seen per sensor. This is what fusion combines. */
  best_by_source: Map<SensorId, number>;
}

export interface FusedTrack {
  track_id: string;
  status: TrackStatus;
  bearing_deg: number;
  range_m?: number;
  speed_mps?: number;
  confidence: number;
  sources: SensorId[];
  first_seen_ms: Millis;
  last_seen_ms: Millis;
}

export interface Tracker {
  /** Feed observations for one tick. Returns the current track set. */
  update(observations: readonly Observation[]): Track[];
  tracks(): Track[];
  /** Advance time without observations, ageing tracks out. */
  tick(t_ms: Millis): Track[];
  reset(): void;
}

/** Do two observations fall inside the correlation gate? */
export const withinGate = (a: Observation, b: Observation): boolean => {
  if (Math.abs(bearingDeltaDeg(a.bearing_deg, b.bearing_deg)) > GATE_BEARING_DEG) return false;

  // Range is only comparable when both sensors measured it.
  if (a.range_m === undefined || b.range_m === undefined) return true;

  const tol = Math.max(Math.abs(a.range_m) * GATE_RANGE_FRAC, GATE_RANGE_ABS_M);
  return Math.abs(a.range_m - b.range_m) <= tol;
};

/** Independent-evidence fusion: `1 − Π(1 − c_i)`. */
export const fuseConfidence = (confidences: readonly number[]): number => {
  if (confidences.length === 0) return 0;
  let product = 1;
  for (const c of confidences) product *= 1 - c;
  return 1 - product;
};

export const createTracker = (): Tracker => {
  let tracks: Track[] = [];
  let nextId = 1;

  const fuse = (track: Track, obs: Observation): void => {
    // Keep the most recent measurement per field; sensors that do not measure a
    // field leave the previous value alone rather than zeroing it.
    track.bearing_deg = obs.bearing_deg;
    if (obs.range_m !== undefined) track.range_m = obs.range_m;
    if (obs.speed_mps !== undefined) track.speed_mps = obs.speed_mps;

    if (!track.sources.includes(obs.sensor)) track.sources.push(obs.sensor);

    // Recompute from one confidence per distinct source, so repeated observations
    // from one radar cannot masquerade as independent corroboration. Only the best
    // per source is kept, so `evidence` need not grow for the whole scenario.
    const bySource = new Map<SensorId, number>(track.best_by_source);
    bySource.set(obs.sensor, Math.max(bySource.get(obs.sensor) ?? 0, obs.confidence));
    track.best_by_source = bySource;
    track.confidence = fuseConfidence([...bySource.values()]);

    // Keep a bounded window of recent observations: enough to explain the track in
    // the AAR without an array that grows for the length of the scenario.
    track.evidence.push(obs);
    if (track.evidence.length > EVIDENCE_WINDOW) track.evidence.shift();

    track.last_seen_ms = obs.t_ms;
  };

  return {
    update(observations) {
      // Sorted so the same observation set always produces the same track numbering.
      const sorted = [...observations].sort((a, b) => (a.obs_id < b.obs_id ? -1 : a.obs_id > b.obs_id ? 1 : 0));

      for (const obs of sorted) {
        const prev = (track: Track): Observation | undefined => track.evidence[track.evidence.length - 1];

        // Correlation is gate-based only. `truth_ref` is never allowed to link two
        // observations: doing so would let a scorer artefact override the physics
        // and merge two genuinely different targets into one track.
        const match = tracks.find((t) => prev(t) !== undefined && withinGate(prev(t)!, obs));

        if (match) {
          match.evidence.push(obs);
          fuse(match, obs);
          if (match.status === "lost") match.status = "reacquired";
          if (match.status === "new" && match.sources.length >= 2) match.status = "confirmed";
          continue;
        }

        tracks.push({
          track_id: `T${String(nextId++).padStart(3, "0")}`,
          status: "new",
          bearing_deg: obs.bearing_deg,
          ...(obs.range_m !== undefined ? { range_m: obs.range_m } : {}),
          ...(obs.speed_mps !== undefined ? { speed_mps: obs.speed_mps } : {}),
          confidence: obs.confidence,
          sources: [obs.sensor],
          first_seen_ms: obs.t_ms,
          last_seen_ms: obs.t_ms,
          truth_ref: obs.truth_ref === "" ? null : obs.truth_ref,
          evidence: [obs],
          best_by_source: new Map([[obs.sensor, obs.confidence]]),
        });
      }

      // A track seen by two independent sensors is confirmed.
      for (const t of tracks) if (t.status === "new" && t.sources.length >= 2) t.status = "confirmed";

      return tracks;
    },

    tick(t_ms) {
      for (const t of tracks) {
        if (t.status !== "lost" && t_ms - t.last_seen_ms > TRACK_TIMEOUT_MS) t.status = "lost";
      }
      // Drop long-dead tracks so a long scenario does not accumulate unbounded state.
      tracks = tracks.filter((t) => t_ms - t.last_seen_ms <= TRACK_TIMEOUT_MS * 10);
      return tracks;
    },

    tracks: () => tracks,
    reset() {
      tracks = [];
      nextId = 1;
    },
  };
};


/**
 * Track projection for a trainee client.
 *
 * The single place `truth_ref` is dropped. A track's identity in the trainee's view
 * is its track id and nothing else.
 */
export const toTraineeTrack = (t: Track): FusedTrack => ({
  track_id: t.track_id,
  status: t.status,
  bearing_deg: t.bearing_deg,
  ...(t.range_m !== undefined ? { range_m: t.range_m } : {}),
  ...(t.speed_mps !== undefined ? { speed_mps: t.speed_mps } : {}),
  confidence: t.confidence,
  sources: [...t.sources],
  first_seen_ms: t.first_seen_ms,
  last_seen_ms: t.last_seen_ms,
});