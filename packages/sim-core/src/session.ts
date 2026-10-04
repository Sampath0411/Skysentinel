/**
 * Session harness (PRD §6.3 `SessionRunner`, §5.3 FR-DEC-1…7).
 *
 * This is the authoritative trainee-facing loop: world tick → sensors → fusion →
 * knowability → authority, plus the actions a trainee can take. It lives in
 * sim-core rather than in `bots` or the server because all three need the identical
 * loop — the bots exercise it now, and M5's server will drive it from a socket
 * with the trainee's actions arriving over the wire. A second implementation would
 * be a second source of truth for the rules, which is exactly the class of bug this
 * project cannot afford.
 *
 * ## The truth boundary
 *
 * Two different things are called "what the trainee knows", and conflating them is
 * the central failure mode of a trainer like this:
 *
 *   - `traineeView()` — observations and fused tracks only. What a client may see.
 *   - `tracks()` — internal tracks, including `truth_ref`. Scoring and AAR only.
 *
 * `traineeView()` is built from `toTraineeTrack`, which is the single projection
 * that drops `truth_ref` (D7). A bot policy receives only that view, so it cannot
 * cheat by reading truth — which matters, because if it could, the M4 ordering
 * assertion (`expert > novice > … > trigger_happy`) would be measuring oracle
 * access rather than skill.
 *
 * ## Determinism
 *
 * Every draw comes from the world's named streams, so the same
 * (scenario, seed, actions) always yields the same log (FR-SIM-1). Bot reaction
 * *timing* is part of that: bots act on integer tick boundaries driven by the
 * harness, never on a wall clock, so a slow machine produces the same session as a
 * fast one.
 */

import type { AnySimEvent, Millis } from "@skysentinel/shared";
import type {
  ClassificationCategory,
  Confidence,
  Posture,
  ResponseAction,
  SensorId,
  SensorMode,
  Vec3,
} from "@skysentinel/shared";

import {
  createAuthority,
  makeRequest,
  type AuthorityState,
  type GrantRule,
} from "./authority.js";
import { type Drone, type ProtectedAsset } from "./entities.js";
import type { Environment } from "./environment.js";
import {
  type FusedTrack,
  type Track,
  type Tracker,
  createTracker,
  toTraineeTrack,
} from "./fusion.js";
import { type Knowability, assessKnowability } from "./knowability.js";
import { type Observation, type Sensor, createSensorSuite, setSensorMode } from "./sensors/index.js";
import type { World } from "./world.js";

/**
 * Everything the harness needs from a scenario.
 *
 * Deliberately structural rather than `Scenario` from `@skysentinel/scenario`: that
 * package depends on this one, so importing it here would be a cycle. The scenario
 * loader adapts one into the other (see `toSessionSpec` in the bots package).
 */
export interface SessionSpec {
  scenario_id: string;
  seed: number;
  duration_s: number;
  observer_pos: Vec3;
  sensors: Record<SensorId, SensorMode>;
  grant_rule: GrantRule;
  posture: Posture;
  /** Seconds before a report reaches the chain. Exercises report discipline. */
  comms_delay_s: number;
  /** Authored runtime injects (FR-SIM-9), applied in time order. */
  injects: readonly { at_t_ms: Millis; type: string; params: Record<string, unknown> }[];
}

/**
 * How often `track_update` is emitted, ms.
 *
 * 1 Hz, matching the `entity_state` cadence in `world.ts`. Sampling any faster makes
 * the event log grow with the tick rate rather than with what happened, and a
 * trainee-facing stream does not need 20 Hz track state to act on.
 */
export const TRACK_UPDATE_PERIOD_MS = 1000;

/** A cue: the first time a truth entity produced any observation for this trainee. */export interface Cue {
  cue_id: string;
  sensor: SensorId;
  t_ms: Millis;
  /** INTERNAL. Scoring correlation only — never sent to a trainee view. */
  truth_ref: string;
}

/** A trainee's declared assessment of a track. */
export interface Declaration {
  track_id: string;
  category: ClassificationCategory;
  confidence: Confidence;
  platform?: string;
  is_reclassification: boolean;
  t_ms: Millis;
}

/** One action the trainee took, in the vocabulary of PRD §7.3. */
export interface TraineeAction {
  action: ResponseAction;
  t_ms: Millis;
  track_id?: string;
  category?: ClassificationCategory;
  confidence?: Confidence;
  quantity?: number;
  bearing_deg?: number;
  range_m?: number;
  asset_id?: string;
}

/** What a trainee client or bot may see. Contains no ground truth, by construction. */
export interface TraineeView {
  t_ms: Millis;
  tracks: readonly FusedTrack[];
  /** What was knowable for each track at this instant. */
  knowability: ReadonlyMap<string, Knowability>;
  /** Cue ids not yet acted on. */
  pending_cues: readonly string[];
  authority: { posture: string; granted: readonly string[]; pending: readonly string[] };
  over: boolean;
}

/** The API a trainee (human or bot) acts through. */
export interface TraineeControls {
  /** Mark a cue as a contact. Returns false for an unknown cue. */
  markContact(cue_id: string): boolean;
  classify(decl: {
    track_id: string;
    category: ClassificationCategory;
    confidence: Confidence;
    platform?: string;
  }): boolean;
  report(args: { track_id?: string; quantity?: number; bearing_deg?: number; range_m?: number }): boolean;
  /** Take any non-classification action. Returns false when inapplicable. */
  act(action: ResponseAction, args?: { track_id?: string; asset_id?: string }): boolean;
  /** Ask for response authority on a track. False for an unknown track. */
  requestAuthority(track_id: string): boolean;
}

/** One tick handed to a policy: the view plus the controls to act on it. */
export interface BotTurn {
  view: TraineeView;
  controls: TraineeControls;
}

export type BotPolicy = (turn: BotTurn) => void;

export interface Session {
  readonly world: World;
  readonly spec: SessionSpec;
  readonly environment: Environment;
  t_ms(): Millis;
  over(): boolean;
  /** Advance one tick. Returns false once the scenario has run out. */
  tick(): boolean;
  /** Run to completion with a policy driving. Returns the tick count. */
  run(policy: BotPolicy): number;
  /** The truth-free view. Safe to send to a trainee client (PRD §4). */
  traineeView(): TraineeView;
  /**
   * The controls a trainee acts through.
   *
   * Exposed so a caller that drives the loop itself — the M5 server acting on
   * socket messages, or a capped run — uses the same surface `run` would have,
   * rather than a second implementation that could drift from it.
   */
  controls(): TraineeControls;
  /** Internal tracks, `truth_ref` included. Scoring and AAR only. */
  tracks(): readonly Track[];
  knowability(track_id: string): Knowability | undefined;
  authority(): AuthorityState;
  cues(): readonly Cue[];
  declarations(): readonly Declaration[];
  actions(): readonly TraineeAction[];
  assets(): readonly ProtectedAsset[];
  log(): readonly AnySimEvent[];
  logHash(): string;
}

export interface SessionParams {
  spec: SessionSpec;
  world: World;
  sensors?: readonly Sensor[];
  tracker?: Tracker;
}

export const createSession = (params: SessionParams): Session => {
  const { spec, world } = params;
  const sensors: Sensor[] = [...(params.sensors ?? createSensorSuite())];
  const tracker = params.tracker ?? createTracker();

  // Apply authored modes once at construction, so a scenario's `failed` sensor is
  // dead from t=0 and the very first tick already reflects it.
  for (const s of sensors) setSensorMode(s, spec.sensors[s.id]);

  const authority = createAuthority({
    posture: spec.posture,
    rule: spec.grant_rule,
    nextDraw: () => world.rng.response.next(),
  });

  const emitter = world.emitter;
  const cueList: Cue[] = [];
  const cuedTruth = new Set<string>();
  const markedCues = new Set<string>();
  const decls: Declaration[] = [];
  const acts: TraineeAction[] = [];
  let ended = false;

  /** Sensors able to contribute, in the suite's fixed order. */
  const activeSensors = (): Sensor[] => sensors.filter((s) => s.mode !== "failed");

  const observe = (t_ms: Millis): void => {
    const ctx = {
      terrain: world.terrain,
      environment: world.environment,
      // False alarms draw from `clutter`, not `sensor`: adding a clutter source
      // later must not shift every real detection (D1).
      rng: world.rng.stream("clutter"),
      t_ms,
      observer_pos: spec.observer_pos,
    };
    const airborne = world.entities().filter((e): e is Drone => e.kind === "drone");

    const observations: Observation[] = [];
    for (const sensor of activeSensors()) {
      observations.push(...sensor.observe(airborne, ctx));
    }

    // A cue fires the first time this truth entity produces any observation at all.
    // Keyed internally on the truth ref; the trainee only ever sees the cue id.
    for (const o of observations) {
      if (cuedTruth.has(o.truth_ref)) continue;
      cuedTruth.add(o.truth_ref);
      cueList.push({
        cue_id: `C${String(cueList.length + 1).padStart(3, "0")}`,
        sensor: o.sensor,
        t_ms,
        truth_ref: o.truth_ref,
      });
      emitter.emit("cue_presented", { cue_id: cueList[cueList.length - 1]!.cue_id, sensor: o.sensor, first_for_truth: true });
    }

    const before = new Map(tracker.tracks().map((t) => [t.track_id, t.status]));
    const tracks = tracker.update(observations);
    tracker.tick(t_ms);

    for (const t of tracks) {
      // Track updates are sampled at 1 Hz, on the same cadence as `entity_state`.
      // At 20 Hz a single track emits 18 000+ events over a 15-minute scenario,
      // which makes the event log the largest artefact the system produces and
      // makes a JSONL replay unreadable. Status *changes* are always emitted:
      // losing or reacquiring a track is the event a trainee must notice, so it
      // must not be sampled away between two 1 Hz boundaries.
      const prev = before.get(t.track_id);
      const statusChanged = prev !== undefined && prev !== t.status;

      if (t_ms % TRACK_UPDATE_PERIOD_MS === 0 || statusChanged) {
        emitter.emit("track_update", {
          track_id: t.track_id,
          sources: t.sources,
          conf: t.confidence,
          status: t.status,
          // The harness projects position from the track's own bearing/range rather
          // than reading the entity, so this cannot smuggle truth into the log.
          pos_est: positionEstimate(t, spec.observer_pos),
        });
      }

      if (prev !== "lost" && t.status === "lost") emitter.emit("track_lost", { track_id: t.track_id });
      if (prev === "lost" && t.status === "reacquired") {
        emitter.emit("track_reacquired", { track_id: t.track_id });
      }
    }
  };

  const applyInjects = (t_ms: Millis): void => {
    for (const inject of spec.injects) {
      if (inject.at_t_ms !== t_ms) continue;
      emitter.emit("inject_applied", { inject_type: inject.type, params: inject.params, by: "scenario" });

      if (inject.type !== "sensor_outage") continue;
      const id = inject.params["sensor"];
      if (typeof id !== "string") continue;
      const sensor = sensors.find((s) => s.id === id);
      if (!sensor) continue;
      setSensorMode(sensor, "failed");
      emitter.emit("sensor_state_changed", { sensor: sensor.id, mode: "failed" });
    }
  };

  const settleAuthority = (t_ms: Millis): void => {
    for (const { request, decision } of authority.settle(t_ms, spec.grant_rule)) {
      emitter.emit("authority_resolved", {
        track_id: request.track_id,
        granted: decision.granted,
        reason: decision.reason,
      });
    }
  };

  /** One tick's worth of work, shared by `tick` and `run` so they cannot drift. */
  const step = (): boolean => {
    if (emitter.now() >= spec.duration_s * 1000) {
      // `session_ended` is the harness's to emit, not the world's: the world only
      // emits it from `run()`, and the harness deliberately drives `tick()` so a
      // policy can act *between* world updates. Without this a session finished via
      // `tick()` would end with no terminal event, and the AAR timeline would have
      // nothing to anchor its end on.
      if (!ended) {
        ended = true;
        emitter.emit("session_ended", {
          scenario_id: spec.scenario_id,
          seed: spec.seed,
          end_reason: world.outcome(),
        });
      }
      return false;
    }
    const more = world.tick();
    const t = emitter.now();
    applyInjects(t);
    observe(t);
    settleAuthority(t);
    return more;
  };

  const view = (): TraineeView => {
    const tracks = tracker.tracks();
    const knowability = new Map<string, Knowability>();
    for (const t of tracks) knowability.set(t.track_id, assessKnowability(t));
    return {
      t_ms: emitter.now(),
      tracks: tracks.map(toTraineeTrack),
      knowability,
      pending_cues: cueList.filter((c) => !markedCues.has(c.cue_id)).map((c) => c.cue_id),
      authority: {
        posture: authority.posture,
        granted: [...authority.granted.keys()].sort(),
        pending: authority.pending().map((r) => r.track_id).sort(),
      },
      over: emitter.now() >= spec.duration_s * 1000,
    };
  };

  const record = (action: ResponseAction, args?: { track_id?: string; asset_id?: string }): boolean => {
    const t_ms = emitter.now();
    const params: Record<string, unknown> = {};
    if (args?.asset_id) params["asset_id"] = args.asset_id;
    acts.push({ action, t_ms, ...(args?.track_id ? { track_id: args.track_id } : {}) });
    emitter.emit("action_taken", {
      action,
      ...(args?.track_id ? { target_track_id: args.track_id } : {}),
      params,
    });
    return true;
  };

  const controls: TraineeControls = {
    markContact(cue_id) {
      const cue = cueList.find((c) => c.cue_id === cue_id);
      if (!cue) return false;
      markedCues.add(cue_id);
      // Only the cue id goes in the payload. An earlier version linked the contact
      // to the *track* under `linked_truth_id` — which is a forbidden trainee key,
      // so it would have been stripped at the server boundary but was still truth
      // sitting in a trainee-visible event. The link is recoverable server-side
      // from the cue id, which is all the client needs.
      emitter.emit("contact_marked", { cue_or_track_id: cue_id });
      return true;
    },

    classify(decl) {
      const t_ms = emitter.now();
      // A second declaration on the same track is a reclassification, which the
      // scorer treats differently from a correction (PRD §10.3).
      const is_reclassification = decls.some((d) => d.track_id === decl.track_id);
      decls.push({ ...decl, is_reclassification, t_ms });
      emitter.emit("classification_submitted", {
        track_id: decl.track_id,
        category: decl.category,
        confidence: decl.confidence,
        ...(decl.platform ? { platform: decl.platform } : {}),
        evidence: [],
        is_reclassification,
      });
      return true;
    },

    report(args) {
      const delay_ms = Math.round(spec.comms_delay_s * 1000);
      emitter.emit("report_sent", {
        fields: {
          ...(args.quantity !== undefined ? { quantity: args.quantity } : {}),
          ...(args.bearing_deg !== undefined ? { bearing_deg: args.bearing_deg } : {}),
          ...(args.range_m !== undefined ? { range_m: args.range_m } : {}),
        },
        ...(args.track_id ? { linked_track_id: args.track_id } : {}),
        delay_ms,
      });
      acts.push({
        action: "report",
        t_ms: emitter.now(),
        ...(args.track_id ? { track_id: args.track_id } : {}),
        ...(args.quantity !== undefined ? { quantity: args.quantity } : {}),
        ...(args.bearing_deg !== undefined ? { bearing_deg: args.bearing_deg } : {}),
        ...(args.range_m !== undefined ? { range_m: args.range_m } : {}),
      });
      return true;
    },

    act: (action, args) => record(action, args),

    requestAuthority(track_id) {
      const track = tracker.tracks().find((t) => t.track_id === track_id);
      if (!track) return false;

      const decl = [...decls].reverse().find((d) => d.track_id === track_id);
      const category = decl?.category ?? "unknown";
      const confidence = decl?.confidence ?? "low";

      const request = makeRequest({
        track_id,
        t_ms: emitter.now(),
        rule: spec.grant_rule,
        category,
        confidence,
        sources: track.sources.length,
        draw: world.rng.response.next(),
      });

      // The request is queued, not decided inline. `settleAuthority` picks it up
      // on the tick where it comes due, which is what makes the delay observable
      // and keeps a bot from acting on authority it has not actually been granted.
      authority.queue(request);
      emitter.emit("authority_requested", { track_id, posture: spec.posture });
      acts.push({ action: "request_response_authority", t_ms: emitter.now(), track_id, category, confidence });
      return true;
    },
  };

  const session: Session = {
    world,
    spec,
    environment: world.environment,
    t_ms: () => emitter.now(),
    over: () => emitter.now() >= spec.duration_s * 1000,
    tick: step,
    run(policy) {
      let ticks = 0;
      while (step()) {
        policy({ view: view(), controls });
        ticks++;
      }
      return ticks;
    },
    traineeView: view,
    controls: () => controls,
    tracks: () => tracker.tracks(),
    knowability: (id) => {
      const t = tracker.tracks().find((x) => x.track_id === id);
      return t ? assessKnowability(t) : undefined;
    },
    authority: () => authority,
    cues: () => cueList,
    declarations: () => decls,
    actions: () => acts,
    assets: () => world.entities().filter((e): e is ProtectedAsset => e.kind === "protected_asset"),
    log: () => emitter.log(),
    logHash: () => world.logHash(),
  };

  return session;
};

/**
 * Estimated position from a track's own measurements.
 *
 * Purely geometric: bearing and measured range from the observer, with altitude
 * omitted because no sensor in the suite measures it directly. Deliberately *not*
 * the entity's real position — the trainee's plot is an estimate, and a harness
 * that published truth would make every classification trivially correct.
 */
const positionEstimate = (t: Track, from: Vec3): [number, number, number] => {
  const r = t.range_m ?? 0;
  const rad = (t.bearing_deg * Math.PI) / 180;
  return [from.x + r * Math.sin(rad), from.y + r * Math.cos(rad), from.z];
};
