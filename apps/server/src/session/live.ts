/**
 * Live session service (PRD §6.3, §14 M5).
 *
 * The server owns the authoritative simulation. Clients are views; they never run
 * the sim themselves, because a client-side sim would mean every trainee's view
 * was a separate truth, and the trainer's whole claim is that what you saw is what
 * was recorded.
 *
 * ## Why the sim is stepped, not fast-forwarded
 *
 * `session.tick()` is synchronous and advances 50 ms of sim time per call. A
 * trainee watches a 900-second scenario in real time, so the loop here is a timer
 * that calls `tick()` at the right wall-clock rate and pushes a frame after each
 * one. `speed` multiplies that rate so an instructor can run a scenario at 4× for
 * a demo.
 *
 * The important property is that `tick()` is never called twice for the same
 * wall-clock moment and never skipped: the loop tracks an accumulator rather than
 * firing on a fixed interval, so a slow tick delays the frame instead of dropping
 * one. Dropping ticks would silently delete decisions from the event log, and the
 * log is the assessment record.
 */

import { EventEmitter } from "node:events";

import { buildSession } from "@skysentinel/bots";
import { SCRIPTED_SCENARIOS, type Scenario } from "@skysentinel/scenario";
import { scoreRun, type ScoreResult, type ScoreInput } from "@skysentinel/scoring";
import { TICK_MS, isAirborne, type Environment, type Session, type TraineeView } from "@skysentinel/sim-core";
import {
  filterForRole,
  type Affiliation,
  type AnySimEvent,
  type EntityKind,
  type Role,
} from "@skysentinel/shared";

import type { SessionStatus } from "../db/repo.js";
import type { LiveSessionOptions, TruthEntityView } from "./types.js";
import { newId } from "../ids.js";

/**
 * The most sim time one `pump` will ever try to step.
 *
 * Without it, a machine that slept or a process that stalled arrives back with a
 * wall-clock gap that the speed multiplier turns into minutes of sim debt, and
 * the loop repays it synchronously — the trainee's UI freezes for exactly as long
 * as the scenario is "catching up", which is worse than the scenario falling
 * behind. Capped, the run slows instead of stalling.
 */
const MAX_SIM_DEBT_MS = 10_000;

/** One broadcast payload: everything a client needs for one frame. */
export interface Frame {
  type: "tick";
  session_id: string;
  t_ms: number;
  /** The role-filtered trainee view. Never carries truth for a trainee. */
  view: TraineeView;
  /** Events since the last frame, already filtered for the receiving role. */
  events: readonly AnySimEvent[];
}

export interface SessionEndedEvent {
  type: "ended";
  session_id: string;
  reason: string;
  t_ms: number;
}

/**
 * A running (or runnable) simulation, plus its frame fan-out.
 *
 * Events are emitted rather than persisted here. The route layer owns persistence
 * and the WS layer owns sockets, so this class stays testable with no I/O at all —
 * and the equivalence with `sim:run`, which drives the same `Session` through a bot
 * policy with no server in the picture, is only meaningful if this layer adds no
 * behaviour of its own.
 */
export class LiveSession extends EventEmitter {
  readonly id: string;
  readonly scenario: Scenario;
  readonly trainee_id: string;
  readonly instructor_id: string | null;
  readonly mode: "assessment" | "training";
  readonly rubric_id: string;
  readonly rubric_version: number;
  readonly created_at: string;

  private readonly sim: Session;
  private timer: NodeJS.Timeout | null = null;
  /** Sim milliseconds owed but not yet stepped. */
  private accumulator = 0;
  private last_tick_at: number;
  /** Sim ms advanced per wall-clock ms. Captured at `start` so a mid-run change
   *  by the instructor cannot retroactively change the rate already accrued. */
  private speed = 1;
  private status: SessionStatus = "created";
  private ended_at: number | null = null;
  private end_reason: string | null = null;
  private score_result: ScoreResult | null = null;
  /** Highest `seq` already included in a broadcast frame. */
  private broadcast_seq = 0;

  constructor(opts: LiveSessionOptions) {
    super();
    this.id = opts.id ?? newId("ses_");
    this.scenario = opts.scenario;
    this.trainee_id = opts.trainee_id;
    this.instructor_id = opts.instructor_id ?? null;
    this.mode = opts.mode;
    this.rubric_id = opts.rubric_id;
    this.rubric_version = opts.rubric_version;
    this.created_at = opts.created_at;
    this.last_tick_at = opts.now;
    this.sim = buildSession(opts.scenario);
  }

  currentStatus(): SessionStatus {
    return this.status;
  }

  /** Sim time in integer milliseconds. Never wall-clock (D5). */
  t_ms(): number {
    return this.sim.t_ms();
  }

  over(): boolean {
    return this.sim.over();
  }

  /**
   * The truth-free view.
   *
   * `assertNoTruthLeak` is not called on every frame — it walks the object, and
   * that is real work at 20 Hz. The view is built by `toTraineeTrack` and explicit
   * field selection, so it has no path to truth; the leak test (PRD §18.6) asserts
   * that at the socket boundary instead, where one thorough scan proves it for
   * every frame rather than each frame proving it for itself.
   */
  view(): TraineeView {
    return this.sim.traineeView();
  }

  /**
   * Live ground truth, for the instructor's truth map (PRD §13.2).
   *
   * Read off `sim.world.entities()` rather than reconstructed from `entity_spawned`
   * events, because the world holds the authoritative entity list and the spawned
   * events are only what the emitter chose to publish. Positions are the current
   * ones: an instructor watching a truth map needs the *now* positions, and the
   * spawn event carries none at all.
   *
   * Guarded by role at the frame layer. This method is the one place in the server
   * that produces ground truth for an outbound payload, which is exactly why it is
   * a method on the session rather than something a route can assemble.
   */
  truthEntities(): readonly TruthEntityView[] {    return this.sim.world.entities().map((e) => {
      // `vel`, `neutralised` and `landed` exist only on airborne entities, and
      // assets and friendly markers have none of them. Rather than widen the type
      // with optional fields and litter every read with `??`, the airborne case is
      // narrowed once and the rest is given explicit stand-ins — a stationary asset
      // genuinely has zero velocity and is never neutralised.
      if (!isAirborne(e)) {
        return {
          id: e.id,
          kind: e.kind as EntityKind,
          pos: [e.pos.x, e.pos.y, e.pos.z] as [number, number, number],
          vel: [0, 0, 0] as [number, number, number],
          affiliation_truth: null,
          intent: null,
          neutralised: false,
          landed: false,
        };
      }

      // Swarm membership and response state exist only on drones; a bird
      // flock has neither, so the fields are omitted rather than defaulted.
      const response =
        e.kind === "drone"
          ? {
              neutralised: e.neutralised ?? false,
              landed: e.landed ?? false,
              ...(e.role !== undefined ? { role: e.role } : {}),
              ...(e.group_id !== undefined ? { group_id: e.group_id } : {}),
            }
          : { neutralised: false, landed: false };

      return {
        id: e.id,
        kind: e.kind,
        pos: [e.pos.x, e.pos.y, e.pos.z] as [number, number, number],
        vel: [e.vel.x, e.vel.y, e.vel.z] as [number, number, number],
        affiliation_truth: e.affiliation_truth as Affiliation,
        intent: e.intent,
        ...response,
      };
    });
  }

  /**
   * Current sensing conditions, for the instructor console's readout.
   *
   * Weather is live rather than scenario-fixed once an instructor can change it
   * (FR-SIM-9), and the console needs to show what the trainee's sensors are
   * currently coping with. Contains no ground truth.
   */
  environment(): Environment {
    return this.sim.world.environment;
  }

  /**
   * Build the next frame: the view plus the events since the last broadcast.
   *
   * `role` decides filtering. For a trainee that is `filterForRole(events,
   * "trainee")`, which drops truth-bearing event types outright and strips
   * forbidden payload keys from the rest (PRD §6.4) — including
   * `sensor_observation.truth_ref`, which the scorer needs and the client does not.
   */
  frame(role: Role): Frame {
    const all = this.sim.log();
    const fresh = all.filter((e) => e.seq > this.broadcast_seq);
    const last = all[all.length - 1];
    if (last) this.broadcast_seq = last.seq;

    return {
      type: "tick",
      session_id: this.id,
      t_ms: this.t_ms(),
      view: this.view(),
      events: filterForRole(fresh, role),
    };
  }

  /** The whole log, role-filtered. For the AAR and the events endpoint. */
  eventsFor(
    role: Role,
    opts: { from_seq?: number; to_t_ms?: number; types?: readonly string[] } = {},
  ): readonly AnySimEvent[] {
    const scoped = this.sim.log().filter(
      (e) =>
        (opts.from_seq === undefined || e.seq >= opts.from_seq) &&
        (opts.to_t_ms === undefined || e.t_ms <= opts.to_t_ms) &&
        (opts.types === undefined || opts.types.length === 0 || opts.types.includes(e.type)),
    );
    return filterForRole(scoped, role);
  }

  /** Every event, unfiltered. Server-side persistence only — never a response body. */
  rawEvents(): readonly AnySimEvent[] {
    return this.sim.log();
  }

  /** Actions a client submitted, for the action endpoint's validation path. */
  controls() {
    return this.sim.controls();
  }

  /**
   * Fire one instructor inject right now (FR-SIM-9).
   *
   * Returns whether the sim could use the parameters. The `inject_applied` event is
   * logged either way — see `Session.inject` — so "not applied" means the world is
   * unchanged, not that the inject is absent from the record.
   */
  inject(type: string, params: Record<string, unknown>, by: string): boolean {
    return this.sim.inject(type, params, by);
  }

  /** Start stepping. `speed` is sim-milliseconds per wall-clock millisecond. */
  start(now: number, speed: number): void {
    if (this.status === "running" || this.status === "ended" || this.status === "scored") return;

    this.status = "running";
    this.last_tick_at = now;
    this.accumulator = 0;
    this.speed = Math.max(speed, 0.0001);

    // 50 ms of sim time per tick, so a tick is due every `TICK_MS / speed` ms of
    // wall clock. Above ~400× that falls below 1 ms, which `setInterval` cannot
    // honour — so the interval is floored and the accumulator absorbs the
    // remainder. The sim stays correct; only the frame rate degrades.
    const period = Math.max(1, Math.floor(TICK_MS / this.speed));
    this.timer = setInterval(() => this.pump(Date.now()), period);
    // Do not hold the process open for a session nobody is watching.
    this.timer.unref?.();
  }

  pause(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    if (this.status === "running") this.status = "paused";
  }

  resume(now: number, speed: number): void {
    if (this.status === "ended" || this.status === "scored") return;
    this.start(now, speed);
  }

  /**
   * Step as many ticks as are due, then publish one frame.
   *
   * The accumulator holds *sim* milliseconds, not wall-clock ones: the elapsed
   * wall time is multiplied by `speed` before it is banked, which is the whole
   * mechanism by which an instructor's 4× run actually runs at 4×. Without the
   * multiplier the interval floor at 1 ms caps every speed at 1×, and a
   * "speed control" that never changes the rate is a control in name only.
   *
   * The accumulator is also the reason a slow tick does not lose events: the next
   * call sees a larger debt and catches up, rather than the debt being discarded
   * and the scenario quietly running slow relative to the clock the trainee sees.
   * A single catch-up is capped so a stall — the process suspended, the machine
   * asleep — does not try to step minutes of sim in one call and freeze the loop
   * repaying it.
   */
  private pump(now: number): void {
    if (this.status !== "running") return;

    const elapsed = Math.max(0, now - this.last_tick_at);
    this.accumulator = Math.min(this.accumulator + elapsed * this.speed, MAX_SIM_DEBT_MS);
    this.last_tick_at = now;

    let ticked = false;
    while (this.accumulator >= TICK_MS) {
      this.accumulator -= TICK_MS;
      if (!this.sim.tick()) {
        this.finish("scenario_complete", now);
        return;
      }
      ticked = true;
    }

    if (ticked) this.emit("frame", this);
    if (this.sim.over()) this.finish("scenario_complete", now);
  }

  /** End the scenario early — a trainee quitting, or an instructor stopping it. */
  end(reason: string, now: number): void {
    this.finish(reason, now);
  }

  private finish(reason: string, now: number): void {
    if (this.status === "ended" || this.status === "scored") return;
    this.pause();
    this.status = "ended";
    this.ended_at = now;
    this.end_reason = reason;
    this.emit("ended", {
      type: "ended",
      session_id: this.id,
      reason,
      t_ms: this.t_ms(),
    } satisfies SessionEndedEvent);
  }

  /**
   * Score the run.
   *
   * Called once, at end. The scoring package is pure and there is no reason to
   * re-run it on a reconnect — and re-running it would risk two `scores` rows for
   * one session.
   */
  score(): ScoreResult {
    if (this.score_result) return this.score_result;

    const input: ScoreInput = {
      scenario_id: this.scenario.id,
      seed: this.scenario.seed,
      duration_ms: this.t_ms(),
      events: this.sim.log(),
      expected: this.scenario.expected,
      correlation: this.sim.correlation(),
      truth: truthEntitiesForScoring(this.sim),
    };

    this.score_result = scoreRun(input);
    this.status = "scored";
    return this.score_result;
  }

  dispose(): void {
    this.pause();
    this.removeAllListeners();
  }

  /** Sim state for persistence. */
  snapshot(): { status: SessionStatus; duration_ms: number | null; end_reason: string | null } {
    return {
      status: this.status,
      duration_ms: this.ended_at === null ? null : this.t_ms(),
      end_reason: this.end_reason,
    };
  }
}

/**
 * Ground truth in the shape the scorer wants.
 *
 * Every airborne entity, not just drones: a bird flock carries `affiliation`
 * `non_uas` and `intent` `none`, and N5 grades exactly the distinction a trainee
 * has to make between it and a hostile. Leaving flocks out would hand a perfect
 * classification score to anyone who ignored them.
 */
const truthEntitiesForScoring = (sim: Session): Map<string, TruthEntityView & { affiliation_truth: Affiliation; intent: string }> => {
  const out = new Map<string, TruthEntityView & { affiliation_truth: Affiliation; intent: string }>();
  for (const e of sim.world.entities()) {
    if (!isAirborne(e)) continue;
    const response =
      e.kind === "drone"
        ? {
            neutralised: e.neutralised ?? false,
            landed: e.landed ?? false,
            ...(e.role !== undefined ? { role: e.role } : {}),
            ...(e.group_id !== undefined ? { group_id: e.group_id } : {}),
          }
        : { neutralised: false, landed: false };
    out.set(e.id, {
      id: e.id,
      kind: e.kind,
      pos: [e.pos.x, e.pos.y, e.pos.z],
      vel: [e.vel.x, e.vel.y, e.vel.z],
      affiliation_truth: e.affiliation_truth as Affiliation,
      intent: e.intent,
      ...response,
    });
  }
  return out;
};

/** Find a scripted scenario by id, for the session-create endpoint. */
export const scriptedScenarioById = (id: string): Scenario | undefined =>
  SCRIPTED_SCENARIOS.find((s) => s.id === id);
