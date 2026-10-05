/**
 * Instructor inject menu (PRD §13.2, FR-SIM-9).
 *
 * The five injects the PRD lists, each with the handful of parameters its sim
 * effect actually reads. The parameter sets are driven off the same vocabularies
 * the server validates against (`SENSOR_IDS`, `WEATHER`, `POSTURES`), so the menu
 * cannot offer a value the route would reject — and a new inject type is a sim-core
 * change that shows up here as a config entry, not as new component code.
 *
 * Assessment runs disable the menu rather than letting the request fail: the
 * exercise is being graded as the trainee's own, and the server refuses the inject
 * anyway, but telling the instructor *why* up front is the difference between a
 * disabled control and one that looks broken.
 */

import { useState } from "react";

import { POSTURES, SENSOR_IDS, WEATHER } from "@skysentinel/shared";

import { injectSession } from "../api.js";

interface ParamSpec {
  readonly kind: "number" | "select";
  readonly label: string;
  readonly default: string;
  readonly min?: number;
  readonly step?: number;
  readonly options?: readonly string[];
}

interface InjectSpec {
  readonly label: string;
  readonly hint: string;
  readonly params: Record<string, ParamSpec>;
}

const INJECTS: Record<string, InjectSpec> = {
  sensor_outage: {
    label: "Sensor outage",
    hint: "Takes the sensor out of the suite; the trainee loses that picture.",
    params: { sensor: { kind: "select", label: "Sensor", default: "radar", options: SENSOR_IDS } },
  },
  weather_change: {
    label: "Weather change",
    hint: "Degrades visibility and IR penetration from the next observation.",
    params: { weather: { kind: "select", label: "Weather", default: "fog", options: WEATHER } },
  },
  comms_delay: {
    label: "Comms delay",
    hint: "Seconds a report takes to reach the chain, for reports sent after this.",
    params: { delay_s: { kind: "number", label: "Delay (s)", default: "20", min: 0, step: 1 } },
  },
  authority_change: {
    label: "Authority change",
    hint: "New response posture, visible to the trainee at once.",
    params: { posture: { kind: "select", label: "Posture", default: "FREE", options: POSTURES } },
  },
  new_track: {
    label: "New track",
    hint: "A new contact loitering at the bearing and range you name.",
    params: {
      bearing_deg: { kind: "number", label: "Bearing (°)", default: "0", min: 0, step: 1 },
      range_m: { kind: "number", label: "Range (m)", default: "800", min: 0, step: 100 },
    },
  },
};

interface InjectMenuProps {
  readonly sessionId: string;
  readonly mode: "assessment" | "training";
  readonly running: boolean;
}

export default function InjectMenu({ sessionId, mode, running }: InjectMenuProps) {
  // Flat keyed by `${type}.${param}` so one state object serves every form.
  const [values, setValues] = useState<Record<string, string>>(() => {
    const init: Record<string, string> = {};
    for (const [type, spec] of Object.entries(INJECTS)) {
      for (const [key, param] of Object.entries(spec.params)) init[`${type}.${key}`] = param.default;
    }
    return init;
  });
  const [busy, setBusy] = useState<string | null>(null);
  const [message, setMessage] = useState("");

  const disabled = mode === "assessment" || !running;

  const fire = async (type: string) => {
    setBusy(type);
    setMessage("");
    const params: Record<string, unknown> = {};
    for (const [key, spec] of Object.entries(INJECTS[type]!.params)) {
      const raw = values[`${type}.${key}`] ?? spec.default;
      params[key] = spec.kind === "number" ? Number(raw) : raw;
    }

    try {
      const res = await injectSession(sessionId, type, params);
      // `applied: false` is not an error — the inject is in the log — but the
      // instructor needs to know the world is unchanged.
      setMessage(res.applied ? `${INJECTS[type]!.label} applied.` : `${INJECTS[type]!.label} logged, no effect.`);
    } catch (e) {
      setMessage(e instanceof Error ? e.message : "Inject failed");
    } finally {
      setBusy(null);
    }
  };

  return (
    <div className="inject-menu">
      <div className="panel-head">
        <h3>Injects</h3>
        {mode === "assessment" && (
          <span className="dim small" title="An assessment run is graded as the trainee's own.">
            disabled in assessment
          </span>
        )}
      </div>
      {Object.entries(INJECTS).map(([type, spec]) => (
        <div key={type} className={`inject-row${disabled ? " disabled" : ""}`}>
          <div className="inject-fields">
            {Object.entries(spec.params).map(([key, param]) =>
              param.kind === "select" ? (
                <label key={key}>
                  <span>{param.label}</span>
                  <select
                    disabled={disabled}
                    value={values[`${type}.${key}`] ?? param.default}
                    onChange={(e) => setValues((v) => ({ ...v, [`${type}.${key}`]: e.target.value }))}
                  >
                    {param.options!.map((o) => (
                      <option key={o} value={o}>
                        {o}
                      </option>
                    ))}
                  </select>
                </label>
              ) : (
                <label key={key}>
                  <span>{param.label}</span>
                  <input
                    type="number"
                    disabled={disabled}
                    min={param.min}
                    step={param.step}
                    value={values[`${type}.${key}`] ?? param.default}
                    onChange={(e) => setValues((v) => ({ ...v, [`${type}.${key}`]: e.target.value }))}
                  />
                </label>
              ),
            )}
          </div>
          <p className="dim small inject-hint">{spec.hint}</p>
          <button
            className="small"
            disabled={disabled || busy !== null}
            onClick={() => void fire(type)}
            title={mode === "assessment" ? "Injects are disabled in assessment mode" : spec.label}
          >
            {busy === type ? "Firing…" : spec.label}
          </button>
        </div>
      ))}
      {message !== "" && <p className="small inject-message">{message}</p>}
    </div>
  );
}
