# Spell card effect mapping — full 65-card catalog status (issue #70)

Resolves [Spell Cards 5/5: Full 65-card catalog mapping](https://github.com/TFordyce/roll-for-brew/issues/70),
a child ticket of [Roll for Brew: Spell Cards spec map](https://github.com/TFordyce/roll-for-brew/issues/51).

This is a data-mapping pass over the primitives already built across
#66-#69 (`supabase/migrations/0017`-`0021`), not a place to invent new
mechanisms. Per #70's own scope note, any card whose effect text doesn't
cleanly fit one of the 11 existing `effect_kind` values is flagged here as a
follow-up decision rather than force-fit into a lossy approximation.

**Status: 18 of 65 cards mapped, 47 flagged as gaps** (grouped by missing
capability below). Of the 18: 15 were already mapped by earlier tickets
(0017/0020/0021); this ticket's migration (`0022_spell_cards_catalog_full_
mapping.sql`) adds 3 more (Six Sugars, Mug Shot, Greater Detox) — every
remaining card that's a clean, lossless fit for an existing primitive.

## Mapped (18)

| Card | Tier | effect_kind | effect_params | Added by |
|---|---|---|---|---|
| Lucky Sip | common | `flat_modifier` | `{"delta":3}` | 0017 |
| Caffeinated Focus | common | `flat_modifier` | `{"delta":5}` | 0017 |
| Brewer's Blessing | common | `flat_modifier` | `{"delta":5}` | 0017 |
| Double Shot | rare | `modifier_multiplier` | `{"multiplier":2}` | 0017 |
| Milky Brew | rare | `set_modifier` | `{"value":0}` | 0017 |
| Sugar Rush | common | `advantage` | `{}` | 0017 |
| Fortune's Flavour | common | `advantage` | `{}` | 0017 |
| Caffeine Crash | rare | `set_modifier` | `{"value":-1}`, 2 rounds | 0020 |
| Cloud of Cream | common | `hidden_modifier` | `{}`, 2 rounds | 0020 |
| Lesser Detox | common | `dispel` | `{"tiers":["common"]}` | 0020 |
| Tannin Tantrum | common | `contested_negate` | `{}` | 0021 |
| Mug Mirror | rare | `redirect` | `{}` | 0021 |
| Double Dunk | common | `forced_reroll` | `{}` | 0021 |
| Re-Steep | common | `forced_reroll` | `{}` | 0021 |
| Milk First? | common | `forced_reroll` | `{}` | 0021 |
| **Six Sugars** | common | `dice_modifier` | `{"dice":"1d6"}` | **0022 (#70)** |
| **Mug Shot** | rare | `set_modifier` | `{"value":0}` | **0022 (#70)** |
| **Greater Detox** | epic | `dispel` | `{"tiers":["rare","epic"]}` | **0022 (#70)** |

Six Sugars and Mug Shot are Reaction-timed; both prove that a numeric-kind
Reaction cast composes into `get_round_modifier_effects` identically to a
pre-roll Action cast (`tests/integration/spell-cards-reaction-modifiers.
test.ts`). Greater Detox mirrors Lesser Detox with the wider tier scope its
own text specifies (`tests/integration/spell-active-effects.test.ts`).

## Gaps (47), grouped by missing capability

### TABLE/WILD target — RESOLVED (issue #115, `0033_spell_cards_table_wild_casting.sql`)
`cast_spell_card`/`cast_reaction_spell_card` now resolve TABLE/
ALL_OTHER_PLAYERS/CHOSEN_PLAYERS/WILD `target_role`s (0032 reserved these
but rejected every card stamped that way outright). All 13 previously-gap
cards are mapped:

- Boil Over (`set_modifier`/TABLE), Tea-M Reroll (`forced_reroll`/TABLE),
  Scalding Pour (`flat_modifier`/ALL_OTHER_PLAYERS), Kettle Storm
  (`flat_modifier`/ALL_OTHER_PLAYERS) — clean fits, fanned out to the
  round's roster (deferred to `close_round` for a pre-roll 'A' cast, since
  the roster isn't final until then; immediate for a Reaction 'R' cast).
- Dunkin Disaster (`roll_swap`), Zariel's Fall (`roll_flip`), Broken Biscuit
  (`lowest_gains_highest_modifier`) — new roll-transform primitives,
  resolved at reaction-window finalize time via new `apply_*` RPCs, the
  same "UPDATE `rolls.value` in place, patch the in-memory array" pattern
  `apply_forced_reroll` (0021) already established.
- Drip Tray, Topsy-Tea — new `tea_maker_override` primitive (modes
  `highest_modifier`/`highest_roll`), consumed client-side in
  `applyLayerOutcome` before `resolveLayer` runs, since brewer selection is
  TS-owned. Drip Tray's "no modifier gained" carve-out is a new
  `resolve_round` param (`p_no_modifier_gain`). This also resolves the two
  TABLE-scoped cross-references in "Tea-maker selection/forcing" below —
  the rest of that gap (Tea Party Revolt, Tea Cosy, etc.) is untouched.
- Kettle Crash — new `reset_persistent_modifier` primitive, zeroes
  `room_players.modifier` room-wide immediately (not round-scoped, so no
  fan-out needed). Simplified: only the "modifiers reset to 0" half of its
  text is implemented — "the day starts again, mechanically" isn't given a
  literal meaning beyond that.
- Wild Brew Surge — the d6 branch is rolled and dispatched inline in
  `cast_spell_card` (not data-driven; the six outcomes are mutually
  exclusive alternatives, not simultaneous effect rows), reusing
  `reset_persistent_modifier`/a new `persistent_modifier_delta`/a new
  `persistent_modifier_swap`/the TABLE `forced_reroll` fan-out/
  `tea_maker_override` for its six branches respectively.
- Inscribed Saucer — new `declared_number_tea_maker` primitive, persisted
  in `spell_active_effects` across rounds until some future roll matches
  the declared number, then self-consumes.
- Time for Brew — **simplified, not literal**: its card text describes a
  true state-rollback/replay ("scrap the result... the round is replayed
  entirely"), which would mean unwinding an already-resolved round — out of
  proportion for this ticket. Mapped instead to the same `forced_reroll`/
  TABLE shape as Tea-M Reroll (everyone rerolls, brewer redetermined from
  the new rolls). Flagged for follow-up if this narrower reading isn't
  good enough at the table.

Also lands `CHOSEN_PLAYERS` target-role support (a caster picks up to N
players at cast time, validated immediately rather than deferred) and maps
it onto Calami-Tea (previously unmapped) to exercise it end-to-end — with
its 1d4-per-round text simplified to a flat -2 approximation, reusing the
existing modifier-bucket/persistence machinery instead of adding a bespoke
per-round-dice-reroll primitive for one card.

### Compound cards — one card, two simultaneous effects on two targets
A single `effect_kind`/`effect_params` row can't represent "opponent gets a
penalty AND caster gets a bonus" without silently dropping one half.

- Slipped Spoon (disadvantage on opponent + 1d4 for caster)
- Cold Tea (flat penalty on opponent + 1d4 for caster)

### Dynamic, cast-time-computed amounts — not a fixed per-card param
Several cards key off a value only known at cast time (another player's
*current* modifier), which `effect_params` (fixed per catalog row) can't
express without a bespoke resolver — new-primitive territory, not mapping.

- Bes-Tea (copy another player's current modifier)
- Tea Leaf (steal a target's current modifier)
- Spillage (halve a target's current modifier)
- Chai-nge of Heart (swap current modifiers between two players)
- Tea-tally Spent (player elects an amount at cast time)

### Tea-maker selection/forcing — not a modifier-bucket effect
No primitive expresses "override who makes tea this round," with or
without the "gains no modifier from this tea-making" carve-out several of
these cards attach.

- Tea Party Revolt, Last Drip (common)
- Tea Cosy, Loose Leaf, PG Tipped, Loaf of Lipton, Brew IOU (rare) — Drip
  Tray (also rare) is RESOLVED via `tea_maker_override`, see #115 above
- The Last Cuppa, Earl of Earl Grey (epic) — Topsy-Tea (also epic) is
  RESOLVED via `tea_maker_override`, see #115 above

### Roll manipulation beyond forced_reroll's shape
`forced_reroll` replaces one player's roll with a *fresh random* reroll.
These cards need a different roll transformation:

- Brew-tal Swap (swaps two existing rolls, doesn't generate new ones) — the
  `roll_swap` primitive #115 added for Dunkin Disaster (TABLE-wide swap of
  the layer's highest/lowest) does the swap mechanics generically, but
  Brew-tal Swap is OPPONENT-targeted (a *chosen* pair, not highest/lowest) —
  needs a target-aware variant, not just a data row.
- Sleeping Camomile (forces a fixed result of natural 1, not a reroll)
- Steaming Mug Bond (both players count as the lower of their two rolls)
- Stir the Pot (swaps two *other* players' rolls — the OPPONENT/PLAYER
  target model is caster-vs-one-other, not "two players besides the caster")
- Zariel's Fall (rewrites every roll in the layer via a formula) — RESOLVED
  via the new `roll_flip` primitive, see #115 above
- Yorkshire Terror — mechanically identical to Milk First?'s forced_reroll,
  but Action-timed (pre-roll) rather than Reaction-timed. #115's
  `open_reaction_window` change (attaching a pre-roll-armed `forced_reroll`
  cast to the layer-0 window once it opens, added for Wild Brew Surge's
  "everyone rerolls" branch) incidentally unblocks this too — Yorkshire
  Terror itself is still unmapped (no `spell_card_effects` row), but the
  RPC-timing blocker this note originally described no longer applies.

### Counterspell variant distinct from contested_negate
- Saving Steep — fixed DC 10 regardless of tier, plus a "nat 1 doubles the
  effect against you" backfire clause. Neither matches `contested_negate`'s
  DC-by-tier, no-backfire shape; would need its own `effect_kind` (e.g.
  `save_or_double`).

### Buff-blocking / immunity — no primitive for "block other effects"
- Jinxed Biscuit ("cannot benefit from any buff card" for 3 rounds)
- Bag for Life ("cannot be reduced, copied, or affected by any card")
- Eternal Steep ("no card can alter their modifier")

### Card-transfer / draw-redirection / copy-effect — unrelated to the
### modifier bucket or reaction primitives
- Marked for Brew, Tea Heist, Stale Biscuit (rare — steals/redirects a card
  or a future draw)
- Saucerer's Apprentice, Genie in the Teapot (rare/epic — copies an
  arbitrary other card's effect generically)

### Multi-target / per-round dynamic — spell_active_effects is single-target
- Calami-Tea (up to 3 chosen players)
- Bitter Leech (per-round drain from one player, transferred to a second,
  over 3 rounds — dual-target, not just single-target-with-duration)

### Gifting a one-shot Reaction token
- Liquid Courage (gives another player a d6 usable once within 3 rounds as
  a Reaction to any roll) — no primitive for handing off a reusable
  Reaction effect to someone who doesn't hold the card.

### Persistent advantage/disadvantage — not yet an allowed active-effect kind
- Prophe-Tea ("roll every round with advantage, rest of the day") —
  `spell_active_effects.effect_kind`'s check constraint only allows
  `flat_modifier`/`dice_modifier`/`modifier_multiplier`/`set_modifier`/
  `hidden_modifier`; `advantage`/`disadvantage` were never added, so
  `record_active_effect_if_persistent` can't carry a persistent advantage
  effect today.

## PR #60 casting-UI placeholder ("Hex of the Broken Biscuit")

Per #70's acceptance criteria, checked whether this placeholder card name
needs swapping in shipped UI copy. PR #60 (the casting-UI prototype that
introduced it) was closed, not merged — `prototype/casting-ui/index.html`
never landed on `master` or any ancestor of it. The string appears nowhere
in the current tree except `research/spell-cards-transcription.md`'s own
reconciliation section, where it's already correctly documented as a
non-existent card (closest analog: Calami-Tea). There is no shipped UI
copy to swap.
