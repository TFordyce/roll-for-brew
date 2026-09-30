-- Tea Heist (issue #438, spec #401 / wayfinder map #379, design #383).
--
-- Tea Heist (Rare, OPPONENT, Action): "Steal a card from another player's
-- hand. They draw nothing in return."
--
-- Model (ADR 0005 #383 amendment, re-amended by #438):
--   * cast_spell_card's by-name branch pins the victim's held card in
--     cast_inputs.stolen_instance_id on one `card_heist` cast (new
--     effect_kind). The picker lists only card-holders (get_heist_targets,
--     below) and the cast re-checks (RFB53).
--   * The resolver only decides and traces: _rr_heist_outcomes /
--     _rr_heist_trace, a final `card_heist` Trace step (moved / fizzled /
--     countered). Its body also runs as every viewer's rolled-back
--     Provisional Recap, so it never moves the card.
--   * finalize_layer's commit step moves it (_rr_apply_heists), in the same
--     transaction as the resolution write. Safe to repeat.
--   * _rr_scrap_round hands it back on a Time for Brew replay if the thief
--     still holds it. The Tea Heist card stays spent.
-- Those function bodies are canonical in db/sql/functions/ and ship in the
-- generated migration that follows this one (ADR 0006).
--
-- This migration: the effect_kind CHECK widening, the picker RPC and the
-- un-bench.

-- ---------------------------------------------------------------------------
-- 1. effect_kind CHECK constraints -- add `card_heist`. spell_casts carries
--    it; spell_card_effects widens with it for consistency (Tea Heist has no
--    effect rows -- it is a by-name branch). spell_active_effects is
--    untouched: a Heist projects no active effect. Lists carried forward from
--    0100.
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
    'card_heist'
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
    'card_heist'
  ));

-- ---------------------------------------------------------------------------
-- 2. get_heist_targets(p_round_id) -> setof text
--
-- The Tea Heist picker's roster: the round's other participants who hold a
-- card (a `held` one -- a keep-or-swap card can't be stolen). A held card is
-- private (spell_deck_instances RLS), so this SECURITY DEFINER read is the
-- only way the client learns who holds one -- and it answers only a caller
-- who is holding Tea Heist, so it leaks nothing to anyone else (empty
-- otherwise, like get_dispellable_active_effects). cast_spell_card re-checks
-- the chosen target (RFB53).
-- ---------------------------------------------------------------------------
create or replace function public.get_heist_targets(p_round_id uuid)
returns setof text
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_player_id text;
begin
  v_player_id := public.current_player_id(p_round_id);

  if not exists (
    select 1 from public.spell_deck_instances sdi
    join public.spell_cards sc on sc.id = sdi.card_id
     where sdi.held_by_player = v_player_id
       and sdi.location = 'held'
       and sc.name = 'Tea Heist'
  ) then
    return;
  end if;

  return query
    select rp.player_id
      from public.round_participants rp
     where rp.round_id = p_round_id
       and rp.player_id <> v_player_id
       and exists (
         select 1 from public.spell_deck_instances sdi
          where sdi.held_by_player = rp.player_id and sdi.location = 'held'
       )
     order by rp.player_id;
end;
$$;

revoke execute on function public.get_heist_targets(uuid) from public, anon;
grant execute on function public.get_heist_targets(uuid) to authenticated;

comment on function public.get_heist_targets(uuid) is
  'Issue #438: the Tea Heist picker roster -- the round''s other participants holding a held (not pending_swap) card. Empty unless the caller holds Tea Heist, so it never reveals card-holders to anyone else. cast_spell_card re-checks the target (RFB53).';

-- ---------------------------------------------------------------------------
-- 3. Un-bench Tea Heist. Guarded on location so this is a no-op where 0074
--    never ran; never touches an instance a player currently holds.
-- ---------------------------------------------------------------------------
update public.spell_deck_instances sdi
   set location = 'in_deck', held_by_player = null
  from public.spell_cards sc
 where sc.id = sdi.card_id
   and sc.name = 'Tea Heist'
   and sdi.location = 'benched';
