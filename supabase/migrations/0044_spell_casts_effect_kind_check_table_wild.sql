-- Fix #143: spell_casts_effect_kind_check (defined in 0021, before TABLE/WILD
-- casting existed) was never widened when 0033 added the TABLE/WILD
-- primitives to spell_card_effects/spell_active_effects. cast_spell_card's
-- WILD dispatch (Wild Brew Surge, effect_kind = 'wild_dispatch') and its
-- declared_number_tea_maker insert (Inscribed Saucer) both insert into
-- spell_casts and have been failing the check constraint ever since --
-- masked in CI until #137's grant fix stopped table-permission errors from
-- shadowing it first.
--
-- Widen spell_casts' constraint to the same full effect_kind union 0033
-- already applied to spell_card_effects (spell_casts's superset, since it
-- also carries every already-resolved cast row), keeping all three tables'
-- constraints in sync.
alter table public.spell_casts drop constraint spell_casts_effect_kind_check;
alter table public.spell_casts add constraint spell_casts_effect_kind_check
  check (effect_kind is null or effect_kind in (
    'flat_modifier', 'dice_modifier', 'modifier_multiplier', 'set_modifier',
    'advantage', 'disadvantage', 'hidden_modifier', 'dispel',
    'forced_reroll', 'contested_negate', 'redirect',
    'reset_persistent_modifier', 'persistent_modifier_delta', 'persistent_modifier_swap',
    'roll_swap', 'roll_flip', 'lowest_gains_highest_modifier',
    'tea_maker_override', 'declared_number_tea_maker', 'wild_dispatch'
  ));
