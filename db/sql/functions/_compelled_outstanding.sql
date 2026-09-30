-- _compelled_outstanding
--
-- The compelled casts still owed in a round: every entry of a live
-- Brewmageddon's fixed set with no row yet made from that card instance by
-- that holder pointing back at it (a compelled cast or a forfeit). Empty
-- once Brewmageddon is negated -- its pending holders are released.
--
-- plpgsql, not sql: a sql body is checked at create time, and the generated
-- migration emits functions alphabetically, before the helpers this calls.
create or replace function public._compelled_outstanding(p_round_id uuid)
returns table (
  player_id text, card_instance_id uuid, casting_time text, brewmageddon_cast_id uuid
)
language plpgsql
stable
security definer
set search_path = public
as $$
begin
  return query
  select h ->> 'player_id', (h ->> 'card_instance_id')::uuid, h ->> 'casting_time', bm.id
    from public.spell_casts bm
    cross join lateral jsonb_array_elements(coalesce(bm.cast_inputs -> 'compelled', '[]'::jsonb)) h
   where bm.round_id = p_round_id
     and bm.effect_kind = 'compel_cast'
     and not exists (
       select 1 from public.spell_casts c
        where c.round_id = p_round_id
          and c.caster_id = h ->> 'player_id'
          and c.card_instance_id = (h ->> 'card_instance_id')::uuid
          and c.cast_inputs ->> 'compelled_by' = bm.id::text
     )
     and not public._rr_brewmageddon_negated(bm.id);
end;
$$;

revoke execute on function public._compelled_outstanding(uuid) from public, anon, authenticated;
grant execute on function public._compelled_outstanding(uuid) to service_role;
