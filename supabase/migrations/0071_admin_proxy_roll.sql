-- Proxy Roll (issue #273): lets an admin fold a player who's physically
-- present at the table but hasn't opened the app today into a genuinely
-- live round, entering the number they read out loud on their behalf.
-- Distinct from Late Declare (#246, 0068_declare_in_late.sql) — that
-- requires the player to already have a room_players row (they logged in,
-- just didn't declare in time); this player has no session at all today,
-- so the room_players row is created implicitly here rather than required
-- up front. Also distinct from Round Backfill (#274, out of scope here) —
-- that's for a whole round nobody logged into the app for.
--
-- Round-status eligibility mirrors declare_in_late's window exactly: the
-- round must still be 'open', or 'closed' with no rolls submitted for any
-- layer yet. Since submit_roll/submit_manual_roll only ever accept a
-- 'closed' round (0005/0008), "no rolls yet" is equivalent to "still on
-- layer 0, nobody has rolled it" — this can never target a tie-break reroll
-- layer. Raises RFB32 for that race, the next in the RFB0x "round moved on
-- under you" family (RFB31 is declare_in_late's own version, one phase
-- earlier).
--
-- rolls.entered_by_admin flags the row as admin/manually entered — surfaced
-- in round history (RoundReveal) so it's visually distinguishable from an
-- in-app roll without casting doubt on the value itself, per the issue's
-- "provenance" behaviour.
alter table public.rolls
  add column if not exists entered_by_admin boolean not null default false;

create or replace function public.admin_proxy_roll(p_round_id uuid, p_player_id text, p_value integer)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_caller text;
  v_is_admin boolean;
  v_status text;
  v_room_id uuid;
  v_layer integer;
  v_modifier integer;
begin
  if p_value is null or p_value < 1 or p_value > 20 then
    raise exception 'admin_proxy_roll: value must be between 1 and 20';
  end if;

  v_caller := public.current_player_id();

  select is_admin into v_is_admin from public.players where id = v_caller;
  if not coalesce(v_is_admin, false) then
    raise exception 'admin_proxy_roll: caller is not an admin';
  end if;

  if not exists (select 1 from public.players where id = p_player_id) then
    raise exception 'admin_proxy_roll: target player not found';
  end if;

  select status, room_id, current_layer into v_status, v_room_id, v_layer
    from public.rounds
   where id = p_round_id;

  if v_status is null then
    raise exception 'admin_proxy_roll: round not found';
  end if;

  if v_status not in ('open', 'closed') or exists (
    select 1 from public.rolls where round_id = p_round_id
  ) then
    raise exception 'admin_proxy_roll: round is no longer open for a proxy roll'
      using errcode = 'RFB32';
  end if;

  -- Implicitly creates the target's today's-room membership — no prior
  -- login required, unlike every other room_players writer
  -- (enter_todays_room, 0003) which always derives the player from the
  -- authenticated caller.
  insert into public.room_players (room_id, player_id)
  values (v_room_id, p_player_id)
  on conflict (room_id, player_id) do nothing;

  insert into public.round_participants (round_id, player_id)
  values (p_round_id, p_player_id)
  on conflict (round_id, player_id) do nothing;

  select modifier into v_modifier
    from public.room_players
   where room_id = v_room_id and player_id = p_player_id;

  insert into public.rolls (round_id, player_id, layer, value, input_mode, modifier_snapshot, entered_by_admin)
  values (p_round_id, p_player_id, v_layer, p_value, 'manual', v_modifier, true);

  -- Same nat-1/nat-20 pending-draw trigger submit_roll/submit_manual_roll
  -- get via maybeRecordPendingSpellDraw (roundActionHelpers.ts), but
  -- inserted directly for the target player rather than reused via
  -- record_pending_spell_draw (0036) — that RPC resolves its player from
  -- current_player_id(p_round_id), which would credit the admin's own
  -- identity, not the proxied player's.
  if p_value in (1, 20) then
    insert into public.pending_spell_draws (round_id, player_id, trigger)
    values (p_round_id, p_player_id, case when p_value = 1 then 'nat1' else 'nat20' end)
    on conflict (round_id, player_id) do nothing;
  end if;
end;
$$;

revoke execute on function public.admin_proxy_roll(uuid, text, integer) from public, anon;
grant execute on function public.admin_proxy_roll(uuid, text, integer) to authenticated;

comment on function public.admin_proxy_roll(uuid, text, integer) is
  'Raises RFB32 (round no longer open for a proxy roll) for the same stale-round race family as declare_in_late''s RFB31 — the round can close-then-roll between the admin form rendering and submitting.';

-- Widen get_current_layer_rolls_if_complete/get_completed_layer_rolls_for_stall_resolution/
-- get_round_layer_history to expose entered_by_admin, so every surface that
-- already renders a roll's value can also flag it as admin-entered. All
-- three share the same CompletedLayer/LayerRoll shape client-side
-- (src/lib/supabase/rolls.ts, src/lib/supabase/stall.ts) and so are kept in
-- lockstep, same as 0051 widened them together for discarded_value.
-- create or replace can't widen a table-returning function's column list
-- (Postgres 42P13) — drop first, same as 0051/0050 had to.
drop function if exists public.get_current_layer_rolls_if_complete(uuid);

create function public.get_current_layer_rolls_if_complete(p_round_id uuid)
returns table (
  layer integer,
  player_id text,
  value integer,
  modifier_snapshot integer,
  discarded_value integer,
  entered_by_admin boolean
)
language plpgsql
security definer
set search_path = public
as $$
declare
  v_player_id text;
  v_layer integer;
  v_expected_count integer;
  v_roll_count integer;
begin
  v_player_id := public.current_player_id(p_round_id);

  select current_layer into v_layer from public.rounds where id = p_round_id;

  if v_layer is null then
    raise exception 'get_current_layer_rolls_if_complete: round not found';
  end if;

  if not public.is_expected_layer_roller(p_round_id, v_player_id, v_layer) then
    raise exception 'get_current_layer_rolls_if_complete: caller is not expected to roll in the current layer'
      using errcode = 'RFB02';
  end if;

  v_expected_count := public.count_expected_layer_rollers(p_round_id, v_layer);

  select count(*) into v_roll_count
    from public.rolls r
   where r.round_id = p_round_id and r.layer = v_layer;

  if v_roll_count < v_expected_count then
    return;
  end if;

  return query
    select r.layer, r.player_id, r.value, r.modifier_snapshot, r.discarded_value, r.entered_by_admin
      from public.rolls r
     where r.round_id = p_round_id and r.layer = v_layer;
end;
$$;

revoke execute on function public.get_current_layer_rolls_if_complete(uuid) from public, anon;
grant execute on function public.get_current_layer_rolls_if_complete(uuid) to authenticated;

drop function if exists public.get_completed_layer_rolls_for_stall_resolution(uuid);

create function public.get_completed_layer_rolls_for_stall_resolution(p_round_id uuid)
returns table (
  layer integer,
  player_id text,
  value integer,
  modifier_snapshot integer,
  discarded_value integer,
  entered_by_admin boolean
)
language plpgsql
security definer
set search_path = public
as $$
declare
  v_layer integer;
  v_expected_count integer;
  v_roll_count integer;
begin
  select current_layer into v_layer from public.rounds where id = p_round_id;

  if v_layer is null then
    raise exception 'get_completed_layer_rolls_for_stall_resolution: round not found';
  end if;

  v_expected_count := public.count_expected_layer_rollers(p_round_id, v_layer);

  select count(*) into v_roll_count
    from public.rolls r
   where r.round_id = p_round_id and r.layer = v_layer;

  if v_roll_count < v_expected_count then
    return;
  end if;

  return query
    select r.layer, r.player_id, r.value, r.modifier_snapshot, r.discarded_value, r.entered_by_admin
      from public.rolls r
     where r.round_id = p_round_id and r.layer = v_layer;
end;
$$;

revoke execute on function public.get_completed_layer_rolls_for_stall_resolution(uuid) from public, anon;
grant execute on function public.get_completed_layer_rolls_for_stall_resolution(uuid) to authenticated;

drop function if exists public.get_round_layer_history(uuid);

create function public.get_round_layer_history(p_round_id uuid)
returns table (
  layer integer,
  player_id text,
  value integer,
  discarded_value integer,
  modifier_snapshot integer,
  entered_by_admin boolean
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
    select r.layer, r.player_id, r.value, r.discarded_value, r.modifier_snapshot, r.entered_by_admin
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

-- Surfaces the same provenance flag on the stats surface (issue #273's
-- "flagged in round history and stats" behaviour) — stats_room_rounds
-- (0025_stats_exclude_test_room.sql) is the only stats view listing
-- individual rounds, so a room's Proxy-Roll-touched rounds get a plain
-- boolean rather than duplicating rolls.entered_by_admin per-player through
-- a view that otherwise never names individual rolls at all.
create or replace view public.stats_room_rounds as
select
  r.room_id,
  r.id as round_id,
  r.resolved_at,
  r.cups_made,
  starter.id as starter_id,
  starter.display_name as starter_display_name,
  starter.email as starter_email,
  brewer.id as brewer_id,
  brewer.display_name as brewer_display_name,
  brewer.email as brewer_email,
  exists (
    select 1 from public.rolls pr where pr.round_id = r.id and pr.entered_by_admin
  ) as has_proxy_roll
from public.rounds r
join public.rooms ro on ro.id = r.room_id
join public.players starter on starter.id = r.started_by
join public.players brewer on brewer.id = r.brewer_id
where r.status = 'resolved' and not ro.is_test
order by r.resolved_at desc;

alter view public.stats_room_rounds set (security_invoker = on);
