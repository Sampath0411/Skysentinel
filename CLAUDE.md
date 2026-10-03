# SkySentinel — Claude Code project rules

## Mission
Offline desktop counter-UAS decision trainer (PS 26247). Training and assessment only.
Source of truth for requirements: docs/PRD_SkySentinel_MVP.md.

## Hard rules
- Safety boundary (PRD §4) is absolute: no real jamming/RF/spoofing/weapon control, no live sensor/C2 links,
  no operational attack/defeat instructions, no AI-authorised engagement. All parameters are fictional.
- Core packages (shared, sim-core, scenario, scoring, adaptive, bots) are PURE TypeScript: no DOM,
  no fs/network, no Date.now(), no Math.random(). Use the seeded PRNG.
- Determinism: same scenario+seed+inputs ⇒ identical event log. Keep golden tests green.
- Trainee clients must NEVER receive ground-truth fields. Filter at the server.
- Scoring is deterministic rules only. LLM/AI never alters scores, classifications, or authority.
- Doctrine/terminology/weights/thresholds live in data/*.json, not in code.
- Offline only: no CDN, no external fonts, no telemetry.

## Commands
pnpm install | pnpm -r test | pnpm -r typecheck | pnpm lint
pnpm sim:run --scenario <id> --bot <expert|novice|trigger_happy|passive|random>
pnpm scenario:validate <file> | pnpm scenario:generate --family F --difficulty D --seed S
pnpm scenario:fuzz --n 1000 | pnpm seed:demo | pnpm dev | pnpm build:desktop

## Workflow
- Build milestones in PRD §14 order. Run tests before every commit. One milestone ⇒ one PR-sized commit series.
- Add a test with every behaviour. Prefer table-driven tests. Record choices in docs/DECISIONS.md.
- Keep UI thin: logic belongs in packages with tests.
- Prefer small files (<300 lines), explicit types, Zod at all boundaries.