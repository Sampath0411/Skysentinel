import { useEffect, useMemo, useState } from "react";
import { useNavigate, useParams } from "react-router-dom";
import type { BriefSection } from "@skysentinel/scenario";
import { BRIEF_SECTIONS } from "@skysentinel/scenario";
import type { ClientScenario } from "../types.js";
import { api, sendAction, startSession } from "../api.js";
import { fmtClock } from "../format.js";

/**
 * Pre-mission brief (PRD §5.3 FR-DEC-6).
 *
 * The brief is read from the scenario's own data — mission,
 * protected assets with priority, friendly flight plan, sensor
 * status, posture and reporting instructions. Section opens are
 * logged as `brief_viewed` events before the session starts:
 * N4 and N9 score whether the brief was consulted, so this
 * screen is part of the assessment, not just decoration.
 */
export default function BriefScreen() {
  const { sessionId } = useParams<{ sessionId: string }>();
  const navigate = useNavigate();
  const [scenario, setScenario] = useState<ClientScenario | null>(null);
  const [opened, setOpened] = useState<Set<BriefSection>>(new Set());
  const [error, setError] = useState("");
  const [starting, setStarting] = useState(false);

  const id = sessionId ?? "";

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        // The brief content lives on the scenario; the session row
        // tells us which scenario this session runs.
        const row = await api<{ session: { scenario_id: string } }>(`/api/sessions/${id}`);
        const sc = await api<{ scenario: ClientScenario }>(
          `/api/scenarios/${row.session.scenario_id}`,
        );
        if (!cancelled) setScenario(sc.scenario);
      } catch (e) {
        if (!cancelled) setError(e instanceof Error ? e.message : "Could not load the brief.");
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [id]);

  const toggle = (section: BriefSection) => {
    setOpened((prev) => {
      const next = new Set(prev);
      if (next.has(section)) next.delete(section);
      else next.add(section);
      return next;
    });
  };

  const start = async () => {
    setStarting(true);
    try {
      // Log the consultation before the clock starts.
      if (opened.size > 0) {
        await sendAction(id, "view_brief", { sections: [...opened] });
      }
      await startSession(id);
      navigate(`/trainee/${id}`);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not start the session.");
      setStarting(false);
    }
  };

  const sections = useMemo(() => scenario?.brief_sections ?? [...BRIEF_SECTIONS], [scenario]);

  if (error !== "" && scenario === null) {
    return (
      <div className="panel">
        <h2>Brief unavailable</h2>
        <p className="dim">{error}</p>
        <button onClick={() => navigate("/")}>Back</button>
      </div>
    );
  }
  if (scenario === null) return <p className="dim">Loading brief…</p>;

  const env = scenario.environment;
  const authority = scenario.authority;
  const grant = authority.grant_rule;

  return (
    <div style={{ maxWidth: 900 }}>
      <h1>{scenario.title}</h1>
      <p className="dim">
        <span className={`chip d${scenario.difficulty ?? 1}`}>D{scenario.difficulty ?? "?"}</span>{" "}
        <span className="chip">{scenario.id}</span>{" "}
        <span className="chip">{fmtClock(scenario.duration_s * 1000)}</span>{" "}
        <span className="chip">
          {env.terrain} · {env.time_of_day} · {env.weather} · wind {env.wind_mps} m/s
        </span>
      </p>
      {scenario.description !== null && <p>{scenario.description}</p>}

      <div className="tabs">
        {sections.map((s) => (
          <button key={s} className={opened.has(s) ? "active" : ""} onClick={() => toggle(s)}>
            {s.replace("_", " ")}
          </button>
        ))}
      </div>

      <div className="panel">
        {sections.includes("situation") && opened.has("situation") && (
          <SectionSituation scenario={scenario} />
        )}
        {sections.includes("assets") && opened.has("assets") && <SectionAssets scenario={scenario} />}
        {sections.includes("friendly_flights") && opened.has("friendly_flights") && (
          <SectionFlights scenario={scenario} />
        )}
        {sections.includes("authority") && opened.has("authority") && (
          <SectionAuthority scenario={scenario} grant={grant} posture={authority.initial_posture} />
        )}
        {sections.includes("objectives") && opened.has("objectives") && (
          <SectionObjectives scenario={scenario} />
        )}
        {opened.size === 0 && (
          <p className="dim">
            Open a section above to read the brief. Consultation is logged and scored — read what
            you will rely on.
          </p>
        )}
      </div>

      <div className="flex mt">
        <button className="primary" onClick={() => void start()} disabled={starting}>
          {starting ? "Starting…" : "Acknowledge brief & start mission"}
        </button>
        <span className="dim small">The clock does not pause for trainees once the mission starts (FR-DEC-7).</span>
      </div>
    </div>
  );
}

const SectionSituation = ({ scenario }: { scenario: ClientScenario }) => (
  <div>
    <h3>Situation</h3>
    <p>{scenario.description ?? "No situation narrative authored."}</p>
    <p className="small dim">
      Environment: {scenario.environment.terrain} terrain, {scenario.environment.time_of_day},{" "}
      {scenario.environment.weather === "clear" ? "clear skies" : scenario.environment.weather},
      wind {scenario.environment.wind_mps} m/s. Mission length {scenario.duration_s} s.
    </p>
    <p className="small dim">
      You are the operator at the observer post. Sensor health is shown in the top bar. The clock
      never pauses.
    </p>
  </div>
);

const SectionAssets = ({ scenario }: { scenario: ClientScenario }) => (
  <div>
    <h3>Protected assets (priority order)</h3>
    <table className="data">
      <thead>
        <tr>
          <th>Asset</th>
          <th>Type</th>
          <th>Priority</th>
          <th>Position (m, ENU)</th>
        </tr>
      </thead>
      <tbody>
        {[...scenario.assets]
          .sort((a, b) => a.priority - b.priority)
          .map((a) => (
            <tr key={a.id}>
              <td>{a.name}</td>
              <td>{a.type}</td>
              <td className="mono">{a.priority}</td>
              <td className="mono">
                {a.pos[0]!.toFixed(0)}, {a.pos[1]!.toFixed(0)}
              </td>
            </tr>
          ))}
      </tbody>
    </table>
  </div>
);

const SectionFlights = ({ scenario }: { scenario: ClientScenario }) => (
  <div>
    <h3>Friendly flight plan</h3>
    {scenario.friendly_flights.length === 0 ? (
      <p className="dim">No friendly flights scheduled.</p>
    ) : (
      <table className="data">
        <thead>
          <tr>
            <th>Flight</th>
            <th>Window (s)</th>
            <th>Info state</th>
            <th>Route</th>
          </tr>
        </thead>
        <tbody>
          {scenario.friendly_flights.map((f) => (
            <tr key={f.id}>
              <td>{f.label}</td>
              <td className="mono">
                {f.window_s[0]}–{f.window_s[1]}
              </td>
              <td>
                <span className={`chip ${f.info_state === "current" ? "d1" : "d3"}`}>
                  {f.info_state}
                </span>
              </td>
              <td className="mono small">
                {f.route.map((p) => `(${p[0]!.toFixed(0)},${p[1]!.toFixed(0)})`).join(" → ")}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    )}
    <p className="small dim">
      A flight on the plan that matches a track is the strongest deconfliction signal you have.
      {scenario.friendly_flights.some((f) => f.info_state !== "current")
        ? " Note: some flight data is not current — verify before relying on it."
        : ""}
    </p>
  </div>
);

const SectionAuthority = ({
  scenario,
  grant,
  posture,
}: {
  scenario: ClientScenario;
  grant: { min_category: string; min_confidence: string; min_sources: number; delay_s: [number, number] };
  posture: string;
}) => (
  <div>
    <h3>Authority & posture</h3>
    <p>
      Initial posture: <span className="chip">{posture}</span> (training abstraction, not a
      Service term).
    </p>
    <p className="small dim">
      Response authority is granted when a track is classified at least <b>{grant.min_category}</b>{" "}
      with <b>{grant.min_confidence}</b> confidence and at least <b>{grant.min_sources}</b>{" "}
      corroborating sensor sources. Simulated delay {grant.delay_s[0]}–{grant.delay_s[1]} s.
    </p>
    <p className="small dim">
      Simulated response assets:{" "}
      {scenario.authority.response_assets.available ? "available" : "unavailable"} (simulated
      delay {scenario.authority.response_assets.delay_s} s). You may only execute a response on a
      track after authority is granted for it.
    </p>
  </div>
);

const SectionObjectives = ({ scenario }: { scenario: ClientScenario }) => (
  <div>
    <h3>Learning objectives</h3>
    <ul>
      {scenario.learning_objectives.map((o) => (
        <li key={o}>{o.replace(/_/g, " ")}</li>
      ))}
    </ul>
    <h3 className="mt">Reporting instructions</h3>
    <p className="small dim">
      Reports are structured: quantity, activity, position (map click or bearing/range), time is
      automatic, description/equipment, confidence. Send updates when the picture materially
      changes.
    </p>
    <h3 className="mt">Hotkeys</h3>
    <p className="small dim">
      <span className="kbd">Space</span> mark contact at selection · <span className="kbd">1–6</span>{" "}
      classification · <span className="kbd">R</span> report · <span className="kbd">W</span> warn ·{" "}
      <span className="kbd">P</span> protective drill · <span className="kbd">A</span> request
      authority · <span className="kbd">Tab</span> cycle tracks
    </p>
  </div>
);
