/** Public surface of @skysentinel/scenario. */
export const PACKAGE_NAME = "@skysentinel/scenario" as const;

export {
  SCENARIO_SCHEMA_VERSION,
  SCENARIO_FAMILIES,
  ScenarioFamilySchema,
  Vec2Schema,
  Vec3Schema,
  SecondRangeSchema,
  EnvironmentSchema,
  AssetSchema,
  SectorSchema,
  ObserverPostSchema,
  FlightInfoStateSchema,
  FriendlyFlightSchema,
  ScenarioSensorsSchema,
  ScenarioBehaviourStepSchema,
  ScenarioEntitySchema,
  GrantRuleSchema,
  AuthoritySchema,
  ExpectedTrackSchema,
  ExpectedSchema,
  INJECT_TYPES,
  InjectTypeSchema,
  ScenarioInjectSchema,
  BRIEF_SECTIONS,
  BriefSectionSchema,
  BriefSectionsSchema,
  ScenarioSchema,
  parseScenario,
} from "./schema.js";
export type {
  Scenario,
  ScenarioEnvironment,
  ScenarioAsset,
  ObserverPost,
  FriendlyFlight,
  ScenarioSensors,
  ScenarioEntity,
  ScenarioAuthority,
  ExpectedBlock,
  ExpectedTrack,
  ScenarioInject,
  InjectType,
  ScenarioFamily,
  BriefSection,
  ParseResult,
} from "./schema.js";

export {
  canonicalForm,
  fingerprint,
  isRepeatOf,
  ANTI_ROTE_WINDOW,
} from "./fingerprint.js";

export {
  DIFFICULTY_MAP,
  DIFFICULTY_LEVELS,
  isDifficulty,
  difficultyLevel,
  minimumReactionGap,
  supportCueConfidence,
  parFactor,
} from "./difficulty.js";

export {
  validateScenario,
  rule1_threatsDetectable,
  rule2_expectedCategoryKnowable,
  rule3_notAllSensorsDown,
  rule4_hasDistractor,
  rule5_reactionTime,
  rule6_geometryValid,
  rule7_notRecentRepeat,
} from "./validate.js";
export type { ValidationIssue, ValidationResult } from "./validate.js";

export {
  SCRIPTED_SCENARIOS,
  SCRIPTED_SCENARIO_IDS,
  scriptedScenarioById,
  nightRecon01,
  friendlyDeconflict01,
  urbanSwarmDiversion01,
} from "./scripted/index.js";

export {
  main,
  parseArgs,
  validateFile,
  renderResult,
  isMainModule,
  USAGE,
  type FileResult,
  type ValidateArgs,
} from "./cli.js";