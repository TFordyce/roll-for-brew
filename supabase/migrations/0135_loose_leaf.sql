-- Loose Leaf (issue #431, spec #401, design #380).
--
-- Loose Leaf (Rare, SELF, Reaction): "When you are named tea-maker, force a
-- roll-off against the second-lowest roller. Both roll d20 -- the loser makes
-- tea instead."
--
-- Model (ADR 0005 precedence ladder, tier 3):
--   * Cast into the layer-0 Reaction Window, the card arms a
--     `named_tea_maker_rolloff` effect for this round: a CASTER Cast Log row
--     that cast_reaction_spell_card's generic branch records with the caster
--     as its target. No by-name branch. A counter negates it in Phase 1.
--   * Tea-maker selection (_rr_select_tea_maker) checks it once the brewer is
--     named, by any tier. The holder named -> an unfinished `rolloff` outcome
--     against the second-lowest layer-0 roller (post-shim roll, then composed
--     modifier; Brewer Candidates only) -- every roller tied there joins it,
--     no player-id tiebreak. No distinct second-lowest (fewer than three in
--     that order, or the holder alone is second-lowest) -> the card does
--     nothing, with a no-op Trace step.
--   * finalize_layer commits a roll-off like a tie: a Tie-Break Reroll Layer
--     for the holder and opponents, with a tie-shaped outcome, so the existing
--     tie broadcast, modal and flow run the roll-off. The lowest roll brews with normal
--     modifier gain; a tied roll-off goes to another Layer.
-- The function bodies are canonical in db/sql/functions/ and ship in the
-- generated migration that follows this one (ADR 0006).
--
-- This migration: the effect_kind CHECK widening, the card's effect row and
-- its un-bench.

-- ---------------------------------------------------------------------------
-- 1. effect_kind CHECK constraints -- add `named_tea_maker_rolloff` to the
--    catalog and the Cast Log. It is never an active effect (this round only,
--    read from the Cast Log), so spell_active_effects is untouched.
-- ---------------------------------------------------------------------------
alter table public.spell_card_effects drop constraint spell_card_effects_effect_kind_check;
alter table public.spell_card_effects add constraint spell_card_effects_effect_kind_check
  check (effect_kind in (
    'flat_modifier', 'dice_modifier', 'modifier_multiplier', 'set_modifier',
    'advantage', 'disadvantage', 'dispel',
    'forced_reroll', 'contested_negate', 'redirect',
    'reset_persistent_modifier',
    'roll_swap', 'roll_flip', 'fixed_roll', 'roll_pair_transform', 'lowest_gains_highest_modifier',
    'tea_maker_override', 'declared_number_tea_maker', 'wild_dispatch',
    'ward', 'persistent_modifier_transfer', 'persistent_modifier_spend',
    'round_replay', 'draw_redirect', 'targeting_skip', 'per_round_dice_tick',
    'card_heist', 'compel_cast', 'brewer_immunity', 'named_tea_maker_rolloff'
  ));

alter table public.spell_casts drop constraint spell_casts_effect_kind_check;
alter table public.spell_casts add constraint spell_casts_effect_kind_check
  check (effect_kind is null or effect_kind in (
    'flat_modifier', 'dice_modifier', 'modifier_multiplier', 'set_modifier',
    'advantage', 'disadvantage', 'dispel',
    'forced_reroll', 'contested_negate', 'redirect',
    'reset_persistent_modifier',
    'roll_swap', 'roll_flip', 'fixed_roll', 'roll_pair_transform', 'lowest_gains_highest_modifier',
    'tea_maker_override', 'declared_number_tea_maker', 'wild_dispatch',
    'ward', 'persistent_modifier_transfer', 'persistent_modifier_spend',
    'round_replay', 'draw_redirect', 'targeting_skip', 'per_round_dice_tick',
    'card_heist', 'compel_cast', 'forfeit', 'brewer_immunity', 'named_tea_maker_rolloff'
  ));

-- ---------------------------------------------------------------------------
-- 2. Loose Leaf's effect row. duration_rounds stays NULL and there's no
--    `persist` marker, so record_active_effect_if_persistent never promotes
--    it: the effect lives for this round, in the Cast Log.
-- ---------------------------------------------------------------------------
insert into public.spell_card_effects (card_id, target_role, effect_kind, effect_params)
select sc.id, 'CASTER', 'named_tea_maker_rolloff', '{}'::jsonb
  from public.spell_cards sc
 where sc.name = 'Loose Leaf'
   and not exists (
     select 1 from public.spell_card_effects e where e.card_id = sc.id
   );

-- ---------------------------------------------------------------------------
-- 3. Un-bench Loose Leaf. Guarded on location so this is a no-op where 0074
--    never ran; never touches an instance a player currently holds.
-- ---------------------------------------------------------------------------
update public.spell_deck_instances sdi
   set location = 'in_deck', held_by_player = null
  from public.spell_cards sc
 where sc.id = sdi.card_id
   and sc.name = 'Loose Leaf'
   and sdi.location = 'benched';
