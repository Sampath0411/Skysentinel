import { useCallback, useEffect, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { useAuth } from "../auth.js";
import type { PublicUser, ScenarioSummary, SessionRecord } from "../types.js";
import { createSession, listScenarios, listSessions, listUsers, startSession } from "../api.js";
import { fmtClock, fmtDuration, fmtWall } from "../format.js";

/**
 * Role landing (PRD §13.1/§13.2).
 *
 * A trainee launches their own run and sees their history.
 * Staff get the launch form (with trainee picker) and the
 * full session table.
 */
export default function Home() {
  const { user } = useAuth();
  const navigate = useNavigate();
  const [scenarios, setScenarios] = useState<ScenarioSummary[] | null>(null);
  const [sessions, setSessions] = useState<SessionRecord[] | null>(null);
  const [trainees, setTrainees] = useState<PublicUser[]>([]);
  const [traineeId, setTraineeId] = useState("");
  const [mode, setMode] = useState<"training" | "assessment">("training");
  const [error, setError] = useState("");

  const load = useCallback(async () => {
    try {
      const [sc, se] = await Promise.all([listScenarios(), listSessions()]);
      setScenarios(sc.scenarios);
      setSessions(se.sessions);
      // Staff-only; a trainee simply gets an empty picker.
      listUsers()
        .then((r) => setTrainees(r.users.filter((u) => u.role === "trainee")))
        .catch(() => undefined);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Load failed");
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  if (user === null) return null;
  const isStaff = user.role === "instructor" || user.role === "admin";

  const launch = async (scenarioId: string) => {
    try {
      const r = await createSession(
        scenarioId,
        mode,
        isStaff && traineeId !== "" ? traineeId : undefined,
      );
      // Creating a session does not start it: the run exists at t=0 with no
      // clock, and nothing steps it until `/start`. Navigating without this call
      // left the console open on a live-looking session that never moved.
      await startSession(r.session.id);
      navigate(isStaff ? `/instructor/${r.session.id}` : `/brief/${r.session.id}`);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Launch failed");
    }
  };

  const mine = (sessions ?? []).filter((s) => s.trainee_id === user.id);
  const shown = isStaff ? (sessions ?? []) : mine;

  return (
    <div>
      <div className="flex-between mb">
        <h1>{isStaff ? "Directing station" : "Mission brief & launch"}</h1>
        <div className="flex">
          <Link className="chip kind" to="/aar">
            AAR dashboard
          </Link>
          <Link className="chip kind" to="/profile">
            My progress
          </Link>
        </div>
      </div>

      {error !== "" && <div className="notice error">{error}</div>}

      {isStaff && (
        <div className="panel mb">
          <h3>Launch a session for a trainee</h3>
          <div className="flex wrap">
            <label className="dim small">
              Trainee
              <select value={traineeId} onChange={(e) => setTraineeId(e.target.value)}>
                <option value="">(as yourself)</option>
                {trainees.map((t) => (
                  <option key={t.id} value={t.id}>
                    {t.display_name ?? t.username}
                  </option>
                ))}
              </select>
            </label>
            <label className="dim small">
              Mode
              <select
                value={mode}
                onChange={(e) => setMode(e.target.value as "training" | "assessment")}
              >
                <option value="training">Training (support cues allowed)</option>
                <option value="assessment">Assessment (no support cues)</option>
              </select>
            </label>
          </div>
          <p className="dim small">
            Pick a scenario below. The session opens on the instructor live view; the trainee
            finds it in their own list.
          </p>
        </div>
      )}

      <h2>Scenarios</h2>
      {scenarios === null ? (
        <p className="dim">Loading…</p>
      ) : (
        <div className="scenario-grid">
          {scenarios.map((s) => (
            <div className="panel scenario-card" key={s.id}>
              <div className="flex-between">
                <span className="title">{s.title}</span>
                <span className={`chip d${s.difficulty ?? 1}`}>D{s.difficulty ?? "?"}</span>
              </div>
              <div className="meta">
                <span className="chip kind">{s.kind}</span>
                {s.family !== null && <span className="chip">{s.family}</span>}
                <span className="chip">{fmtClock(s.duration_s * 1000)}</span>
                <span className="chip">seed {s.seed}</span>
              </div>
              {s.description !== null && <p className="dim small">{s.description}</p>}
              {s.learning_objectives.length > 0 && (
                <p className="small faint">Teaches: {s.learning_objectives.join(" · ")}</p>
              )}
              <button className="primary small" onClick={() => void launch(s.id)}>
                Launch
              </button>
            </div>
          ))}
        </div>
      )}

      <h2 className="mt">{isStaff ? "All sessions" : "My sessions"}</h2>
      {shown.length === 0 ? (
        <p className="dim">No sessions yet.</p>
      ) : (
        <div className="panel">
          <table className="data">
            <thead>
              <tr>
                <th>Scenario</th>
                <th>Trainee</th>
                <th>Mode</th>
                <th>Status</th>
                <th>Duration</th>
                <th>Started</th>
              </tr>
            </thead>
            <tbody>
              {shown.slice(0, 15).map((s) => (
                <tr
                  key={s.id}
                  className="clickable"
                  onClick={() =>
                    navigate(
                      s.status === "scored" || s.status === "ended"
                        ? `/aar/${s.id}`
                        : isStaff
                          ? `/instructor/${s.id}`
                          : `/brief/${s.id}`,
                    )
                  }
                >
                  <td className="mono">{s.scenario_id}</td>
                  <td className="mono">{s.trainee_id.slice(0, 12)}</td>
                  <td>{s.mode}</td>
                  <td>
                    <span className={`status-pill ${s.status}`}>{s.status}</span>
                  </td>
                  <td className="mono">{fmtDuration(s.duration_ms)}</td>
                  <td className="mono small">{fmtWall(s.started_at)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
