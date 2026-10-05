/**
 * Live session registry (PRD §6.3).
 *
 * The set of simulations this server currently owns. Held in memory rather than
 * reconstructed from the database, because a `Session` holds the tracker, the
 * world's entity list and the PRNG state — the database holds the events, and a
 * log cannot be stepped. A session that has ended is dropped from here and read
 * back from SQLite for the AAR.
 *
 * This is the single place that decides whether a session id is live, so "is this
 * session still running" is answered once rather than inferred by each route.
 */

import { SCRIPTED_SCENARIOS } from "@skysentinel/scenario";
import type { Scenario } from "@skysentinel/scenario";

import { LiveSession } from "./live.js";
import type { LiveSessionOptions } from "./types.js";
import { nowIso } from "../ids.js";

/**
 * What the registry does when a session reaches its own end.
 *
 * Wiring this through the constructor keeps the registry free of the database and
 * the scorer — `main` decides what "a run finished" means, the registry only
 * owns the set of live simulations.
 */
export type OnSessionEnded = (session: LiveSession) => void;

export interface RegistryOptions {
  /**
   * Called once, when a session ends itself rather than being ended by a route.
   *
   * The server owns the authoritative simulation, so it must persist its own
   * completion: a trainee whose socket dropped, or who closed the tab, still
   * finished the exercise, and a run that scores only if a client stayed
   * attached is a run whose score depends on the network.
   */
  onEnded?: OnSessionEnded;
}

export class SessionRegistry {
  private readonly live = new Map<string, LiveSession>();
  private readonly onEnded?: OnSessionEnded;

  constructor(options: RegistryOptions = {}) {
    this.onEnded = options.onEnded;
  }

  create(scenario: Scenario, opts: Omit<LiveSessionOptions, "scenario" | "created_at">): LiveSession {
    const session = new LiveSession({ ...opts, scenario, created_at: nowIso() });
    this.live.set(session.id, session);

    // Listened to here rather than in `ws.ts` because the end has to be persisted
    // whether or not a socket is attached. See `RegistryOptions.onEnded`.
    session.on("ended", () => this.handleEnded(session));

    return session;
  }

  get(id: string): LiveSession | undefined {
    return this.live.get(id);
  }

  /**
   * A session ended itself.
   *
   * Persistence first, retirement second, and the retirement is deferred a beat:
   * `dispose()` strips the session's listeners, and the socket layer's own
   * `ended` listener still needs the session to fire on. Disposing synchronously
   * here would send the trainee nothing at all on the run they just completed.
   */
  private handleEnded(session: LiveSession): void {
    if (!this.onEnded) return;
    this.onEnded(session);
    setTimeout(() => this.retire(session.id), 0);
  }

  /** Every live session. For the instructor's session list. */
  all(): readonly LiveSession[] {
    return [...this.live.values()];
  }

  /**
   * Drop a finished session.
   *
   * Only callable once ended, so a caller cannot accidentally evict a run that is
   * still stepping — which would leave the trainee's client connected to a session
   * that will never send another frame.
   */
  retire(id: string): boolean {
    const session = this.live.get(id);
    if (!session) return false;
    if (session.currentStatus() !== "ended" && session.currentStatus() !== "scored") return false;

    session.dispose();
    return this.live.delete(id);
  }

  /** Stop everything. On server shutdown, so no timer outlives the process. */
  shutdown(): void {
    for (const s of this.live.values()) s.dispose();
    this.live.clear();
  }
}

/** Every shipped scripted scenario, for the scenario picker. */
export const allScriptedScenarios = (): readonly Scenario[] => SCRIPTED_SCENARIOS;
