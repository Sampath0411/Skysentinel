import { describe, expect, it } from "vitest";

import { createRng, createRngBundle, hashString, mixSeed, unitVector3 } from "./rng.js";

describe("createRng determinism (PRD §5.1 FR-SIM-1)", () => {
  it("produces an identical sequence for the same seed", () => {
    const a = createRng(1234);
    const b = createRng(1234);
    const seqA = Array.from({ length: 200 }, () => a.next());
    const seqB = Array.from({ length: 200 }, () => b.next());
    expect(seqA).toEqual(seqB);
  });

  it("produces a different sequence for a different seed", () => {
    const a = Array.from({ length: 50 }, createRng(1).next);
    const b = Array.from({ length: 50 }, createRng(2).next);
    expect(a).not.toEqual(b);
  });

  it("returns values within [0, 1)", () => {
    const rng = createRng(99);
    for (let i = 0; i < 5000; i++) {
      const v = rng.next();
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThan(1);
    }
  });

  it("stays within [0,1) even for low-entropy seeds", () => {
    // Seed 0 is the classic weak case; the warm-up draws should prevent a burst of
    // identical or out-of-range values.
    for (const seed of [0, 1, 2, 3]) {
      const rng = createRng(seed);
      for (let i = 0; i < 1000; i++) {
        const v = rng.next();
        expect(v).toBeGreaterThanOrEqual(0);
        expect(v).toBeLessThan(1);
      }
    }
  });

  it("is roughly uniform across deciles (chi-square sanity)", () => {
    const rng = createRng(4242);
    const buckets = new Array<number>(10).fill(0);
    const n = 100_000;
    for (let i = 0; i < n; i++) {
      const idx = Math.floor(rng.next() * 10);
      buckets[idx] = (buckets[idx] ?? 0) + 1;
    }
    const expected = n / 10;
    for (const count of buckets) {
      // Within 5% of expected for every decile.
      expect(Math.abs(count - expected) / expected).toBeLessThan(0.05);
    }
  });

  it("separates streams by name from the same seed (DECISIONS.md D1)", () => {
    const motion = Array.from({ length: 20 }, createRng(7, "motion").next);
    const sensor = Array.from({ length: 20 }, createRng(7, "sensor").next);
    expect(motion).not.toEqual(sensor);
  });

  it("gives the same stream the same sequence regardless of creation order", () => {
    const first = createRng(55, "sensor");
    const before = Array.from({ length: 30 }, () => first.next());

    // Consume an unrelated stream in between; the sensor stream must be unaffected.
    const other = createRng(55, "clutter");
    for (let i = 0; i < 500; i++) other.next();

    const second = createRng(55, "sensor");
    const after = Array.from({ length: 30 }, () => second.next());
    expect(after).toEqual(before);
  });
});

describe("seed mixing", () => {
  it("hashes strings distinctly", () => {
    expect(hashString("motion")).not.toBe(hashString("sensor"));
  });

  it("is stable for the same input", () => {
    expect(hashString("clutter")).toBe(hashString("clutter"));
  });

  it("mixes seed and salt to distinct values", () => {
    expect(mixSeed(1, 2)).not.toBe(mixSeed(2, 1));
  });
});

describe("Rng helpers", () => {
  it("int respects its bound", () => {
    const rng = createRng(11);
    for (let i = 0; i < 2000; i++) {
      const v = rng.int(10);
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThan(10);
    }
  });

  it("int returns 0 for a non-positive bound rather than throwing", () => {
    expect(createRng(1).int(0)).toBe(0);
    expect(createRng(1).int(-5)).toBe(0);
  });

  it("intBetween is inclusive at both ends and never exceeds them", () => {
    const rng = createRng(21);
    const seen = new Set<number>();
    for (let i = 0; i < 5000; i++) {
      const v = rng.intBetween(3, 6);
      expect(v).toBeGreaterThanOrEqual(3);
      expect(v).toBeLessThanOrEqual(6);
      seen.add(v);
    }
    expect([...seen].sort()).toEqual([3, 4, 5, 6]);
  });

  it("intBetween collapses to min when max <= min", () => {
    expect(createRng(1).intBetween(5, 5)).toBe(5);
    expect(createRng(1).intBetween(5, 2)).toBe(5);
  });

  it("floatBetween respects its range", () => {
    const rng = createRng(31);
    for (let i = 0; i < 2000; i++) {
      const v = rng.floatBetween(-2, 5);
      expect(v).toBeGreaterThanOrEqual(-2);
      expect(v).toBeLessThan(5);
    }
  });

  it("chance is deterministic at the extremes", () => {
    const rng = createRng(41);
    expect(rng.chance(0)).toBe(false);
    expect(rng.chance(1)).toBe(true);
    expect(rng.chance(1.5)).toBe(true);
    expect(rng.chance(-1)).toBe(false);
  });

  it("chance(0.5) is near 50% over many trials", () => {
    const rng = createRng(43);
    let hits = 0;
    const n = 20_000;
    for (let i = 0; i < n; i++) if (rng.chance(0.5)) hits++;
    expect(Math.abs(hits / n - 0.5)).toBeLessThan(0.02);
  });

  it("pick returns an element of the input", () => {
    const rng = createRng(51);
    const items = ["a", "b", "c"] as const;
    for (let i = 0; i < 500; i++) expect(items).toContain(rng.pick(items));
  });

  it("pick throws on an empty array rather than returning undefined", () => {
    expect(() => createRng(1).pick([])).toThrow(/empty/);
  });

  it("weighted respects the weight ratio", () => {
    const rng = createRng(61);
    let a = 0;
    const n = 20_000;
    for (let i = 0; i < n; i++) if (rng.weighted(["a", "b"], [3, 1]) === "a") a++;
    expect(a / n).toBeCloseTo(0.75, 1);
  });

  it("weighted ignores non-normalised weights", () => {
    const rng = createRng(62);
    const counts = { a: 0, b: 0 };
    const n = 4000;
    for (let i = 0; i < n; i++) counts[rng.weighted(["a", "b"] as const, [30, 10])]++;
    expect(counts.a / n).toBeCloseTo(0.75, 1);
  });

  it("weighted rejects mismatched and degenerate inputs", () => {
    const rng = createRng(63);
    expect(() => rng.weighted(["a"], [1, 2])).toThrow(/same length/);
    expect(() => rng.weighted(["a", "b"], [0, 0])).toThrow(/not all be zero/);
    expect(() => rng.weighted([], [])).toThrow(/empty/);
  });

  it("normal has the requested mean and spread", () => {
    const rng = createRng(71);
    const n = 50_000;
    let sum = 0;
    let sumSq = 0;
    for (let i = 0; i < n; i++) {
      const v = rng.normal(5, 2);
      sum += v;
      sumSq += v * v;
    }
    const mean = sum / n;
    const variance = sumSq / n - mean * mean;
    expect(mean).toBeCloseTo(5, 1);
    expect(Math.sqrt(variance)).toBeCloseTo(2, 1);
  });

  it("state() advances and differs between streams", () => {
    const a = createRng(81, "motion");
    const s0 = a.state();
    a.next();
    expect(a.state()).not.toEqual(s0);
    expect(createRng(81, "sensor").state()).not.toEqual(s0);
  });
});

describe("unitVector3", () => {
  it("returns a unit-length vector", () => {
    const rng = createRng(91);
    for (let i = 0; i < 500; i++) {
      const v = unitVector3(rng);
      expect(Math.hypot(v.x, v.y, v.z)).toBeCloseTo(1, 6);
    }
  });

  it("spreads z across the full range", () => {
    const rng = createRng(92);
    let minZ = Infinity;
    let maxZ = -Infinity;
    for (let i = 0; i < 2000; i++) {
      const z = unitVector3(rng).z;
      minZ = Math.min(minZ, z);
      maxZ = Math.max(maxZ, z);
    }
    expect(minZ).toBeLessThan(-0.9);
    expect(maxZ).toBeGreaterThan(0.9);
  });
});

describe("createRngBundle", () => {
  it("exposes each named stream independently", () => {
    const b = createRngBundle(123);
    const motionBefore = b.motion.state();
    b.sensor.next();
    b.clutter.next();
    // Consuming other streams must not perturb motion.
    expect(b.motion.state()).toEqual(motionBefore);
  });

  it("gives identical bundles for identical seeds", () => {
    const a = createRngBundle(777);
    const b = createRngBundle(777);
    expect(a.motion.next()).toBe(b.motion.next());
    expect(a.response.next()).toBe(b.response.next());
  });

  it("streams(name) returns a stable stream for that name", () => {
    const b = createRngBundle(5);
    expect(b.stream("custom").next()).toBe(b.stream("custom").next());
    expect(b.stream("custom").next()).not.toBe(b.stream("other").next());
  });
});