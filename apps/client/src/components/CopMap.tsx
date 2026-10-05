import { useEffect, useRef } from "react";
import type { FusedTrack } from "@skysentinel/sim-core";
import type { ClientScenario } from "../types.js";

interface CopMapProps {
  scenario: ClientScenario;
  tracks: readonly FusedTrack[];
  selectedTrack: string | null;
  reportLoc: { bearing_deg: number; range_m: number } | null;
  onPick: (loc: { bearing_deg: number; range_m: number }) => void;
  /**
   * Tracks to draw on this animation frame, interpolated between the last two
   * frames (see `interpolate.ts`). Optional, for the static replay case.
   */
  readTracks?: () => readonly FusedTrack[];
}

/**
 * Common Operating Picture (PRD §5.3 FR-DEC-3, §13.1).
 *
 * Top-down 2D: protected assets, friendly flight plans,
 * observer sectors, and fused tracks plotted from their
 * bearing/range relative to the observer post. Clicking
 * sets the report's position (bearing + range).
 */
export default function CopMap({
  scenario,
  tracks,
  selectedTrack,
  reportLoc,
  onPick,
  readTracks,
}: CopMapProps) {
  const hostRef = useRef<HTMLDivElement>(null);
  const propsRef = useRef({ scenario, tracks, selectedTrack, reportLoc, readTracks });
  propsRef.current = { scenario, tracks, selectedTrack, reportLoc, readTracks };

  /** The tracks to plot right now: interpolated when available, else the props. */
  const liveTracks = (): readonly FusedTrack[] => propsRef.current.readTracks?.() ?? propsRef.current.tracks;

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

      const { scenario: sc, selectedTrack: sel, reportLoc: loc } = propsRef.current;
      const trks = liveTracks();
      const obs = sc.observer_post.pos;
      const ox = obs[0] ?? 0;
      const oy = obs[1] ?? 0;

      // Extent: assets + flight routes + a fixed minimum
      let extent = 700;
      for (const a of sc.assets) {
        extent = Math.max(extent, Math.hypot((a.pos[0] ?? 0) - ox, (a.pos[1] ?? 0) - oy) * 1.25);
      }
      for (const f of sc.friendly_flights) {
        for (const p of f.route) {
          extent = Math.max(extent, Math.hypot((p[0] ?? 0) - ox, (p[1] ?? 0) - oy) * 1.15);
        }
      }
      for (const t of trks) {
        if (t.range_m !== undefined) extent = Math.max(extent, t.range_m * 1.15);
      }

      const scale = Math.min(w, h) / 2 / extent;
      const cx = w / 2;
      const cy = h / 2;
      const toXY = (x: number, y: number): [number, number] => [
        cx + (x - ox) * scale,
        cy - (y - oy) * scale,
      ];

      // Background
      ctx.fillStyle = "#0d1218";
      ctx.fillRect(0, 0, w, h);

      // Grid every 100 m
      ctx.strokeStyle = "#1a222b";
      ctx.lineWidth = 1;
      const step = 100 * scale;
      if (step > 14) {
        for (let gx = cx % step; gx < w; gx += step) {
          ctx.beginPath();
          ctx.moveTo(gx, 0);
          ctx.lineTo(gx, h);
          ctx.stroke();
        }
        for (let gy = cy % step; gy < h; gy += step) {
          ctx.beginPath();
          ctx.moveTo(0, gy);
          ctx.lineTo(w, gy);
          ctx.stroke();
        }
      }

      // Observer sectors
      for (const sector of sc.observer_post.sectors) {
        const from = ((sector.from_deg * Math.PI) / 180) * -1 + Math.PI / 2;
        const to = ((sector.to_deg * Math.PI) / 180) * -1 + Math.PI / 2;
        ctx.fillStyle = "rgba(63,182,217,0.07)";
        ctx.beginPath();
        ctx.moveTo(cx, cy);
        ctx.arc(cx, cy, scale * extent * 0.5, -to + Math.PI, -from + Math.PI, true);
        ctx.closePath();
        ctx.fill();
        ctx.fillStyle = "#3fb6d9";
        ctx.font = " 12px monospace";
        const mid = (sector.from_deg + sector.to_deg) / 2;
        const lx = cx + Math.sin(((mid - 90) * Math.PI) / 180) * scale * extent * 0.32;
        const ly = cy - Math.cos(((mid - 90) * Math.PI) / 180) * scale * extent * 0.32;
        ctx.fillText(sector.name, lx - 6, ly);
      }

      // Flight plans
      for (const f of sc.friendly_flights) {
        ctx.strokeStyle = "#57ab7a";
        ctx.lineWidth = 1.5;
        ctx.setLineDash([6, 4]);
        ctx.beginPath();
        f.route.forEach((p, i) => {
          const [x, y] = toXY(p[0] ?? 0, p[1] ?? 0);
          if (i === 0) ctx.moveTo(x, y);
          else ctx.lineTo(x, y);
        });
        ctx.stroke();
        ctx.setLineDash([]);
        const mid = f.route[Math.floor(f.route.length / 2)];
        if (mid !== undefined) {
          const [mx, my] = toXY(mid[0] ?? 0, mid[1] ?? 0);
          ctx.fillStyle = "#57ab7a";
          ctx.font = " 12px monospace";
          ctx.fillText(`${f.label} ${f.window_s[0]}–${f.window_s[1]}s`, mx + 6, my - 4);
        }
      }

      // Protected assets
      for (const a of sc.assets) {
        const [x, y] = toXY(a.pos[0] ?? 0, a.pos[1] ?? 0);
        ctx.fillStyle = "#f0a832";
        ctx.fillRect(x - 5, y - 5, 10, 10);
        ctx.strokeStyle = "#f0a832";
        ctx.strokeRect(x - 8, y - 8, 16, 16);
        ctx.font = " 12px monospace";
        ctx.fillText(`P${a.priority} ${a.name}`, x + 10, y + 3);
      }

      // Tracks from bearing/range relative to observer
      for (const t of trks) {
        if (t.range_m === undefined) continue;
        const rad = (t.bearing_deg * Math.PI) / 180;
        const wx = ox + t.range_m * Math.sin(rad);
        const wy = oy + t.range_m * Math.cos(rad);
        const [x, y] = toXY(wx, wy);
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
        ctx.beginPath();
        ctx.moveTo(x, y - 5);
        ctx.lineTo(x + 5, y);
        ctx.lineTo(x, y + 5);
        ctx.lineTo(x - 5, y);
        ctx.closePath();
        ctx.fill();
        if (t.track_id === sel) {
          ctx.strokeStyle = "#ffffff";
          ctx.lineWidth = 2;
          ctx.beginPath();
          ctx.arc(x, y, 10, 0, Math.PI * 2);
          ctx.stroke();
          ctx.lineWidth = 1;
        }
        ctx.font = " 12px monospace";
        ctx.fillText(t.track_id, x + 8, y - 5);
      }

      // Report location crosshair
      if (loc !== null) {
        const rad = (loc.bearing_deg * Math.PI) / 180;
        const wx = ox + loc.range_m * Math.sin(rad);
        const wy = oy + loc.range_m * Math.cos(rad);
        const [x, y] = toXY(wx, wy);
        ctx.strokeStyle = "#a37fd4";
        ctx.beginPath();
        ctx.moveTo(x - 8, y);
        ctx.lineTo(x + 8, y);
        ctx.moveTo(x, y - 8);
        ctx.lineTo(x, y + 8);
        ctx.stroke();
        ctx.font = " 12px monospace";
        ctx.fillText(`${loc.bearing_deg.toFixed(0)}° ${loc.range_m.toFixed(0)}m`, x + 10, y + 12);
      }

      // Observer post + north arrow
      const [px, py] = toXY(ox, oy);
      ctx.fillStyle = "#3fb6d9";
      ctx.beginPath();
      ctx.arc(px, py, 4, 0, Math.PI * 2);
      ctx.fill();
      ctx.strokeStyle = "#cdd6df";
      ctx.beginPath();
      ctx.moveTo(px, py - 12);
      ctx.lineTo(px, py - 26);
      ctx.moveTo(px - 4, py - 18);
      ctx.lineTo(px, py - 26);
      ctx.lineTo(px + 4, py - 18);
      ctx.stroke();
      ctx.font = " 12px monospace";
      ctx.fillText("N", px - 3, py - 30);
      ctx.fillText("OBS", px + 7, py + 3);
    };
    draw();

    const onClick = (e: MouseEvent) => {
      const rect = canvas.getBoundingClientRect();
      const { scenario: sc } = propsRef.current;
      const obs = sc.observer_post.pos;
      const ox = obs[0] ?? 0;
      const oy = obs[1] ?? 0;
      // Recompute the same transform the draw loop uses.
      const w = rect.width;
      const h = rect.height;
      let extent = 700;
      for (const a of sc.assets) {
        extent = Math.max(extent, Math.hypot((a.pos[0] ?? 0) - ox, (a.pos[1] ?? 0) - oy) * 1.25);
      }
      for (const f of sc.friendly_flights) {
        for (const p of f.route) {
          extent = Math.max(extent, Math.hypot((p[0] ?? 0) - ox, (p[1] ?? 0) - oy) * 1.15);
        }
      }
      for (const t of propsRef.current.tracks) {
        if (t.range_m !== undefined) extent = Math.max(extent, t.range_m * 1.15);
      }
      // Clicks use the props' tracks, not the interpolated set: a click is a
      // measurement, and it should resolve to the position the sim last reported
      // rather than to a half-frame between two reports.
      const scale = Math.min(w, h) / 2 / extent;
      const cx = w / 2;
      const cy = h / 2;
      const wx = ox + (e.clientX - rect.left - cx) / scale;
      const wy = oy - (e.clientY - rect.top - cy) / scale;
      const dx = wx - ox;
      const dy = wy - oy;
      const range = Math.hypot(dx, dy);
      let bearing = (Math.atan2(dx, dy) * 180) / Math.PI;
      if (bearing < 0) bearing += 360;
      onPick({ bearing_deg: Math.round(bearing * 10) / 10, range_m: Math.round(range) });
    };
    canvas.addEventListener("click", onClick);

    return () => {
      cancelAnimationFrame(raf);
      ro.disconnect();
      canvas.removeEventListener("click", onClick);
      host.removeChild(canvas);
    };
  }, [onPick]);

  return <div ref={hostRef} style={{ position: "absolute", inset: 0 }} />;
}
