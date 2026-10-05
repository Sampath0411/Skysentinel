import { useEffect, useMemo, useState } from "react";
import { Link } from "react-router-dom";
import type { Competency, ScoreResult } from "@skysentinel/scoring";
import type { ProgressRun } from "../types.js";
import { getProgress, getScore } from "../api.js";
import { useAuth } from "../auth.js";
import { BarChart, Histogram, LineChart, RadarChart } from "./charts.js";
import { fmtWall } from "../format.js";

const ALL_COMP: readonly Competency[] = [
  "detection",
  "classification",
  "response",
  "reporting",
  "prioritisation",
  "coordination",
  "adaptation",
];

/**
 * Trainee profile (PRD §12.3): trends, competency
 * mastery, error frequency, learning gain, and the
 * next recommended scenario with rationale.
 */
export default function TraineeProfile() {
  const { user } = useAuth();
  const [runs, setRuns] = useState<ProgressRun[]>([]);
  const [results, setResults] = useState<ScoreResult[]>([]);
  const [loaded, setLoaded] = useState(false);

  useEffect(() => {
    if (user === null) return;
    (async () => {
      const p = await getProgress(user.id);
      setRuns(p.runs);
      const scored = p.runs.filter((r) => r.total !== null);
      const results: ScoreResult[] = [];
      for (const r of scored) {
        try {
          const s = await getScore(r.session_id);
          results.push(s.score.result);
        } catch {
          // A run whose score is not readable yet is skipped.
        }
      }
      setResults(results);
      setLoaded(true);
    })().catch(() => setLoaded(true));
  }, [user]);

  const analysis = useMemo(() => analyze(results), [results]);

  if (user === null) return null;
  if (!loaded) return <p className="dim">Loading progress…</p>;

  const mean = analysis.competencyMeans;
  const weakest = ALL_COMP.map((c) => ({ c, v: mean[c] ?? 50 })).sort((a, b) => a.v - b.v)[0];
  const suggestion = weakest !== undefined ? suggestNext(weakest.c, weakest.v) : null;

  return (
    <div>
      <h1>My progress</h1>

      {runs.length === 0 ? (
        <div className="panel">
          <p>No scored sessions yet.</p>
          <Link className="chip kind" to="/">
            Launch a scenario
          </Link>
        </div>
      ) : (
        <>
          <div className="card-row">
            <div className="panel">
              <h3>Sessions</h3>
              <div className="score-big">
                {analysis.meanTotal.toFixed(0)}
                <span className="of"> avg</span>
              </div>
              <p className="dim small">
                {runs.length} runs · best {analysis.bestTotal?.toFixed(0) ?? "—"} · gain{" "}
                {analysis.gain === null ? "—" : `${analysis.gain.toFixed(0)}%`}
              </p>
            </div>
            <div className="panel">
              <h3>Mastery by competency</h3>
              <RadarChart
                axes={ALL_COMP.map((c) => ({ label: c, value: mean[c] ?? 0 }))}
              />
            </div>
          </div>

          <div className="panel mt">
            <h3>Score across sessions</h3>
            <LineChart
              points={results.map((r) => r.total)}
              labels={results.map((_, i) => `#${i + 1}`)}
            />
          </div>

          <div className="grid mt" style={{ gridTemplateColumns: "1fr 1fr" }}>
            <div className="panel">
              <h3>Critical errors by kind</h3>
              <BarChart data={analysis.errorKinds} color="#e5534b" />
            </div>
            <div className="panel">
              <h3>Detection competency distribution</h3>
              <Histogram
                values={results.map((r) => r.competencies.find((c) => c.competency === "detection")?.points ?? 0)}
                min={0}
                max={100}
                bins={10}
                color="#3fb6d9"
              />
            </div>
          </div>

          {suggestion !== null && (
            <div className="panel mt">
              <h3>Recommended next</h3>
              <p>
                <b>{suggestion.text}</b>
              </p>
              <p className="dim small">
                Weakest competency: {weakest?.c} (
                {(weakest?.v ?? 0).toFixed(0)}%). The recommender targets the
                weakest dimension with the easiest family that exercises it,
                then steps difficulty up as mastery grows (PRD §11.2).
              </p>
              <Link className="chip kind" to="/">
                Choose scenario
              </Link>
            </div>
          )}

          <div className="panel mt">
            <h3>Session history</h3>
            <table className="data">
              <thead>
                <tr>
                  <th>#</th>
                  <th>Scenario</th>
                  <th>Mode</th>
                  <th>Ended</th>
                  <th>Total</th>
                  <th>Critical errors</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {runs.map((r, i) => (
                  <tr key={r.session_id} className="clickable" onClick={() => undefined}>
                    <td className="mono">{i + 1}</td>
                    <td className="mono">{r.scenario_id}</td>
                    <td>{r.mode}</td>
                    <td className="mono small">{fmtWall(r.ended_at)}</td>
                    <td className="mono">{r.total?.toFixed(0) ?? "—"}</td>
                    <td className="mono">{r.critical_errors ?? "—"}</td>
                    <td>
                      <Link className="chip kind" to={`/aar/${r.session_id}`} onClick={(e) => e.stopPropagation()}>
                        AAR
                      </Link>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}
    </div>
  );
}

interface Analysis {
  meanTotal: number;
  bestTotal: number | null;
  gain: number | null;
  competencyMeans: Record<string, number>;
  errorKinds: readonly { label: string; value: number }[];
}

const analyze = (results: readonly ScoreResult[]): Analysis => {
  const totals = results.map((r) => r.total);
  const meanTotal = totals.length > 0 ? totals.reduce((a, b) => a + b, 0) / totals.length : 0;
  const bestTotal = totals.length > 0 ? Math.max(...totals) : null;

  // Learning gain: mean of first 3 vs last 3 (PRD §11.3)
  let gain: number | null = null;
  if (totals.length >= 4) {
    const first = totals.slice(0, 3);
    const last = totals.slice(-3);
    const baseline = first.reduce((a, b) => a + b, 0) / first.length;
    const post = last.reduce((a, b) => a + b, 0) / last.length;
    gain = ((post - baseline) / Math.max(1, 100 - baseline)) * 100;
  }

  const competencyMeans: Record<string, number> = {};
  for (const c of ALL_COMP) {
    const vals = results
      .map((r) => r.competencies.find((x) => x.competency === c))
      .filter((x): x is NonNullable<typeof x> => x !== undefined && x.assessed)
      .map((x) => x.points);
    competencyMeans[c] = vals.length > 0 ? vals.reduce((a, b) => a + b, 0) / vals.length : 50;
  }

  const errorCounts = new Map<string, number>();
  for (const r of results) {
    for (const e of r.critical_errors) {
      errorCounts.set(e.kind, (errorCounts.get(e.kind) ?? 0) + 1);
    }
  }
  const errorKinds = [...errorCounts.entries()]
    .map(([label, value]) => ({ label, value }))
    .sort((a, b) => b.value - a.value);

  return { meanTotal, bestTotal, gain, competencyMeans, errorKinds };
};

/** PRD §11.2 recommender rationale, as plain language. */
const suggestNext = (competency: string, mastery: number): { text: string } => {
  const family =
    competency === "prioritisation" || competency === "adaptation"
      ? "decoy_plus_main_swarm"
      : "recon_near_asset";
  const difficulty = Math.max(1, Math.min(5, Math.round(1 + 4 * (mastery / 100))));
  return {
    text: `Weak ${competency} (${mastery.toFixed(0)}%) → ${family}, difficulty ${difficulty}`,
    ...{},
  };
};
