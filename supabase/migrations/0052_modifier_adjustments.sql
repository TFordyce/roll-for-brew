-- Modifier Adjustment (issue #183, part of #182): the core primitive for
-- logging a one-off, signed, reasoned change to any player's modifier for
-- today's room. Append-only by design -- rows are only ever inserted (via
-- log_modifier_adjustment) or deleted on undo (via
-- delete_modifier_adjustment), never updated, so the log itself is always a
-- faithful history of what was applied and reversed.
--
-- Mirrors withdraw_declaration's (0043) shape for actor resolution and
-- close_round's (0004) authority-check style: the actor is always derived
-- server-side from current_player_id(), never a client parameter.
create table if not exists public.modifier_adjustments (
  id uuid primary key default gen_random_uuid(),
  room_id uuid not null references public.rooms (id) on delete cascade,
  target_player_id text not null references public.players (id) on delete cascade,
  actor_player_id text not null references public.players (id) on delete cascade,
  delta integer not null,
  reason text not null,
  created_at timestamptz not null default now(),
  constraint modifier_adjustments_delta_nonzero check (delta <> 0),
  constraint modifier_adjustments_reason_not_blank check (btrim(reason) <> '')
);

-- Powers "today's adjustments" listing (by room) and the "caller's own
-- most-recent adjustment" lookup delete_modifier_adjustment relies on.
create index if not exists modifier_adjustments_room_id_idx on public.modifier_adjustments (room_id);
create index if not exists modifier_adjustments_actor_created_at_idx
  on public.modifier_adjustments (actor_player_id, created_at desc);

alter table public.modifier_adjustments enable row level security;

-- No insert/update/delete policies -- the only writers are the
-- security definer functions below, which bypass RLS as table owner.
create policy "modifier adjustments are readable by authenticated users"
  on public.modifier_adjustments for select
  to authenticated
  using (true);

-- Logs an adjustment and applies it to the target's live room_players.modifier
-- in the same transaction. Validates the target is present in the caller's
-- own today's room (not a client-supplied room id -- "today" is re-derived
-- server-side the same way enter_todays_room does, 0003), and rejects a zero
-- delta or a blank reason before the insert (also guarded by the table's own
-- check constraints as a second line of defense).
create or replace function public.log_modifier_adjustment(
  p_target_player_id text,
  p_delta integer,
  p_reason text
)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_actor_id text;
  v_room_id uuid;
  v_reason text;
  v_adjustment_id uuid;
begin
  v_actor_id := public.current_player_id();

  if p_delta = 0 then
    raise exception 'log_modifier_adjustment: delta must be non-zero'
      using errcode = 'RFB10';
  end if;

  v_reason := btrim(coalesce(p_reason, ''));
  if v_reason = '' then
    raise exception 'log_modifier_adjustment: reason is required'
      using errcode = 'RFB11';
  end if;

  select id into v_room_id
    from public.rooms
   where date = ((now() at time zone 'Europe/London')::date);

  if v_room_id is null then
    raise exception 'log_modifier_adjustment: no room exists for today';
  end if;

  if not exists (
    select 1 from public.room_players
     where room_id = v_room_id and player_id = p_target_player_id
  ) then
    raise exception 'log_modifier_adjustment: target is not in today''s room'
      using errcode = 'RFB12';
  end if;

  insert into public.modifier_adjustments (room_id, target_player_id, actor_player_id, delta, reason)
  values (v_room_id, p_target_player_id, v_actor_id, p_delta, v_reason)
  returning id into v_adjustment_id;

  update public.room_players
     set modifier = modifier + p_delta
   where room_id = v_room_id and player_id = p_target_player_id;

  return v_adjustment_id;
end;
$$;

revoke execute on function public.log_modifier_adjustment(text, integer, text) from public, anon;
grant execute on function public.log_modifier_adjustment(text, integer, text) to authenticated;

comment on function public.log_modifier_adjustment(text, integer, text) is
  'Raises RFB10 for a zero delta, RFB11 for a blank reason, RFB12 when the target is not in the caller''s today''s room.';

-- Undoes the caller's own most-recent adjustment within 5 minutes of
-- logging it, reversing the modifier bump and deleting the row in one
-- transaction. Mirrors stall-timeout's (0009) real-elapsed-time gating,
-- computed off created_at rather than an injected clock since this runs
-- server-side against now().
create or replace function public.delete_modifier_adjustment(p_adjustment_id uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_actor_id text;
  v_row public.modifier_adjustments%rowtype;
  v_latest_id uuid;
begin
  v_actor_id := public.current_player_id();

  select * into v_row from public.modifier_adjustments where id = p_adjustment_id;

  if v_row.id is null then
    raise exception 'delete_modifier_adjustment: adjustment not found';
  end if;

  if v_row.actor_player_id <> v_actor_id then
    raise exception 'delete_modifier_adjustment: only the actor can undo their own adjustment'
      using errcode = 'RFB13';
  end if;

  select id into v_latest_id
    from public.modifier_adjustments
   where actor_player_id = v_actor_id
   order by created_at desc, id desc
   limit 1;

  if v_latest_id is distinct from p_adjustment_id then
    raise exception 'delete_modifier_adjustment: only the most recent adjustment can be undone'
      using errcode = 'RFB14';
  end if;

  if now() - v_row.created_at > interval '5 minutes' then
    raise exception 'delete_modifier_adjustment: the 5 minute undo window has passed'
      using errcode = 'RFB15';
  end if;

  update public.room_players
     set modifier = modifier - v_row.delta
   where room_id = v_row.room_id and player_id = v_row.target_player_id;

  delete from public.modifier_adjustments where id = p_adjustment_id;
end;
$$;

revoke execute on function public.delete_modifier_adjustment(uuid) from public, anon;
grant execute on function public.delete_modifier_adjustment(uuid) to authenticated;

comment on function public.delete_modifier_adjustment(uuid) is
  'Raises RFB13 when the caller is not the row''s actor, RFB14 when it is not the actor''s most-recent adjustment, RFB15 once 5 minutes have elapsed since created_at.';
