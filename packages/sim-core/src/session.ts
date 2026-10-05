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

import type { AnySimEvent, Millis, ReportFields } from "@skysentinel/shared";
import type {
  Affiliation,
  Archetype,
  ClassificationCategory,
  Confidence,
  Posture,
  ResponseAction,
  SensorId,
  SensorMode,
  Vec3,
  Weather,
} from "@skysentinel/shared";
import { POSTURES, WEATHER } from "@skysentinel/shared";

import {
  createAuthority,
  makeRequest,
  type AuthorityState,
  type GrantRule,
} from "./authority.js";
import { type Drone, type ProtectedAsset } from "./entities.js";
import { setWeather, type Environment } from "./environment.js";
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
  /**
   * The sections a mission brief offers, and that a trainee may consult.
   *
   * Not content — just the headings the console can open. N4 and N9 score whether
   * the brief was read before deciding, so the brief has to be something a
   * trainee can actually read; until the control existed, that credit was
   * unreachable on a real run and every bot scored zero on it.
   */
  brief_sections: readonly string[];
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
  /** The sections this mission's brief offers. The trainee may open any of them. */
  brief_sections: readonly string[];
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
  /**
   * Report up the chain.
   *
   * `activity` and `description` are part of a usable report (PRD §7.3): a bearing
   * and a range alone do not tell a chain operator what is looking at them. Both
   * are free text and are not checked against truth — see D24 for why.
   */
  report(args: {
    track_id?: string;
    quantity?: number;
    bearing_deg?: number;
    range_m?: number;
    activity?: string;
    description?: string;
  }): boolean;
  /** Take any non-classification action. Returns false when inapplicable. */
  act(action: ResponseAction, args?: { track_id?: string; asset_id?: string }): boolean;
  /** Ask for response authority on a track. False for an unknown track. */
  requestAuthority(track_id: string): boolean;
  /**
   * Consult the mission brief. Records which sections were opened, which N4 and
   * N9 score against. Returns false for a section this brief does not have.
   */
  viewBrief(sections?: readonly string[]): boolean;
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
  /**
   * Fire one inject right now (FR-SIM-9).
   *
   * `by` names whoever applied it — `"scenario"` for an authored timeline, an
   * instructor id for a live one — and lands in the `inject_applied` payload so the
   * AAR can tell a scripted degradation from a human one.
   *
   * Returns false when the type or its parameters were not usable. See
   * `applyInject`: the event is still logged, so the inject is visible in the AAR
   * even when it had no effect on the world.
   */
  inject(type: string, params: Record<string, unknown>, by: string): boolean;
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
  /**
   * Every cue and track id this run produced, mapped to the entity behind it.
   *
   * Scoring correlation only, and accumulated for the whole run rather than read
   * off the live tracker — the tracker drops retired tracks, so `tracks()` after a
   * run correlates only the contacts still alive at the end. A track id is mapped
   * to `null` when it was fused from clutter alone and has no entity behind it.
   */
  correlation(): { cue_truth: ReadonlyMap<string, string>; track_truth: ReadonlyMap<string, string | null> };
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

  /**
   * Cue and track ids → the truth entity behind them, accumulated for the whole run.
   *
   * Never pruned. A track that is lost or retired still has a classification, an
   * action and a report against it in the log, and all of those need to resolve
   * back to an entity long after the tracker has forgotten the track.
   */
  const cueTruth = new Map<string, string>();
  const trackTruth = new Map<string, string | null>();
  const firstSeenTruth = new Set<string>();
  const seenFalseObs = new Set<string>();

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
    // Entities that exist *now*: airborne, not landed or neutralised, and past
    // their spawn time.
    //
    // The spawn-time filter is load-bearing and was missing. Every sensor checks
    // `neutralised` and `landed` but none of them check `spawn_t_ms`, because each
    // sensor only sees the list it is handed — so with no filter here, a drone
    // scheduled to appear at t=260 s was detectable from t=0, sitting at its
    // authored start position. That is not a scoring nuance: it gave the swarm
    // scenario's neutral civilian a track from t=45 s, and a bot that correctly
    // classified everything it could see was then punished for calling the
    // long-dormant civilian a threat. The scenario said the civilian arrives late;
    // the simulation had it on scope the whole time.
    const airborne = world
      .entities()
      .filter(
        (e): e is Drone =>
          e.kind === "drone" && t_ms >= e.spawn_t_ms && !e.neutralised && !e.landed,
      );

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
      cueTruth.set(cueList[cueList.length - 1]!.cue_id, o.truth_ref);
      emitter.emit("cue_presented", { cue_id: cueList[cueList.length - 1]!.cue_id, sensor: o.sensor, first_for_truth: true });
    }

    const before = new Map(tracker.tracks().map((t) => [t.track_id, t.status]));
    const tracks = tracker.update(observations);
    tracker.tick(t_ms);

    // Raw sensor pictures, for the console scopes and for N6's position check.
    //
    // Sampled on the same 1 Hz boundary as `track_update` (D17): at 20 Hz these
    // dominate the log, and the trainee acts on a picture, not on twenty frames a
    // second of the same one.
    //
    // These events were previously never emitted at all — the type existed, was
    // schema-checked, was stripped of `truth_ref` for trainees, and nothing
    // produced one. That left the radar and radio scopes with nothing to draw and
    // left report position unscorable on a real run.
    //
    // The first sighting of each entity, and of one clutter contact per sensor, is
    // emitted *regardless* of the boundary. That case is not an optimisation: a cue
    // and the report it prompts often fall in the same 50 ms tick, and a report
    // emitted before any `sensor_observation` has no measurement for N6 to judge
    // it against — the trainee is marked down for a position they could not have
    // known. A contact that appears and vanishes between two boundaries would
    // likewise never appear in the log at all.
    const first_sightings = new Set<string>();
    for (const o of observations) {
      if (!o.truth_ref) {
        // One clutter contact per sensor per run is enough for the scope to show
        // what a false alarm looks like without flooding the log with them.
        if (seenFalseObs.has(o.sensor)) continue;
        seenFalseObs.add(o.sensor);
        first_sightings.add(o.obs_id);
      } else if (!firstSeenTruth.has(o.truth_ref)) {
        firstSeenTruth.add(o.truth_ref);
        first_sightings.add(o.obs_id);
      }
    }

    const on_boundary = t_ms % TRACK_UPDATE_PERIOD_MS === 0;
    for (const o of observations) {
      const is_first = first_sightings.has(o.obs_id);
      if (!is_first && !on_boundary) continue;
      // A first sighting already logged this tick; the boundary pass must not log
      // it a second time under the same `obs_id`.
      if (!is_first && !o.truth_ref) continue;
      emitter.emit("sensor_observation", {
        sensor: o.sensor,
        obs_id: o.obs_id,
        truth_ref: o.truth_ref === "" ? undefined : o.truth_ref,
        bearing_deg: o.bearing_deg,
        range_m: o.range_m ?? 0,
        alt_m: o.altitude_m ?? 0,
        conf: o.confidence,
        is_false: o.truth_ref === "",
        ...(o.rcs === undefined ? {} : { shape: o.rcs }),
      });
    }

    // Track ids are recorded as they are first seen, because the tracker drops
    // retired tracks: reading `tracker.tracks()` after the run would correlate
    // only the last few contacts and leave every earlier one's events unattributed.
    for (const t of tracks) {
      if (!trackTruth.has(t.track_id)) trackTruth.set(t.track_id, t.truth_ref);
    }

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

  /**
   * Apply one inject (FR-SIM-9), whatever its source.
   *
   * The authored timeline and an instructor clicking a button both land here, so a
   * scripted sensor outage and a fired one degrade the same sensor by the same code
   * and the log records both identically. A second implementation would be a second
   * set of rules this project cannot afford.
   *
   * Returns false when the type or its parameters were unusable. The `inject_applied`
   * event is emitted regardless, because the inject *did* happen and the AAR should
   * show it; the boolean lets a caller distinguish "applied" from "logged, no effect"
   * without parsing the log.
   */
  const applyInject = (type: string, params: Record<string, unknown>, by: string): boolean => {
    emitter.emit("inject_applied", { inject_type: type, params, by });

    switch (type) {
      case "sensor_outage": {
        const id = params["sensor"];
        if (typeof id !== "string") return false;
        const sensor = sensors.find((s) => s.id === id);
        if (!sensor) return false;
        setSensorMode(sensor, "failed");
        emitter.emit("sensor_state_changed", { sensor: sensor.id, mode: "failed" });
        return true;
      }

      case "weather_change": {
        const weather = params["weather"];
        if (typeof weather !== "string" || !WEATHER.includes(weather as Weather)) return false;
        // Sensors read `factors` on every observation, so the next tick already sees
        // the new atmosphere.
        world.setEnvironment(setWeather(world.environment, weather as Weather));
        return true;
      }

      case "comms_delay": {
        // Mutating the spec is enough: `report` reads `spec.comms_delay_s` when it
        // builds the payload, so a report sent after this inject carries the new lag.
        const delay_s = params["delay_s"];
        if (typeof delay_s !== "number" || !Number.isFinite(delay_s) || delay_s < 0) return false;
        spec.comms_delay_s = delay_s;
        return true;
      }

      case "authority_change": {
        const posture = params["posture"];
        if (typeof posture !== "string" || !POSTURES.includes(posture as Posture)) return false;
        authority.setPosture(posture as Posture);
        return true;
      }

      case "new_track": {
        // Placed from the observer's own picture — a bearing and a range is what an
        // instructor reads off a scope, and an absolute xy would require a second
        // map to enter.
        const bearing = params["bearing_deg"];
        const range = params["range_m"];
        if (typeof bearing !== "number" || typeof range !== "number") return false;
        const pos = positionAtBearingRange(
          spec.observer_pos,
          bearing,
          range,
          typeof params["altitude_m"] === "number" ? params["altitude_m"] : 120,
        );
        world.spawnDrone({
          pos,
          ...(typeof params["archetype"] === "string" ? { archetype: params["archetype"] as Archetype } : {}),
          ...(typeof params["affiliation"] === "string"
            ? { affiliation_truth: params["affiliation"] as Affiliation }
            : {}),
          ...(typeof params["speed_mps"] === "number" ? { speed_mps: params["speed_mps"] } : {}),
        });
        return true;
      }

      default:
        return false;
    }
  };

  const applyInjects = (t_ms: Millis): void => {
    for (const inject of spec.injects) {
      if (inject.at_t_ms !== t_ms) continue;
      applyInject(inject.type, inject.params, "scenario");
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
      brief_sections: spec.brief_sections,
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
      const fields: ReportFields = {
        ...(args.quantity !== undefined ? { quantity: args.quantity } : {}),
        ...(args.bearing_deg !== undefined ? { bearing_deg: args.bearing_deg } : {}),
        ...(args.range_m !== undefined ? { range_m: args.range_m } : {}),
        ...(args.activity !== undefined ? { activity: args.activity } : {}),
        ...(args.description !== undefined ? { description: args.description } : {}),
      };
      emitter.emit("report_sent", {
        fields,
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
        ...(args.activity !== undefined ? { activity: args.activity } : {}),
        ...(args.description !== undefined ? { description: args.description } : {}),
      });
      return true;
    },

    act: (action, args) => record(action, args),

    viewBrief(sections) {
      // Default to the whole brief: opening the brief at all is the scored act, and
      // a console that made the trainee tick each heading to earn the credit would
      // be measuring clicking, not preparation.
      const asked = sections ?? spec.brief_sections;
      const known = asked.filter((s) => spec.brief_sections.includes(s));
      if (known.length === 0) return false;
      emitter.emit("brief_viewed", { sections_viewed: known });
      return true;
    },

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
    inject: (type, params, by) => applyInject(type, params, by),
    traineeView: view,
    controls: () => controls,
    tracks: () => tracker.tracks(),
    correlation: () => ({ cue_truth: new Map(cueTruth), track_truth: new Map(trackTruth) }),
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
 * Position at a given bearing and range from `from`, on the local ENU plane.
 *
 * The same geometry the track projection uses, so a contact an instructor injects
 * at "045°, 4 km" lands where the trainee's own plot would put a contact at that
 * bearing and range — the two ways of naming a position agree by construction.
 */
const positionAtBearingRange = (
  from: Vec3,
  bearing_deg: number,
  range_m: number,
  alt_m: number,
): Vec3 => {
  const rad = (bearing_deg * Math.PI) / 180;
  return { x: from.x + range_m * Math.sin(rad), y: from.y + range_m * Math.cos(rad), z: alt_m };
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
  const p = positionAtBearingRange(from, t.bearing_deg, t.range_m ?? 0, from.z);
  return [p.x, p.y, p.z];
};
