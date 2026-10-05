/**
 * Auth boot behaviour.
 *
 * Tokens are signed with a per-boot secret, so restarting the local server
 * invalidates whatever the browser has stored. The failure this pins is the app
 * trusting `localStorage` at face value: the header showed a signed-in admin
 * while every request 401'd, and the only way back to the login form was to
 * clear site data by hand.
 */

import { describe, expect, it, vi, beforeEach } from "vitest";
import { render, screen } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router-dom";

import { AuthProvider, RequireAuth } from "./auth.js";

const USER = {
  id: "u1",
  username: "admin",
  display_name: "Administrator",
  role: "admin",
  unit_id: null,
};

/** Flipped per test: does the server accept the stored token? */
let meResult: { ok: true } | { ok: false } = { ok: true };

vi.mock("./api.js", () => ({
  me: async () => {
    if (meResult.ok) return { user: USER };
    throw new Error("401");
  },
  login: async () => ({ token: "fresh", user: USER }),
  getStoredUser: () => {
    const raw = localStorage.getItem("skysentinel.user");
    return raw === null ? null : (JSON.parse(raw) as typeof USER);
  },
  setStoredUser: (u: typeof USER | null) => {
    if (u === null) localStorage.removeItem("skysentinel.user");
    else localStorage.setItem("skysentinel.user", JSON.stringify(u));
  },
  setToken: (t: string | null) => {
    if (t === null) localStorage.removeItem("skysentinel.token");
    else localStorage.setItem("skysentinel.token", t);
  },
}));

const renderApp = () =>
  render(
    <MemoryRouter initialEntries={["/"]}>
      <AuthProvider>
        <Routes>
          <Route
            path="/"
            element={
              <RequireAuth>
                <p>CONSOLE</p>
              </RequireAuth>
            }
          />
          <Route path="/login" element={<p>LOGIN FORM</p>} />
        </Routes>
      </AuthProvider>
    </MemoryRouter>,
  );

const storeSession = () => {
  localStorage.setItem("skysentinel.token", "stored");
  localStorage.setItem("skysentinel.user", JSON.stringify(USER));
};

describe("AuthProvider boot", () => {
  beforeEach(() => {
    localStorage.clear();
    meResult = { ok: true };
  });

  it("lets a valid stored token through", async () => {
    storeSession();
    renderApp();
    expect(await screen.findByText("CONSOLE")).toBeInTheDocument();
    expect(localStorage.getItem("skysentinel.token")).toBe("stored");
  });

  it("clears a token the server rejects and falls back to the login form", async () => {
    // The regression: a stale token rendered the app anyway, so the user sat in a
    // signed-in-looking UI with every request failing and no route back out.
    storeSession();
    meResult = { ok: false };

    renderApp();

    expect(await screen.findByText("LOGIN FORM")).toBeInTheDocument();
    expect(screen.queryByText("CONSOLE")).not.toBeInTheDocument();
    // The dead token is removed, so a later reload cannot resurrect it either.
    expect(localStorage.getItem("skysentinel.token")).toBeNull();
    expect(localStorage.getItem("skysentinel.user")).toBeNull();
  });

  it("does not flash the login form while a valid token is being checked", async () => {
    // A genuinely signed-in user should not watch the app appear and vanish, nor
    // see their own name replaced by a sign-in prompt for a frame.
    storeSession();
    const { container } = renderApp();

    expect(container.textContent).not.toContain("LOGIN FORM");
    expect(await screen.findByText("CONSOLE")).toBeInTheDocument();
  });

  it("goes straight to the login form when nothing is stored", async () => {
    renderApp();
    expect(await screen.findByText("LOGIN FORM")).toBeInTheDocument();
  });
});