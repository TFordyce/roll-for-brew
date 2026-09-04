# Trace-snapshot harness

A permanent, **sub-round** regression net for the `resolve_round(uuid)` RPC —
introduced by issue #366, slice **S1** of wayfinder map #350 ("Effect
resolver: monolithic `resolve_round` makes every migration a 2k-line
re-emit").

Every other resolver test in this repo runs at the full-round integration
level. This harness pins `resolve_round`'s **Resolution Trace** — the ordered,
structured record it emits for every effect it applies — for a curated corpus
of freshly-seeded rounds, and diffs live output against committed golden JSON
on every integration run.

It is the mechanical behaviour-preservation proof that **S3** (the verbatim
`db/sql/` cutover) leans on: S3 moves function bodies byte-for-byte, so a
green snapshot diff across the cutover is proof it changed nothing.

## Layout

| Path | What |
|---|---|
| `corpus/framework.ts` | `PHASE_TAGS`, the Trace types, `normaliseTrace()`, `snapshotDocument()`, `makeContext()` (the seeding vocabulary), `phasesWitnessedBy()` |
| `corpus/index.ts` | `CORPUS` — one entry per seeded round |
| `*.json` | committed goldens, one per scenario (`<scenario-name>.json`) |
| `../integration/trace-snapshot.test.ts` | the golden runner (needs a Supabase test stack; `describe.skipIf(!hasAnonTestEnv)`) |
| `../integration/trace-snapshot-coverage.test.ts` | pure checklist — fails if a phase header or WILD branch has no scenario |

The runner lives under `tests/integration/` so `npm run test:integration:local`
and any `vitest run tests/integration` pick it up with no extra wiring.

## Running it

```
npm run test:integration:local          # diffs live Trace vs. goldens
npx vitest run tests/integration/trace-snapshot.test.ts -u   # refresh goldens
```

A golden refresh is a **reviewable per-scenario diff** — that is the point.
When a resolver change moves the Trace, `-u` shows exactly which steps
changed for which scenario; commit the delta with the change that caused it.

## Why the Trace is normalised, not raw

The raw Trace carries values that are not stable run-to-run:

- **UUIDs** — cast / active-effect / player ids are generated per test.
  `normaliseTrace()` maps them to stable role tokens: `P:<label>` for players
  (from the scenario roster), `cast#N` / `fx#N` in first-seen order, `uuid#N`
  for anything else. Nothing raw is ever written to a golden.
- **Resolve-time RNG** — Calami-Tea's `per_round_dice_tick` rolls its die
  *inside* `resolve_round` (Phase 3-pre). The `rolled` key, and
  `would_be_after` on a Calami-Tea warded step, are redacted to `"<rng>"`.
  Every other field on those steps (phase, kind, outcome, ward, before/after)
  still diffs verbatim.

Everything else — step order, indices, `display_kind`, `outcome`,
`before`/`after`, `negated`, `backfire`, `ward_*`, `rest_of_day`, `op`,
`condition.branch`, … — is committed exactly as the resolver emitted it.

## Why scenarios seed the Cast Log directly

Each `seed()` writes `rolls` + `spell_casts` + `cast_inputs` straight to the
tables (the seam `regression-net-working-cards.test.ts` uses), rather than
driving `cast_spell_card` / `cast_reaction_spell_card`. That keeps cast-time
RNG (WILD's d6 branch pick, a `contested_negate` d20) out of the picture: the
recorded value the resolver reads is simply what the scenario seeded.

For the **WILD** branches this means the corpus seeds each branch's
*post-dispatch* shape — the `persistent_modifier_transfer` pair, the
`forced_reroll`, the `tea_maker_override` — plus a parent `wild_dispatch` row
carrying `cast_inputs.branch = N`. WILD dispatch itself runs at cast time and
is out of `resolve_round`'s scope; the corpus pins what the resolver does with
the *result*.

## Coverage bar

`trace-snapshot-coverage.test.ts` fails unless:

- every `PHASE_TAG` (`0a 0b 1 2 3-pre 3 4a 4b 4b-pre 4c 5`) is named by at
  least one scenario's `phases`, and
- every WILD d6 branch `1..6` is named by some scenario's `wildBranch`.

The runner additionally cross-checks that each scenario's **declared** phases
actually fire in its live Trace (via `phasesWitnessedBy()`), so a stale
declaration can't hide an uncovered phase. Phases that emit no distinctive
step of their own (`0a`, `4a`) are exempt from that cross-check but still
counted for the coverage bar.

When `resolve_round` grows a phase: add its tag to `PHASE_TAGS`, add a
scenario that provokes it, refresh the goldens.

## Known limitation

`phasesWitnessedBy()` recognises Phase `0b` via a `copy` / `spell_seize`
`display_kind` or an `invocation`/`invocation_kind` marker; if the resolver
renames those, update the map in `framework.ts` alongside it.
