-- admin_proxy_roll(uuid, text, integer) -> void
--
-- Proxy Roll (issue #273, migration 0071): an admin enters the number a
-- player present at the table read out, folding them into a live round.
-- Round-status eligibility mirrors declare_in_late's window: 'open', or
-- 'closed' with no rolls yet; RFB32 for the stale-round race.
--
-- Issue #435 (spec #401 F6): its nat 1 / nat 20 pending-draw insert is a crit
-- entry point, so the row goes to _apply_crit_redirect's recipient; a NULL
-- recipient (a fizzled redirect) records nothing. A no-op redirect today.
-- Verbatim from migration 0071 otherwise.
--
-- Canonical source: this file is the source of truth for the function body.
-- Edit here and run `npm run build:migrations` -- do not hand-edit the
-- generated migration. See db/sql/README.md.

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
  v_recipient text;
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
    v_recipient := public._apply_crit_redirect(p_round_id, p_player_id);
    if v_recipient is not null then
      insert into public.pending_spell_draws (round_id, player_id, trigger)
      values (p_round_id, v_recipient, case when p_value = 1 then 'nat1' else 'nat20' end)
      on conflict (round_id, player_id) do nothing;
    end if;
  end if;
end;
$$;

revoke execute on function public.admin_proxy_roll(uuid, text, integer) from public, anon;
grant execute on function public.admin_proxy_roll(uuid, text, integer) to authenticated;

comment on function public.admin_proxy_roll(uuid, text, integer) is
  'Raises RFB32 (round no longer open for a proxy roll) for the same stale-round race family as declare_in_late''s RFB31 — the round can close-then-roll between the admin form rendering and submitting.';
