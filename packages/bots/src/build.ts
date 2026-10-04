/**
 * Scenario → running session (PRD §6.3 `SessionRunner`).
 *
 * The one place a validated `Scenario` becomes a live simulation: terrain, world,
 * sensors, and the harness. `sim-core` cannot do this itself because a `Scenario`
 * is authored data in `@skysentinel/scenario`, which already depends on `sim-core`
 * — the dependency only points one way (DECISIONS.md D16).
 *
 * The adapter is deliberately thin. Everything it does is a mechanical
 * translation of authored fields into sim-core constructors; no rules live here.
 * A rule that appears in this file would be a rule the validator, the scorer and
 * the server would each have to know about.
 */

import {
  type Drone,
  type ProtectedAsset,
  createAsset,
  createBirdFlock,
  createDrone,
  createEnvironment,
  createSession,
  createTerrain,
  createWorld,
  observerAt,
  sToMs,
  type Session,
  type SessionSpec,
} from "@skysentinel/sim-core";
import type { Scenario } from "@skysentinel/scenario";
import { SENSOR_IDS } from "@skysentinel/shared";

/** Translate a scenario's authored authority block into a `GrantRule`. */
export const grantRuleOf = (s: Scenario): SessionSpec["grant_rule"] => ({
  min_category: s.authority.grant_rule.min_category,
  min_confidence: s.authority.grant_rule.min_confidence,
  min_sources: s.authority.grant_rule.min_sources,
  delay_s: s.authority.grant_rule.delay_s,
});

/**
 * Build a runnable session from a validated scenario.
 *
 * Entity truth fields (`affiliation_truth`, `role`, `group_id`) are copied across
 * because the simulation needs them to fly correctly. They stay inside the world;
 * the only thing that reaches a trainee-facing view is the harness's projection.
 */
export const buildSession = (scenario: Scenario): Session => {
  const terrain = createTerrain(scenario.environment.terrain, scenario.seed);
  const environment = createEnvironment(
    scenario.environment.time_of_day,
    scenario.environment.weather,
    scenario.environment.wind_mps,
    scenario.environment.terrain,
  );

  // Assets first, so their `spawned_seq` precedes every drone's and the emitter's
  // initial ordering is stable.
  const assets: ProtectedAsset[] = scenario.assets.map((a, i) =>
    createAsset({
      id: a.id,
      name: a.name,
      type: a.type,
      pos: { x: a.pos[0], y: a.pos[1], z: terrain.obstructionAt(a.pos[0], a.pos[1]) },
      priority: a.priority,
      impact_radius_m: a.impact_radius_m,
      spawned_seq: i,
    }),
  );

  const drones: Drone[] = [];
  scenario.entities.forEach((e, i) => {
    const programme = e.behaviour.map((b) => ({
      state: b.state,
      ...(b.to ? { to: { x: b.to[0], y: b.to[1], z: b.to[2] } } : {}),
      ...(b.speed !== undefined ? { speed: b.speed } : {}),
      ...(b.center ? { center: { x: b.center[0], y: b.center[1], z: b.center[2] } } : {}),
      ...(b.radius !== undefined ? { radius: b.radius } : {}),
      ...(b.duration_s !== undefined ? { duration_s: b.duration_s } : {}),
      ...(b.alt !== undefined ? { alt: b.alt } : {}),
    }));
    const spawn_t_ms = sToMs(e.spawn_t_s);
    const pos = { x: e.pos[0], y: e.pos[1], z: e.pos[2] };

    if (e.archetype === "bird_flock") {
      drones.push(
        createBirdFlock({
          id: e.id,
          pos,
          spawn_t_ms,
          speed_mps: 8,
          programme,
          count: e.count ?? 1,
          spawned_seq: assets.length + i,
        }) as unknown as Drone,
      );
      return;
    }

    drones.push(
      createDrone({
        id: e.id,
        archetype: e.archetype,
        affiliation_truth: e.affiliation_truth,
        intent: e.intent,
        pos,
        spawn_t_ms,
        speed_mps: programme[0]?.speed ?? 8,
        programme,
        rf_emitting: e.rf_emitting,
        spawned_seq: assets.length + i,
        ...(e.role !== undefined ? { role: e.role } : {}),
        ...(e.group_id !== undefined ? { group_id: e.group_id } : {}),
        ...(e.flight_ref !== undefined ? { flight_ref: e.flight_ref } : {}),
      }),
    );
  });

  const world = createWorld({
    scenario_id: scenario.id,
    seed: scenario.seed,
    duration_ms: sToMs(scenario.duration_s),
    terrain,
    environment,
    drones,
    assets,
  });

  // Every sensor key is present on `ScenarioSensors` (all five have defaults), so
  // the explicit loop is only there to keep the record's key type honest.
  const sensors = Object.fromEntries(
    SENSOR_IDS.map((id) => [id, scenario.sensors[id]]),
  ) as SessionSpec["sensors"];

  const spec: SessionSpec = {
    scenario_id: scenario.id,
    seed: scenario.seed,
    duration_s: scenario.duration_s,
    observer_pos: observerAt(terrain, scenario.observer_post.pos[0], scenario.observer_post.pos[1]),
    sensors,
    grant_rule: grantRuleOf(scenario),
    posture: scenario.authority.initial_posture,
    comms_delay_s: scenario.authority.response_assets.delay_s,
    brief_sections: scenario.brief_sections,
    injects: scenario.injects.map((i) => ({
      at_t_ms: sToMs(i.at_t_s),
      type: i.type,
      params: i.params as Record<string, unknown>,
    })),
  };

  return createSession({ spec, world });
};
