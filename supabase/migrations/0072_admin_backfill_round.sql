-- Round Backfill (issue #274): an admin bulk-records an entire round that
-- happened with physical dice but that nobody ever opened the app for --
-- distinct from Proxy Roll (#273, PR #276, migration 0071_admin_proxy_roll.sql),
-- which folds one absent player into an already-live round. Here there's no
-- live round at all: the admin enters every participant's roll (and any
-- tie-break reroll layer, in full) up front, and the whole thing resolves in
-- one transaction as though it had just been played live start to finish.
-- Spell casting is explicitly out of scope for v1 (grilled 2026-08-19) -- a
-- backfilled round only replays the roll-off/tie-break mechanics, using
-- whatever spell effects already persist in spell_active_effects the same
-- way any other round's modifier math would.
--
-- Numbered 0072, one past Proxy Roll's 0071, since that issue was already
-- being implemented in parallel (PR #276, open at the time of writing) and
-- had already claimed 0071 -- same "check open PRs before picking a
-- migration number" practice this project already follows.
--
-- Provenance deliberately reuses Proxy Roll's own rolls.entered_by_admin
-- flag (0071) rather than adding a second, competing column: both issues
-- need the exact same "this wasn't the player's own live entry" story per
-- roll, and #274's own spec calls for "the same visual manually/admin-
-- entered flag as Proxy Roll, applied to the whole backfilled round". The
-- `if not exists` on the column add below makes this migration safe to run
-- whichever of the two PRs actually lands in master first -- the second one
-- through just no-ops on an already-present column, same pattern already
-- used throughout this project's migrations for idempotent adds.
-- rounds.backfilled_by/backfilled_at is the one genuinely new, round-level
-- flag this issue needs: Proxy Roll only ever marks the one proxied roll,
-- never the round itself, since the round it joins was genuinely live.
alter table public.rolls
  add column if not exists entered_by_admin boolean not null default false;

alter table public.rounds
  add column if not exists backfilled_by text references public.players (id),
  add column if not exists backfilled_at timestamptz;

-- Bulk-creates and fully resolves a same-day round nobody logged in the app
-- for. p_participant_ids is the round's full roster (layer 0); p_layers is
-- a jsonb array of layers, each an array of {"player_id", "value"} for
-- exactly that layer's expected rollers -- layer 0 is every participant,
-- layer N>0 is whichever subset tied at layer N-1. The admin supplies every
-- layer up front (they already know how the physical dice actually played
-- out), and this function persists each layer's rolls, computes that
-- layer's outcome with the *exact* nat-1/all-nat-20/lowest-total precedence
-- resolveLayer.ts already applies live, and either advances to the next
-- layer (public.advance_round_layer) or resolves the round
-- (public.resolve_round) -- reusing both unchanged, so a backfilled round
-- ends up in the identical shape a live one would, including
-- round_layer_participants and rounds.current_layer. Mirrors 0007/0057's
-- own trust boundary: SQL only *persists* an outcome computed elsewhere (in
-- this case, from the admin's own entered figures) rather than re-deriving
-- it from first principles -- the caller (adminBackfillRound, driven by the
-- same resolveLayer.ts the live UI uses, per layer, as the admin enters
-- each one) is trusted to have supplied the real tied subset, same as
-- advance_round_layer already trusts the layer-resolution caller today.
--
-- Same-day-only per spec: always resolves "today" (Europe/London) server-
-- side, exactly like enter_todays_room/start_round -- there's no date
-- parameter to backfill into a past day. Also implicitly creates each
-- participant's room_players row for today (issue #273/0071 establishes the
-- same "no prior login required" behaviour for its own proxy roll), and
-- refuses to run at all if another round is already open/closed in today's
-- room -- a backfill is a one-shot whole-round action, not something that
-- can interleave with a genuinely live round.
--
-- Error codes start at RFB33, one past Proxy Roll's RFB32 (0071), so a
-- client switching on error.code never sees the same code mean two
-- different things depending on which RPC raised it.
create or replace function public.admin_backfill_round(p_participant_ids text[], p_layers jsonb)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_admin_id text;
  v_is_admin boolean;
  v_today date;
  v_room_id uuid;
  v_round_id uuid;
  v_layer_count integer;
  v_layer_index integer;
  v_layer_data jsonb;
  v_entry jsonb;
  v_player_id text;
  v_value integer;
  v_modifier integer;
  v_expected_ids text[];
  v_given_ids text[];
  v_missing_id text;
  v_nat1_ids text[];
  v_all_nat20 boolean;
  v_winner_ids text[];
begin
  v_admin_id := public.current_player_id();

  select is_admin into v_is_admin from public.players where id = v_admin_id;
  if not coalesce(v_is_admin, false) then
    raise exception 'admin_backfill_round: caller is not an admin'
      using errcode = 'RFB33';
  end if;

  if p_participant_ids is null or array_length(p_participant_ids, 1) < 2 then
    raise exception 'admin_backfill_round: at least 2 participants required'
      using errcode = 'RFB34';
  end if;

  v_layer_count := coalesce(jsonb_array_length(p_layers), 0);
  if v_layer_count < 1 then
    raise exception 'admin_backfill_round: at least one layer of rolls is required'
      using errcode = 'RFB35';
  end if;

  v_today := (now() at time zone 'Europe/London')::date;

  -- rooms.date is a *partial* unique index ("where not is_test", 0024), and
  -- this insert only ever creates real (non-test) rooms — same 42P10 fix
  -- 0027 already applied to enter_todays_room, repeating the index's own
  -- predicate so Postgres can infer it as the arbiter.
  insert into public.rooms (date) values (v_today) on conflict (date) where not is_test do nothing;
  select id into v_room_id from public.rooms where date = v_today;

  if exists (
    select 1 from public.rounds where room_id = v_room_id and status in ('open', 'closed')
  ) then
    raise exception 'admin_backfill_round: another round is already in progress in today''s room'
      using errcode = 'RFB36';
  end if;

  -- Implicit same-day membership, same reasoning as Proxy Roll (#273/0071):
  -- requiring these players to have logged in themselves first would defeat
  -- the point of backfilling a round nobody opened the app for at all.
  insert into public.room_players (room_id, player_id)
  select v_room_id, unnest(p_participant_ids)
  on conflict (room_id, player_id) do nothing;

  insert into public.rounds
    (room_id, started_by, status, started_at, closed_at, current_layer, backfilled_by, backfilled_at)
  values
    (v_room_id, v_admin_id, 'closed', now(), now(), 0, v_admin_id, now())
  returning id into v_round_id;

  insert into public.round_participants (round_id, player_id)
  select v_round_id, unnest(p_participant_ids);

  for v_layer_index in 0 .. v_layer_count - 1 loop
    v_layer_data := p_layers -> v_layer_index;

    if v_layer_index = 0 then
      v_expected_ids := p_participant_ids;
    else
      select array_agg(rlp.player_id) into v_expected_ids
        from public.round_layer_participants rlp
       where rlp.round_id = v_round_id and rlp.layer = v_layer_index;
    end if;

    select array_agg(elem ->> 'player_id') into v_given_ids
      from jsonb_array_elements(v_layer_data) elem;

    if v_given_ids is null or array_length(v_given_ids, 1) <> array_length(v_expected_ids, 1) then
      raise exception 'admin_backfill_round: layer % must have exactly the expected tied roster', v_layer_index
        using errcode = 'RFB37';
    end if;

    select e into v_missing_id from unnest(v_expected_ids) e where e <> all (v_given_ids) limit 1;
    if v_missing_id is not null then
      raise exception 'admin_backfill_round: layer % is missing a roll for %', v_layer_index, v_missing_id
        using errcode = 'RFB37';
    end if;

    for v_entry in select * from jsonb_array_elements(v_layer_data) loop
      v_player_id := v_entry ->> 'player_id';
      v_value := (v_entry ->> 'value')::integer;

      if v_value is null or v_value < 1 or v_value > 20 then
        raise exception 'admin_backfill_round: roll value for % must be between 1 and 20', v_player_id
          using errcode = 'RFB38';
      end if;

      select modifier into v_modifier
        from public.room_players
       where room_id = v_room_id and player_id = v_player_id;

      -- Tie-break rerolls never carry advantage/disadvantage or a
      -- discarded_value (issue #219/0060) — only layer 0 ever could, and
      -- spell casting is out of scope for backfill entirely, so every
      -- backfilled roll at every layer leaves discarded_value null.
      insert into public.rolls
        (round_id, player_id, layer, value, input_mode, modifier_snapshot, entered_by_admin)
      values
        (v_round_id, v_player_id, v_layer_index, v_value, 'manual', coalesce(v_modifier, 0), true);
    end loop;

    -- Same precedence as src/lib/game/resolveLayer.ts: any nat-1 forces
    -- resolution among just the nat-1s (lowest modifier among them); else
    -- if every roller hit nat-20, lowest modifier among all of them; else
    -- nat-20 rollers are excluded as candidates and the lowest roll+modifier
    -- among the rest decides it. A single remaining candidate is the
    -- brewer; more than one is next layer's tied roster.
    select array_agg(player_id) into v_nat1_ids
      from jsonb_to_recordset(v_layer_data) as x(player_id text, value integer)
     where x.value = 1;

    if v_nat1_ids is not null then
      select array_agg(t.player_id) into v_winner_ids
        from (
          select r.player_id, rank() over (order by r.modifier_snapshot asc) as rnk
            from public.rolls r
           where r.round_id = v_round_id and r.layer = v_layer_index and r.player_id = any (v_nat1_ids)
        ) t
       where t.rnk = 1;
    else
      select not exists (
        select 1 from jsonb_to_recordset(v_layer_data) as x(player_id text, value integer) where x.value <> 20
      ) into v_all_nat20;

      if v_all_nat20 then
        select array_agg(t.player_id) into v_winner_ids
          from (
            select r.player_id, rank() over (order by r.modifier_snapshot asc) as rnk
              from public.rolls r
             where r.round_id = v_round_id and r.layer = v_layer_index
          ) t
         where t.rnk = 1;
      else
        select array_agg(t.player_id) into v_winner_ids
          from (
            select r.player_id, rank() over (order by (r.value + r.modifier_snapshot) asc) as rnk
              from public.rolls r
             where r.round_id = v_round_id and r.layer = v_layer_index and r.value <> 20
          ) t
         where t.rnk = 1;
      end if;
    end if;

    if array_length(v_winner_ids, 1) = 1 then
      if v_layer_index <> v_layer_count - 1 then
        raise exception 'admin_backfill_round: round already resolved at layer % — no further layers expected', v_layer_index
          using errcode = 'RFB39';
      end if;

      perform public.resolve_round(v_round_id, v_winner_ids[1], array_length(p_participant_ids, 1));
    else
      if v_layer_index = v_layer_count - 1 then
        raise exception 'admin_backfill_round: layer % is still tied — a further layer is required', v_layer_index
          using errcode = 'RFB40';
      end if;

      perform public.advance_round_layer(v_round_id, v_winner_ids);
    end if;
  end loop;

  return v_round_id;
end;
$$;

revoke execute on function public.admin_backfill_round(text[], jsonb) from public, anon;
grant execute on function public.admin_backfill_round(text[], jsonb) to authenticated;

comment on function public.admin_backfill_round(text[], jsonb) is
  'Raises RFB33 when the caller is not an admin, RFB34 for fewer than 2 participants, RFB35 for no layers, RFB36 when another round is already live in today''s room, RFB37 for a roster mismatch, RFB38 for an out-of-range roll, RFB39/RFB40 for a layer count that does not match the computed tie-break outcome.';

-- Redefines stats_room_rounds (0025, most recently 0071_admin_proxy_roll.sql)
-- to add rounds.backfilled_by as a plain `backfilled` boolean, the round-
-- level counterpart to 0071's per-roll `has_proxy_roll` -- both columns are
-- kept here since `create or replace view` replaces the entire column list,
-- not just the one this migration cares about. Whichever of 0071/0072
-- actually lands second in master needs its own view redefinition to carry
-- the other's column forward the same way -- ordinary migration-conflict
-- housekeeping, same as any other pair of migrations touching one shared
-- view (e.g. 0053 layering onto 0025's own stats views).
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
  ) as has_proxy_roll,
  r.backfilled_by is not null as backfilled
from public.rounds r
join public.rooms ro on ro.id = r.room_id
join public.players starter on starter.id = r.started_by
join public.players brewer on brewer.id = r.brewer_id
where r.status = 'resolved' and not ro.is_test
order by r.resolved_at desc;

alter view public.stats_room_rounds set (security_invoker = on);

-- Read-only helper for the /admin/backfill wizard (issue #274): each
-- candidate participant's *current* modifier in today's room, defaulting to
-- 0 for a player with no room_players row yet (they haven't logged in
-- today, or today's room doesn't exist at all yet) -- exactly the same
-- default a fresh room_players row would get. Lets the admin's browser
-- replicate resolveLayer.ts's own tie-break precedence live, layer by
-- layer, using the same modifier figures admin_backfill_round itself will
-- snapshot into each roll it writes. No admin gate: room_players is already
-- "readable by authenticated users" (0003), so this exposes nothing a
-- direct query couldn't already -- it just centralizes the Europe/London
-- "today" resolution server-side rather than duplicating that date logic in
-- TS, matching every other same-day RPC in this codebase.
create or replace function public.get_todays_modifiers(p_player_ids text[])
returns table (player_id text, modifier integer)
language plpgsql
security definer
set search_path = public
as $$
declare
  v_today date;
  v_room_id uuid;
begin
  v_today := (now() at time zone 'Europe/London')::date;
  select id into v_room_id from public.rooms where date = v_today;

  return query
    select u.pid, coalesce(rp.modifier, 0)
      from unnest(p_player_ids) as u (pid)
      left join public.room_players rp on rp.room_id = v_room_id and rp.player_id = u.pid;
end;
$$;

revoke execute on function public.get_todays_modifiers(text[]) from public, anon;
grant execute on function public.get_todays_modifiers(text[]) to authenticated;
