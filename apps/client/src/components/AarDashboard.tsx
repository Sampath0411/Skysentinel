import { useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import type { Role, SessionStatus } from "../types.js";
import type { SessionRecord } from "../types.js";
import { listSessions } from "../api.js";
import { useAuth } from "../auth.js";
import { fmtDuration, fmtWall } from "../format.js";

/**
 * AAR sessions list (PRD §12.1): filterable, sortable
 * list of finished runs. A trainee sees only their own.
 */
export default function AarDashboard() {
  const { user } = useAuth();
  const navigate = useNavigate();
  const [sessions, setSessions] = useState<SessionRecord[]>([]);
  const [statusFilter, setStatusFilter] = useState<"all" | SessionStatus>("all");
  const [traineeFilter, setTraineeFilter] = useState("");
  const [scenarioFilter, setScenarioFilter] = useState("");

  useEffect(() => {
    listSessions()
      .then((r) => setSessions(r.sessions))
      .catch(() => undefined);
  }, []);

  if (user === null) return null;
  const isStaff = user.role === "instructor" || user.role === "admin";

  const scenarioIds = [...new Set(sessions.map((s) => s.scenario_id))];
  const traineeIds = isStaff
    ? [...new Set(sessions.map((s) => s.trainee_id))]
    : [];

  const shown = sessions
    .filter((s) => statusFilter === "all" || s.status === statusFilter)
    .filter((s) => traineeFilter === "" || s.trainee_id === traineeFilter)
    .filter((s) => scenarioFilter === "" || s.scenario_id === scenarioFilter)
    .sort((a, b) => (b.ended_at ?? "").localeCompare(a.ended_at ?? ""));

  return (
    <div>
      <h1>After-Action Review</h1>

      <div className="flex wrap mb">
        <label className="dim small">
          Status
          <select value={statusFilter} onChange={(e) => setStatusFilter(e.target.value as "all" | SessionStatus)}>
            <option value="all">all</option>
            <option value="scored">scored</option>
            <option value="ended">ended</option>
            <option value="running">running</option>
            <option value="paused">paused</option>
          </select>
        </label>
        {isStaff && (
          <label className="dim small">
            Trainee
            <select value={traineeFilter} onChange={(e) => setTraineeFilter(e.target.value)}>
              <option value="">all</option>
              {traineeIds.map((t) => (
                <option key={t} value={t}>
                  {t.slice(0, 12)}
                </option>
              ))}
            </select>
          </label>
        )}
        <label className="dim small">
          Scenario
          <select value={scenarioFilter} onChange={(e) => setScenarioFilter(e.target.value)}>
            <option value="">all</option>
            {scenarioIds.map((s) => (
              <option key={s} value={s}>
                {s}
              </option>
            ))}
          </select>
        </label>
      </div>

      {shown.length === 0 ? (
        <p className="dim">No sessions match. Launch a scenario first.</p>
      ) : (
        <div className="panel">
          <table className="data">
            <thead>
              <tr>
                <th>Scenario</th>
                {isStaff && <th>Trainee</th>}
                <th>Mode</th>
                <th>Status</th>
                <th>Duration</th>
                <th>Ended</th>
                <th>Reason</th>
              </tr>
            </thead>
            <tbody>
              {shown.slice(0, 50).map((s) => (
                <tr
                  key={s.id}
                  className="clickable"
                  onClick={() => navigate(`/aar/${s.id}`)}
                >
                  <td className="mono">{s.scenario_id}</td>
                  {isStaff && <td className="mono">{s.trainee_id.slice(0, 12)}</td>}
                  <td>{s.mode}</td>
                  <td>
                    <span className={`status-pill ${s.status}`}>{s.status}</span>
                  </td>
                  <td className="mono">{fmtDuration(s.duration_ms)}</td>
                  <td className="mono small">{fmtWall(s.ended_at)}</td>
                  <td className="small dim">{s.end_reason ?? "—"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <p className="faint small mt">
        Signed in as <RoleLabel role={user.role} />. Scores appear once a session ends.
      </p>
    </div>
  );
}

const RoleLabel = ({ role }: { role: Role }) => <span className={`role-badge ${role}`}>{role}</span>;
