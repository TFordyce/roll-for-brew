-- Expose card name, caster, and advantage/disadvantage in round-modifier
-- data (issue #165, part of #160's RollCalculation spell-effect UI work).
--
-- get_round_modifier_effects (latest definition: 0026_acting_as_and_end_
-- test_session.sql) already joins spell_casts -> spell_deck_instances ->
-- spell_cards to read effect_kind/effect_params/resolved_value, but throws
-- away the card name and caster it just joined against, and deliberately
-- excludes advantage/disadvantage ("shape roll generation instead" — see
-- 0019's doc comment). The UI now wants to show which card, cast by whom,
-- produced *every* effect touching a round's roll, including advantage/
-- disadvantage, so it can label them next to the discarded-roll strike-
-- through (issue #164).
--
-- Widens the return shape additively (two new trailing columns) rather than
-- replacing it, so existing callers reading only the original four columns
-- (layerResolution.ts's modifier composition, via getRoundModifierEffects)
-- are unaffected.
--
-- spell_active_effects rows are untouched here: their effect_kind is
-- constrained to the flat/dice/multiplier/set/hidden modifier kinds only
-- (0020) — advantage/disadvantage never persist across rounds — so that
-- branch just gains the same card_name/caster_id columns via its existing
-- card_id join.
-- create or replace can't widen a function's return type (Postgres error
-- 42P13 "cannot change return type of existing function") — drop the old
-- four-column definition first.
drop function if exists public.get_round_modifier_effects(uuid);

create function public.get_round_modifier_effects(p_round_id uuid)
returns table (
  target_player_id text,
  effect_kind text,
  effect_params jsonb,
  resolved_value numeric,
  card_name text,
  caster_player_id text
)
language plpgsql
security definer
set search_path = public
as $$
declare
  v_player_id text;
  v_room_id uuid;
begin
  v_player_id := public.current_player_id(p_round_id);

  if not exists (
    select 1 from public.round_participants
     where round_id = p_round_id and player_id = v_player_id
  ) then
    raise exception 'get_round_modifier_effects: caller is not a participant in this round';
  end if;

  select room_id into v_room_id from public.rounds where id = p_round_id;

  return query
    select casts.target_player_id, casts.effect_kind, casts.effect_params, casts.resolved_value,
           sc.name, casts.caster_id
      from public.spell_casts casts
      join public.spell_deck_instances sdi on sdi.id = casts.card_instance_id
      join public.spell_cards sc on sc.id = sdi.card_id
     where casts.round_id = p_round_id
       and casts.target_pending = false
       and casts.negated = false
       and casts.effect_kind in (
         'flat_modifier', 'dice_modifier', 'modifier_multiplier', 'set_modifier',
         'advantage', 'disadvantage'
       )
       and sc.duration_rounds is null
    union all
    select sae.target_player_id, sae.effect_kind, sae.effect_params, null::numeric,
           sc.name, sae.caster_id
      from public.spell_active_effects sae
      join public.spell_cards sc on sc.id = sae.card_id
     where sae.room_id = v_room_id
       and sae.effect_kind in ('flat_modifier', 'dice_modifier', 'modifier_multiplier', 'set_modifier');
end;
$$;

revoke execute on function public.get_round_modifier_effects(uuid) from public, anon;
grant execute on function public.get_round_modifier_effects(uuid) to authenticated;
