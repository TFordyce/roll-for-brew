-- Hold layer-0 resolution while a pre-roll forced_reroll cast still awaits its
-- deferred target (issue #325, a follow-up slice off rebuild/effect-resolver
-- to the incremental data-row fix in PR #324 / migration 0075; ADR 0005 #302).
--
-- Migration number: on rebuild/effect-resolver 0097 is persistent advantage
-- (#320, merged) and 0099 is the targeting-skip slice (#321, in flight), so
-- this sits at 0098. Re-check the number at the integrate step (branching
-- strategy in #303) if the branch has moved again.
--
-- The gap (documented as a KNOWN GAP in 0075:101-117)
-- --------------------------------------------------
-- A pre-roll Action forced_reroll cast (Yorkshire Terror, or a WILD/TABLE
-- fan-out) whose target is not named at cast time defers:
-- target_pending = true, target_player_id = null, reaction_window_id = null.
-- The caster fills it later with set_spell_cast_target, after close_round.
--
--   * Reaction holder present  -> the layer-0 reaction window stays open;
--     whichever of open_reaction_window / set_spell_cast_target resolves the
--     target last runs attach_pre_roll_forced_reroll_casts and the cast rides
--     the normal apply_forced_reroll path. This case already works (PR #324).
--   * Nobody holds a Reaction  -> open_reaction_window closes the window on
--     the spot and layer-0 finalisation (finalizeReactionWindow ->
--     applyLayerOutcome -> resolve_round) runs synchronously on the roll that
--     completes layer 0. The round is `resolved` before the caster can call
--     set_spell_cast_target, which then raises RFB03 ("round is not yet
--     closed for targeting"). The reroll is silently lost and the caster is
--     left holding an un-completable cast (its card instance was discarded at
--     cast time).
--
-- The fix
-- -------
-- Layer 0 is not "complete" while an un-negated, not-yet-window-attached
-- (reaction_window_id is null -- i.e. pre-roll) forced_reroll cast for the
-- round still has target_pending = true -- the same gate shape the pending
-- dice_modifier cast (issue #252) already uses in these two functions.
-- resolveCompletedLayerIfAny / finalizeReactionWindow both no-op until the
-- caster names the target; set_spell_cast_target then still sees a `closed`
-- round (no RFB03) and the app re-enters layer resolution
-- (afterDeferredCastTargetSet, src/app/rounds/roundActionHelpers.ts), which
-- opens the window for the first time -- open_reaction_window's own
-- attach_pre_roll_forced_reroll_casts now picks the (no-longer-pending) cast
-- up, and the nobody-holds-a-Reaction path reaches the same end state as the
-- reaction-window-stays-open path.
--
-- resolve_round itself is unchanged: once the target is set and the window
-- finalises, apply_forced_reroll records the before->after into
-- cast_inputs.roll_transform and Phase 3 adopts it exactly as for a
-- non-deferred forced_reroll. The hold lives entirely in the completeness
-- gate, mirroring the pending-die gate -- no new precondition inside
-- resolve_round, no re-emit of that 1600-line function in a follow-up slice.
--
-- Terminal outcome for a never-resolvable target
-- ----------------------------------------------
-- If the caster never names a target (the intended player genuinely never
-- joins and the caster picks no one), the existing 5-minute closed-round
-- stall timer -- not a new clock -- force-negates the outstanding cast via
-- resolve_stalled_pending_forced_reroll_casts below: the cast becomes a
-- recorded no-op (negated = true, target_pending = false, cast_inputs stamped
-- deferred_target_abandoned) with no roll_transform, so resolve_round Phase 3
-- skips it and the round resolves off the un-rerolled rolls. Same recovery
-- shape as resolve_stalled_pending_spell_dice (0069/0083).

-- ---------------------------------------------------------------------------
-- get_current_layer_rolls_if_complete -- re-emitted from 0079 with a second
-- layer-0 gate: an un-negated forced_reroll cast still awaiting its deferred
-- target. Signature and every other line are identical to 0079.
-- ---------------------------------------------------------------------------
create or replace function public.get_current_layer_rolls_if_complete(p_round_id uuid)
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

  if v_layer = 0 and exists (
    select 1 from public.spell_casts
     where round_id = p_round_id and effect_kind = 'dice_modifier'
       and not coalesce(cast_inputs ? 'dice_roll', false)
  ) then
    return;
  end if;

  -- Issue #325: layer 0 also isn't "complete" while a pre-roll forced_reroll
  -- cast is still awaiting its deferred target. Resolving now would drop the
  -- reroll -- the cast never attaches to a reaction window, never reaches
  -- apply_forced_reroll, and so never records a cast_inputs.roll_transform
  -- for resolve_round Phase 3 to adopt. Cleared either by the caster naming
  -- the target (set_spell_cast_target) or, on a never-resolvable target, by
  -- resolve_stalled_pending_forced_reroll_casts once the stall timer fires.
  if v_layer = 0 and exists (
    select 1 from public.spell_casts
     where round_id = p_round_id
       and effect_kind = 'forced_reroll'
       and target_pending = true
       and negated = false
       and reaction_window_id is null
  ) then
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

-- ---------------------------------------------------------------------------
-- get_completed_layer_rolls_for_stall_resolution -- the stall-timeout
-- counterpart, same second gate. Re-emitted from 0079.
-- ---------------------------------------------------------------------------
create or replace function public.get_completed_layer_rolls_for_stall_resolution(p_round_id uuid)
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

  if v_layer = 0 and exists (
    select 1 from public.spell_casts
     where round_id = p_round_id and effect_kind = 'dice_modifier'
       and not coalesce(cast_inputs ? 'dice_roll', false)
  ) then
    return;
  end if;

  -- Issue #325: see get_current_layer_rolls_if_complete above.
  if v_layer = 0 and exists (
    select 1 from public.spell_casts
     where round_id = p_round_id
       and effect_kind = 'forced_reroll'
       and target_pending = true
       and negated = false
       and reaction_window_id is null
  ) then
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

-- ---------------------------------------------------------------------------
-- resolve_stalled_pending_forced_reroll_casts -- the terminal no-op for a
-- deferred forced_reroll target the caster never resolves. Sibling of
-- resolve_stalled_pending_spell_dice (0069/0083): grantable to any
-- authenticated caller, does no timing check of its own -- called only from
-- enforceStallTimeout (src/app/rounds/stallEnforcement.ts) after its own
-- hasStalled check has already fired. Force-negates every still-pending
-- forced_reroll cast for the round and clears its pending flag, so the
-- layer-0 gate above lets the round resolve. cast_inputs is stamped
-- deferred_target_abandoned as the durable record of why the reroll never
-- landed; with no roll_transform key, resolve_round Phase 3 skips the row.
-- Returns how many casts it negated, so the caller only re-runs layer
-- resolution when there was something to recover.
-- ---------------------------------------------------------------------------
create or replace function public.resolve_stalled_pending_forced_reroll_casts(p_round_id uuid)
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  v_count integer;
begin
  update public.spell_casts
     set negated = true,
         target_pending = false,
         cast_inputs = coalesce(cast_inputs, '{}'::jsonb)
           || jsonb_build_object('deferred_target_abandoned', true)
   where round_id = p_round_id
     and effect_kind = 'forced_reroll'
     and target_pending = true
     and negated = false
     and reaction_window_id is null;

  get diagnostics v_count = row_count;
  return v_count;
end;
$$;

revoke execute on function public.resolve_stalled_pending_forced_reroll_casts(uuid) from public, anon;
grant execute on function public.resolve_stalled_pending_forced_reroll_casts(uuid) to authenticated;
