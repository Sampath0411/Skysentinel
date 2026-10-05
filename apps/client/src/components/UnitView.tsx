import { useEffect, useMemo, useState } from "react";
import type { ScoreResult } from "@skysentinel/scoring";
import type { PublicUser, SessionRecord } from "../types.js";
import { getScore, listSessions, listUsers } from "../api.js";
import { BarChart, HeatCell, LineChart } from "./charts.js";

/**
 * Unit view (PRD §12.4): aggregate by unit —
 * distribution, trainee × competency heatmap,
 * recurring errors, detection-time distribution,
 * cohort learning gain. Staff only.
 */
export default function UnitView() {
  const [users, setUsers] = useState<PublicUser[]>([]);
  const [sessions, setSessions] = useState<SessionRecord[]>([]);
  const [results, setResults] = useState<Map<string, ScoreResult>>(new Map());
  const [loaded, setLoaded] = useState(false);

  useEffect(() => {
    (async () => {
      try {
        const [u, s] = await Promise.all([listUsers(), listSessions()]);
        setUsers(u.users);
        setSessions(s.sessions);
        const scored = s.sessions.filter((x) => x.status === "scored");
        const map = new Map<string, ScoreResult>();
        for (const sess of scored) {
          try {
            const r = await getScore(sess.id);
            map.set(sess.id, r.score.result);
          } catch {
            // unreadable score rows are skipped
          }
        }
        setResults(map);
      } finally {
        setLoaded(true);
      }
    })();
  }, []);

  const byUnit = useMemo(() => {
    const units = new Map<string, PublicUser[]>();
    for (const u of users) {
      if (u.role !== "trainee") continue;
      const name = u.unit_id ?? "Unassigned";
      const list = units.get(name) ?? [];
      list.push(u);
      units.set(name, list);
    }
    return [...units.entries()];
  }, [users]);

  const nameOf = (id: string) =>
    users.find((u) => u.id === id)?.display_name ?? users.find((u) => u.id === id)?.username ?? id.slice(0, 10);

  const stats = useMemo(() => {
    const all = [...results.values()];
    const totals = all.map((r) => r.total);
    const sorted = [...totals].sort((a, b) => a - b);
    const mean = sorted.length > 0 ? sorted.reduce((a, b) => a + b, 0) / sorted.length : 0;
    const median = sorted.length > 0 ? sorted[Math.floor(sorted.length / 2)] ?? 0 : 0;
    const spread = sorted.length > 1 ? sorted[sorted.length - 1]! - sorted[0]! : 0;

    const errorCounts = new Map<string, number>();
    for (const r of all) {
      for (const e of r.critical_errors) {
        errorCounts.set(e.kind, (errorCounts.get(e.kind) ?? 0) + 1);
      }
    }
    const topErrors = [...errorCounts.entries()]
      .map(([kind, n]) => ({ kind, n }))
      .sort((a, b) => b.n - a.n)
      .slice(0, 5);

    const detection = all
      .map((r) => r.competencies.find((c) => c.competency === "detection")?.points ?? 0);

    return { mean, median, spread, topErrors, detection, count: sorted.length };
  }, [results]);

  if (!loaded) return <p className="dim">Loading unit analytics…</p>;

  return (
    <div>
      <h1>Unit view</h1>

      <div className="card-row">
        <div className="panel">
          <h3>Cohort ({stats.count} scored runs)</h3>
          <div className="score-big">{stats.mean.toFixed(0)}</div>
          <p className="dim small">
            median {stats.median.toFixed(0)} · spread {stats.spread.toFixed(0)}
          </p>
        </div>
        <div className="panel">
          <h3>Most common errors</h3>
          <BarChart
            data={stats.topErrors.map((e) => ({ label: e.kind, value: e.n }))}
            color="#e5534b"
            height={120}
          />
        </div>
        <div className="panel">
          <h3>Detection score distribution</h3>
          <LineChart
            points={stats.detection}
            color="#3fb6d9"
            height={120}
          />
        </div>
      </div>

      {byUnit.map(([unit, trainees]) => (
        <div className="panel mt" key={unit}>
          <h3>{unit} — {trainees.length} trainees</h3>
          <UnitHeatmap
            trainees={trainees}
            sessions={sessions}
            results={results}
            nameOf={nameOf}
          />
        </div>
      ))}

      {byUnit.length === 0 && (
        <p className="dim">No trainees with units yet. Assign units from the admin console.</p>
      )}
    </div>
  );
}

const COMPETENCIES = [
  "detection",
  "classification",
  "response",
  "reporting",
  "prioritisation",
  "coordination",
  "adaptation",
] as const;

const UnitHeatmap = ({
  trainees,
  sessions,
  results,
  nameOf,
}: {
  trainees: readonly PublicUser[];
  sessions: readonly SessionRecord[];
  results: Map<string, ScoreResult>;
  nameOf: (id: string) => string;
}) => {
  // Latest scored session per trainee
  const latest = new Map<string, ScoreResult | null>();
  for (const t of trainees) {
    const mine = sessions
      .filter((s) => s.trainee_id === t.id && s.status === "scored")
      .sort((a, b) => (b.ended_at ?? "").localeCompare(a.ended_at ?? ""));
    const first = mine[0];
    latest.set(t.id, first !== undefined ? (results.get(first.id) ?? null) : null);
  }
  const max = 100;

  return (
    <div className="heatmap" style={{ gridTemplateColumns: `140px repeat(${COMPETENCIES.length + 1}, 1fr)` }}>
      <div className="hm-cell hm-head">trainee</div>
      {COMPETENCIES.map((c) => (
        <div className="hm-cell hm-head" key={c}>
          {c.slice(0, 6)}
        </div>
      ))}
      <div className="hm-cell hm-head">total</div>
      {trainees.map((t) => {
        const r = latest.get(t.id);
        return (
          <div key={t.id} style={{ display: "contents" }}>
            <div className="hm-cell" style={{ textAlign: "left" }}>
              {nameOf(t.id)}
            </div>
            {COMPETENCIES.map((c) => {
              const comp = r?.competencies.find((x) => x.competency === c);
              const value = comp !== undefined && comp.assessed ? comp.points : null;
              return <HeatCell key={c} value={value} max={max} />;
            })}
            <HeatCell value={r?.total ?? null} max={max} />
          </div>
        );
      })}
    </div>
  );
};
