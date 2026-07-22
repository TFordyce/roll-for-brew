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

### TABLE/WILD target — casting RPCs don't handle these stamps at all
`cast_spell_card` and `cast_reaction_spell_card` only branch on
SELF/OPPONENT/PLAYER; a TABLE or WILD card raises `"% -targeted cards
cannot be cast pre-roll yet"` today, regardless of `effect_kind`.

- Boil Over, Tea-M Reroll, Dunkin Disaster, Broken Biscuit, Drip Tray,
  Inscribed Saucer, Scalding Pour (rare)
- Kettle Crash, Wild Brew Surge, Time for Brew, Zariel's Fall, Topsy-Tea,
  Kettle Storm (epic)

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
- Tea Cosy, Drip Tray*, Loose Leaf, PG Tipped, Loaf of Lipton, Brew IOU
  (rare) — *Drip Tray is TABLE-scoped too, listed once above
- The Last Cuppa, Earl of Earl Grey, Topsy-Tea* (epic) — *Topsy-Tea is
  TABLE-scoped too, listed once above

### Roll manipulation beyond forced_reroll's shape
`forced_reroll` replaces one player's roll with a *fresh random* reroll.
These cards need a different roll transformation:

- Brew-tal Swap (swaps two existing rolls, doesn't generate new ones)
- Sleeping Camomile (forces a fixed result of natural 1, not a reroll)
- Steaming Mug Bond (both players count as the lower of their two rolls)
- Stir the Pot (swaps two *other* players' rolls — the OPPONENT/PLAYER
  target model is caster-vs-one-other, not "two players besides the caster")
- Zariel's Fall (rewrites every roll in the layer via a formula) — TABLE-
  scoped too, listed once above
- Yorkshire Terror — mechanically identical to Milk First?'s forced_reroll,
  but Action-timed (pre-roll) rather than Reaction-timed. The current
  plumbing (`get_forced_reroll_targets`/`apply_forced_reroll`) only reads
  casts tied to a `reaction_window_id`, so an Action-cast `forced_reroll`
  row would never be picked up at layer-finalize time — this needs the
  primitive's timing extended, not just a data row.

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
