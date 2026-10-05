import { useEffect, useRef } from "react";
import type { ClientScenario, TruthEntityView } from "../types.js";
import { PositionSmoother, type Vec3 } from "../interpolate.js";

interface TruthMapProps {
  scenario: ClientScenario;
  truth: readonly TruthEntityView[];
  /** Track id → estimated position (what the trainee knows). */
  knownTracks: Map<string, [number, number, number]>;
}

const AFFILIATION_COLOR: Record<string, string> = {
  hostile: "#e5534b",
  friendly: "#57ab7a",
  authorised: "#57ab7a",
  non_uas: "#6b7683",
};

/**
 * Instructor truth map (PRD §13.2).
 *
 * Ground-truth entities (coloured by true affiliation, with
 * intent) under the trainee's fused-track estimates (cyan
 * diamonds). The gap between the two is the exercise.
 *
 * Both marker sets are eased between frames. That is not cosmetic here: an
 * instructor watching this view is judging how far the trainee's estimate has
 * drifted from the truth, and at 20 Hz the markers jump far enough between
 * frames that the drift reads as a flicker rather than as a growing separation.
 */
export default function TruthMap({ scenario, truth, knownTracks }: TruthMapProps) {
  const hostRef = useRef<HTMLDivElement>(null);
  const propsRef = useRef({ scenario, truth, knownTracks });
  propsRef.current = { scenario, truth, knownTracks };

  /**
   * Eased positions for both marker sets.
   *
   * Refilled once per wire frame (see below) and read on every animation frame,
   * which is what lets the markers glide: the draw loop is three times faster than
   * the data arrives, and reading the last interpolated position from each frame
   * fills the gap.
   */
  const smoothRef = useRef<{ truth: PositionSmoother; known: PositionSmoother }>({
    truth: new PositionSmoother(),
    known: new PositionSmoother(),
  });

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

      const { scenario: sc, truth: ents, knownTracks: known } = propsRef.current;
      const obs = sc.observer_post.pos;
      const ox = obs[0] ?? 0;
      const oy = obs[1] ?? 0;
      const now = performance.now();
      // Eased positions. An entity absent from the current frame is not drawn:
      // a neutralised contact should disappear, not coast onward on a stale fix.
      const at = (key: string): Vec3 | undefined => smoothRef.current.truth.position(key, now);
      const knownAt = (key: string): Vec3 | undefined => smoothRef.current.known.position(key, now);

      let extent = 700;
      for (const a of sc.assets) {
        extent = Math.max(extent, Math.hypot((a.pos[0] ?? 0) - ox, (a.pos[1] ?? 0) - oy) * 1.25);
      }
      for (const f of sc.friendly_flights) {
        for (const p of f.route) {
          extent = Math.max(extent, Math.hypot((p[0] ?? 0) - ox, (p[1] ?? 0) - oy) * 1.15);
        }
      }
      for (const e of ents) {
        extent = Math.max(extent, Math.hypot(e.pos[0] - ox, e.pos[1] - oy) * 1.2);
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

      // Flight plans
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

      // Assets
      for (const a of sc.assets) {
        const [x, y] = toXY(a.pos[0] ?? 0, a.pos[1] ?? 0);
        ctx.fillStyle = "#f0a832";
        ctx.fillRect(x - 5, y - 5, 10, 10);
        ctx.font = " 12px monospace";
        ctx.fillText(`P${a.priority} ${a.name}`, x + 10, y + 3);
      }

      // Swarm group links
      const groups = new Map<string, TruthEntityView[]>();
      for (const e of ents) {
        if (e.group_id === undefined) continue;
        const list = groups.get(e.group_id) ?? [];
        list.push(e);
        groups.set(e.group_id, list);
      }
      ctx.strokeStyle = "rgba(229,83,75,0.35)";
      for (const members of groups.values()) {
        for (let i = 1; i < members.length; i++) {
          const a = at(members[i - 1]!.id);
          const b = at(members[i]!.id);
          if (a === undefined || b === undefined) continue;
          const [x1, y1] = toXY(a[0], a[1]);
          const [x2, y2] = toXY(b[0], b[1]);
          ctx.beginPath();
          ctx.moveTo(x1, y1);
          ctx.lineTo(x2, y2);
          ctx.stroke();
        }
      }

      // Ground-truth entities
      for (const e of ents) {
        const pos = at(e.id);
        if (pos === undefined) continue;
        const [x, y] = toXY(pos[0], pos[1]);
        const color = AFFILIATION_COLOR[e.affiliation_truth ?? "non_uas"] ?? "#6b8fdd";
        ctx.fillStyle = color;
        ctx.strokeStyle = color;
        if (e.neutralised) {
          // struck through
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
        ctx.fillStyle = color;
        const tag = `${e.id}${e.role !== undefined ? ` (${e.role})` : ""}`;
        ctx.fillText(tag, x + 8, y - 4);
        if (e.intent !== null && e.intent !== "none") {
          ctx.fillStyle = "#8494a3";
          ctx.fillText(e.intent, x + 8, y + 8);
        }
      }

      // Trainee's known tracks (cyan diamonds)
      for (const trackId of known.keys()) {
        const pos = knownAt(trackId);
        if (pos === undefined) continue;
        const [x, y] = toXY(pos[0], pos[1]);
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
  }, []);

  // Stamp the smoothers on every new frame, before the draw loop reads them.
  useEffect(() => {
    const now = performance.now();
    const truthPos = new Map<string, Vec3>();
    for (const e of truth) truthPos.set(e.id, e.pos);
    smoothRef.current.truth.update(truthPos, now);
    // The two sets share one arrival instant so they stay in step — the whole
    // point of this view is the distance between them.
    const knownPos = new Map<string, Vec3>();
    for (const [k, v] of knownTracks) knownPos.set(k, v);
    smoothRef.current.known.update(knownPos, now);
  }, [truth, knownTracks]);

  return <div ref={hostRef} style={{ position: "absolute", inset: 0 }} />;
}
