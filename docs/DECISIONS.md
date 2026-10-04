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

---

## D11 — Radar detection probability has no independent RF-noise term (M2)

**Decision.** `radar.ts` detection probability is built from range, aspect, RCS, environment and
terrain masking only. The `rf` stream no longer feeds a separate noise multiplier into radar
detection. RF is instead a sensor in its own right: `rf.ts` produces the emissions and geolocation
observations that feed classification.

**Why.** Radar and the RF sensor were originally two readings of the same physical fact — whether
something is radiating — which double-counted it. That had two costs. A scenario with a strong jammer
or a dense RF environment suppressed radar as well, so an `rf` failure mode silently became a radar
failure mode; and it made the two sensors perfectly correlated, which defeats the point of a
multi-sensor fusion trainer where corroboration across *independent* sources is the thing being
taught (cf. D8). Keeping radar a radar and RF an RF sensor is also what makes an `rf` outage a
recognisably different exercise from a `radar` outage.

---

## D12 — Corroboration and visibility are separate thresholds (M2)

**Decision.** Track `confirmed` status requires two *distinct* sensor sources (D7/D8), while
`track.confidence` is a separate continuous quantity from `1 − Π(1 − c_i)`. A track can be
high-confidence on one source without being confirmed, and confirmed without being high-confidence.

**Why.** Conflating "we believe this assessment" with "we have seen this from more than one place"
makes the fusion rule either too strict (demanding high confidence before corroboration, so a weak
but consistently-observed target never confirms) or too loose (confirming on repeated sightings from
one sensor, which is exactly the D8 failure mode). PRD §9.3 asks for both properties and they are
genuinely different, so they are modelled as different numbers.

---

## D13 — Rule 5 measures arrival, not issuance (M2)

**Decision.** Every timing rule in `data/doctrine.json` measures the interval from when the *event
reached the relevant actor* to when the trainee responded. Where a rule's clock should start at
issuance instead, the rule carries an explicit `clock` field rather than relying on the default.

**Why.** With RF and comms delay modelled, "time to classify" is ambiguous: a cue that fires at
t=10 s but whose track does not become usable until t=18 s cannot be classified at t=11 s, and
scoring the gap as the trainee's delay would punish them for the sensor model. Anchoring on arrival
measures the decision the trainee actually made. Making the default explicit means a future rule can
opt out of it visibly instead of by accident.

---

## D14 — Scenario schema gained an `injects` array (M3)

**Decision.** `Scenario` accepts `injects: { at_t_ms, type, params }[]`, applied by the session
harness in time order. `type` is a closed set (`sensor_outage`, and room for M7's generated
perturbations); unknown types emit `inject_applied` and are otherwise inert rather than throwing.

**Why.** FR-SIM-9 requires runtime perturbations, and M7's generator needs to produce them
procedurally. Without them in the schema a generator could only vary the opening state, so every
generated scenario would be a static picture. Inert-unknown is deliberate: a generated scenario
carrying an inject type this build does not implement should still run, because a trainer that
refuses to start over an unrecognised annotation is worse than one that ignores it.

---

## D15 — Time of day is a single `dusk` level, not a `day`/`dusk` pair (M3)

**Decision.** `data/difficulty.json` carries one lighting level, `dusk`. There is no `day` level.

**Why.** Day and dusk differ mainly in whether EO/IR are usable at all, and a scenario where the EO/IR
operator is blind is a different exercise, not a harder version of the same one. Keeping both would
have meant difficulty quietly controlling sensor availability, which is scenario authoring's job
(`sensors` modes in the scenario, already used for the scripted `failed` sensors). The rename from
the PRD's `day` keeps the vocabulary honest about what the level models.

---

## D16 — The session harness lives in sim-core, not bots (M3)

**Decision.** `packages/sim-core/src/session.ts` owns the authoritative trainee-facing loop: world
tick → sensors → fusion → knowability → authority, plus `TraineeControls`. The bots package supplies
policies and `build.ts`, and imports it.

**Why.** Three callers need the identical loop — the bots (now), the M5 server driving a live session
from socket messages, and capped/fuzz runs. `@skysentinel/scenario` depends on `sim-core`, so
`session.ts` cannot import the `Scenario` type without a cycle; it takes a structural `SessionSpec`
instead and `build.ts` adapts. That is the one concession: the alternative — a harness in `bots` —
would make the server depend on the bot package, which is not what that package is for.

---

## D17 — `track_update` is sampled at 1 Hz, but status changes always emit (M3)

**Decision.** Track state is emitted on a 1 Hz boundary (`TRACK_UPDATE_PERIOD_MS`), matching the
`entity_state` cadence. `track_lost` and `track_reacquired` are emitted immediately on transition.

**Why.** Emitting every track every tick produced 18 538 `track_update` events for one 15-minute
scenario, making the event log the largest artefact the system produces and a JSONL replay unreadable.
A trainee-facing stream does not need 20 Hz track state to act on. Status *changes* are excluded from
the sampling deliberately: losing and reacquiring a track is the event a trainee must notice, and it
must not fall between two 1 Hz boundaries.

---

## D18 — One authority request per track, and bots hold focus (M3)

**Decision.** `AuthorityState.queue` supersedes any pending request for the same track. Bot policies
keep a `focus` track and make at most one authority request per track, treating "requested, neither
pending nor granted" as a refusal.

**Why.** Both halves fix the same symptom — an operator re-asking forever. A bot that re-requests
every tick on an unconfirmed track generates 44 requests for one track and never acts, which scores as
noise rather than as the failure mode it represents. Superseding on re-request is also correct in its
own right: a trainee who revises their call to `unknown` after asking for hostile authority has
withdrawn the grounds, and granting on the stale grounds would be wrong. The bot-side `focus` is what
makes a track get worked to completion — the first version always picked the *best* undeclared track,
so no track ever reached a response.

---

## D19 — `contact_marked` carries only the cue id (M3, PRD §4)

**Decision.** `markContact` emits `{ cue_or_track_id }`. It does not link the contact to the track or
to the underlying truth entity.

**Why.** An earlier version emitted `linked_truth_id`, which is in `FORBIDDEN_TRAINEE_KEYS`. It would
have been stripped at the server boundary, but it was still ground truth sitting in an event whose
visibility is `trainee` — the boundary would have been doing the work that the emitter should have
done. The server can recover the link from the cue id, which is all a client needs, and the truth
correlation stays where the rule says it belongs: internal, for scoring only.

---

## D20 — Truth correlation is a scorer *input*, not a log field (M4, PRD §4, §6.4)

**Decision.** `ScoreInput` carries `correlation` (cue→truth, track→truth) and `truth` as arguments
alongside the event log. The log alone cannot be scored.

**Why.** The alternative — reading `truth_ref` out of the events as the scorer walks them — makes the
log self-sufficient, and a self-sufficient log is one that has to be filtered before it can be stored,
streamed or handed to a client. Keeping truth as a separate argument means the thing stored next to a
session is the same thing that can be sent to a trainee: an event stream with no answer key in it. The
server holds both halves and joins them at score time.

**Consequence.** `sensor_observation.truth_ref` is the one exception, and it is deliberate: that field
is documented on the event as internal-only and is stripped by `filterForRole` for trainees. It exists
so the server does not have to reconstruct observation correlation from scratch. The scorer reads it
because the scorer runs on the server, and `runScenario` keeps all of it in a `server_side` block that
`toJsonl` names field-by-field and does not serialise.

---

## D21 — N9 normalises against its own ceiling, not 100 (M4, PRD §10.3)

**Decision.** `scoreCoordination` divides the rubric's coordination credits by the sum of those credits
(`brief_credit + owner_assigned_credit + cop_update_credit`, read from data) rather than by 100.

**Why.** The rubric expresses coordination as three independent credits that deliberately do not sum to
100 — they are a checklist, not a curve. Dividing a 50-point maximum by 100 capped a *perfectly*
coordinated trainee at 50/100 forever, which cost 2.5 of the 5 points PRD §10.2 assigns to the
dimension for doing everything right. Deriving the ceiling from the same data that awards the credits
means a rubric author adding a fourth credit changes the ceiling and the score together; they cannot
drift.

---

## D22 — An unassessed competency is excluded, not scored zero (M4, PRD §10.2)

**Decision.** A competency whose nodes are all zero-max is returned with `assessed: false`, contributes
zero to the weighted sum, and the remaining weights are renormalised over `100 / assessed_weight`.

**Why.** N8 emits zero-max when only one contact needed attention and N10 when nothing was lost. Both
are "there was nothing to judge". Charging a trainee the 5 points of `adaptation` for a track that was
never lost made the score depend on the scenario as much as on the trainee. The alternative — awarding
full marks — was rejected: a passive trainee acted on no track at all, which would have earned free
marks in a dimension about *how* attention was spent.

**Consequence.** `CompetencyScore` carries `assessed` explicitly and `coach.ts` has a `not_assessed`
band separate from `absent`, because "nothing tested it" and "they failed it" must not read the same
way to a trainee. `points` stays numeric (0) so consumers need no null handling, but the AAR must read
`assessed`, not the number.

---

## D23 — A reported position is judged against what the sensors had shown (M4, PRD §10.3 N6)

**Decision.** N6 compares a report's bearing and range against the latest genuine `sensor_observation`
at or before the report's own timestamp. False/clutter observations are excluded when the facts are read.

**Why.** Neither truth nor the final picture is a fair yardstick. Truth penalises a correct report for a
contact the sensors had not yet located; the last observation in the run penalises it for the contact
having flown on afterwards. "What you could see when you sent it" is the only rule that treats every
trainee identically, and it is the rule a trainee would apply to themselves.

**Consequence.** `TrackFacts` accumulates a time-ordered `observations` list rather than a single
"latest" pair. If the sensors had nothing at all before the report, position scores zero and says so in
the reason string rather than silently awarding or withholding the points.

---

## D24 — A reported activity is judged on being an assessment, not on being right (M4, PRD §9.4, §10.3 N6)

**Decision.** N6 scores a report's `activity` field for being a substantive description — anything but a
short, fixed list of placeholders (`unknown`, `n/a`, `tbd`, and similar) — rather than for matching the
entity's `intent`.

**Why.** The previous rule required the reported activity to contain the truth `intent`, which the
trainee cannot see (PRD §4). A trainee who accurately described what they could observe was marked down
for not guessing the word in the answer key, and one who guessed it was rewarded for knowing something
they had no way of knowing. This is the §9.4 knowability rule stated exactly as the rest of the rubric
applies it: score against what was knowable, not against what was true.

Whether the activity was *correct* is already scored, and against evidence rather than truth: N5 grades
the declaration, and N6's `presence_points` reward carrying the field at all. So the rule here checks the
one thing a log can fairly check — that the trainee committed to a judgement instead of passing the
question back up the chain. A placeholder is a real failure: it tells the chain operator nothing, and
withholding a judgement is not the same as being wrong.

**Consequence.** The placeholder list is deliberately short and closed, and must not grow. This is not a
natural-language classifier; scoring is deterministic rules only (CLAUDE.md), and a fuzzy synonym list
would make the rubric's behaviour depend on phrasing it never declared. Anything not on the list counts as
an assessment and is graded by N5. `TraineeControls.report` therefore accepts `activity` and
`description` as free text and records them verbatim.

---

## D25 — The mission brief is a control the trainee opens, and opening it is the scored act (M4, PRD §7.1)

**Decision.** `TraineeControls.viewBrief(sections?)` emits a `brief_viewed` event. Called bare it opens
every heading the scenario offers; called with a list it opens those it recognises and silently drops the
rest. `Scenario.brief_sections` declares which headings exist.

**Why.** N4 and N9 both score briefing discipline, and until this control existed the credit was
unreachable on a real run — every bot scored zero on it, so the rubric node was untestable rather than
merely unpassed.

Defaulting to the whole brief is the load-bearing choice. A console that made the trainee tick each
heading to earn the credit would be measuring clicking, not preparation, and would train a bot to open a
brief for the points. N9 asks whether the brief was consulted before deciding; it does not ask how many
tabs were opened.

**Consequence.** `BRIEF_DISCIPLINE` models each profile's likelihood of reading it, with
`trigger_happy` at 0 — the profile that goes straight to the scope is precisely the habit being trained
out. `brief_sections` is per-scenario rather than global because the heading list is what the console
renders: a short scenario with nothing to say about friendly flights should not open an empty tab, and
an empty tab that pays N9 credit would be worse than none.

---

## D26 — Bot discipline is drawn once per track, not re-rolled per tick (M3, PRD §11.1)

**Decision.** `commits(cache, rng, track_id, p)` draws a bot's willingness to report or warn on a track
once and remembers it for the rest of the run. The draw still comes from the seeded RNG, so runs stay
reproducible.

**Why.** This was `rng.chance(p)` re-rolled on every tick, which made a discipline a per-tick coin flip
rather than a property of the operator. The visible symptom: a bot gets about ten decision ticks on a
track it is working, so a probability of 0.35 resolved to "declined" for most tracks it ever touched,
and it finished runs having reported nothing at all. That is not passivity, it is muteness — and it
scored `passive` *below* the pure-noise `random` control, which is the ordering the M4 DoD asserts should
not happen.

With one draw per track the number means what the rubric tables say it means: the share of contacts this
operator bothers to pass up the chain.

**Consequence.** `REPORT_DISCIPLINE.passive` was raised from 0.15 to 0.35 alongside this, and is
documented at its definition. A passive operator is *more* likely to report than a random one, because
reporting is not the hard part — acting on it is.

---

## D27 — The §10.7 ordering is asserted on the aggregate, the safety invariants per scenario (M4, PRD §14 M4 DoD)

**Decision.** `expert > novice > passive ≈ random` is asserted on the mean total across all three
scripted scenarios. `expert > novice` and `trigger_happy` last are asserted per scenario. The
passive-vs-random band is one full competency weight (10, PRD §10.2's reporting).

**Why.** A per-scenario assertion asked the test to be lucky rather than correct. `random` picks its
category uniformly from six; on the two-track deconfliction scenario it has a one-in-six chance of naming
the friendly's category correctly, and that single guess is worth up to 16 points of the 25-weight
classification competency. If it also reports both tracks it collects the entire 10-weight reporting
competency that `passive` does not. Thirteen points of swing, arriving from a coin flip, is variance in
the measurement — not a scorer that has formed an opinion about passivity.

The band is the reporting weight rather than an arbitrary tolerance, because reporting is the *only*
dimension on which the PRD separates the two profiles: §10.2 scores both as weak response behaviour
everywhere else. A band narrower than one whole competency would assert the scorer can tell them apart
better than the rubric can.

**Consequence.** The two per-scenario invariants are asserted because they hold regardless of what any
individual bot guessed — no arrangement of two or three contacts reverses "corroborate, classify
honestly, wait for authority, report" against "guess", and the critical-error penalties are absolute
rather than weighted. A fourth test asserts the table is actually spread (`expert > 50`,
`trigger_happy == 0`), so that every ordering assertion cannot pass trivially against a scorer that gave
all five trainees the same number.

---

## D28 — The flight-plan feed reports true position, and correlation picks the nearest track (M2, PRD §9.3)

**Decision.** `flight_plan` observations carry `bearingDeg(observer, entity)` and `range2d`. The tracker
ranks in-gate candidates by squared bearing error and associates with the minimum.

**Why.** Both were defects found only by the end-to-end ordering probe, and neither was visible in the
shaped-log fixtures.

The plan feed hardcoded `bearing_deg: 0`. Defensible as a *policy* statement — "this entity is on the
plan" — and wrong as a *position*: correlation is gate-based on bearing, so every listed flight landed
90°+ from the radar return for the same aircraft and opened its own track. An operator saw a friendly as
two contacts, one with a plan and one without a radar return, and the deconfliction channel deconflicted
nothing. The bots' only way to behave well was to ignore the track that named the friendly.

Taking the *first* in-gate track rather than the nearest is nearest-neighbour association done wrong. The
observation list is sorted by id, so in the urban swarm scenario — where a decoy and the friendly's plan
return pass through one gate for a few seconds — whichever track sorted earlier absorbed the plan
observation. A hostile decoy ended up carrying `flight_plan` as a source, so a competent bot read the
hostile as an authorised flight and stood down. Ordering in the tracker list is not evidence of
proximity.

Ranking on bearing alone is deliberate: range is frequently unmeasured (the RF sensor reports none), so a
distance metric that fell back to range would silently ignore whichever candidate had one. Bearing is
always available, so the ranking is always the same comparison.

**Consequence.** Both are now pinned by tests — `sensors.test.ts` table-drives the four quadrants from a
known origin, `fusion.test.ts` asserts nearest-neighbour association and asserts that a ranged track does
not win on range when it is the worse bearing match.

---

## D29 — Sensors see only entities that exist yet (M2, PRD §9.2)

**Decision.** The session filters the entity list handed to the sensors on `t_ms >= spawn_t_ms`,
alongside the `neutralised` and `landed` checks every sensor already did.

**Why.** Each sensor only sees the list it is handed, and none of them check `spawn_t_ms` themselves — so
with no filter upstream, a drone authored to arrive at t=260 s was detectable from t=0, sitting at its
start position. That is not a scoring nuance: it gave the swarm scenario's neutral civilian a track from
t=45 s, and a bot that correctly classified everything it could see was then punished for calling a
long-dormant civilian a threat. The scenario said the civilian arrives late; the simulation had it on
scope the whole time.

**Consequence.** The swarm scenario's expert score went from 0 to 61 on this fix alone. Covered by two
tests in `session.test.ts`: no track exists before the spawn time, and one does exist after it — the
second because without it the first would also pass for a session whose sensors were simply dead.
