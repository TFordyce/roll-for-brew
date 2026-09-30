-- GENERATED FROM db/sql/functions/ -- DO NOT EDIT
--
-- Written by `npm run build:migrations` from the canonical resolver-function
-- sources under db/sql/functions/. To change any function below, edit its
-- db/sql/functions/<name>.sql and re-run the build. See db/sql/README.md.
--
-- Functions in this migration:
--   _apply_crit_redirect
--   _land_drawn_instance
--   _rr_active_effects_as_of
--   _rr_participated_rounds_elapsed
--   admin_proxy_roll
--   draw_pending_spell_card
--   draw_pending_spell_card_manual
--   draw_spell_card
--   draw_spell_card_as
--   record_pending_spell_draw

-- BEGIN db/sql/functions/_apply_crit_redirect.sql
-- _apply_crit_redirect(uuid, text) -> text
--
-- Issue #435 (spec #401 F6, #383 Q5): the shared crit-redirect hook. Given
-- that p_player_id just rolled a nat 1 / nat 20 in p_round_id, returns the
-- player the crit's spell draw goes to. NULL means the draw fizzles.
--
-- Called from all three crit entry points, before the draw is recorded for
-- anyone:
--   * record_pending_spell_draw (the client's pending-draw record);
--   * admin_proxy_roll (its direct pending_spell_draws insert);
--   * draw_spell_card_as when given a round (the Test-room puppet path, which
--     draws immediately and has no pending row).
-- Returning the recipient rather than rewriting a pending row keeps the
-- puppet path on the same hook.
--
-- A no-op for now: every crit draws for the roller. Marked for Brew (#401)
-- fills it in -- the oldest live next_crit draw_redirect mark on the roller
-- names the beneficiary, and firing it records consumption on the mark's
-- source cast.
--
-- Internal: no grant; only reached from the SECURITY DEFINER entry points.
--
-- Canonical source: this file is the source of truth for the function body.
-- Edit here and run `npm run build:migrations` -- do not hand-edit the
-- generated migration. See db/sql/README.md.

create or replace function public._apply_crit_redirect(p_round_id uuid, p_player_id text)
returns text
language plpgsql
set search_path = public
as $$
begin
  return p_player_id;
end;
$$;

revoke execute on function public._apply_crit_redirect(uuid, text) from public, anon, authenticated;
-- END db/sql/functions/_apply_crit_redirect.sql

-- BEGIN db/sql/functions/_land_drawn_instance.sql
-- _land_drawn_instance(text, uuid, text) -> boolean
--
-- Issue #435 (spec #401 F6, #383 Q5): puts a just-drawn spell_deck_instances
-- row into p_player_id's hand and logs the draw. Returns needs_swap_decision.
-- Replaces the placement block the four draw RPCs (draw_spell_card,
-- draw_spell_card_as, draw_pending_spell_card, draw_pending_spell_card_manual)
-- each carried a copy of (0018 / 0034 / 0036, last restated in 0070):
--   * empty hand -> 'held';
--   * already holding a card, nat 20 -> parked as 'pending_swap' for the
--     keep-or-swap choice;
--   * already holding a card, nat 1 -> forced swap (0070, #267): the held card
--     goes back to 'in_deck' and the new one is seated as 'held', no choice.
-- Then one spell_draws row for the player.
--
-- The callers keep their own instance pick and their own "already has a
-- pending keep-or-swap decision" guard. Stale Biscuit (#401) hooks in here:
-- a live next_draw mark on p_player_id lands the card with its beneficiary.
--
-- Internal: no grant; only reached from the SECURITY DEFINER draw RPCs.
--
-- Canonical source: this file is the source of truth for the function body.
-- Edit here and run `npm run build:migrations` -- do not hand-edit the
-- generated migration. See db/sql/README.md.

create or replace function public._land_drawn_instance(
  p_player_id text, p_instance_id uuid, p_trigger text
)
returns boolean
language plpgsql
set search_path = public
as $$
declare
  v_already_held boolean;
  v_needs_swap_decision boolean;
begin
  v_already_held := exists (
    select 1 from public.spell_deck_instances
     where held_by_player = p_player_id and location = 'held'
  );

  if v_already_held and p_trigger = 'nat1' then
    update public.spell_deck_instances
       set location = 'in_deck', held_by_player = null
     where held_by_player = p_player_id and location = 'held';

    update public.spell_deck_instances
       set location = 'held', held_by_player = p_player_id
     where id = p_instance_id;

    v_needs_swap_decision := false;
  else
    update public.spell_deck_instances
       set location = case when v_already_held then 'pending_swap' else 'held' end,
           held_by_player = p_player_id
     where id = p_instance_id;

    v_needs_swap_decision := v_already_held;
  end if;

  insert into public.spell_draws (player_id, card_instance_id, trigger)
  values (p_player_id, p_instance_id, p_trigger);

  return v_needs_swap_decision;
end;
$$;

revoke execute on function public._land_drawn_instance(text, uuid, text) from public, anon, authenticated;
-- END db/sql/functions/_land_drawn_instance.sql

-- BEGIN db/sql/functions/_rr_active_effects_as_of.sql
-- _rr_active_effects_as_of(uuid, uuid) -> setof spell_active_effects
--
-- The projection row source (issue #310, migration 0084): the
-- spell_active_effects rows LIVE as of p_as_of_round_id. Drop-in for
-- `from public.spell_active_effects sae` in any reader that has a room id and
-- a round id in scope.
--
-- A row is live as of the given round iff ALL of:
--   * its source cast is not negated;
--   * its duration is not exhausted: rounds_remaining IS NULL (unbounded), OR
--     the number of resolved rounds in [source-cast's round .started_at,
--     as-of round .started_at) is < rounds_remaining
--     (_rr_effect_rounds_elapsed);
--   * it has not been dispelled at or before the as-of round: no non-negated
--     'dispel' cast whose effect_params.ended_effect_id names this row sits
--     in a round started on/before the as-of round;
--   * it has not been spent (issue #435, spec #401 F6): its source cast
--     records neither cast_inputs.consumed_by_round nor
--     cast_inputs.consumed_by_draw. A one-shot effect (a Draw Redirect mark)
--     writes one of these when it fires. Unlike a dispel this is not bounded
--     by the as-of round -- a fired mark is spent for good, even to an as-of
--     read of an earlier round, and a Round replay scrap does not restore it
--     (#383 Q2), because the card it moved survives the scrap.
--
-- Body from migration 0084 plus the spent condition; grants merge 0084
-- (authenticated) and 0108 (service_role, the integration suite's seam).
--
-- Canonical source: this file is the source of truth for the function body.
-- Edit here and run `npm run build:migrations` -- do not hand-edit the
-- generated migration. See db/sql/README.md.

create or replace function public._rr_active_effects_as_of(
  p_room_id uuid, p_as_of_round_id uuid
)
returns setof public.spell_active_effects
language sql
stable
set search_path = public
as $$
  -- Not SECURITY DEFINER: like _rr_active_ward_gate (0082), this is only ever
  -- reached from within a SECURITY DEFINER reader, so it runs with that
  -- reader's privileges. A direct call by `authenticated` hits RLS on
  -- spell_active_effects (no select policy) and returns nothing -- the room
  -- membership gate stays with the public-facing RPCs.
  with as_of as (
    select started_at from public.rounds where id = p_as_of_round_id
  )
  select sae.*
    from public.spell_active_effects sae
    join public.spell_casts src on src.id = sae.source_cast_id
    join public.rounds src_round on src_round.id = src.round_id
   where sae.room_id = p_room_id
     and coalesce(src.negated, false) = false
     and src.cast_inputs ->> 'consumed_by_round' is null
     and src.cast_inputs ->> 'consumed_by_draw' is null
     and (
       sae.rounds_remaining is null
       or public._rr_effect_rounds_elapsed(
            p_room_id, src_round.started_at, (select started_at from as_of)
          ) < sae.rounds_remaining
     )
     and not exists (
       select 1
         from public.spell_casts dc
         join public.rounds dr on dr.id = dc.round_id
        where dc.effect_kind = 'dispel'
          and dc.effect_params ->> 'ended_effect_id' = sae.id::text
          and coalesce(dc.negated, false) = false
          and dr.started_at <= (select started_at from as_of)
     );
$$;

revoke execute on function public._rr_active_effects_as_of(uuid, uuid) from public, anon;
grant execute on function public._rr_active_effects_as_of(uuid, uuid) to authenticated, service_role;

comment on function public._rr_active_effects_as_of(uuid, uuid) is
  'Issue #310: the spell_active_effects rows live as of a given round -- '
  'source cast not negated, duration not exhausted (resolved-round count '
  'since the source round), not dispelled at/before the round, and (#435) '
  'not spent (source cast_inputs.consumed_by_round / consumed_by_draw). '
  'The shared row source for every reader that treats spell_active_effects '
  'as current game state (the ward gate/map, dispel/room badge readers, '
  'resolve_round''s phases).';
-- END db/sql/functions/_rr_active_effects_as_of.sql

-- BEGIN db/sql/functions/_rr_participated_rounds_elapsed.sql
-- _rr_participated_rounds_elapsed(uuid, text, timestamptz, timestamptz) -> integer
--
-- Issue #435 (spec #401 F3, #383 Q3 / #384): resolved rounds in
-- [p_source_started_at, p_as_of_started_at) that p_player_id took part in --
-- has a round_participants row for -- in p_room_id. The per-player sibling of
-- _rr_effect_rounds_elapsed (0084), which counts every resolved room round.
-- Same bounds: source inclusive, as-of strict, a NULL as-of drops the upper
-- bound.
--
-- "Took part" is participation, not rolling: a round the player joined but
-- never rolled in (a Tea Cosy round, a Roll Exemption, a Brew Debt round)
-- still counts; a round they sat out does not. Shared duration clock for
-- Marked for Brew's 5-round window and the Courage Token's 3 rounds.
--
-- Canonical source: this file is the source of truth for the function body.
-- Edit here and run `npm run build:migrations` -- do not hand-edit the
-- generated migration. See db/sql/README.md.

create or replace function public._rr_participated_rounds_elapsed(
  p_room_id uuid, p_player_id text,
  p_source_started_at timestamptz, p_as_of_started_at timestamptz
)
returns integer
language sql
stable
set search_path = public
as $$
  select count(*)::integer
    from public.rounds r
    join public.round_participants rp
      on rp.round_id = r.id and rp.player_id = p_player_id
   where r.room_id = p_room_id
     and r.status = 'resolved'
     and r.started_at >= p_source_started_at
     and (p_as_of_started_at is null or r.started_at < p_as_of_started_at);
$$;

revoke execute on function public._rr_participated_rounds_elapsed(uuid, text, timestamptz, timestamptz) from public, anon;
grant execute on function public._rr_participated_rounds_elapsed(uuid, text, timestamptz, timestamptz) to authenticated, service_role;
-- END db/sql/functions/_rr_participated_rounds_elapsed.sql

-- BEGIN db/sql/functions/admin_proxy_roll.sql
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
-- END db/sql/functions/admin_proxy_roll.sql

-- BEGIN db/sql/functions/draw_pending_spell_card.sql
-- draw_pending_spell_card(uuid) -> table (instance_id uuid, needs_swap_decision boolean)
--
-- In-app draw against the caller's pending_spell_draws row for a round
-- (0036; forced nat-1 swap from 0070). Placement is _land_drawn_instance's
-- (issue #435) -- verbatim from migration 0070 otherwise.
--
-- Canonical source: this file is the source of truth for the function body.
-- Edit here and run `npm run build:migrations` -- do not hand-edit the
-- generated migration. See db/sql/README.md.

create or replace function public.draw_pending_spell_card(p_round_id uuid)
returns table (instance_id uuid, needs_swap_decision boolean)
language plpgsql
security definer
set search_path = public
as $$
declare
  v_player_id text;
  v_trigger text;
  v_new_instance_id uuid;
begin
  v_player_id := public.current_player_id(p_round_id);

  select trigger into v_trigger
    from public.pending_spell_draws
   where round_id = p_round_id and player_id = v_player_id;

  if v_trigger is null then
    raise exception 'draw_pending_spell_card: caller has no pending spell draw for this round';
  end if;

  if exists (
    select 1 from public.spell_deck_instances
     where held_by_player = v_player_id and location = 'pending_swap'
  ) then
    raise exception 'draw_pending_spell_card: caller already has a pending keep-or-swap decision';
  end if;

  select id into v_new_instance_id
    from public.spell_deck_instances
   where location = 'in_deck'
   order by random()
   limit 1
     for update skip locked;

  delete from public.pending_spell_draws where round_id = p_round_id and player_id = v_player_id;

  if v_new_instance_id is null then
    return;
  end if;

  needs_swap_decision := public._land_drawn_instance(v_player_id, v_new_instance_id, v_trigger);
  instance_id := v_new_instance_id;
  return next;
end;
$$;

revoke execute on function public.draw_pending_spell_card(uuid) from public, anon;
grant execute on function public.draw_pending_spell_card(uuid) to authenticated;
-- END db/sql/functions/draw_pending_spell_card.sql

-- BEGIN db/sql/functions/draw_pending_spell_card_manual.sql
-- draw_pending_spell_card_manual(uuid, uuid) -> table (instance_id uuid, needs_swap_decision boolean)
--
-- "I drew this IRL" against the caller's pending_spell_draws row: claims a
-- named card from the deck (0036; forced nat-1 swap from 0070). Placement is
-- _land_drawn_instance's (issue #435) -- verbatim from migration 0070
-- otherwise.
--
-- Canonical source: this file is the source of truth for the function body.
-- Edit here and run `npm run build:migrations` -- do not hand-edit the
-- generated migration. See db/sql/README.md.

create or replace function public.draw_pending_spell_card_manual(p_round_id uuid, p_card_id uuid)
returns table (instance_id uuid, needs_swap_decision boolean)
language plpgsql
security definer
set search_path = public
as $$
declare
  v_player_id text;
  v_trigger text;
  v_new_instance_id uuid;
begin
  v_player_id := public.current_player_id(p_round_id);

  select trigger into v_trigger
    from public.pending_spell_draws
   where round_id = p_round_id and player_id = v_player_id;

  if v_trigger is null then
    raise exception 'draw_pending_spell_card_manual: caller has no pending spell draw for this round';
  end if;

  if exists (
    select 1 from public.spell_deck_instances
     where held_by_player = v_player_id and location = 'pending_swap'
  ) then
    raise exception 'draw_pending_spell_card_manual: caller already has a pending keep-or-swap decision';
  end if;

  select id into v_new_instance_id
    from public.spell_deck_instances
   where card_id = p_card_id and location = 'in_deck'
     for update skip locked;

  if v_new_instance_id is null then
    raise exception 'draw_pending_spell_card_manual: that card is not currently in the deck'
      using errcode = 'RFB06';
  end if;

  delete from public.pending_spell_draws where round_id = p_round_id and player_id = v_player_id;

  needs_swap_decision := public._land_drawn_instance(v_player_id, v_new_instance_id, v_trigger);
  instance_id := v_new_instance_id;
  return next;
end;
$$;

revoke execute on function public.draw_pending_spell_card_manual(uuid, uuid) from public, anon;
grant execute on function public.draw_pending_spell_card_manual(uuid, uuid) to authenticated;

comment on function public.draw_pending_spell_card_manual(uuid, uuid) is
  'Raises RFB06 when the claimed card has no currently-in-deck instance — a physical/digital desync the table needs to reconcile. The pending draw row is left in place so the player can retry.';
-- END db/sql/functions/draw_pending_spell_card_manual.sql

-- BEGIN db/sql/functions/draw_spell_card.sql
-- draw_spell_card(text, uuid) -> table (instance_id uuid, needs_swap_decision boolean)
--
-- In-app nat-1 / nat-20 draw for the caller (0018; (text, uuid) signature from
-- 0026; forced nat-1 swap from 0070). Placement is _land_drawn_instance's
-- (issue #435) -- verbatim from migration 0070 otherwise.
--
-- Canonical source: this file is the source of truth for the function body.
-- Edit here and run `npm run build:migrations` -- do not hand-edit the
-- generated migration. See db/sql/README.md.

create or replace function public.draw_spell_card(p_trigger text, p_room_id uuid default null)
returns table (instance_id uuid, needs_swap_decision boolean)
language plpgsql
security definer
set search_path = public
as $$
declare
  v_player_id text;
  v_new_instance_id uuid;
begin
  v_player_id := public.current_player_id(null, p_room_id);

  if p_trigger not in ('nat1', 'nat20') then
    raise exception 'draw_spell_card: invalid trigger %', p_trigger;
  end if;

  if exists (
    select 1 from public.spell_deck_instances
     where held_by_player = v_player_id and location = 'pending_swap'
  ) then
    raise exception 'draw_spell_card: caller already has a pending keep-or-swap decision';
  end if;

  select id into v_new_instance_id
    from public.spell_deck_instances
   where location = 'in_deck'
   order by random()
   limit 1
     for update skip locked;

  if v_new_instance_id is null then
    return;
  end if;

  needs_swap_decision := public._land_drawn_instance(v_player_id, v_new_instance_id, p_trigger);
  instance_id := v_new_instance_id;
  return next;
end;
$$;

revoke execute on function public.draw_spell_card(text, uuid) from public, anon;
grant execute on function public.draw_spell_card(text, uuid) to authenticated;
-- END db/sql/functions/draw_spell_card.sql

-- BEGIN db/sql/functions/draw_spell_card_as.sql
-- draw_spell_card_as(text, uuid, text, uuid, uuid) -> table (instance_id uuid, needs_swap_decision boolean)
--
-- Admin "draw for others" in the Test Room (0034; forced nat-1 swap from
-- 0070) -- the Test-room puppet path's crit draw, which draws immediately
-- with no pending_spell_draws row.
--
-- Issue #435 (spec #401 F6): gains p_round_id, the round the crit was rolled
-- in. When given, the draw goes to _apply_crit_redirect's recipient -- this is
-- the puppet path's crit entry point -- and a NULL recipient (a fizzled
-- redirect) draws nothing. Without it (a caller with no round in hand) the
-- draw goes to p_player_id as before. Placement is _land_drawn_instance's.
-- The old 4-arg signature is dropped so PostgREST sees one overload.
--
-- Canonical source: this file is the source of truth for the function body.
-- Edit here and run `npm run build:migrations` -- do not hand-edit the
-- generated migration. See db/sql/README.md.

drop function if exists public.draw_spell_card_as(text, uuid, text, uuid);

create or replace function public.draw_spell_card_as(
  p_trigger text,
  p_room_id uuid,
  p_player_id text,
  p_card_id uuid default null,
  p_round_id uuid default null
)
returns table (instance_id uuid, needs_swap_decision boolean)
language plpgsql
security definer
set search_path = public
as $$
declare
  v_caller text;
  v_is_admin boolean;
  v_player_id text;
  v_new_instance_id uuid;
begin
  v_caller := public.current_player_id();

  select is_admin into v_is_admin from public.players where id = v_caller;
  if not coalesce(v_is_admin, false) then
    raise exception 'draw_spell_card_as: caller is not an admin';
  end if;

  if not exists (select 1 from public.rooms where id = p_room_id and is_test) then
    raise exception 'draw_spell_card_as: room is not the Test Room';
  end if;

  if p_trigger not in ('nat1', 'nat20') then
    raise exception 'draw_spell_card_as: invalid trigger %', p_trigger;
  end if;

  v_player_id := p_player_id;
  if p_round_id is not null then
    if not exists (select 1 from public.rounds where id = p_round_id and room_id = p_room_id) then
      raise exception 'draw_spell_card_as: round is not in this room';
    end if;

    v_player_id := public._apply_crit_redirect(p_round_id, p_player_id);
    if v_player_id is null then
      return;
    end if;
  end if;

  if exists (
    select 1 from public.spell_deck_instances
     where held_by_player = v_player_id and location = 'pending_swap'
  ) then
    raise exception 'draw_spell_card_as: target player already has a pending keep-or-swap decision';
  end if;

  if p_card_id is not null then
    select id into v_new_instance_id
      from public.spell_deck_instances
     where card_id = p_card_id and location = 'in_deck'
       for update skip locked;

    if v_new_instance_id is null then
      raise exception 'draw_spell_card_as: chosen card is not currently in the deck';
    end if;
  else
    select id into v_new_instance_id
      from public.spell_deck_instances
     where location = 'in_deck'
     order by random()
     limit 1
       for update skip locked;

    if v_new_instance_id is null then
      return;
    end if;
  end if;

  needs_swap_decision := public._land_drawn_instance(v_player_id, v_new_instance_id, p_trigger);
  instance_id := v_new_instance_id;
  return next;
end;
$$;

revoke execute on function public.draw_spell_card_as(text, uuid, text, uuid, uuid) from public, anon;
grant execute on function public.draw_spell_card_as(text, uuid, text, uuid, uuid) to authenticated;
-- END db/sql/functions/draw_spell_card_as.sql

-- BEGIN db/sql/functions/record_pending_spell_draw.sql
-- record_pending_spell_draw(uuid, text) -> void
--
-- Records that the caller's nat 1 / nat 20 has fired this round, without
-- drawing yet (0036, re-created by 0041) -- the client's crit entry point
-- (maybeRecordPendingSpellDraw).
--
-- Issue #435 (spec #401 F6): the row is recorded for _apply_crit_redirect's
-- recipient rather than the roller outright; a NULL recipient (a fizzled
-- redirect) records nothing. A no-op redirect today, so behaviour is
-- unchanged.
--
-- Canonical source: this file is the source of truth for the function body.
-- Edit here and run `npm run build:migrations` -- do not hand-edit the
-- generated migration. See db/sql/README.md.

create or replace function public.record_pending_spell_draw(p_round_id uuid, p_trigger text)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_player_id text;
  v_recipient text;
begin
  v_player_id := public.current_player_id(p_round_id);

  if p_trigger not in ('nat1', 'nat20') then
    raise exception 'record_pending_spell_draw: invalid trigger %', p_trigger;
  end if;

  v_recipient := public._apply_crit_redirect(p_round_id, v_player_id);
  if v_recipient is null then
    return;
  end if;

  insert into public.pending_spell_draws (round_id, player_id, trigger)
  values (p_round_id, v_recipient, p_trigger)
  on conflict (round_id, player_id) do nothing;
end;
$$;

revoke execute on function public.record_pending_spell_draw(uuid, text) from public, anon;
grant execute on function public.record_pending_spell_draw(uuid, text) to authenticated;
-- END db/sql/functions/record_pending_spell_draw.sql

