# SkySentinel — workflow

The end-to-end path from a clean checkout to a scored after-action review, and the
rules that govern work in the tree. Written once the MVP runs in the browser.

Companion documents: `PRD_SkySentinel_MVP.md` (requirements — the source of truth),
`DECISIONS.md` (why each design choice was made, with its PRD clause).

---

## 1. The one-paragraph version

The server owns the simulation. It steps a fixed 20 Hz deterministic clock, emits
an append-only event log, and pushes role-filtered frames to browsers over a
WebSocket. The client is a **pure view** — it renders what it is told, sends actions
back, and never simulates or predicts. When a run ends, the scoring package grades
the log deterministically and the after-action review renders the result. Nothing
about the run depends on a model, a network call, or the wall clock.

---

## 2. Repository shape

```
packages/          pure TypeScript — no DOM, no fs/network, no Date.now/Math.random
  shared/          event + scenario types, the event log, the seeded PRNG
  sim-core/        world, sensors, behaviours, track fusion, authority, session
  scenario/        schema, Zod validator, fingerprint, scripted scenarios
  scoring/         the §10 decision tree, competencies, critical errors
  adaptive/        difficulty adaptation (empty for the MVP)
  bots/            five competence profiles + the headless runner
  ai-adapter/      offline model adapter (stubbed; never touches scores)
apps/
  server/          Fastify + ws + SQLite: the only owner of sim state
  client/          React + Vite + Three.js operator console
  desktop/         Electron packaging (deferred)
data/              doctrine lives here, never in code
  sensors.json, difficulty.json, rubrics/default-v1.json
  families/, scenarios/scripted/   (reserved — see §9)
```

The three shipped scenarios are **TypeScript modules**, not data files:
`packages/scenario/src/scripted/{night-recon-01, urban-swarm-diversion-01,
friendly-deconflict-01}.ts`. Each parses through the same Zod schema and validator
as an authored JSON scenario, so the two forms cannot diverge.

**The dependency rule that matters:** nothing in `packages/` may import `apps/`,
and no package may import another package's `dist/`. Core packages are pure so the
golden determinism tests can run them headless in milliseconds. If logic needs
testing, it belongs in a package, not in a `.tsx` file (CLAUDE.md: "keep UI thin").

---

## 3. Setup

```bash
pnpm install
```

Requires Node 22+ (the server runs TypeScript directly via
`--experimental-strip-types`). No CDN, no external fonts, no telemetry — the whole
app must work with the network cable pulled (PRD §18).

---

## 4. Running it

```bash
pnpm dev            # all packages + client + server in watch mode
```

Then open the server URL (default `http://localhost:8787`). On first boot with an
empty user store the server creates the default administrator and logs its
credentials: username `admin`, password `admin` (override with
`SKYSENTINEL_ADMIN_PASSWORD`) — `apps/server/src/main.ts:80`. Change it from the
admin console after first sign-in.

The server serves the built client from `apps/client/dist`, so if the page is blank
or stale, run `pnpm --filter @skysentinel/client build` and restart.

---

## 5. A full run, start to finish

1. **Sign in.** The client validates its stored token against `/api/me` at mount. The
   HMAC secret is regenerated per boot, so a server restart invalidates stored
   tokens and the client falls back to the login form rather than failing silently.

2. **Instructor starts a scenario.** From the instructor console, pick a scenario and
   Start. This is two calls, in this order: create the session, then `POST /start`.
   A session left at t=0 has no clock — the console looked live but never moved until
   `/start` was fixed (`Home.test.tsx` pins the ordering).

3. **The sim runs.** The server steps `TICK_MS = 50`. Each tick advances entities,
   samples sensors, fuses tracks, resolves authority, and appends events. One frame
   goes to each connected client, filtered by role.

4. **Trainee works the problem** in the console (`TraineeConsole.tsx`): EO/IR view,
   radar PPI, RF direction finding, COP map, track panel, classification, report,
   response panel, radio log. Hotkeys per PRD §13.1 — `Tab` cycle, `Space` mark at
   reticle, `R` report, `W`/`P` warn/drill, `A` request authority, `1`–`6` classify.

5. **The run ends** — by scenario time, by the trainee ending it, or by an instructor
   ending it. The server ends the session and scores it.

6. **After-action review.** `/aar/:id` renders the §12.2 report: detection time
   against par, classification accuracy, response decisions, the decision tree,
   competencies, and any critical errors.

---

## 6. The rules that keep this honest

These are not style preferences. Each one is a place where a plausible shortcut
would produce a trainer that lies to its users.

| Rule | Why it exists |
|---|---|
| **Determinism** — same scenario + seed + inputs ⇒ identical log | The event log *is* the assessment artefact. A non-reproducible run cannot be defended after review. No `Date.now()`, no `Math.random()` in core; the seeded PRNG is the only source of randomness. |
| **The client never receives ground truth** | A trainee who can see `affiliation_truth` is not being trained. `filterForRole` is the single authority, applied server-side. There is a test that walks every truth-bearing event type and greps the serialised trainee view for `hostile`. |
| **Scoring is deterministic rules** | Never a model. The AI adapter may explain, but it never alters a score, a classification, or an authority decision. |
| **The client does not simulate** | No prediction of unseen state. The one place this gets interesting is render smoothing (§8) — which interpolates between two *reported* frames and never extrapolates past one. |
| **Doctrine lives in `data/*.json`** | Weights and thresholds are a curriculum decision, not a code change. |
| **Zod at every boundary** | Scenario files, HTTP bodies, and WS messages are all untrusted input. |
| **No secrets in the repo** | PRD §17. Token scratch files are gitignored. |

---

## 7. Verification

```bash
pnpm -r test        # all packages
pnpm -r typecheck   # tsc -b across project references
pnpm lint           # eslint
```

Run all three before every commit (CLAUDE.md).

**Headless, no browser** — the bots run a scenario to completion and print the
score, which is the fastest way to check that the sim, fusion and scoring still
agree end to end:

```bash
pnpm sim:run --scenario scr-night-recon-01 --bot expert
pnpm scenario:validate <file>     # any scenario JSON
```

`--bot` takes one of `expert`, `novice`, `trigger_happy`, `passive`, `random` — the
five competence profiles in `packages/bots`.

**Known flake — read before trusting a red suite.** One test in
`packages/sim-core/src/world.test.ts` asserts that 10 simulated minutes for 30
entities complete in under 5 s. It measures **wall-clock time**, so it fails when
`pnpm -r test` saturates the CPU with every package's vitest workers at once —
observed at ~12 s under full parallel load, versus ~1.8–4.4 s running sim-core
alone. It is not a logic regression: the same suite passes 205/205 standalone, and
no code on that path has changed. The fix is a CI change (run perf tests in a
dedicated serial pass), not a change to the PRD's 5 s budget.

---

## 8. Two decisions worth knowing before you change the render

**The 20 Hz sim is correct — do not "fix" it.** PRD line 915: *"fixed 20 Hz sim
decoupled from render."* The event log's resolution is the assessment record, and
`TICK_MS = 50` is what makes runs comparable. Making it faster for smoothness would
corrupt the artefact.

**The render is decoupled from it.** `apps/client/src/interpolate.ts` holds the last
two authoritative frames and interpolates between them per animation frame, so
contacts glide at 60 Hz while the log keeps its 20 Hz resolution. Two properties are
deliberate and tested (`interpolate.test.ts`):

- **Nothing is extrapolated.** Every drawn position lies between two positions the
  sim actually reported, so the client never invents a track location.
- **The lag is one frame interval** — 50 ms at 20 Hz, under the ~100 ms at which
  added latency reads as sluggish. `MAX_LEAD_MS` caps it, so a backgrounded tab or a
  dropped socket resumes by snapping to the newest frame rather than crawling.

`ReplayMap.tsx` is deliberately **not** interpolated: it is scrub-driven, so a
position resolves to a fixed sim time and showing a half-frame between two reports
would display a position that was never reported at that instant.

Recorded as D38 in `DECISIONS.md`.

---

## 9. What is not built yet

Honest status, so nobody goes looking for it:

- **Procedural scenario generator.** `POST /api/scenarios/generate` and
  `pnpm scenario:generate` are in the PRD (§15) and the scripts are wired, but
  `packages/scenario` only *parses and validates* — nothing constructs a `Scenario`
  programmatically from `data/families` yet. `data/families/` is an empty directory.
- **`seed:demo`** is a stub (`echo stub-seed-demo`); there is no demo roster.
- **`pnpm verify-offline`** is referenced by the root `package.json` but the script
  does not exist. The offline *constraint* is honoured throughout (no CDN, no
  external fonts, no telemetry); only the automated check is missing.
- **Electron packaging** (`apps/desktop`), **PDF export**, and the **adaptive**
  package (an empty index) are all unstarted.

---

## 10. Where to look when something is wrong

| Symptom | Start here |
|---|---|
| Runs differ between machines | the seed, and `pnpm sim:run` — compare `logHash` |
| A trainee sees an answer | `filterForRole` in sim-core; the truth-boundary test |
| Contacts stutter | `interpolate.ts` §8 above; the sim rate is *not* the bug |
| Score looks wrong | `packages/scoring/src/mandated.ts` — the §10 decision tree |
| Motion is wrong | `packages/sim-core/src/behaviours.ts` — the scripted programme |