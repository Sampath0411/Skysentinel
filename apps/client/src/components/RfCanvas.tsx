import { useEffect, useRef } from "react";
import type { AnySimEvent, SensorMode } from "@skysentinel/shared";

interface RfCanvasProps {
  /** RF-sensor observations only. */
  observations: readonly AnySimEvent[];
  mode: SensorMode;
}

/**
 * RF direction-finding strip (PRD §5.3 FR-SEN-4, §13.1).
 *
 * Top: DOA strip — bearing markers whose height is signature
 * confidence. Bottom: waterfall of recent alerts. RF has no
 * range: the trainee must combine it with radar or EO to
 * localise, which is the skill being trained.
 */
export default function RfCanvas({ observations, mode }: RfCanvasProps) {
  const hostRef = useRef<HTMLDivElement>(null);
  const obsRef = useRef(observations);
  const modeRef = useRef(mode);
  obsRef.current = observations;
  modeRef.current = mode;

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

      if (modeRef.current === "failed") {
        ctx.fillStyle = "#e5534b";
        ctx.font = "600 13px monospace";
        ctx.textAlign = "center";
        ctx.fillText("SENSOR OFFLINE", w / 2, h / 2);
        ctx.textAlign = "left";
        return;
      }

      const stripH = Math.floor(h * 0.38);
      const waterH = h - stripH - 8;

      // --- DOA strip -------------------------------------------------
      ctx.strokeStyle = "#232c37";
      ctx.strokeRect(8, 4, w - 16, stripH - 8);
      ctx.fillStyle = "#5a6a78";
      ctx.font = " 12px monospace";
      for (let deg = 0; deg <= 360; deg += 30) {
        const x = 8 + ((w - 16) * deg) / 360;
        ctx.fillText(`${deg}°`, x - 8, stripH - 2);
        ctx.beginPath();
        ctx.moveTo(x, stripH - 14);
        ctx.lineTo(x, stripH - 8);
        ctx.stroke();
      }

      const recent = obsRef.current.slice(-60);
      for (const ev of recent) {
        if (ev.type !== "sensor_observation") continue;
        const p = ev.payload;
        const x = 8 + ((((p.bearing_deg % 360) + 360) % 360) / 360) * (w - 16);
        const conf = p.conf;
        const markerH = 6 + conf * (stripH - 30);
        const alpha = ev === recent[recent.length - 1] ? 1 : 0.35 + conf * 0.4;
        ctx.fillStyle = p.is_false
          ? `rgba(90,106,120,${alpha})`
          : `rgba(240,168,50,${alpha})`;
        // triangle marker
        ctx.beginPath();
        ctx.moveTo(x, stripH - 16 - markerH);
        ctx.lineTo(x - 4, stripH - 16);
        ctx.lineTo(x + 4, stripH - 16);
        ctx.closePath();
        ctx.fill();
        if (p.shape !== undefined && p.shape !== "") {
          ctx.fillStyle = `rgba(205,214,223,${alpha})`;
          ctx.font = " 12px monospace";
          ctx.fillText(p.shape, x - 10, stripH - 20 - markerH);
        }
      }

      // --- Waterfall ---------------------------------------------------
      const top = stripH + 8;
      ctx.strokeStyle = "#232c37";
      ctx.strokeRect(8, top, w - 16, waterH);
      const rows = Math.min(recent.length, Math.floor(waterH / 3));
      for (let i = 0; i < rows; i++) {
        const ev = recent[recent.length - rows + i];
        if (ev === undefined || ev.type !== "sensor_observation") continue;
        const p = ev.payload;
        const x = 8 + ((((p.bearing_deg % 360) + 360) % 360) / 360) * (w - 16);
        const intensity = p.is_false ? 0.15 : 0.25 + p.conf * 0.75;
        ctx.fillStyle = `rgba(240,168,50,${intensity})`;
        ctx.fillRect(x - 1, top + waterH - (i + 1) * 3, 2, 3);
      }
      if (recent.length === 0) {
        ctx.fillStyle = "#5a6a78";
        ctx.font = " 12px monospace";
        ctx.textAlign = "center";
        ctx.fillText("No RF emissions detected", w / 2, top + waterH / 2);
        ctx.textAlign = "left";
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
