-- get_dispellable_active_effects(uuid) -> table
--
-- The Detox picker: the live active effects the caller's held dispel card
-- can end (its tiers), read off the projection (_rr_active_effects_as_of) so
-- the UI never offers an already-expired or already-dispelled effect. Empty
-- unless the caller holds a dispel card.
--
-- Body from migration 0084 plus issue #428: an is_undispellable effect (The
-- Last Cuppa's immunity) is never offered.
--
-- Canonical source: this file is the source of truth for the function body.
-- Edit here and run `npm run build:migrations` -- do not hand-edit the
-- generated migration. See db/sql/README.md.

create or replace function public.get_dispellable_active_effects(p_round_id uuid)
returns table (
  effect_id uuid, target_player_id text, target_display_name text, card_name text, tier text
)
language plpgsql
security definer
set search_path = public
as $$
declare
  v_player_id text;
  v_room_id uuid;
  v_effect_kind text;
  v_effect_params jsonb;
  v_tiers text[];
begin
  v_player_id := public.current_player_id(p_round_id);

  select room_id into v_room_id from public.rounds where id = p_round_id;

  if v_room_id is null then
    raise exception 'get_dispellable_active_effects: round not found';
  end if;

  select gh.effect_kind, gh.effect_params
    into v_effect_kind, v_effect_params
    from public.get_held_card_effect(v_player_id) gh;

  if v_effect_kind is distinct from 'dispel' then
    return;
  end if;

  select array(select jsonb_array_elements_text(v_effect_params -> 'tiers')) into v_tiers;

  return query
    select sae.id, sae.target_player_id, coalesce(p.display_name, p.email), sc2.name, sc2.tier
      from public._rr_active_effects_as_of(v_room_id, p_round_id) sae
      join public.spell_cards sc2 on sc2.id = sae.card_id
      join public.players p on p.id = sae.target_player_id
     where sc2.tier = any(v_tiers)
       and not sae.is_undispellable;
end;
$$;

revoke execute on function public.get_dispellable_active_effects(uuid) from public, anon;
grant execute on function public.get_dispellable_active_effects(uuid) to authenticated;

comment on function public.get_dispellable_active_effects(uuid) is
  'Issue #310: reads the live projection (_rr_active_effects_as_of) so the '
  'dispel UI never offers an already-expired or already-dispelled effect. '
  'Issue #428: never offers an is_undispellable effect (The Last Cuppa). '
  'Signature and output columns unchanged.';
