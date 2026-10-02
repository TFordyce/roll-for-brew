-- Liquid Courage (issue #439, spec #401, design #384).
--
-- Liquid Courage (Rare, OPPONENT, Action): "Give another player a d6. In the
-- next 3 rounds they may use it as a Reaction to add to their roll."
--
-- Model: a Courage Token (CONTEXT.md) -- a Reaction Source that isn't a card.
--   * The gift is an ordinary cast. Its one effect row, TARGET / courage_token
--     `{dice: 1d6, persist: true, participated_rounds_from_cast: 3}`, is
--     promoted to an unbounded spell_active_effects row on the recipient
--     (record_active_effect_if_persistent: `persist`). A deferred target is
--     projected once it is set, as for any OPPONENT card.
--   * Lifetime: _rr_active_effects_as_of keeps the token live while the
--     recipient has taken part in fewer than 3 resolved rounds counted FROM
--     the gift round (inclusive -- the gift round counts once it resolves; a
--     no-roll round they took part in counts too). Rooms are daily, so a
--     token dies at day end.
--   * Spend: spend_courage_token, in an open Layer-0 Reaction Window, writes a
--     Six Sugars-shaped row -- CASTER / dice_modifier `{dice: 1d6}` on the
--     spender, pointing at the gifting card instance and flagged
--     cast_inputs.courage_token_cast_id. It is a Pending Spell Die (rolled
--     in-app or entered manually) that Phase 4a adds after advantage /
--     disadvantage has picked the kept d20. "Spent" is derived: a token with
--     a non-negated spend row is no longer live. No counter.
--   * Reaction Source: _is_reaction_source (a held Reaction card, or a live
--     unspent token in a Layer-0 window for a player with a Layer-0 roll)
--     backs count_eligible_reaction_holders, pass_reaction_window, the
--     waiting-on set (pending players, Skip vote, stall timeout) and
--     get_open_reaction_window's `eligible`.
--   * A spend is not a card: get_reaction_stack hides it, a CARD-target
--     Reaction refuses it, and the resolver's card-group matches (Phase 1
--     negation, seize, backfire, ward pre-pass) skip it. A spend is void
--     only when its gift cast is negated.
--   * Greater Detox (rare/epic) can end an unspent token; Lesser Detox
--     (common) can't -- the existing tier rule. A Round replay deletes the
--     scrapped attempt's spend rows, so the token is unspent again.
-- The function bodies are canonical in db/sql/functions/ and ship in the
-- generated migration that follows this one (ADR 0006).
--
-- This migration: the new effect kind, the card's effect row and polarity,
-- and its un-bench.

-- ---------------------------------------------------------------------------
-- 1. effect_kind 'courage_token' on the catalog, the Cast Log and the
--    active-effect projection.
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
    'card_heist', 'compel_cast', 'brewer_immunity', 'named_tea_maker_rolloff',
    'courage_token'
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
    'card_heist', 'compel_cast', 'forfeit', 'brewer_immunity', 'named_tea_maker_rolloff',
    'courage_token'
  ));

alter table public.spell_active_effects drop constraint spell_active_effects_effect_kind_check;
alter table public.spell_active_effects add constraint spell_active_effects_effect_kind_check
  check (effect_kind in (
    'flat_modifier', 'dice_modifier', 'modifier_multiplier', 'set_modifier',
    'declared_number_tea_maker',
    'advantage', 'disadvantage',
    'ward', 'persistent_modifier_transfer', 'persistent_modifier_spend',
    'round_replay', 'draw_redirect', 'targeting_skip', 'per_round_dice_tick',
    'brewer_immunity', 'courage_token'
  ));

-- ---------------------------------------------------------------------------
-- 2. Liquid Courage's effect row, and a positive polarity so the roster
--    shows the recipient's token as a gold badge.
-- ---------------------------------------------------------------------------
insert into public.spell_card_effects (card_id, target_role, effect_kind, effect_params, ordinal)
select sc.id, 'TARGET', 'courage_token',
       '{"dice": "1d6", "persist": true, "participated_rounds_from_cast": 3}'::jsonb,
       0
  from public.spell_cards sc
 where sc.name = 'Liquid Courage'
   and not exists (
     select 1 from public.spell_card_effects sce where sce.card_id = sc.id
   );

update public.spell_cards set polarity = 'positive' where name = 'Liquid Courage';

-- ---------------------------------------------------------------------------
-- 3. Un-bench Liquid Courage. Guarded on location so this is a no-op where
--    0074 never ran; never touches an instance a player currently holds.
-- ---------------------------------------------------------------------------
update public.spell_deck_instances sdi
   set location = 'in_deck', held_by_player = null
  from public.spell_cards sc
 where sc.id = sdi.card_id
   and sc.name = 'Liquid Courage'
   and sdi.location = 'benched';
