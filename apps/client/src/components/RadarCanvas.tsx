import { useEffect, useRef } from "react";
import type { FusedTrack } from "@skysentinel/sim-core";
import type { AnySimEvent, SensorMode } from "@skysentinel/shared";

interface RadarCanvasProps {
  tracks: readonly FusedTrack[];
  /** Radar-sensor observations only (incl. false tracks). */
  observations: readonly AnySimEvent[];
  t_ms: number;
  mode: SensorMode;
  /**
   * Tracks to draw on this animation frame, interpolated between the last two
   * frames (see `interpolate.ts`). Optional so the component still works when
   * driven from a static snapshot — the AAR replay — where there is no stream.
   */
  readTracks?: () => readonly FusedTrack[];
}

/**
 * Radar PPI (PRD §5.3 FR-SEN-3, §13.1).
 *
 * Sweep is cosmetic; the information is the track set and the
 * raw returns, both from the server's role-filtered stream.
 * False/clutter returns render dim so the trainee learns to
 * distrust uncorroborated singles.
 *
 * Track positions come from `readTracks` when the console supplies one, so the
 * sweep runs at the display's refresh rate and contacts slide rather than step.
 * Without it the props' own tracks are drawn, which is what a static replay wants.
 */
export default function RadarCanvas({ tracks, observations, t_ms, mode, readTracks }: RadarCanvasProps) {
  const hostRef = useRef<HTMLDivElement>(null);
  const sweepRef = useRef(0);
  const tracksRef = useRef(tracks);
  const obsRef = useRef(observations);
  const modeRef = useRef(mode);
  const tRef = useRef(t_ms);
  const readRef = useRef(readTracks);
  tracksRef.current = tracks;
  obsRef.current = observations;
  modeRef.current = mode;
  tRef.current = t_ms;
  readRef.current = readTracks;

  /** The tracks to plot right now: interpolated when available, else the props. */
  const liveTracks = (): readonly FusedTrack[] => readRef.current?.() ?? tracksRef.current;

  useEffect(() => {
    const host = hostRef.current;
    if (host === null) return;
    const canvas = document.createElement("canvas");
    host.appendChild(canvas);
    const ctx = canvas.getContext("2d");
    if (ctx === null) return;

    const ro = new ResizeObserver(() => {
      const dpr = Math.min(window.devicePixelRatio, 2);
      canvas.width = host.clientWidth * dpr;
      canvas.height = host.clientHeight * dpr;
    });
    ro.observe(host);

    let raf = 0;
    const draw = () => {
      raf = requestAnimationFrame(draw);
      const dpr = Math.min(window.devicePixelRatio, 2);
      const w = canvas.width / dpr;
      const h = canvas.height / dpr;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.clearRect(0, 0, w, h);

      const cx = w / 2;
      const cy = h / 2;
      const scale = Math.min(w, h) / 2 - 14;

      // Range scale: fit the furthest track, minimum 800 m
      const maxRange = Math.max(
        800,
        ...liveTracks().map((t) => t.range_m ?? 0),
        ...obsRef.current.map((o) => (o.type === "sensor_observation" ? (o.payload.range_m ?? 0) : 0)),
      ) * 1.15;

      const toXY = (bearingDeg: number, rangeM: number): [number, number] => {
        const rad = (bearingDeg * Math.PI) / 180;
        const r = (rangeM / maxRange) * scale;
        return [cx + r * Math.sin(rad), cy - r * Math.cos(rad)];
      };

      // Background rings
      ctx.strokeStyle = "#232c37";
      ctx.lineWidth = 1;
      for (const f of [0.25, 0.5, 0.75, 1]) {
        ctx.beginPath();
        ctx.arc(cx, cy, scale * f, 0, Math.PI * 2);
        ctx.stroke();
      }
      ctx.beginPath();
      ctx.moveTo(cx, cy - scale);
      ctx.lineTo(cx, cy + scale);
      ctx.moveTo(cx - scale, cy);
      ctx.lineTo(cx + scale, cy);
      ctx.stroke();

      // Range labels
      ctx.fillStyle = "#5a6a78";
      ctx.font = " 12px monospace";
      for (const f of [0.5, 1]) {
        ctx.fillText(`${Math.round((maxRange * f) / 100) / 10}km`, cx + 4, cy - scale * f + 10);
      }

      // Sweep (cosmetic)
      sweepRef.current = (sweepRef.current + 0.02) % (Math.PI * 2);
      const grad = ctx.createConicGradient
        ? ctx.createConicGradient(sweepRef.current, cx, cy)
        : null;
      if (grad !== null) {
        grad.addColorStop(0, "rgba(63,182,217,0.25)");
        grad.addColorStop(0.08, "rgba(63,182,217,0.06)");
        grad.addColorStop(0.2, "rgba(63,182,217,0)");
        grad.addColorStop(1, "rgba(63,182,217,0)");
        ctx.fillStyle = grad;
        ctx.beginPath();
        ctx.moveTo(cx, cy);
        ctx.arc(cx, cy, scale, 0, Math.PI * 2);
        ctx.fill();
      }

      const failed = modeRef.current === "failed";
      const degraded = modeRef.current === "degraded";

      if (failed) {
        ctx.fillStyle = "#e5534b";
        ctx.font = "600 13px monospace";
        ctx.textAlign = "center";
        ctx.fillText("SENSOR OFFLINE", cx, cy);
        ctx.textAlign = "left";
        return;
      }

      // Raw returns (dim; clutter included)
      const recent = obsRef.current.slice(-240);
      for (const ev of recent) {
        if (ev.type !== "sensor_observation") continue;
        const p = ev.payload;
        const [x, y] = toXY(p.bearing_deg, p.range_m ?? 0);
        ctx.fillStyle = p.is_false ? "rgba(90,106,120,0.35)" : "rgba(63,182,217,0.4)";
        ctx.beginPath();
        ctx.arc(x, y, p.is_false ? 1.5 : 2, 0, Math.PI * 2);
        ctx.fill();
      }

      // Degraded mode: extra noise specks, deterministic in t
      if (degraded) {
        ctx.fillStyle = "rgba(240,168,50,0.25)";
        const n = 24;
        for (let i = 0; i < n; i++) {
          const a = (Math.sin(tRef.current / 900 + i * 2.399) + 1) * Math.PI;
          const r = ((Math.cos(tRef.current / 700 + i * 1.7) + 1) / 2) * scale;
          ctx.beginPath();
          ctx.arc(cx + r * Math.sin(a), cy - r * Math.cos(a), 1.2, 0, Math.PI * 2);
          ctx.fill();
        }
      }

      // Fused tracks
      for (const t of liveTracks()) {
        if (t.range_m === undefined) continue;
        const [x, y] = toXY(t.bearing_deg, t.range_m);
        const color =
          t.status === "lost"
            ? "#e5534b"
            : t.status === "confirmed"
              ? "#57ab7a"
              : t.status === "reacquired"
                ? "#f0a832"
                : "#3fb6d9";
        ctx.fillStyle = color;
        ctx.strokeStyle = color;
        // diamond
        ctx.beginPath();
        ctx.moveTo(x, y - 5);
        ctx.lineTo(x + 5, y);
        ctx.lineTo(x, y + 5);
        ctx.lineTo(x - 5, y);
        ctx.closePath();
        ctx.fill();
        if (t.status === "lost") {
          ctx.globalAlpha = 0.5;
          ctx.strokeRect(x - 7, y - 7, 14, 14);
          ctx.globalAlpha = 1;
        }
        ctx.font = " 12px monospace";
        ctx.fillText(t.track_id, x + 7, y - 4);
        // velocity tick
        if (t.speed_mps !== undefined) {
          const len = Math.min(18, 6 + t.speed_mps);
          const rad = (t.bearing_deg * Math.PI) / 180;
          ctx.beginPath();
          ctx.moveTo(x, y);
          ctx.lineTo(x + len * Math.sin(rad), y - len * Math.cos(rad));
          ctx.stroke();
        }
      }
    };
    draw();

    return () => {
      cancelAnimationFrame(raf);
      ro.disconnect();
      host.removeChild(canvas);
    };
  }, []);

  return <div ref={hostRef} style={{ position: "absolute", inset: 0 }} />;
}
