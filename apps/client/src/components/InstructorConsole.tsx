import { useCallback, useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import type { PublicUser, ScenarioSummary, SessionRecord } from "../types.js";
import { createSession, listScenarios, listSessions, listUsers } from "../api.js";
import { fmtClock, fmtDuration, fmtWall } from "../format.js";

/**
 * Instructor console (PRD §13.2): scenario picker with
 * trainee and mode selection, plus the live session table.
 */
export default function InstructorConsole() {
  const navigate = useNavigate();
  const [scenarios, setScenarios] = useState<ScenarioSummary[]>([]);
  const [sessions, setSessions] = useState<SessionRecord[]>([]);
  const [users, setUsers] = useState<PublicUser[]>([]);
  const [scenarioId, setScenarioId] = useState("");
  const [traineeId, setTraineeId] = useState("");
  const [mode, setMode] = useState<"training" | "assessment">("training");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    try {
      const [sc, se, us] = await Promise.all([listScenarios(), listSessions(), listUsers()]);
      setScenarios(sc.scenarios);
      setSessions(se.sessions);
      setUsers(us.users);
      if (sc.scenarios.length > 0) setScenarioId((prev) => prev || sc.scenarios[0]?.id || "");
    } catch (e) {
      setError(e instanceof Error ? e.message : "Load failed");
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const launch = async () => {
    if (scenarioId === "") return;
    setBusy(true);
    try {
      const r = await createSession(scenarioId, mode, traineeId !== "" ? traineeId : undefined);
      navigate(`/instructor/${r.session.id}`);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Launch failed");
    } finally {
      setBusy(false);
    }
  };

  const live = sessions.filter((s) => s.status === "created" || s.status === "running" || s.status === "paused");
  const done = sessions.filter((s) => s.status === "ended" || s.status === "scored");
  const trainees = users.filter((u) => u.role === "trainee");
  const nameOf = (id: string) =>
    users.find((u) => u.id === id)?.display_name ?? users.find((u) => u.id === id)?.username ?? id.slice(0, 12);

  return (
    <div>
      <h1>Instructor console</h1>
      {error !== "" && <div className="notice error">{error}</div>}

      <div className="panel mb">
        <h3>Launch scenario</h3>
        <div className="flex wrap">
          <label className="dim small">
            Scenario
            <select value={scenarioId} onChange={(e) => setScenarioId(e.target.value)}>
              {scenarios.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.title} (D{s.difficulty ?? "?"})
                </option>
              ))}
            </select>
          </label>
          <label className="dim small">
            Trainee
            <select value={traineeId} onChange={(e) => setTraineeId(e.target.value)}>
              <option value="">(run as yourself)</option>
              {trainees.map((t) => (
                <option key={t.id} value={t.id}>
                  {t.display_name ?? t.username}
                </option>
              ))}
            </select>
          </label>
          <label className="dim small">
            Mode
            <select value={mode} onChange={(e) => setMode(e.target.value as "training" | "assessment")}>
              <option value="training">Training</option>
              <option value="assessment">Assessment</option>
            </select>
          </label>
          <button className="primary" onClick={() => void launch()} disabled={busy || scenarioId === ""}>
            {busy ? "Launching…" : "Launch"}
          </button>
        </div>
      </div>

      <h2>Live sessions</h2>
      {live.length === 0 ? (
        <p className="dim">None running. Launch one above.</p>
      ) : (
        <div className="panel">
          <table className="data">
            <thead>
              <tr>
                <th>Session</th>
                <th>Scenario</th>
                <th>Trainee</th>
                <th>Status</th>
                <th>Duration</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {live.map((s) => (
                <tr key={s.id}>
                  <td className="mono">{s.id.slice(0, 14)}</td>
                  <td className="mono">{s.scenario_id}</td>
                  <td>{nameOf(s.trainee_id)}</td>
                  <td>
                    <span className={`status-pill ${s.status}`}>{s.status}</span>
                  </td>
                  <td className="mono">{fmtDuration(s.duration_ms)}</td>
                  <td>
                    <button className="small primary" onClick={() => navigate(`/instructor/${s.id}`)}>
                      Open live
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <h2 className="mt">Completed</h2>
      {done.length === 0 ? (
        <p className="dim">None yet.</p>
      ) : (
        <div className="panel">
          <table className="data">
            <thead>
              <tr>
                <th>Scenario</th>
                <th>Trainee</th>
                <th>Started</th>
                <th>Duration</th>
                <th>Reason</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {done.slice(0, 20).map((s) => (
                <tr key={s.id} className="clickable" onClick={() => navigate(`/aar/${s.id}`)}>
                  <td className="mono">{s.scenario_id}</td>
                  <td>{nameOf(s.trainee_id)}</td>
                  <td className="mono small">{fmtWall(s.started_at)}</td>
                  <td className="mono">{fmtDuration(s.duration_ms)}</td>
                  <td className="small dim">{s.end_reason ?? "—"}</td>
                  <td>
                    <span className="chip kind">AAR</span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <p className="faint small mt">
        Mission lengths: {scenarios.slice(0, 3).map((s) => `${fmtClock(s.duration_s * 1000)}`).join(" · ")}
      </p>
    </div>
  );
}
