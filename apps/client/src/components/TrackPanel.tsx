import type { FusedTrack } from "@skysentinel/sim-core";
import type { ClassificationLog } from "../types.js";
import { fmtConf, fmtRange, fmtSpeed } from "../format.js";

interface TrackPanelProps {
  tracks: readonly FusedTrack[];
  selectedTrack: string | null;
  onSelect: (trackId: string) => void;
  classifications: ClassificationLog;
  supportCues: Map<string, { text: string; p: number }>;
}

/** Track list with classification state and support cues (PRD §13.1). */
export default function TrackPanel({
  tracks,
  selectedTrack,
  onSelect,
  classifications,
  supportCues,
}: TrackPanelProps) {
  return (
    <div>
      <h3>Tracks ({tracks.length})</h3>
      <div className="track-list">
        {tracks.length === 0 && <p className="dim small">No tracks yet. Await a cue, then mark the contact.</p>}
        {tracks.map((t) => {
          const cls = classifications.latest.get(t.track_id);
          const cue = supportCues.get(t.track_id);
          return (
            <div
              key={t.track_id}
              className={`track-item ${t.track_id === selectedTrack ? "selected" : ""}`}
              onClick={() => onSelect(t.track_id)}
            >
              <div className="row1">
                <span>
                  {t.track_id}{" "}
                  <span className={`track-status ${t.status}`}>{t.status}</span>
                </span>
                <span>{fmtConf(t.confidence)}</span>
              </div>
              <div className="row2">
                <span>{t.sources.join("+")}</span>
                <span>{fmtRange(t.range_m)}</span>
                <span>{fmtSpeed(t.speed_mps)}</span>
                <span>{t.bearing_deg.toFixed(0)}°</span>
              </div>
              <div className="row2">
                {cls !== undefined ? (
                  <span className={`cat-${cls.category}`}>
                    {cls.category}/{cls.confidence}
                    {cls.platform !== undefined ? ` · ${cls.platform}` : ""}
                  </span>
                ) : (
                  <span className="faint">unclassified</span>
                )}
              </div>
              {cue !== undefined && (
                <div className="row2">
                  <span className="cat-suspicious" title="Decision-support cue (FR-SEN-8)">
                    cue: {cue.text} p={cue.p.toFixed(2)}
                  </span>
                </div>
              )}
              <div className="conf-bar">
                <div style={{ width: `${Math.round(t.confidence * 100)}%` }} />
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
