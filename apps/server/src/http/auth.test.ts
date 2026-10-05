/**
 * Auth and RBAC API tests (PRD §14 M5 DoD, §17).
 *
 * The DoD's first clause is "trainee cannot read others' sessions". That is one
 * instance of a general rule — a caller's role decides what they may touch — so
 * this file covers the rule itself and `sessions.test.ts` covers the instance.
 *
 * These tests go through the HTTP layer on purpose. The RBAC check is a
 * `preHandler` the routes declare, and a route that forgets to declare it is the
 * failure mode that a repository-level test cannot see.
 */

import request from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { buildTestApp, type TestApp } from "../testing/harness.js";

let test: TestApp;

beforeAll(async () => {
  test = await buildTestApp();
  await test.listen();
});

afterAll(async () => {
  await test.close();
});

const auth = (username: string) => {
  const user = test.users.get(username);
  if (!user) throw new Error(`no user ${username}; call test.user first`);
  return { authorization: `Bearer ${user.token}` };
};

describe("login", () => {
  it("accepts a correct password and returns a token", async () => {
    await test.user("alice", "trainee");

    const res = await request(test.app.server)
      .post("/api/auth/login")
      .send({ username: "alice", password: "alice" });

    expect(res.status).toBe(200);
    expect(res.body.token).toBeTypeOf("string");
    expect(res.body.user).toMatchObject({ username: "alice", role: "trainee" });
    // The hash is never handed back, not even to the account it belongs to.
    expect(JSON.stringify(res.body)).not.toMatch(/password_hash/);
  });

  it("answers a wrong password exactly like an unknown username", async () => {
    // PRD §17: the two failure modes must be indistinguishable, or this endpoint
    // becomes a username oracle. Same status, same body, same everything.
    const badUser = await request(test.app.server)
      .post("/api/auth/login")
      .send({ username: "nobody", password: "whatever" });
    const badPassword = await request(test.app.server)
      .post("/api/auth/login")
      .send({ username: "alice", password: "wrong" });

    expect(badUser.status).toBe(badPassword.status);
    expect(badUser.status).toBe(401);
    expect(badPassword.body).toEqual(badUser.body);
  });

  it("rejects an unauthenticated request to a protected route", async () => {
    const res = await request(test.app.server).get("/api/me");
    expect(res.status).toBe(401);
  });

  it("rejects a token the server did not sign", async () => {
    const res = await request(test.app.server)
      .get("/api/me")
      .set("authorization", "Bearer not.a.token");
    expect(res.status).toBe(401);
  });

  it("identifies the caller from a valid token", async () => {
    const res = await request(test.app.server).get("/api/me").set(auth("alice"));
    expect(res.status).toBe(200);
    expect(res.body.user).toMatchObject({ username: "alice", role: "trainee" });
  });
});

describe("account administration is admin-only", () => {
  it("lets an admin create a trainee", async () => {
    await test.user("root", "admin");

    const res = await request(test.app.server)
      .post("/api/users")
      .set(auth("root"))
      .send({ username: "bobby", password: "bobby", role: "trainee" });

    expect(res.status).toBe(201);
    expect(res.body.user).toMatchObject({ username: "bobby", role: "trainee" });
  });

  it("forbids a trainee from creating accounts", async () => {
    const res = await request(test.app.server)
      .post("/api/users")
      .set(auth("alice"))
      .send({ username: "eve", password: "eve", role: "trainee" });

    expect(res.status).toBe(403);
    expect(res.body.error).toBe("forbidden");
  });

  it("forbids a trainee from listing accounts", async () => {
    const res = await request(test.app.server).get("/api/users").set(auth("alice"));
    expect(res.status).toBe(403);
  });

  it("lets an admin list accounts", async () => {
    await test.user("carol", "trainee");
    const res = await request(test.app.server).get("/api/users").set(auth("root"));
    expect(res.status).toBe(200);
    const usernames = res.body.users.map((u: { username: string }) => u.username);
    expect(usernames).toContain("alice");
    expect(usernames).toContain("carol");
  });

  it("refuses a duplicate username rather than overwriting one", async () => {
    const res = await request(test.app.server)
      .post("/api/users")
      .set(auth("root"))
      .send({ username: "alice", password: "x", role: "trainee" });

    expect(res.status).toBe(409);
    expect(res.body.error).toBe("username_taken");
  });

  it("forbids a trainee from reading the audit trail", async () => {
    // The audit log records what other users did; it is staff-only (PRD §17).
    const res = await request(test.app.server).get("/api/audit").set(auth("alice"));
    expect(res.status).toBe(403);
  });

  it("lets an admin read the audit trail", async () => {
    const res = await request(test.app.server).get("/api/audit").set(auth("root"));
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body.entries)).toBe(true);
  });
});

describe("role enforcement on routes a trainee can reach", () => {
  it("forbids a trainee from pausing a session", async () => {
    // Pause is instructor-only by design: freezing the world to buy decision time
    // is not a skill the trainer assesses, so a trainee cannot have the control.
    await test.user("instructor", "instructor");
    const res = await request(test.app.server)
      .post("/api/sessions/ses_does-not-exist/pause")
      .set(auth("alice"));

    expect(res.status).toBe(403);
    expect(res.body.error).toBe("forbidden");
  });

  it("lets an instructor reach the instructor-only endpoint", async () => {
    // The 404 here proves the trainee's 403 above was about role, not route shape:
    // the same request from an instructor passes the gate and then misses the
    // session, which is the correct failure for a role that may pause things.
    const res = await request(test.app.server)
      .post("/api/sessions/ses_does-not-exist/pause")
      .set(auth("instructor"));

    expect(res.status).toBe(404);
  });

  it("forbids an instructor from administering accounts", async () => {
    // RBAC is per-route, not per-tier: an instructor outranks a trainee on the
    // console but still cannot mint users.
    const res = await request(test.app.server)
      .post("/api/users")
      .set(auth("instructor"))
      .send({ username: "mallory", password: "mallory", role: "trainee" });

    expect(res.status).toBe(403);
  });
});
