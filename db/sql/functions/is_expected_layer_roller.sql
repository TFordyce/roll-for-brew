-- is_expected_layer_roller
--
-- Rolling is held during the Compelled Cast step: nobody is an expected
-- Layer-0 roller until every compelled Action cast is in. This is the gate
-- submit_roll, submit_manual_roll and the Test Room roll-as RPCs all check,
-- and page.tsx reads it for "your turn to roll". Otherwise unchanged (0014).
create or replace function public.is_expected_layer_roller(
  p_round_id uuid,
  p_player_id text,
  p_layer integer
)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
begin
  if p_layer = 0 and public._compelled_cast_step_open(p_round_id) then
    return false;
  end if;

  return exists (
    select 1 from public.get_expected_layer_roller_ids(p_round_id, p_layer) ids
     where ids.player_id = p_player_id
  );
end;
$$;
