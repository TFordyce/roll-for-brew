-- advance_round_layer(p_round_id uuid, p_tied_player_ids text[]) -> integer
--
-- Persist a Tie-Break Reroll: the tied players become the next Layer's
-- round_layer_participants and the round moves to that Layer, whose number
-- it returns. Each tied player must have been in the current Layer -- an
-- expected roller of it, or (issue #433) at Layer 0 a Participant with a
-- Roll Exemption, who skipped the roll but can still be tied: by the
-- all-immune give-way, or as the holder in a Loose Leaf roll-off. They roll
-- normally in the new Layer.
--
-- Moved from migration 0007 into db/sql/ by issue #433 (the first change
-- since).
--
-- Canonical source: this file is the source of truth for the function body.
-- Edit here and run `npm run build:migrations` -- do not hand-edit the
-- generated migration. See db/sql/README.md.

create or replace function public.advance_round_layer(p_round_id uuid, p_tied_player_ids text[])
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  v_status text;
  v_layer integer;
  v_next_layer integer;
  v_player_id text;
  -- issue #433: Layer 0's Roll Exemptions, read once
  v_exempt text[] := array[]::text[];
begin
  select status, current_layer into v_status, v_layer
    from public.rounds
   where id = p_round_id
   for update;

  if v_status is null then
    raise exception 'advance_round_layer: round not found';
  end if;

  if v_status <> 'closed' then
    raise exception 'advance_round_layer: round is not closed';
  end if;

  if p_tied_player_ids is null or array_length(p_tied_player_ids, 1) < 2 then
    raise exception 'advance_round_layer: at least 2 tied players required';
  end if;

  if v_layer = 0 then
    select coalesce(array_agg(ex.player_id), array[]::text[]) into v_exempt
      from public._rr_roll_exemptions(p_round_id) ex;
  end if;

  foreach v_player_id in array p_tied_player_ids loop
    if not public.is_expected_layer_roller(p_round_id, v_player_id, v_layer)
       and not (v_player_id = any (v_exempt)) then
      raise exception 'advance_round_layer: % did not roll in the current layer', v_player_id;
    end if;
  end loop;

  v_next_layer := v_layer + 1;

  insert into public.round_layer_participants (round_id, layer, player_id)
  select p_round_id, v_next_layer, unnest(p_tied_player_ids)
  on conflict do nothing;

  update public.rounds set current_layer = v_next_layer where id = p_round_id;

  return v_next_layer;
end;
$$;

revoke execute on function public.advance_round_layer(uuid, text[]) from public, anon;
grant execute on function public.advance_round_layer(uuid, text[]) to authenticated;
