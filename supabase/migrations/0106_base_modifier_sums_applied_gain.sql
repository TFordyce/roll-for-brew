-- Fixes issue #395: a suppressed tea-making gain comes back on the next
-- modifier recompute.
--
-- The 4-arg resolve_round(uuid, text, integer, boolean) always writes
-- rounds.cups_made = participant count, but when gain is suppressed -- a
-- no_modifier_gain tea_maker_override (Drip Tray) or a block_earned_modifier
-- ward on the brewer (Eternal Steep) -- it writes brewer_modifier_gain = 0 and
-- skips the live room_players.modifier increment. _rr_base_modifier (0085)
-- summed cups_made, so every absolute recompute seeded from it
-- (_rr_recompute_modifier_cache via admin_delete_round / round-replay scrap,
-- and resolve_round(uuid) Phase 4b / Bitter Leech would_be_before) handed the
-- suppressed gain back. get_modifier_breakdown's first column summed cups_made
-- the same way, so its three columns stopped reconciling to
-- room_players.modifier.
--
-- Both now sum rounds.brewer_modifier_gain -- the gain actually applied
-- (0057). For an unsuppressed round gain = cups_made, so nothing else moves;
-- scrapped rounds (replay: cups_made null, gain 0) still contribute 0.
-- get_modifier_breakdown keeps its name, signature and column names (the
-- first column is still called cups_made) so no client change is needed.

create or replace function public._rr_base_modifier(p_room_id uuid, p_player_id text)
returns integer
language sql
stable
as $$
  select
    coalesce((
      select sum(r.brewer_modifier_gain) from public.rounds r
       where r.room_id = p_room_id and r.brewer_id = p_player_id and r.status = 'resolved'
    ), 0)::integer
    +
    coalesce((
      select sum(ma.delta) from public.modifier_adjustments ma
       where ma.room_id = p_room_id and ma.target_player_id = p_player_id
    ), 0)::integer;
$$;

revoke execute on function public._rr_base_modifier(uuid, text) from public, anon;
grant execute on function public._rr_base_modifier(uuid, text) to authenticated;

comment on function public._rr_base_modifier(uuid, text) is
  'Issue #311 / #395: the base half of room_players.modifier = sum(resolved-'
  'round brewer_modifier_gain as brewer -- the tea-making gain actually '
  'applied, 0 when Drip Tray / Eternal Steep suppressed it) + '
  'sum(modifier_adjustments.delta). Same math get_modifier_breakdown splits '
  'across its cups_made / adjustments columns.';

create or replace function public.get_modifier_breakdown(p_player_id text, p_room_id uuid)
returns table (cups_made integer, adjustments integer, spell_effects integer)
language plpgsql
security definer
set search_path = public
as $$
begin
  -- Any authenticated player can look up any other player's breakdown for a
  -- room -- same read-openness as the room roster itself.
  perform public.current_player_id();

  return query
    select
      coalesce((
        select sum(r.brewer_modifier_gain) from public.rounds r
         where r.room_id = p_room_id and r.brewer_id = p_player_id and r.status = 'resolved'
      ), 0)::integer as cups_made,
      coalesce((
        select sum(ma.delta) from public.modifier_adjustments ma
         where ma.room_id = p_room_id and ma.target_player_id = p_player_id
      ), 0)::integer as adjustments,
      public._rr_spell_modifier_delta(p_room_id, p_player_id, null) as spell_effects;
end;
$$;

revoke execute on function public.get_modifier_breakdown(text, uuid) from public, anon;
grant execute on function public.get_modifier_breakdown(text, uuid) to authenticated;

comment on function public.get_modifier_breakdown(text, uuid) is
  'Issue #311 / #395 (was #184 / 0054): the three sums behind a player''s '
  'room-scoped modifier -- tea-making gain actually applied as brewer '
  '(resolved-round brewer_modifier_gain; the column keeps its historical name '
  'cups_made), modifier_adjustments.delta, and the spell modifier delta '
  '(persistent_modifier_transfer / persistent_modifier_spend). cups_made + '
  'adjustments + spell_effects reconciles to room_players.modifier for every '
  'player a transfer has touched.';
