-- Spell Cards 5/5: full 65-card catalog mapping (issue #70, child of the
-- spell-cards spec map #65). Blocked-by #68 (0021, reaction window/
-- contested_negate/redirect/forced_reroll) and #69 (0020, lasting effects),
-- both merged ahead of this ticket.
--
-- This is a data-mapping pass over primitives already built across
-- #66-#69, not a place to invent new engine mechanisms (per #70's own scope
-- note). 15 of 65 cards were already mapped (0017: Lucky Sip, Caffeinated
-- Focus, Brewer's Blessing, Double Shot, Milky Brew, Sugar Rush, Fortune's
-- Flavour; 0020: Caffeine Crash, Cloud of Cream, Lesser Detox; 0021: Tannin
-- Tantrum, Mug Mirror, Double Dunk, Re-Steep, Milk First?). This migration
-- adds every remaining card whose effect text is a clean, lossless fit for
-- one of the 11 existing effect_kind values:
--
--   Six Sugars   (common, R, SELF)     "Add 1d6 to your roll this round."
--                -> dice_modifier {"dice":"1d6"}, identical shape to the
--                   already-supported dice_modifier resolution in
--                   cast_spell_card/cast_reaction_spell_card (0019/0021).
--   Mug Shot     (rare,   R, OPPONENT) "Negate a target's modifier for this
--                   round only." -> set_modifier {"value":0}, the same
--                   mechanic as Milky Brew, just Reaction-timed; the
--                   modifier bucket (get_round_modifier_effects) already
--                   resolves numeric-kind casts identically regardless of
--                   whether they came from cast_spell_card or
--                   cast_reaction_spell_card, so no engine change is needed.
--   Greater Detox (epic, A, CARD)      "End an ongoing Rare or Epic
--                   condition on any player." -> dispel {"tiers":["rare",
--                   "epic"]}, the same primitive as Lesser Detox (0020)
--                   with the wider tier scope its own card text specifies.
--
-- The remaining 47 cards do not cleanly fit any existing primitive and are
-- deliberately left null rather than force-fit (per #70's acceptance
-- criteria) — see research/spell-cards-effect-mapping.md for the full,
-- reasoned gap list per card (grouped by the missing capability: TABLE/WILD
-- casting isn't handled by cast_spell_card/cast_reaction_spell_card at all;
-- compound cards apply two simultaneous effects to two different targets,
-- which the single effect_kind/effect_params column can't represent without
-- dropping one half; several cards need dynamic, cast-time-computed amounts
-- (e.g. "half of a target's current modifier") rather than a fixed
-- per-card param; others are tea-maker-selection, card-theft, or copy-effect
-- mechanics with no numeric-modifier/advantage/dispel/reroll/contest/redirect
-- analog at all. That document is this ticket's concrete "follow-up
-- decision" artifact.
update public.spell_cards set effect_kind = 'dice_modifier', effect_params = '{"dice": "1d6"}'::jsonb
 where name = 'Six Sugars';

update public.spell_cards set effect_kind = 'set_modifier', effect_params = '{"value": 0}'::jsonb
 where name = 'Mug Shot';

update public.spell_cards set effect_kind = 'dispel', effect_params = '{"tiers": ["rare", "epic"]}'::jsonb
 where name = 'Greater Detox';
