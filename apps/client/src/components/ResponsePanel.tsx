import type { FusedTrack } from "@skysentinel/sim-core";
import type { ClassificationState } from "../types.js";
import type { ResponseAction } from "@skysentinel/shared";

interface ResponsePanelProps {
  track: FusedTrack | null;
  classification: ClassificationState | undefined;
  authority: { posture: string; granted: readonly string[]; pending: readonly string[] } | null;
  onAct: (action: ResponseAction) => void;
  onRequestAuthority: () => void;
  onReclassify: () => void;
}

/**
 * Response actions and authority status (PRD §5.3 FR-DEC-4/5).
 *
 * The allowed set follows the trainee's own declared classification
 * band (unknown → observe/report; suspicious → warn/protect/request;
 * hostile → execute, only after authority). The server re-validates
 * everything — these buttons are convenience, not permission.
 */
export default function ResponsePanel({
  track,
  classification,
  authority,
  onAct,
  onRequestAuthority,
  onReclassify,
}: ResponsePanelProps) {
  const band = classification?.category ?? "unknown";
  const trackId = track?.track_id ?? null;
  const hasAuthority = trackId !== null && (authority?.granted.includes(trackId) ?? false);
  const isPending = trackId !== null && (authority?.pending.includes(trackId) ?? false);

  const basic: ResponseAction[] = ["continue_observe", "request_sensor_cue", "assign_track_owner", "handover"];
  const suspicious: ResponseAction[] = ["issue_warning", "activate_protective_drill", "request_support"];

  const canWarn = band === "suspicious" || band === "hostile";
  const canExecute = band === "hostile";

  const label: Record<ResponseAction, string> = {
    continue_observe: "Continue observing",
    request_sensor_cue: "Request sensor cue",
    report: "Report",
    assign_track_owner: "Assign track owner",
    handover: "Handover",
    issue_warning: "Issue warning (W)",
    activate_protective_drill: "Protective drill (P)",
    request_support: "Request support",
    request_response_authority: "Request authority (A)",
    execute_response: "Execute response",
    stand_down: "Stand down",
    reclassify: "Reclassify",
  };

  return (
    <div className="mt">
      <h3>Response</h3>
      <div className="flex wrap mb">
        <span className="chip">posture {authority?.posture ?? "—"}</span>
        {authority !== null && authority.granted.length > 0 && (
          <span className="chip d1">authority: {authority.granted.join(", ")}</span>
        )}
        {isPending && <span className="chip d3">authority pending…</span>}
      </div>

      {track === null ? (
        <p className="dim small">Select a track to act on it.</p>
      ) : (
        <div className="flex wrap">
          {basic.map((a) => (
            <button key={a} className="small" onClick={() => onAct(a)} title={a}>
              {label[a]}
            </button>
          ))}
          {canWarn &&
            suspicious.map((a) => (
              <button key={a} className="small warn" onClick={() => onAct(a)} title={a}>
                {label[a]}
              </button>
            ))}
          <button
            className="small"
            onClick={onRequestAuthority}
            disabled={isPending || hasAuthority}
            title="Ask the authority chain for response authority on this track"
          >
            {label.request_response_authority}
          </button>
          {canExecute && (
            <button
              className="small danger"
              onClick={() => onAct("execute_response")}
              disabled={!hasAuthority}
              title={hasAuthority ? "Execute the simulated response on this track" : "Requires granted authority for this track"}
            >
              {label.execute_response}
            </button>
          )}
          <button className="small" onClick={() => onAct("stand_down")} title={label.stand_down}>
            {label.stand_down}
          </button>
          <button className="small ghost" onClick={onReclassify} title={label.reclassify}>
            {label.reclassify}
          </button>
        </div>
      )}
      <p className="small faint">
        A simulated response resolves by probability from track quality and asset availability
        (FR-SIM-8). Executing without authority is a critical error.
      </p>
    </div>
  );
}
