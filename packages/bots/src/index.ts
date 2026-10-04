/** Public surface of @skysentinel/bots. */
export const PACKAGE_NAME = "@skysentinel/bots" as const;

export {
  buildSession,
  grantRuleOf,
} from "./build.js";

export {
  runScenario,
} from "./run.js";
export type { RunOptions, RunResult, ServerSideTruth } from "./run.js";

export {
  scoreInputFor,
} from "./score-input.js";

export {
  BOT_NAMES,
  REACTION_TICKS,
  ATTENTION,
  CORROBORATION_DISCIPLINE,
  AUTHORITY_DISCIPLINE,
  REPORT_DISCIPLINE,
  WARN_DISCIPLINE,
  createBotRng,
  categoryFor,
  unclassified,
  believedThreats,
  cuesCleared,
  policy,
} from "./policy.js";
export type { BotName, BotRng } from "./policy.js";

export {
  POLICIES,
  isBotName,
  expertPolicy,
  novicePolicy,
  triggerHappyPolicy,
  passivePolicy,
  randomPolicy,
} from "./policies.js";

export {
  main,
  parseArgs,
  toJsonl,
  summarise,
  isMainModule,
  USAGE,
} from "./cli.js";
export type { ParsedArgs } from "./cli.js";
