# Slice 2b parity audit: TS integration tests against C# (#547, #548)

Spec #533's exit 1 asks that each existing TS integration test for a slice's RPCs has an equivalent C# test. Slice 2b ports `advance_layer`, `finalize_layer`, `resolve_round`, `get_round_recap` and `admin_backfill_round`.

**Which tests count.** A title search would be wrong both ways, because many tests reach an RPC through a helper. So the whole integration suite ran once with `fetch` logged: 416 tests in 43 files called one of the five RPCs over REST. A test that reaches one only inside another SQL function (for example a stall path) is not listed.

**Result.**

| Kind | Tests | Meaning |
|---|---|---|
| `golden` | 245 | A corpus scenario pins the same behaviour through both engines |
| `test` | 110 | A named C# test pins it, or the named tests pin the same branch |
| `elsewhere` | 48 | The test's point is another RPC from a later slice, and the slice 2b RPC is only how the round ends |
| `GAP` | 13 | No C# equivalent yet, listed below |

The mapping is a reading of each test's title and seed, not a mechanical proof. `test` rows that name a sibling branch are the weakest and say so.

**What the audit added.** 31 corpus scenarios for branches only the TS suite reached, taking the corpus from 72 to 103. 19 came from reading the tests and 12 from C# line coverage after a full run, which showed that some title-based mappings were wrong: `roll_frozen`, carried advantage and carried modifiers, the block_copy and countered-seize branches, and the polarity arms had run in no C# test. Each scenario passed through C# `Evaluate`, both advance entry points and the Recap, and the audit found no rule difference between the engines. It found one stored-byte difference: with a fractional multiplier, SQL stores `2.0` in `resolution_trace` where C# stores `2`. JSON parsing reads both as 2, and the only catalog multiplier is Double Shot's 2, so play can't reach it today. The scenario uses a multiplier of 0 to stay exact. It also added `A_recap_read_does_not_wait_on_a_round_being_finalized` and `A_resolved_round_with_no_stored_summary_reads_the_same`.

**Regenerating a scenario.** `tests/integration/trace-snapshot.test.ts` writes a new golden, and `EMIT_INPUT_FIXTURES=1` writes its input. That flag rewrites every input, so restore the existing ones afterwards: they predate `rooms.version`.

## Open gaps (13)

| TS file | Test | Why it is open |
|---|---|---|
| `brew-iou.test.ts` | no debt when Brew IOU's target goes on to a Loose Leaf roll-off | No golden has Brew IOU and a roll-off together |
| `brew-iou.test.ts` | a debt from a real room is not paid in the Test Room | `Rules.BrewDebtDue` Test Room scoping has no C# test |
| `effect-invocation.test.ts` | a block_copy ward blocks the seize -- card burned, source resolves normally | Invocation edge case with no golden. Line coverage reaches its branch through the block_copy and seize goldens, but not this combination |
| `effect-invocation.test.ts` | a Brew-merang seizing a Brew-merang terminates and resolves coherently | Invocation edge case with no golden. Line coverage reaches its branch through the block_copy and seize goldens, but not this combination |
| `last-drip.test.ts` | reads the most recent resolved round, ignoring older and cancelled ones | Past-round selection among older and cancelled rounds has no golden |
| `last-drip.test.ts` | breaks a full tie (roll and snapshot) on the lowest player id | Same code path as the snapshot tie-break, one comparison further |
| `last-drip.test.ts` | an immune fall-through target is still handled by Brewer Immunity: the default pick stands | Immunity filter on this rung, covered for other rungs by `05-brewer-immunity-override-falls-through` |
| `last-drip.test.ts` | Genie in the Teapot can invoke it: the previous winner brews with no gain | Genie invoking this card has no golden |
| `tea-heist.test.ts` | lands the loot as a keep-or-swap choice when the thief picked up a card mid-round | Heist branch with no golden |
| `tea-maker-override-modifier-gain.test.ts` | a reserved mode (no card slice yet) stays out of the override contest instead of failing the round | A reserved override mode staying out of the contest has no golden |
| `ward-transfer-interaction.test.ts` | a ward on the losing side blocks both sides of a Chai-nge swap; the card is still spent | Ward against a transfer card at cast time has no golden of its own |
| `ward-transfer-interaction.test.ts` | a warded Tea Leaf target keeps their modifier and the caster gets no roll bonus | Ward against a transfer card at cast time has no golden of its own |
| `ward-transfer-interaction.test.ts` | a warded Spillage target keeps their modifier; an unwarded Spillage still moves floor(m/2) | Ward against a transfer card at cast time has no golden of its own |

## Every test

The RPC column names what the test really called. `golden` names a corpus scenario, which runs through `GoldenEvaluateTests`, `AdvanceRoundParityTests` (both entry points) and `RoundRecapParityTests`.

### `admin-backfill-round.test.ts` (11)

| Test | RPC | Kind | C# equivalent |
|---|---|---|---|
| rejects a non-admin caller (RFB33) | backfill | test | RoundBackfillParityTests.A_non_admin_is_refused |
| rejects fewer than 2 participants (RFB34) | backfill | test | RoundBackfillParityTests.A_bad_backfill_fails_the_same_way_and_leaves_nothing |
| rejects zero layers (RFB35) | backfill | test | RoundBackfillParityTests.A_bad_backfill_fails_the_same_way_and_leaves_nothing |
| rejects backfilling while another round is already live in today's room (RFB36) | backfill | test | RoundBackfillParityTests.A_live_round_in_todays_room_is_refused |
| rejects a layer whose roster doesn't match the expected tied set (RFB37) | backfill | test | RoundBackfillParityTests.A_bad_backfill_fails_the_same_way_and_leaves_nothing |
| rejects an out-of-range roll value (RFB38) | backfill | test | RoundBackfillParityTests.A_bad_backfill_fails_the_same_way_and_leaves_nothing |
| rejects supplying an extra layer once the round already resolved (RFB39) | backfill | test | RoundBackfillParityTests.A_bad_backfill_fails_the_same_way_and_leaves_nothing |
| rejects a still-tied final layer with no further layer supplied (RFB40) | backfill | test | RoundBackfillParityTests.A_bad_backfill_fails_the_same_way_and_leaves_nothing |
| resolves a straightforward two-player round with no tie, flagging provenance throughout | backfill | test | RoundBackfillParityTests.A_round_resolves_the_same_in_both_engines |
| implicitly creates room_players rows for participants who never logged in today | backfill | test | RoundBackfillParityTests.Nobody_needs_to_have_logged_in_today |
| resolves a round that ties at layer 0 and is decided by a layer-1 reroll | backfill | test | RoundBackfillParityTests.A_round_resolves_the_same_in_both_engines |

### `admin-delete-drain-origin-round.test.ts` (2)

| Test | RPC | Kind | C# equivalent |
|---|---|---|---|
| Bitter Leech: deleting the origin round succeeds, later ticks stay applied, the drain stops | resolve | elsewhere | Asserts `admin_delete_round`, not slice 2b; ticks: `4b-pre-bitter-leech-tick-synthesis`, `3-pre-calami-tea-tick-warded` |
| Calami-Tea: deleting the origin round succeeds, later dice ticks stay, the drain stops | resolve | elsewhere | Asserts `admin_delete_round`, not slice 2b; ticks: `4b-pre-bitter-leech-tick-synthesis`, `3-pre-calami-tea-tick-warded` |

### `brew-iou.test.ts` (21)

| Test | RPC | Kind | C# equivalent |
|---|---|---|---|
| the target brews this round with normal gain, and the caster owes a Brew Debt | advance | golden | `05-brew-iou-creates-debt` |
| no debt when the override didn't pick the Tea Maker > countered (negated): the default pick brews, no debt | advance | test | `05-pg-tipped-redirected-onto-caster`-style ladder goldens; `Phase5BrewDebtTests` for the debt read |
| no debt when the override didn't pick the Tea Maker > out-ranked by a later override: no debt | advance | test | `05-pg-tipped-redirected-onto-caster`-style ladder goldens; `Phase5BrewDebtTests` for the debt read |
| no debt when the override didn't pick the Tea Maker > an immune target: the override falls through to the default pick, no debt | advance | test | `05-pg-tipped-redirected-onto-caster`-style ladder goldens; `Phase5BrewDebtTests` for the debt read |
| the Debtor's next round resolves at close to them: no rolls, no window, normal gain | advance | golden | `05-brew-debt-round-paid` |
| active effects still age through a debt round | advance | test | `Phase5BrewDebtTests`, `05-brew-debt-round-paid` |
| no debt when Brew IOU's target goes on to a Loose Leaf roll-off | advance | GAP | No golden has Brew IOU and a roll-off together |
| nobody can roll in a debt round | advance | golden | `05-brew-debt-round-paid` |
| the debt survives into another room (another day), and is paid there | advance | test | AdvanceRoundParityTests.A_brew_debt_from_another_room_makes_this_a_debt_round |
| a debt from a real room is not paid in the Test Room | advance | GAP | `Rules.BrewDebtDue` Test Room scoping has no C# test |
| an immune Debtor plays the round normally and still owes | advance | test | `Phase5BrewDebtTests.An_immune_debtor_plays_normally_and_the_debt_stays_owed` |
| targeting the Earl: the title passes to the caster, the debt is created and waits | advance | golden | `05-earl-override-transfers-title`, `05-brew-iou-creates-debt` |
| several Debtors: the oldest debt pays, the others stay owed; an immune Debtor is skipped | advance | test | `Phase5BrewDebtTests.An_immune_debtor_plays_normally_and_the_debt_stays_owed` |
| several Debtors with the oldest immune: the next debt pays instead | advance | test | `Phase5BrewDebtTests.An_immune_debtor_plays_normally_and_the_debt_stays_owed` |
| owing twice: one debt per round, oldest first | advance | test | `Phase5BrewDebtTests.A_debt_round_pays_the_oldest_due_debt_and_skips_the_ladder` |
| a Debtor's Late Declare turns the round into a debt round only while nobody has rolled | advance | test | `Phase5BrewDebtTests.A_round_that_has_started_rolling_is_not_a_debt_round`; `declare_in_late` itself is slice 3 |
| once someone has rolled, a Debtor can't declare in late and the round stays normal | advance | test | `Phase5BrewDebtTests.A_round_that_has_started_rolling_is_not_a_debt_round`; `declare_in_late` itself is slice 3 |
| admin-deleting the paying round makes the debt owed again | advance | elsewhere | Asserts `admin_delete_round`, not slice 2b |
| admin-deleting the Brew IOU round erases the debt | advance | elsewhere | Asserts `admin_delete_round`, not slice 2b |
| scrapping the paying round (Round replay) makes the debt owed again | advance | elsewhere | Scrap and replay are `confirm_round_replay`, not slice 2b; the replayed round runs through the goldens as any other |
| scrapping the Brew IOU round erases the debt | advance | elsewhere | Scrap and replay are `confirm_round_replay`, not slice 2b; the replayed round runs through the goldens as any other |

### `brewer-immunity.test.ts` (13)

| Test | RPC | Kind | C# equivalent |
|---|---|---|---|
| the lowest roller who cast it this round doesn't brew: the next-lowest does, end to end | resolve, finalize | golden | `05-brewer-immunity-lowest-roller` |
| an immune natural 1 is skipped too | resolve | golden | `05-brewer-immunity-lowest-roller` |
| no skip step when the immune player wasn't going to brew anyway | resolve | golden | `05-earl-override-on-another-leaves-title` |
| a declared number the immune player rolled is no match; selection falls through | resolve | golden | `05-brewer-immunity-declared-number` |
| a declared number matched by an immune and a non-immune roller names the non-immune one | resolve | golden | `05-brewer-immunity-declared-number` |
| a chosen override naming the immune player falls through to the default pick | resolve | golden | `05-brewer-immunity-override-falls-through` |
| a highest_roll override naming the immune player falls through to the default pick | resolve | golden | `05-brewer-immunity-override-falls-through` |
| a highest_modifier override naming the immune player falls through to the default pick | resolve | golden | `05-brewer-immunity-override-falls-through` |
| an override on someone else still lands | resolve | golden | `05-earl-override-on-another-leaves-title` |
| everyone immune and no override: a Tie-Break Reroll among all participants | resolve, finalize | golden | `05-brewer-immunity-all-immune-tie` |
| Greater Detox can't dispel it: never offered, refused directly, and a dispel naming it is ignored | resolve | elsewhere | Asserts the dispel RPC, slice 5 |
| lasts the rest of the day and survives a Round replay of a later round | resolve | elsewhere | Scrap and replay are `confirm_round_replay`, not slice 2b; the replayed round runs through the goldens as any other |
| a Last Cuppa countered in the layer-0 Reaction Window grants no immunity | resolve | elsewhere | Asserts cast or reaction RPCs (slices 3 to 6); the round then finalizes through the goldens |

### `brewmageddon.test.ts` (9)

| Test | RPC | Kind | C# equivalent |
|---|---|---|---|
| stall: forfeits outstanding compelled Action casts, excludes nobody, then restarts the roll clock | advance | elsewhere | Asserts stall enforcement (slice 7), which only calls the advance RPC afterwards; advance itself is covered by `AdvanceRoundParityTests` holds and `A_golden_scenario_advances_identically_in_both_engines` |
| a compelled Reaction holder cannot pass the Layer-0 window, and their cast counts | advance, finalize | elsewhere | Asserts cast or reaction RPCs (slices 3 to 6); the round then finalizes through the goldens |
| a compelled Reaction holder skipped by vote forfeits their card | advance | elsewhere | Asserts stall enforcement (slice 7), which only calls the advance RPC afterwards; advance itself is covered by `AdvanceRoundParityTests` holds and `A_golden_scenario_advances_identically_in_both_engines` |
| a compelled Reaction holder timed out by the stall backstop forfeits their card | advance | elsewhere | Asserts stall enforcement (slice 7), which only calls the advance RPC afterwards; advance itself is covered by `AdvanceRoundParityTests` holds and `A_golden_scenario_advances_identically_in_both_engines` |
| a compelled Reaction holder excluded for never rolling forfeits their card | advance | elsewhere | Asserts stall enforcement (slice 7), which only calls the advance RPC afterwards; advance itself is covered by `AdvanceRoundParityTests` holds and `A_golden_scenario_advances_identically_in_both_engines` |
| Brewmageddon countered: the earlier compelled cast stands and pending Reaction holders are released | advance, finalize | test | `LayerReadinessTests.An_owed_compelled_action_stops_rolling_but_the_players_stay_expected`; the counter itself is slice 6 |
| with nobody holding a card it is a no-op: rolling opens at close and the Trace says so | advance | golden | `1-brewmageddon-compelled-cast-and-forfeit` |
| the Trace and the Recap link compelled casts and Forfeits to Brewmageddon | advance, recap | golden | `1-brewmageddon-compelled-cast-and-forfeit` |
| does not re-fire on a Time for Brew replay | advance | elsewhere | Asserts cast or reaction RPCs (slices 3 to 6); the round then finalizes through the goldens |

### `calami-tea-dice-tick.test.ts` (5)

| Test | RPC | Kind | C# equivalent |
|---|---|---|---|
| casting Calami-Tea projects a per_round_dice_tick effect and each round subtracts a fresh 1d4 from the roll | resolve | test | `3-calami-tea-floored-natural-1`, `CommitTests`; two targets each roll through `IDieRoller` |
| a re-resolve reuses the recorded die — no extra rows, identical Trace step | resolve | test | `CommitTests.An_existing_calami_tea_tick_row_suppresses_the_roll` |
| two chosen targets each get an independent fresh die in the same round | resolve | test | `3-calami-tea-floored-natural-1`, `CommitTests`; two targets each roll through `IDieRoller` |
| a negative-polarity roll-domain ward on a target blocks that round's tick with a warded step | resolve | golden | `3-pre-calami-tea-tick-warded` |
| a genuine natural 1 still brews when another player is Calami-floored to 1 | resolve | golden | `3-calami-tea-floored-natural-1` |

### `carried-effects.test.ts` (3)

| Test | RPC | Kind | C# equivalent |
|---|---|---|---|
| a Round replay of a round in the new room re-applies the carried effect and counts the round once | resolve | elsewhere | Scrap and replay are `confirm_round_replay`, not slice 2b; the replayed round runs through the goldens as any other |
| Caffeine Crash forces -1 in the new room for the remaining participated rounds, then reverts to that room's base | resolve | test | `GoldenLivenessTests`, `ActiveEffectsTests` |
| Bitter Leech ticks on the target's clock; the caster's gain is lost when the caster is absent | resolve | test | `GoldenLivenessTests`, `ActiveEffectsTests` |

### `chosen-pair-roll-transform.test.ts` (8)

| Test | RPC | Kind | C# equivalent |
|---|---|---|---|
| swap exchanges the caster-named pair's rolls and records before->after per player | resolve | test | AdvanceRoundParityTests.An_unapplied_chosen_pair_transform_applies_its_op |
| set-both-lower (min) drops both of the pair to the lower of the two rolls | resolve | test | AdvanceRoundParityTests.An_unapplied_chosen_pair_transform_applies_its_op |
| set-both-higher (max) lifts both of the pair to the higher of the two rolls | resolve | test | AdvanceRoundParityTests.An_unapplied_chosen_pair_transform_applies_its_op |
| a no-op transform (pair already equal) still records and traces a step per player | resolve | test | AdvanceRoundParityTests.A_degenerate_pair_records_an_empty_transform |
| a roll-domain ward on the losing end of a swap cancels it with no mutation | resolve | test | AdvanceRoundParityTests.A_ward_older_than_the_transform_blocks_it_and_says_so |
| a roll-domain ward on the GAINING end of a swap also cancels it (either end blocks) | resolve | test | AdvanceRoundParityTests.A_ward_older_than_the_transform_blocks_it_and_says_so |
| Stir the Pot (Action) swaps two OTHER players and attaches to the layer-0 window | resolve | test | AdvanceRoundParityTests.Pre_roll_transforms_attach_to_the_window_the_bridge_opens_and_are_shimmed |
| Tea for Two (Action, max) lifts caster + target to the higher of the two rolls | resolve | test | AdvanceRoundParityTests.An_unapplied_chosen_pair_transform_applies_its_op |

### `discarded-advantage-roll.test.ts` (1)

| Test | RPC | Kind | C# equivalent |
|---|---|---|---|
| surfaces discarded_value through advance_layer's layer_rolls (issue #167; the reveal payload since #415) | advance | test | `AdvanceRoundParityTests` payload comparison (`layer_rolls.discarded_value`); `AdvanceRoundCommandTests` |

### `earl-of-earl-grey.test.ts` (12)

| Test | RPC | Kind | C# equivalent |
|---|---|---|---|
| the Earl would be lowest: the next-lowest roller brews, end to end | resolve, finalize | golden | `05-earl-lowest-roller-next-lowest-brews` |
| casting Earl while someone else holds the title leaves exactly one Earl | resolve, finalize | golden | `05-earl-second-title-ends-the-older` |
| dispelling the new Earl does not hand the title back to the old one | finalize | golden | `05-earl-second-title-ends-the-older` |
| a countered Earl cast takes nothing from the sitting Earl | resolve, finalize | elsewhere | Asserts cast or reaction RPCs (slices 3 to 6); the round then finalizes through the goldens |
| a chosen override naming the Earl moves the title to its caster, and the ex-Earl brews | resolve, finalize | golden | `05-earl-override-transfers-title` |
| a highest_roll override naming the Earl moves the title to its caster, and the ex-Earl brews | resolve, finalize | golden | `05-earl-override-transfers-title` |
| an override on someone else leaves the title where it is | resolve, finalize | golden | `05-earl-override-on-another-leaves-title` |
| an Earl who also holds override-proof immunity is simply passed over: no transfer | resolve | golden | `05-earl-override-proof-passed-over-no-transfer` |
| an override the Earl cast on themselves can't pass the title to its own holder: plain skip | resolve | golden | `05-earl-self-override-plain-skip` |
| a declared number matching the Earl is skipped (immune), with no transfer | resolve, finalize | golden | `05-earl-declared-number-no-transfer` |
| viewing the Provisional Recap mid-window doesn't move the title | recap | test | RoundRecapParityTests.A_golden_scenario_reads_the_same_before_and_after_it_resolves on the 05-earl goldens |
| a Round replay of the round that moved the title hands it back | finalize | elsewhere | Scrap and replay are `confirm_round_replay`, not slice 2b; the replayed round runs through the goldens as any other |

### `effect-invocation.test.ts` (10)

| Test | RPC | Kind | C# equivalent |
|---|---|---|---|
| copies a stack cast onto the Apprentice caster; the original still resolves | resolve | golden | `0-spell-copy-onto-apprentice-caster` |
| the copy draws its own RNG -- a copied dice_modifier re-rolls independently | resolve | golden | `0-spell-copy-onto-apprentice-caster` |
| copying a negated / broken-chain cast is a no-op | resolve | golden | `0-copy-of-countered-source-is-noop` |
| a block_copy ward blocks the copy -- card burned, outcome blocked | resolve | golden | `0-copy-blocked-by-block-copy-ward` |
| retargets the seized cast to its own caster | resolve | test | AdvanceRoundParityTests.A_seize_keeps_the_seized_cast_and_records_that_it_did |
| a multi-target seized cast collapses to just the caster | resolve | test | AdvanceRoundParityTests.A_seize_keeps_the_seized_cast_and_records_that_it_did |
| countering the Brew-merang undoes the seize | resolve | golden | `0-seize-countered-is-undone` |
| a block_copy ward blocks the seize -- card burned, source resolves normally | resolve | GAP | Invocation edge case with no golden. Line coverage reaches its branch through the block_copy and seize goldens, but not this combination |
| resolve_round is idempotent over an invocation round | resolve | test | `EvaluatePipelineTests.Evaluate_is_deterministic_and_leaves_the_snapshot_untouched` |
| a Brew-merang seizing a Brew-merang terminates and resolves coherently | resolve | GAP | Invocation edge case with no golden. Line coverage reaches its branch through the block_copy and seize goldens, but not this combination |

### `fixed-roll.test.ts` (7)

| Test | RPC | Kind | C# equivalent |
|---|---|---|---|
| Steady Hand forces the caster's d20 to 10, records before->after, and resolve_round adopts it | resolve | golden | `3-fixed-roll-pre-roll-kind` |
| Sleeping Camomile forces the target's d20 to 1, records it, and resolve_round adopts it | resolve | golden | `3-fixed-roll-pre-roll-kind` |
| a negative roll-domain ward on the target pre-empts Sleeping Camomile: the roll is not overridden and a warded marker is recorded | resolve | golden | `3-fixed-roll-warded-marker` |
| resolve_round Phase 3 turns a recorded warded fixed_roll marker into one blocked step and keeps the real roll | resolve | golden | `3-fixed-roll-warded-marker` |
| a negated (countered) fixed_roll is logically unwound: Phase 3 adopts the recorded `before` and emits no step | resolve | golden | `3-fixed-roll-negated-unwinds` |
| resolve_round over a fixed_roll is idempotent — a second run yields the same brewer and Trace | resolve | test | `EvaluatePipelineTests.Evaluate_is_deterministic_and_leaves_the_snapshot_untouched` |
| a later roll_flip chains off the fixed value: Phase 3 walks fixed_roll then roll_flip | resolve | golden | `3-roll-flip-then-swap`, `3-fixed-roll-pre-roll-kind` |

### `last-drip.test.ts` (14)

| Test | RPC | Kind | C# equivalent |
|---|---|---|---|
| the previous round's highest roller brews and gains no modifier | resolve, finalize | golden | `05-tea-maker-override-prev-round-highest` |
| reads the most recent resolved round, ignoring older and cancelled ones | resolve | GAP | Past-round selection among older and cancelled rounds has no golden |
| breaks a tie for highest on the lowest modifier snapshot | resolve | golden | `05-last-drip-tie-breaks-on-lowest-snapshot` |
| breaks a full tie (roll and snapshot) on the lowest player id | resolve | GAP | Same code path as the snapshot tie-break, one comparison further |
| does nothing when there's no previous resolved round: a no-op step, and the default pick stands | resolve, finalize | golden | `05-tea-maker-override-prev-round-highest-inert` |
| falls through an absent previous winner to the next-highest previous roller, with no gain | resolve | golden | `05-tea-maker-override-prev-round-highest-falls-through` |
| falls through a Roll-Exempt previous winner the same way | resolve | golden | `05-last-drip-falls-through-exempt-previous-winner` |
| is inert only when nobody in the previous round's roll list qualifies | resolve | golden | `05-tea-maker-override-prev-round-highest-inert` |
| an immune fall-through target is still handled by Brewer Immunity: the default pick stands | resolve | GAP | Immunity filter on this rung, covered for other rungs by `05-brewer-immunity-override-falls-through` |
| a later override beats it (last cast wins) | resolve | golden | `05-last-drip-later-override-wins` |
| beats an earlier override when it's cast last | resolve | golden | `05-last-drip-later-override-wins` |
| an inert Last Drip cast last lets the earlier override stand | resolve | golden | `05-last-drip-inert-lets-earlier-override-stand` |
| Genie in the Teapot can invoke it: the previous winner brews with no gain | resolve | GAP | Genie invoking this card has no golden |
| a declared number outranks it | resolve | golden | `05-brewer-immunity-declared-number`, `05-declared-number-tea-maker` |

### `liquid-courage.test.ts` (8)

| Test | RPC | Kind | C# equivalent |
|---|---|---|---|
| the gift round resolves normally; the recipient may spend the new token in that round's window | advance | elsewhere | Asserts cast or reaction RPCs (slices 3 to 6); the round then finalizes through the goldens |
| prompts a recipient with no Reaction card, who spends it once to add 1d6 to their roll | advance, finalize | golden | `4a-courage-token-spend` |
| refuses a spend outside a Layer-0 window or without a token | advance | elsewhere | Asserts cast or reaction RPCs (slices 3 to 6); the round then finalizes through the goldens |
| a Skip vote counts an unspent token holder as someone being waited on | advance | elsewhere | Asserts cast or reaction RPCs (slices 3 to 6); the round then finalizes through the goldens |
| adds the d6 after advantage picked the kept d20 | advance | golden | `4a-courage-token-spend` |
| a spend is invisible to card-targeting Reactions | advance | elsewhere | Asserts cast or reaction RPCs (slices 3 to 6); the round then finalizes through the goldens |
| a Time for Brew replay restores a token spent in the scrapped attempt | advance, resolve | elsewhere | Scrap and replay are `confirm_round_replay`, not slice 2b; the replayed round runs through the goldens as any other |
| two tokens are independent: each is spent on its own | advance | elsewhere | Asserts cast or reaction RPCs (slices 3 to 6); the round then finalizes through the goldens |

### `loaf-of-lipton.test.ts` (12)

| Test | RPC | Kind | C# equivalent |
|---|---|---|---|
| the caster has no layer-0 roll; the round completes without it; they brew with double gain | advance | golden | `05-loaf-of-lipton-skips-roll` |
| a later override on someone else beats Loaf; the caster still skipped their roll | advance | golden | `05-loaf-of-lipton-later-override-beats-it` |
| dice-based picks never choose an exempt player; a chosen override still can | advance | golden | `05-loaf-of-lipton-skips-roll` |
| an immune Loaf caster falls through to the lowest roller, never themselves | advance | golden | `05-loaf-of-lipton-immune-caster-falls-through` |
| countered: exempt while the window is open; once it closes the caster rolls late, and effects aimed at them apply | finalize, advance | test | RoundRecapParityTests.A_countered_exemption_stays_exempt_until_the_window_closes |
| a counter of the counter keeps the exemption: Loaf stands | finalize | golden | `1-counter-of-counter-depth-2` |
| countered: the late roller's stall clock starts when the window closes, then a no-show is excluded | advance | elsewhere | Asserts stall enforcement (slice 7), which only calls the advance RPC afterwards; advance itself is covered by `AdvanceRoundParityTests` holds and `A_golden_scenario_advances_identically_in_both_engines` |
| stall: excluding one no-show leaves the round alive while the exempt caster is still a Participant | advance | elsewhere | Asserts stall enforcement (slice 7), which only calls the advance RPC afterwards; advance itself is covered by `AdvanceRoundParityTests` holds and `A_golden_scenario_advances_identically_in_both_engines` |
| every participant exempt: the round resolves at close -- last Loaf wins | advance | golden | `05-loaf-of-lipton-everyone-exempt-last-wins` |
| every participant exempt and immune: immunity gives way, and they roll normally in the Tie-Break Reroll | advance | golden | `05-tea-cosy-exempt-and-immune` |
| an exempt Loose Leaf holder named Tea Maker rolls off against the second-lowest of the other rollers | finalize | golden | `05-loose-leaf-rolloff` |
| replay: the clean slate wipes the exemption, and the caster rolls normally | finalize | elsewhere | Scrap and replay are `confirm_round_replay`, not slice 2b; the replayed round runs through the goldens as any other |

### `loose-leaf.test.ts` (5)

| Test | RPC | Kind | C# equivalent |
|---|---|---|---|
| the holder named Tea Maker rolls off against the second-lowest roller, and the loser brews with normal gain | finalize | golden | `05-loose-leaf-rolloff`, `05-loose-leaf-tied-second` |
| every roller tied at second-lowest joins the roll-off -- no player-id tiebreak | finalize | golden | `05-loose-leaf-rolloff`, `05-loose-leaf-tied-second` |
| a tied roll-off goes to another Layer, and the holder brews if they lose it | finalize | golden | `05-loose-leaf-tied-second` |
| does nothing in a two-player round -- there's no distinct second-lowest roller | finalize | golden | `05-loose-leaf-two-player-inert` |
| does nothing when its holder isn't named Tea Maker | finalize | golden | `05-loose-leaf-holder-alone-second` |

### `marked-for-brew.test.ts` (2)

| Test | RPC | Kind | C# equivalent |
|---|---|---|---|
| a Time for Brew replay keeps the redirected draw and does not restore the spent mark | resolve | elsewhere | Scrap and replay are `confirm_round_replay`, not slice 2b; the replayed round runs through the goldens as any other |
| traces the mark in its cast round and the redirect in the round it fires | resolve | golden | `6-marked-for-brew-placed`, `6-marked-for-brew-redirected` |

### `persistent-advantage.test.ts` (6)

| Test | RPC | Kind | C# equivalent |
|---|---|---|---|
| carries advantage across three consecutive rounds via the projection | resolve | golden | `3-persistent-advantage-from-active-effect` |
| resolve_round emits an advantage Trace step sourced from the projection row | resolve | golden | `3-persistent-advantage-from-active-effect` |
| stacks before a reaction-window transform on the same roller (advantage step first, not zero-impact) | resolve | golden | `3-persistent-advantage-from-active-effect` |
| negating the originating cast re-projects the advantage away | resolve | test | `ActiveEffectsTests`, `GoldenLivenessTests` |
| a dispel cast ends the persistent advantage from that round onward | resolve | test | `ActiveEffectsTests`, `GoldenLivenessTests` |
| a modifier-domain ward on the caster does not touch the roll-domain advantage | resolve | golden | `3-persistent-advantage-from-active-effect` |

### `persistent-modifier-cards.test.ts` (7)

| Test | RPC | Kind | C# equivalent |
|---|---|---|---|
| Chai-nge of Heart swaps the two effective modifiers rest-of-day and the breakdown reconciles | resolve | golden | `4b-persistent-modifier-transfer-rest-of-day` |
| a second resolve_round leaves the Chai-nge swap and its Trace steps unchanged (idempotent) | resolve | test | `Phase4bTests.An_existing_tick_row_for_this_generation_suppresses_resynthesis`, `EvaluatePipelineTests` |
| negating a Chai-nge cast reverts both sides on re-resolution | resolve | test | `Phase4bTests.A_fully_negated_transfer_still_reverts_the_targets_cache` |
| Tea-tally Spent burns a clamped amount durably and adds it to the cast round's roll only | resolve | test | `4b-persistent-modifier-transfer-rest-of-day`; the clamp is at cast time (slice 4) |
| Tea-tally Spent clamps the spend to the caster's current effective modifier | resolve | test | `4b-persistent-modifier-transfer-rest-of-day`; the clamp is at cast time (slice 4) |
| Bitter Leech drains 1 modifier/round from target to caster for the cast round + next 2, then stops | resolve | golden | `4b-pre-bitter-leech-tick-synthesis` |
| Bitter Leech tick synthesis is idempotent — a second resolve adds no rows and no steps | resolve | test | `Phase4bTests.An_existing_tick_row_for_this_generation_suppresses_resynthesis`, `EvaluatePipelineTests` |

### `pg-tipped.test.ts` (5)

| Test | RPC | Kind | C# equivalent |
|---|---|---|---|
| target rolls lower than the caster: the target brews and gains nothing | finalize | golden | `05-pg-tipped-condition-met` |
| target rolls equal: a no-op Trace step and the normal pick stands | finalize | golden | `05-pg-tipped-condition-not-met` |
| target rolls higher: a no-op Trace step and the normal pick stands | finalize | golden | `05-pg-tipped-condition-not-met` |
| a failed condition doesn't beat an earlier override in the last-cast-wins contest | finalize | golden | `05-pg-tipped-not-met-earlier-override-stands` |
| a met condition beats an earlier override (last cast wins) | finalize | golden | `05-pg-tipped-condition-met` |

### `reaction-window-close-on-last-cast.test.ts` (1)

| Test | RPC | Kind | C# equivalent |
|---|---|---|---|
| enforceStallTimeout recovers a window some earlier code already stranded | advance | elsewhere | Asserts stall enforcement (slice 7), which only calls the advance RPC afterwards; advance itself is covered by `AdvanceRoundParityTests` holds and `A_golden_scenario_advances_identically_in_both_engines` |

### `reaction-window-skip-vote.test.ts` (9)

| Test | RPC | Kind | C# equivalent |
|---|---|---|---|
| stall backstop: a silent Reaction holder is auto-passed 5 minutes after the poll round started and the round resolves | advance, recap | test | RoundRecapParityTests.The_latest_windows_skips_name_who_was_not_heard_from |
| 2 participants: after the grace period the other votes, the window closes and the round resolves | advance, finalize, recap | test | RoundRecapParityTests.The_latest_windows_skips_name_who_was_not_heard_from |
| rejects a vote inside the 30-second grace period | advance | elsewhere | Asserts `vote_skip_reaction_window`, slice 6 |
| the player being waited on, a spectator and a stall-excluded participant can't vote | advance | elsewhere | Asserts `vote_skip_reaction_window`, slice 6 |
| 4 participants, 1 being waited on: the 1st vote doesn't skip, the 2nd does; a repeat vote is a no-op | advance | elsewhere | Asserts `vote_skip_reaction_window`, slice 6 |
| a chained Reaction cast discards the votes so far and restarts the grace period | advance | elsewhere | Asserts `vote_skip_reaction_window`, slice 6 |
| 4 participants, 3 silent holders: one vote can't skip, and the stall backstop auto-passes them | advance | test | RoundRecapParityTests.The_latest_windows_skips_name_who_was_not_heard_from |
| the backstop counts from the latest poll round, not closed_at | advance | test | RoundRecapParityTests.The_latest_windows_skips_name_who_was_not_heard_from |
| an outstanding Reaction-timed Pending Spell Die still blocks after a skip; resolving it advances the round | advance, finalize | test | AdvanceRoundParityTests.Each_hold_kind_noops_with_the_sql_reason |

### `regression-net-working-cards.test.ts` (27)

| Test | RPC | Kind | C# equivalent |
|---|---|---|---|
| flat_modifier > Lucky Sip (+3 self) pushes the caster's total past the other roller | resolve | golden | `4a-flat-modifier-self-buff` |
| flat_modifier > Caffeinated Focus (+5 self) hands the brew to the other roller | resolve | golden | `4a-flat-modifier-self-buff` |
| flat_modifier > Brewer's Blessing (+5 self) hands the brew to the other roller | resolve | golden | `4a-flat-modifier-self-buff` |
| flat_modifier > Scalding Pour (-3 opponent) drags the target's total below the caster's | resolve | golden | `4a-flat-modifier-self-buff` |
| flat_modifier > Kettle Storm (-8 opponent) drags the target's total below the caster's | resolve | golden | `4a-flat-modifier-self-buff` |
| set_modifier > Milky Brew (set 0 self) wipes the caster's persistent snapshot for the round | resolve | golden | `4a-set-modifier-overrides-sibling-flat` |
| set_modifier > Mug Shot (set 0 opponent) wipes the target's persistent snapshot for the round | resolve | golden | `4a-set-modifier-overrides-sibling-flat` |
| set_modifier > Boil Over (set 0 self) wipes the caster's persistent snapshot for the round | resolve | golden | `4a-set-modifier-overrides-sibling-flat` |
| set_modifier > Caffeine Crash (set -1 self) overrides the caster's snapshot to a fixed -1 | resolve | golden | `4a-set-modifier-overrides-sibling-flat` |
| Double Shot (x2 self) scales the persistent snapshot, not the roll | resolve | golden | `4a-modifier-multiplier-scales-snapshot` |
| Six Sugars (1d6 self) adds its recorded roll as a positive flat delta | resolve | golden | `4a-flat-modifier-self-buff` |
| advantage (eager shim) > Sugar Rush (advantage self) makes the resolver adopt the kept high die | resolve | golden | `3-advantage-adopts-kept-high-die` |
| advantage (eager shim) > Fortune's Flavour (advantage self) makes the resolver adopt the kept high die | resolve | golden | `3-advantage-adopts-kept-high-die` |
| forced_reroll (eager shim) > Double Dunk forces the target's reroll and the resolver adopts it | resolve | golden | `3-forced-reroll-adopted` |
| forced_reroll (eager shim) > Re-Steep forces the target's reroll and the resolver adopts it | resolve | golden | `3-forced-reroll-adopted` |
| forced_reroll (eager shim) > Milk First? forces the target's reroll and the resolver adopts it | resolve | golden | `3-forced-reroll-adopted` |
| forced_reroll (eager shim) > Tea-M Reroll forces the target's reroll and the resolver adopts it | resolve | golden | `3-forced-reroll-adopted` |
| Dunkin Disaster (roll_swap) swaps the two rollers' values and the resolver adopts them | resolve | golden | `3-roll-flip-then-swap` |
| Zariel's Fall (roll_flip) flips every roll to 21 minus its value and the resolver adopts them | resolve | golden | `3-roll-flip-then-swap` |
| Cold Tea applies both halves: -3 on the opponent and the caster's positive 1d4 | resolve | golden | `4a-flat-modifier-self-buff`, `3-advantage-adopts-kept-high-die` |
| Slipped Spoon applies both halves: disadvantage on the opponent and the caster's positive 1d4 | resolve | golden | `4a-flat-modifier-self-buff`, `3-advantage-adopts-kept-high-die` |
| Tannin Tantrum negates the whole victim cast group when its d20 clears the victim card's tier DC | resolve | golden | `1-contested-negate-succeeds` |
| Broken Biscuit lifts the tied-lowest roller's composed modifier to the highest roller's | resolve | golden | `4c-lowest-gains-highest-modifier` |
| Drip Tray (tea_maker_override highest_modifier) names the top persistent snapshot and suppresses the gain | resolve | golden | `05-tea-maker-override-highest-modifier-no-gain` |
| Topsy-Tea (tea_maker_override highest_roll) names the top roller regardless of totals | resolve | golden | `05-tea-maker-override-highest-roll` |
| Inscribed Saucer (declared_number_tea_maker) names the first roller matching the declared number | resolve | golden | `05-declared-number-tea-maker` |
| Wild Brew Surge branches 2 / 3 / 5 produce the same modifier outcome via the projection | resolve | golden | `wild-2-persistent-plus-three-caster`, `wild-3-modifier-swap-pair`, `wild-5-high-low-modifier-swap-pair` |

### `resolve-round.test.ts` (37)

| Test | RPC | Kind | C# equivalent |
|---|---|---|---|
| a zero-cast round picks the lowest roll+modifier and emits an empty Trace | resolve | golden | `05-default-pick-empty-trace` |
| a flat_modifier cast composes into the pick and shows as a Trace step | resolve | golden | `4a-flat-modifier-self-buff` |
| a modifier_multiplier scales the persistent snapshot, not the roll | resolve | golden | `4a-modifier-multiplier-scales-snapshot` |
| set_modifier is absolute — it ignores a sibling flat effect and two sets resolve to the last by seq | resolve | golden | `4a-set-modifier-overrides-sibling-flat` |
| lowest_gains_highest_modifier lifts the tied-lowest roller's composed modifier to the highest roller's | resolve | golden | `4c-lowest-gains-highest-modifier` |
| tea_maker_override 'chosen' names the brewer regardless of the rolls | resolve | golden | `wild-6-tea-maker-override-chosen` |
| tea_maker_override 'highest_roll' picks the top roller | resolve | golden | `05-tea-maker-override-highest-roll` |
| tea_maker_override 'highest_modifier' with no_modifier_gain picks the top persistent snapshot and suppresses the gain | resolve | golden | `05-tea-maker-override-highest-modifier-no-gain` |
| declared_number_tea_maker beats a tea_maker_override, and resolve_round only reads it (does not consume) | resolve | golden | `05-declared-number-tea-maker` |
| a tie returns the sorted tied roster and no brewer | resolve | golden | `4a-spell-modifier-creates-layer0-tie` |
| a tie-break reroll layer (layer > 0) bypasses all spell logic | resolve | test | `EvaluatePipelineTests.Tie_layer_*` |
| Phase 3 adopts the eager shim's recorded roll_transform, flip before swap (issue #306) | resolve | golden | `3-roll-flip-then-swap` |
| Phase 3 reproduces the final rolls purely from cast_inputs, with no dependence on the live rolls.value (issue #306) | resolve | golden | `3-roll-flip-then-swap` |
| is idempotent: re-running over identical inputs yields the same outcome and Trace | resolve | test | `EvaluatePipelineTests.Evaluate_is_deterministic_and_leaves_the_snapshot_untouched`; `Phase4bTests` |
| a succeeded contested_negate suppresses the whole victim cast group and marks it negated | resolve | golden | `1-contested-negate-succeeds` |
| a failed contested_negate leaves the victim cast to compose, and reads as a no-op step | resolve | golden | `1-contested-negate-fails-is-noop-step` |
| DC is tier-derived from the victim card unless effect_params.dc (recorded in cast_inputs) overrides it | resolve | golden | `1-contested-negate-succeeds`, `1-nat1-backfire-reapplies-onto-reactor` |
| counter-of-counter (depth 2): the counter is itself countered, so the original victim effect applies | resolve | golden | `1-counter-of-counter-depth-2` |
| counter-of-counter-of-counter (depth 3): the top counter revives C1, re-negating the victim | resolve | golden | `1-counter-of-counter-depth-3` |
| redirect retargets a modifier cast onto the original caster, from recorded state (no in-place UPDATE) | resolve | golden | `1-redirect-retargets-modifier-cast` |
| Phase 1 is idempotent: re-resolving a round with a counter chain yields an identical Trace | resolve | test | `EvaluatePipelineTests.Evaluate_is_deterministic_and_leaves_the_snapshot_untouched`; `Phase4bTests` |
| a negated forced_reroll unwinds to the recorded before value (issue #308) | resolve | test | `3-fixed-roll-negated-unwinds` (the same unwind branch for another kind) |
| a nat-1 backfire leaves the victim to resolve and re-applies its flat_modifier onto the reactor, outcome 'backfired' | resolve | golden | `1-nat1-backfire-flat-with-recorded-payload` |
| a nat-1 backfire re-applies a disadvantage onto the reactor as a third-die-lowest roll step | resolve | golden | `1-nat1-backfire-disadvantage-third-die` |
| redirect on a multi-target countered cast moves only the reactor's own row; the other target still hits | resolve | golden | `1-redirect-moves-only-the-reactors-row` |
| Saving Steep {dc:10}: d20 >= 10 negates the whole victim group | resolve | golden | `1-contested-negate-succeeds` |
| Saving Steep {dc:10}: a 2-9 roll loses the contest — victim composes, no backfire, no-op step | resolve | golden | `1-contested-negate-fails-is-noop-step` |
| a counter with no recorded backfire payload never backfires on a nat 1 (Tannin Tantrum path) | resolve | golden | `1-contested-negate-fails-is-noop-step` |
| a negated advantage unwinds to the recorded before value (issue #308) | resolve | test | `3-fixed-roll-negated-unwinds` (the same unwind branch for another kind) |
| negating one row of a compound cast negates every row of the group (issue #308) | resolve | golden | `1-negating-one-row-negates-the-group` |
| Phase 4b writes room_players.modifier = base + delta for a transfer pair and reconciles the breakdown | resolve | golden | `4b-persistent-modifier-transfer-rest-of-day` |
| Phase 4b is idempotent — a second resolve_round leaves the cache and the steps unchanged | resolve | test | `EvaluatePipelineTests.Evaluate_is_deterministic_and_leaves_the_snapshot_untouched`; `Phase4bTests` |
| Phase 4b skips a negated transfer — the cache is not moved | resolve | test | `Phase4bTests.A_fully_negated_transfer_still_reverts_the_targets_cache` |
| admin_delete_round recomputes the cache with no bespoke revert | resolve | elsewhere | Asserts `admin_delete_round`, not slice 2b |
| Gambler's Infusion — first die >= 15 takes the advantage branch; resolver adopts the high die | resolve | golden | `3-conditional-advantage-branch-advantage` |
| Gambler's Infusion — first die <= 5 takes the disadvantage branch; resolver adopts the low die | resolve | test | `3-conditional-advantage-branch-advantage` (the mirror branch) |
| Gambler's Infusion — first die between the thresholds is a kept zero-impact conditional_advantage step | resolve | golden | `3-conditional-advantage-branch-none-noop` |

### `roll-and-resolve.test.ts` (3)

| Test | RPC | Kind | C# equivalent |
|---|---|---|---|
| submits layer-0 rolls, hides them until personally submitted, then resolves the brewer and increments their modifier | resolve | golden | `05-default-pick-empty-trace` |
| resolve_round rejects a brewer who isn't a participant in the round | resolve | test | `RoundAdvanceHttpTests.A_tea_maker_outside_the_round_is_a_422_problem_and_writes_nothing` |
| broadcasts a round-revealed event on the room's Realtime channel when resolved | resolve | test | `RoomStoreCommandTests.A_committed_write_bumps_the_version_and_delivers_the_event_with_it`, `AdvanceRoundCommandTests`, plus a real subscriber on the isolated stack (below) |

### `round-advancement.test.ts` (23)

| Test | RPC | Kind | C# equivalent |
|---|---|---|---|
| a spectator's render recovers a stranded window and the round resolves without error | advance | test | AdvanceRoundParityTests.An_open_window_noops, .Finalize_with_no_window_noops, .A_missing_roll_holds_the_layer |
| reactionWindowChanged while the window is still open is a noop | finalize | test | AdvanceRoundParityTests.An_open_window_noops, .Finalize_with_no_window_noops, .A_missing_roll_holds_the_layer |
| reactionWindowChanged at Layer 0 with no window never opens one | finalize | test | AdvanceRoundParityTests.An_open_window_noops, .Finalize_with_no_window_noops, .A_missing_roll_holds_the_layer |
| two concurrent reactionWindowChanged calls produce one resolution and one transform record | finalize | test | `AdvanceRoundCommandTests.Two_racing_calls_resolve_the_round_once` |
| a Provisional Recap read racing finalize_layer neither deadlocks nor errors | recap, finalize | test | RoundRecapParityTests.A_recap_read_does_not_wait_on_a_round_being_finalized |
| applies and records a flip at finalization | finalize | test | AdvanceRoundParityTests.An_unapplied_flip_is_recorded_and_flips_every_roll |
| applies and records a swap at finalization | finalize | test | AdvanceRoundParityTests.An_unapplied_swap_exchanges_high_and_low |
| applies and records a chosen-pair transform at finalization | finalize | test | AdvanceRoundParityTests.An_unapplied_chosen_pair_transform_applies_its_op |
| commits no-modifier-gain (Drip Tray) through finalize_layer | finalize | golden | `05-tea-maker-override-highest-modifier-no-gain` |
| commits a declared-number brewer (Inscribed Saucer) through finalize_layer, once | finalize | golden | `05-declared-number-tea-maker` |
| records a pending Round Replay (Time for Brew) through finalize_layer | finalize | test | AdvanceRoundParityTests.A_surviving_round_replay_is_recorded_as_pending |
| a tied Layer 0 advances to the Tie-Break Reroll Layer with the tied players | finalize | test | AdvanceRoundParityTests.A_tie_advances_the_layer_for_the_tied_players |
| layerRolled before the Layer is complete is a noop and opens no window | advance | test | AdvanceRoundParityTests.An_open_window_noops, .Finalize_with_no_window_noops, .A_missing_roll_holds_the_layer |
| Layer 0 with nobody eligible to react opens and finalizes within one layerRolled call | advance | test | `AdvanceRoundCommandTests.A_window_that_closes_on_the_spot_reveals_the_raw_rolls_then_the_result_at_one_version` |
| a Tie-Break Reroll Layer finalizes on its last roll with no reaction window | advance | test | AdvanceRoundParityTests.The_tie_break_layer_resolves_with_a_late_heist_moving_the_card |
| a Pending Spell Die resolved while the window is open leaves it open; the round resolves once the holders pass | advance, finalize | test | AdvanceRoundParityTests.Each_hold_kind_noops_with_the_sql_reason |
| a Pending Spell Die resolved after the window closed triggers Layer finalization | advance, finalize | test | AdvanceRoundParityTests.Each_hold_kind_noops_with_the_sql_reason |
| a Deferred Forced-Reroll Target set with no window opens the window (and, with no reactor, finalizes) | advance | test | AdvanceRoundParityTests.Pre_roll_transforms_attach_to_the_window_the_bridge_opens_and_are_shimmed |
| a deferred target set while a window already exists is a noop | advance | test | AdvanceRoundParityTests.An_open_window_noops, .Finalize_with_no_window_noops, .A_missing_roll_holds_the_layer |
| a stall-resolved Pending Spell Die at Layer 0 opens the reaction window instead of resolving directly | advance | elsewhere | Asserts stall enforcement (slice 7), which only calls the advance RPC afterwards; advance itself is covered by `AdvanceRoundParityTests` holds and `A_golden_scenario_advances_identically_in_both_engines` |
| a stall-abandoned Deferred Forced-Reroll Target at Layer 0 opens the reaction window instead of resolving directly | advance | elsewhere | Asserts stall enforcement (slice 7), which only calls the advance RPC afterwards; advance itself is covered by `AdvanceRoundParityTests` holds and `A_golden_scenario_advances_identically_in_both_engines` |
| stall exclusion at Layer 0 leads into the reaction window | advance | elsewhere | Asserts stall enforcement (slice 7), which only calls the advance RPC afterwards; advance itself is covered by `AdvanceRoundParityTests` holds and `A_golden_scenario_advances_identically_in_both_engines` |
| stall exclusion at a Tie-Break Reroll Layer finalizes it with no window | advance | elsewhere | Asserts stall enforcement (slice 7), which only calls the advance RPC afterwards; advance itself is covered by `AdvanceRoundParityTests` holds and `A_golden_scenario_advances_identically_in_both_engines` |

### `round-recap-rows.test.ts` (9)

| Test | RPC | Kind | C# equivalent |
|---|---|---|---|
| #407: a resolved round's rows carry the stored Resolution Summary, provisional false | resolve, recap | test | RoundRecapParityTests.A_golden_scenario_reads_the_same_before_and_after_it_resolves |
| #407: a warded flat modifier is a struck term and not in the total | resolve, recap | golden | `2-ward-blocks-modifier-cast` |
| #407: a redirected cast strikes the original target and lands on the new one | resolve, recap | golden | `1-redirect-retargets-modifier-cast` |
| #407: a Calami-Tea-floored 1 is not a nat 1 on the row | resolve, recap | golden | `3-calami-tea-floored-natural-1` |
| #407: a round with no summary (resolved before it existed) renders the degraded row | resolve, recap | test | RoundRecapParityTests.A_resolved_round_with_no_stored_summary_reads_the_same |
| #409: no Provisional Recap until layer 0 is complete, then a live dry run | recap | test | RoundRecapParityTests.A_round_with_nothing_rolled_is_not_provisional_and_reveals_nothing |
| #409: an unrolled Pending Spell Die holds the Provisional Recap back until its value lands | recap | test | RoundRecapParityTests.A_pending_die_or_a_deferred_target_holds_the_recap_back |
| #409: a spectator in the room (not in the round) reads the same Provisional Recap | recap | test | RoundRecapParityTests.A_spectator_in_the_room_may_read_and_nobody_else |
| #406: a spell-made layer-0 tie shows in every tied player's Reroll Chain | resolve, recap | golden | `4a-spell-modifier-creates-layer0-tie` |

### `round-replay.test.ts` (8)

| Test | RPC | Kind | C# equivalent |
|---|---|---|---|
| records a pending decision after a surviving Time for Brew resolves, and locks start_round | resolve | test | AdvanceRoundParityTests.A_surviving_round_replay_is_recorded_as_pending |
| confirm scraps the round to a clean generation-1 round and reverts the brewer's modifier gain | resolve, recap | test | RoundRecapParityTests.A_recap_reads_a_scrapped_generation_through_untouched |
| decline keeps the resolved round standing and clears the pending decision | resolve | elsewhere | Scrap and replay are `confirm_round_replay`, not slice 2b; the replayed round runs through the goldens as any other |
| a countered Time for Brew never becomes a pending decision | resolve | golden | `5-replay-scrapped-generation-summary` |
| auto_decline_stalled_round_replays clears a decision left past the 5-minute window | resolve | elsewhere | Scrap and replay are `confirm_round_replay`, not slice 2b; the replayed round runs through the goldens as any other |
| carries a negative roll-domain ward holder's layer-0 roll into generation 1 and emits a roll_frozen Trace step | resolve | golden | `5-replay-frozen-roller-step` |
| does not carry a roll over for 'Jinxed Biscuit (positive roll-domain)' | resolve | golden | `5-replay-frozen-roller-step` |
| does not carry a roll over for 'Eternal Steep (modifier-only)' | resolve | golden | `5-replay-frozen-roller-step` |

### `round-scoped-modifier-cards.test.ts` (3)

| Test | RPC | Kind | C# equivalent |
|---|---|---|---|
| Bes-Tea sets the caster's modifier for the round only and leaves the cache untouched | resolve | test | `4a-set-modifier-overrides-sibling-flat`, `4a-flat-modifier-self-buff`; effect kinds composed the same way, recorded at cast time (slice 4) |
| Tea Leaf zeroes the target's modifier and adds the stolen amount to the caster's roll, for the round only | resolve | test | `4a-set-modifier-overrides-sibling-flat`, `4a-flat-modifier-self-buff`; effect kinds composed the same way, recorded at cast time (slice 4) |
| Spillage moves floor(m/2) from the target to the caster for the round only | resolve | test | `4a-set-modifier-overrides-sibling-flat`, `4a-flat-modifier-self-buff`; effect kinds composed the same way, recorded at cast time (slice 4) |

### `spell-active-effects.test.ts` (1)

| Test | RPC | Kind | C# equivalent |
|---|---|---|---|
| Caffeine Crash composes into the modifier bucket for exactly its 2 remaining rounds, then expires | resolve | golden | `4a-carried-set-modifier-from-active-effect` |

### `stale-biscuit.test.ts` (1)

| Test | RPC | Kind | C# equivalent |
|---|---|---|---|
| traces the mark in its cast round as a next_draw mark | resolve | golden | `6-stale-biscuit-placed` |

### `stall-timeout.test.ts` (3)

| Test | RPC | Kind | C# equivalent |
|---|---|---|---|
| excludes a declared player who never rolls and resolves the round off the rest | advance | elsewhere | Asserts stall enforcement (slice 7), which only calls the advance RPC afterwards; advance itself is covered by `AdvanceRoundParityTests` holds and `A_golden_scenario_advances_identically_in_both_engines` |
| a stall-excluded Reaction-card holder doesn't hold a reaction window open (issue #463) | advance | elsewhere | Asserts stall enforcement (slice 7), which only calls the advance RPC afterwards; advance itself is covered by `AdvanceRoundParityTests` holds and `A_golden_scenario_advances_identically_in_both_engines` |
| excludes a stalled tie-break reroller and resolves off the remaining tied players | advance | test | `LayerReadiness` reads `excluded_at` at Layer > 0; `A_tie_advances_the_layer_for_the_tied_players`. The exclusion is slice 7 |

### `suppressed-gain-base-modifier.test.ts` (3)

| Test | RPC | Kind | C# equivalent |
|---|---|---|---|
| Drip Tray (highest_modifier, no_modifier_gain) brewer keeps zero gain after admin_delete_round recompute | resolve | golden | `05-tea-maker-override-highest-modifier-no-gain` |
| Eternal Steep (block_earned_modifier) warded brewer keeps zero gain after admin_delete_round recompute | resolve | golden | `2-ward-block-earned-modifier-zeroes-gain` |
| a normal brewer's gain is unchanged by the recompute and still shows in the breakdown | resolve | golden | `05-default-pick-empty-trace` |

### `targeting-skip.test.ts` (5)

| Test | RPC | Kind | C# equivalent |
|---|---|---|---|
| a Cloud of Cream holder is skipped as a lowest_gains_highest_modifier beneficiary; the next-lowest roller is lifted instead | resolve | golden | `4c-targeting-skip-excludes-holder` |
| a Cloud of Cream holder is skipped as the highest-modifier source; the lift value comes from the next-highest roller's composed modifier | resolve | golden | `4c-targeting-skip-excludes-holder` |
| with no Cloud of Cream, lowest_gains_highest_modifier still lifts the tied-lowest roller (control) | resolve | golden | `4c-lowest-gains-highest-modifier` |
| a Cloud of Cream holder is skipped by tea_maker_override 'highest_modifier'; the next-highest snapshot roller brews | resolve | golden | `05-highest-modifier-skips-cloud-of-cream-holder` |
| the flag does not change the default lowest-roll brewer pick or emit a skip step | resolve | golden | `05-default-pick-empty-trace` |

### `tea-cosy.test.ts` (7)

| Test | RPC | Kind | C# equivalent |
|---|---|---|---|
| the caster has no layer-0 roll; the round completes without it; the lowest roller brews | advance | golden | `05-tea-cosy-exempt-and-immune` |
| an override naming the caster can't make them brew: it falls through to the lowest roller | advance | golden | `05-brewer-immunity-override-falls-through` |
| the caster's own Loaf of Lipton can't make them brew either | advance | golden | `05-loaf-of-lipton-immune-caster-falls-through` |
| the immunity is gone next round: the caster rolls and can brew | advance | test | `ActiveEffectsTests`, `GoldenLivenessTests` |
| countered: no immunity and a late roll -- the caster rolls once the window closes and can brew | finalize, advance | test | RoundRecapParityTests.A_countered_exemption_stays_exempt_until_the_window_closes |
| every participant on Tea Cosy: resolved at close, immunity gives way to a Tie-Break Reroll among everyone | advance | golden | `05-tea-cosy-exempt-and-immune` |
| replay: the cast is gone -- the caster rolls normally and has no immunity | finalize, resolve | elsewhere | Scrap and replay are `confirm_round_replay`, not slice 2b; the replayed round runs through the goldens as any other |

### `tea-heist.test.ts` (10)

| Test | RPC | Kind | C# equivalent |
|---|---|---|---|
| a plain steal moves the card at finalize -- not at cast, not on a Provisional Recap view | recap, finalize | golden | `6-heist-moved` |
| countered: nothing moves and the Trace says countered | finalize | golden | `6-heist-countered` |
| fizzles when the victim plays the targeted card before rolling | finalize | golden | `6-heist-fizzled-victim-played-first` |
| fizzles (not countered) when the victim counters with the targeted card itself | finalize | golden | `6-heist-countered` |
| a repeated finalize is a no-op and doesn't double-move | finalize | test | AdvanceRoundParityTests.A_resolved_round_noops |
| lands the loot as a keep-or-swap choice when the thief picked up a card mid-round | finalize | GAP | Heist branch with no golden |
| fizzles when the thief's hand has no free slot (held + keep-or-swap) | finalize | test | `CommitTests.A_thief_with_a_full_hand_fizzles_the_heist` |
| a Time for Brew replay returns the stolen card to the victim; Tea Heist stays spent | finalize | elsewhere | Scrap and replay are `confirm_round_replay`, not slice 2b; the replayed round runs through the goldens as any other |
| a replay sends the card back to the deck when the victim's hand has refilled both slots | finalize | elsewhere | Scrap and replay are `confirm_round_replay`, not slice 2b; the replayed round runs through the goldens as any other |
| a replay leaves the card alone once the thief no longer holds it | finalize | elsewhere | Scrap and replay are `confirm_round_replay`, not slice 2b; the replayed round runs through the goldens as any other |

### `tea-maker-override-modifier-gain.test.ts` (6)

| Test | RPC | Kind | C# equivalent |
|---|---|---|---|
| a default-lowest brewer resolves with a null modifier gain and finalize_layer commits cups_made | resolve, finalize | golden | `05-default-pick-empty-trace` |
| a legacy no_modifier_gain override (Drip Tray) resolves with modifier gain 0 | resolve, finalize | golden | `05-tea-maker-override-highest-modifier-no-gain` |
| an override's modifier_gain is used as given and finalize_layer commits it to brewer_modifier_gain | resolve, finalize | golden | `05-tea-maker-override-prev-round-highest`, `05-loaf-of-lipton-skips-roll` |
| the 4-arg resolve_round write takes a modifier gain number: null is cups_made, 0 is none, else as given | resolve | test | Not ported on purpose: these write overloads go at #549 (`docs/port/recap-backfill-bridges.md`). `CommitTests` pins the one write |
| the boolean no-modifier-gain write stays as a compat alias | resolve | test | Not ported on purpose: these write overloads go at #549 (`docs/port/recap-backfill-bridges.md`). `CommitTests` pins the one write |
| a reserved mode (no card slice yet) stays out of the override contest instead of failing the round | resolve | GAP | A reserved override mode staying out of the contest has no golden |

### `tea-party-revolt.test.ts` (4)

| Test | RPC | Kind | C# equivalent |
|---|---|---|---|
| holds layer 0 while the pick is outstanding; after the pick the chosen player brews | advance, finalize | test | AdvanceRoundParityTests.Each_hold_kind_noops_with_the_sql_reason |
| finalize_layer reports the hold when the window is already closed | finalize | test | AdvanceRoundParityTests.Each_hold_kind_noops_with_the_sql_reason |
| a stalled pick is dropped, and the default lowest roller brews | advance | golden | `05-tea-party-revolt-pick-abandoned` |
| stall enforcement abandons an outstanding pick and the round resolves | advance | elsewhere | Asserts stall enforcement (slice 7), which only calls the advance RPC afterwards; advance itself is covered by `AdvanceRoundParityTests` holds and `A_golden_scenario_advances_identically_in_both_engines` |

### `tie-break-and-reroll.test.ts` (1)

| Test | RPC | Kind | C# equivalent |
|---|---|---|---|
| resolves a multi-layer tie (including a nat-1 tie) to a single brewer, off whichever layer it finally resolves on | resolve | test | `EvaluatePipelineTests.Tie_layer_*`, `AdvanceRoundParityTests.A_tie_advances_the_layer_for_the_tied_players` |

### `trace-snapshot.test.ts` (72)

| Test | RPC | Kind | C# equivalent |
|---|---|---|---|
| 05-default-pick-empty-trace | recap, resolve | golden | The golden itself |
| 05-tea-maker-override-highest-roll | recap, resolve | golden | The golden itself |
| 05-tea-maker-override-highest-modifier-no-gain | recap, resolve | golden | The golden itself |
| 05-tea-maker-override-prev-round-highest | recap, resolve | golden | The golden itself |
| 05-tea-maker-override-prev-round-highest-falls-through | recap, resolve | golden | The golden itself |
| 05-tea-maker-override-prev-round-highest-inert | recap, resolve | golden | The golden itself |
| 05-declared-number-tea-maker | recap, resolve | golden | The golden itself |
| 05-pg-tipped-condition-met | recap, resolve | golden | The golden itself |
| 05-pg-tipped-condition-not-met | recap, resolve | golden | The golden itself |
| 05-pg-tipped-not-met-earlier-override-stands | recap, resolve | golden | The golden itself |
| 05-tea-party-revolt-picked | recap, resolve | golden | The golden itself |
| 05-tea-party-revolt-pick-abandoned | recap, resolve | golden | The golden itself |
| 05-tea-party-revolt-abandoned-earlier-override-stands | recap, resolve | golden | The golden itself |
| 05-pg-tipped-compares-post-shim-rolls | recap, resolve | golden | The golden itself |
| 05-pg-tipped-redirected-onto-caster | recap, resolve | golden | The golden itself |
| 05-brewer-immunity-lowest-roller | recap, resolve | golden | The golden itself |
| 05-brewer-immunity-declared-number | recap, resolve | golden | The golden itself |
| 05-brewer-immunity-override-falls-through | recap, resolve | golden | The golden itself |
| 05-brewer-immunity-all-immune-tie | recap, resolve | golden | The golden itself |
| 05-earl-lowest-roller-next-lowest-brews | recap, resolve | golden | The golden itself |
| 05-earl-override-transfers-title | recap, resolve | golden | The golden itself |
| 05-earl-declared-number-no-transfer | recap, resolve | golden | The golden itself |
| 4a-flat-modifier-self-buff | recap, resolve | golden | The golden itself |
| 4a-courage-token-spend | recap, resolve | golden | The golden itself |
| 4a-spell-modifier-creates-layer0-tie | recap, resolve | golden | The golden itself |
| 4a-set-modifier-overrides-sibling-flat | recap, resolve | golden | The golden itself |
| 4a-modifier-multiplier-scales-snapshot | recap, resolve | golden | The golden itself |
| 4c-lowest-gains-highest-modifier | recap, resolve | golden | The golden itself |
| 4c-targeting-skip-excludes-holder | recap, resolve | golden | The golden itself |
| 1-contested-negate-succeeds | recap, resolve | golden | The golden itself |
| 1-contested-negate-fails-is-noop-step | recap, resolve | golden | The golden itself |
| 1-counter-of-counter-depth-2 | recap, resolve | golden | The golden itself |
| 1-redirect-retargets-modifier-cast | recap, resolve | golden | The golden itself |
| 1-nat1-backfire-reapplies-onto-reactor | recap, resolve | golden | The golden itself |
| 3-roll-flip-then-swap | recap, resolve | golden | The golden itself |
| 3-forced-reroll-adopted | recap, resolve | golden | The golden itself |
| 3-advantage-adopts-kept-high-die | recap, resolve | golden | The golden itself |
| 3-fixed-roll-pre-roll-kind | recap, resolve | golden | The golden itself |
| 3-roll-pair-transform-swap | recap, resolve | golden | The golden itself |
| 3-conditional-advantage-branch-advantage | recap, resolve | golden | The golden itself |
| 3-conditional-advantage-branch-none-noop | recap, resolve | golden | The golden itself |
| 2-ward-blocks-modifier-cast | recap, resolve | golden | The golden itself |
| 2-ward-blocks-roll-transform | recap, resolve | golden | The golden itself |
| 0-spell-copy-onto-apprentice-caster | recap, resolve | golden | The golden itself |
| 4b-persistent-modifier-transfer-rest-of-day | recap, resolve | golden | The golden itself |
| 4b-pre-bitter-leech-tick-synthesis | recap, resolve | golden | The golden itself |
| 3-pre-calami-tea-tick-warded | recap, resolve | golden | The golden itself |
| 3-calami-tea-floored-natural-1 | recap, resolve | golden | The golden itself |
| 5-replay-scrapped-generation-summary | resolve, recap | golden | The golden itself |
| 6-heist-moved | recap, resolve | golden | The golden itself |
| 6-marked-for-brew-placed | recap, resolve | golden | The golden itself |
| 6-marked-for-brew-redirected | recap, resolve | golden | The golden itself |
| 6-marked-for-brew-fizzled | recap, resolve | golden | The golden itself |
| 6-stale-biscuit-placed | recap, resolve | golden | The golden itself |
| 6-heist-countered | recap, resolve | golden | The golden itself |
| 6-heist-fizzled-victim-played-first | recap, resolve | golden | The golden itself |
| wild-1-room-reset | recap, resolve | golden | The golden itself |
| wild-2-persistent-plus-three-caster | recap, resolve | golden | The golden itself |
| wild-3-modifier-swap-pair | recap, resolve | golden | The golden itself |
| wild-4-table-forced-reroll | recap, resolve | golden | The golden itself |
| wild-5-high-low-modifier-swap-pair | recap, resolve | golden | The golden itself |
| wild-6-tea-maker-override-chosen | recap, resolve | golden | The golden itself |
| 1-brewmageddon-compelled-cast-and-forfeit | recap, resolve | golden | The golden itself |
| 05-loose-leaf-rolloff | recap, resolve | golden | The golden itself |
| 05-loose-leaf-two-player-inert | recap, resolve | golden | The golden itself |
| 05-loose-leaf-named-by-override | recap, resolve | golden | The golden itself |
| 05-loose-leaf-tied-second | recap, resolve | golden | The golden itself |
| 05-loose-leaf-holder-alone-second | recap, resolve | golden | The golden itself |
| 05-loaf-of-lipton-skips-roll | recap, resolve | golden | The golden itself |
| 05-tea-cosy-exempt-and-immune | recap, resolve | golden | The golden itself |
| 05-brew-iou-creates-debt | recap, resolve | golden | The golden itself |
| 05-brew-debt-round-paid | recap, resolve | golden | The golden itself |

### `ward-phase.test.ts` (13)

| Test | RPC | Kind | C# equivalent |
|---|---|---|---|
| a positive-polarity modifier ward blocks a positive flat_modifier: the cast row stays, the effect is removed, and a warded step is emitted | resolve | golden | `2-ward-blocks-modifier-cast` |
| a negative-polarity modifier ward does not block a positive buff | resolve | golden | `2-ward-positive-blocks-raising-set-and-multiplier` |
| a set_modifier that lowers the target is negative-polarity and is blocked by a negative ward | resolve | golden | `2-ward-negative-blocks-lowering-set-and-multiplier` |
| block_earned_modifier ward on the selected brewer zeroes their tea-making gain | resolve | golden | `2-ward-block-earned-modifier-zeroes-gain` |
| a warded tied-lowest roller is excluded from lowest_gains_highest_modifier; an unwarded tied-lowest roller is still lifted | resolve | golden | `4c-warded-tied-lowest-not-lifted` |
| the warded Trace step carries blocked_cast_id / ward_cast_id / ward_card_name / would_be_before / would_be_after | resolve | golden | `2-ward-blocks-modifier-cast` |
| is idempotent: re-running with a ward yields the same outcome and Trace | resolve | test | `EvaluatePipelineTests.Evaluate_is_deterministic_and_leaves_the_snapshot_untouched` |
| a roll-domain ward cancels a reaction-window roll_swap with no mutation to rolls.value | resolve | golden | `2-ward-blocks-roll-transform` |
| a roll-domain ward does not un-apply an advantage recorded before it | resolve | golden | `2-ward-blocks-roll-transform` |
| resolve_round emits a warded step for an advantage warded off at submit_roll, over the un-inflated roll | resolve | test | `2-ward-blocks-roll-transform`; the marker is written at submit_roll, slice 3 |
| a negative-only roll-domain ward does not touch a static advantage: the second die is still drawn | resolve | test | `2-ward-blocks-roll-transform`; the marker is written at submit_roll, slice 3 |
| a negative roll-domain ward blocks a static disadvantage at submit_roll: no second die is drawn and a warded step is emitted | resolve | test | `2-ward-blocks-roll-transform`; the marker is written at submit_roll, slice 3 |
| a NULL rounds_remaining ward is unbounded and stays in the projection across resolve_round; tier-scoped dispel still ends it | resolve | test | `ActiveEffectsTests` |

### `ward-transfer-interaction.test.ts` (7)

| Test | RPC | Kind | C# equivalent |
|---|---|---|---|
| a ward on the losing side blocks both sides of a Chai-nge swap; the card is still spent | resolve | GAP | Ward against a transfer card at cast time has no golden of its own |
| an unwarded Chai-nge swap still applies (control) | resolve | golden | `4b-persistent-modifier-transfer-rest-of-day` |
| the block is idempotent — a second resolve reproduces the caches and the Trace | resolve | test | `Phase4bTests` |
| a warded Tea Leaf target keeps their modifier and the caster gets no roll bonus | resolve | GAP | Ward against a transfer card at cast time has no golden of its own |
| a warded Spillage target keeps their modifier; an unwarded Spillage still moves floor(m/2) | resolve | GAP | Ward against a transfer card at cast time has no golden of its own |
| Bes-Tea against a block_copy holder resolves blocked — the caster's round modifier is unchanged | resolve | golden | `2-cast-time-ward-block-marker` |
| a Bitter Leech tick landing on a warded victim is skipped; a later tick after the ward expires still applies | resolve | test | `Phase4bTests.A_warded_tick_negates_the_pair_and_reverts_both_caches` |

### `yorkshire-terror.test.ts` (2)

| Test | RPC | Kind | C# equivalent |
|---|---|---|---|
| deferred target, no reactor: layer 0 holds until set_spell_cast_target, then the reroll lands (issue #325) | advance | test | AdvanceRoundParityTests.Each_hold_kind_noops_with_the_sql_reason |
| never-resolvable deferred target is force-negated by the stall timer as a recorded no-op (issue #325) | advance | elsewhere | Asserts stall enforcement (slice 7), which only calls the advance RPC afterwards; advance itself is covered by `AdvanceRoundParityTests` holds and `A_golden_scenario_advances_identically_in_both_engines` |
