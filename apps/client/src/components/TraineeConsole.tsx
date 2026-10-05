import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useNavigate, useParams } from "react-router-dom";
import type { FusedTrack, TraineeView } from "@skysentinel/sim-core";
import type { AnySimEvent, Posture, SensorMode } from "@skysentinel/shared";
import type { ClientScenario, ClassificationLog } from "../types.js";
import { foldClassifications } from "../types.js";
import { api, endSession, openSessionSocket, sendAction, type Frame } from "../api.js";
import { useSmoothTracks } from "../useSmoothTracks.js";
import { useAuth } from "../auth.js";
import TopBar from "./TopBar.js";
import EoScene from "./EoScene.js";
import RadarCanvas from "./RadarCanvas.js";
import RfCanvas from "./RfCanvas.js";
import CopMap from "./CopMap.js";
import TrackPanel from "./TrackPanel.js";
import ClassificationForm from "./ClassificationForm.js";
import ReportForm from "./ReportForm.js";
import ResponsePanel from "./ResponsePanel.js";
import RadioLog from "./RadioLog.js";

/** Zero support cues, for the toggle's "hidden" state — a stable empty reference. */
const EMPTY_SUPPORT_CUES = new Map<string, { text: string; p: number }>();

/**
 * Trainee operator console (PRD §13.1).
 *
 * The client is a pure view: the server owns the simulation and
 * sends role-filtered frames over the WebSocket. Every action is
 * posted to `/action`, which validates it against live sim state
 * and returns the authoritative view — the client never simulates
 * and never trusts its own optimistic state.
 */
export default function TraineeConsole() {
  const { sessionId } = useParams<{ sessionId: string }>();
  const { user } = useAuth();
  const navigate = useNavigate();
  const id = sessionId ?? "";

  const [scenario, setScenario] = useState<ClientScenario | null>(null);
  const [view, setView] = useState<TraineeView | null>(null);
  const [events, setEvents] = useState<AnySimEvent[]>([]);
  const [selectedTrack, setSelectedTrack] = useState<string | null>(null);
  const [eoMode, setEoMode] = useState<"eo" | "ir">("eo");
  /** Bearing the EO/IR reticle is pointing at, for the `Space` hotkey (PRD §13.1). */
  const [eoBearing, setEoBearing] = useState<number | null>(null);
  /** Support-cue display toggle (PRD §13.1). The run decides whether cues exist at all. */
  const [supportCuesShown, setSupportCuesShown] = useState(true);
  const [reportLoc, setReportLoc] = useState<{ bearing_deg: number; range_m: number } | null>(null);
  const [notice, setNotice] = useState<{ kind: "info" | "error"; text: string } | null>(null);
  const [finishing, setFinishing] = useState(false);
  const finishedRef = useRef(false);

  // Scenario context (assets, flights, sensors, posture) — the
  // scenario minus its answer key, which the server strips.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const row = await api<{ session: { scenario_id: string } }>(`/api/sessions/${id}`);
        const sc = await api<{ scenario: ClientScenario }>(`/api/scenarios/${row.session.scenario_id}`);
        if (!cancelled) setScenario(sc.scenario);
      } catch (e) {
        setNotice({ kind: "error", text: e instanceof Error ? e.message : "Brief load failed" });
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [id]);

  // Frame stream. The first message is a full snapshot.
  useEffect(() => {
    const close = openSessionSocket(id, (msg) => {
      if (msg.type === "error") {
        setNotice({ kind: "error", text: msg.message });
        return;
      }
      if (msg.type === "ended") {
        void finish(msg.reason);
        return;
      }
      const frame = msg as Frame;
      setView(frame.view);
      setEvents((prev) => {
        const lastSeq = prev.length > 0 ? (prev[prev.length - 1]?.seq ?? 0) : 0;
        const fresh = frame.events.filter((e) => e.seq > lastSeq);
        return fresh.length > 0 ? [...prev, ...fresh] : prev;
      });
      if (frame.view.over) void finish("scenario_complete");
    });
    return close;
  }, [id]);

  const finish = useCallback(
    async (reason: string) => {
      if (finishedRef.current) return;
      finishedRef.current = true;
      setFinishing(true);
      try {
        await endSession(id, reason);
        navigate(`/aar/${id}`);
      } catch {
        // End-of-run scoring is idempotent server-side; the AAR
        // route scores on demand if this call raced a restart.
        navigate(`/aar/${id}`);
      }
    },
    [id, navigate],
  );

  /** Post one trainee action; adopt the server's authoritative view. */
  const act = useCallback(
    async (
      type: "mark_contact" | "classify" | "report" | "act" | "request_authority" | "view_brief",
      payload: Record<string, unknown>,
    ): Promise<boolean> => {
      try {
        const r = await sendAction(id, type, payload);
        setView(r.view);
        setNotice(null);
        return true;
      } catch (e) {
        setNotice({ kind: "error", text: e instanceof Error ? e.message : "Action rejected" });
        return false;
      }
    },
    [id],
  );

  const classifications = useMemo<ClassificationLog>(() => foldClassifications(events), [events]);

  /**
   * Tracks for the canvases, interpolated between the last two frames.
   *
   * The server steps at 20 Hz but the display redraws at 60 Hz, so drawing the
   * frame's own positions makes every contact stutter (see `interpolate.ts`).
   * The reader is stable, so the panels hold it in a ref and never re-subscribe.
   */
  const frameForPlots = useMemo(
    () => (view === null ? null : { t_ms: view.t_ms, tracks: view.tracks }),
    [view],
  );
  const readTracks = useSmoothTracks(frameForPlots);

  const sensorModes = useMemo<Record<string, SensorMode>>(() => {
    const modes: Record<string, SensorMode> = { ...(scenario?.sensors ?? {}) };
    for (const ev of events) {
      if (ev.type === "sensor_state_changed") modes[ev.payload.sensor] = ev.payload.mode;
    }
    return modes;
  }, [events, scenario]);

  const observations = useMemo(
    () => events.filter((e) => e.type === "sensor_observation"),
    [events],
  );
  const radarObs = useMemo(
    () => observations.filter((o) => o.type === "sensor_observation" && o.payload.sensor === "radar"),
    [observations],
  );
  const rfObs = useMemo(
    () => observations.filter((o) => o.type === "sensor_observation" && o.payload.sensor === "rf"),
    [observations],
  );

  const supportCues = useMemo(() => {
    const cues = new Map<string, { text: string; p: number }>();
    for (const ev of events) {
      if (ev.type === "support_cue_shown") {
        cues.set(ev.payload.track_id, { text: ev.payload.text, p: ev.payload.p });
      }
    }
    return cues;
  }, [events]);

  const selected = useMemo(
    () => view?.tracks.find((t) => t.track_id === selectedTrack) ?? null,
    [view, selectedTrack],
  );

  /**
   * The cue under the EO/IR reticle: of the cues still pending, the one whose track
   * bears closest to where the camera is looking. Falls back to the first pending
   * cue when the reticle is pointing at nothing in range, so a keyboard-only run
   * still marks something.
   */
  const cueAtReticle = useCallback(
    (pending: readonly string[]): string | undefined => {
      if (pending.length === 0) return undefined;
      if (eoBearing === null) return pending[0];

      const bearingOf = (cueId: string): number | undefined => {
        const ev = events.find((e) => e.type === "cue_presented" && e.payload.cue_id === cueId);
        const trackId = ev?.type === "cue_presented" ? ev.payload.track_id : undefined;
        const track = view?.tracks.find((t) => t.track_id === trackId);
        return track?.bearing_deg;
      };

      let best = pending[0]!;
      let bestGap = Number.POSITIVE_INFINITY;
      for (const cue of pending) {
        const b = bearingOf(cue);
        if (b === undefined) continue;
        const gap = Math.min(Math.abs(b - eoBearing), 360 - Math.abs(b - eoBearing));
        if (gap < bestGap) {
          bestGap = gap;
          best = cue;
        }
      }
      // 30° is about the width of the reticle's useful coverage at the ranges this
      // view works at; wider than that and the camera is plainly looking elsewhere.
      return bestGap <= 30 ? best : pending[0];
    },
    [eoBearing, events, view],
  );

  // --- hotkeys (PRD §13.1) ------------------------------------------------
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement) return;
      if (e.target instanceof HTMLSelectElement) return;

      if (e.code === "Tab") {
        e.preventDefault();
        if (!view || view.tracks.length === 0) return;
        const idx = view.tracks.findIndex((t) => t.track_id === selectedTrack);
        const next = view.tracks[(idx + 1) % view.tracks.length] as FusedTrack | undefined;
        if (next) setSelectedTrack(next.track_id);
        return;
      }
      if (e.code === "Space") {
        e.preventDefault();
        if (!view) return;
        // PRD §13.1: mark the contact at the crosshair. The reticle is an EO/IR
        // overlay, so a run with no camera bearing falls back to the cue strip.
        const cue = cueAtReticle(view.pending_cues);
        if (cue !== undefined) {
          void act("mark_contact", { cue_id: cue });
        } else if (selectedTrack !== null) {
          setNotice({ kind: "info", text: "No pending cues — mark cues from the cue strip." });
        }
        return;
      }
      if (e.code === "KeyR") {
        setReportFocus((f) => f + 1);
        return;
      }
      if (!selectedTrack) return;
      if (e.code === "KeyW") void act("act", { action: "issue_warning", track_id: selectedTrack });
      if (e.code === "KeyP") void act("act", { action: "activate_protective_drill", track_id: selectedTrack });
      if (e.code === "KeyA") void act("request_authority", { track_id: selectedTrack });
      const catIdx = ["Digit1", "Digit2", "Digit3", "Digit4", "Digit5", "Digit6"].indexOf(e.code);
      if (catIdx >= 0) {
        const categories = ["friendly", "authorised", "unknown", "suspicious", "hostile", "non_uas"];
        const current = classifications.latest.get(selectedTrack);
        void act("classify", {
          track_id: selectedTrack,
          category: categories[catIdx],
          confidence: current?.confidence ?? "medium",
        });
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [view, selectedTrack, classifications, act, cueAtReticle]);

  // Report-focus counter: R bumps this, ReportForm focuses its activity field.
  const [reportFocus, setReportFocus] = useState(0);

  if (user === null) return null;

  const tracks = view?.tracks ?? [];
  const pendingCues = view?.pending_cues ?? [];

  return (
    <div>
      <TopBar
        t_ms={view?.t_ms ?? 0}
        scenario={scenario}
        posture={(view?.authority.posture ?? null) as Posture | null}
        sensorModes={sensorModes}
        supportCueCount={supportCues.size}
        supportCuesShown={supportCuesShown}
        onToggleSupportCues={() => setSupportCuesShown((s) => !s)}
        onEnd={() => void finish("ended_by_trainee")}
      />

      {notice !== null && (
        <div className={`notice ${notice.kind === "error" ? "error" : ""}`}>{notice.text}</div>
      )}

      {pendingCues.length > 0 && (
        <div className="cue-strip">
          {pendingCues.map((cue) => (
            <span className="cue" key={cue}>
              NEW CUE {cue}
              <button
                className="small primary"
                onClick={() => void act("mark_contact", { cue_id: cue })}
              >
                Mark contact (Space)
              </button>
            </span>
          ))}
        </div>
      )}

      <div className="console-grid">
        <div className="panel panel-canvas p-eo">
          <div className="panel-head">
            <h3>EO / IR view</h3>
            <div className="flex">
              <button
                className={`small ${eoMode === "eo" ? "primary" : ""}`}
                onClick={() => setEoMode("eo")}
              >
                EO
              </button>
              <button
                className={`small ${eoMode === "ir" ? "primary" : ""}`}
                onClick={() => setEoMode("ir")}
              >
                IR
              </button>
            </div>
          </div>
          <div className="canvas-wrap">
            {scenario !== null && (
              <EoScene
                scenario={scenario}
                tracks={tracks}
                observations={observations}
                mode={eoMode}
                selectedTrack={selectedTrack}
                onBearing={setEoBearing}
                readTracks={readTracks}
              />
            )}
            {/* Reticle (PRD §13.1): `Space` marks the contact under it. */}
            <div className="reticle" aria-hidden>
              <div className="reticle-arm h" />
              <div className="reticle-arm v" />
              <div className="reticle-ring" />
            </div>
          </div>
        </div>

        <div className="panel panel-canvas p-radar">
          <div className="panel-head">
            <h3>Radar PPI</h3>
            <span className="dim small mono">
              {sensorModes["radar"] === "failed" ? "OFFLINE" : (sensorModes["radar"] ?? "normal").toUpperCase()}
            </span>
          </div>
          <div className="canvas-wrap">
            <RadarCanvas
              tracks={tracks}
              observations={radarObs}
              t_ms={view?.t_ms ?? 0}
              mode={sensorModes["radar"] ?? "normal"}
              readTracks={readTracks}
            />
          </div>
        </div>

        <div className="panel panel-canvas p-rf">
          <div className="panel-head">
            <h3>RF direction finding</h3>
            <span className="dim small mono">
              {sensorModes["rf"] === "failed" ? "OFFLINE" : (sensorModes["rf"] ?? "normal").toUpperCase()}
            </span>
          </div>
          <div className="canvas-wrap">
            <RfCanvas observations={rfObs} mode={sensorModes["rf"] ?? "normal"} />
          </div>
        </div>

        <div className="panel panel-canvas p-cop">
          <div className="panel-head">
            <h3>COP — tactical map</h3>
            <span className="dim small">click to set report location</span>
          </div>
          <div className="canvas-wrap">
            {scenario !== null && (
              <CopMap
                scenario={scenario}
                tracks={tracks}
                selectedTrack={selectedTrack}
                reportLoc={reportLoc}
                onPick={setReportLoc}
                readTracks={readTracks}
              />
            )}
          </div>
        </div>

        <div className="panel p-action" style={{ overflowY: "auto" }}>
          <TrackPanel
            tracks={tracks}
            selectedTrack={selectedTrack}
            onSelect={setSelectedTrack}
            classifications={classifications}
            supportCues={supportCuesShown ? supportCues : EMPTY_SUPPORT_CUES}
          />
          <ClassificationForm
            track={selected}
            classification={selectedTrack !== null ? classifications.latest.get(selectedTrack) : undefined}
            onSubmit={(category, confidence, platform) =>
              void act("classify", { track_id: selectedTrack, category, confidence, ...(platform ? { platform } : {}) })
            }
          />
          <ReportForm
            tracks={tracks}
            selectedTrack={selectedTrack}
            reportLoc={reportLoc}
            focusSignal={reportFocus}
            events={events}
            onSubmit={(fields) => void act("report", fields)}
          />
          <ResponsePanel
            track={selected}
            classification={selectedTrack !== null ? classifications.latest.get(selectedTrack) : undefined}
            authority={view?.authority ?? null}
            onAct={(action) => void act("act", { action, track_id: selectedTrack })}
            onRequestAuthority={() => void act("request_authority", { track_id: selectedTrack })}
            onReclassify={() => {
              const el = document.getElementById("classify-cat-0");
              el?.focus();
            }}
          />
          <RadioLog events={events} />
        </div>
      </div>

      {finishing && (
        <div className="overlay">
          <div className="box panel">
            <h2>Scenario complete</h2>
            <p className="dim">Scoring… the after-action review is being prepared.</p>
          </div>
        </div>
      )}
    </div>
  );
}
