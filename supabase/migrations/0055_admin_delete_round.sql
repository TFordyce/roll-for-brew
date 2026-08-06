-- Admin round deletion (issue #189): a round can end up invalid with no
-- in-app way to clean it up -- concrete case: a declared player turned out
-- not to be whitelisted partway through a round (the whitelist is an
-- auth-layer gate only, re-checked on token refresh per 0001/0002, not a
-- check any round RPC makes), so the round had to be resolved by hand
-- outside the app. That round's rolls/participants/etc. were still sitting
-- in the DB, silently skewing stats (stats_* are computed live off these
-- tables, per 0006/0025/0053 -- deleting the round is sufficient to exclude
-- it, no separate stats fix needed).
--
-- Deletes a single round, not its room -- other rounds that day may still
-- be legitimate. Every downstream table already cascades off rounds.id
-- (round_participants/rolls/reroll layers since 0004/0005/0007,
-- spell_casts/reaction windows/manual draws since 0019/0021/0036/0041), so
-- `delete from rounds` alone is enough; no per-table cleanup needed.
--
-- Hard delete, not a soft "voided" flag: this is corrupted data that should
-- never have existed, not a dispute needing an in-app audit trail visible to
-- players (mirrors modifier_adjustments' append-only style, but scoped to
-- service_role only -- see admin_round_deletions below).

-- Snapshot of every round deletion: round_id has no FK (the round row is
-- gone immediately after this insert) but room_id does, since the room
-- itself persists. Exists so "what was deleted, by whom, and why" survives
-- the round row's deletion -- required precisely because
-- admin_delete_round's reason parameter would otherwise have nowhere to
-- live once the round it describes is gone. service_role only: this is an
-- internal admin log, not a player-facing history like modifier_adjustments
-- (0052), so there's no authenticated select grant/policy for it yet.
create table if not exists public.admin_round_deletions (
  id uuid primary key default gen_random_uuid(),
  round_id uuid not null,
  room_id uuid not null references public.rooms (id) on delete cascade,
  round_status text not null,
  round_started_by text,
  round_started_at timestamptz not null,
  actor_player_id text not null references public.players (id) on delete cascade,
  reason text not null,
  deleted_at timestamptz not null default now(),
  constraint admin_round_deletions_reason_not_blank check (btrim(reason) <> '')
);

create index if not exists admin_round_deletions_room_id_idx on public.admin_round_deletions (room_id);

alter table public.admin_round_deletions enable row level security;

-- No policies at all: service_role bypasses RLS entirely, and there's no
-- authenticated-facing read/write surface for this table today (see above).

-- Every table created since 0017 needs its own explicit grant -- 0015's
-- `grant all on all tables in schema public` was a one-time snapshot, not
-- retroactive (issue #137/0042's fix generalized this same lesson).
grant all on public.admin_round_deletions to service_role;

-- Deletes a round after logging a snapshot + reason to
-- admin_round_deletions. Admin-gated the same way as
-- admin_allocate_spell_card/admin_get_card_assignments (0047): caller's
-- is_admin re-checked here regardless of what called it, not trusted from
-- the client. Deliberately has no round-status restriction (e.g. resolved
-- vs. still-open) -- the admin gate plus the required reason are the
-- intended friction, and an admin may just as plausibly need to clear out a
-- phantom open round as a bad resolved one.
create or replace function public.admin_delete_round(p_round_id uuid, p_reason text)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_caller text;
  v_is_admin boolean;
  v_reason text;
  v_room_id uuid;
  v_status text;
  v_started_by text;
  v_started_at timestamptz;
begin
  v_caller := public.current_player_id();

  select is_admin into v_is_admin from public.players where id = v_caller;
  if not coalesce(v_is_admin, false) then
    raise exception 'admin_delete_round: caller is not an admin'
      using errcode = 'RFB16';
  end if;

  v_reason := btrim(coalesce(p_reason, ''));
  if v_reason = '' then
    raise exception 'admin_delete_round: reason is required'
      using errcode = 'RFB17';
  end if;

  select room_id, status, started_by, started_at
    into v_room_id, v_status, v_started_by, v_started_at
    from public.rounds
   where id = p_round_id;

  if v_room_id is null then
    raise exception 'admin_delete_round: round not found'
      using errcode = 'RFB18';
  end if;

  insert into public.admin_round_deletions
    (round_id, room_id, round_status, round_started_by, round_started_at, actor_player_id, reason)
  values
    (p_round_id, v_room_id, v_status, v_started_by, v_started_at, v_caller, v_reason);

  delete from public.rounds where id = p_round_id;
end;
$$;

revoke execute on function public.admin_delete_round(uuid, text) from public, anon;
grant execute on function public.admin_delete_round(uuid, text) to authenticated;

comment on function public.admin_delete_round(uuid, text) is
  'Raises RFB16 when the caller is not an admin, RFB17 for a blank reason, RFB18 when the round does not exist.';
