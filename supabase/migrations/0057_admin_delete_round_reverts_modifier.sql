-- Fixes a gap found live after PR #190/#192 shipped: admin_delete_round
-- (0055) only ever did `delete from rounds`. That's enough to stop a round
-- counting in stats (computed live off the base tables), but resolve_round
-- (0020/0033) had already permanently written the brewer's cups-made bonus
-- into room_players.modifier -- a plain running total with no per-round
-- ledger row -- when the round resolved, and deleting the round's own rows
-- afterward never touched it. get_modifier_breakdown (0054) is explicit that
-- it can't reconcile spell-effect deltas against the live modifier for the
-- same reason (no durable per-source row); cups_made is the one source that
-- *does* have one (rounds.cups_made + rounds.brewer_id), so it's the one
-- source admin_delete_round can safely revert.
--
-- Concrete incident: a round was invalidated (issue #189's whitelist gap)
-- after its brewer had already banked a modifier gain from resolve_round.
-- The team logged a compensating modifier_adjustments row to net it back to
-- zero by hand. Once the round was deleted (0055) and, separately, that
-- compensating adjustment was deleted as no-longer-needed
-- (admin_delete_modifier_adjustment, 0056 -- which correctly reverses *its
-- own* delta), the brewer's modifier was left holding the original,
-- never-reverted cups-made gain on its own.
--
-- Fix has two parts: resolve_round now records exactly what it added (0 when
-- p_no_modifier_gain suppressed it, matching the existing guard) onto the
-- round row itself, and admin_delete_round reverts that exact amount from
-- the brewer's modifier before deleting the round -- no re-derivation from
-- spell_casts needed, and no risk of reverting more than resolve_round
-- actually applied.

-- Not null default 0: existing resolved rounds predate this column and get
-- 0 here, i.e. "nothing more to revert" -- correct for admin_delete_round's
-- purposes, since retroactively guessing a historical bump is worse than
-- leaving it alone (any such case would need the same manual correction
-- this incident already needed).
alter table public.rounds
  add column if not exists brewer_modifier_gain integer not null default 0;

-- Redefines resolve_round (0033) to also persist the modifier delta it just
-- applied (or suppressed) onto the round row, so a later admin_delete_round
-- can revert precisely that amount without re-deriving p_no_modifier_gain
-- from spell_casts rows that may no longer exist by delete time.
create or replace function public.resolve_round(
  p_round_id uuid, p_brewer_id text, p_cups_made integer, p_no_modifier_gain boolean default false
)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_status text;
  v_room_id uuid;
  v_layer integer;
  v_participant_count integer;
  v_expected_layer_count integer;
  v_roll_count integer;
  v_gain integer;
begin
  select status, room_id, current_layer into v_status, v_room_id, v_layer
    from public.rounds
   where id = p_round_id
   for update;

  if v_status is null then
    raise exception 'resolve_round: round not found';
  end if;

  if v_status <> 'closed' then
    raise exception 'resolve_round: round is not closed';
  end if;

  if not exists (
    select 1 from public.round_participants
     where round_id = p_round_id and player_id = p_brewer_id
  ) then
    raise exception 'resolve_round: brewer is not a participant in this round';
  end if;

  select count(*) into v_participant_count
    from public.round_participants
   where round_id = p_round_id;

  v_expected_layer_count := public.count_expected_layer_rollers(p_round_id, v_layer);

  select count(*) into v_roll_count
    from public.rolls
   where round_id = p_round_id and layer = v_layer;

  if v_roll_count < v_expected_layer_count then
    raise exception 'resolve_round: not all participants have rolled yet';
  end if;

  if p_cups_made <> v_participant_count then
    raise exception 'resolve_round: cups_made must equal the round''s participant count';
  end if;

  v_gain := case when p_no_modifier_gain then 0 else p_cups_made end;

  update public.rounds
     set status = 'resolved',
         brewer_id = p_brewer_id,
         cups_made = p_cups_made,
         brewer_modifier_gain = v_gain,
         resolved_at = now()
   where id = p_round_id;

  if not p_no_modifier_gain then
    update public.room_players
       set modifier = modifier + p_cups_made
     where room_id = v_room_id and player_id = p_brewer_id;
  end if;

  update public.spell_active_effects
     set rounds_remaining = rounds_remaining - 1
   where room_id = v_room_id;

  delete from public.spell_active_effects
   where room_id = v_room_id and rounds_remaining <= 0;
end;
$$;

revoke execute on function public.resolve_round(uuid, text, integer, boolean) from public, anon;
grant execute on function public.resolve_round(uuid, text, integer, boolean) to authenticated;

-- admin_round_deletions (0055) grows two columns so the audit trail shows
-- exactly what modifier reversal, if any, accompanied a deletion -- the same
-- "what happened and why survives the deleted row" rationale 0055 already
-- applied to the round snapshot itself.
alter table public.admin_round_deletions
  add column if not exists brewer_id text,
  add column if not exists brewer_modifier_gain_reverted integer;

-- Redefines admin_delete_round (0055) to revert the brewer's cups-made
-- modifier gain before deleting the round, when the round was resolved and
-- actually applied one. Deliberately still doesn't touch spell-effect
-- deltas -- same carve-out get_modifier_breakdown (0054) already documents,
-- since those have no durable per-source row to revert safely.
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
  v_brewer_id text;
  v_gain integer;
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

  select room_id, status, started_by, started_at, brewer_id, brewer_modifier_gain
    into v_room_id, v_status, v_started_by, v_started_at, v_brewer_id, v_gain
    from public.rounds
   where id = p_round_id;

  if v_room_id is null then
    raise exception 'admin_delete_round: round not found'
      using errcode = 'RFB18';
  end if;

  if v_status = 'resolved' and v_brewer_id is not null and coalesce(v_gain, 0) <> 0 then
    update public.room_players
       set modifier = modifier - v_gain
     where room_id = v_room_id and player_id = v_brewer_id;
  else
    v_gain := 0;
  end if;

  insert into public.admin_round_deletions
    (round_id, room_id, round_status, round_started_by, round_started_at, actor_player_id, reason,
     brewer_id, brewer_modifier_gain_reverted)
  values
    (p_round_id, v_room_id, v_status, v_started_by, v_started_at, v_caller, v_reason,
     v_brewer_id, v_gain);

  delete from public.rounds where id = p_round_id;
end;
$$;

revoke execute on function public.admin_delete_round(uuid, text) from public, anon;
grant execute on function public.admin_delete_round(uuid, text) to authenticated;

comment on function public.admin_delete_round(uuid, text) is
  'Raises RFB16 when the caller is not an admin, RFB17 for a blank reason, RFB18 when the round does not exist. Reverts the resolved round''s brewer_modifier_gain from the brewer''s room_players.modifier before deleting.';
