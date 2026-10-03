# Build decisions

Record of choices made while implementing the PRD. PRD §0.6 requires ambiguities to be resolved by
picking the simplest option that satisfies the acceptance criteria and recording it here.

Format: one entry per decision, newest last. Reference the PRD section that forced the choice.

---

## D1 — `sfc32` with named independent streams (PRD §5.1 FR-SIM-1, §9.2)

**Decision.** One PRNG family (`sfc32`), but each stochastic *system* draws from its own named stream,
seeded by `hash(seed, streamName)`. Streams: `motion`, `sensor`, `clutter`, `response`, `spawn`.

**Why.** A single shared stream means any new draw in one system shifts the sequence for every later
system, so adding a sensor feature silently changes drone trajectories and breaks golden tests. Named
streams make systems independently extensible while preserving full determinism.

**Consequence.** Two runs with the same scenario + seed produce identical logs as long as stream
*usage* is unchanged. Adding a draw to an existing stream still changes output — so each new
stochastic feature should add a new named stream where practical.

---

## D2 — Composite project references, ESM + NodeNext (PRD §6.1)

**Decision.** TypeScript `module: NodeNext`, ESM-only, project references for internal packages,
`tsc -b` for the workspace typecheck.

**Why.** Internal packages import each other by package name (`@skysentinel/sim-core`); NodeNext
resolution matches how Node actually loads the built ESM, so type errors surface the same way they
will at runtime. ESM-only avoids the `require`/`import` interop class of bug entirely.

**Consequence.** Relative imports in source need explicit `.js` extensions. Build order is derived
from the reference graph, so `pnpm -r build` and `tsc -b` agree.

---

## D3 — Entity update order is stable and id-sorted (PRD §5.1 FR-SIM-1)

**Decision.** Each tick, entities are updated in ascending entity-id order. Iteration never depends
on insertion order or on `Map`/`Object` key ordering of dynamically-created entities.

**Why.** Determinism is a hard requirement. If update order depended on spawn order and spawn order
depended on a stochastic roll, the same seed could produce two different worlds across JS engines
with different object-key ordering semantics.

---

## D4 — Apps scaffolded as empty workspace packages (PRD §6.2)

**Decision.** `apps/server`, `apps/client` and `apps/desktop` exist in M0 with a `package.json` and a
README stating the milestone that fills them (M5, M6, M9 respectively), but no code.

**Why.** PRD §6.2 defines the repo layout and M0's DoD requires the folder layout to match it. The
apps have no implementation until M5/M6/M9, so stubbing them keeps `pnpm -r` working without
pretending dependencies are installed.

---

## D5 — Sim time is integer milliseconds; no wall clock anywhere in core (PRD §7.2)

**Decision.** All sim timestamps are integer `t_ms`. Fixed 20 Hz tick (50 ms). `Date.now()` and
`performance.now()` are forbidden in the core packages; anything needing real time (session
`started_at`, AAR latency measurement) lives in `apps/server`.

**Why.** Sim time is integer ms so event logs compare byte for byte and the DB columns are exact.
Float seconds accumulate representation error, which breaks replay equality over long sessions.