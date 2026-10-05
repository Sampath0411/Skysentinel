import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useNavigate, useParams } from "react-router-dom";
import type { AnySimEvent } from "@skysentinel/shared";
import type { ClientScenario, SessionRecord, TruthEntityView } from "../types.js";
import {
  api,
  endSession,
  openSessionSocket,
  pauseSession,
  resumeSession,
  startSession,
  type EndedMessage,
  type ErrorMessage,
  type Frame,
} from "../api.js";
import { describeEvent, eventClass, fmtClock } from "../format.js";
import InjectMenu from "./InjectMenu.js";
import TruthMap from "./TruthMap.js";

/**
 * Instructor live view (PRD §13.2).
 *
 * The instructor's stream includes ground-truth events
 * (`entity_spawned`, `entity_state`), so the truth map
 * shows where things actually are, overlaid with the
 * tracks the trainee has built. The instructor can
 * start, pause, resume and end — but a trainee cannot
 * pause, which is what makes timing a scored skill — and
 * can fire injects (FR-SIM-9), which an assessment run
 * refuses so the graded exercise stays the trainee's own.
 */
export default function InstructorLive() {
  const { sessionId } = useParams<{ sessionId: string }>();
  const navigate = useNavigate();
  const id = sessionId ?? "";

  const [scenario, setScenario] = useState<ClientScenario | null>(null);
  const [mode, setMode] = useState<"assessment" | "training">("training");
  const [t_ms, setTms] = useState(0);
  const [events, setEvents] = useState<AnySimEvent[]>([]);
  const [truth, setTruth] = useState<Map<string, TruthEntityView>>(new Map());
  const [knownTracks, setKnownTracks] = useState<Map<string, [number, number, number]>>(new Map());
  const [status, setStatus] = useState<string>("created");
  const [error, setError] = useState("");
  const [ending, setEnding] = useState(false);
  const endedRef = useRef(false);
  const feedRef = useRef<HTMLDivElement>(null);

  // Scenario + session metadata
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const row = await api<{ session: SessionRecord }>(`/api/sessions/${id}`);
        if (cancelled) return;
        setStatus(row.session.status);
        setMode(row.session.mode);
        const scenarioRes = await api<{ scenario: ClientScenario }>(`/api/scenarios/${row.session.scenario_id}`);
        if (!cancelled) setScenario(scenarioRes.scenario);
      } catch (e) {
        setError(e instanceof Error ? e.message : "Session load failed");
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [id]);

  const finish = useCallback(
    async (reason: string) => {
      if (endedRef.current) return;
      endedRef.current = true;
      setEnding(true);
      try {
        await endSession(id, reason);
      } catch {
        // End is idempotent server-side.
      }
      navigate(`/aar/${id}`);
    },
    [id, navigate],
  );

  // Frame stream
  useEffect(() => {
    const close = openSessionSocket(id, (msg) => {
      if (msg.type === "error") {
        setError((msg as ErrorMessage).message);
        return;
      }
      if (msg.type === "ended") {
        void finish((msg as EndedMessage).reason);
        return;
      }
      const frame = msg as Frame;
      setTms(frame.t_ms);
      setEvents((prev) => {
        const lastSeq = prev.length > 0 ? (prev[prev.length - 1]?.seq ?? 0) : 0;
        const fresh = frame.events.filter((e) => e.seq > lastSeq);
        return fresh.length > 0 ? [...prev, ...fresh] : prev;
      });
      // Fold truth entities and trainee-known track positions
      // out of the instructor-visible stream.
      setTruth((prev) => {
        let changed = false;
        const next = new Map(prev);
        for (const ev of frame.events) {
          if (ev.type === "entity_spawned") {
            const p = ev.payload;
            next.set(p.id, {
              id: p.id,
              kind: "drone",
              pos: [0, 0, 0],
              vel: [0, 0, 0],
              affiliation_truth: p.affiliation_truth,
              intent: p.intent,
              ...(p.role !== undefined ? { role: p.role } : {}),
              ...(p.group_id !== undefined ? { group_id: p.group_id } : {}),
              neutralised: false,
              landed: false,
            });
            changed = true;
          } else if (ev.type === "entity_state") {
            const p = ev.payload;
            const cur = next.get(p.id);
            next.set(p.id, {
              ...(cur ?? {
                id: p.id,
                kind: "drone",
                affiliation_truth: null,
                intent: null,
                neutralised: false,
                landed: false,
              }),
              id: p.id,
              pos: p.pos,
              vel: p.vel,
            });
            changed = true;
          }
        }
        return changed ? next : prev;
      });
      setKnownTracks((prev) => {
        let changed = false;
        const next = new Map(prev);
        for (const ev of frame.events) {
          if (ev.type === "track_update") {
            next.set(ev.payload.track_id, ev.payload.pos_est);
            changed = true;
          }
        }
        return changed ? next : prev;
      });
    });
    return close;
  }, [id, finish]);

  // Auto-scroll the event feed
  useEffect(() => {
    const el = feedRef.current;
    if (el !== null) el.scrollTop = el.scrollHeight;
  }, [events.length]);

  const recent = useMemo(() => [...events].reverse().slice(0, 120), [events]);

  const doStart = async () => {
    try {
      await startSession(id);
      setStatus("running");
    } catch (e) {
      setError(e instanceof Error ? e.message : "Start failed");
    }
  };
  const doPause = async () => {
    try {
      await pauseSession(id);
      setStatus("paused");
    } catch (e) {
      setError(e instanceof Error ? e.message : "Pause failed");
    }
  };
  const doResume = async () => {
    try {
      await resumeSession(id);
      setStatus("running");
    } catch (e) {
      setError(e instanceof Error ? e.message : "Resume failed");
    }
  };

  if (error !== "" && scenario === null) {
    return (
      <div className="panel">
        <h2>Live view unavailable</h2>
        <p className="dim">{error}</p>
        <button onClick={() => navigate("/instructor")}>Back</button>
      </div>
    );
  }

  return (
    <div>
      <div className="topbar">
        <span className="clock">{fmtClock(t_ms)}</span>
        <span className="dim small">{scenario?.title ?? "…"}</span>
        <span className={`status-pill ${status}`}>{status}</span>
        <span className="spacer" />
        {status === "created" && (
          <button className="small primary" onClick={() => void doStart()}>
            Start
          </button>
        )}
        {status === "running" && (
          <button className="small warn" onClick={() => void doPause()}>
            Pause
          </button>
        )}
        {status === "paused" && (
          <button className="small primary" onClick={() => void doResume()}>
            Resume
          </button>
        )}
        <button className="small danger" onClick={() => void finish("ended_by_instructor")}>
          End session
        </button>
      </div>
      {error !== "" && <div className="notice error">{error}</div>}

      <div
        style={{
          display: "grid",
          gridTemplateColumns: "minmax(0,1.5fr) minmax(0,1fr) minmax(0,290px)",
          gap: 10,
          height: "calc(100vh - 210px)",
          minHeight: 420,
        }}
      >
        <div className="panel panel-canvas">
          <div className="panel-head">
            <h3>Truth map — ground truth + trainee's known tracks</h3>
          </div>
          <div className="canvas-wrap">
            {scenario !== null && (
              <TruthMap
                scenario={scenario}
                truth={[...truth.values()]}
                knownTracks={knownTracks}
              />
            )}
          </div>
        </div>

        <div className="panel" style={{ display: "flex", flexDirection: "column", overflow: "hidden" }}>
          <h3>Event feed ({events.length})</h3>
          <div ref={feedRef} className="radio-log" style={{ flex: 1, maxHeight: "none" }}>
            {recent.map((ev) => (
              <div className="line" key={ev.seq}>
                <span className="t">{fmtClock(ev.t_ms)}</span>
                <span className={eventClass(ev.type)}>{describeEvent(ev)}</span>
              </div>
            ))}
            {events.length === 0 && <div className="line dim">Waiting for the session to start…</div>}
          </div>
        </div>

        <div className="panel" style={{ overflowY: "auto" }}>
          <InjectMenu sessionId={id} mode={mode} running={status === "running"} />
        </div>
      </div>

      {ending && (
        <div className="overlay">
          <div className="box panel">
            <h2>Session ended</h2>
            <p className="dim">Scoring… opening the after-action review.</p>
          </div>
        </div>
      )}
    </div>
  );
}
