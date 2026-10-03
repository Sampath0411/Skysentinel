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
---

## D6 — Sensor platforms are placed relative to terrain, not at a fixed altitude (M2)

**Decision.** `observerAt(terrain)` returns the mast position as `terrain.obstructionAt(x, y) + MAST_HEIGHT_M`
rather than a constant z. There is no `DEFAULT_OBSERVER_POS` constant.

**Why.** A fixed z is not merely inaccurate, it is silently fatal. The first M2 sensor tests returned a
zero detection rate for every sensor and every range. At z=0 the observer sits inside the ground; at
z=30 it still sits inside the ground on any map whose terrain rises above 30 m at the origin — the
test map's origin was on a 59 m hill. Because LOS marches against `obstructionAt`, a platform buried
in terrain occludes every target and every sensor reports nothing while still looking correct in
review. Measuring the mast from local terrain is what real platforms do, and it makes the failure mode
impossible rather than merely unlikely.

---

## D7 — Track correlation is gate-based only; `truth_ref` never links observations (M2)

**Decision.** `createTracker` correlates observations purely by the PRD §9.3 gate (bearing ±8°,
range ±15% or ±150 m). `truth_ref` is recorded on the track for scoring but is never consulted when
deciding whether two observations belong together.

**Why.** The tracker originally fell back to matching on `truth_ref`, which merged two targets 180°
apart into one track whenever they happened to share an entity id. Beyond being wrong, it violates the
truth-leak boundary in spirit: the fusion layer would be using oracle information to make an
operational decision. Scorers may read `truth_ref` after the fact; the physics may not.

---

## D8 — Fusion keeps the best confidence per source, not the evidence list (M2)

**Decision.** Each track carries `best_by_source: Map<SensorId, number>`, which is what fusion
combines, plus a bounded `evidence` window (32 observations) for the AAR.

**Why.** `1 − Π(1 − c_i)` is only valid across *independent* sources. Recomputing it from every
retained observation would let one radar returning every 50 ms masquerade as strong corroboration and
drive confidence toward 1. Keying on the best value per sensor makes the independence assumption
explicit, and it means the retained evidence window can be bounded instead of growing for the length of
the scenario.

---

## D9 — World update order is fixed and documented (M2)

**Decision.** `world.ts` ticks in a fixed order: spawn → behaviour → swarm rule → impacts → drills →
1 Hz truth state. The order is part of the simulation's contract, not an implementation detail.

**Why.** Anything that draws randomness or mutates shared state makes update order observable in the
event log. Two systems updated in the opposite order would produce different logs for the same seed,
which would read as a determinism bug. Naming the order here means changing it is a deliberate act with
a documented blast radius.

---

## D10 — `flight_plan` joins the sensor vocabulary in `shared` (M2)

**Decision.** `SENSOR_IDS` gains `flight_plan`, alongside `visual`, `ir`, `radar`, `rf`.

**Why.** PRD §9.2 lists flight-plan as one of the five sensors, so it needs to be representable in the
event catalogue and the sensor suite. It is the deconfliction channel and the only source that cannot
produce a false alarm, which is what makes ignoring it scoreable as a critical error. Adding the id in
`shared` rather than only in `sim-core` keeps the vocabulary single-sourced.
