/**
 * `pnpm sim:run --scenario <id> --bot <name>` (PRD §14 M3).
 *
 * Writes one JSON object per line — the event log, then a run summary. JSONL is
 * the format because the AAR replays from stored events and because a stream of
 * lines survives being tailed while a run is still going, which a single JSON blob
 * does not.
 *
 * Exit codes are meaningful so the M3 DoD check can be scripted:
 *   0  ran to completion
 *   1  bad usage (unknown scenario or bot)
 *   2  the scenario failed validation and `--strict` was passed
 */

import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { SYNTHETIC_BANNER } from "@skysentinel/shared";
import { SCRIPTED_SCENARIO_IDS, scriptedScenarioById, validateScenario } from "@skysentinel/scenario";

import { POLICIES, isBotName } from "./policies.js";
import type { BotName } from "./policy.js";
import { runScenario, type RunResult } from "./run.js";

export interface ParsedArgs {
  scenario: string | undefined;
  bot: string | undefined;
  out: string | undefined;
  seed: number | undefined;
  strict: boolean;
  quiet: boolean;
  help: boolean;
  list: boolean;
}

/** Parse argv. Tolerant of `--flag value` and `--flag=value`. */
export const parseArgs = (argv: readonly string[]): ParsedArgs => {
  const parsed: ParsedArgs = {
    scenario: undefined,
    bot: undefined,
    out: undefined,
    seed: undefined,
    strict: false,
    quiet: false,
    help: false,
    list: false,
  };

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    const eq = arg.indexOf("=");
    const flag = eq >= 0 ? arg.slice(0, eq) : arg;
    const inline = eq >= 0 ? arg.slice(eq + 1) : undefined;
    const value = (): string | undefined => inline ?? argv[++i];

    switch (flag) {
      case "--scenario": parsed.scenario = value(); break;
      case "--bot": parsed.bot = value(); break;
      case "--out": parsed.out = value(); break;
      case "--seed": parsed.seed = Number(value()); break;
      case "--strict": parsed.strict = true; break;
      case "--quiet": parsed.quiet = true; break;
      case "--list": parsed.list = true; break;
      case "--help": parsed.help = true; break;
      default:
        if (flag.startsWith("--")) throw new Error(`Unknown option: ${flag}`);
    }
  }
  return parsed;
};

export const USAGE = `SkySentinel headless runner

  pnpm sim:run --scenario <id> --bot <expert|novice|trigger_happy|passive|random>

Options
  --scenario <id>   Scripted scenario id. Use --list to see them.
  --bot <name>      Bot policy driving the trainee loop.
  --seed <n>        Bot seed. Defaults to the scenario seed.
  --out <file>      Write JSONL here instead of stdout.
  --strict          Exit 2 if the scenario fails validation.
  --quiet           Suppress the human-readable summary.
  --list            List scenario ids and exit.
  --help            This message.

Output is JSONL: every simulation event on its own line, then a final
"run_summary" object with tick count, log hash and event counts.

${SYNTHETIC_BANNER}`;

/** Render a run as JSONL: every event, then the summary. */
export const toJsonl = (result: RunResult): string => {
  const lines = result.events.map((e) => JSON.stringify(e));
  const summary = {
    type: "run_summary",
    scenario_id: result.scenario_id,
    bot: result.bot,
    seed: result.seed,
    fingerprint: result.fingerprint,
    ticks: result.ticks,
    t_ms: result.t_ms,
    log_hash: result.log_hash,
    counts: result.counts,
    validation_issues: result.validation_issues,
    synthetic: SYNTHETIC_BANNER,
  };
  lines.push(JSON.stringify(summary));
  return lines.join("\n") + "\n";
};

/** Human-readable footer, so the CLI is useful without piping to jq. */
export const summarise = (result: RunResult): string => {
  const rows = Object.entries(result.counts).sort(([a], [b]) => a.localeCompare(b));
  const width = Math.max(...rows.map(([t]) => t.length));
  const body = rows.map(([t, n]) => `  ${t.padEnd(width)}  ${String(n).padStart(5)}`).join("\n");
  return [
    "",
    `  scenario  ${result.scenario_id}  (${result.bot}, seed ${result.seed})`,
    `  ticks     ${result.ticks}   t=${(result.t_ms / 1000).toFixed(1)}s   log ${result.log_hash}`,
    `  fingerprint ${result.fingerprint}`,
    result.validation_issues.length > 0
      ? `  validation: ${result.validation_issues.length} issue(s)\n${result.validation_issues.map((i) => `    - ${i}`).join("\n")}`
      : "  validation: clean",
    "",
    body,
    "",
  ].join("\n");
};

/** The process entry point. Returns the exit code. */
export const main = (argv: readonly string[], out: (line: string) => void): number => {
  let args: ParsedArgs;
  try {
    args = parseArgs(argv);
  } catch (e) {
    out(String(e instanceof Error ? e.message : e));
    return 1;
  }

  if (args.help || args.list) {
    if (args.list) {
      out("Scenarios:");
      for (const id of SCRIPTED_SCENARIO_IDS) out(`  ${id}`);
      out("");
    }
    out(USAGE);
    return 0;
  }

  if (!args.scenario || !args.bot) {
    out("Both --scenario and --bot are required.\n");
    out(USAGE);
    return 1;
  }

  if (!isBotName(args.bot)) {
    out(`Unknown bot "${args.bot}". Expected one of: ${Object.keys(POLICIES).join(", ")}.`);
    return 1;
  }

  const scenario = scriptedScenarioById(args.scenario);
  if (!scenario) {
    out(`Unknown scenario "${args.scenario}". Known ids:\n  ${SCRIPTED_SCENARIO_IDS.join("\n  ")}`);
    return 1;
  }

  const bot: BotName = args.bot;
  const validation = validateScenario(scenario);
  if (args.strict && !validation.valid) {
    out(`${scenario.id} failed validation:\n${validation.issues.map((i) => `  - ${i.code}: ${i.message}`).join("\n")}`);
    return 2;
  }

  let result: RunResult;
  try {
    result = runScenario({ scenario, bot, ...(args.seed !== undefined ? { seed: args.seed } : {}) });
  } catch (e) {
    // A stack trace is the wrong output for an operator running a training drill.
    // A failed run is a scenario or harness defect, so name it and exit non-zero
    // rather than dumping internals they did not ask for.
    out(`Run failed for ${args.scenario} with the ${bot} bot: ${e instanceof Error ? e.message : e}`);
    return 1;
  }

  if (args.out) {
    // Create the parent directory: `--out logs/run.jsonl` should work without the
    // operator having to mkdir first, and a bare filename must not be resolved
    // against whichever package directory pnpm happened to run the script from.
    try {
      mkdirSync(dirname(resolve(args.out)), { recursive: true });
      writeFileSync(args.out, toJsonl(result), "utf8");
    } catch (e) {
      out(`Could not write ${args.out}: ${e instanceof Error ? e.message : e}`);
      return 1;
    }
    if (!args.quiet) out(`wrote ${result.events.length} events + summary to ${args.out}`);
  } else {
    process.stdout.write(toJsonl(result));
  }

  if (!args.quiet) out(summarise(result));
  return 0;
};

/**
 * Is this module the process entry point?
 *
 * Compared against the resolved argv[1] path rather than by checking whether
 * `process.argv[1]` merely *ends with* `cli.ts`, which a different `cli.ts`
 * elsewhere in the tree would also satisfy.
 */
export const isMainModule = (meta_url: string): boolean => {
  const entry = process.argv[1];
  if (!entry) return false;
  try {
    return resolve(fileURLToPath(meta_url)) === resolve(entry);
  } catch {
    return false;
  }
};

/* c8 ignore start -- process wiring, exercised by `pnpm sim:run` rather than tests */
if (isMainModule(import.meta.url)) {
  const code = main(process.argv.slice(2), (line) => process.stdout.write(line + "\n"));
  process.exit(code);
}
/* c8 ignore stop */
