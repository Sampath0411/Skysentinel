/**
 * REST + WebSocket client (PRD §15).
 *
 * One `api` helper carries the bearer token on every call.
 * The frame socket is separate: it cannot set headers, so the
 * token rides the query string and the server verifies it
 * against the same secret before sending anything.
 */

import type {
  AnySimEvent,
  AnnotationRecord,
  AuditEntry,
  LaunchResult,
  PostureState,
  ProgressRun,
  ProgressSummary,
  PublicUser,
  ReplayPayload,
  ScorePayload,
  ScenarioSummary,
  SessionRecord,
  TruthEntityView,
} from "./types.js";
import type { TraineeView } from "@skysentinel/sim-core";

const TOKEN_KEY = "skysentinel.token";
const USER_KEY = "skysentinel.user";

export const getToken = (): string | null => localStorage.getItem(TOKEN_KEY);
export const setToken = (token: string | null): void => {
  if (token === null) localStorage.removeItem(TOKEN_KEY);
  else localStorage.setItem(TOKEN_KEY, token);
};
export const getStoredUser = (): PublicUser | null => {
  const raw = localStorage.getItem(USER_KEY);
  if (!raw) return null;
  try {
    return JSON.parse(raw) as PublicUser;
  } catch {
    return null;
  }
};
export const setStoredUser = (user: PublicUser | null): void => {
  if (user === null) localStorage.removeItem(USER_KEY);
  else localStorage.setItem(USER_KEY, JSON.stringify(user));
};

export class ApiFailure extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message?: string,
  ) {
    super(message ?? code);
  }
}

export async function api<T>(path: string, init?: RequestInit): Promise<T> {
  const token = getToken();
  let res: Response;
  try {
    res = await fetch(path, {
      ...init,
      headers: {
        // Only claim a JSON body when there is one. Fastify's parser rejects an
        // empty body outright if the content-type says JSON, so the bodyless
        // POSTs — start, pause, resume, end — must not carry this header.
        ...(init?.body !== undefined ? { "Content-Type": "application/json" } : {}),
        ...(token !== null ? { Authorization: `Bearer ${token}` } : {}),
        ...(init?.headers ?? {}),
      },
    });
  } catch {
    throw new ApiFailure(0, "offline", "Cannot reach the local server. Is it running?");
  }

  if (!res.ok) {
    const body = (await res.json().catch(() => ({}))) as { error?: string; message?: string };
    throw new ApiFailure(res.status, body.error ?? "request_failed", body.message);
  }
  return (await res.json()) as T;
}

// --- auth ----------------------------------------------------------------

export const login = (username: string, password: string) =>
  api<{ token: string; user: PublicUser }>("/api/auth/login", {
    method: "POST",
    body: JSON.stringify({ username, password }),
  });

export const me = () => api<{ user: PublicUser; server_time: string }>("/api/me");

// --- scenarios -------------------------------------------------------------

export const listScenarios = () => api<{ scenarios: ScenarioSummary[] }>("/api/scenarios");

// --- sessions --------------------------------------------------------------

export const listSessions = () => api<{ sessions: SessionRecord[] }>("/api/sessions");

export const createSession = (
  scenario_id: string,
  mode: "assessment" | "training",
  trainee_id?: string,
) =>
  api<LaunchResult>("/api/sessions", {
    method: "POST",
    body: JSON.stringify({ scenario_id, mode, ...(trainee_id ? { trainee_id } : {}) }),
  });

export const startSession = (id: string) =>
  api<{ session_id: string; status: string; speed: number }>(`/api/sessions/${id}/start`, {
    method: "POST",
  });

export const pauseSession = (id: string) =>
  api<{ session_id: string; status: string }>(`/api/sessions/${id}/pause`, { method: "POST" });

export const resumeSession = (id: string) =>
  api<{ session_id: string; status: string }>(`/api/sessions/${id}/resume`, { method: "POST" });

export const endSession = (id: string, reason = "ended_by_user") =>
  api<{ session_id: string; status: string; score: (ScorePayload & { result: unknown }) | null }>(
    `/api/sessions/${id}/end`,
    { method: "POST", body: JSON.stringify({ reason }) },
  );

export const sendAction = (
  id: string,
  type: "mark_contact" | "classify" | "report" | "act" | "request_authority" | "view_brief",
  payload: Record<string, unknown>,
) =>
  api<{ session_id: string; t_ms: number; view: TraineeView }>(`/api/sessions/${id}/action`, {
    method: "POST",
    body: JSON.stringify({ type, payload }),
  });

export const getView = (id: string) =>
  api<{ session_id: string; t_ms: number; view: TraineeView }>(`/api/sessions/${id}/view`);

/** The server's answer to an inject (FR-SIM-9): whether the sim could use the params. */
export interface InjectResult {
  session_id: string;
  t_ms: number;
  applied: boolean;
  view: TraineeView;
}

export const injectSession = (id: string, type: string, params: Record<string, unknown> = {}) =>
  api<InjectResult>(`/api/sessions/${id}/inject`, {
    method: "POST",
    body: JSON.stringify({ type, params }),
  });

export const getEvents = (id: string) =>
  api<{ events: AnySimEvent[] }>(`/api/sessions/${id}/events`);

// --- AAR --------------------------------------------------------------------

export const getScore = (id: string) => api<{ score: ScorePayload }>(`/api/sessions/${id}/score`);

export const getReplay = (id: string) => api<ReplayPayload>(`/api/sessions/${id}/replay`);

export const addAnnotation = (id: string, t_ms: number, text: string) =>
  api<{ annotation: AnnotationRecord }>(`/api/sessions/${id}/annotations`, {
    method: "POST",
    body: JSON.stringify({ t_ms, text }),
  });

export const getProgress = (traineeId: string) =>
  api<{ trainee_id: string; runs: ProgressRun[]; summary: ProgressSummary }>(
    `/api/trainees/${traineeId}/progress`,
  );

// --- staff ------------------------------------------------------------------

export const listUsers = () => api<{ users: PublicUser[] }>("/api/users");

export const listAudit = () => api<{ entries: AuditEntry[] }>("/api/audit");

// --- frames WebSocket --------------------------------------------------------

/** One broadcast frame (server `session/live.ts`). */
export interface Frame {
  type: "tick";
  session_id: string;
  t_ms: number;
  view: TraineeView;
  events: AnySimEvent[];
}

export interface EndedMessage {
  type: "ended";
  session_id: string;
  reason: string;
  t_ms: number;
}

export interface ErrorMessage {
  type: "error";
  message: string;
}

export type WsMessage = Frame | EndedMessage | ErrorMessage;

/**
 * Open the frame socket for a session. Returns a disconnect function.
 *
 * The first message is a full snapshot (the server sends the whole
 * event log with it), so a reconnecting client rebuilds its state
 * without a separate fetch.
 */
export const openSessionSocket = (
  sessionId: string,
  onMessage: (msg: WsMessage) => void,
): (() => void) => {
  const token = getToken() ?? "";
  const proto = location.protocol === "https:" ? "wss" : "ws";
  const url = `${proto}://${location.host}/ws?session_id=${encodeURIComponent(sessionId)}&token=${encodeURIComponent(token)}`;

  let ws: WebSocket;
  try {
    ws = new WebSocket(url);
  } catch {
    return () => undefined;
  }

  ws.onmessage = (e) => {
    try {
      onMessage(JSON.parse(e.data as string) as WsMessage);
    } catch {
      // A malformed frame is dropped, never fatal: the next frame
      // carries the authoritative state.
    }
  };

  const close = () => {
    ws.onmessage = null;
    ws.onerror = null;
    ws.close();
  };
  return close;
};

/** The posture/authority block, narrowed for display. */
export const postureOf = (v: TraineeView): PostureState => v.authority as PostureState;

/** Truth entities for an instructor replay. */
export type { TruthEntityView };
