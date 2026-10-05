/**
 * REST client (PRD §15).
 *
 * The interesting behaviour is the failure surface: a trainer runs offline, so a
 * server that is not there and a server that says no must both surface as a
 * typed `ApiFailure` rather than a raw `TypeError` the UI would render as
 * "undefined is not a function".
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { PublicUser } from "./types.js";

import { ApiFailure, api, getStoredUser, getToken, injectSession, login, setToken } from "./api.js";

describe("api()", () => {
  const fetchMock = vi.fn();
  const json = (body: unknown, ok = true, status = 200): Response =>
    ({ ok, status, json: async () => body }) as unknown as Response;

  beforeEach(() => {
    vi.stubGlobal("fetch", fetchMock);
    localStorage.clear();
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    fetchMock.mockReset();
  });

  it("carries the stored bearer token on every call", () => {
    fetchMock.mockResolvedValue(json({ ok: true }));
    setToken("abc.def.ghi");

    void api("/api/sessions");

    const [, init] = fetchMock.mock.calls[0]!;
    expect(init?.headers).toMatchObject({ Authorization: "Bearer abc.def.ghi" });
  });

  it("omits the header rather than sending a null bearer", () => {
    // `Authorization: Bearer null` is a header a strict server logs as a bad token.
    fetchMock.mockResolvedValue(json({ ok: true }));

    void api("/api/sessions");

    const [, init] = fetchMock.mock.calls[0]!;
    expect(init?.headers).not.toHaveProperty("Authorization");
  });

  it("unwraps the JSON body on success", async () => {
    fetchMock.mockResolvedValue(json({ sessions: [] }));
    await expect(api("/api/sessions")).resolves.toEqual({ sessions: [] });
  });

  it("turns an error body into a typed ApiFailure", async () => {
    // The UI switches on `code` (`assessment_locked`, `not_found`, …), so the code
    // must survive the hop from server to catch block.
    fetchMock.mockResolvedValue(json({ error: "assessment_locked", message: "Injects are disabled" }, false, 403));

    await expect(api("/api/sessions/x/inject")).rejects.toMatchObject({
      status: 403,
      code: "assessment_locked",
      message: "Injects are disabled",
    });
    expect(() => {
      throw new ApiFailure(403, "assessment_locked");
    }).toThrow(ApiFailure);
  });

  it("falls back to a generic code when the body has none", async () => {
    fetchMock.mockResolvedValue(json({}, false, 500));
    await expect(api("/api/sessions")).rejects.toMatchObject({ status: 500, code: "request_failed" });
  });

  it("reports an unreachable server as `offline` rather than a TypeError", async () => {
    // The one error a fetch can throw without a server involved; `status: 0` is the
    // UI's signal to say "start the server", not "the session is broken".
    fetchMock.mockRejectedValue(new TypeError("fetch failed"));

    await expect(api("/api/sessions")).rejects.toMatchObject({ status: 0, code: "offline" });
  });

  it("omits Content-Type on a call with no body", () => {
    // The regression: start/pause/resume/end send no body, and Fastify rejects an
    // empty body outright when the content-type claims JSON. Every one of those
    // four buttons returned 400 until the header was made conditional.
    fetchMock.mockResolvedValue(json({ ok: true }));

    void api("/api/sessions/x/start", { method: "POST" });

    const [, init] = fetchMock.mock.calls[0]!;
    const headers = init?.headers as Record<string, string>;
    expect(headers["Content-Type"]).toBeUndefined();
  });

  it("still sends Content-Type when there is a body", () => {
    fetchMock.mockResolvedValue(json({ ok: true }));

    void api("/api/sessions/x/end", { method: "POST", body: JSON.stringify({ reason: "done" }) });

    const [, init] = fetchMock.mock.calls[0]!;
    const headers = init?.headers as Record<string, string>;
    expect(headers["Content-Type"]).toBe("application/json");
  });
});

describe("token / user storage", () => {
  beforeEach(() => localStorage.clear());

  it("round-trips a token through localStorage", () => {
    expect(getToken()).toBe(null);
    setToken("t1");
    expect(getToken()).toBe("t1");
    setToken(null);
    expect(getToken()).toBe(null);
  });

  it("round-trips a user, and drops a corrupt row", () => {
    // A user row that is not JSON is stale data from an older build; reading it
    // must not throw the app out of the login screen.
    localStorage.setItem("skysentinel.user", "{not json");
    expect(getStoredUser()).toBe(null);

    const user: PublicUser = {
      id: "u1",
      username: "admin",
      display_name: "Admin",
      role: "instructor",
      unit_id: null,
    };
    localStorage.setItem("skysentinel.user", JSON.stringify(user));
    expect(getStoredUser()).toEqual(user);
  });
});

describe("request helpers", () => {
  const fetchMock = vi.fn();

  beforeEach(() => {
    vi.stubGlobal("fetch", fetchMock);
    fetchMock.mockResolvedValue({ ok: true, status: 200, json: async () => ({ ok: true }) } as unknown as Response);
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    fetchMock.mockReset();
  });

  it("posts a login body", async () => {
    await login("admin", "admin");
    const [path, init] = fetchMock.mock.calls[0]!;
    expect(path).toBe("/api/auth/login");
    expect(JSON.parse(String(init?.body))).toEqual({ username: "admin", password: "admin" });
  });

  it("posts an inject with its params", async () => {
    // FR-SIM-9: the instructor console sends `{ type, params }`; a param dropped
    // here is an inject that silently does nothing.
    await injectSession("s1", "weather_change", { weather: "rain" });
    const [path, init] = fetchMock.mock.calls[0]!;
    expect(path).toBe("/api/sessions/s1/inject");
    expect(JSON.parse(String(init?.body))).toEqual({ type: "weather_change", params: { weather: "rain" } });
  });

  it("defaults the inject params to an empty object", async () => {
    await injectSession("s1", "sensor_outage");
    const [, init] = fetchMock.mock.calls[0]!;
    expect(JSON.parse(String(init?.body))).toEqual({ type: "sensor_outage", params: {} });
  });
});
