-- Issue #440 (spec #401, design #385): Brewmageddon -- Compelled Cast and
-- Forfeit (CONTEXT.md).
--
-- "All players must immediately play their spell card this round. Players
-- holding no card are unaffected."
--
-- The model, in one place:
--  * Brewmageddon is an ordinary Action / TABLE cast: one `compel_cast` row.
--  * close_round fixes the compelled set onto that row as
--    cast_inputs.compelled = [{ player_id, card_instance_id, casting_time }]:
--    every non-excluded participant holding a card at close. The set is
--    fixed once and is not an active effect, so a Round replay (whose scrap
--    deletes the cast) never re-fires it.
--  * An obligation is met by any spell_casts row the holder makes with that
--    card instance carrying cast_inputs.compelled_by = the Brewmageddon cast:
--    a compelled cast, or a `forfeit` row. _compelled_outstanding derives
--    what is still owed; nothing is counted or flagged separately.
--  * Compelled Cast step: while any Action holder still owes a cast, nobody
--    rolls (is_expected_layer_roller is false at Layer 0, and Layer 0 is held
--    incomplete). cast_spell_card / end_active_effect accept a compelled cast
--    while the round is `closed`, with no deferred target.
--  * Compelled Reaction holders cast in the Layer-0 Reaction Window and
--    cannot pass it. Skipped by vote or by the stall backstop, they Forfeit.
--  * Forfeit: the card goes back to the deck and a no-effect `forfeit` row
--    records it, pointing at Brewmageddon. Triggers: no legal target (Action
--    cards when the set is fixed, Reaction cards when the window opens); the
--    stall clock (forfeit_stalled_compelled_casts, its own branch); exclusion
--    for never rolling; being skipped in the Reaction Window.
--  * Brewmageddon countered: casts already made stand, and whoever still owes
--    a cast is released (_compelled_outstanding reads the live negation).
--
-- Every function this issue adds or changes is canonical in db/sql/functions/
-- (ADR 0006) and lands in the generated migration that follows this one:
-- the new helpers and RPCs (_compelled_*, _forfeit_*, _fix_compelled_set,
-- _fan_out_table_placeholder_casts, _rr_finish_compelled_cast,
-- _rr_brewmageddon_negated, get_my_compelled_cast, get_compelled_cast_step,
-- forfeit_stalled_compelled_casts) and the changed ones (close_round,
-- cast_spell_card, cast_reaction_spell_card, advance_layer,
-- _layer_is_complete, _rr_resolve_eval, get_round_recap,
-- is_expected_layer_roller, exclude_round_participant, pass_reaction_window,
-- _auto_pass_reaction_window, end_active_effect, admin_proxy_roll,
-- get_reaction_stack). This migration holds only the schema and data
-- changes, which the generated one's functions depend on.

-- ---------------------------------------------------------------------------
-- 1. Effect kinds: `compel_cast` (Brewmageddon) and `forfeit` (the Cast Log
--    row a Forfeit leaves). Neither is ever an active effect.
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
    'card_heist', 'compel_cast'
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
    'card_heist', 'compel_cast', 'forfeit'
  ));

-- ---------------------------------------------------------------------------
-- 2. Brewmageddon's effect row. TABLE + a kind the generic cast loop does not
--    fan out, so cast_spell_card writes one row with no target.
-- ---------------------------------------------------------------------------
insert into public.spell_card_effects (card_id, target_role, effect_kind, effect_params, ordinal)
select id, 'TABLE', 'compel_cast', '{}'::jsonb, 0
  from public.spell_cards
 where name = 'Brewmageddon'
   and not exists (
     select 1 from public.spell_card_effects e
      where e.card_id = spell_cards.id and e.effect_kind = 'compel_cast'
   );

-- ---------------------------------------------------------------------------
-- 3. Un-bench Brewmageddon (benched by 0074 for having no effect rows).
-- ---------------------------------------------------------------------------
update public.spell_deck_instances sdi
   set location = 'in_deck'
  from public.spell_cards sc
 where sc.id = sdi.card_id
   and sc.name = 'Brewmageddon'
   and sdi.location = 'benched';
