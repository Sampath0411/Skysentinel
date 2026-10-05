/**
 * Launching a session (PRD §13.2).
 *
 * The DoD here is not "a session exists" but "a session *runs*": creating one
 * leaves it at t=0 with no clock, and nothing steps it until `/start` is called.
 * A launch that skipped that call produced a console that looked live and never
 * moved, so this asserts both calls happen, and in that order.
 */

import { describe, expect, it, vi, beforeEach } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import type * as ReactRouterDom from "react-router-dom";

import Home from "./Home.js";

/** The order the API was called in, which is the whole point of the test. */
const calls: string[] = [];

const navigate = vi.fn();

vi.mock("react-router-dom", async () => {
  const actual = await vi.importActual<typeof ReactRouterDom>("react-router-dom");
  return { ...actual, useNavigate: () => navigate };
});

vi.mock("../api.js", () => ({
  listScenarios: async () => ({
    scenarios: [
      {
        id: "scr-night-recon-01",
        title: "Night reconnaissance",
        description: "An unidentified multirotor orbits a fuel point.",
        kind: "scripted",
        difficulty: 2,
        duration_s: 420,
        seed: 1001,
        learning_objectives: ["reporting"],
      },
    ],
  }),
  listSessions: async () => ({ sessions: [] }),
  listUsers: async () => ({ users: [] }),
  createSession: async () => {
    calls.push("create");
    return { session: { id: "ses_1" } };
  },
  startSession: async () => {
    calls.push("start");
    return { session_id: "ses_1", status: "running", speed: 1 };
  },
  me: async () => ({
    user: { id: "u1", username: "admin", display_name: "Administrator", role: "admin", unit_id: null },
  }),
}));

vi.mock("../auth.js", () => ({
  useAuth: () => ({
    user: { id: "u1", username: "admin", display_name: "Administrator", role: "admin", unit_id: null },
    ready: true,
    signIn: vi.fn(),
    signOut: vi.fn(),
    refresh: vi.fn(),
  }),
}));

describe("Home — launching a session", () => {
  beforeEach(() => {
    calls.length = 0;
    navigate.mockClear();
  });

  it("creates the session and then starts it", async () => {
    // The regression: create-without-start leaves the run at t_ms 0 forever, so
    // the console renders but the simulation never advances.
    render(
      <MemoryRouter>
        <Home />
      </MemoryRouter>,
    );

    const launch = await screen.findByRole("button", { name: "Launch" });
    fireEvent.click(launch);

    await waitFor(() => expect(calls).toEqual(["create", "start"]));
    await waitFor(() => expect(navigate).toHaveBeenCalledWith("/instructor/ses_1"));
  });
});