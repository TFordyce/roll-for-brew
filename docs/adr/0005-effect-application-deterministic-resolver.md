# Effect application rebuilt around a deterministic resolver over the Cast Log

## Status

accepted — rebuild spec #302 picked up 2026-08-30. Decided by the Spell-casting review wayfinder map (#278), ticket #280; sub-decisions #290–#295. Being built via #304–#321 on the shared integration branch `rebuild/effect-resolver` (branching strategy recorded in #303).

## Decision

Spell effect application is being **rebuilt**, not incrementally extended. Today a cast fans out across `layerResolution.ts` and roughly eight RPCs (modifier bucket, `submit_roll` for advantage, `apply_roll_swap/flip`, `apply_forced_reroll`, tea-maker overrides, inline WILD branches, inline `contested_negate`/`redirect`), `spell_casts.resolved_value` carries five unrelated meanings, and effect ordering is a hard-coded `flip → swap → lowest`. The rebuild replaces the fan-out with:

- **One authoritative SQL `resolve_round`** that owns all *outcome* math — modifier composition, tea-maker override, declared-number, lowest-gains-highest, hidden_modifier, ward checks, counterspell filtering, and ordering.
- **A thin eager shim** for the four effect kinds that change roll *inputs* (`advantage`, `disadvantage`/`forced_reroll`, `roll_swap`, `roll_flip`), which record exactly what they did into the Cast Log so the resolver can still account for them. The model is deliberately hybrid, not "everything lazy": making every player roll twice to support rare advantage cards is wasteful and confusing at a physical table.
- **A Resolution Trace** — an ordered, structured record of every step the resolver applied (kind, source cast, target, before → after). The game resolves from it and the player-clarity surface (map tickets #282/#283) renders it, from a single implementation.

The central commitment is the **determinism invariant**: a round's outcome is a pure, deterministic function of its rolls, its Cast Log, and active effects, with nothing applied by side-effect that can't be reconstructed from the log. This is what makes three otherwise-hard things cheap — round replay (Time for Brew) becomes re-running the resolver over a modified Cast Log, counterspell-unwind becomes marking a cast negated and re-resolving, and player clarity becomes reading the trace. It also forces `resolved_value` to be de-overloaded into named fields as a precondition.

The dead enum values `persistent_modifier_delta` and `persistent_modifier_swap` (zero cards, zero readers) are retired as part of the first rebuild migration.

## Considered

- **Tweak the fan-out in place** — add the ~14 missing capability classes as new `effect_kind` values and readers following the existing pattern. Rejected: the fan-out itself is the prime suspect for both "messy application" and "players can't tell what happened this round", and the cross-cutting gaps (immunity/ward layer, counterspell-unwind, true round replay) bolt on badly. Lower regression risk short-term, but doesn't move the subsystem anywhere better.
- **Maximally lazy resolver** — model roll transforms too as resolver choices over always-recorded extra rolls. Rejected: awkward at a physical table and adds confusion for a small set of cards.
- **TS resolver over thin data RPCs** — more unit-testable, but moves authority off the database and away from RLS, and splits backfill/replay onto a different path than live play.

## Consequences

- Every one of the 29 currently-working cards has to be re-pathed through the new resolver; the rebuild spec must sequence that to keep regressions contained.
- `spell_active_effects` needs an explicit place under the invariant (log-derived cache vs first-class state) — see #292.
- The Resolution Trace becomes a stable contract consumed by the player-clarity work; changes to it ripple into #282/#283.
