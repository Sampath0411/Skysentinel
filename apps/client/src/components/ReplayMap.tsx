import { useEffect, useRef } from "react";
import type { AnySimEvent } from "@skysentinel/shared";
import type { ClientScenario, TruthEntityView } from "../types.js";

interface ReplayMapProps {
  scenario: ClientScenario;
  events: readonly AnySimEvent[];
  /** Ground truth (staff only, and only while the session is in memory). */
  truth: readonly TruthEntityView[];
  scrubT: number;
  showTruth: boolean;
}

interface Sample {
  t: number;
  x: number;
  y: number;
}

/** Last sample at or before `t`, or null. */
const at = (hist: readonly Sample[], t: number): Sample | null => {
  let found: Sample | null = null;
  for (const s of hist) {
    if (s.t > t) break;
    found = s;
  }
  return found;
};

/**
 * AAR map replay (PRD §12.3).
 *
 * Truth positions come from `entity_state` events
 * (1 Hz samples); the trainee's picture comes from
 * `track_update` pos_est samples. Both are stepped to
 * the scrub time, so the replay shows exactly what
 * was knowable when.
 */
export default function ReplayMap({
  scenario,
  events,
  truth,
  scrubT,
  showTruth,
}: ReplayMapProps) {
  const hostRef = useRef<HTMLDivElement>(null);
  const propsRef = useRef({ scenario, scrubT, showTruth });
  propsRef.current = { scenario, scrubT, showTruth };

  const histories = useMemoHistories(events, truth);

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

      const { scenario: sc, scrubT: t, showTruth: truthOn } = propsRef.current;
      const obs = sc.observer_post.pos;
      const ox = obs[0] ?? 0;
      const oy = obs[1] ?? 0;

      let extent = 700;
      for (const a of sc.assets) {
        extent = Math.max(extent, Math.hypot((a.pos[0] ?? 0) - ox, (a.pos[1] ?? 0) - oy) * 1.25);
      }
      for (const f of sc.friendly_flights) {
        for (const p of f.route) {
          extent = Math.max(extent, Math.hypot((p[0] ?? 0) - ox, (p[1] ?? 0) - oy) * 1.15);
        }
      }
      for (const hist of histories.truth.values()) {
        for (const s of hist) extent = Math.max(extent, Math.hypot(s.x - ox, s.y - oy) * 1.2);
      }
      for (const hist of histories.known.values()) {
        for (const s of hist) extent = Math.max(extent, Math.hypot(s.x - ox, s.y - oy) * 1.2);
      }

      const scale = Math.min(w, h) / 2 / extent;
      const cx = w / 2;
      const cy = h / 2;
      const toXY = (x: number, y: number): [number, number] => [
        cx + (x - ox) * scale,
        cy - (y - oy) * scale,
      ];

      ctx.fillStyle = "#0d1218";
      ctx.fillRect(0, 0, w, h);

      // Grid
      ctx.strokeStyle = "#1a222b";
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

      // Flight plans + assets
      for (const f of sc.friendly_flights) {
        ctx.strokeStyle = "#2f5f43";
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
      }
      for (const a of sc.assets) {
        const [x, y] = toXY(a.pos[0] ?? 0, a.pos[1] ?? 0);
        ctx.fillStyle = "#f0a832";
        ctx.fillRect(x - 5, y - 5, 10, 10);
        ctx.font = " 12px monospace";
        ctx.fillText(`P${a.priority} ${a.name}`, x + 10, y + 3);
      }

      // Ground truth at T (staff only)
      if (truthOn) {
        for (const e of truth) {
          const hist = histories.truth.get(e.id);
          const s = hist === undefined ? null : at(hist, t);
          if (s === null) continue;
          const [x, y] = toXY(s.x, s.y);
          const color =
            e.affiliation_truth === "hostile"
              ? "#e5534b"
              : e.affiliation_truth === "friendly" || e.affiliation_truth === "authorised"
                ? "#57ab7a"
                : "#6b7683";
          ctx.fillStyle = color;
          ctx.strokeStyle = color;
          if (e.neutralised) {
            ctx.beginPath();
            ctx.moveTo(x - 6, y - 6);
            ctx.lineTo(x + 6, y + 6);
            ctx.moveTo(x + 6, y - 6);
            ctx.lineTo(x - 6, y + 6);
            ctx.stroke();
          } else if (e.kind === "bird") {
            ctx.beginPath();
            ctx.arc(x, y, 3, 0, Math.PI * 2);
            ctx.stroke();
          } else {
            ctx.beginPath();
            ctx.moveTo(x, y - 6);
            ctx.lineTo(x + 6, y);
            ctx.lineTo(x, y + 6);
            ctx.lineTo(x - 6, y);
            ctx.closePath();
            ctx.fill();
          }
          ctx.font = " 12px monospace";
          ctx.fillText(e.id, x + 8, y - 4);
        }
      }

      // Trainee-known tracks at T
      for (const [trackId, hist] of histories.known.entries()) {
        const s = at(hist, t);
        if (s === null) continue;
        const [x, y] = toXY(s.x, s.y);
        ctx.strokeStyle = "#3fb6d9";
        ctx.lineWidth = 1.5;
        ctx.beginPath();
        ctx.moveTo(x, y - 5);
        ctx.lineTo(x + 5, y);
        ctx.lineTo(x, y + 5);
        ctx.lineTo(x - 5, y);
        ctx.closePath();
        ctx.stroke();
        ctx.lineWidth = 1;
        ctx.fillStyle = "#3fb6d9";
        ctx.font = " 12px monospace";
        ctx.fillText(trackId, x - 14, y + 16);
      }

      // Observer
      const [px, py] = toXY(ox, oy);
      ctx.fillStyle = "#3fb6d9";
      ctx.beginPath();
      ctx.arc(px, py, 4, 0, Math.PI * 2);
      ctx.fill();
      ctx.fillStyle = "#cdd6df";
      ctx.font = " 12px monospace";
      ctx.fillText("OBS", px + 7, py + 3);
    };
    draw();

    return () => {
      cancelAnimationFrame(raf);
      ro.disconnect();
      host.removeChild(canvas);
    };
  }, [histories, truth]);

  return <div ref={hostRef} style={{ position: "absolute", inset: 0 }} />;
}

/** Build position histories from the event log. Pure. */
const useMemoHistories = (
  events: readonly AnySimEvent[],
  truth: readonly TruthEntityView[],
): { truth: Map<string, Sample[]>; known: Map<string, Sample[]> } => {
  const truthHist = new Map<string, Sample[]>();
  const knownHist = new Map<string, Sample[]>();

  // Seed truth histories with the live snapshot (latest known position),
  // then let entity_state events fill the timeline.
  for (const e of truth) {
    truthHist.set(e.id, []);
  }
  for (const ev of events) {
    if (ev.type === "entity_state") {
      const p = ev.payload;
      const list = truthHist.get(p.id) ?? [];
      list.push({ t: ev.t_ms, x: p.pos[0] ?? 0, y: p.pos[1] ?? 0 });
      truthHist.set(p.id, list);
    } else if (ev.type === "track_update") {
      const p = ev.payload;
      const list = knownHist.get(p.track_id) ?? [];
      list.push({ t: ev.t_ms, x: p.pos_est[0] ?? 0, y: p.pos_est[1] ?? 0 });
      knownHist.set(p.track_id, list);
    }
  }
  return { truth: truthHist, known: knownHist };
};
