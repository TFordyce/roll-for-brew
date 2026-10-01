-- Tea Party Revolt (issue #430, spec #401, design #380).
--
-- Tea Party Revolt (Common, TABLE, Action): "The lowest roller chooses who
-- makes tea this round."
--
-- Model: a table-wide tea_maker_override in mode `chosen` (tier 2 of the
-- precedence ladder, ADR 0005) whose target isn't known at cast time. The
-- catalog row carries `picker: 'lowest_roller'`, so cast_spell_card's generic
-- TABLE branch records it with no target and no by-name branch. Once layer 0
-- is rolled, the Revolt Picker -- the lowest raw layer-0 roller, a tie going
-- to the tied roller with the smallest player_id -- names the target through
-- set_tea_party_revolt_target. The pick is written onto the cast
-- (target_player_id, cast_inputs.revolt_picked_by), and tea-maker selection
-- (_rr_select_tea_maker, #451) then reads it as an ordinary `chosen`
-- override.
--
-- Advancement (ADR 0008): _layer_is_complete holds layer 0 while a pick is
-- outstanding (the #325 Deferred Forced-Reroll Target pattern), so neither
-- advance_layer nor finalize_layer does anything; both report the noop reason
-- `revolt_pick_pending`. The hold sits before the reaction window opens, so
-- the table sees the pick before deciding whether to counter the card. The
-- app raises advanceRound(revoltPickMade) after the pick. A stalled pick is
-- cleared by resolve_stalled_revolt_picks on the ordinary 5-minute layer-0
-- clock: the cast is negated and stamped `revolt_pick_abandoned`, and the
-- default pick stands; stall then raises stallCleared.
--
-- The resolver, completeness and advancement changes are canonical in
-- db/sql/functions/ and ship in the generated migration that follows this one
-- (ADR 0006). This migration: the catalog effect row, the un-bench, and the
-- new pick functions (defined once, so they live here).
--
-- Migration number: 0128-0130 are #428 (The Last Cuppa) and #451 (the
-- tea-maker selection extraction).

insert into public.spell_card_effects (card_id, target_role, effect_kind, effect_params)
select sc.id, 'TABLE', 'tea_maker_override', '{"mode": "chosen", "picker": "lowest_roller"}'::jsonb
  from public.spell_cards sc
 where sc.name = 'Tea Party Revolt'
   and not exists (
     select 1 from public.spell_card_effects e where e.card_id = sc.id
   );

-- Un-bench Tea Party Revolt. Guarded on location so this is a no-op where 0074
-- never ran; never touches an instance a player currently holds.
update public.spell_deck_instances sdi
   set location = 'in_deck', held_by_player = null
  from public.spell_cards sc
 where sc.id = sdi.card_id
   and sc.name = 'Tea Party Revolt'
   and sdi.location = 'benched';

-- ---------------------------------------------------------------------------
-- _revolt_outstanding_casts(round) -> setof uuid
--
-- The live Tea Party Revolt casts in the round still awaiting their pick: a
-- `picker: lowest_roller` override that isn't negated, names nobody yet, and
-- wasn't abandoned by stall. The one definition of "outstanding" -- the
-- completeness hold, the pick and stall recovery all read it.
-- ---------------------------------------------------------------------------
create or replace function public._revolt_outstanding_casts(p_round_id uuid)
returns setof uuid
language sql
stable
security definer
set search_path = public
as $$
  select id from public.spell_casts
   where round_id = p_round_id
     and effect_kind = 'tea_maker_override'
     and effect_params ->> 'picker' = 'lowest_roller'
     and negated = false
     and target_player_id is null
     and not coalesce(cast_inputs ? 'revolt_pick_abandoned', false);
$$;

revoke execute on function public._revolt_outstanding_casts(uuid) from public, anon, authenticated;
grant execute on function public._revolt_outstanding_casts(uuid) to service_role;

comment on function public._revolt_outstanding_casts(uuid) is
  'Issue #430: ids of the live Tea Party Revolt casts (tea_maker_override, picker lowest_roller) in the round still awaiting their pick -- not negated, no target, not abandoned by stall. Internal.';

-- ---------------------------------------------------------------------------
-- _revolt_pick_outstanding(round) -> boolean
--
-- Whether any Tea Party Revolt pick is outstanding. The layer-0 completeness
-- hold read by _layer_is_complete.
-- ---------------------------------------------------------------------------
create or replace function public._revolt_pick_outstanding(p_round_id uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (select 1 from public._revolt_outstanding_casts(p_round_id));
$$;

revoke execute on function public._revolt_pick_outstanding(uuid) from public, anon, authenticated;
grant execute on function public._revolt_pick_outstanding(uuid) to service_role;

comment on function public._revolt_pick_outstanding(uuid) is
  'Issue #430: whether a live Tea Party Revolt cast in the round still awaits its pick (_revolt_outstanding_casts). The layer-0 completeness hold read by _layer_is_complete. Internal.';

-- ---------------------------------------------------------------------------
-- _revolt_picker(round) -> text
--
-- The Revolt Picker: the lowest raw layer-0 roll, a tie going to the smallest
-- player_id. Null until every expected layer-0 roller has rolled. Raw
-- (pre-shim) values: the pick is made before the reaction window opens, so
-- the roll-input shim -- which uses server dice for forced rerolls and isn't
-- safe to run twice -- hasn't run yet. The picker can therefore differ from
-- the player the default pick would name off the final rolls.
-- ---------------------------------------------------------------------------
create or replace function public._revolt_picker(p_round_id uuid)
returns text
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_picker text;
begin
  if (select count(*) from public.rolls where round_id = p_round_id and layer = 0)
     < public.count_expected_layer_rollers(p_round_id, 0) then
    return null;
  end if;

  select r.player_id into v_picker
    from public.rolls r
   where r.round_id = p_round_id and r.layer = 0
   order by r.value asc, r.player_id asc
   limit 1;

  return v_picker;
end;
$$;

revoke execute on function public._revolt_picker(uuid) from public, anon, authenticated;
grant execute on function public._revolt_picker(uuid) to service_role;

comment on function public._revolt_picker(uuid) is
  'Issue #430: the Tea Party Revolt picker -- the lowest raw layer-0 roller (ties: smallest player_id), or null until every expected layer-0 roller has rolled. Internal.';

-- ---------------------------------------------------------------------------
-- _layer_hold_reason(round, layer) -> text
--
-- The noop reason advance_layer and finalize_layer report for a Layer that
-- isn't complete: `revolt_pick_pending` when layer 0 is rolled but a Tea
-- Party Revolt pick is outstanding, else `layer_incomplete`.
-- ---------------------------------------------------------------------------
create or replace function public._layer_hold_reason(p_round_id uuid, p_layer integer)
returns text
language sql
stable
security definer
set search_path = public
as $$
  select case when p_layer = 0
                   and public._revolt_pick_outstanding(p_round_id)
                   and public._revolt_picker(p_round_id) is not null
              then 'revolt_pick_pending' else 'layer_incomplete' end;
$$;

revoke execute on function public._layer_hold_reason(uuid, integer) from public, anon, authenticated;
grant execute on function public._layer_hold_reason(uuid, integer) to service_role;

comment on function public._layer_hold_reason(uuid, integer) is
  'Issue #430: the noop reason for an incomplete Layer -- revolt_pick_pending (layer 0 rolled, a Tea Party Revolt pick outstanding) or layer_incomplete. Internal to advance_layer / finalize_layer.';

-- ---------------------------------------------------------------------------
-- get_tea_party_revolt_picker(round) -> text
--
-- Who a Tea Party Revolt pick is waiting on right now: the Revolt Picker
-- while a pick is outstanding and layer 0 is rolled, else null. The room page
-- shows the pick prompt to this player only.
-- ---------------------------------------------------------------------------
create or replace function public.get_tea_party_revolt_picker(p_round_id uuid)
returns text
language plpgsql
stable
security definer
set search_path = public
as $$
begin
  if not exists (
    select 1 from public.rounds where id = p_round_id and status = 'closed' and current_layer = 0
  ) or not public._revolt_pick_outstanding(p_round_id) then
    return null;
  end if;

  return public._revolt_picker(p_round_id);
end;
$$;

revoke execute on function public.get_tea_party_revolt_picker(uuid) from public, anon;
grant execute on function public.get_tea_party_revolt_picker(uuid) to authenticated;

comment on function public.get_tea_party_revolt_picker(uuid) is
  'Issue #430: the player a Tea Party Revolt pick is waiting on -- the lowest layer-0 roller (ties: smallest player_id) while the round is closed at layer 0, every expected roller has rolled and a pick is outstanding; otherwise null.';

-- ---------------------------------------------------------------------------
-- set_tea_party_revolt_target(round, target) -> void
--
-- Records the Tea Party Revolt pick. Only the Revolt Picker may call it, once
-- layer 0 is rolled; the target must be a Participant who hasn't been
-- excluded. Fills every outstanding Revolt cast in the round (two Revolts ask
-- the same player the same question). Takes the round row lock, like
-- advance_layer, so a pick can't race stall recovery or a finalization.
-- ---------------------------------------------------------------------------
create or replace function public.set_tea_party_revolt_target(p_round_id uuid, p_target_player_id text)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_status text;
  v_player_id text;
  v_picker text;
begin
  select status into v_status
    from public.rounds
   where id = p_round_id
     for update;

  if v_status is null then
    raise exception 'set_tea_party_revolt_target: round not found';
  end if;

  if v_status <> 'closed' then
    raise exception 'set_tea_party_revolt_target: round is not awaiting a pick'
      using errcode = 'RFB03';
  end if;

  v_player_id := public.current_player_id(p_round_id);

  if not public._revolt_pick_outstanding(p_round_id) then
    raise exception 'set_tea_party_revolt_target: no Tea Party Revolt pick is outstanding';
  end if;

  v_picker := public._revolt_picker(p_round_id);

  if v_picker is null then
    raise exception 'set_tea_party_revolt_target: not everyone has rolled yet';
  end if;

  if v_player_id is distinct from v_picker then
    raise exception 'set_tea_party_revolt_target: only the lowest roller can choose who makes tea';
  end if;

  if not exists (
    select 1 from public.round_participants
     where round_id = p_round_id and player_id = p_target_player_id and excluded_at is null
  ) then
    raise exception 'set_tea_party_revolt_target: target is not a participant in this round';
  end if;

  update public.spell_casts
     set target_player_id = p_target_player_id,
         cast_inputs = coalesce(cast_inputs, '{}'::jsonb)
           || jsonb_build_object('revolt_picked_by', v_player_id)
   where id in (select public._revolt_outstanding_casts(p_round_id));
end;
$$;

revoke execute on function public.set_tea_party_revolt_target(uuid, text) from public, anon;
grant execute on function public.set_tea_party_revolt_target(uuid, text) to authenticated;

comment on function public.set_tea_party_revolt_target(uuid, text) is
  'Issue #430: records the Tea Party Revolt pick -- only the lowest layer-0 roller (ties: smallest player_id) may call it, once every expected roller has rolled; the target must be a non-excluded round participant. Writes target_player_id and cast_inputs.revolt_picked_by onto every outstanding Revolt cast, releasing the layer-0 hold; the caller then raises advanceRound(revoltPickMade).';

-- ---------------------------------------------------------------------------
-- resolve_stalled_revolt_picks(round) -> integer
--
-- Stall recovery, called once enforceStallTimeout's own clock has fired:
-- every outstanding Tea Party Revolt cast is negated and stamped
-- `revolt_pick_abandoned`, so the hold releases and the default pick stands.
-- _rr_select_tea_maker's tier 2 reads the stamp (Phase 1 rewrites `negated` when the
-- round has counters, so the flag alone isn't durable) and leaves a no-op
-- Trace step. Returns how many casts it abandoned.
--
-- Unlike its 0098 sibling it checks the clock itself: any signed-in player
-- can call it, and abandoning the pick early would be a free counter to the
-- card. The bound is 5 minutes since close -- the stall clock
-- (src/lib/game/stallTimeout.ts) never starts before closed_at, so this never
-- refuses a call enforceStallTimeout makes.
-- ---------------------------------------------------------------------------
create or replace function public.resolve_stalled_revolt_picks(p_round_id uuid)
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  v_closed_at timestamptz;
  v_count integer;
begin
  select closed_at into v_closed_at
    from public.rounds
   where id = p_round_id and status = 'closed'
     for update;

  if v_closed_at is null or v_closed_at > now() - interval '5 minutes' then
    return 0;
  end if;

  update public.spell_casts
     set negated = true,
         cast_inputs = coalesce(cast_inputs, '{}'::jsonb)
           || jsonb_build_object('revolt_pick_abandoned', true)
   where id in (select public._revolt_outstanding_casts(p_round_id));

  get diagnostics v_count = row_count;
  return v_count;
end;
$$;

revoke execute on function public.resolve_stalled_revolt_picks(uuid) from public, anon;
grant execute on function public.resolve_stalled_revolt_picks(uuid) to authenticated;

comment on function public.resolve_stalled_revolt_picks(uuid) is
  'Issue #430: stall recovery for a Tea Party Revolt pick never made -- once the round has been closed 5 minutes, negates every outstanding Revolt cast and stamps cast_inputs.revolt_pick_abandoned, so the layer-0 hold releases and the default pick stands. Returns how many casts it abandoned (0 before the 5 minutes are up); the caller raises advanceRound(stallCleared) when it is > 0.';
