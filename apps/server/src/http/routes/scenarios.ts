/**
 * Scenario catalogue routes (PRD §15).
 *
 * Deliberately read-only. A scenario is authored data validated by the validator and
 * stored on first use; nothing in the running system invents one, because a scenario
 * that appeared mid-session would not be reproducible and the trainer's claim is
 * that any run can be replayed exactly (FR-SIM-10).
 */

import type { FastifyInstance } from "fastify";

import { SCENARIO_SCHEMA_VERSION, SCRIPTED_SCENARIOS, fingerprint } from "@skysentinel/scenario";
import type { Scenario } from "@skysentinel/scenario";

import { listScenarios, findScenario } from "../../db/repo.js";
import type { Db } from "../../db/index.js";

const ALL_ROLES = ["trainee", "instructor", "admin"] as const;

/** The catalogue entry the scenario picker renders. */
const summarise = (s: Scenario) => ({
  id: s.id,
  kind: s.kind,
  title: s.title,
  description: s.description,
  family: s.family ?? null,
  difficulty: s.difficulty,
  seed: s.seed,
  duration_s: s.duration_s,
  fingerprint: fingerprint(s),
  learning_objectives: s.learning_objectives,
});

/**
 * Every scenario available to launch.
 *
 * The shipped scripted set is the source of truth and is always listed, whether or
 * not anyone has run it yet — the picker must not depend on the database having
 * been written to first. Generated scenarios come from the database, since there is
 * no shipped set of those.
 */
export const catalogue = (db: Db): Scenario[] => {
  const stored: Scenario[] = [];
  for (const row of listScenarios(db)) {
    if (row.kind !== "generated") continue;
    // A row we cannot parse is a row we must not offer. Skipping it keeps the picker
    // usable rather than failing the whole list on one bad row.
    try {
      stored.push(JSON.parse(row.spec_json) as Scenario);
    } catch {
      continue;
    }
  }
  return [...SCRIPTED_SCENARIOS, ...stored];
};

/** Find a scenario by id, or undefined. Used by the session-create route. */
export const resolveScenario = (db: Db, id: string): Scenario | undefined => {
  const shipped = SCRIPTED_SCENARIOS.find((s) => s.id === id);
  if (shipped) return shipped;

  const row = findScenario(db, id);
  if (!row) return undefined;
  try {
    return JSON.parse(row.spec_json) as Scenario;
  } catch {
    return undefined;
  }
};

export const scenarioRoutes = async (app: FastifyInstance) => {
  const db = app.db;

  app.get("/api/scenarios", { preHandler: app.requireRole(ALL_ROLES) }, async () => ({
    scenarios: catalogue(db).map(summarise),
  }));

  app.get("/api/scenarios/:id", { preHandler: app.requireRole(ALL_ROLES) }, async (request, reply) => {
    const { id } = request.params as { id: string };

    const found = resolveScenario(db, id);
    if (!found) return reply.code(404).send({ error: "not_found", message: "No such scenario." });

    // `expected` is ground truth: the answer key (PRD §5.4). Stripping it here
    // rather than relying on the client to ignore it means one less way to read it
    // out of devtools, and the leak test has one fewer surface to cover.
    const { expected: _answerKey, ...safe } = found;
    return { scenario: { ...safe, schema_version: SCENARIO_SCHEMA_VERSION } };
  });
};