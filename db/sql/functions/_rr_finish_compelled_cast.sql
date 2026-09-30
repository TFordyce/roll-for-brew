-- _rr_finish_compelled_cast
--
-- The tail every cast path runs before returning: when the cast just made
-- meets a compelled obligation, fan out its TABLE placeholders (a cast made
-- after close_round missed the close-time fan-out) and tag every row of it
-- with cast_inputs.compelled_by, which both meets the obligation and links
-- the cast to Brewmageddon in the Recap. A no-op for any other cast.
create or replace function public._rr_finish_compelled_cast(
  p_round_id uuid, p_player_id text, p_card_instance_id uuid, p_cast_id uuid
)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_brewmageddon_cast_id uuid;
begin
  select o.brewmageddon_cast_id into v_brewmageddon_cast_id
    from public._compelled_outstanding(p_round_id) o
   where o.player_id = p_player_id and o.card_instance_id = p_card_instance_id;

  if v_brewmageddon_cast_id is null then
    return p_cast_id;
  end if;

  perform public._fan_out_table_placeholder_casts(p_round_id, p_card_instance_id);

  update public.spell_casts
     set cast_inputs = coalesce(cast_inputs, '{}'::jsonb)
                       || jsonb_build_object('compelled_by', v_brewmageddon_cast_id)
   where round_id = p_round_id
     and card_instance_id = p_card_instance_id
     and caster_id = p_player_id;

  return p_cast_id;
end;
$$;

revoke execute on function public._rr_finish_compelled_cast(uuid, text, uuid, uuid) from public, anon, authenticated;
