import { useEffect, useRef, useState } from "react";
import type { FusedTrack } from "@skysentinel/sim-core";
import type { AnySimEvent } from "@skysentinel/shared";
import { fmtClock } from "../format.js";

interface ReportFormProps {
  tracks: readonly FusedTrack[];
  selectedTrack: string | null;
  reportLoc: { bearing_deg: number; range_m: number } | null;
  /** Bumped by the R hotkey; focuses the activity field. */
  focusSignal: number;
  events: readonly AnySimEvent[];
  onSubmit: (fields: Record<string, unknown>) => void;
}

/**
 * Structured report form (PRD §5.3 FR-DEC-3).
 *
 * Quantity, activity, position (map click or bearing/range),
 * time auto-stamped, description, confidence. Sent over the
 * simulated radio net with acknowledgement and delay.
 */
export default function ReportForm({
  tracks,
  selectedTrack,
  reportLoc,
  focusSignal,
  events,
  onSubmit,
}: ReportFormProps) {
  const [trackId, setTrackId] = useState("");
  const [quantity, setQuantity] = useState("");
  const [bearing, setBearing] = useState("");
  const [range, setRange] = useState("");
  const [activity, setActivity] = useState("");
  const [description, setDescription] = useState("");
  const [confidence, setConfidence] = useState("medium");
  const activityRef = useRef<HTMLInputElement>(null);
  const rootRef = useRef<HTMLDivElement>(null);

  // R hotkey focus. The form is below the fold in a scrolling panel, so the same
  // keystroke brings it up as well as putting the cursor in it — otherwise `R`
  // focuses a field the trainee cannot see.
  useEffect(() => {
    if (focusSignal > 0) {
      rootRef.current?.scrollIntoView({ block: "nearest" });
      activityRef.current?.focus();
    }
  }, [focusSignal]);

  // Track selection fills the position fields from the track estimate.
  useEffect(() => {
    if (selectedTrack === null) return;
    setTrackId(selectedTrack);
    const t = tracks.find((tr) => tr.track_id === selectedTrack);
    if (t === undefined) return;
    setBearing(t.bearing_deg.toFixed(0));
    if (t.range_m !== undefined) setRange(t.range_m.toFixed(0));
  }, [selectedTrack, tracks]);

  // Map click fills position
  useEffect(() => {
    if (reportLoc === null) return;
    setBearing(reportLoc.bearing_deg.toFixed(0));
    setRange(reportLoc.range_m.toFixed(0));
  }, [reportLoc]);

  const send = () => {
    const fields: Record<string, unknown> = { confidence };
    if (trackId !== "") fields.track_id = trackId;
    if (quantity !== "") fields.quantity = Number(quantity);
    if (bearing !== "") fields.bearing_deg = Number(bearing);
    if (range !== "") fields.range_m = Number(range);
    if (activity !== "") fields.activity = activity;
    if (description !== "") fields.description = description;
    if (fields.track_id === undefined && fields.activity === undefined && fields.description === undefined) {
      return; // server would reject: needs a track, activity or description
    }
    onSubmit(fields);
    setDescription("");
  };

  const acks = events.filter((e) => e.type === "report_acked").slice(-3);

  return (
    <div className="mt" ref={rootRef} id="report-form">
      <h3>Report (R)</h3>
      <div className="form-grid">
        <label>
          Track
          <select value={trackId} onChange={(e) => setTrackId(e.target.value)}>
            <option value="">— none —</option>
            {tracks.map((t) => (
              <option key={t.track_id} value={t.track_id}>
                {t.track_id}
              </option>
            ))}
          </select>
        </label>
        <label>
          Quantity
          <input value={quantity} onChange={(e) => setQuantity(e.target.value)} placeholder="1" inputMode="numeric" />
        </label>
        <label>
          Bearing °
          <input value={bearing} onChange={(e) => setBearing(e.target.value)} placeholder="from observer, 0=N" inputMode="decimal" />
        </label>
        <label>
          Range m
          <input value={range} onChange={(e) => setRange(e.target.value)} placeholder="metres" inputMode="decimal" />
        </label>
        <label className="full">
          Activity
          <input ref={activityRef} value={activity} onChange={(e) => setActivity(e.target.value)} placeholder="e.g. orbiting near fuel point" />
        </label>
        <label className="full">
          Description / equipment
          <input value={description} onChange={(e) => setDescription(e.target.value)} placeholder="e.g. multirotor, ~1 m, white" />
        </label>
        <label>
          Confidence
          <select value={confidence} onChange={(e) => setConfidence(e.target.value)}>
            <option value="low">low</option>
            <option value="medium">medium</option>
            <option value="high">high</option>
          </select>
        </label>
        <div className="flex" style={{ alignItems: "flex-end" }}>
          <button className="primary small" onClick={send}>
            Send report
          </button>
        </div>
      </div>
      {acks.length > 0 && (
        <p className="small faint">
          Last ack{" "}
          {acks.map((a) => (
            <span key={a.seq}>
              at {fmtClock(a.t_ms)} (+{((a.payload.delay_ms ?? 0) / 1000).toFixed(0)}s radio delay)
            </span>
          ))}
        </p>
      )}
    </div>
  );
}
