# Effect application rebuilt around a deterministic resolver over the Cast Log

## Status

accepted — rebuild spec #302 picked up 2026-08-30. Decided by the Spell-casting review wayfinder map (#278), ticket #280; sub-decisions #290–#295. Being built via #304–#321 on the shared integration branch `rebuild/effect-resolver` (branching strategy recorded in #303).

## Decision

Spell effect application is being **rebuilt**, not incrementally extended. Today a cast fans out across `layerResolution.ts` and roughly eight RPCs (modifier bucket, `submit_roll` for advantage, `apply_roll_swap/flip`, `apply_forced_reroll`, tea-maker overrides, inline WILD branches, inline `contested_negate`/`redirect`), `spell_casts.resolved_value` carries five unrelated meanings, and effect ordering is a hard-coded `flip → swap → lowest`. The rebuild replaces the fan-out with:

- **One authoritative SQL `resolve_round`** that owns all *outcome* math — modifier composition, tea-maker override, declared-number, lowest-gains-highest, hidden_modifier, ward checks, counterspell filtering, and ordering.
- **A thin eager shim** for the effect kinds that change roll *inputs* — originally four (`advantage`, `disadvantage`/`forced_reroll`, `roll_swap`, `roll_flip`); the Tier A primitives extend the set (`roll_pair_transform`, #318, is the fifth) — which record exactly what they did into the Cast Log so the resolver can still account for them. The model is deliberately hybrid, not "everything lazy": making every player roll twice to support rare advantage cards is wasteful and confusing at a physical table.
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
- **Amendment (#383, 2026-09-26): `resolve_round` may move one held card.** Tea Heist's Heist is applied by `resolve_round` itself, in a final phase. It moves the card pinned in the cast's `cast_inputs` only if the cast's final status is not negated and the victim still holds that card. It was **not** applied at cast time with an undo on negation: the thief could have played the card before a counter landed, leaving nothing to move back. It was also not given a separate post-resolve step, because every place that runs `resolve_round` would then have to call that step too. The write is safe to repeat (a re-run finds the card already with the thief and does nothing), the same rule as Phase 4b's `room_players.modifier` rewrite. Round replay scraps only a round that has already resolved, so the move has already happened. `_rr_scrap_round` therefore moves the card back to the victim if the thief still holds it, the same way a scrap reverses every other effect of the scrapped attempt's casts. The Tea Heist card itself stays spent.
- **Amendment (#425, spec #401 F1, 2026-09-30): the tea-maker precedence ladder and the modifier gain number.** Phase 5 of `resolve_round` picks the Tea Maker by one fixed ladder. The first tier that names someone wins:
  - **Tier 0: `brewer_immunity` filter (reserved).** A filter applied *inside* every tier below, not a pass of its own. An immune candidate at any tier counts as no match, and selection falls through. The Earl of Earl Grey is the one exception: an override naming the Earl first passes the title to the override's caster, and the ex-Earl then brews. If everyone is immune and there's no override, immunity gives way and a Tie-Break Reroll runs among all participants.
  - **Tier 1: `declared_number_tea_maker`.** Unchanged. It never triggers an Earl transfer.
  - **Tier 2: `tea_maker_override`, last cast wins** (`cast_at desc, seq desc`). The mode is a closed set, `highest_modifier | highest_roll | chosen | prev_round_highest | conditional_chosen`. A CHECK on both `spell_card_effects` and `spell_casts` rejects any other (or a missing) mode. `prev_round_highest` (Last Drip) and `conditional_chosen` (PG Tipped) are reserved: until their card slices land, the resolver leaves them out of the contest. A `conditional_chosen` override whose condition fails never enters the contest.
  - **Tier 3: Loose Leaf roll-off.** Applied after selection, keyed to the final Tea Maker, whichever tier named them.
  - **Tier 4: default lowest roller** (`_rr_pick_lowest`). Immune players are left out of the candidate pool, and exempt players have no roll.
  - **Pre-ladder rule:** a round with a live, payable Brew Debt skips tea-maker selection entirely.
  - `targeting_skip` (Cloud of Cream), `forced_reroll`, `lowest_gains_highest_modifier` and the ward phase are orthogonal to the ladder. `targeting_skip` only steers the `highest_modifier` pick and doesn't interact with the new modes (`prev_round_highest`, `conditional_chosen`).

  The Tea Maker's gain is now a **modifier gain number** rather than a yes/no, and it flows from `resolve_round(uuid)`'s `modifier_gain` through `finalize_layer` into the resolution write `resolve_round(uuid, text, integer, integer)` and on to `rounds.brewer_modifier_gain`. `null` means the normal `cups_made`, `0` means no gain, and any other value is used as given (e.g. `2 * cups_made`). An override sets it from `effect_params.modifier_gain`; the legacy `no_modifier_gain: true` reads as `0`. A `block_earned_modifier` ward on the Tea Maker forces it to `0` over any override value. The yes/no stays only as a compat alias: `no_modifier_gain` in the resolver output, and the `resolve_round(uuid, text, integer, boolean)` overload that delegates to the integer one. `_rr_base_modifier` sums `brewer_modifier_gain` (#395), so a 0 or doubled gain survives every modifier recompute.
