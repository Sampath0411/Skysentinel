/**
 * Fingerprint tests (PRD §5.4 FR-SCN-5, §8.4 rule 7).
 *
 * Two properties matter and they pull in opposite directions: the hash must
 * change when the exercise changes, and must not change when the exercise is
 * merely renamed or reseeded. A hash that is too sensitive makes anti-rote fire
 * constantly and suppress legitimate practice; one that is too insensitive lets
 * the same drill back. Both failure modes are tested here explicitly.
 */

import { describe, expect, it } from "vitest";

import { SCRIPTED_SCENARIOS, nightRecon01 } from "./scripted/index.js";
import { ANTI_ROTE_WINDOW, canonicalForm, fingerprint, isRepeatOf } from "./fingerprint.js";
import type { Scenario } from "./schema.js";

const draft = (): Scenario => structuredClone(nightRecon01) as unknown as Scenario;

/** Fields that describe identity or provenance, not content. */
const identityEdits = [
  { name: "id", apply: (s: Scenario) => void (s.id = "scr-renamed") },
  { name: "title", apply: (s: Scenario) => void (s.title = "A completely different title") },
  { name: "description", apply: (s: Scenario) => void (s.description = "Rewritten prose.") },
  { name: "seed", apply: (s: Scenario) => void (s.seed = 999_999) },
  { name: "family", apply: (s: Scenario) => void ((s as { family?: string }).family = "recon_near_asset") },
  { name: "rubric_id", apply: (s: Scenario) => void (s.rubric_id = "some-other-rubric") },
] as const;

/** Fields that change what the trainee actually faces. */
const contentEdits = [
  { name: "terrain", apply: (s: Scenario) => void (s.environment.terrain = "urban") },
  // night-recon-01 is authored at `night`, so the probe has to move *away* from
  // it — setting it to its own current value would be a no-op and prove nothing.
  { name: "time of day", apply: (s: Scenario) => void (s.environment.time_of_day = "day") },
  // It is authored in `haze`, so likewise.
  { name: "weather", apply: (s: Scenario) => void (s.environment.weather = "fog") },
  { name: "wind", apply: (s: Scenario) => void (s.environment.wind_mps = 21) },
  { name: "sensor mode", apply: (s: Scenario) => void (s.sensors.radar = "degraded") },
  { name: "asset position", apply: (s: Scenario) => void (s.assets[0]!.pos = [321, -123]) },
  { name: "entity behaviour", apply: (s: Scenario) => void (s.entities[0]!.behaviour[0]!.speed = 44) },
  { name: "spawn time", apply: (s: Scenario) => void (s.entities[0]!.spawn_t_s = 777) },
  { name: "difficulty", apply: (s: Scenario) => void (s.difficulty = 5) },
  { name: "inject timeline", apply: (s: Scenario) => void s.injects.push({ at_t_s: 30, type: "sensor_outage", params: {}, note: "" }) },
] as const;

describe("canonicalForm", () => {
  it("is independent of object key order", () => {
    const a = canonicalForm(draft());
    const s = draft();
    const reordered = Object.fromEntries(Object.entries(s).reverse()) as Scenario;
    expect(canonicalForm(reordered)).toBe(a);
  });

  it("excludes the seed string entirely", () => {
    const s = draft();
    s.seed = 424_242;
    expect(canonicalForm(s)).not.toContain("424242");
  });
});

describe("fingerprint stability", () => {
  it("is deterministic for an unchanged scenario", () => {
    expect(fingerprint(draft())).toBe(fingerprint(draft()));
  });

  it("returns 16 hex characters", () => {
    expect(fingerprint(draft())).toMatch(/^[0-9a-f]{16}$/);
  });

  it("carries real entropy in both halves, not one hash repeated", () => {
    // A single 32-bit FNV pass, padded to 16 chars, yields `a0c920cca0c920cc` —
    // the same 8 characters twice. That looks like 64 bits and carries 32, and
    // over a large generated library collides often enough to silently suppress
    // distinct exercises from the anti-rote check.
    const halves = new Set(SCRIPTED_SCENARIOS.map((s) => {
      const fp = fingerprint(s);
      return [fp.slice(0, 8), fp.slice(8, 16)].join("|");
    }));
    for (const pair of halves) {
      const [hi, lo] = pair.split("|");
      expect(hi).not.toBe(lo);
    }
  });

  it.each(identityEdits)("ignores a change to $name", ({ apply }) => {
    const before = fingerprint(draft());
    const after = draft();
    apply(after);
    expect(fingerprint(after)).toBe(before);
  });

  it.each(contentEdits)("changes when $name changes", ({ apply }) => {
    const before = fingerprint(draft());
    const after = draft();
    apply(after);
    expect(fingerprint(after)).not.toBe(before);
  });

  it("is stable across a JSON round trip", () => {
    const s = draft();
    expect(fingerprint(JSON.parse(JSON.stringify(s)) as Scenario)).toBe(fingerprint(s));
  });

  it("gives every shipped scenario a distinct fingerprint", () => {
    const fps = SCRIPTED_SCENARIOS.map(fingerprint);
    expect(new Set(fps).size).toBe(fps.length);
  });

  it("tolerates a one-metre position change as significant", () => {
    // Rounded to 1 m, so a genuine metre-scale difference is a different drill.
    const a = draft();
    const b = draft();
    b.assets[0]!.pos = [a.assets[0]!.pos[0] + 1, a.assets[0]!.pos[1]];
    expect(fingerprint(b)).not.toBe(fingerprint(a));
  });

  it("does not change on sub-centimetre float noise", () => {
    const a = draft();
    const b = draft();
    b.assets[0]!.pos = [a.assets[0]!.pos[0] + 1e-9, a.assets[0]!.pos[1]];
    expect(fingerprint(b)).toBe(fingerprint(a));
  });
});

describe("isRepeatOf", () => {
  const fp = fingerprint(draft());

  it("detects a repeat at the head of the history", () => {
    expect(isRepeatOf([fp], fp)).toBe(true);
  });

  it("does not fire on an unseen fingerprint", () => {
    expect(isRepeatOf(["ffffffffffffffff"], fp)).toBe(false);
  });

  it("ignores history beyond the window", () => {
    const history = [fp, ...Array.from({ length: ANTI_ROTE_WINDOW }, (_, i) => `old${i}`)];
    expect(isRepeatOf(history, fp)).toBe(false);
  });

  it("honours an explicit window", () => {
    const history = [fp, ...Array.from({ length: ANTI_ROTE_WINDOW }, (_, i) => `old${i}`)];
    expect(isRepeatOf(history, fp, 20)).toBe(true);
  });

  it("treats an empty history as no repeat", () => {
    expect(isRepeatOf([], fp)).toBe(false);
  });
});