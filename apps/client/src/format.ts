/** Display formatting helpers. Sim time is integer milliseconds (PRD §7.2). */

/** `mm:ss` from sim milliseconds. */
export const fmtClock = (t_ms: number): string => {
  const s = Math.max(0, Math.floor(t_ms / 1000));
  const m = Math.floor(s / 60);
  return `${String(m).padStart(2, "0")}:${String(s % 60).padStart(2, "0")}`;
};

/** `mm:ss.s` — tighter clock for the top bar. */
export const fmtClockTenths = (t_ms: number): string => {
  // Integer tenths rather than `toFixed(1)` on the seconds: 59.96 s must render as
  // 00:59.9, and a rounding toFixed would print the impossible "00:60.0".
  const tenths = Math.max(0, Math.floor(t_ms / 100));
  const m = Math.floor(tenths / 600);
  const rem = tenths % 600;
  return `${String(m).padStart(2, "0")}:${(rem / 10).toFixed(1).padStart(4, "0")}`;
};

export const fmtDeg = (deg: number, digits = 0): string =>
  `${deg.toFixed(digits)}°`;

export const fmtRange = (m: number | undefined, digits = 0): string =>
  m === undefined ? "—" : `${m.toFixed(digits)} m`;

export const fmtSpeed = (mps: number | undefined): string =>
  mps === undefined ? "—" : `${mps.toFixed(1)} m/s`;

export const fmtConf = (c: number): string => `${Math.round(c * 100)}%`;

/** Bearing as a compass-ish label for radio logs. */
export const bearingLabel = (deg: number): string => {
  const dirs = ["N", "NE", "E", "SE", "S", "SW", "W", "NW"];
  const idx = Math.round((((deg % 360) + 360) % 360) / 45) % 8;
  return dirs[idx] ?? "N";
};

/** Short ISO time for AAR lists (wall clock, stored data only). */
export const fmtWall = (iso: string | null): string => {
  if (!iso) return "—";
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? "—" : d.toLocaleString();
};

export const fmtDuration = (ms: number | null): string => {
  if (ms === null) return "—";
  return fmtClock(ms);
};

/** One-line summary of a sim event, for radio logs and feeds. */
export const describeEvent = (ev: { type: string; t_ms: number; payload: Record<string, unknown> }): string => {
  const p = ev.payload;
  switch (ev.type) {
    case "session_started":
      return `Session started — ${String(p.scenario_id)} (seed ${String(p.seed)})`;
    case "session_ended":
      return `Session ended — ${String(p.end_reason)}`;
    case "brief_viewed":
      return `Brief consulted: ${(p.sections_viewed as string[])?.join(", ") ?? "all"}`;
    case "sensor_observation": {
      const obs = p as { sensor: string; bearing_deg: number; range_m?: number; conf: number; is_false: boolean; shape?: string };
      const range = obs.range_m !== undefined ? ` @ ${obs.range_m.toFixed(0)}m` : "";
      const falseTag = obs.is_false ? " [clutter]" : "";
      const shape = obs.shape ? ` (${obs.shape})` : "";
      return `${obs.sensor.toUpperCase()} return ${obs.bearing_deg.toFixed(0)}°${range} conf ${(obs.conf * 100).toFixed(0)}%${shape}${falseTag}`;
    }
    case "cue_presented": {
      const c = p as { cue_id: string; sensor: string };
      return `Cue ${c.cue_id} presented (${c.sensor})`;
    }
    case "track_update": {
      const t = p as { track_id: string; sources: string[]; conf: number; status: string };
      return `Track ${t.track_id} ${t.status} — ${t.sources.join("+")} conf ${(t.conf * 100).toFixed(0)}%`;
    }
    case "contact_marked":
      return `Contact marked: ${String(p.cue_or_track_id)}`;
    case "classification_submitted": {
      const c = p as { track_id: string; category: string; confidence: string; platform?: string; is_reclassification: boolean };
      const plat = c.platform ? `, ${c.platform}` : "";
      return `${c.is_reclassification ? "Re-classified" : "Classified"} ${c.track_id}: ${c.category}/${c.confidence}${plat}`;
    }
    case "report_sent":
      return `Report sent${p.delay_ms ? ` (radio delay ${(Number(p.delay_ms) / 1000).toFixed(0)}s)` : ""}`;
    case "report_acked":
      return `Report acknowledged by chain`;
    case "action_taken": {
      const a = p as { action: string; target_track_id?: string };
      return `Action: ${a.action}${a.target_track_id ? ` on ${a.target_track_id}` : ""}`;
    }
    case "authority_requested":
      return `Response authority requested: ${String(p.track_id)}`;
    case "authority_resolved": {
      const a = p as { track_id: string; granted: boolean; reason: string };
      return `Authority ${a.granted ? "GRANTED" : "denied"} for ${a.track_id} — ${a.reason}`;
    }
    case "response_effect_resolved": {
      const r = p as { track_id: string; outcome: string };
      return `Response on ${r.track_id}: ${r.outcome.toUpperCase()}`;
    }
    case "impact":
      return `Impact on asset ${String(p.asset_id)} — damage ${(Number(p.damage) * 100).toFixed(0)}%`;
    case "sensor_state_changed": {
      const s = p as { sensor: string; mode: string };
      return `Sensor ${s.sensor} → ${s.mode.toUpperCase()}`;
    }
    case "inject_applied":
      return `Inject: ${String(p.inject_type)}`;
    case "track_lost":
      return `Track ${String(p.track_id)} lost`;
    case "track_reacquired":
      return `Track ${String(p.track_id)} reacquired`;
    case "support_cue_shown": {
      const s = p as { track_id: string; text: string; p: number };
      return `Support cue ${s.track_id}: ${s.text} (p=${s.p.toFixed(2)})`;
    }
    default:
      return ev.type;
  }
};

/** Event category for radio-log colouring. */
export const eventClass = (type: string): string => {
  // Exact match first: `response_effect_resolved` is the outcome of a kinetic
  // response and colours critical, but the broader `response_effect` authority
  // check below would otherwise claim it.
  if (type === "response_effect_resolved") return "critical";
  if (type.includes("classif") || type.includes("contact") || type.includes("action")) return "decision";
  if (type.includes("report")) return "report";
  if (type.includes("authority") || type.includes("response_effect")) return "authority";
  if (type.includes("impact") || type.includes("fratricide")) return "critical";
  if (type.includes("sensor") || type.includes("track") || type.includes("cue") || type.includes("observation")) return "sensor";
  return "";
};
