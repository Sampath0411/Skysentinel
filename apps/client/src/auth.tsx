/**
 * Auth context (PRD §17).
 *
 * The token lives in localStorage so a refresh survives a
 * restart of the local server — but tokens are signed with a
 * per-boot secret, so a server restart simply makes the stored
 * token invalid and the client drops back to the login screen.
 * That is the correct behaviour for a local, offline tool.
 */

import { createContext, useCallback, useContext, useEffect, useState } from "react";
import type { ReactNode } from "react";
import type { PublicUser } from "./types.js";
import {
  getStoredUser,
  login as apiLogin,
  me,
  setStoredUser,
  setToken,
} from "./api.js";

interface AuthSession {
  user: PublicUser;
}

interface AuthContextValue {
  user: PublicUser | null;
  /** False while a stored token is still being checked against the server. */
  ready: boolean;
  signIn: (username: string, password: string) => Promise<void>;
  signOut: () => void;
  refresh: () => Promise<void>;
}

const AuthContext = createContext<AuthContextValue | null>(null);

export const AuthProvider = ({ children }: { children: ReactNode }) => {
  // `restored` is the third state: a stored session exists but the server has
  // not confirmed it yet. Booting straight into "signed in" from localStorage is
  // what produced the dead-token screen — the header showed admin while every
  // request 401'd, because the token is signed with a per-boot secret and a
  // restarted server invalidates it. Until `/me` answers, the honest thing is to
  // show neither the app nor a login form, because we do not yet know which.
  const [session, setSession] = useState<AuthSession | null>(() => {
    const user = getStoredUser();
    return user === null ? null : { user };
  });
  const [restored, setRestored] = useState<boolean>(() => getStoredUser() === null);

  const signIn = useCallback(async (username: string, password: string) => {
    const { token, user } = await apiLogin(username, password);
    setToken(token);
    setStoredUser(user);
    setSession({ user });
    setRestored(true);
  }, []);

  const signOut = useCallback(() => {
    setToken(null);
    setStoredUser(null);
    setSession(null);
    setRestored(true);
  }, []);

  // Validate the stored token once at mount. A 401 here clears it and drops the
  // user on the login form; an offline server clears it too, because a token we
  // cannot verify is not a session worth showing an app for.
  useEffect(() => {
    if (getStoredUser() === null) {
      setRestored(true);
      return;
    }
    let cancelled = false;
    void (async () => {
      try {
        const { user } = await me();
        if (cancelled) return;
        setStoredUser(user);
        setSession({ user });
      } catch {
        if (cancelled) return;
        setToken(null);
        setStoredUser(null);
        setSession(null);
      } finally {
        if (!cancelled) setRestored(true);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const refresh = useCallback(async () => {
    try {
      const { user } = await me();
      setStoredUser(user);
      setSession({ user });
    } catch {
      signOut();
    }
  }, [signOut]);

  return (
    <AuthContext.Provider
      value={{ user: session?.user ?? null, ready: restored, signIn, signOut, refresh }}
    >
      {children}
    </AuthContext.Provider>
  );
};

export const useAuth = (): AuthContextValue => {
  const ctx = useContext(AuthContext);
  if (ctx === null) throw new Error("useAuth outside AuthProvider");
  return ctx;
};

/** Require any signed-in role. */
export const RequireAuth = ({ children }: { children: ReactNode }) => {
  const { user, ready } = useAuth();
  if (!ready) return <BootScreen />;
  if (user === null) return <NavigateToLogin />;
  return <>{children}</>;
};

/** Require one of the listed roles. */
export const RequireRole = ({
  roles,
  children,
}: {
  roles: readonly string[];
  children: ReactNode;
}) => {
  const { user, ready } = useAuth();
  if (!ready) return <BootScreen />;
  if (user === null) return <NavigateToLogin />;
  if (!roles.includes(user.role)) {
    return (
      <div className="panel mt">
        <h2>Access restricted</h2>
        <p className="dim">
          This console requires one of: {roles.join(", ")}. You are signed in as{" "}
          <span className="role-badge">{user.role}</span>.
        </p>
      </div>
    );
  }
  return <>{children}</>;
};

import { Navigate } from "react-router-dom";
const NavigateToLogin = () => <Navigate to="/login" replace />;

/**
 * Shown while a stored token is being validated. Deliberately not the login form:
 * a user who is actually signed in would see their own username disappear for a
 * frame, and one whose token died gets the form a moment later instead of a flash.
 */
const BootScreen = () => (
  <div className="boot">
    <span className="boot-dot" />
    <p className="dim">Restoring session…</p>
  </div>
);
