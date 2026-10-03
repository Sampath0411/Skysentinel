/**
 * Deterministic pseudo-random number generation (PRD §5.1 FR-SIM-1).
 *
 * Pure TypeScript: no Date.now(), no Math.random(), no crypto. Same seed ⇒ same
 * stream, always, on any engine.
 *
 * ## Named streams (DECISIONS.md D1)
 *
 * A single shared stream would mean that adding one draw anywhere shifts the
 * sequence for every later draw everywhere. Adding a radar false-alarm roll would
 * silently change every drone's trajectory and invalidate every golden test.
 *
 * Instead, each stochastic *system* draws from its own named stream, seeded by
 * mixing the run seed with the stream name. Systems are then independently
 * extensible: changing the number of draws in `clutter` cannot perturb `motion`.
 *
 * The trade-off is deliberate and recorded: adding a draw to an *existing* stream
 * still changes that stream's output. New stochastic features should therefore
 * prefer a new named stream.
 */

/** A uniform source of randomness in [0, 1). */
export interface Rng {
  /** Next uniform value in [0, 1). */
  next(): number;
  /** Next integer in [0, maxExclusive). */
  int(maxExclusive: number): number;
  /** Next integer in [min, max] inclusive. */
  intBetween(min: number, max: number): number;
  /** Next float in [min, max). */
  floatBetween(min: number, max: number): number;
  /** True with probability `p`. */
  chance(p: number): boolean;
  /** Uniformly pick one element. Throws on an empty array. */
  pick<T>(items: readonly T[]): T;
  /** Pick using relative weights. Weights need not be normalised; must be > 0. */
  weighted<T>(items: readonly T[], weights: readonly number[]): T;
  /** Standard normal via Box-Muller. Cached second value is not reused, to keep
   *  the draw count per call constant and stream arithmetic simple. */
  normal(mean?: number, stdDev?: number): number;
  /** Current internal state, for snapshot/compare in tests. */
  state(): number[];
}

/** String hash (FNV-1a) used to mix a stream name into the seed. */
export const hashString = (s: string): number => {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
};

/** Mix two 32-bit values into one, so (seed, name) separates cleanly. */
export const mixSeed = (seed: number, salt: number): number => {
  let h = (seed ^ Math.imul(salt ^ 0x9e3779b9, 0x85ebca6b)) >>> 0;
  h = Math.imul(h ^ (h >>> 16), 0x2545f491) >>> 0;
  h = Math.imul(h ^ (h >>> 15), 0x27d4eb2f) >>> 0;
  return (h ^ (h >>> 15)) >>> 0;
};

/**
 * sfc32 — small, fast, statistically sound counter-based PRNG.
 * Passes PractRand; 128-bit state, ~2^32 period per stream in practice.
 */
const sfc32 = (a: number, b: number, c: number, d: number) => {
  let s0 = a >>> 0;
  let s1 = b >>> 0;
  let s2 = c >>> 0;
  let s3 = d >>> 0;

  const next = (): number => {
    s0 >>>= 0;
    s1 >>>= 0;
    s2 >>>= 0;
    s3 >>>= 0;
    let t = (s0 + s1) | 0;
    s0 = s1 ^ (s1 >>> 9);
    s1 = (s2 + (s2 << 3)) | 0;
    s2 = (s2 << 21) | (s2 >>> 11);
    s3 = (s3 + 1) | 0;
    t = (t + s3) | 0;
    s2 = (s2 + t) | 0;
    return (t >>> 0) / 4294967296;
  };

  // Discard the first values so low-entropy seeds (0, 1, 2…) do not produce
  // correlated first draws.
  for (let i = 0; i < 12; i++) next();

  return { next, state: () => [s0, s1, s2, s3] };
};

export const createRng = (seed: number, stream = "default"): Rng => {
  const salted = mixSeed(seed >>> 0, hashString(stream));
  // Four decorrelated 32-bit words from one salted seed.
  const s0 = mixSeed(salted, 0x243f6a88);
  const s1 = mixSeed(salted, 0x85a308d3);
  const s2 = mixSeed(salted, 0x13198a2e);
  const s3 = mixSeed(salted, 0x03707344);
  const gen = sfc32(s0, s1, s2, s3);

  const rng: Rng = {
    next: gen.next,
    state: gen.state,

    int(maxExclusive: number): number {
      if (maxExclusive <= 0) return 0;
      return Math.floor(gen.next() * maxExclusive);
    },

    intBetween(min: number, max: number): number {
      if (max <= min) return min;
      return min + Math.floor(gen.next() * (max - min + 1));
    },

    floatBetween(min: number, max: number): number {
      return min + gen.next() * (max - min);
    },

    chance(p: number): boolean {
      if (p <= 0) return false;
      if (p >= 1) return true;
      return gen.next() < p;
    },

    pick<T>(items: readonly T[]): T {
      if (items.length === 0) throw new Error("Rng.pick called with an empty array");
      return items[Math.floor(gen.next() * items.length)] as T;
    },

    weighted<T>(items: readonly T[], weights: readonly number[]): T {
      if (items.length === 0) throw new Error("Rng.weighted called with an empty array");
      if (items.length !== weights.length) {
        throw new Error("Rng.weighted: items and weights must be the same length");
      }
      let total = 0;
      for (const w of weights) {
        if (w < 0) throw new Error("Rng.weighted: weights must be >= 0");
        total += w;
      }
      if (total <= 0) throw new Error("Rng.weighted: weights must not all be zero");

      let roll = gen.next() * total;
      for (let i = 0; i < items.length; i++) {
        roll -= weights[i] as number;
        if (roll < 0) return items[i] as T;
      }
      return items[items.length - 1] as T;
    },

    normal(mean = 0, stdDev = 1): number {
      // Box-Muller. u1 is nudged off zero so log() is finite.
      const u1 = Math.max(gen.next(), Number.EPSILON);
      const u2 = gen.next();
      return mean + stdDev * Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2);
    },
  };

  return rng;
};

/** Named streams in use, matching DECISIONS.md D1. */
export const RNG_STREAMS = {
  motion: "motion",
  sensor: "sensor",
  clutter: "clutter",
  response: "response",
  spawn: "spawn",
} as const;

export type RngStreamName = (typeof RNG_STREAMS)[keyof typeof RNG_STREAMS];

/**
 * A bundle of the named streams for one simulation run.
 *
 * Systems take the bundle and pull the stream they need, so the mapping from
 * "which stream feeds which decision" is visible at every call site.
 */
export interface RngBundle {
  motion: Rng;
  sensor: Rng;
  clutter: Rng;
  response: Rng;
  spawn: Rng;
  /** Get an arbitrary additional stream by name. */
  stream(name: string): Rng;
}

export const createRngBundle = (seed: number): RngBundle => ({
  motion: createRng(seed, RNG_STREAMS.motion),
  sensor: createRng(seed, RNG_STREAMS.sensor),
  clutter: createRng(seed, RNG_STREAMS.clutter),
  response: createRng(seed, RNG_STREAMS.response),
  spawn: createRng(seed, RNG_STREAMS.spawn),
  stream: (name: string) => createRng(seed, name),
});

/** A uniform point on the unit sphere, for jitter directions. */
export const unitVector3 = (rng: Rng): { x: number; y: number; z: number } => {
  // Marsaglia's method: uniform on sphere without trig.
  let x1 = 0;
  let x2 = 0;
  let s = 2;
  while (s > 1 || s === 0) {
    x1 = rng.floatBetween(-1, 1);
    x2 = rng.floatBetween(-1, 1);
    s = x1 * x1 + x2 * x2;
  }
  const f = 2 * Math.sqrt(1 - s);
  return { x: x1 * f, y: x2 * f, z: 1 - 2 * s };
};