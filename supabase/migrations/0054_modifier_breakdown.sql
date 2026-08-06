-- Modifier breakdown popover (issue #184, part of #182): a read RPC backing
-- the "why is my modifier N" popover on PlayerTile/RoundReveal. Splits a
-- player's room-scoped modifier into the two sources that can move it —
-- cups made as brewer (0005's resolve_round) and manual adjustments (0052's
-- modifier_adjustments) — so the popover can show "Cups made: +N" /
-- "Adjustments: +M" without the client re-deriving either sum itself.
--
-- Deliberately doesn't reconcile the two sums against room_players.modifier
-- (spell-effect deltas, out of scope here per #182, also move the live
-- modifier without a durable per-source row to sum) — it only answers "how
-- much of this came from cups made" and "how much came from logged
-- adjustments", each defaulting to zero via coalesce when a player has no
-- history of that kind.
create or replace function public.get_modifier_breakdown(p_player_id text, p_room_id uuid)
returns table (cups_made integer, adjustments integer)
language plpgsql
security definer
set search_path = public
as $$
begin
  -- Any authenticated player can look up any other player's breakdown for a
  -- room — same read-openness as the room roster itself (rounds/
  -- modifier_adjustments are both "readable by authenticated users" tables),
  -- just gated on being signed in at all.
  perform public.current_player_id();

  return query
    select
      coalesce((
        select sum(r.cups_made) from public.rounds r
         where r.room_id = p_room_id and r.brewer_id = p_player_id and r.status = 'resolved'
      ), 0)::integer as cups_made,
      coalesce((
        select sum(ma.delta) from public.modifier_adjustments ma
         where ma.room_id = p_room_id and ma.target_player_id = p_player_id
      ), 0)::integer as adjustments;
end;
$$;

revoke execute on function public.get_modifier_breakdown(text, uuid) from public, anon;
grant execute on function public.get_modifier_breakdown(text, uuid) to authenticated;
