import { useEffect, useMemo, useRef, useState } from "react";
import type { AnySimEvent } from "@skysentinel/shared";
import { Legend } from "./charts.js";

interface TimelineProps {
  events: readonly AnySimEvent[];
  duration_ms: number;
  /** `seq` values that triggered a critical error. */
  criticalSeqs: ReadonlySet<number>;
  /** `seq` → verdict, from the score tree. Present overrides a marker's type colour. */
  verdicts?: ReadonlyMap<number, "pass" | "fail">;
  scrubT: number;
  onScrub: (t_ms: number) => void;
}

interface MarkerSpec {
  shape: "circle" | "square" | "diamond" | "triangle" | "x" | "line";
  color: string;
  label: string;
}

/**
 * Marker shape identifies the event type; colour identifies the verdict (PRD §12.2
 * asks for "colour = verdict"). A marker that the score tree never cites keeps its
 * type colour, because a sensor update has no verdict — only a decision does.
 */
const SPEC: Record<string, MarkerSpec> = {
  cue_presented: { shape: "circle", color: "#3fb6d9", label: "First cue" },
  track_update: { shape: "circle", color: "#2a6f8c", label: "Track update" },
  contact_marked: { shape: "square", color: "#57ab7a", label: "Contact marked" },
  classification_submitted: { shape: "diamond", color: "#6b8fdd", label: "Classification" },
  report_sent: { shape: "triangle", color: "#a37fd4", label: "Report sent" },
  report_acked: { shape: "triangle", color: "#7a5fa8", label: "Report acked" },
  action_taken: { shape: "square", color: "#cdd6df", label: "Action" },
  authority_requested: { shape: "diamond", color: "#f0a832", label: "Authority requested" },
  authority_resolved: { shape: "diamond", color: "#ffb84d", label: "Authority resolved" },
  response_effect_resolved: { shape: "diamond", color: "#e5534b", label: "Response effect" },
  impact: { shape: "x", color: "#e5534b", label: "Impact" },
  track_lost: { shape: "triangle", color: "#6b7683", label: "Track lost" },
  track_reacquired: { shape: "triangle", color: "#8a97a5", label: "Track reacquired" },
  sensor_state_changed: { shape: "circle", color: "#4a5560", label: "Sensor change" },
  support_cue_shown: { shape: "circle", color: "#3fb6d9", label: "Support cue" },
  session_started: { shape: "line", color: "#57ab7a", label: "Start" },
  session_ended: { shape: "line", color: "#e5534b", label: "End" },
};

const VERDICT_COLOR: Record<"pass" | "fail", string> = {
  pass: "#57ab7a",
  fail: "#e5534b",
};

const LEGEND: readonly { color: string; label: string }[] = [
  { color: "#57ab7a", label: "Decision passed" },
  { color: "#e5534b", label: "Decision failed" },
  { color: "#3fb6d9", label: "Cue / sensor" },
  { color: "#f0a832", label: "Authority" },
  { color: "#6b7683", label: "Track status" },
  { color: "#a37fd4", label: "Report" },
];

/**
 * Decision timeline (PRD §12.2). Horizontal sim-time axis;
 * click anywhere to scrub the replay. Markers linked to
 * critical errors carry a red ring.
 */
export default function Timeline({
  events,
  duration_ms,
  criticalSeqs,
  verdicts,
  scrubT,
  onScrub,
}: TimelineProps) {
  const hostRef = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(900);
  const scrubRef = useRef(scrubT);
  scrubRef.current = scrubT;

  useEffect(() => {
    const host = hostRef.current;
    if (host === null) return;
    const ro = new ResizeObserver(() => setWidth(host.clientWidth));
    ro.observe(host);
    setWidth(host.clientWidth);
    return () => ro.disconnect();
  }, []);

  const height = 84;
  const pad = 12;
  const iw = width - pad * 2;
  const dur = Math.max(1, duration_ms);
  const xOf = (t: number) => pad + (t / dur) * iw;
  const tOf = (x: number) => Math.max(0, Math.min(dur, ((x - pad) / iw) * dur));

  const markers = useMemo(
    () =>
      events
        .filter((e) => SPEC[e.type] !== undefined)
        .map((e) => ({ ev: e, spec: SPEC[e.type] as MarkerSpec })),
    [events],
  );

  const onPointer = (e: React.PointerEvent<SVGSVGElement>) => {
    const rect = e.currentTarget.getBoundingClientRect();
    onScrub(tOf(e.clientX - rect.left));
  };

  return (
    <div ref={hostRef} className="timeline-wrap">
      <svg
        width="100%"
        height={height}
        onPointerDown={onPointer}
        style={{ cursor: "crosshair", touchAction: "none" }}
      >
        {/* axis */}
        <line x1={pad} x2={width - pad} y1={height - 18} y2={height - 18} stroke="#232c37" />
        {Array.from({ length: Math.min(10, Math.ceil(dur / 60000) + 1) }, (_, i) => {
          const t = (i / Math.min(10, Math.ceil(dur / 60000) + 1)) * dur;
          return (
            <g key={i}>
              <line x1={xOf(t)} x2={xOf(t)} y1={height - 24} y2={height - 14} stroke="#232c37" />
              <text x={xOf(t)} y={height - 2} fontSize={12} fill="#5a6a78" textAnchor="middle">
                {Math.round(t / 1000)}s
              </text>
            </g>
          );
        })}

        {/* start/end bookends */}
        <line x1={xOf(0)} x2={xOf(0)} y1={8} y2={height - 18} stroke="#57ab7a" strokeWidth={2} />
        <line x1={xOf(dur)} x2={xOf(dur)} y1={8} y2={height - 18} stroke="#e5534b" strokeWidth={2} />

        {markers.map(({ ev, spec }) => {
          const x = xOf(ev.t_ms);
          const y = 30 + (ev.seq % 3) * 12;
          const critical = criticalSeqs.has(ev.seq);
          const verdict = verdicts?.get(ev.seq);
          const color = verdict === undefined ? spec.color : VERDICT_COLOR[verdict];
          return (
            <g key={ev.seq} data-seq={ev.seq} transform={`translate(${x},${y})`}>
              {critical && (
                <circle r={8} fill="none" stroke="#e5534b" strokeWidth={1.5} />
              )}
              {spec.shape === "circle" && <circle r={3.5} fill={color} />}
              {spec.shape === "square" && <rect x={-3} y={-3} width={6} height={6} fill={color} />}
              {spec.shape === "diamond" && (
                <polygon points="0,-4 4,0 0,4 -4,0" fill={color} />
              )}
              {spec.shape === "triangle" && <polygon points="0,-4 4,3 -4,3" fill={color} />}
              {spec.shape === "x" && (
                <g stroke={color} strokeWidth={2}>
                  <line x1={-4} y1={-4} x2={4} y2={4} />
                  <line x1={4} y1={-4} x2={-4} y2={4} />
                </g>
              )}
              <title>
                {`${Math.round(ev.t_ms / 1000)}s — ${spec.label}${verdict === "pass" ? " (passed)" : verdict === "fail" ? " (failed)" : ""}${critical ? " · critical error" : ""}`}
              </title>
            </g>
          );
        })}

        {/* scrubber */}
        <line
          x1={xOf(scrubRef.current)}
          x2={xOf(scrubRef.current)}
          y1={6}
          y2={height - 18}
          stroke="#f0a832"
          strokeWidth={1.5}
        />
      </svg>
      <Legend items={LEGEND} />
      <div className="flex wrap small dim">
        <span>
          <b className="mono" style={{ color: "#f0a832" }}>
            {Math.round(scrubT / 1000)}s
          </b>{" "}
          of {Math.round(dur / 1000)}s
        </span>
        <span className="faint">click the timeline to scrub · ringed marker = critical error</span>
      </div>
    </div>
  );
}
