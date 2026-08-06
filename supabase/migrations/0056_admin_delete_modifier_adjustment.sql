-- Admin modifier-adjustment deletion (issue #191): the self-serve undo
-- (delete_modifier_adjustment, 0052) only covers the actor's own,
-- most-recent, within-5-minutes adjustment. Real corrections don't always
-- fit that window -- e.g. an adjustment logged by someone other than the
-- actor, or noticed well after the fact (the same Marcus-whitelist incident
-- that motivated #189/admin_delete_round also produced an adjustment that
-- needed correcting later by someone who wasn't its actor). This gives an
-- admin an unrestricted variant: any adjustment, any age, any actor.
--
-- Reverses the modifier bump exactly the way delete_modifier_adjustment
-- does (modifier = modifier - delta) and deletes the row -- same
-- reversal logic, just without the actor/most-recent/5-minute gates.
--
-- Reason + audit table mirror admin_delete_round/admin_round_deletions
-- (0055): deleting the row loses its own `reason` explaining the delta, so
-- the deletion's own reason needs somewhere to live once the row is gone.

-- Snapshot of every admin-forced adjustment deletion, for the same reason
-- admin_round_deletions exists: adjustment_id has no FK (the row is gone
-- immediately after this insert) but room_id/target/actor do, since players
-- and rooms persist. service_role only -- internal admin log, no
-- authenticated-facing surface.
create table if not exists public.admin_modifier_adjustment_deletions (
  id uuid primary key default gen_random_uuid(),
  adjustment_id uuid not null,
  room_id uuid not null references public.rooms (id) on delete cascade,
  target_player_id text not null references public.players (id) on delete cascade,
  original_actor_player_id text not null references public.players (id) on delete cascade,
  delta integer not null,
  original_reason text not null,
  actor_player_id text not null references public.players (id) on delete cascade,
  reason text not null,
  deleted_at timestamptz not null default now(),
  constraint admin_modifier_adjustment_deletions_reason_not_blank check (btrim(reason) <> '')
);

create index if not exists admin_modifier_adjustment_deletions_room_id_idx
  on public.admin_modifier_adjustment_deletions (room_id);

alter table public.admin_modifier_adjustment_deletions enable row level security;

-- No policies: service_role bypasses RLS entirely, no authenticated-facing
-- read/write surface for this table today (see admin_round_deletions, 0055).

-- Every table created since 0017 needs its own explicit grant -- 0015's
-- `grant all on all tables in schema public` was a one-time snapshot, not
-- retroactive (issue #137/0042's fix generalized this same lesson).
grant all on public.admin_modifier_adjustment_deletions to service_role;

-- Deletes any modifier adjustment after logging a snapshot + reason to
-- admin_modifier_adjustment_deletions, reversing its modifier bump.
-- Admin-gated the same way as admin_delete_round (0055): caller's is_admin
-- re-checked here regardless of what called it, not trusted from the
-- client. Deliberately skips delete_modifier_adjustment's actor/most-recent/
-- 5-minute checks (RFB13/14/15) -- the admin gate plus the required reason
-- are the intended friction here instead.
create or replace function public.admin_delete_modifier_adjustment(p_adjustment_id uuid, p_reason text)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_caller text;
  v_is_admin boolean;
  v_reason text;
  v_row public.modifier_adjustments%rowtype;
begin
  v_caller := public.current_player_id();

  select is_admin into v_is_admin from public.players where id = v_caller;
  if not coalesce(v_is_admin, false) then
    raise exception 'admin_delete_modifier_adjustment: caller is not an admin'
      using errcode = 'RFB19';
  end if;

  v_reason := btrim(coalesce(p_reason, ''));
  if v_reason = '' then
    raise exception 'admin_delete_modifier_adjustment: reason is required'
      using errcode = 'RFB20';
  end if;

  select * into v_row from public.modifier_adjustments where id = p_adjustment_id;

  if v_row.id is null then
    raise exception 'admin_delete_modifier_adjustment: adjustment not found'
      using errcode = 'RFB21';
  end if;

  insert into public.admin_modifier_adjustment_deletions
    (adjustment_id, room_id, target_player_id, original_actor_player_id, delta, original_reason, actor_player_id, reason)
  values
    (v_row.id, v_row.room_id, v_row.target_player_id, v_row.actor_player_id, v_row.delta, v_row.reason, v_caller, v_reason);

  update public.room_players
     set modifier = modifier - v_row.delta
   where room_id = v_row.room_id and player_id = v_row.target_player_id;

  delete from public.modifier_adjustments where id = p_adjustment_id;
end;
$$;

revoke execute on function public.admin_delete_modifier_adjustment(uuid, text) from public, anon;
grant execute on function public.admin_delete_modifier_adjustment(uuid, text) to authenticated;

comment on function public.admin_delete_modifier_adjustment(uuid, text) is
  'Raises RFB19 when the caller is not an admin, RFB20 for a blank reason, RFB21 when the adjustment does not exist.';
