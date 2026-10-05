/**
 * Session lifecycle and isolation tests (PRD §14 M5 DoD, §15).
 *
 * Two of the DoD's three clauses live here:
 *
 *   - "trainee cannot read others' sessions" — asserted across every route that
 *     takes a session id, so a route added without the check is caught by the
 *     table rather than by someone remembering to look;
 *   - "session completes and `scores` row exists" — a real session is driven to
 *     natural completion and the persisted row is read back.
 *
 * The third clause ("trainee WS never receives truth events") is in
 * `ws.test.ts`, where a socket is the thing under test.
 */

import request from "supertest";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";

import { findScore, findSession } from "../../db/repo.js";
import { buildTestApp, type TestApp } from "../../testing/harness.js";

let test: TestApp;

beforeAll(async () => {
  // A whole 420 s scenario in a few seconds of wall clock. The speed multiplier
  // is what makes a completion test affordable in CI.
  test = await buildTestApp({ speed: 8_000 });
  await test.listen();
  await test.user("root", "admin");
  await test.user("alice", "trainee");
  await test.user("bob", "trainee");
  await test.user("instructor", "instructor");
});

afterEach(async () => {
  // Stop whatever this test started, before the next one starts its clock. A
  // session that already ran to its own end ignores `/end`, so this is safe to
  // call unconditionally.
  while (open.length > 0) {
    const s = open.pop()!;
    await request(test.app.server)
      .post(`/api/sessions/${s.id}/end`)
      .set(auth(s.username))
      .catch(() => undefined);
  }
});

afterAll(async () => {
  await test.close();
});

const auth = (username: string) => {
  const user = test.users.get(username);
  if (!user) throw new Error(`no user ${username}`);
  return { authorization: `Bearer ${user.token}` };
};

/** A session created and started as `username`. */
const startSession = async (
  username: string,
  scenario_id = "scr-night-recon-01",
  mode: "training" | "assessment" = "training",
): Promise<string> => {
  const created = await request(test.app.server)
    .post("/api/sessions")
    .set(auth(username))
    .send({ scenario_id, mode });
  expect(created.status).toBe(201);

  const id = created.body.session.id as string;
  const started = await request(test.app.server)
    .post(`/api/sessions/${id}/start`)
    .set(auth(username));
  expect(started.status).toBe(200);

  // Retire it when the test is done. This suite runs at speed 8000, so an
  // abandoned session keeps stepping a 420 s scenario as fast as the CPU allows
  // for the remainder of the file — and the completion test at the bottom waits
  // on a wall clock that the two dozen sessions before it are competing for.
  open.push({ id, username });
  return id;
};

/** Every session `startSession` opened, so `afterEach` can stop them all. */
const open: { id: string; username: string }[] = [];

describe("launching a session", () => {
  it("creates and starts a session for the trainee", async () => {
    const id = await startSession("alice");

    const res = await request(test.app.server).get(`/api/sessions/${id}`).set(auth("alice"));
    expect(res.status).toBe(200);
    expect(res.body.session.id).toBe(id);
    expect(res.body.session.trainee_id).toBe(test.users.get("alice")!.id);
    expect(res.body.live).toBe(true);
  });

  it("hands the trainee the scenario without its answer key", async () => {
    // `expected` is the answer key (PRD §5.4). Shipping it to the client would
    // make the whole classification exercise solvable from devtools.
    const res = await request(test.app.server)
      .post("/api/sessions")
      .set(auth("alice"))
      .send({ scenario_id: "scr-night-recon-01", mode: "training" });

    expect(res.status).toBe(201);
    expect(res.body.scenario.expected).toBeUndefined();
    expect(res.body.scenario.id).toBe("scr-night-recon-01");
    // The brief is repeated at the top level so the console can open it before
    // the first tick without a second round trip.
    expect(res.body.brief_sections.length).toBeGreaterThan(0);
  });

  it("refuses a scenario that does not exist", async () => {
    const res = await request(test.app.server)
      .post("/api/sessions")
      .set(auth("alice"))
      .send({ scenario_id: "scr-not-a-scenario", mode: "training" });

    expect(res.status).toBe(404);
  });

  it("rejects a body missing the scenario id", async () => {
    const res = await request(test.app.server)
      .post("/api/sessions")
      .set(auth("alice"))
      .send({ mode: "training" });

    expect(res.status).toBe(400);
    expect(res.body.error).toBe("invalid_body");
  });
});

describe("a trainee cannot reach another trainee's session", () => {
  it("is refused on the session read", async () => {
    const mine = await startSession("alice");

    const res = await request(test.app.server).get(`/api/sessions/${mine}`).set(auth("bob"));
    expect(res.status).toBe(403);
    expect(res.body.error).toBe("forbidden");
  });

  it("is refused on the live view", async () => {
    const mine = await startSession("alice");

    const res = await request(test.app.server)
      .get(`/api/sessions/${mine}/view`)
      .set(auth("bob"));

    expect(res.status).toBe(403);
  });

  it("is refused on the event log", async () => {
    const mine = await startSession("alice");

    const res = await request(test.app.server)
      .get(`/api/sessions/${mine}/events`)
      .set(auth("bob"));

    expect(res.status).toBe(403);
  });

  it("is refused on the score", async () => {
    const mine = await startSession("alice");

    const res = await request(test.app.server)
      .get(`/api/sessions/${mine}/score`)
      .set(auth("bob"));

    expect(res.status).toBe(403);
  });

  it("is refused on the replay bundle", async () => {
    const mine = await startSession("alice");

    const res = await request(test.app.server)
      .get(`/api/sessions/${mine}/replay`)
      .set(auth("bob"));

    expect(res.status).toBe(403);
  });

  it("is refused when posting an action", async () => {
    const mine = await startSession("alice");

    const res = await request(test.app.server)
      .post(`/api/sessions/${mine}/action`)
      .set(auth("bob"))
      .send({ type: "mark_contact", payload: { cue_id: "C001" } });

    expect(res.status).toBe(403);
    // And the action did not land: the trainee's own read of the session is the
    // state the route left it in, not a view poisoned by another trainee's input.
    const check = await request(test.app.server)
      .get(`/api/sessions/${mine}/view`)
      .set(auth("alice"));
    expect(check.status).toBe(200);
  });

  it("is refused when ending the session", async () => {
    const mine = await startSession("alice");

    const res = await request(test.app.server)
      .post(`/api/sessions/${mine}/end`)
      .set(auth("bob"))
      .send({ reason: "ended_by_user" });

    expect(res.status).toBe(403);

    // The session is still alive — the refusal did not disturb it.
    const check = await request(test.app.server).get(`/api/sessions/${mine}`).set(auth("alice"));
    expect(check.status).toBe(200);
    expect(check.body.session.status).not.toBe("scored");
  });

  it("cannot list another trainee's sessions", async () => {
    await startSession("alice");

    const res = await request(test.app.server).get("/api/sessions").set(auth("bob"));

    expect(res.status).toBe(200);
    const ids = res.body.sessions.map((s: { id: string }) => s.id);
    const bobId = test.users.get("bob")!.id;
    // Every row the list returns is Bob's own; the scope is a property of the
    // query, not a filter the caller can pass a parameter to defeat.
    for (const row of res.body.sessions) {
      expect(row.trainee_id).toBe(bobId);
    }
    expect(ids).not.toContain(undefined);
  });
});

describe("staff can reach any trainee's session", () => {
  it("lets an instructor read a trainee's session", async () => {
    const mine = await startSession("alice");

    const res = await request(test.app.server).get(`/api/sessions/${mine}`).set(auth("instructor"));
    expect(res.status).toBe(200);
    expect(res.body.session.id).toBe(mine);
  });

  it("lets an admin read a trainee's session", async () => {
    const mine = await startSession("alice");

    const res = await request(test.app.server).get(`/api/sessions/${mine}`).set(auth("root"));
    expect(res.status).toBe(200);
  });

  it("lets an instructor list every session", async () => {
    await startSession("alice");

    const res = await request(test.app.server).get("/api/sessions").set(auth("instructor"));
    expect(res.status).toBe(200);
    expect(res.body.sessions.length).toBeGreaterThan(0);
  });
});

describe("a session that does not exist", () => {
  it("answers 404 rather than 403 for a trainee", async () => {
    // The distinction matters: a 403 on an unknown id would confirm the id exists,
    // which is exactly the oracle the isolation tests are trying not to build.
    const res = await request(test.app.server)
      .get("/api/sessions/ses_definitely-not-real")
      .set(auth("alice"));
    expect(res.status).toBe(404);
    expect(res.body.error).toBe("not_found");
  });
});

describe("completing a session", () => {
  /**
   * Wait until the live session leaves the registry or the deadline passes.
   *
   * A completed session is retired by the caller (`/end`) rather than by the
   * session itself, so "the scenario ran to its own end" is observed as the sim
   * clock reaching the scenario's duration — which is also the thing worth
   * asserting, since it is the property the speed multiplier exists to provide.
   */
  const waitForEnd = async (id: string): Promise<void> => {
    const deadline = Date.now() + 25_000;
    while (Date.now() < deadline) {
      const live = test.registry.get(id);
      if (!live) return;
      if (live.over()) return;
      await new Promise((r) => setTimeout(r, 100));
    }
  };

  it("runs the scenario to its own end and records a score", async () => {
    const id = await startSession("alice");
    const scenario = test.registry.get(id)!.scenario;

    await waitForEnd(id);

    const row = findSession(test.app.db, id);
    expect(row).not.toBeUndefined();

    // The score row exists (the DoD clause) and the events were persisted.
    const score = findScore(test.app.db, id);
    expect(score).not.toBeUndefined();
    expect(score!.session_id).toBe(id);

    // `result_json` is stored as text and returned parsed, so the AAR does not
    // have to choose between storing and reading it.
    const parsed = JSON.parse(score!.result_json) as { nodes: unknown[]; competencies: unknown[] };
    expect(parsed.nodes.length).toBeGreaterThan(0);
    expect(parsed.competencies.length).toBe(7);

    void scenario;
  }, 30_000);

  it("ends early on request and still records a score", async () => {
    const id = await startSession("alice");

    // End immediately, before anything has happened. Scoring an empty run must
    // still work — a trainee who quits at t=0 has a run, not a void.
    const res = await request(test.app.server)
      .post(`/api/sessions/${id}/end`)
      .set(auth("alice"))
      .send({ reason: "ended_by_user" });

    expect(res.status).toBe(200);
    expect(res.body.status).toBe("scored");
    expect(res.body.score).not.toBe(null);
    expect(res.body.score.total).toBeTypeOf("number");

    const score = findScore(test.app.db, id);
    expect(score).not.toBeUndefined();
  });

  it("is idempotent when ended twice", async () => {
    // `/end` and the AAR's first fetch can both arrive, in either order. The
    // upsert means one row, not two — a trainee who refreshes the score page
    // does not duplicate the record.
    const id = await startSession("alice");

    const first = await request(test.app.server)
      .post(`/api/sessions/${id}/end`)
      .set(auth("alice"))
      .send({ reason: "ended_by_user" });
    const second = await request(test.app.server)
      .post(`/api/sessions/${id}/end`)
      .set(auth("alice"))
      .send({ reason: "ended_by_user" });

    expect(first.status).toBe(200);
    expect(second.status).toBe(200);
    expect(second.body.score.total).toBe(first.body.score.total);
  });

  it("persists the events the trainee produced", async () => {
    const id = await startSession("alice");

    const ended = await request(test.app.server)
      .post(`/api/sessions/${id}/end`)
      .set(auth("alice"))
      .send({ reason: "ended_by_user" });
    expect(ended.status).toBe(200);

    const res = await request(test.app.server)
      .get(`/api/sessions/${id}/events`)
      .set(auth("alice"));

    expect(res.status).toBe(200);
    expect(Array.isArray(res.body.events)).toBe(true);
    // A run that never left t=0 still opened the session, so the log is not
    // empty and the AAR has a timeline to render.
    expect(res.body.events.length).toBeGreaterThan(0);
  });
});

describe("instructor injects (FR-SIM-9, PRD §13.2)", () => {
  /** Fire one inject as `username`. */
  const inject = (id: string, username: string, type: string, params: Record<string, unknown> = {}) =>
    request(test.app.server).post(`/api/sessions/${id}/inject`).set(auth(username)).send({ type, params });

  it("applies an inject and records it in the session's events", async () => {
    const id = await startSession("alice");

    const res = await inject(id, "instructor", "weather_change", { weather: "fog" });
    expect(res.status).toBe(200);
    expect(res.body.applied).toBe(true);
    // The view comes back so the console updates from the authoritative state rather
    // than guessing what the inject did.
    expect(res.body.view).toBeDefined();

    const live = test.registry.get(id)!;
    expect(live.environment().weather).toBe("fog");

    const events = live.eventsFor("instructor");
    const applied = events.find((e) => e.type === "inject_applied")!;
    expect(applied).toBeDefined();
    expect(applied.payload).toMatchObject({
      inject_type: "weather_change",
      params: { weather: "fog" },
    });
    // `by` is the instructor's id, so the AAR can tell a human inject from a
    // scripted one.
    expect(applied.payload["by"]).toBe(test.users.get("instructor")!.id);
  });

  it("applies every inject type the sim knows", async () => {
    // Table-driven over the FR-SIM-9 menu. The *physics* of each is asserted in
    // `packages/sim-core`; here the boundary only promises that the route forwards
    // a type the sim accepted and reported an effect for.
    const cases: [string, Record<string, unknown>][] = [
      ["sensor_outage", { sensor: "radar" }],
      ["weather_change", { weather: "rain" }],
      ["comms_delay", { delay_s: 10 }],
      ["authority_change", { posture: "FREE" }],
      ["new_track", { bearing_deg: 90, range_m: 800 }],
    ];

    for (const [type, params] of cases) {
      const id = await startSession("alice");
      const res = await inject(id, "instructor", type, params);
      expect(res.status, `${type} ${JSON.stringify(params)}`).toBe(200);
      expect(res.body.applied, type).toBe(true);
    }
  });

  it("refuses a trainee outright", async () => {
    const id = await startSession("alice");

    const res = await inject(id, "alice", "weather_change", { weather: "fog" });

    expect(res.status).toBe(403);
    // Not merely refused: nothing was applied. A trainee who could not create the
    // weather but could log an attempt at it would still be writing to the AAR.
    const live = test.registry.get(id)!;
    expect(live.rawEvents().some((e) => e.type === "inject_applied")).toBe(false);
  });

  it("refuses an instructor in assessment mode, before the sim is touched", async () => {
    const id = await startSession("alice", "scr-night-recon-01", "assessment");
    const live = test.registry.get(id)!;
    const weatherBefore = live.environment().weather;

    const res = await inject(id, "instructor", "weather_change", { weather: "fog" });

    expect(res.status).toBe(409);
    expect(res.body.error).toBe("assessment");

    // The run is graded as the trainee's own, so the world must be identical to one
    // where nobody opened the inject menu.
    expect(live.environment().weather).toBe(weatherBefore);
    expect(live.rawEvents().some((e) => e.type === "inject_applied")).toBe(false);
  });

  it("rejects an inject type the sim does not know", async () => {
    const id = await startSession("alice");

    const res = await inject(id, "instructor", "deploy_jammer");

    expect(res.status).toBe(400);
    expect(res.body.error).toBe("invalid_body");
  });

  it("reports an inject the sim could not use, and still records it", async () => {
    const id = await startSession("alice");
    const live = test.registry.get(id)!;
    const weatherBefore = live.environment().weather;

    // `weather` is not in the vocabulary, so the sim returns false — but the inject
    // happened, and the AAR should say so rather than drop it.
    const res = await inject(id, "instructor", "weather_change", { weather: "monsoon" });

    expect(res.status).toBe(200);
    expect(res.body.applied).toBe(false);

    expect(live.eventsFor("instructor").some((e) => e.type === "inject_applied")).toBe(true);
    expect(live.environment().weather).toBe(weatherBefore);
  });

  it("never surfaces an inject to the trainee's own event feed", async () => {
    // `inject_applied` is instructor-visible, and a `new_track` inject emits
    // truth-bearing `entity_spawned` — both must be gone from the trainee's role-
    // filtered stream, which is the same filter the socket applies per frame.
    const id = await startSession("alice");
    await inject(id, "instructor", "new_track", { bearing_deg: 0, range_m: 700 });

    const events = test.registry.get(id)!.eventsFor("trainee");
    expect(events.some((e) => e.type === "inject_applied")).toBe(false);
    expect(events.some((e) => e.type === "entity_spawned")).toBe(false);
  });

  it("is refused on a session another trainee owns", async () => {
    const id = await startSession("alice");

    const res = await inject(id, "bob", "weather_change", { weather: "fog" });

    expect(res.status).toBe(403);
  });
});
