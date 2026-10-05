import type { ClientScenario } from "../types.js";
import type { Posture } from "@skysentinel/shared";
import { fmtClockTenths } from "../format.js";
import type { SensorMode } from "@skysentinel/shared";

interface TopBarProps {
  t_ms: number;
  scenario: ClientScenario | null;
  posture: Posture | null;
  sensorModes: Record<string, SensorMode>;
  /** How many decision-support cues the run has presented. */
  supportCueCount: number;
  /** Are the support cues currently displayed? (PRD §13.1 toggle.) */
  supportCuesShown: boolean;
  onToggleSupportCues: () => void;
  onEnd: () => void;
}

const SENSOR_LABELS: Record<string, string> = {
  visual: "EO",
  ir: "IR",
  radar: "RADAR",
  rf: "RF",
  flight_plan: "FLIGHT PLAN",
};

/** Top bar: clock, posture, sensor health, support-cue toggle, session end (PRD §13.1). */
export default function TopBar({
  t_ms,
  scenario,
  posture,
  sensorModes,
  supportCueCount,
  supportCuesShown,
  onToggleSupportCues,
  onEnd,
}: TopBarProps) {
  return (
    <div className="topbar">
      <span className="clock" title="Scenario clock — sim time, never pauses">
        {fmtClockTenths(t_ms)}
      </span>
      <span className="dim small">{scenario?.title ?? "…"}</span>
      {posture !== null && <span className="chip">posture {posture}</span>}
      <span className="flex" style={{ gap: 10 }}>
        {Object.entries(SENSOR_LABELS).map(([sensor, label]) => {
          const mode = sensorModes[sensor] ?? "normal";
          return (
            <span className={`sensor-light ${mode}`} key={sensor} title={`${sensor}: ${mode}`}>
              <span className="dot" />
              {label}
            </span>
          );
        })}
      </span>
      <span className="spacer" />
      {supportCueCount > 0 && (
        <button
          className={`small ${supportCuesShown ? "primary" : ""}`}
          onClick={onToggleSupportCues}
          title="Decision-support cues (PRD §13.1). Hidden by an assessment run regardless of this toggle."
        >
          {supportCuesShown ? "Hide" : "Show"} {supportCueCount} cue{supportCueCount === 1 ? "" : "s"}
        </button>
      )}
      <button className="small danger" onClick={onEnd}>
        End session
      </button>
    </div>
  );
}
