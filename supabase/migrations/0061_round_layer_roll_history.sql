-- Full reroll-layer roll history for a round (issue #220, piece 1 of the
-- modal + dependent-row RoundReveal rework). Every RPC that reads rolls
-- today (get_current_layer_rolls_if_complete) is scoped to *the round's
-- current layer only*, and gates the caller on being one of that layer's
-- own expected rollers (submit_roll's own caller, checking their own
-- just-submitted layer). Neither fits a spectator opening RoundReveal after
-- the round has already moved through one or more tie-break layers: they
-- need every already-revealed layer's rolls, not just whichever layer is
-- live right now, and they were never an expected roller of a tie layer
-- they're only spectating.
--
-- "Already-revealed" is derived the same way get_current_layer_rolls_if_
-- complete decides a layer is done — its roll count has reached
-- count_expected_layer_rollers (0014) — rather than tracked as separate
-- state. A round's earlier layers are always complete by construction
-- (current_layer only ever advances off advance_round_layer, which itself
-- requires the layer it's leaving to be fully rolled), so in practice this
-- only ever withholds the round's *current* layer while it's still short a
-- roller — exactly the window the realtime layer-rolls-revealed broadcast
-- (still push-only, unaffected by this RPC) hasn't fired for yet.
--
-- Authorization: round_participants/round_layer_participants are both
-- already open "readable by authenticated users" policies (0004/0007) — this
-- project's trust model is one shared community room, not per-round ACLs —
-- so this matches them rather than inventing a narrower rule. security
-- definer only to see past rolls(), whose own RLS (0026) otherwise limits a
-- non-roller to a *resolved* round.
create or replace function public.get_round_layer_history(p_round_id uuid)
returns table (
  layer integer,
  player_id text,
  value integer,
  discarded_value integer,
  modifier_snapshot integer
)
language plpgsql
security definer
set search_path = public
as $$
begin
  if not exists (select 1 from public.rounds where id = p_round_id) then
    raise exception 'get_round_layer_history: round not found';
  end if;

  return query
    select r.layer, r.player_id, r.value, r.discarded_value, r.modifier_snapshot
      from public.rolls r
     where r.round_id = p_round_id
       and (
         select count(*) from public.rolls r2
          where r2.round_id = p_round_id and r2.layer = r.layer
       ) >= public.count_expected_layer_rollers(p_round_id, r.layer)
     order by r.layer asc;
end;
$$;

revoke execute on function public.get_round_layer_history(uuid) from public, anon;
grant execute on function public.get_round_layer_history(uuid) to authenticated;
