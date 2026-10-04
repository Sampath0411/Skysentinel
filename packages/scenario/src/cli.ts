/**
 * `pnpm scenario:validate <file>` (PRD §14 M3).
 *
 * Validates a scenario file against the Zod schema and the seven authoring rules
 * (PRD §8.4). This is the authoring loop's gate: a scenario that cannot be solved,
 * or that punishes the trainee for evidence they were never given, teaches the
 * wrong lesson — so an instructor-authored file should not reach a trainee client
 * without passing here first.
 *
 * Exit codes:
 *   0  valid (possibly with warnings)
 *   1  bad usage, or the file could not be read/parsed as JSON
 *   2  the scenario is invalid
 *
 * Distinct from the bots runner's `--strict`: this reads a *file*, so it is the
 * authoring-time check, whereas `sim:run --strict` validates a scenario already
 * loaded from the shipped set.
 */

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { SYNTHETIC_BANNER } from "@skysentinel/shared";

import { fingerprint } from "./fingerprint.js";
import { parseScenario, type Scenario } from "./schema.js";
import { validateScenario } from "./validate.js";

export interface ValidateArgs {
  files: string[];
  json: boolean;
  quiet: boolean;
  help: boolean;
}

export const USAGE = `SkySentinel scenario validator

  pnpm scenario:validate <file> [<file> ...]

Options
  --json     Emit one JSON object per scenario instead of prose.
  --quiet    Print only failures. Suppresses the passing summary.
  --help     This message.

Checks each file against the scenario schema, then against the seven authoring
rules in PRD §8.4 (solvable, knowable, not all sensors down, has a distractor,
reaction time, geometry, not a recent repeat).

Exit codes: 0 valid, 1 usage or parse failure, 2 invalid.

${SYNTHETIC_BANNER}`;

/** Parse argv. Unlike the bots CLI, positional file paths are the point. */
export const parseArgs = (argv: readonly string[]): ValidateArgs => {
  const args: ValidateArgs = { files: [], json: false, quiet: false, help: false };

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    switch (arg) {
      case "--json": args.json = true; break;
      case "--quiet":
      case "-q": args.quiet = true; break;
      case "--help":
      case "-h": args.help = true; break;
      default:
        if (arg.startsWith("--")) throw new Error(`Unknown option: ${arg}`);
        // A leading dash that is not a known flag is a typo'd filename or a stray
        // flag value; treating it as a path would produce an ENOENT the operator
        // cannot connect to their command line.
        if (arg.startsWith("-")) throw new Error(`Unknown option: ${arg}`);
        args.files.push(arg);
    }
  }
  return args;
};

export interface FileResult {
  file: string;
  /** null when the file could not be read or did not match the schema. */
  scenario: Scenario | null;
  fingerprint: string | null;
  valid: boolean;
  issues: ReturnType<typeof validateScenario>["issues"];
}

/**
 * Validate one file.
 *
 * Returns rather than throws: an operator validating a directory of scenarios
 * wants every verdict, not just the first crash.
 */
export const validateFile = (path: string): FileResult => {
  const absolute = resolve(path);

  let text: string;
  try {
    text = readFileSync(absolute, "utf8");
  } catch {
    return {
      file: path,
      scenario: null,
      fingerprint: null,
      valid: false,
      issues: [
        {
          rule: 0,
          code: "unreadable",
          message: `Could not read ${absolute}`,
          severity: "error",
        },
      ],
    };
  }

  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (e) {
    return {
      file: path,
      scenario: null,
      fingerprint: null,
      valid: false,
      issues: [
        {
          rule: 0,
          code: "not_json",
          message: `Not valid JSON: ${e instanceof Error ? e.message : e}`,
          severity: "error",
        },
      ],
    };
  }

  const parsed = parseScenario(raw);
  if (!parsed.ok) {
    return {
      file: path,
      scenario: null,
      fingerprint: null,
      valid: false,
      // `parseScenario` already renders each Zod issue as `path: message`, and it
      // collects every one rather than stopping at the first. Both matter here: an
      // instructor editing a 400-line scenario needs to be told *where* each
      // problem is, and one run should surface the whole set.
      issues: parsed.issues.map((message) => ({
        rule: 0,
        code: "schema",
        message,
        severity: "error" as const,
      })),
    };
  }

  const result = validateScenario(parsed.scenario);
  return {
    file: path,
    scenario: parsed.scenario,
    fingerprint: fingerprint(parsed.scenario),
    valid: result.valid,
    issues: result.issues,
  };
};

/** Prose rendering for one file. */
export const renderResult = (r: FileResult): string => {
  const lines: string[] = [];
  const errors = r.issues.filter((i) => i.severity === "error");
  const warnings = r.issues.filter((i) => i.severity === "warning");

  for (const i of r.issues) {
    // `rule 0` means the problem is in the file rather than in one of the seven
    // authoring rules, so there is no rule number to print — prefixing those with
    // "schema" produced "schema schema" and "schema not_json".
    const where = i.rule > 0 ? `rule ${i.rule} ` : "";
    const subject = i.subject ? ` [${i.subject}]` : "";
    lines.push(`  ${i.severity === "error" ? "ERROR" : "warn "}  ${where}${i.code}${subject}: ${i.message}`);
  }

  if (r.scenario) {
    // `family` is optional in the schema — the scripted scenarios carry it in the
    // id and filename instead — so it is printed only when present rather than
    // leaving a literal "undefined" in the middle of an otherwise useful line.
    const family = r.scenario.family ? `${r.scenario.family}/` : "";
    lines.push(`  ${r.scenario.id}  ${family}difficulty ${r.scenario.difficulty}  seed ${r.scenario.seed}`);
    if (r.fingerprint) lines.push(`  fingerprint ${r.fingerprint}`);
  }

  const verdict =
    errors.length === 0
      ? warnings.length > 0
        ? `valid with ${warnings.length} warning(s)`
        : "valid"
      : `invalid — ${errors.length} error(s)`;

  return [`${r.file}\n${lines.join("\n")}${lines.length > 0 ? "\n" : ""}  ${verdict}`].join("\n");
};

/** The process entry point. Returns the exit code. */
export const main = (argv: readonly string[], out: (line: string) => void): number => {
  let args: ValidateArgs;
  try {
    args = parseArgs(argv);
  } catch (e) {
    out(String(e instanceof Error ? e.message : e));
    return 1;
  }

  if (args.help) {
    out(USAGE);
    return 0;
  }

  if (args.files.length === 0) {
    out("Pass at least one scenario file.\n");
    out(USAGE);
    return 1;
  }

  const results = args.files.map(validateFile);
  const failed = results.filter((r) => !r.valid);

  if (args.json) {
    for (const r of results) {
      out(JSON.stringify({
        file: r.file,
        id: r.scenario?.id ?? null,
        fingerprint: r.fingerprint,
        valid: r.valid,
        issues: r.issues,
      }));
    }
    return failed.length > 0 ? 2 : 0;
  }

  const show = results.filter((r) => !r.valid || !args.quiet);
  for (const r of show) out(renderResult(r));

  if (args.quiet && failed.length === 0) return 0;

  const totalErrors = failed.reduce((n, r) => n + r.issues.filter((i) => i.severity === "error").length, 0);
  out(
    failed.length === 0
      ? `\n${results.length} scenario(s) valid.`
      : `\n${failed.length} of ${results.length} scenario(s) invalid, ${totalErrors} error(s).`,
  );
  return failed.length > 0 ? 2 : 0;
};

export const isMainModule = (meta_url: string): boolean => {
  const entry = process.argv[1];
  if (!entry) return false;
  try {
    return resolve(fileURLToPath(meta_url)) === resolve(entry);
  } catch {
    return false;
  }
};

/* c8 ignore start -- process wiring, exercised by `pnpm scenario:validate` rather than tests */
if (isMainModule(import.meta.url)) {
  const code = main(process.argv.slice(2), (line) => process.stdout.write(line + "\n"));
  process.exit(code);
}
/* c8 ignore stop */