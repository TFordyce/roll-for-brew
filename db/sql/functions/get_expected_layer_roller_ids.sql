-- get_expected_layer_roller_ids(p_round_id uuid, p_layer integer)
--   -> table (player_id text)
--
-- The single source of truth for who is expected to roll a round's Layer
-- (0014): is_expected_layer_roller, count_expected_layer_rollers, stall
-- enforcement and the room page all read it.
--   * Layer 0: every Participant not excluded -- except in a debt round
--     (issue #432, _brew_debt_due), where nobody rolls. The round then
--     resolves at close with the Debtor as Tea Maker.
--   * A Tie-Break Reroll Layer: its round_layer_participants not excluded.
--
-- Moved from migration 0014 into db/sql/ by issue #432 (the first change
-- since). Body otherwise unchanged.
--
-- Canonical source: this file is the source of truth for the function body.
-- Edit here and run `npm run build:migrations` -- do not hand-edit the
-- generated migration. See db/sql/README.md.

create or replace function public.get_expected_layer_roller_ids(p_round_id uuid, p_layer integer)
returns table (player_id text)
language plpgsql
security definer
set search_path = public
as $$
begin
  if p_layer = 0 then
    if public._brew_debt_due(p_round_id) is not null then
      return;
    end if;

    return query
      select rp.player_id from public.round_participants rp
       where rp.round_id = p_round_id and rp.excluded_at is null;
  else
    return query
      select rlp.player_id from public.round_layer_participants rlp
       where rlp.round_id = p_round_id and rlp.layer = p_layer and rlp.excluded_at is null;
  end if;
end;
$$;

revoke execute on function public.get_expected_layer_roller_ids(uuid, integer) from public, anon;
grant execute on function public.get_expected_layer_roller_ids(uuid, integer) to authenticated;

comment on function public.get_expected_layer_roller_ids(uuid, integer) is
  'The players expected to roll a round''s Layer (0014): at Layer 0 every non-excluded Participant, or nobody in a debt round (issue #432, _brew_debt_due); above Layer 0 the Tie-Break Reroll Layer''s non-excluded participants. Backs is_expected_layer_roller and count_expected_layer_rollers.';
