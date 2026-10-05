/**
 * WebSocket truth-boundary tests (PRD §14 M5 DoD clause 3, §6.4, §18.6).
 *
 * The DoD clause is "trainee WS never receives truth events". This asserts it at
 * the socket itself: a real client is opened against a real listening server, the
 * scenario is allowed to run, and *every byte* the client receives is scanned for
 * the forbidden keys and the truth-bearing event types.
 *
 * Two properties make this more than a tautology:
 *
 *   - The trainee's socket is connected while truth is actively being generated,
 *     so a field that leaked only on a live tick is caught, not just one that
 *     leaked in the connection snapshot.
 *   - An instructor's socket on the same session *does* receive truth-bearing
 *     events, so "nothing leaked" is evidence the filter worked rather than that
 *     the scenario had nothing to leak.
 */

import { WebSocket } from "ws";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";

import { findForbiddenKeys, TRUTH_BEARING_EVENT_TYPES } from "@skysentinel/shared";

import { buildTestApp, type TestApp } from "./testing/harness.js";

let test: TestApp;

beforeAll(async () => {
  // Fast enough to produce a good number of frames inside the test's window.
  test = await buildTestApp({ speed: 6_000 });
  await test.listen();
  await test.user("alice", "trainee");
  await test.user("bob", "trainee");
  await test.user("instructor", "instructor");
});

afterEach(async () => {
  // Retire whatever this test started, before the next one starts its clock.
  // A session that has already run to its own end ignores `/end`, so this is
  // safe to call unconditionally.
  while (open.length > 0) {
    const s = open.pop()!;
    await fetch(`${test.origin()}/api/sessions/${s.id}/end`, {
      method: "POST",
      headers: { authorization: `Bearer ${s.token}` },
    }).catch(() => undefined);
  }
});

afterAll(async () => {
  await test.close();
});

/**
 * Open a socket as `username`, or with an explicit `token`, and resolve every
 * message it receives.
 *
 * Collects until the socket closes or `budget_ms` of wall clock has passed,
 * whichever comes first. A socket that errors resolves what it has — the caller
 * asserts on what arrived, and an empty result set is itself a finding.
 */
const collect = (
  sessionId: string,
  auth: string,
  budgetMs: number,
): Promise<{ messages: unknown[]; code: number | null }> =>
  new Promise((resolve) => {
    const messages: unknown[] = [];
    let code: number | null = null;
    let settled = false;

    const finish = () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ messages, code });
    };

    const url = new URL("/ws", test.origin());
    url.searchParams.set("session_id", sessionId);
    url.searchParams.set("token", auth);

    const socket = new WebSocket(url);
    const timer = setTimeout(() => {
      socket.terminate();
      finish();
    }, budgetMs);

    socket.on("message", (raw) => {
      try {
        messages.push(JSON.parse(raw.toString()));
      } catch {
        messages.push({ unparseable: raw.toString() });
      }
    });
    socket.on("close", (c) => {
      code = c;
      finish();
    });
    socket.on("error", () => finish());
  });

/** Resolve the bearer token for a user the harness has minted. */
const tokenOf = (username: string): string => {
  const user = test.users.get(username);
  if (!user) throw new Error(`no user ${username}`);
  return user.token;
};

/**
 * Start a session as `username` and return its id.
 *
 * The socket is opened after `start` so the connection snapshot and the first
 * frames both come from a live, stepping simulation.
 */
const startSession = async (username: string, scenario_id = "scr-night-recon-01"): Promise<string> => {
  const user = test.users.get(username);
  if (!user) throw new Error(`no user ${username}`);

  const created = await fetch(`${test.origin()}/api/sessions`, {
    method: "POST",
    headers: { authorization: `Bearer ${user.token}`, "content-type": "application/json" },
    body: JSON.stringify({ scenario_id, mode: "training" }),
  });
  expect(created.status).toBe(201);
  const { session } = (await created.json()) as { session: { id: string } };

  const started = await fetch(`${test.origin()}/api/sessions/${session.id}/start`, {
    method: "POST",
    headers: { authorization: `Bearer ${user.token}` },
  });
  expect(started.status).toBe(200);

  // Retire the session when the test that opened it is done. Each of these runs
  // at speed 6000, so a session left running keeps stepping a 420 s scenario as
  // fast as the CPU allows — and the *next* test's socket budget is measured
  // against a wall clock that four of those now compete for. Without this the
  // suite fails on a machine that is merely busy, and the rejection tests are the
  // ones that notice, because they assert a close within a couple of seconds.
  open.push({ id: session.id, token: user.token });
  return session.id;
};

/** Every session `startSession` opened, so `afterEach` can stop them all. */
const open: { id: string; token: string }[] = [];

describe("a trainee's socket", () => {
  it("receives frames but never a truth field", async () => {
    const id = await startSession("alice");

    // The window is wall clock, not sim time: the point is to sit on the socket
    // while ticks are being published, so a leak that only appears on a live
    // frame is observed.
    const { messages } = await collect(id, tokenOf("alice"), 2_500);

    // The socket delivered something — the connection snapshot at minimum. A test
    // that received nothing cannot claim the boundary held.
    expect(messages.length).toBeGreaterThan(0);

    // The scan is recursive and covers every message type this socket can see:
    // the connection snapshot, the per-tick frames, and the terminal `ended`.
    // `findForbiddenKeys` is the same walker the shared package exports for the
    // AAR leak test, so "clean" means the same thing on both sides of the wire.
    const hits = messages.flatMap((m) => findForbiddenKeys(m));
    expect(hits).toEqual([]);
  }, 30_000);

  it("never receives a truth-bearing event type", async () => {
    const id = await startSession("alice");
    const { messages } = await collect(id, tokenOf("alice"), 2_500);

    // `filterForRole` drops `entity_spawned` and `entity_state` for a trainee
    // outright, before key stripping — a trainee learns an entity exists only
    // through their own sensor picture. Asserted separately from the key scan
    // because a stripped event of a forbidden type would pass the key test while
    // still revealing the truth schedule.
    const eventTypes = messages.flatMap((m) => {
      const msg = m as { events?: { type: string }[] };
      return (msg.events ?? []).map((e) => e.type);
    });

    for (const type of eventTypes) {
      expect(TRUTH_BEARING_EVENT_TYPES).not.toContain(type);
    }

    // And the trainee did see the world: the frames carry a view with tracks,
    // so "no truth events" is not "no events at all".
    const frames = messages.filter((m) => (m as { type?: string }).type === "tick");
    expect(frames.length).toBeGreaterThan(0);
    expect((frames[0] as { view: unknown }).view).toBeDefined();
  }, 30_000);
});

describe("an instructor's socket on the same session", () => {
  it("does receive the truth a trainee is denied", async () => {
    const id = await startSession("alice");
    const { messages } = await collect(id, tokenOf("instructor"), 2_500);

    expect(messages.length).toBeGreaterThan(0);

    // The instructor is *supposed* to see truth — the truth map is their tool
    // (PRD §13.2). If this assertion failed, the trainee's clean result above
    // would prove nothing about the filter: an empty scenario leaks from no role.
    const hits = messages.flatMap((m) => findForbiddenKeys(m));
    expect(hits.length).toBeGreaterThan(0);
  }, 30_000);
});

describe("sockets that must not reach a session", () => {
  it("rejects a trainee who is not the session's owner", async () => {
    const id = await startSession("alice");

    const { messages, code } = await collect(id, tokenOf("bob"), 2_000);

    // The server sends one error frame and closes, so the socket ends with a
    // reason rather than timing out silently.
    expect(code).not.toBe(null);
    expect(messages).toContainEqual({ type: "error", message: "forbidden" });
  }, 30_000);

  it("rejects a token the server did not sign", async () => {
    const id = await startSession("alice");

    const { messages, code } = await collect(id, `${tokenOf("alice")}corrupted`, 2_000);

    // The socket is closed rather than subscribed: no frames, no snapshot, no
    // subscription to future ticks. The one message it may carry is the rejection
    // itself, which arrives before the close.
    expect(code).not.toBe(null);
    const frames = messages.filter((m) => (m as { type?: string }).type === "tick");
    expect(frames).toEqual([]);
  }, 30_000);
});
