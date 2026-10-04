/**
 * GENERATED FILE — do not edit.
 *
 * Source of truth: `data/rubrics/default-v1.json`
 * Regenerate: `node scripts/gen-data.mjs`
 *
 * Scoring weights, curves and thresholds are a training abstraction (PRD §10).
 * No LLM reads or writes any value in them. They are not calibrated against any real course and must not be
 * presented as an assessment standard.
 */

import { z } from "zod";

import { ClassificationCategorySchema, ResponseActionSchema } from "@skysentinel/shared";

/** The mandated and secondary competency dimensions (PRD §10.2). */
export const CompetencySchema = z.enum([
  "detection",
  "classification",
  "response",
  "reporting",
  "prioritisation",
  "coordination",
  "adaptation",
]);
export type Competency = z.infer<typeof CompetencySchema>;

/** One point on a piecewise-linear curve: x = normalised latency, y = points. */
export const CurvePointSchema = z.object({
  x: z.number().nonnegative(),
  y: z.number().min(0).max(100),
});

export const DetectionRulesSchema = z.object({
  curve: z.array(CurvePointSchema).min(2),
  latency_divisor_cap: z.number().positive(),
});

/**
 * rows = expected band (knowability at time t), cols = declared category.
 *
 * Every cell is required. A missing cell would silently become `undefined` and
 * score as zero at runtime, which reads as "the trainee was wrong" when it
 * actually means the rubric is incomplete.
 */
/**
 * rows = expected band (knowability at time t), cols = declared category.
 *
 * Exhaustiveness is enforced rather than assumed. `z.record(enum, value)` only
 * checks the keys that are *present*, so a dropped cell would parse cleanly and
 * then read as `undefined` at scoring time — which the AAR would present as "the
 * trainee was wrong" when it actually means the rubric is incomplete.
 */
export const ClassificationMatrixSchema = z
  .record(
    ClassificationCategorySchema,
    z.record(ClassificationCategorySchema, z.number().min(0).max(100)),
  )
  .superRefine((matrix, ctx) => {
    const bands = ClassificationCategorySchema.options;
    for (const band of bands) {
      const row = matrix[band];
      if (row === undefined) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: [band],
          message: `missing row for "${band}".`,
        });
        continue;
      }
      for (const col of bands) {
        if (row[col] === undefined) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: [band, col],
            message: `missing cell for declared "${col}" against band "${band}".`,
          });
        }
      }
    }
    for (const band of Object.keys(matrix)) {
      if (!(bands as string[]).includes(band)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: [band],
          message: `"${band}" is not a classification category.`,
        });
      }
    }
  });

export const ClassificationRulesSchema = z.object({
  matrix: ClassificationMatrixSchema,
  non_uas_for_real_threat: z.number().min(0).max(100),
  reclassify_toward_truth_bonus: z.number().min(0),
  reclassify_bonus_cap: z.number().min(0).max(100),
  confidence_policy: z.object({
    overconfidence_penalty: z.number().min(0),
    underconfidence_penalty: z.number().min(0),
    order: z.array(z.enum(["low", "medium", "high"])).length(3),
  }),
});

export const ReportingRulesSchema = z.object({
  field_presence_points: z.number().min(0).max(100),
  position_tolerance_points: z.number().min(0).max(100),
  bearing_tolerance_deg: z.number().positive(),
  range_tolerance_frac: z.number().min(0),
  range_tolerance_abs_m: z.number().min(0),
  quantity_points: z.number().min(0).max(100),
  activity_points: z.number().min(0).max(100),
  promptness_points: z.number().min(0).max(100),
  promptness_window_s: z.number().positive(),
  update_after_change_bonus: z.number().min(0),
});

/** Allowed actions per expected band. Cumulative: a band admits the weaker bands' actions. */
export const AllowedActionsSchema = z.record(
  ClassificationCategorySchema,
  z.array(ResponseActionSchema).min(1),
);

export const ResponseRulesSchema = z.object({
  allowed: AllowedActionsSchema,
  late_after_par: z.number().positive(),
  late_score_low: z.number().min(0).max(100),
  late_score_high: z.number().min(0).max(100),
  passive_only_score: z.number().min(0).max(100),
  authority_required_before_execute_response: z.literal(true),
}).superRefine((r, ctx) => {
  // A response may only be executed against what the evidence supports (PRD §10.3
  // N7). If `execute_response` were reachable from a weaker band the rubric would
  // train exactly the habit the authority model exists to prevent, so this is
  // enforced at load rather than checked in the scorer where it might be missed.
  for (const [band, actions] of Object.entries(r.allowed)) {
    if (actions.includes("execute_response") && band !== "hostile") {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["allowed", band],
        message: "execute_response is reachable from a band that does not support it.",
      });
    }
  }
  // Conversely, a rubric in which no band can execute a response is unsolvable:
  // a trainee facing a genuine hostile would be punished for every option.
  if (!Object.values(r.allowed).some((a) => a.includes("execute_response"))) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["allowed"],
      message: "no band admits execute_response, so a hostile encounter is unsolvable.",
    });
  }
});

export const CoordinationRulesSchema = z.object({
  brief_not_viewed_penalty: z.number().min(0),
  brief_credit: z.number().min(0).max(100),
  owner_assigned_credit: z.number().min(0).max(100),
  cop_update_credit: z.number().min(0).max(100),
});

export const AdaptationRulesSchema = z.object({
  reacquire_par_ms: z.number().positive(),
  reacquire_full_credit: z.number().min(0).max(100),
  reacquire_zero_credit: z.number().min(0).max(100),
});

/** The fixed critical-error list (PRD §10.5). */
export const CriticalErrorSchema = z.enum([
  "FRATRICIDE",
  "UNAUTHORISED_ACTION",
  "MISSED_THREAT",
  "FALSE_HOSTILE_ON_FRIENDLY",
  "NO_WARNING_BEFORE_IMPACT",
  "IGNORED_FLIGHT_PLAN",
]);
export type CriticalError = z.infer<typeof CriticalErrorSchema>;

export const RubricSchema = z.object({
  id: z.string().min(1),
  version: z.number().int().positive(),
  weights: z.record(CompetencySchema, z.number().min(0)),
  mandated_dimensions: z.array(CompetencySchema),
  detection: DetectionRulesSchema,
  classification: ClassificationRulesSchema,
  reporting: ReportingRulesSchema,
  response: ResponseRulesSchema,
  coordination: CoordinationRulesSchema,
  adaptation: AdaptationRulesSchema,
  critical: z.record(CriticalErrorSchema, z.number().min(0)),
  clamp: z.object({ min: z.number(), max: z.number() }),
}).superRefine((r, ctx) => {
  const sum = Object.values(r.weights).reduce((a, b) => a + b, 0);
  if (sum !== 100) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["weights"],
      message: `Weights must sum to 100, got ${sum}.`,
    });
  }
});

export type Rubric = z.infer<typeof RubricSchema>;
export type ClassificationMatrix = z.infer<typeof ClassificationMatrixSchema>;

/** Raw parsed document, exactly as it appears in `data/rubrics/default-v1.json`. */
export const RUBRIC_DEFAULT_V1_RAW = {
  "id": "default-v1",
  "version": 1,
  "_comment": [
    "FICTIONAL TRAINING PARAMETERS (PRD §10).",
    "Weights, curves and the classification matrix are training defaults for this simulator only.",
    "They are not a Service assessment standard and must not be presented as one.",
    "Editable by admin with version history (FR-SCR-8)."
  ],
  "weights": {
    "detection": 25,
    "classification": 25,
    "response": 20,
    "reporting": 10,
    "prioritisation": 10,
    "coordination": 5,
    "adaptation": 5
  },
  "mandated_dimensions": [
    "detection",
    "classification",
    "response"
  ],
  "detection": {
    "curve": [
      {
        "x": 1,
        "y": 100
      },
      {
        "x": 2,
        "y": 40
      },
      {
        "x": 4,
        "y": 0
      }
    ],
    "latency_divisor_cap": 4
  },
  "classification": {
    "_comment": "rows = expected band (knowability at time t), cols = declared category.",
    "matrix": {
      "friendly": {
        "friendly": 100,
        "authorised": 95,
        "unknown": 55,
        "suspicious": 20,
        "hostile": 10,
        "non_uas": 25
      },
      "authorised": {
        "friendly": 95,
        "authorised": 100,
        "unknown": 55,
        "suspicious": 20,
        "hostile": 10,
        "non_uas": 25
      },
      "unknown": {
        "friendly": 20,
        "authorised": 20,
        "unknown": 100,
        "suspicious": 70,
        "hostile": 40,
        "non_uas": 30
      },
      "suspicious": {
        "friendly": 10,
        "authorised": 10,
        "unknown": 70,
        "suspicious": 100,
        "hostile": 75,
        "non_uas": 10
      },
      "hostile": {
        "friendly": 5,
        "authorised": 5,
        "unknown": 40,
        "suspicious": 75,
        "hostile": 100,
        "non_uas": 10
      },
      "non_uas": {
        "non_uas": 100,
        "unknown": 70,
        "friendly": 30,
        "authorised": 30,
        "suspicious": 10,
        "hostile": 5
      }
    },
    "non_uas_for_real_threat": 10,
    "reclassify_toward_truth_bonus": 10,
    "reclassify_bonus_cap": 100,
    "confidence_policy": {
      "overconfidence_penalty": 25,
      "underconfidence_penalty": 10,
      "order": [
        "low",
        "medium",
        "high"
      ]
    }
  },
  "reporting": {
    "field_presence_points": 35,
    "position_tolerance_points": 25,
    "bearing_tolerance_deg": 15,
    "range_tolerance_frac": 0.25,
    "range_tolerance_abs_m": 120,
    "quantity_points": 15,
    "activity_points": 15,
    "promptness_points": 10,
    "promptness_window_s": 30,
    "update_after_change_bonus": 5
  },
  "response": {
    "_comment": "Policy-level workflow only (PRD §4). No operational detail is modelled.",
    "allowed": {
      "friendly": [
        "continue_observe",
        "assign_track_owner",
        "stand_down",
        "report"
      ],
      "authorised": [
        "continue_observe",
        "assign_track_owner",
        "stand_down",
        "report"
      ],
      "unknown": [
        "continue_observe",
        "request_sensor_cue",
        "report",
        "assign_track_owner",
        "handover"
      ],
      "suspicious": [
        "continue_observe",
        "request_sensor_cue",
        "report",
        "assign_track_owner",
        "handover",
        "issue_warning",
        "activate_protective_drill",
        "request_support",
        "request_response_authority"
      ],
      "hostile": [
        "continue_observe",
        "request_sensor_cue",
        "report",
        "assign_track_owner",
        "handover",
        "issue_warning",
        "activate_protective_drill",
        "request_support",
        "request_response_authority",
        "execute_response"
      ],
      "non_uas": [
        "continue_observe",
        "report",
        "assign_track_owner",
        "stand_down"
      ]
    },
    "late_after_par": 1.5,
    "late_score_low": 40,
    "late_score_high": 80,
    "passive_only_score": 30,
    "authority_required_before_execute_response": true
  },
  "coordination": {
    "brief_not_viewed_penalty": 10,
    "brief_credit": 15,
    "owner_assigned_credit": 20,
    "cop_update_credit": 15
  },
  "adaptation": {
    "reacquire_par_ms": 15000,
    "reacquire_full_credit": 100,
    "reacquire_zero_credit": 20
  },
  "critical": {
    "FRATRICIDE": 30,
    "UNAUTHORISED_ACTION": 25,
    "MISSED_THREAT": 20,
    "FALSE_HOSTILE_ON_FRIENDLY": 20,
    "NO_WARNING_BEFORE_IMPACT": 15,
    "IGNORED_FLIGHT_PLAN": 10
  },
  "clamp": {
    "min": 0,
    "max": 100
  }
} as const;
