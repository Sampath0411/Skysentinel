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

---

## D30 — Instructor injects share one code path with authored injects (M5, PRD §13.2 / §15, FR-SIM-9)

**Decision.** `Session.applyInject(type, params, by)` is the single entry point: the runtime
`POST /api/sessions/:id/inject` route calls it, and the authored-scenario path (`spec.injects`) calls the
same function instead of its own loop. Every inject emits `inject_applied` at `instructor` visibility.

**Why.** The inject menu is the largest feature gap the audit found, and the failure mode that made it
worth doing properly is drift: a second implementation of "what a weather change does" would eventually
disagree with the one the scenario files use, and a scripted and an injected rain squall on the same
scenario would produce different sensor factors. One function cannot drift from itself.

**Consequence.** Four of the five `INJECT_TYPES` mutate real sim state and are asserted in
`session.test.ts` (sensor `failed`, environment factors re-resolved, `comms_delay_s`, authority posture);
`new_track` needs a world spawn surface that does not exist yet and is out of scope for this pass. The
server test asserts only the boundary — applied vs. refused — and refuses before mutating when the
session is in assessment mode, which is the §13.2 rule made testable.

---

## D31 — The mandated-three AAR card is computed in scoring, not in the client (M5, PRD §12.2)

**Decision.** `ScoreResult.mandated` carries the detection time / classification accuracy / response
decision summary, derived in `packages/scoring/src/mandated.ts` from `RunFacts` and the score tree. The
AAR card renders it.

**Why.** The three numbers the PRD asks for come from correlation against truth — `par_detect_s`, the
*final* declaration per track, the defensible-category set — and `RunFacts` never leaves the server.
Deriving them in the client would mean either parsing node reason strings (fragile: the wording is
display copy, not an API) or shipping truth to the browser, which the knowability boundary forbids. The
choice that keeps the boundary is to compute where the facts live.

**Consequence.** The card cannot disagree with the score explanation beside it, because it is built from
the same nodes; `mandated.test.ts` asserts that `response` equals the N7 node counts rather than
re-deriving them. Detection grades mirror `scoreDetection`'s bands exactly, and one test asserts the two
agree so a future band change has to touch both.

---

## D32 — Timeline colour is the score verdict, and uncited events keep their type colour (M5, PRD §12.2)

**Decision.** The AAR timeline takes a `seq → pass | fail` map off the score tree and uses it to colour
markers; a seq the tree never cites keeps the colour its event type always had. The `Legend` component
that nothing imported now keys the strip.

**Why.** §12.2 says "colour = verdict", and the strip sits beside the per-node explanation — so a
marker coloured by event type would read as a disagreement with the score. But a sensor update or a cue
has no verdict; colouring it pass/fail would invent a judgement the score did not make. Only scored
nodes (`max_points > 0`) contribute, and fail wins over pass where a seq is cited twice.

**Consequence.** A new event type renders with no verdict until something scores it, which is the
correct default rather than a gap to fill. Pinned in `Timeline.test.tsx`.

---

## D33 — Client tests cover the pure view models first (M5, CLAUDE.md "add a test with every behaviour")

**Decision.** `apps/client` gained Vitest + React Testing Library with `fileParallelism: false` (a
browser env is heavier than node, and these are unit-shaped tests). The first suites are `format.ts`,
`types.ts` and `api.ts`, then the components the UI work touched; both apps are now in
`vitest.workspace.ts` so the root `pnpm test` covers them.

**Why.** The client had zero tests and no runner, and the pure helpers are where a regression is most
likely to ship unnoticed — a clock that rounds the wrong way is a wrong number on a screen a trainee
times a decision against. That is not hypothetical: writing the first suite found two real defects.

**Consequence.** `fmtClockTenths` rounded `toFixed(1)` on the seconds and rendered 59.96 s as
`00:60.0`; it now floors integer tenths. And `eventClass` had a dead branch — the
`response_effect_resolved → critical` exact match sat below the broader
`includes("response_effect") → authority` check, so the outcome of a kinetic response coloured as a
permission row. Both are pinned with boundary tests.

---

## D34 — A non-attacking programme must not enter an asset's impact radius (M3, PRD §8.4 rule 6)

**Decision.** Rule 6 gained `non_attacker_in_impact_radius`. It flies an entity's programme as the
behaviour engine does — each step measured from where the previous one left it — and reports the closest
approach of that occupied region to every asset, unless the programme contains an approach state
(`approach_direct`, `terrain_masked_approach`, `land`).

**Why.** The sim's impact rule is unconditional: any airborne entity inside an asset's `impact_radius_m`
damages it and is neutralised (`world.ts`), measured horizontally, regardless of intent or altitude. Two
of the three shipped scenarios authored against that rule without knowing it — a reconnaissance orbit
that passed 8 m *inside* the fuel point it was watching, and five "harmless" decoys whose hovers were
centred on the substation they were meant to draw fire from. The decoys destroyed it themselves at
t=46.9 s, before the main group arrived; the orbit ended the only track in the scenario 15 s after it
appeared. From the trainee's seat the simulation looked broken, and the AAR then reported a mission
outcome the author had not written.

**Consequence.** `scr-night-recon-01` now transits to its orbit and holds it 25 m clear of the fuel
point; `scr-urban-swarm-diversion-01` holds its decoys on the NE perimeter and routes the civil crossing
33 m clear of the operations centre. `closestApproachTo` treats an orbit or hover as the disc the
behaviour engine snaps onto, not the centre — a 90 m orbit around a point 60 m from an asset still
flies through it. Attackers are exempt because entering the radius is the whole point of an approach;
`scr-friendly-deconflict-01`'s intended impact on A1 still fires. Golden bot scores for the two edited
scenarios move with the geometry.

---

## D35 — Integration tests retire the session they opened (M5, CLAUDE.md "run tests before every commit")

**Decision.** `ws.test.ts` and `sessions.test.ts` both record the sessions `startSession` opens, and an
`afterEach` posts `/end` for all of them.

**Why.** Every test in those files starts a live session at `speed: 6000`/`8000` and nothing stopped it, so
each one left a sim stepping a 420 s scenario as fast as the CPU would allow for the rest of the file. The
tests that assert on wall clock were the ones that broke, and they broke *deterministically* — run alone,
with nothing else on the machine, two of the three still failed. Instrumenting the socket showed the server
behaving correctly throughout: `unauthenticated` frame at +99 ms, close at +442 ms. The budget was being
consumed by load the earlier tests had left running, not by a defect in the code under test.

**Consequence.** The two socket rejection tests finish in 659 ms and 939 ms instead of racing a 2 s budget
they used to miss, the completion test stops timing out at 30 s, the server suite drops from 271 s to 154 s,
and neither file is order-dependent: a test that runs slowly can no longer starve the next one. The
wall-clock budgets in `vitest.config.ts` stay, because these are integration tests driving real timer
loops and a busy machine is a genuine failure mode — the fix is to stop paying for work no test needs.

---

## D36 — A bodyless POST must not claim a JSON content-type (M5, PRD §15)

**Decision.** `api()` sets `Content-Type: application/json` only when `init.body` is defined.

**Why.** Fastify's parser rejects an empty body outright when the content-type says JSON
(`FST_ERR_CTP_EMPTY_JSON_BODY`, HTTP 400). The client's `startSession`, `pauseSession` and `resumeSession`
send no body, so all three returned 400 and **the simulation could not be started from the UI at all** — the
console rendered a live-looking session that never moved past t=0. The failure was invisible to the server
suite because those tests call the route through Fastify's own injector, which sets no content-type on a
bodyless request; only a real `fetch` from the browser sent the header.

**Consequence.** Start, pause and resume work from the UI, and the launch path starts the session it
creates. Two tests pin it: `api.test.ts` asserts the header is absent without a body and present with one,
and `Home.test.tsx` asserts `create` then `start` happen in that order — the second test exists because
launching previously created a session and navigated without starting it.

---

## D37 — A stored token is validated before the app is shown (M5, PRD §17)

**Decision.** `AuthProvider` calls `/me` once at mount when a token is stored, and shows neither the app nor
the login form until it answers. A rejected or unreachable check clears the token and the stored user.

**Why.** Tokens are signed with a per-boot secret, so restarting the local server invalidates whatever the
browser holds — the intended behaviour, and `auth.tsx` said so in its own header comment. But nothing ever
checked. The app booted straight into "signed in" from `localStorage` and every request 401'd: the header
showed `admin` over a dead token, scenario lists stayed on "Loading…", and the only escape was clearing site
data by hand. The comment described a recovery path that was never wired up.

**Consequence.** A restarted server drops the user on the login form instead of a broken console, and a
genuinely signed-in user does not watch the app flash past the login prompt. `auth.test.tsx` covers the valid
token, the rejected token, the no-flash property and the empty-storage case.

---

## D38 — The 20 Hz sim drives the record; the render rate is decoupled (PRD §18 "Performance on weak laptops")

**Decision.** The server still steps at 20 Hz and still pushes one frame per tick. Nothing about the
simulation changed. The client buffers the last two frames and interpolates between them on each animation
frame, so the canvases redraw at the display's own refresh rate. Implemented in `apps/client/src/interpolate.ts`
(the pure maths), `useSmoothTracks.ts` (the React-facing buffer, handing the draw loops a stable reader rather
than state — putting a 60 Hz React render on five panels to move a few pixels is the opposite of a performance
win) and `EoScene.tsx` / `RadarCanvas.tsx` / `CopMap.tsx` / `TruthMap.tsx` (the draw loops).

**Why.** PRD §18 asks for "fixed 20 Hz sim decoupled from render" and §13.1 asks for smooth continuous
movement. The sim was already right; the *render* was coupled to it, which is what the §18 clause is there to
prevent. Every canvas drew the last frame's positions, so a 60 Hz monitor showed the same contact in the same
pixel for two frames out of three and teleported it on the third. `EoScene` compounded it: it cleared its blip
group and rebuilt every marker mesh, geometry and material, twenty times a second, and put each new marker at
the new position rather than moving the old one there.

**Two properties are deliberate and tested.** *Nothing is extrapolated* — every drawn position lies between two
positions the sim actually reported, so the client never invents a track location (CLAUDE.md: the server owns
the truth; the client is a view). And *the lag is one frame interval, 50 ms*, which is under the ~100 ms at
which added latency reads as sluggish; `MAX_LEAD_MS` caps how far the render clock may run past the newest
frame so a backgrounded tab or a dropped socket snaps forward instead of crawling.

**Consequence.** Contacts glide at 60 Hz while the event log keeps its 20 Hz resolution — the assessment record
is unaffected, and `pnpm sim:run` still produces a byte-identical log for the same scenario and seed. Cost is
one frame of display latency and a bounded buffer per client. The EO scene's markers are now created once per
track and restyled in place, which is cheaper than the rebuild it replaces. `interpolate.test.ts` (30 tests)
pins the invariance that no alpha in 0…1 ever draws a position the sim did not report.
