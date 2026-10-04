/**
 * `scenario:validate` CLI tests.
 *
 * The CLI is the authoring gate, so what matters is not that it runs but that it
 * cannot pass a scenario it should reject, and cannot reject one it should accept.
 * Everything here is asserted through `validateFile`/`main` rather than by
 * inspecting stdout formatting, except for the two rendering cases where the text
 * *is* the product.
 */

import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterAll, describe, expect, it } from "vitest";

import { main, parseArgs, renderResult, USAGE, validateFile } from "./cli.js";
import { SCRIPTED_SCENARIOS } from "./scripted/index.js";

/** A scratch directory, so tests write real files without touching the repo. */
const dir = mkdtempSync(join(tmpdir(), "skysentinel-scnval-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

const write = (name: string, body: unknown): string => {
  const path = join(dir, name);
  writeFileSync(path, typeof body === "string" ? body : JSON.stringify(body), "utf8");
  return path;
};

describe("parseArgs", () => {
  it("treats bare arguments as files, in order", () => {
    const a = parseArgs(["a.json", "b.json"]);
    expect(a.files).toEqual(["a.json", "b.json"]);
  });

  it("reads the flags in either order", () => {
    expect(parseArgs(["--json", "-q", "a.json"])).toEqual(parseArgs(["a.json", "--quiet", "--json"]));
  });

  it("defaults every flag to false", () => {
    const a = parseArgs(["a.json"]);
    expect(a.json).toBe(false);
    expect(a.quiet).toBe(false);
    expect(a.help).toBe(false);
  });

  it("rejects an unknown option rather than treating it as a path", () => {
    // Reading --jsno as a filename would report ENOENT, and the operator would
    // never connect that to their typo.
    expect(() => parseArgs(["--jsno", "a.json"])).toThrow(/Unknown option/);
    expect(() => parseArgs(["-z"])).toThrow(/Unknown option/);
  });
});

/**
 * A scenario with every non-threat entity removed, so rule 4 alone fires.
 *
 * The `expected.tracks` entries for the removed entities go too — leaving them
 * behind trips rule 1 (`expected.tracks references unknown entity`), and a test
 * that asserts on rule 4 would then be passing for the wrong reason.
 */
const withoutDistractors = (id: string) => {
  const base = SCRIPTED_SCENARIOS.find((s) => s.id === id)!;
  const kept = base.entities.filter((e) => e.affiliation_truth === "hostile");
  const kept_ids = new Set(kept.map((e) => e.id));
  return {
    ...base,
    entities: kept,
    expected: {
      ...base.expected,
      tracks: base.expected.tracks.filter((t) => kept_ids.has(t.truth_id)),
    },
  };
};

describe("validateFile", () => {
  it("accepts every shipped scenario", () => {
    for (const s of SCRIPTED_SCENARIOS) {
      const path = write(`${s.id}.json`, s);
      const r = validateFile(path);
      expect(r.issues.filter((i) => i.severity === "error")).toEqual([]);
      expect(r.valid).toBe(true);
    }
  });

  it("reports the id and fingerprint of a valid scenario", () => {
    const s = SCRIPTED_SCENARIOS[0]!;
    const r = validateFile(write("ok.json", s));
    expect(r.scenario?.id).toBe(s.id);
    expect(r.fingerprint).toMatch(/^[0-9a-f]{16}$/);
  });

  it("reports a missing file without throwing", () => {
    const r = validateFile(join(dir, "does-not-exist.json"));
    expect(r.valid).toBe(false);
    expect(r.issues[0]?.code).toBe("unreadable");
  });

  it("reports malformed JSON without throwing", () => {
    const r = validateFile(write("broken.json", "{ not json"));
    expect(r.valid).toBe(false);
    expect(r.issues[0]?.code).toBe("not_json");
  });

  it("reports a schema violation with the failing path", () => {
    // The path is what makes the message actionable on a 400-line scenario.
    const bad = { ...SCRIPTED_SCENARIOS[0]!, duration_s: -1 };
    const r = validateFile(write("bad-schema.json", bad));
    expect(r.valid).toBe(false);
    expect(r.issues.map((i) => i.code)).toEqual(["schema"]);
    expect(r.issues[0]!.message).toMatch(/duration_s/);
  });

  it("surfaces every schema problem in one pass, not just the first", () => {
    const bad = { ...SCRIPTED_SCENARIOS[0]!, duration_s: -1, seed: "not a number" };
    const r = validateFile(write("two-errors.json", bad));
    expect(r.issues.filter((i) => i.code === "schema").length).toBeGreaterThan(1);
  });

  it("catches a rule violation that the schema alone permits", () => {
    // This is the case the CLI exists for. Rule 4 requires a distractor; the
    // schema does not, so a file can be structurally perfect and still unteachable.
    const r = validateFile(write("no-distractor.json", withoutDistractors("scr-friendly-deconflict-01")));
    expect(r.issues.map((i) => i.code)).toEqual(["no_distractor"]);
    expect(r.valid).toBe(false);
  });
});

describe("renderResult", () => {
  it("names the scenario and its verdict", () => {
    const s = SCRIPTED_SCENARIOS[0]!;
    const text = renderResult(validateFile(write("render-ok.json", s)));
    expect(text).toContain(s.id);
    expect(text).toMatch(/valid/);
  });

  it("labels a rule-0 issue by its code, and a numbered issue by its rule", () => {
    // Rule 0 means "the file is wrong", not "one of the seven rules fired". Printing
    // a "schema" prefix there produced "schema schema" and "schema not_json".
    const bad = { ...SCRIPTED_SCENARIOS[0]!, duration_s: -1 };
    const schemaText = renderResult(validateFile(write("render-schema.json", bad)));
    expect(schemaText).toContain("ERROR  schema:");
    expect(schemaText).not.toContain("rule 0");

    const ruleText = renderResult(validateFile(write("render-rule.json", withoutDistractors("scr-friendly-deconflict-01"))));
    expect(ruleText).toContain("ERROR  rule 4 no_distractor:");
  });

  it("does not print an undefined family", () => {
    // The scripted scenarios carry their family in the id, not in a `family` field,
    // so printing it unconditionally put "undefined" in the middle of the line.
    const text = renderResult(validateFile(write("render-family.json", SCRIPTED_SCENARIOS[0]!)));
    expect(text).not.toContain("undefined");
    expect(text).toContain("difficulty 2");
  });

  it("counts errors, not warnings, in the verdict", () => {
    const text = renderResult(validateFile(write("render-count.json", withoutDistractors("scr-friendly-deconflict-01"))));
    expect(text).toMatch(/invalid — \d+ error\(s\)/);
    expect(text).not.toMatch(/invalid — \d+ warning/);
  });
});

describe("main", () => {
  const capture = (argv: string[]): { code: number; out: string } => {
    const lines: string[] = [];
    const code = main(argv, (l) => lines.push(l));
    return { code, out: lines.join("\n") };
  };

  it("exits 0 when no files are asked for but --help is passed", () => {
    const { code, out } = capture(["--help"]);
    expect(code).toBe(0);
    expect(out).toBe(USAGE);
  });

  it("exits 1 with usage when no file is given", () => {
    const { code, out } = capture([]);
    expect(code).toBe(1);
    expect(out).toContain("at least one scenario file");
  });

  it("exits 0 for a valid scenario", () => {
    const s = SCRIPTED_SCENARIOS[0]!;
    expect(capture([write("main-ok.json", s)]).code).toBe(0);
  });

  it("exits 2 for an invalid scenario", () => {
    const bad = { ...SCRIPTED_SCENARIOS[0]!, duration_s: -1 };
    expect(capture([write("main-bad.json", bad)]).code).toBe(2);
  });

  it("emits one parseable JSON object per scenario under --json", () => {
    const ok = SCRIPTED_SCENARIOS[0]!;
    const bad = { ...SCRIPTED_SCENARIOS[1]!, duration_s: -1 };
    const { code, out } = capture(["--json", write("j-ok.json", ok), write("j-bad.json", bad)]);
    expect(code).toBe(2);

    const parsed = out.trim().split("\n").map((l) => JSON.parse(l) as { valid: boolean; id: string | null });
    expect(parsed).toHaveLength(2);
    expect(parsed[0]).toMatchObject({ valid: true, id: ok.id });
    expect(parsed[1]).toMatchObject({ valid: false, id: null });
  });

  it("validates every file even when an earlier one fails", () => {
    // An operator fixing a batch needs all the verdicts from one run.
    const bad = { ...SCRIPTED_SCENARIOS[0]!, duration_s: -1 };
    const { out } = capture(["--json", write("batch-1.json", bad), write("batch-2.json", SCRIPTED_SCENARIOS[1]!)]);
    expect(out.trim().split("\n")).toHaveLength(2);
  });

  it("prints nothing at all under --quiet when everything passes", () => {
    const { code, out } = capture(["--quiet", write("quiet-ok.json", SCRIPTED_SCENARIOS[0]!)]);
    expect(code).toBe(0);
    expect(out).toBe("");
  });

  it("still prints the failures under --quiet", () => {
    const bad = { ...SCRIPTED_SCENARIOS[0]!, duration_s: -1 };
    const { code, out } = capture(["--quiet", write("quiet-bad.json", bad)]);
    expect(code).toBe(2);
    expect(out).toContain("quiet-bad.json");
  });

  it("reports a bad option as exit 1 rather than a crash", () => {
    expect(capture(["--nope"]).code).toBe(1);
  });
});