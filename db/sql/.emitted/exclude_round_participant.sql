-- exclude_round_participant
--
-- Exclusion for never rolling forfeits the player's outstanding compelled
-- cast (a Reaction holder who never rolled never reached the window).
-- Otherwise unchanged (0009).
create or replace function public.exclude_round_participant(
  p_round_id uuid,
  p_player_id text,
  p_layer integer
)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  if p_layer = 0 then
    update public.round_participants
       set excluded_at = now()
     where round_id = p_round_id and player_id = p_player_id and excluded_at is null;

    perform public._forfeit_compelled_card(p_round_id, p_player_id, 'excluded');
  else
    update public.round_layer_participants
       set excluded_at = now()
     where round_id = p_round_id and layer = p_layer and player_id = p_player_id
       and excluded_at is null;
  end if;
end;
$$;
