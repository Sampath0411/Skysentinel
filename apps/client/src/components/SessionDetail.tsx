import { useCallback, useEffect, useMemo, useState } from "react";
import { useNavigate, useParams } from "react-router-dom";
import type { AnySimEvent } from "@skysentinel/shared";
import { coachBrief } from "@skysentinel/scoring";
import type { ClassificationState, ClientScenario, ReplayPayload, ScorePayload } from "../types.js";
import type { DetectionGrade } from "@skysentinel/scoring";
import { addAnnotation, api, getReplay, getScore } from "../api.js";
import { useAuth } from "../auth.js";
import { fmtClock, fmtDuration, fmtWall } from "../format.js";
import Timeline from "./Timeline.js";
import ReplayMap from "./ReplayMap.js";
import ScoreTree from "./ScoreTree.js";

/**
 * AAR session detail (PRD §12.2–§12.6).
 *
 * Renders entirely from the stored event log and score
 * tree — no simulation re-run. The scrubber drives the
 * map replay, the evidence panel and the timeline
 * marker together, so a reviewer can ask "what did the
 * trainee know at 3:12?" and see it.
 */
export default function SessionDetail() {
  const { sessionId } = useParams<{ sessionId: string }>();
  const { user } = useAuth();
  const navigate = useNavigate();
  const id = sessionId ?? "";
  const isStaff = user !== null && (user.role === "instructor" || user.role === "admin");

  const [replay, setReplay] = useState<ReplayPayload | null>(null);
  const [score, setScore] = useState<ScorePayload | null>(null);
  const [scenario, setScenario] = useState<ClientScenario | null>(null);
  const [loadError, setLoadError] = useState("");
  const [scrubT, setScrubT] = useState(0);
  const [playing, setPlaying] = useState(false);
  const [speed, setSpeed] = useState(4);
  const [showTruth, setShowTruth] = useState(true);
  const [annText, setAnnText] = useState("");
  const [seqIndex, setSeqIndex] = useState<Map<number, number>>(new Map());

  const load = useCallback(async () => {
    try {
      const [rp, scoreRes] = await Promise.all([
        getReplay(id),
        getScore(id).catch((e: { status?: number }) =>
          e.status === 409 ? null : Promise.reject(e),
        ) as Promise<{ score: ScorePayload } | null>,
      ]);
      setReplay(rp);
      if (scoreRes !== null) setScore(scoreRes.score);
      setScrubT(0);
      // seq → t_ms index for timeline jumps from the score tree
      const idx = new Map<number, number>();
      for (const ev of rp.events) idx.set(ev.seq, ev.t_ms);
      setSeqIndex(idx);
      // The replay payload carries the session row; the map
      // needs the scenario geometry, so fetch it too.
      const row = await api<{ session: { scenario_id: string } }>(`/api/sessions/${id}`);
      const sc = await api<{ scenario: ClientScenario }>(`/api/scenarios/${row.session.scenario_id}`);
      setScenario(sc.scenario);
    } catch (e) {
      setLoadError(e instanceof Error ? e.message : "AAR load failed");
    }
  }, [id]);

  useEffect(() => {
    void load();
  }, [load]);

  const events = replay?.events ?? [];
  const duration = replay?.session.duration_ms ?? Math.max(0, ...events.map((e) => e.t_ms));

  // Playback
  useEffect(() => {
    if (!playing) return;
    let raf = 0;
    let last = performance.now();
    const step = (now: number) => {
      const dt = now - last;
      last = now;
      setScrubT((t) => {
        const next = t + dt * speed;
        if (next >= duration) {
          setPlaying(false);
          return duration;
        }
        return next;
      });
      raf = requestAnimationFrame(step);
    };
    raf = requestAnimationFrame(step);
    return () => cancelAnimationFrame(raf);
  }, [playing, speed, duration]);

  const jumpToSeq = useCallback(
    (seq: number) => {
      const t = seqIndex.get(seq);
      if (t !== undefined) setScrubT(t);
    },
    [seqIndex],
  );

  const criticalSeqs = useMemo(() => {
    const seqs = new Set<number>();
    for (const c of score?.result.critical_errors ?? []) {
      for (const ref of c.event_refs) seqs.add(ref);
    }
    return seqs;
  }, [score]);

  /**
   * Per-event verdicts, read off the score tree so the timeline colours what the
   * tree concluded (PRD §12.2: "colour = verdict") rather than re-judging the log.
   *
   * Only scored nodes contribute — a zero-max node carries no verdict, just an
   * explanation. A `seq` cited by both a passing and a failing node reads as failed:
   * the failure is what a reviewer needs to find on the strip.
   */
  const verdicts = useMemo(() => {
    const m = new Map<number, "pass" | "fail">();
    for (const n of score?.result.nodes ?? []) {
      if (n.max_points === 0) continue;
      for (const ref of n.event_refs) {
        if (m.get(ref) === "fail") continue;
        m.set(ref, n.passed ? "pass" : "fail");
      }
    }
    return m;
  }, [score]);

  // --- evidence at time T ---------------------------------------------
  const evidence = useMemo(() => {
    const obs: AnySimEvent[] = [];
    const trackState = new Map<string, (typeof events)[number]>();
    const classState = new Map<string, ClassificationState>();
    for (const ev of events) {
      if (ev.t_ms > scrubT) continue;
      if (ev.type === "sensor_observation") obs.push(ev);
      if (ev.type === "track_update") trackState.set(ev.payload.track_id, ev);
      if (ev.type === "classification_submitted") {
        classState.set(ev.payload.track_id, {
          track_id: ev.payload.track_id,
          category: ev.payload.category,
          confidence: ev.payload.confidence,
          ...(ev.payload.platform !== undefined ? { platform: ev.payload.platform } : {}),
          t_ms: ev.t_ms,
          is_reclassification: ev.payload.is_reclassification,
        });
      }
    }
    return { obs: obs.slice(-8).reverse(), trackState, classState };
  }, [events, scrubT]);

  const scenarioOf = useMemo(() => replay?.session.scenario_id ?? "", [replay]);

  const sendAnnotation = async () => {
    if (annText.trim() === "") return;
    await addAnnotation(id, Math.round(scrubT), annText.trim());
    setAnnText("");
    await load();
  };

  const exportJson = () => {
    const blob = new Blob([JSON.stringify({ replay, score }, null, 2)], {
      type: "application/json",
    });
    download(blob, `${scenarioOf}-aar.json`);
  };

  const exportCsv = () => {
    const header = "seq,t_ms,type,actor,visibility,payload";
    const rows = events.map((e) =>
      [e.seq, e.t_ms, e.type, e.actor, e.visibility, JSON.stringify(e.payload)]
        .map((c) => `"${String(c).replace(/"/g, '""')}"`)
        .join(","),
    );
    const blob = new Blob([[header, ...rows].join("\n")], { type: "text/csv" });
    download(blob, `${scenarioOf}-events.csv`);
  };

  if (loadError !== "" && replay === null) {
    return (
      <div className="panel">
        <h2>AAR unavailable</h2>
        <p className="dim">{loadError}</p>
        <button onClick={() => navigate("/aar")}>Back to list</button>
      </div>
    );
  }
  if (replay === null) return <p className="dim">Loading AAR…</p>;

  const result = score?.result;
  if (scenario === null) return <p className="dim">Loading scenario geometry…</p>;

  const actionCount = events.filter((e) => e.type === "action_taken").length;
  const unauthorised = (result?.critical_errors ?? []).filter(
    (c) => c.kind === "UNAUTHORISED_ACTION",
  ).length;

  return (
    <div>
      <div className="flex-between mb">
        <button className="ghost small no-print" onClick={() => navigate("/aar")}>
          ← All sessions
        </button>
        <div className="flex no-print">
          <button className="small" onClick={exportJson}>
            Export JSON
          </button>
          <button className="small" onClick={exportCsv}>
            Export CSV
          </button>
          <button className="small" onClick={() => window.print()}>
            Print / PDF
          </button>
        </div>
      </div>

      <div className="aar-head">
        <h1 className="mono">{scenarioOf}</h1>
        {scenario !== null && scenario.difficulty !== null && (
          <span className={`chip d${scenario.difficulty}`} title="Scenario difficulty">
            D{scenario.difficulty}
          </span>
        )}
        <span className="chip">seed {result?.seed ?? replay.session.scenario_id}</span>
        <span className="chip">{replay.session.mode}</span>
        <span className="chip">{fmtDuration(replay.session.duration_ms)}</span>
        {result !== undefined && (
          <>
            <span className="chip kind" title="Process score (PRD §10.6): the decision tree, before penalties.">
              process {result.process_score.toFixed(0)}
            </span>
            <span
              className="chip kind"
              title={`Mission outcome: asset integrity ${result.mission_outcome.asset_integrity.toFixed(0)}%, ${result.mission_outcome.assets_lost} asset(s) lost, ${result.mission_outcome.threats_neutralised} neutralised, ${result.mission_outcome.impacts} impact(s).`}
            >
              outcome {result.mission_outcome.score.toFixed(0)} · {result.mission_outcome.impacts} impact
              {result.mission_outcome.impacts === 1 ? "" : "s"}
            </span>
          </>
        )}
        <span className="dim small">ended {fmtWall(replay.session.ended_at)}</span>
        <span className="spacer" />
        {score !== null && (
          <span className="score-big">
            {score.total.toFixed(0)}
            <span className="of">/100</span>
          </span>
        )}
      </div>

      {(result?.critical_errors ?? []).length > 0 && (
        <div className="mt">
          {result?.critical_errors.map((c, i) => (
            <span className="critical-chip" key={i} title={c.reason}>
              {c.kind} −{c.penalty}
            </span>
          ))}
        </div>
      )}

      {/* Mandated three (PRD §12.2) */}
      <div className="mandated-three">
        <MandatedCard
          label="Detection time"
          value={
            result === undefined
              ? "not scored"
              : result.mandated.detection.latency_s === undefined
                ? "—"
                : `${result.mandated.detection.latency_s.toFixed(1)}s`
          }
          tone={
            result === undefined
              ? "dim"
              : result.mandated.detection.grade === "at_par"
                ? "good"
                : result.mandated.detection.grade === "late" ||
                    result.mandated.detection.grade === "well_past_par"
                  ? "bad"
                  : "warn"
          }
          sub={
            result === undefined
              ? "no score for this run"
              : result.mandated.detection.latency_s === undefined
                ? gradeWord(result.mandated.detection.grade)
                : `par ${result.mandated.detection.par_s?.toFixed(1) ?? "—"}s · ${gradeWord(result.mandated.detection.grade)}`
          }
        />
        <MandatedCard
          label="Classification accuracy"
          value={result === undefined ? "not scored" : `${result.mandated.classification.accuracy_pct}%`}
          tone={
            result === undefined
              ? "dim"
              : result.mandated.classification.accuracy_pct >= 67
                ? "good"
                : result.mandated.classification.accuracy_pct >= 34
                  ? "warn"
                  : "bad"
          }
          sub={
            result === undefined
              ? "no score for this run"
              : `${result.mandated.classification.correct}/${result.mandated.classification.scored} defensible · ${result.mandated.classification.confusion_note}`
          }
        />
        <MandatedCard
          label="Response decisions"
          value={result === undefined ? "not scored" : `${result.mandated.response.correct}/${result.mandated.response.total}`}
          tone={
            result === undefined
              ? "dim"
              : result.mandated.response.unauthorised > 0
                ? "bad"
                : result.mandated.response.total === 0 || result.mandated.response.correct === result.mandated.response.total
                  ? "good"
                  : "warn"
          }
          sub={
            result === undefined
              ? "no score for this run"
              : `${unauthorised} unauthorised${unauthorised > 0 ? " — critical" : ""} · ${actionCount} action${actionCount === 1 ? "" : "s"} taken`
          }
        />
      </div>

      {/* Timeline + replay */}
      <div className="panel mb">
        <div className="flex-between wrap mb">
          <h3 style={{ margin: 0 }}>Timeline &amp; replay</h3>
          <div className="flex no-print">
            <button className="small primary" onClick={() => setPlaying((p) => !p)}>
              {playing ? "Pause" : "Play"}
            </button>
            <select value={speed} onChange={(e) => setSpeed(Number(e.target.value))}>
              {[1, 2, 4, 8, 16].map((s) => (
                <option key={s} value={s}>
                  {s}×
                </option>
              ))}
            </select>
            {isStaff && (
              <label className="small dim">
                <input
                  type="checkbox"
                  checked={showTruth}
                  onChange={(e) => setShowTruth(e.target.checked)}
                />{" "}
                Show truth
              </label>
            )}
          </div>
        </div>
        <Timeline
          events={events}
          duration_ms={Math.max(1, duration)}
          criticalSeqs={criticalSeqs}
          verdicts={verdicts}
          scrubT={scrubT}
          onScrub={setScrubT}
        />
        <div className="panel-canvas mt" style={{ height: 320 }}>
          <div className="canvas-wrap">
            <ReplayMap
              scenario={scenario}
              events={events}
              truth={isStaff ? replay.truth : []}
              scrubT={scrubT}
              showTruth={isStaff && showTruth}
            />
          </div>
        </div>
        <p className="faint small">
          {isStaff
            ? "Red diamonds: ground truth. Cyan diamonds: what the trainee knew at this instant."
            : "Cyan diamonds: what you knew at this instant. Ground truth is shown in your debrief with staff."}
        </p>
      </div>

      {/* Evidence at T */}
      <div className="panel mb">
        <h3>Evidence available at {fmtClock(scrubT)}</h3>
        <div className="grid" style={{ gridTemplateColumns: "1fr 1fr" }}>
          <div>
            <h4 className="dim">Sensor observations (latest)</h4>
            {evidence.obs.length === 0 ? (
              <p className="dim small">None yet at this time.</p>
            ) : (
              <div className="radio-log">
                {evidence.obs.map((ev) => (
                  <div className="line" key={ev.seq}>
                    <span className="t">{fmtClock(ev.t_ms)}</span>
                    <span className="sensor">
                      {ev.type === "sensor_observation" &&
                        `${ev.payload.sensor.toUpperCase()} ${ev.payload.bearing_deg.toFixed(0)}°` +
                          (ev.payload.range_m !== undefined
                            ? ` @${ev.payload.range_m.toFixed(0)}m`
                            : "") +
                          ` conf ${(ev.payload.conf * 100).toFixed(0)}%` +
                          (ev.payload.shape ? ` (${ev.payload.shape})` : "") +
                          (ev.payload.is_false ? " [clutter]" : "")}
                    </span>
                  </div>
                ))}
              </div>
            )}
          </div>
          <div>
            <h4 className="dim">Trainee picture at this time</h4>
            {evidence.trackState.size === 0 ? (
              <p className="dim small">No tracks yet.</p>
            ) : (
              <table className="data">
                <thead>
                  <tr>
                    <th>Track</th>
                    <th>Status</th>
                    <th>Sources</th>
                    <th>Conf</th>
                    <th>Declared</th>
                  </tr>
                </thead>
                <tbody>
                  {[...evidence.trackState.values()].map((ev) =>
                    ev.type === "track_update" ? (
                      <tr key={ev.seq}>
                        <td className="mono">{ev.payload.track_id}</td>
                        <td>
                          <span className={`track-status ${ev.payload.status}`}>
                            {ev.payload.status}
                          </span>
                        </td>
                        <td className="mono small">{ev.payload.sources.join("+")}</td>
                        <td className="mono">{(ev.payload.conf * 100).toFixed(0)}%</td>
                        <td>
                          {evidence.classState.get(ev.payload.track_id) !== undefined ? (
                            <span
                              className={`cat-${evidence.classState.get(ev.payload.track_id)!.category}`}
                            >
                              {evidence.classState.get(ev.payload.track_id)!.category}/
                              {evidence.classState.get(ev.payload.track_id)!.confidence}
                            </span>
                          ) : (
                            <span className="faint">—</span>
                          )}
                        </td>
                      </tr>
                    ) : null,
                  )}
                </tbody>
              </table>
            )}
          </div>
        </div>
      </div>

      {/* Score tree + coach */}
      <div className="grid" style={{ gridTemplateColumns: "minmax(0,1.2fr) minmax(0,1fr)" }}>
        <div className="panel">
          <h3>Score explanation</h3>
          {result !== undefined && <ScoreTree nodes={result.nodes} onJump={jumpToSeq} />}
        </div>
        <div>
          {result !== undefined && (
            <div className="panel">
              <h3>Coach brief</h3>
              <div className="coach-brief">
                {coachBrief(result).map((line, i) =>
                  line.startsWith("  - ") ? (
                    <span className="weakest" key={i}>
                      {line.trimStart()}
                    </span>
                  ) : (
                    <span key={i}>{line === "" ? <br /> : line}</span>
                  ),
                )}
              </div>
            </div>
          )}
          {result !== undefined && result.reviews.length > 0 && (
            <div className="panel mt">
              <h3>Process vs outcome (PRD §10.6)</h3>
              {result.reviews.map((r, i) => (
                <div className="small mb" key={i}>
                  <span className="mono">{r.truth_id}</span> — <b>{r.label}</b>
                  <div className="dim">{r.reason}</div>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>

      {/* Competency breakdown */}
      {result !== undefined && (
        <div className="panel mt">
          <h3>Competency breakdown</h3>
          <div className="heatmap" style={{ gridTemplateColumns: "repeat(8, 1fr)" }}>
            <div className="hm-cell hm-head">competency</div>
            <div className="hm-cell hm-head">points</div>
            <div className="hm-cell hm-head">weight</div>
            <div className="hm-cell hm-head">weighted</div>
            <div className="hm-cell hm-head">mandated</div>
            <div className="hm-cell hm-head">assessed</div>
            <div className="hm-cell hm-head">band</div>
            <div className="hm-cell hm-head">nodes</div>
            {result.competencies.map((c) => (
              <HeatRow key={c.competency} comp={c} />
            ))}
          </div>
        </div>
      )}

      {/* Annotations */}
      <div className="panel mt no-print">
        <h3>Annotations</h3>
        <div className="annotations">
          {replay.annotations.map((a) => (
            <div className="ann" key={a.id}>
              <div className="meta">
                {fmtClock(a.t_ms)} · {a.author_id.slice(0, 12)} · {fmtWall(a.created_at)}
              </div>
              {a.text}
            </div>
          ))}
          {replay.annotations.length === 0 && <p className="dim small">None yet.</p>}
        </div>
        <div className="flex mt">
          <input
            value={annText}
            onChange={(e) => setAnnText(e.target.value)}
            placeholder={`Annotation at ${fmtClock(scrubT)}…`}
            style={{ flex: 1 }}
            onKeyDown={(e) => {
              if (e.key === "Enter") void sendAnnotation();
            }}
          />
          <button className="small" onClick={() => void sendAnnotation()}>
            Add at {fmtClock(scrubT)}
          </button>
        </div>
      </div>
    </div>
  );
}

const HeatRow = ({ comp }: { comp: { competency: string; points: number; weight: number; weighted: number; mandated: boolean; assessed: boolean; node_ids: readonly string[] } }) => (
  <>
    {[
      comp.competency,
      comp.points.toFixed(0),
      comp.weight,
      comp.weighted.toFixed(1),
      comp.mandated ? "PS" : "—",
      comp.assessed ? "yes" : "no",
      comp.points >= 75 ? "strong" : comp.points >= 45 ? "adequate" : comp.points > 0 ? "weak" : "absent",
      String(comp.node_ids.length),
    ].map((v, i) => (
      <div
        key={i}
        className="hm-cell"
        style={
          i === 1
            ? {
                background:
                  comp.points >= 75
                    ? "rgba(87,171,122,0.3)"
                    : comp.points >= 45
                      ? "rgba(240,168,50,0.25)"
                      : "rgba(229,83,75,0.2)",
              }
            : undefined
        }
      >
        {v}
      </div>
    ))}
  </>
);

const download = (blob: Blob, name: string) => {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  a.click();
  URL.revokeObjectURL(url);
};

/**
 * The mandated card's grade, in the words the detection node uses (PRD §12.2 asks for
 * a *grade*). The three negative grades are spelled out rather than scored, because
 * "never marked" is a different lesson from "marked late".
 */
const DETECTION_GRADE_WORD: Record<DetectionGrade, string> = {
  at_par: "at par",
  late: "late",
  well_past_par: "well past par",
  never_marked: "cue presented, never marked",
  never_cued: "no cue presented",
  no_par: "no par set for this track",
};

const gradeWord = (grade: DetectionGrade): string => DETECTION_GRADE_WORD[grade] ?? grade;

type CardTone = "good" | "warn" | "bad" | "dim";

const CARD_TONE_COLOR: Record<CardTone, string> = {
  good: "var(--green)",
  warn: "var(--amber)",
  bad: "var(--red)",
  dim: "var(--text-dim)",
};

/** One of the PRD §12.2 mandated-three cells: a number a person reads, and why. */
const MandatedCard = ({
  label,
  value,
  sub,
  tone,
}: {
  label: string;
  value: string;
  sub: string;
  tone: CardTone;
}) => (
  <div className="panel mandated-card">
    <div className="label">{label}</div>
    <div className="value" style={{ color: CARD_TONE_COLOR[tone] }}>
      {value}
    </div>
    <div className="sub">{sub}</div>
  </div>
);
