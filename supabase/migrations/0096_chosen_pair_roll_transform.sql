-- Chosen-pair roll transform: swap / set-both-lower / set-both-higher over a
-- caster-named pair of players (issue #318, Tier A primitive 2 of the
-- effect-application rebuild #302 / ADR 0005 §12). Generalises roll_swap past
-- the automatic highest<->lowest pick to an explicit pair the caster names.
--
-- Cards un-benched by this slice (all four have zero spell_card_effects rows,
-- so each is a by-name branch in the cast RPC -- the Yorkshire Terror /
-- Bes-Tea / Chai-nge of Heart pattern):
--
--   * Brew-tal Swap       (Reaction, OPPONENT) -- swap the caster's d20 with
--                          the target's.
--   * Stir the Pot        (Action, OPPONENT)   -- two OTHER players (never the
--                          caster) swap their d20s.
--   * Steaming Mug Bond   (Action, OPPONENT)   -- caster + target both count
--                          as the LOWER of their two d20s.
--   * Tea for Two         (Action, PLAYER)     -- caster + target both count
--                          as the HIGHER of their two d20s.
--
-- Representation
-- --------------
-- One new effect_kind, `roll_pair_transform`, with effect_params:
--   { "op": "swap" | "min" | "max" }
-- and cast_inputs.pair = [<player_id>, <player_id>] recorded at cast time (an
-- unreconstructable human choice, spec §4). It is an eager-shim roll-INPUT
-- kind, resolution order 5 -- after roll_swap (order 4), "flip before swap
-- before chosen-pair" for the vanishingly rare player hit by more than one.
--
-- New RPC `apply_roll_pair_transform(uuid, integer)` runs at reaction-window
-- finalize (TS finalizeReactionWindow, after apply_roll_swap), per cast:
--   * derive the pair from cast_inputs.pair, read both current rolls.value;
--   * op = swap -> exchange; min -> both take least(a,b); max -> both take
--     greatest(a,b);
--   * roll-domain ward pre-check per end (spec §2/§7): swap -> the losing end
--     is negative and the gaining end positive; min -> the strictly-higher end
--     is negative (the other unchanged); max -> the strictly-lower end is
--     positive (the other unchanged). If EITHER end carries a matching
--     earlier-seq roll-domain ward the whole transform is cancelled -- no
--     mutation, a half-transform cannot conserve values (same rule as
--     apply_roll_swap);
--   * mutate rolls.value in place (RoundReveal / history / broadcast read it)
--     AND record the exact per-player before->after into
--     cast_inputs.roll_transform, warded ends carrying warded/would_be_after/
--     ward_cast_id/ward_card_name with after == before.
--
-- resolve_round Phase 3 adopts the recorded values with no computation (its
-- effect_kind filter grows `roll_pair_transform`), emits one Resolution Trace
-- step per affected player with typed before->after roll values and the op in
-- a 7-arg extra, and honours the recorded `warded` marker exactly as it does
-- for roll_swap. The eager-roll-kind lists in resolve_round Phase 0a (copy
-- materialisation) and the seize `keepable` test also grow the new kind so a
-- Saucerer's Apprentice copy of a chosen-pair cast is a zero-impact step and a
-- Brew-merang seize of one unwinds it (consistent with roll_swap, #316).
-- _rr_build_copy_inputs is deliberately NOT changed: with no synthesised
-- roll_transform the copied row simply carries none and Phase 3 skips it.
--
-- Pre-roll attach: Stir the Pot / Steaming Mug Bond / Tea for Two are Action
-- casts, so like the pre-roll forced_reroll path (#286, migration 0075) their
-- rows have reaction_window_id = null until the layer-0 window opens. A
-- sibling helper attach_pre_roll_roll_pair_transform_casts is called from
-- open_reaction_window (re-emitted from 0075) right after the forced_reroll
-- one. No deferred-target path in this slice: the three Action cards require an
-- explicit target at cast time (RFB46), matching Bes-Tea / Chai-nge of Heart.
--
-- Client target pickers (a two-other-players picker for Stir the Pot, an
-- at-cast target select for Steaming Mug Bond / Tea for Two) are NOT wired in
-- CastForm here -- the same follow-up gap the sibling by-name slices (#316,
-- #342, #343) carry. Server-side pair-rule enforcement is complete. Tracked as
-- a follow-up issue.
--
-- Migration numbering: master's highest is 0077; rebuild/effect-resolver runs
-- 0078-0095. This is 0096, renumbered from a first-cut 0094 after both sibling
-- Tier A slices merged ahead of it -- #317 (fixed_roll) took 0094 and #319
-- (conditional advantage) took 0095. Because all three re-emit shared function
-- bodies and this migration replays last, it carries the UNION of their edits:
--   * §2b re-emits submit_roll / submit_roll_as with BOTH #319's
--     conditional-advantage branch and #317's _rr_apply_fixed_roll shim call
--     (0095 had dropped the latter -- see that section's header);
--   * §2 keeps `fixed_roll` in the effect_kind CHECK lists (this drop/re-add
--     runs after 0094 and would otherwise strip it);
--   * §8 re-emits resolve_round from 0095's body with `fixed_roll` (#317) and
--     `roll_pair_transform` (#318) both added to Phase 3's kind filter.
-- This is the #303 integrate-gate reconciliation done early so the branch is
-- release-clean; the gate should still re-verify the numbering.

-- ---------------------------------------------------------------------------
-- 1. Un-bench the four cards (migration 0074 parked them at 'benched').
--    Guarded on location so this is a no-op if 0074 never ran; never touches
--    an instance a player currently holds.
-- ---------------------------------------------------------------------------
update public.spell_deck_instances sdi
   set location = 'in_deck', held_by_player = null
  from public.spell_cards sc
 where sc.id = sdi.card_id
   and sc.name in ('Brew-tal Swap', 'Stir the Pot', 'Steaming Mug Bond', 'Tea for Two')
   and sdi.location = 'benched';

-- ---------------------------------------------------------------------------
-- 2. effect_kind CHECK constraints -- add `roll_pair_transform`.
--    spell_card_effects gets it too (future-proofing / mirrors spec §15 which
--    widens all constraints together) even though these four cards carry no
--    effect rows this slice. spell_active_effects does NOT: a chosen-pair
--    transform is round-scoped, never promoted to a persistent effect.
--    `fixed_roll` (sibling #317, migration 0094) is carried in the list too --
--    this drop/re-add runs after 0094 and would otherwise strip it.
-- ---------------------------------------------------------------------------
alter table public.spell_card_effects drop constraint spell_card_effects_effect_kind_check;
alter table public.spell_card_effects add constraint spell_card_effects_effect_kind_check
  check (effect_kind in (
    'flat_modifier', 'dice_modifier', 'modifier_multiplier', 'set_modifier',
    'advantage', 'disadvantage', 'dispel',
    'forced_reroll', 'contested_negate', 'redirect',
    'reset_persistent_modifier',
    'roll_swap', 'roll_flip', 'fixed_roll', 'roll_pair_transform', 'lowest_gains_highest_modifier',
    'tea_maker_override', 'declared_number_tea_maker', 'wild_dispatch',
    'ward', 'persistent_modifier_transfer', 'persistent_modifier_spend',
    'round_replay', 'draw_redirect'
  ));

alter table public.spell_casts drop constraint spell_casts_effect_kind_check;
alter table public.spell_casts add constraint spell_casts_effect_kind_check
  check (effect_kind is null or effect_kind in (
    'flat_modifier', 'dice_modifier', 'modifier_multiplier', 'set_modifier',
    'advantage', 'disadvantage', 'dispel',
    'forced_reroll', 'contested_negate', 'redirect',
    'reset_persistent_modifier',
    'roll_swap', 'roll_flip', 'fixed_roll', 'roll_pair_transform', 'lowest_gains_highest_modifier',
    'tea_maker_override', 'declared_number_tea_maker', 'wild_dispatch',
    'ward', 'persistent_modifier_transfer', 'persistent_modifier_spend',
    'round_replay', 'draw_redirect'
  ));

-- 2a. _rr_apply_fixed_roll -- re-emitted from 0094 (#317) with a merge fix:
--     v_ward is now seeded to a NULL row before the ward-gate lookup so the
--     later UPDATE's v_ward.* field refs are always valid (PL/pgSQL rejects
--     a field ref on a never-assigned record at plan time, even in the
--     untaken CASE branch, when the gate returns no row).
-- ---------------------------------------------------------------------------
create or replace function public._rr_apply_fixed_roll(
  p_round_id uuid, p_player_id text, p_layer integer,
  p_room_id uuid, p_rolled_value integer
)
returns table (value integer, applied boolean)
language plpgsql
security definer
set search_path = public
as $$
declare
  v_fixed_value integer;
  v_before_seq bigint;
  v_polarity text;
  v_warded boolean := false;
  v_ward record;
begin
  if p_layer <> 0 then
    return query select p_rolled_value, false;
    return;
  end if;

  select (sc.effect_params ->> 'value')::integer, sc.seq
    into v_fixed_value, v_before_seq
    from public.spell_casts sc
   where sc.round_id = p_round_id
     and sc.target_player_id = p_player_id
     and sc.target_pending = false
     and sc.effect_kind = 'fixed_roll'
     and sc.negated = false            -- pre-resolve invariant; negation is
   order by sc.seq                     -- resolver-written (Phase 1)
   limit 1;

  if v_fixed_value is null then
    return query select p_rolled_value, false;
    return;
  end if;

  -- Polarity of the fix vs what the player actually rolled, mirroring
  -- roll_flip's "computed from the actual pre-value" (spec section 7). A
  -- neutral fix (constant == roll) is never warded.
  v_polarity := case
    when v_fixed_value > p_rolled_value then 'positive'
    when v_fixed_value < p_rolled_value then 'negative'
    else 'neutral' end;

  -- issue #318 merge fix: v_ward must be assigned before the UPDATE below
  -- references v_ward.* -- PL/pgSQL rejects a field ref on a never-assigned
  -- record at plan time even inside the untaken CASE branch. A no-row gate
  -- result otherwise leaves it unassigned.
  select null::uuid as ward_cast_id, null::text as ward_card_name into v_ward;
  if v_polarity <> 'neutral' then
    select g.ward_cast_id, g.ward_card_name into v_ward
      from public._rr_active_ward_gate(
        p_room_id, p_player_id, 'roll', v_polarity, p_round_id, v_before_seq) g;
    v_warded := found;
  end if;

  update public.spell_casts casts
     set cast_inputs = coalesce(casts.cast_inputs, '{}'::jsonb) || jsonb_build_object(
           'roll_transform', jsonb_build_object(
             'kind', 'fixed_roll',
             'order', 0,
             'players', jsonb_build_array(
               case when v_warded then jsonb_build_object(
                 'player_id', p_player_id,
                 'before', p_rolled_value,
                 'after', p_rolled_value,
                 'warded', true,
                 'would_be_after', v_fixed_value,
                 'ward_cast_id', v_ward.ward_cast_id,
                 'ward_card_name', v_ward.ward_card_name
               ) else jsonb_build_object(
                 'player_id', p_player_id,
                 'before', p_rolled_value,
                 'after', v_fixed_value
               ) end
             )
           ))
   where casts.round_id = p_round_id
     and casts.target_player_id = p_player_id
     and casts.target_pending = false
     and casts.effect_kind = 'fixed_roll'
     and casts.negated = false;

  if v_warded then
    return query select p_rolled_value, false;
  else
    return query select v_fixed_value, true;
  end if;
end;
$$;

revoke execute on function public._rr_apply_fixed_roll(uuid, text, integer, uuid, integer) from public, anon;
grant execute on function public._rr_apply_fixed_roll(uuid, text, integer, uuid, integer) to authenticated;

-- ---------------------------------------------------------------------------
-- 2b. submit_roll / submit_roll_as -- re-emitted as the UNION of sibling
--     slices #317 (fixed_roll, migration 0094) and #319 (conditional
--     advantage, migration 0095). Both re-emitted these two from 0079 and
--     0095 (numerically later, so last to win at replay) dropped #317's
--     _rr_apply_fixed_roll hook. This 0096 body carries BOTH: the #319
--     conditional-advantage branch AND the #317 fixed-roll shim call, the
--     latter guarding the second-draw and roll-transform-recording blocks
--     on `not v_fixed_applied` (a fixed die has nothing to take advantage
--     on). Reconciles at the #303 integrate gate; emitted here so this
--     branch is release-clean.
-- ---------------------------------------------------------------------------
create or replace function public.submit_roll(p_round_id uuid)
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  v_player_id text;
  v_status text;
  v_room_id uuid;
  v_layer integer;
  v_modifier integer;
  v_value integer;
  v_first_value integer;
  v_second_value integer;
  v_discarded_value integer;
  v_has_advantage boolean;      -- a PLAIN advantage cast (no condition)
  v_has_disadvantage boolean;
  v_condition jsonb;            -- effect_params.condition of a conditional cast
  v_cond_branch text;          -- 'advantage' | 'disadvantage' | 'none' | null
  v_cond_adv_at integer;
  v_cond_dis_at integer;
  v_eff_advantage boolean;     -- plain OR condition-selected advantage
  v_eff_disadvantage boolean;
  v_cancelled boolean;
  v_dice jsonb;
  v_fixed_applied boolean := false;   -- issue #317
begin
  v_player_id := public.current_player_id(p_round_id);

  select status, room_id, current_layer into v_status, v_room_id, v_layer
    from public.rounds
   where id = p_round_id;

  if v_status is null then
    raise exception 'submit_roll: round not found';
  end if;

  if v_status <> 'closed' then
    raise exception 'submit_roll: round is not closed for rolling'
      using errcode = 'RFB01';
  end if;

  if not public.is_expected_layer_roller(p_round_id, v_player_id, v_layer) then
    raise exception 'submit_roll: caller is not expected to roll in the current layer'
      using errcode = 'RFB02';
  end if;

  select modifier into v_modifier
    from public.room_players
   where room_id = v_room_id and player_id = v_player_id;
  v_modifier := coalesce(v_modifier, 0);

  -- Plain (unconditional) advantage / disadvantage casts. The `? 'condition'`
  -- exclusion is on the advantage side only: a conditional cast is always
  -- effect_kind 'advantage' (Gambler's Infusion; there is no conditional
  -- disadvantage card), so the disadvantage probe needs no matching guard.
  v_has_advantage := v_layer = 0 and exists (
    select 1 from public.spell_casts
     where round_id = p_round_id and target_player_id = v_player_id
       and target_pending = false and effect_kind = 'advantage'
       and not (coalesce(effect_params, '{}'::jsonb) ? 'condition')
  );
  v_has_disadvantage := v_layer = 0 and exists (
    select 1 from public.spell_casts
     where round_id = p_round_id and target_player_id = v_player_id
       and target_pending = false and effect_kind = 'disadvantage'
  );

  if v_layer = 0 then
    select casts.effect_params -> 'condition'
      into v_condition
      from public.spell_casts casts
     where casts.round_id = p_round_id and casts.target_player_id = v_player_id
       and casts.target_pending = false and casts.effect_kind = 'advantage'
       and casts.effect_params ? 'condition'
     limit 1;
  end if;

  v_value := floor(random() * 20 + 1)::integer;
  v_first_value := v_value;
  v_discarded_value := null;

  -- issue #317: fixed-roll shim. Records the before->after (order 0) and
  -- returns the constant die; a roll-domain ward instead records a `warded`
  -- marker and returns v_first_value with applied = false. A fixed die has
  -- nothing to take advantage / disadvantage on, so the blocks below are
  -- all guarded on `not v_fixed_applied`.
  select f.value, f.applied into v_value, v_fixed_applied
    from public._rr_apply_fixed_roll(p_round_id, v_player_id, v_layer, v_room_id, v_first_value) f;

  v_cond_branch := null;
  if v_condition is not null then
    v_cond_adv_at := coalesce((v_condition ->> 'advantage_at_or_above')::integer, 15);
    v_cond_dis_at := coalesce((v_condition ->> 'disadvantage_at_or_below')::integer, 5);
    if v_first_value >= v_cond_adv_at then
      v_cond_branch := 'advantage';
    elsif v_first_value <= v_cond_dis_at then
      v_cond_branch := 'disadvantage';
    else
      v_cond_branch := 'none';
    end if;
  end if;

  v_eff_advantage := v_has_advantage or v_cond_branch is not distinct from 'advantage';
  v_eff_disadvantage := v_has_disadvantage or v_cond_branch is not distinct from 'disadvantage';
  v_cancelled := v_eff_advantage and v_eff_disadvantage;

  if not v_fixed_applied and v_eff_advantage <> v_eff_disadvantage then
    v_second_value := floor(random() * 20 + 1)::integer;
    if v_eff_advantage then
      v_discarded_value := least(v_value, v_second_value);
      v_value := greatest(v_value, v_second_value);
    else
      v_discarded_value := greatest(v_value, v_second_value);
      v_value := least(v_value, v_second_value);
    end if;
  end if;

  insert into public.rolls (round_id, player_id, layer, value, input_mode, modifier_snapshot, discarded_value)
  values (p_round_id, v_player_id, v_layer, v_value, 'in_app', v_modifier, v_discarded_value);

  -- Record the roll transform onto the advantage / disadvantage cast(s).
  if not v_fixed_applied and (v_eff_advantage or v_eff_disadvantage or v_condition is not null) then
    if v_cancelled or v_second_value is null then
      v_dice := jsonb_build_array(v_first_value);
    else
      v_dice := jsonb_build_array(v_first_value, v_second_value);
    end if;

    -- Plain advantage / disadvantage casts (Sugar Rush, Slipped Spoon, ...).
    update public.spell_casts casts
       set cast_inputs = coalesce(casts.cast_inputs, '{}'::jsonb) || jsonb_build_object(
             'roll_transform', jsonb_build_object(
               'kind', casts.effect_kind,
               'order', 1,
               'cancelled', v_cancelled,
               'dice', v_dice,
               'players', jsonb_build_array(jsonb_build_object(
                 'player_id', v_player_id,
                 'before', v_first_value,
                 'after', v_value
               ))
             ))
     where casts.round_id = p_round_id
       and casts.target_player_id = v_player_id
       and casts.target_pending = false
       and casts.effect_kind in ('advantage', 'disadvantage')
       and not (coalesce(casts.effect_params, '{}'::jsonb) ? 'condition');

    -- Conditional advantage cast (Gambler's Infusion): same shape plus the
    -- `condition` object naming the branch the first die selected.
    if v_condition is not null then
      update public.spell_casts casts
         set cast_inputs = coalesce(casts.cast_inputs, '{}'::jsonb) || jsonb_build_object(
               'roll_transform', jsonb_build_object(
                 'kind', 'advantage',
                 'order', 1,
                 'cancelled', v_cancelled,
                 'condition', jsonb_build_object(
                   'first_die', v_first_value,
                   'branch', v_cond_branch,
                   'advantage_at_or_above', v_cond_adv_at,
                   'disadvantage_at_or_below', v_cond_dis_at
                 ),
                 'dice', v_dice,
                 'players', jsonb_build_array(jsonb_build_object(
                   'player_id', v_player_id,
                   'before', v_first_value,
                   'after', v_value
                 ))
               ))
       where casts.round_id = p_round_id
         and casts.target_player_id = v_player_id
         and casts.target_pending = false
         and casts.effect_kind = 'advantage'
         and casts.effect_params ? 'condition';
    end if;
  end if;

  return v_value;
end;
$$;

revoke execute on function public.submit_roll(uuid) from public, anon;
grant execute on function public.submit_roll(uuid) to authenticated;

create or replace function public.submit_roll_as(p_round_id uuid, p_player_id text)
returns integer
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
  v_value integer;
  v_first_value integer;
  v_second_value integer;
  v_discarded_value integer;
  v_has_advantage boolean;
  v_has_disadvantage boolean;
  v_condition jsonb;
  v_cond_branch text;
  v_cond_adv_at integer;
  v_cond_dis_at integer;
  v_eff_advantage boolean;
  v_eff_disadvantage boolean;
  v_cancelled boolean;
  v_dice jsonb;
  v_fixed_applied boolean := false;   -- issue #317
begin
  v_caller := public.current_player_id();

  select is_admin into v_is_admin from public.players where id = v_caller;
  if not coalesce(v_is_admin, false) then
    raise exception 'submit_roll_as: caller is not an admin';
  end if;

  select status, room_id, current_layer into v_status, v_room_id, v_layer
    from public.rounds
   where id = p_round_id;

  if v_status is null then
    raise exception 'submit_roll_as: round not found';
  end if;

  if not exists (select 1 from public.rooms where id = v_room_id and is_test) then
    raise exception 'submit_roll_as: round is not in the Test Room';
  end if;

  if v_status <> 'closed' then
    raise exception 'submit_roll_as: round is not closed for rolling'
      using errcode = 'RFB01';
  end if;

  if not public.is_expected_layer_roller(p_round_id, p_player_id, v_layer) then
    raise exception 'submit_roll_as: target player is not expected to roll in the current layer'
      using errcode = 'RFB02';
  end if;

  select modifier into v_modifier
    from public.room_players
   where room_id = v_room_id and player_id = p_player_id;
  v_modifier := coalesce(v_modifier, 0);

  v_has_advantage := v_layer = 0 and exists (
    select 1 from public.spell_casts
     where round_id = p_round_id and target_player_id = p_player_id
       and target_pending = false and effect_kind = 'advantage'
       and not (coalesce(effect_params, '{}'::jsonb) ? 'condition')
  );
  v_has_disadvantage := v_layer = 0 and exists (
    select 1 from public.spell_casts
     where round_id = p_round_id and target_player_id = p_player_id
       and target_pending = false and effect_kind = 'disadvantage'
  );

  if v_layer = 0 then
    select casts.effect_params -> 'condition'
      into v_condition
      from public.spell_casts casts
     where casts.round_id = p_round_id and casts.target_player_id = p_player_id
       and casts.target_pending = false and casts.effect_kind = 'advantage'
       and casts.effect_params ? 'condition'
     limit 1;
  end if;

  v_value := floor(random() * 20 + 1)::integer;
  v_first_value := v_value;
  v_discarded_value := null;

  -- issue #317: fixed-roll shim. Records the before->after (order 0) and
  -- returns the constant die; a roll-domain ward instead records a `warded`
  -- marker and returns v_first_value with applied = false. A fixed die has
  -- nothing to take advantage / disadvantage on, so the blocks below are
  -- all guarded on `not v_fixed_applied`.
  select f.value, f.applied into v_value, v_fixed_applied
    from public._rr_apply_fixed_roll(p_round_id, p_player_id, v_layer, v_room_id, v_first_value) f;

  v_cond_branch := null;
  if v_condition is not null then
    v_cond_adv_at := coalesce((v_condition ->> 'advantage_at_or_above')::integer, 15);
    v_cond_dis_at := coalesce((v_condition ->> 'disadvantage_at_or_below')::integer, 5);
    if v_first_value >= v_cond_adv_at then
      v_cond_branch := 'advantage';
    elsif v_first_value <= v_cond_dis_at then
      v_cond_branch := 'disadvantage';
    else
      v_cond_branch := 'none';
    end if;
  end if;

  v_eff_advantage := v_has_advantage or v_cond_branch is not distinct from 'advantage';
  v_eff_disadvantage := v_has_disadvantage or v_cond_branch is not distinct from 'disadvantage';
  v_cancelled := v_eff_advantage and v_eff_disadvantage;

  if not v_fixed_applied and v_eff_advantage <> v_eff_disadvantage then
    v_second_value := floor(random() * 20 + 1)::integer;
    if v_eff_advantage then
      v_discarded_value := least(v_value, v_second_value);
      v_value := greatest(v_value, v_second_value);
    else
      v_discarded_value := greatest(v_value, v_second_value);
      v_value := least(v_value, v_second_value);
    end if;
  end if;

  insert into public.rolls (round_id, player_id, layer, value, input_mode, modifier_snapshot, discarded_value)
  values (p_round_id, p_player_id, v_layer, v_value, 'in_app', v_modifier, v_discarded_value);

  if not v_fixed_applied and (v_eff_advantage or v_eff_disadvantage or v_condition is not null) then
    if v_cancelled or v_second_value is null then
      v_dice := jsonb_build_array(v_first_value);
    else
      v_dice := jsonb_build_array(v_first_value, v_second_value);
    end if;

    update public.spell_casts casts
       set cast_inputs = coalesce(casts.cast_inputs, '{}'::jsonb) || jsonb_build_object(
             'roll_transform', jsonb_build_object(
               'kind', casts.effect_kind,
               'order', 1,
               'cancelled', v_cancelled,
               'dice', v_dice,
               'players', jsonb_build_array(jsonb_build_object(
                 'player_id', p_player_id,
                 'before', v_first_value,
                 'after', v_value
               ))
             ))
     where casts.round_id = p_round_id
       and casts.target_player_id = p_player_id
       and casts.target_pending = false
       and casts.effect_kind in ('advantage', 'disadvantage')
       and not (coalesce(casts.effect_params, '{}'::jsonb) ? 'condition');

    if v_condition is not null then
      update public.spell_casts casts
         set cast_inputs = coalesce(casts.cast_inputs, '{}'::jsonb) || jsonb_build_object(
               'roll_transform', jsonb_build_object(
                 'kind', 'advantage',
                 'order', 1,
                 'cancelled', v_cancelled,
                 'condition', jsonb_build_object(
                   'first_die', v_first_value,
                   'branch', v_cond_branch,
                   'advantage_at_or_above', v_cond_adv_at,
                   'disadvantage_at_or_below', v_cond_dis_at
                 ),
                 'dice', v_dice,
                 'players', jsonb_build_array(jsonb_build_object(
                   'player_id', p_player_id,
                   'before', v_first_value,
                   'after', v_value
                 ))
               ))
       where casts.round_id = p_round_id
         and casts.target_player_id = p_player_id
         and casts.target_pending = false
         and casts.effect_kind = 'advantage'
         and casts.effect_params ? 'condition';
    end if;
  end if;

  return v_value;
end;
$$;

revoke execute on function public.submit_roll_as(uuid, text) from public, anon;
grant execute on function public.submit_roll_as(uuid, text) to authenticated;

-- ---------------------------------------------------------------------------
-- 3. attach_pre_roll_roll_pair_transform_casts -- sibling of
--    attach_pre_roll_forced_reroll_casts (0075). Attaches every still-
--    unattached, non-pending, non-negated layer-0 roll_pair_transform cast to
--    the window passed in, so has_active_cast_kind / apply_roll_pair_transform
--    (both scoped through spell_reaction_windows) can see the pre-roll Action
--    casts. A Reaction Brew-tal Swap already carries its own
--    reaction_window_id and is excluded by the null check.
-- ---------------------------------------------------------------------------
create or replace function public.attach_pre_roll_roll_pair_transform_casts(
  p_round_id uuid, p_window_id uuid
)
returns void
language sql
security definer
set search_path = public
as $$
  update public.spell_casts
     set reaction_window_id = p_window_id
   where round_id = p_round_id
     and effect_kind = 'roll_pair_transform'
     and reaction_window_id is null
     and target_pending = false
     and negated = false;
$$;

revoke execute on function public.attach_pre_roll_roll_pair_transform_casts(uuid, uuid) from public, anon;
grant execute on function public.attach_pre_roll_roll_pair_transform_casts(uuid, uuid) to authenticated;

-- ---------------------------------------------------------------------------
-- 4. open_reaction_window -- re-emitted from 0075 to also attach pre-roll
--    roll_pair_transform casts to the layer-0 window it opens. Only the one
--    added `perform` line differs from 0075.
-- ---------------------------------------------------------------------------
create or replace function public.open_reaction_window(p_round_id uuid, p_layer integer)
returns table (window_id uuid, is_closed boolean)
language plpgsql
security definer
set search_path = public
as $$
declare
  v_window_id uuid;
  v_eligible_count integer;
begin
  if not exists (select 1 from public.rounds where id = p_round_id) then
    raise exception 'open_reaction_window: round not found';
  end if;

  insert into public.spell_reaction_windows (round_id, layer)
  values (p_round_id, p_layer)
  returning id into v_window_id;

  if p_layer = 0 then
    perform public.attach_pre_roll_forced_reroll_casts(p_round_id, v_window_id);
    perform public.attach_pre_roll_roll_pair_transform_casts(p_round_id, v_window_id);
  end if;

  v_eligible_count := public.count_eligible_reaction_holders(p_round_id);

  if v_eligible_count = 0 then
    perform public.close_reaction_window(v_window_id);
  end if;

  window_id := v_window_id;
  is_closed := v_eligible_count = 0;
  return next;
end;
$$;

revoke execute on function public.open_reaction_window(uuid, integer) from public, anon;
grant execute on function public.open_reaction_window(uuid, integer) to authenticated;
grant execute on function public.open_reaction_window(uuid, integer) to service_role;

-- ---------------------------------------------------------------------------
-- 5. apply_roll_pair_transform(uuid, integer) -- the chosen-pair eager shim.
--    Per un-negated roll_pair_transform cast attached to the (round, layer)
--    window: derive the pair, compute the op, ward pre-check per end, mutate
--    rolls.value unless warded, and stamp cast_inputs.roll_transform. Returns
--    every roll in the layer (like apply_roll_swap / apply_roll_flip) so the
--    TS caller can patch its in-memory copy for the reveal broadcast.
-- ---------------------------------------------------------------------------
create or replace function public.apply_roll_pair_transform(p_round_id uuid, p_layer integer)
returns table (player_id text, value integer)
language plpgsql
security definer
set search_path = public
as $$
declare
  v_room_id uuid;
  v_cast record;
  v_op text;
  v_a_player text;
  v_b_player text;
  v_a_value integer;
  v_b_value integer;
  v_a_after integer;
  v_b_after integer;
  v_a_pol text;
  v_b_pol text;
  v_ward record;
  v_warded boolean;
  v_ward_cast_id uuid;
  v_ward_card_name text;
begin
  select room_id into v_room_id from public.rounds where id = p_round_id;

  for v_cast in
    select casts.id,
           casts.seq,
           casts.effect_params ->> 'op' as op,
           casts.cast_inputs -> 'pair' ->> 0 as pair_a,
           casts.cast_inputs -> 'pair' ->> 1 as pair_b
      from public.spell_casts casts
      join public.spell_reaction_windows w on w.id = casts.reaction_window_id
     where w.round_id = p_round_id and w.layer = p_layer
       and casts.effect_kind = 'roll_pair_transform'
       and casts.negated = false
     order by casts.seq
  loop
    v_op := coalesce(v_cast.op, 'swap');
    v_a_player := v_cast.pair_a;
    v_b_player := v_cast.pair_b;

    v_a_value := null;
    v_b_value := null;
    if v_a_player is not null then
      select r.value into v_a_value
        from public.rolls r
       where r.round_id = p_round_id and r.layer = p_layer and r.player_id = v_a_player;
    end if;
    if v_b_player is not null then
      select r.value into v_b_value
        from public.rolls r
       where r.round_id = p_round_id and r.layer = p_layer and r.player_id = v_b_player;
    end if;

    -- Degenerate cast: the pair is not two distinct players who both rolled.
    -- Unreachable from the cast_spell_card / cast_reaction_spell_card by-name
    -- branches (they validate the pair against the round roster, and every
    -- participant rolls) -- handled defensively. Record an empty transform so
    -- the cast still appears in the Cast Log; Phase 3 emits nothing for it.
    if v_a_player is null or v_b_player is null or v_a_player = v_b_player
       or v_a_value is null or v_b_value is null then
      update public.spell_casts
         set cast_inputs = coalesce(cast_inputs, '{}'::jsonb) || jsonb_build_object(
               'roll_transform', jsonb_build_object(
                 'kind', 'roll_pair_transform', 'order', 5, 'op', v_op,
                 'players', '[]'::jsonb))
       where id = v_cast.id;
      continue;
    end if;

    -- Target values per op.
    if v_op = 'min' then
      v_a_after := least(v_a_value, v_b_value);
      v_b_after := v_a_after;
    elsif v_op = 'max' then
      v_a_after := greatest(v_a_value, v_b_value);
      v_b_after := v_a_after;
    else
      -- swap
      v_a_after := v_b_value;
      v_b_after := v_a_value;
    end if;

    -- Incoming roll-domain polarity per end (spec §7): a strict gain is
    -- positive, a strict loss negative, no change neutral (never warded).
    v_a_pol := case when v_a_after > v_a_value then 'positive'
                    when v_a_after < v_a_value then 'negative' else 'neutral' end;
    v_b_pol := case when v_b_after > v_b_value then 'positive'
                    when v_b_after < v_b_value then 'negative' else 'neutral' end;

    -- Ward pre-check: if EITHER end carries a matching earlier-seq roll-domain
    -- ward the whole transform is cancelled (a half-transform cannot conserve
    -- values -- same rule as apply_roll_swap).
    v_warded := false;
    v_ward_cast_id := null;
    v_ward_card_name := null;

    if v_a_pol <> 'neutral' then
      select g.ward_cast_id, g.ward_card_name into v_ward
        from public._rr_active_ward_gate(
          v_room_id, v_a_player, 'roll', v_a_pol, p_round_id, v_cast.seq) g;
      if found then
        v_warded := true;
        v_ward_cast_id := v_ward.ward_cast_id;
        v_ward_card_name := v_ward.ward_card_name;
      end if;
    end if;

    if not v_warded and v_b_pol <> 'neutral' then
      select g.ward_cast_id, g.ward_card_name into v_ward
        from public._rr_active_ward_gate(
          v_room_id, v_b_player, 'roll', v_b_pol, p_round_id, v_cast.seq) g;
      if found then
        v_warded := true;
        v_ward_cast_id := v_ward.ward_cast_id;
        v_ward_card_name := v_ward.ward_card_name;
      end if;
    end if;

    if not v_warded then
      update public.rolls as r set value = v_a_after
       where r.round_id = p_round_id and r.layer = p_layer and r.player_id = v_a_player;
      update public.rolls as r set value = v_b_after
       where r.round_id = p_round_id and r.layer = p_layer and r.player_id = v_b_player;
    end if;

    update public.spell_casts
       set cast_inputs = coalesce(cast_inputs, '{}'::jsonb) || jsonb_build_object(
             'roll_transform', jsonb_build_object(
               'kind', 'roll_pair_transform',
               'order', 5,
               'op', v_op,
               'players', case when v_warded then jsonb_build_array(
                   jsonb_build_object('player_id', v_a_player, 'before', v_a_value, 'after', v_a_value,
                     'warded', true, 'would_be_after', v_a_after,
                     'ward_cast_id', v_ward_cast_id, 'ward_card_name', v_ward_card_name),
                   jsonb_build_object('player_id', v_b_player, 'before', v_b_value, 'after', v_b_value,
                     'warded', true, 'would_be_after', v_b_after,
                     'ward_cast_id', v_ward_cast_id, 'ward_card_name', v_ward_card_name)
                 )
                 else jsonb_build_array(
                   jsonb_build_object('player_id', v_a_player, 'before', v_a_value, 'after', v_a_after),
                   jsonb_build_object('player_id', v_b_player, 'before', v_b_value, 'after', v_b_after)
                 )
               end
             ))
     where id = v_cast.id;
  end loop;

  return query
    select r.player_id, r.value
      from public.rolls r
     where r.round_id = p_round_id and r.layer = p_layer;
end;
$$;

revoke execute on function public.apply_roll_pair_transform(uuid, integer) from public, anon;
grant execute on function public.apply_roll_pair_transform(uuid, integer) to authenticated;

-- ---------------------------------------------------------------------------
-- 6. cast_reaction_spell_card -- re-emitted from 0093 with a Brew-tal Swap
--    by-name branch (only that branch differs from 0093).
-- ---------------------------------------------------------------------------
create or replace function public.cast_reaction_spell_card(
  p_round_id uuid, p_target_player_id text default null, p_target_cast_id uuid default null,
  p_spend_amount integer default null
)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_player_id text;
  v_window_id uuid;
  v_instance_id uuid;
  v_card_id uuid;
  v_casting_time text;
  v_target_stamp text;
  v_final_target text := p_target_player_id;
  v_cast_id uuid;
  v_effect record;
  v_row_target text;
  v_row_cast_id uuid;
  v_cast_inputs jsonb;
  v_dice_count integer;
  v_dice_sides integer;
  v_roll_total integer;
  v_target_tier text;
  v_target_target_player text;
  v_target_group uuid;
  v_dc integer;
  v_roll integer;
  v_participant record;
  v_room_id uuid;
  v_card_name text;
  v_eff_mod integer;
  v_spend integer;
  -- issue #316: Effect Invocation (Saucerer's Apprentice / Brew-merang)
  v_src_caster text;
  v_src_group uuid;
  v_src_card_name text;
  v_src_parent uuid;
begin
  v_player_id := public.current_player_id(p_round_id);

  select id into v_window_id
    from public.spell_reaction_windows
   where round_id = p_round_id and status = 'open'
   order by opened_at desc
   limit 1
     for update;

  if v_window_id is null then
    raise exception 'cast_reaction_spell_card: no open reaction window for this round'
      using errcode = 'RFB04';
  end if;

  if not exists (
    select 1 from public.round_participants
     where round_id = p_round_id and player_id = v_player_id
  ) then
    raise exception 'cast_reaction_spell_card: caller is not a participant in this round';
  end if;

  select sdi.id, sc.id, sc.casting_time, sc.target
    into v_instance_id, v_card_id, v_casting_time, v_target_stamp
    from public.spell_deck_instances sdi
    join public.spell_cards sc on sc.id = sdi.card_id
   where sdi.held_by_player = v_player_id and sdi.location = 'held';

  if v_instance_id is null then
    raise exception 'cast_reaction_spell_card: caller is not holding a card';
  end if;

  if v_casting_time <> 'R' then
    raise exception 'cast_reaction_spell_card: only Reaction cards can be cast into a reaction window';
  end if;

  if v_target_stamp = 'CARD' then
    if p_target_cast_id is null then
      raise exception 'cast_reaction_spell_card: this card requires a target cast';
    end if;
    select casts.target_player_id, casts.card_instance_id, sc2.tier
      into v_target_target_player, v_target_group, v_target_tier
      from public.spell_casts casts
      join public.spell_deck_instances sdi2 on sdi2.id = casts.card_instance_id
      join public.spell_cards sc2 on sc2.id = sdi2.card_id
     where casts.id = p_target_cast_id and casts.round_id = p_round_id;

    if v_target_tier is null then
      raise exception 'cast_reaction_spell_card: target cast not found in this round';
    end if;
    v_final_target := null;
  elsif v_target_stamp = 'SELF' then
    v_final_target := v_player_id;
  elsif v_target_stamp in ('OPPONENT', 'PLAYER') then
    if p_target_player_id is null then
      raise exception 'cast_reaction_spell_card: this card requires a target player';
    end if;
    if v_target_stamp = 'OPPONENT' and p_target_player_id = v_player_id then
      raise exception 'cast_reaction_spell_card: this card cannot target yourself';
    end if;
    if not exists (
      select 1 from public.round_participants
       where round_id = p_round_id and player_id = p_target_player_id
    ) then
      raise exception 'cast_reaction_spell_card: target is not a participant in this round';
    end if;
  elsif v_target_stamp = 'TABLE' then
    v_final_target := null;
  else
    raise exception 'cast_reaction_spell_card: % -targeted cards cannot be cast as a reaction yet', v_target_stamp;
  end if;

  update public.spell_deck_instances
     set location = 'in_deck', held_by_player = null
   where id = v_instance_id;

  select room_id into v_room_id from public.rounds where id = p_round_id;
  select name into v_card_name from public.spell_cards where id = v_card_id;

  -- issue #318: Brew-tal Swap (Reaction, OPPONENT) -- swap the caster's d20
  -- with the target's. Zero spell_card_effects rows, so it is a by-name
  -- branch emitting one roll_pair_transform cast (op = swap) with the pair
  -- recorded in cast_inputs; apply_roll_pair_transform runs it at
  -- reaction-window finalize and resolve_round Phase 3 adopts the result.
  -- target_role convention across the four #318 cards: 'TARGET' when a single
  -- non-caster is named (Brew-tal Swap / Steaming Mug Bond / Tea for Two),
  -- 'TABLE' when the caster names two others (Stir the Pot). The pair itself
  -- is authoritative in cast_inputs.pair; the resolver never reads target_role
  -- for these rows.
  if v_card_name = 'Brew-tal Swap' then
    insert into public.spell_casts (
      round_id, caster_id, card_instance_id, target_player_id, target_pending,
      effect_kind, effect_params, cast_inputs, reaction_window_id, target_role
    )
    values (
      p_round_id, v_player_id, v_instance_id, v_final_target, false,
      'roll_pair_transform', jsonb_build_object('op', 'swap'),
      jsonb_build_object('pair', jsonb_build_array(v_player_id, v_final_target)),
      v_window_id, 'TARGET'
    )
    returning id into v_cast_id;

    update public.spell_reaction_windows
       set poll_round = poll_round + 1
     where id = v_window_id;

    return v_cast_id;
  end if;

  -- issue #316: Effect Invocation -- Saucerer's Apprentice (copy) and
  -- Brew-merang (seize). Both are CARD-targeted Reactions with NO
  -- spell_card_effects rows, so the generic loop below would burn the card for
  -- nothing. Instead emit a single effect_kind = NULL invoking row carrying a
  -- pointer in cast_inputs; resolve_round Phase 0 derives the real effect.
  if v_card_name in ('Saucerer''s Apprentice', 'Brew-merang') then
    select src.caster_id, src.card_instance_id, srcn.name, src.parent_cast_id
      into v_src_caster, v_src_group, v_src_card_name, v_src_parent
      from public.spell_casts src
      join public.spell_deck_instances srcsdi on srcsdi.id = src.card_instance_id
      join public.spell_cards srcn on srcn.id = srcsdi.card_id
     where src.id = p_target_cast_id and src.round_id = p_round_id
     limit 1;

    if v_src_caster is null then
      raise exception 'cast_reaction_spell_card: target cast not found in this round';
    end if;

    -- No meta-invocation (spec §10): invocation cards cannot invoke each other.
    if v_src_card_name in ('Saucerer''s Apprentice', 'Brew-merang', 'Genie in the Teapot') then
      raise exception 'cast_reaction_spell_card: an invocation card cannot invoke another invocation card'
        using errcode = 'RFB49';
    end if;

    -- Brew-merang seizes ANOTHER player's cast (card text: "When another
    -- player plays a card").
    if v_card_name = 'Brew-merang' and v_src_caster = v_player_id then
      raise exception 'cast_reaction_spell_card: Brew-merang can only seize another player''s cast'
        using errcode = 'RFB49';
    end if;

    if v_card_name = 'Brew-merang' then
      v_cast_inputs := jsonb_build_object('seized_cast_id', p_target_cast_id);
    else
      -- Saucerer's Apprentice: draw every fresh copy RNG now (a copied d20 /
      -- dice re-rolls, a copied eager roll cast gets a synthesised
      -- roll_transform onto this caster) so resolve_round stays pure.
      v_cast_inputs := jsonb_build_object('copied_cast_id', p_target_cast_id)
        || jsonb_build_object('copy_inputs',
             public._rr_build_copy_inputs(p_round_id, p_target_cast_id, v_player_id));
    end if;

    insert into public.spell_casts (
      round_id, caster_id, card_instance_id, target_player_id, target_pending,
      effect_kind, effect_params, cast_inputs, parent_cast_id, reaction_window_id, target_role
    )
    values (
      p_round_id, v_player_id, v_instance_id, null, false,
      null, '{}'::jsonb, v_cast_inputs, p_target_cast_id, v_window_id, 'CARD'
    )
    returning id into v_cast_id;

    update public.spell_reaction_windows
       set poll_round = poll_round + 1
     where id = v_window_id;

    return v_cast_id;
  end if;

  -- issue #342: Tea-tally Spent. Spend a clamped amount of your own effective
  -- modifier durably (a persistent_modifier_spend {delta:-n} on SELF, picked
  -- up by resolve_round Phase 4b and _rr_spell_modifier_delta) and add the
  -- same amount to THIS round's roll only (a round-scoped flat_modifier
  -- {delta:+n} on SELF, composed by Phase 4a). No spell_card_effects rows.
  if v_card_name = 'Tea-tally Spent' then
    if p_spend_amount is null then
      raise exception 'cast_reaction_spell_card: Tea-tally Spent requires a spend amount'
        using errcode = 'RFB45';
    end if;

    select modifier into v_eff_mod from public.room_players
     where room_id = v_room_id and player_id = v_player_id;
    v_eff_mod := coalesce(v_eff_mod, 0);

    if v_eff_mod <= 0 then
      raise exception 'cast_reaction_spell_card: caster has no modifier to spend'
        using errcode = 'RFB44';
    end if;

    v_spend := least(greatest(p_spend_amount, 0), v_eff_mod);

    insert into public.spell_casts (
      round_id, caster_id, card_instance_id, target_player_id, target_pending,
      effect_kind, effect_params, cast_inputs, reaction_window_id, target_role
    )
    values (
      p_round_id, v_player_id, v_instance_id, v_player_id, false,
      'persistent_modifier_spend', jsonb_build_object('delta', -v_spend),
      jsonb_build_object('spend_amount', v_spend), v_window_id, 'CASTER'
    )
    returning id into v_cast_id;

    insert into public.spell_casts (
      round_id, caster_id, card_instance_id, target_player_id, target_pending,
      effect_kind, effect_params, cast_inputs, reaction_window_id, target_role, source_cast_id
    )
    values (
      p_round_id, v_player_id, v_instance_id, v_player_id, false,
      'flat_modifier', jsonb_build_object('delta', v_spend),
      jsonb_build_object('spend_amount', v_spend), v_window_id, 'CASTER', v_cast_id
    );

    update public.spell_reaction_windows
       set poll_round = poll_round + 1
     where id = v_window_id;

    return v_cast_id;
  end if;

  for v_effect in
    select target_role, effect_kind, effect_params
      from public.spell_card_effects
     where card_id = v_card_id
     order by ordinal
  loop
    if v_effect.target_role in ('TABLE', 'ALL_OTHER_PLAYERS')
      and v_effect.effect_kind in ('flat_modifier', 'dice_modifier', 'modifier_multiplier', 'set_modifier', 'forced_reroll') then
      for v_participant in
        select rp.player_id
          from public.round_participants rp
         where rp.round_id = p_round_id
           and (v_effect.target_role <> 'ALL_OTHER_PLAYERS' or rp.player_id <> v_player_id)
      loop
        -- #312: a table-wide reaction dice_modifier rolls now, into
        -- cast_inputs.dice_roll (raw, unsigned). resolve_round / the finalize
        -- shim apply the sign.
        v_cast_inputs := null;

        if v_effect.effect_kind = 'dice_modifier' then
          v_dice_count := (regexp_match(v_effect.effect_params ->> 'dice', '^(\d+)d(\d+)$'))[1]::integer;
          v_dice_sides := (regexp_match(v_effect.effect_params ->> 'dice', '^(\d+)d(\d+)$'))[2]::integer;

          v_roll_total := 0;
          for i in 1..v_dice_count loop
            v_roll_total := v_roll_total + floor(random() * v_dice_sides + 1)::integer;
          end loop;

          v_cast_inputs := jsonb_build_object('dice_roll', v_roll_total);
        end if;

        insert into public.spell_casts (
          round_id, caster_id, card_instance_id, target_player_id, target_pending,
          effect_kind, effect_params, cast_inputs, parent_cast_id, reaction_window_id, target_role
        )
        values (
          p_round_id, v_player_id, v_instance_id, v_participant.player_id, false,
          v_effect.effect_kind, v_effect.effect_params, v_cast_inputs, p_target_cast_id, v_window_id, v_effect.target_role
        )
        returning id into v_row_cast_id;

        if v_cast_id is null then
          v_cast_id := v_row_cast_id;
        end if;
      end loop;

      continue;
    elsif v_effect.target_role in ('TABLE', 'ALL_OTHER_PLAYERS') then
      v_row_target := null;
    else
      v_row_target := case when v_effect.target_role = 'CASTER' then v_player_id else v_final_target end;
    end if;

    insert into public.spell_casts (
      round_id, caster_id, card_instance_id, target_player_id, target_pending,
      effect_kind, effect_params, parent_cast_id, reaction_window_id, target_role
    )
    values (
      p_round_id, v_player_id, v_instance_id, v_row_target, false,
      v_effect.effect_kind, v_effect.effect_params, p_target_cast_id, v_window_id, v_effect.target_role
    )
    returning id into v_row_cast_id;

    if v_cast_id is null then
      v_cast_id := v_row_cast_id;
    end if;

    if v_effect.effect_kind = 'contested_negate' then
      -- effect_params.dc (from the card's spell_card_effects row) overrides
      -- the tier default: Saving Steep {"dc": 10}, Tannin Tantrum omits it.
      v_dc := coalesce(
        (v_effect.effect_params ->> 'dc')::integer,
        public._rr_tier_default_dc(v_target_tier));
      v_roll := floor(random() * 20 + 1)::integer;

      -- The d20 is a server-RNG draw -> record it into the Cast Log
      -- (cast_inputs.dc_d20) alongside the DC it was checked against.
      update public.spell_casts
         set cast_inputs = coalesce(cast_inputs, '{}'::jsonb)
                           || jsonb_build_object('dc_d20', v_roll, 'dc', v_dc)
       where id = v_row_cast_id;

      -- PROVISIONAL cache for live readers only (reaction stack, the
      -- finalize shim's negated filter, the get_round_modifier_effects
      -- preview). resolve_round Phase 1 recomputes negation recursively
      -- (counter-of-counter to any depth) and overwrites this
      -- authoritatively — for a single-level counter the two always agree.
      if v_roll >= v_dc then
        update public.spell_casts set negated = true where id = p_target_cast_id;
      end if;

      -- Natural 1 on a counter whose card carries the backfire behaviour
      -- (effect_params.backfire = true -- Saving Steep only; Tannin Tantrum
      -- omits it and just "resolves as normal" on a fail, spec §8). It does
      -- NOT negate the victim; instead resolve_round re-applies every effect
      -- row of the victim group once more onto the reactor. Draw + record
      -- every extra server-RNG that needs, now, into cast_inputs.backfire --
      -- whose presence is then the resolver's backfire signal.
      if v_roll = 1
         and v_target_group is not null
         and coalesce((v_effect.effect_params ->> 'backfire')::boolean, false) then
        perform public._rr_record_backfire(v_row_cast_id, v_target_group);
      end if;
    elsif v_effect.effect_kind = 'redirect' then
      -- #312: redirect records nothing of its own (spec §4: cast_inputs = {}).
      update public.spell_casts
         set cast_inputs = coalesce(cast_inputs, '{}'::jsonb)
       where id = v_row_cast_id;

      -- No in-place target_player_id UPDATE (spec §8). Provisional
      -- redirected_to_cast_id pointer only; resolve_round Phase 1 derives
      -- the effective post-redirect target from recorded state.
      if v_target_group is not null then
        update public.spell_casts
           set redirected_to_cast_id = v_row_cast_id
         where id = p_target_cast_id;
      end if;
    end if;
  end loop;

  update public.spell_reaction_windows
     set poll_round = poll_round + 1
   where id = v_window_id;

  return v_cast_id;
end;
$$;

revoke execute on function public.cast_reaction_spell_card(uuid, text, uuid, integer) from public, anon;
grant execute on function public.cast_reaction_spell_card(uuid, text, uuid, integer) to authenticated;


-- ---------------------------------------------------------------------------
-- 7. cast_spell_card -- re-emitted from 0093 with a Stir the Pot / Steaming
--    Mug Bond / Tea for Two by-name branch (only that branch differs).
-- ---------------------------------------------------------------------------
create or replace function public.cast_spell_card(
  p_round_id uuid, p_target_player_id text default null,
  p_chosen_player_ids text[] default null, p_declared_number integer default null,
  p_invoked_card_name text default null
)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_player_id text;
  v_status text;
  v_room_id uuid;
  v_instance_id uuid;
  v_card_id uuid;
  v_card_name text;
  v_casting_time text;
  v_target_stamp text;
  v_target_pending boolean := false;
  v_final_target text := p_target_player_id;
  v_cast_id uuid;
  v_effect record;
  v_row_target text;
  v_row_pending boolean;
  v_row_cast_id uuid;
  v_cast_inputs jsonb;
  v_dice_count integer;
  v_dice_sides integer;
  v_roll_total integer;
  v_effect_params jsonb;
  v_max_targets integer;
  v_chosen_id text;
  v_branch integer;
  v_other_id text;
  v_extreme_low text;
  v_extreme_high text;
  v_target_mod integer;
  v_snap integer;
  v_caster_mod integer;
  -- issue #344: ward interaction for modifier-transfer / snapshot cards
  v_ward_cast_id uuid;
  v_ward_card_name text;
  v_ward_blocked boolean := false;
  v_loser text;
  v_wb_before integer;
  v_wb_after integer;
  v_block_marker jsonb;
  -- issue #316: Genie in the Teapot (Effect Invocation)
  v_is_genie boolean := false;
  v_gen_card_id uuid;
  v_gen_casting_time text;
  v_gen_tier text;
  v_gen_target_stamp text;
  v_gen_in_deck integer;
begin
  v_player_id := public.current_player_id(p_round_id);

  select status, room_id into v_status, v_room_id from public.rounds where id = p_round_id;

  if v_status is null then
    raise exception 'cast_spell_card: round not found';
  end if;

  if v_status <> 'open' then
    raise exception 'cast_spell_card: round is not open for pre-roll casting'
      using errcode = 'RFB03';
  end if;

  if not exists (
    select 1 from public.round_participants
     where round_id = p_round_id and player_id = v_player_id
  ) then
    raise exception 'cast_spell_card: caller is not a participant in this round';
  end if;

  select sdi.id, sc.id, sc.name, sc.casting_time, sc.target
    into v_instance_id, v_card_id, v_card_name, v_casting_time, v_target_stamp
    from public.spell_deck_instances sdi
    join public.spell_cards sc on sc.id = sdi.card_id
   where sdi.held_by_player = v_player_id and sdi.location = 'held';

  if v_instance_id is null then
    raise exception 'cast_spell_card: caller is not holding a card';
  end if;

  if v_casting_time <> 'A' then
    raise exception 'cast_spell_card: only Action cards can be cast pre-roll';
  end if;

  -- issue #316: Genie in the Teapot (Effect Invocation). Name any OTHER
  -- non-Epic Action card whose sole edition instance is in_deck and resolve
  -- its effect as if played. The named instance is NOT moved (ethereal). The
  -- Genie's own held instance IS consumed. Implemented by rebinding v_card_id
  -- / v_target_stamp to the named card and falling through to the generic
  -- per-effect loop; the Genie's rows carry cast_inputs.invoked_card. A card
  -- Genie cannot express (no non-WILD effect rows, or a by-name special-case)
  -- is a typed RFB50, never a silent burn.
  if v_card_name = 'Genie in the Teapot' then
    if p_invoked_card_name is null then
      raise exception 'cast_spell_card: Genie in the Teapot must name a card'
        using errcode = 'RFB50';
    end if;

    select sc.id, sc.casting_time, sc.tier, sc.target
      into v_gen_card_id, v_gen_casting_time, v_gen_tier, v_gen_target_stamp
      from public.spell_cards sc
     where sc.name = p_invoked_card_name;

    if v_gen_card_id is null then
      raise exception 'cast_spell_card: no card named %', p_invoked_card_name
        using errcode = 'RFB50';
    end if;
    if p_invoked_card_name = 'Genie in the Teapot'
       or v_gen_tier = 'epic'
       or v_gen_casting_time <> 'A' then
      raise exception 'cast_spell_card: Genie can only name a non-Epic Action card'
        using errcode = 'RFB50';
    end if;
    -- Cards cast_spell_card resolves through a bespoke by-name / WILD branch
    -- rather than the generic per-effect loop cannot be invoked this way in
    -- this slice: their real behaviour needs live-modifier snapshots or d6
    -- dispatch the loop can't express, and "no card silently no-ops" (spec
    -- #302) beats a technically-legal-but-inert invocation. This list mirrors
    -- the name-keyed branches earlier in this function + the #342/#343 ones --
    -- keep it in sync if another by-name special-case is added.
    if p_invoked_card_name in (
         'Bes-Tea', 'Tea Leaf', 'Spillage', 'Chai-nge of Heart', 'Bitter Leech',
         'Wild Brew Surge', 'Kettle Crash')
       or v_gen_target_stamp = 'WILD' then
      raise exception 'cast_spell_card: % cannot be invoked by Genie yet', p_invoked_card_name
        using errcode = 'RFB50';
    end if;
    if not exists (
      select 1 from public.spell_card_effects
       where card_id = v_gen_card_id and target_role <> 'WILD'
    ) then
      raise exception 'cast_spell_card: % has no invokable effect', p_invoked_card_name
        using errcode = 'RFB50';
    end if;

    -- The named card's sole edition instance must be available in the deck
    -- (held / pending_swap => not nameable). Ethereal: not consumed, not moved.
    select count(*) filter (where location = 'in_deck')
      into v_gen_in_deck
      from public.spell_deck_instances
     where card_id = v_gen_card_id;
    if coalesce(v_gen_in_deck, 0) < 1 then
      raise exception 'cast_spell_card: % is not available in the deck', p_invoked_card_name
        using errcode = 'RFB50';
    end if;

    -- Genie picks the target now, following the named card's own rule.
    if v_gen_target_stamp in ('OPPONENT', 'PLAYER') and p_target_player_id is null then
      raise exception 'cast_spell_card: Genie must choose the target for % now', p_invoked_card_name
        using errcode = 'RFB50';
    end if;

    v_is_genie := true;
    v_card_id := v_gen_card_id;
    v_target_stamp := v_gen_target_stamp;
  end if;

  if v_target_stamp = 'SELF' then
    if p_target_player_id is not null and p_target_player_id <> v_player_id then
      raise exception 'cast_spell_card: this card can only target yourself';
    end if;
    v_final_target := v_player_id;
  elsif v_target_stamp in ('OPPONENT', 'PLAYER') then
    if p_target_player_id is null then
      v_target_pending := true;
      v_final_target := null;
    else
      if v_target_stamp = 'OPPONENT' and p_target_player_id = v_player_id then
        raise exception 'cast_spell_card: this card cannot target yourself';
      end if;
      if not exists (
        select 1 from public.round_participants
         where round_id = p_round_id and player_id = p_target_player_id
      ) then
        raise exception 'cast_spell_card: target is not a participant in this round';
      end if;
    end if;
  elsif v_target_stamp = 'CHOSEN_PLAYERS' then
    if p_chosen_player_ids is null or array_length(p_chosen_player_ids, 1) is null then
      raise exception 'cast_spell_card: this card requires at least one chosen player';
    end if;
    if array_length(p_chosen_player_ids, 1) <> (
      select count(distinct x) from unnest(p_chosen_player_ids) x
    ) then
      raise exception 'cast_spell_card: chosen players must be distinct';
    end if;
    foreach v_chosen_id in array p_chosen_player_ids loop
      if not exists (
        select 1 from public.round_participants
         where round_id = p_round_id and player_id = v_chosen_id
      ) then
        raise exception 'cast_spell_card: chosen player is not a participant in this round';
      end if;
    end loop;
  elsif v_target_stamp in ('TABLE', 'WILD') then
    v_final_target := null;
  else
    raise exception 'cast_spell_card: % -targeted cards cannot be cast pre-roll yet', v_target_stamp;
  end if;

  update public.spell_deck_instances
     set location = 'in_deck', held_by_player = null
   where id = v_instance_id;

  -- issue #318: chosen-pair roll transform Action cards. Zero
  -- spell_card_effects rows, so each is a by-name branch emitting one
  -- roll_pair_transform cast; apply_roll_pair_transform runs it at
  -- reaction-window finalize (its pre-roll rows are attached to the layer-0
  -- window by attach_pre_roll_roll_pair_transform_casts, migration 0096) and
  -- resolve_round Phase 3 adopts the result. No deferred-target path this
  -- slice -- an explicit target / pair is required at cast time (RFB46), the
  -- Bes-Tea / Chai-nge of Heart tradeoff.
  --   * Stir the Pot      -- op = swap over two OTHER players (never caster)
  --   * Steaming Mug Bond  -- op = min: caster + target both take the lower d20
  --   * Tea for Two        -- op = max: caster + target both take the higher d20
  if v_card_name in ('Stir the Pot', 'Steaming Mug Bond', 'Tea for Two') then
    if v_card_name = 'Stir the Pot' then
      if coalesce(array_length(p_chosen_player_ids, 1), 0) <> 2 then
        raise exception 'cast_spell_card: Stir the Pot requires exactly two chosen players'
          using errcode = 'RFB46';
      end if;
      if p_chosen_player_ids[1] = p_chosen_player_ids[2] then
        raise exception 'cast_spell_card: chosen players must be distinct'
          using errcode = 'RFB46';
      end if;
      if v_player_id = any (p_chosen_player_ids) then
        raise exception 'cast_spell_card: Stir the Pot cannot choose yourself'
          using errcode = 'RFB46';
      end if;
      foreach v_chosen_id in array p_chosen_player_ids loop
        if not exists (
          select 1 from public.round_participants
           where round_id = p_round_id and player_id = v_chosen_id
        ) then
          raise exception 'cast_spell_card: chosen player is not a participant in this round'
            using errcode = 'RFB46';
        end if;
      end loop;

      insert into public.spell_casts (
        round_id, caster_id, card_instance_id, target_player_id, target_pending,
        effect_kind, effect_params, cast_inputs, target_role
      )
      values (
        p_round_id, v_player_id, v_instance_id, null, false,
        'roll_pair_transform', jsonb_build_object('op', 'swap'),
        jsonb_build_object('pair',
          jsonb_build_array(p_chosen_player_ids[1], p_chosen_player_ids[2])),
        'TABLE'
      )
      returning id into v_cast_id;
    else
      if v_final_target is null then
        raise exception 'cast_spell_card: % requires an explicit target', v_card_name
          using errcode = 'RFB46';
      end if;
      if v_final_target = v_player_id then
        raise exception 'cast_spell_card: this card cannot target yourself'
          using errcode = 'RFB46';
      end if;

      insert into public.spell_casts (
        round_id, caster_id, card_instance_id, target_player_id, target_pending,
        effect_kind, effect_params, cast_inputs, target_role
      )
      values (
        p_round_id, v_player_id, v_instance_id, v_final_target, false,
        'roll_pair_transform',
        jsonb_build_object('op',
          case v_card_name when 'Steaming Mug Bond' then 'min' else 'max' end),
        jsonb_build_object('pair', jsonb_build_array(v_player_id, v_final_target)),
        'TARGET'
      )
      returning id into v_cast_id;
    end if;

    return v_cast_id;
  end if;

  -- issue #343: round-scoped modifier snapshot cards. Fully special-cased
  -- (like WILD / Kettle Crash / declared_number_tea_maker) because the
  -- generic per-effect loop can only copy static spell_card_effects params
  -- and these cards need a value computed from live modifiers at cast time.
  -- The rows emitted here carry no duration and no spell_active_effects
  -- row, so resolve_round Phase 4a composes them for THIS round only and
  -- they revert automatically at round end.
  if v_card_name in ('Bes-Tea', 'Tea Leaf', 'Spillage') then
    if v_final_target is null then
      raise exception 'cast_spell_card: this card requires a target chosen at cast time';
    end if;

    select coalesce(modifier, 0) into v_target_mod
      from public.room_players
     where room_id = v_room_id and player_id = v_final_target;
    v_target_mod := coalesce(v_target_mod, 0);

    -- issue #344: ward interaction. Bes-Tea's copy fails against a block_copy
    -- holder; Tea Leaf / Spillage's steal is blocked atomically -- the target
    -- keeps their modifier AND the caster gets no roll bonus -- when the
    -- target holds a matching negative modifier-domain ward. The card is still
    -- spent (the deck instance was returned above); the emitted rows go in
    -- negated with a _rr_ward_block_marker that resolve_round's Pre-pass turns
    -- into one `warded` step. Detection is at cast time: like Bes-Tea's own
    -- source_modifier snapshot these Action cards resolve their inputs when
    -- cast, so a ward cast later the same round (higher seq) does not gate.
    v_ward_blocked := false;
    v_ward_cast_id := null;
    v_ward_card_name := null;
    v_block_marker := '{}'::jsonb;

    if v_card_name = 'Bes-Tea' then
      select sae.source_cast_id, scw.name
        into v_ward_cast_id, v_ward_card_name
        from public.spell_active_effects sae
        join public.spell_cards scw on scw.id = sae.card_id
       where sae.room_id = v_room_id
         and sae.target_player_id = v_final_target
         and sae.effect_kind = 'ward'
         and coalesce((sae.effect_params ->> 'block_copy')::boolean, false) = true
       order by sae.created_at
       limit 1;
      v_ward_blocked := found;
      if v_ward_blocked then
        -- ward_target is the block_copy holder (v_final_target), so the Trace
        -- sentence names the ward holder; the would-be values describe the
        -- caster's round modifier the copy would have set.
        v_block_marker := public._rr_ward_block_marker(
          v_ward_cast_id, v_ward_card_name, v_final_target,
          coalesce((select modifier from public.room_players
                     where room_id = v_room_id and player_id = v_player_id), 0),
          v_target_mod);
      end if;

      -- Copy the target's effective modifier onto the caster for this round.
      insert into public.spell_casts (
        round_id, caster_id, card_instance_id, target_player_id, target_pending,
        effect_kind, effect_params, cast_inputs, target_role, negated
      )
      values (
        p_round_id, v_player_id, v_instance_id, v_player_id, false,
        'set_modifier', jsonb_build_object('value', v_target_mod),
        jsonb_build_object('source_modifier', v_target_mod) || v_block_marker,
        'CASTER', v_ward_blocked
      )
      returning id into v_cast_id;

    elsif v_card_name = 'Tea Leaf' then
      if v_target_mod > 0 then
        select g.ward_cast_id, g.ward_card_name into v_ward_cast_id, v_ward_card_name
          from public._rr_active_ward_gate(
            v_room_id, v_final_target, 'modifier', 'negative', p_round_id, null) g;
        v_ward_blocked := found;
      end if;
      if v_ward_blocked then
        v_block_marker := public._rr_ward_block_marker(
          v_ward_cast_id, v_ward_card_name, v_final_target, v_target_mod, 0);
      end if;

      -- Target's modifier drops to 0 for this round...
      insert into public.spell_casts (
        round_id, caster_id, card_instance_id, target_player_id, target_pending,
        effect_kind, effect_params, cast_inputs, target_role, negated
      )
      values (
        p_round_id, v_player_id, v_instance_id, v_final_target, false,
        'set_modifier', jsonb_build_object('value', 0),
        jsonb_build_object('stolen_amount', v_target_mod) || v_block_marker,
        'TARGET', v_ward_blocked
      )
      returning id into v_cast_id;

      -- ...and the stolen amount is added to the caster's roll this round.
      insert into public.spell_casts (
        round_id, caster_id, card_instance_id, target_player_id, target_pending,
        effect_kind, effect_params, cast_inputs, target_role, negated
      )
      values (
        p_round_id, v_player_id, v_instance_id, v_player_id, false,
        'flat_modifier', jsonb_build_object('delta', v_target_mod),
        jsonb_build_object('stolen_amount', v_target_mod), 'CASTER', v_ward_blocked
      );

    else
      -- Spillage: floor(m/2) leaves the target and joins the caster's roll
      -- for this round. Postgres integer division truncates toward zero, so
      -- compute the floor explicitly for negative modifiers.
      v_snap := floor(v_target_mod / 2.0)::integer;

      if v_snap > 0 then
        select g.ward_cast_id, g.ward_card_name into v_ward_cast_id, v_ward_card_name
          from public._rr_active_ward_gate(
            v_room_id, v_final_target, 'modifier', 'negative', p_round_id, null) g;
        v_ward_blocked := found;
      end if;
      if v_ward_blocked then
        v_block_marker := public._rr_ward_block_marker(
          v_ward_cast_id, v_ward_card_name, v_final_target,
          v_target_mod, v_target_mod - v_snap);
      end if;

      insert into public.spell_casts (
        round_id, caster_id, card_instance_id, target_player_id, target_pending,
        effect_kind, effect_params, cast_inputs, target_role, negated
      )
      values (
        p_round_id, v_player_id, v_instance_id, v_final_target, false,
        'flat_modifier', jsonb_build_object('delta', -v_snap),
        jsonb_build_object('stolen_amount', v_snap) || v_block_marker,
        'TARGET', v_ward_blocked
      )
      returning id into v_cast_id;

      insert into public.spell_casts (
        round_id, caster_id, card_instance_id, target_player_id, target_pending,
        effect_kind, effect_params, cast_inputs, target_role, negated
      )
      values (
        p_round_id, v_player_id, v_instance_id, v_player_id, false,
        'flat_modifier', jsonb_build_object('delta', v_snap),
        jsonb_build_object('stolen_amount', v_snap), 'CASTER', v_ward_blocked
      );
    end if;

    return v_cast_id;
  end if;

  -- issue #342: two durable persistent-modifier cards whose emission the
  -- generic spell_card_effects loop cannot express (they carry no effect
  -- rows). Both are Action / OPPONENT and need an explicit target at cast
  -- time (RFB46) -- no deferred-target path in this slice. v_card_name is
  -- already populated from the held-card lookup above (#343).
  if v_card_name = 'Chai-nge of Heart' then
    if v_final_target is null then
      raise exception 'cast_spell_card: Chai-nge of Heart requires an explicit target'
        using errcode = 'RFB46';
    end if;

    select modifier into v_caster_mod from public.room_players
     where room_id = v_room_id and player_id = v_player_id;
    select modifier into v_target_mod from public.room_players
     where room_id = v_room_id and player_id = v_final_target;
    v_caster_mod := coalesce(v_caster_mod, 0);
    v_target_mod := coalesce(v_target_mod, 0);

    -- issue #344: ward interaction. A swap is atomic -- if the side that LOSES
    -- modifier holds a matching negative modifier-domain ward (Eternal Steep /
    -- Bag for Life / Cast-Iron Kettle) the whole transfer is blocked: both
    -- sibling rows go in negated, so Phase 4b's running-sum filter drops them
    -- while its target gather still reverts both caches to base. The card is
    -- still spent. resolve_round's Pre-pass turns the marker into one `warded`
    -- step. A ward cast later this round (higher seq) does not gate.
    v_ward_blocked := false;
    v_ward_cast_id := null;
    v_ward_card_name := null;
    v_block_marker := '{}'::jsonb;
    -- The caster's transfer row is delta = target_mod - caster_mod, so the
    -- caster is the losing side when target_mod < caster_mod (and vice versa).
    if v_target_mod < v_caster_mod then
      v_loser := v_player_id;    v_wb_before := v_caster_mod; v_wb_after := v_target_mod;
    elsif v_caster_mod < v_target_mod then
      v_loser := v_final_target; v_wb_before := v_target_mod; v_wb_after := v_caster_mod;
    else
      v_loser := null;   -- equal modifiers: the swap moves nothing
    end if;

    if v_loser is not null then
      select g.ward_cast_id, g.ward_card_name into v_ward_cast_id, v_ward_card_name
        from public._rr_active_ward_gate(
          v_room_id, v_loser, 'modifier', 'negative', p_round_id, null) g;
      v_ward_blocked := found;
    end if;
    if v_ward_blocked then
      v_block_marker := public._rr_ward_block_marker(
        v_ward_cast_id, v_ward_card_name, v_loser, v_wb_before, v_wb_after);
    end if;

    -- Sibling persistent_modifier_transfer pair: caster gains (target - caster),
    -- target gains (caster - target) -> their effective modifiers swap for the
    -- rest of the day. resolve_round Phase 4b projects both into
    -- room_players.modifier; whole-cast negation (shared card_instance_id)
    -- drops both. cast_inputs snapshots both effective modifiers at cast time.
    insert into public.spell_casts (
      round_id, caster_id, card_instance_id, target_player_id,
      effect_kind, effect_params, cast_inputs, negated
    )
    values (
      p_round_id, v_player_id, v_instance_id, v_player_id,
      'persistent_modifier_transfer',
      jsonb_build_object('delta', v_target_mod - v_caster_mod),
      jsonb_build_object('caster_modifier', v_caster_mod, 'target_modifier', v_target_mod) || v_block_marker,
      v_ward_blocked
    )
    returning id into v_cast_id;

    insert into public.spell_casts (
      round_id, caster_id, card_instance_id, target_player_id,
      effect_kind, effect_params, cast_inputs, source_cast_id, negated
    )
    values (
      p_round_id, v_player_id, v_instance_id, v_final_target,
      'persistent_modifier_transfer',
      jsonb_build_object('delta', v_caster_mod - v_target_mod),
      jsonb_build_object('caster_modifier', v_caster_mod, 'target_modifier', v_target_mod),
      v_cast_id, v_ward_blocked
    );

    return v_cast_id;

  elsif v_card_name = 'Bitter Leech' then
    if v_final_target is null then
      raise exception 'cast_spell_card: Bitter Leech requires an explicit target'
        using errcode = 'RFB46';
    end if;

    -- One anchor cast + one spell_active_effects row (rounds_remaining => 3
    -- from the card's duration_rounds). resolve_round Phase 4b-pre projects a
    -- -1 / +1 persistent_modifier_transfer pair off it every round it is live
    -- (cast round + next 2). The anchor carries no 'delta' key, so it never
    -- contributes to _rr_spell_modifier_delta on its own.
    insert into public.spell_casts (
      round_id, caster_id, card_instance_id, target_player_id,
      effect_kind, effect_params, cast_inputs
    )
    values (
      p_round_id, v_player_id, v_instance_id, v_final_target,
      'persistent_modifier_transfer',
      jsonb_build_object('per_round_delta', 1, 'direction', 'caster_gains'),
      '{}'::jsonb
    )
    returning id into v_cast_id;

    perform public.record_active_effect_if_persistent(
      v_room_id, v_player_id, v_final_target, v_card_id,
      'persistent_modifier_transfer',
      jsonb_build_object('per_round_delta', 1, 'direction', 'caster_gains'),
      v_cast_id
    );

    return v_cast_id;
  end if;

  -- WILD is fully special-cased: the six branches are mutually exclusive
  -- alternatives chosen by a d6 roll at cast time, not simultaneous
  -- spell_card_effects rows, so this bypasses the generic per-effect loop
  -- below entirely (that loop explicitly excludes target_role = 'WILD').
  if v_target_stamp = 'WILD' then
    v_branch := floor(random() * 6 + 1)::integer;

    if v_branch = 1 then
      update public.room_players set modifier = 0 where room_id = v_room_id;
      v_effect_params := '{}'::jsonb;
    elsif v_branch = 2 then
      -- issue #311: +3 caster rest of day -> a one-sided
      -- persistent_modifier_transfer the resolver's Phase 4b projects into
      -- room_players.modifier at resolve. No imperative write here.
      insert into public.spell_casts (
        round_id, caster_id, card_instance_id, target_player_id,
        effect_kind, effect_params, cast_inputs
      )
      values (
        p_round_id, v_player_id, v_instance_id, v_player_id,
        'persistent_modifier_transfer', jsonb_build_object('delta', 3), '{}'::jsonb
      );
      v_effect_params := '{"delta": 3}'::jsonb;
    elsif v_branch = 3 then
      select player_id into v_other_id
        from public.room_players
       where room_id = v_room_id and player_id <> v_player_id
       order by random()
       limit 1;
      if v_other_id is not null then
        -- issue #311: modifier swap -> a persistent_modifier_transfer sibling
        -- pair with a cast-time snapshot; the resolver's Phase 4b projects
        -- both sides. swap_room_player_modifiers is retired.
        perform public._rr_emit_modifier_swap_pair(
          v_room_id, p_round_id, v_player_id, v_instance_id, v_player_id, v_other_id
        );
        v_effect_params := jsonb_build_object('swapped_with', v_other_id);
      else
        v_effect_params := '{}'::jsonb;
      end if;
    elsif v_branch = 4 then
      -- "Everyone rerolls" — nobody's rolled yet (WBS is cast pre-roll), so
      -- this arms a table-wide forced_reroll placeholder the same as Tea-M
      -- Reroll, fanned out to the final roster by close_round below and
      -- applied once the round's first rolls are in (finalizeReactionWindow
      -- already applies any un-negated forced_reroll cast for the layer,
      -- regardless of whether it was armed pre-roll or as a reaction).
      insert into public.spell_casts (
        round_id, caster_id, card_instance_id, target_player_id, target_pending,
        effect_kind, effect_params, target_role
      )
      values (
        p_round_id, v_player_id, v_instance_id, null, true,
        'forced_reroll', '{}'::jsonb, 'TABLE'
      );
      v_effect_params := '{}'::jsonb;
    elsif v_branch = 5 then
      select rp.player_id into v_extreme_high
        from public.round_participants rp
        join public.room_players rpl on rpl.room_id = v_room_id and rpl.player_id = rp.player_id
       where rp.round_id = p_round_id
       order by rpl.modifier desc, rp.player_id
       limit 1;
      select rp.player_id into v_extreme_low
        from public.round_participants rp
        join public.room_players rpl on rpl.room_id = v_room_id and rpl.player_id = rp.player_id
       where rp.round_id = p_round_id
       order by rpl.modifier asc, rp.player_id
       limit 1;
      if v_extreme_high is not null and v_extreme_low is not null and v_extreme_high <> v_extreme_low then
        -- issue #311: highest <-> lowest modifier swap -> a
        -- persistent_modifier_transfer sibling pair with a cast-time snapshot.
        perform public._rr_emit_modifier_swap_pair(
          v_room_id, p_round_id, v_player_id, v_instance_id, v_extreme_high, v_extreme_low
        );
        v_effect_params := jsonb_build_object('swapped', jsonb_build_array(v_extreme_high, v_extreme_low));
      else
        v_effect_params := '{}'::jsonb;
      end if;
    else
      -- Branch 6: choose who makes tea this round. p_target_player_id may
      -- already be known (client asked up front); otherwise this defers the
      -- same way OPPONENT/PLAYER cards do, and the caster fills it in later
      -- via set_spell_cast_target once the round closes.
      insert into public.spell_casts (
        round_id, caster_id, card_instance_id, target_player_id, target_pending,
        effect_kind, effect_params, target_role
      )
      values (
        p_round_id, v_player_id, v_instance_id, p_target_player_id, p_target_player_id is null,
        'tea_maker_override', '{"mode": "chosen"}'::jsonb, 'WILD'
      )
      returning id into v_cast_id;

      insert into public.spell_casts (
        round_id, caster_id, card_instance_id, target_player_id,
        effect_kind, effect_params, cast_inputs
      )
      values (p_round_id, v_player_id, v_instance_id, null,
              'wild_dispatch', '{"branch": 6}'::jsonb, jsonb_build_object('branch', v_branch));

      return v_cast_id;
    end if;

    insert into public.spell_casts (
      round_id, caster_id, card_instance_id, target_player_id,
      effect_kind, effect_params, cast_inputs
    )
    values (p_round_id, v_player_id, v_instance_id, null,
            'wild_dispatch', v_effect_params, jsonb_build_object('branch', v_branch))
    returning id into v_cast_id;

    return v_cast_id;
  end if;

  for v_effect in
    select target_role, effect_kind, effect_params
      from public.spell_card_effects
     where card_id = v_card_id and target_role <> 'WILD'
     order by ordinal
  loop
    v_effect_params := v_effect.effect_params;

    if v_effect.effect_kind = 'declared_number_tea_maker' then
      if p_declared_number is null or p_declared_number < 1 or p_declared_number > 20 then
        raise exception 'cast_spell_card: this card requires a declared number between 1 and 20';
      end if;
      v_effect_params := jsonb_build_object('number', p_declared_number);

      insert into public.spell_casts (
        round_id, caster_id, card_instance_id, target_player_id, effect_kind, effect_params, target_role
      )
      values (p_round_id, v_player_id, v_instance_id, null, v_effect.effect_kind, v_effect_params, v_effect.target_role)
      returning id into v_row_cast_id;

      -- #310: Cast Log row first so the sentinel active-effect row can carry a
      -- real source_cast_id (spell_active_effects.source_cast_id is NOT NULL).
      -- rounds_remaining => 1: the declared number applies to its own cast
      -- round only, then _rr_active_effects_as_of derives it expired -- no
      -- physical DELETE (resolve_declared_number_tea_maker, #310).
      insert into public.spell_active_effects (
        room_id, target_player_id, caster_id, source_cast_id, card_id, effect_kind, effect_params, rounds_remaining
      )
      values (v_room_id, v_player_id, v_player_id, v_row_cast_id, v_card_id, v_effect.effect_kind, v_effect_params, 1);

      if v_cast_id is null then
        v_cast_id := v_row_cast_id;
      end if;

      continue;
    end if;

    if v_effect.target_role = 'CASTER' then
      v_row_target := v_player_id;
      v_row_pending := false;
    elsif v_effect.target_role = 'TARGET' then
      v_row_target := v_final_target;
      v_row_pending := v_target_pending;
    elsif v_effect.target_role in ('TABLE', 'ALL_OTHER_PLAYERS')
      and v_effect.effect_kind in ('flat_modifier', 'dice_modifier', 'modifier_multiplier', 'set_modifier', 'forced_reroll') then
      insert into public.spell_casts (
        round_id, caster_id, card_instance_id, target_player_id, target_pending,
        effect_kind, effect_params, target_role
      )
      values (
        p_round_id, v_player_id, v_instance_id, null, true,
        v_effect.effect_kind, v_effect_params, v_effect.target_role
      )
      returning id into v_row_cast_id;

      if v_cast_id is null then
        v_cast_id := v_row_cast_id;
      end if;

      continue;
    elsif v_effect.target_role in ('TABLE', 'ALL_OTHER_PLAYERS') then
      -- Single table-wide event (roll_swap/roll_flip/lowest_gains_highest_
      -- modifier/tea_maker_override) — no per-player row needed.
      if v_effect.effect_kind = 'reset_persistent_modifier' then
        -- Kettle Crash (#285, migration 0076): persistent, not round-scoped,
        -- so apply the reset live at cast time — no close_round fan-out. The
        -- spell_casts insert just below is the audit trail.
        update public.room_players set modifier = 0 where room_id = v_room_id;
      end if;

      insert into public.spell_casts (
        round_id, caster_id, card_instance_id, target_player_id, effect_kind, effect_params, target_role
      )
      values (p_round_id, v_player_id, v_instance_id, null, v_effect.effect_kind, v_effect_params, v_effect.target_role)
      returning id into v_row_cast_id;

      if v_cast_id is null then
        v_cast_id := v_row_cast_id;
      end if;

      continue;
    elsif v_effect.target_role = 'CHOSEN_PLAYERS' then
      v_max_targets := coalesce((v_effect_params ->> 'max_targets')::integer, array_length(p_chosen_player_ids, 1));
      if array_length(p_chosen_player_ids, 1) > v_max_targets then
        raise exception 'cast_spell_card: this card can only target up to % players', v_max_targets;
      end if;

      foreach v_chosen_id in array p_chosen_player_ids loop
        -- #312: a CHOSEN_PLAYERS dice_modifier rolls immediately at cast time
        -- (unlike a CASTER/TARGET one, which defers to a Pending Spell Die).
        -- The raw, unsigned total is recorded into cast_inputs.dice_roll;
        -- its presence keeps this cast out of get_my_pending_spell_dice --
        -- the role a non-null resolved_value used to play.
        v_cast_inputs := null;

        if v_effect.effect_kind = 'dice_modifier' then
          v_dice_count := (regexp_match(v_effect_params ->> 'dice', '^(\d+)d(\d+)$'))[1]::integer;
          v_dice_sides := (regexp_match(v_effect_params ->> 'dice', '^(\d+)d(\d+)$'))[2]::integer;

          v_roll_total := 0;
          for i in 1..v_dice_count loop
            v_roll_total := v_roll_total + floor(random() * v_dice_sides + 1)::integer;
          end loop;

          v_cast_inputs := jsonb_build_object('dice_roll', v_roll_total);
        end if;

        insert into public.spell_casts (
          round_id, caster_id, card_instance_id, target_player_id, target_pending,
          effect_kind, effect_params, cast_inputs, target_role
        )
        values (
          p_round_id, v_player_id, v_instance_id, v_chosen_id, false,
          v_effect.effect_kind, v_effect_params, v_cast_inputs, v_effect.target_role
        )
        returning id into v_row_cast_id;

        if v_cast_id is null then
          v_cast_id := v_row_cast_id;
        end if;

        perform public.record_active_effect_if_persistent(
          v_room_id, v_player_id, v_chosen_id, v_card_id,
          v_effect.effect_kind, v_effect_params, v_row_cast_id
        );
      end loop;

      continue;
    else
      v_row_target := v_final_target;
      v_row_pending := v_target_pending;
    end if;

    insert into public.spell_casts (
      round_id, caster_id, card_instance_id, target_player_id, target_pending,
      effect_kind, effect_params, target_role
    )
    values (
      p_round_id, v_player_id, v_instance_id, v_row_target, v_row_pending,
      v_effect.effect_kind, v_effect_params, v_effect.target_role
    )
    returning id into v_row_cast_id;

    if v_cast_id is null then
      v_cast_id := v_row_cast_id;
    end if;

    if v_row_target is not null then
      perform public.record_active_effect_if_persistent(
        v_room_id, v_player_id, v_row_target, v_card_id,
        v_effect.effect_kind, v_effect_params, v_row_cast_id
      );
    end if;
  end loop;

  -- issue #316: tag every row the Genie emitted with the card it invoked, so
  -- the Cast Log / Recap show it resolved "as if you had played" that card.
  if v_is_genie then
    update public.spell_casts
       set cast_inputs = coalesce(cast_inputs, '{}'::jsonb)
                         || jsonb_build_object('invoked_card', p_invoked_card_name)
     where round_id = p_round_id
       and card_instance_id = v_instance_id
       and caster_id = v_player_id;
  end if;

  return v_cast_id;
end;
$$;

revoke execute on function public.cast_spell_card(uuid, text, text[], integer, text) from public, anon;
grant execute on function public.cast_spell_card(uuid, text, text[], integer, text) to authenticated;

-- ---------------------------------------------------------------------------
-- 8. resolve_round(uuid) -- re-emitted from 0095 (sibling #319 body, which
--    itself re-emitted 0093). Diffs vs 0095:
--      * Phase 3's accounting-loop kind filter grows BOTH `fixed_roll` (#317 --
--        0095 re-emitted resolve_round from 0093 and dropped it) and
--        `roll_pair_transform` (#318). The Phase 0a (copy materialisation) and
--        seize `keepable` lists grow only `roll_pair_transform` -- #317 did not
--        add `fixed_roll` there and this body matches that.
--      * Phase 3 reads the roll_transform `op` (`pair_op`) and folds it into
--        the same 7-arg _rr_trace_step `p_extra` #319 uses for `condition` --
--        a step is either chosen-pair or conditional-advantage, never both --
--        so the Recap renderer can word swap / min / max.
-- ---------------------------------------------------------------------------
create or replace function public.resolve_round(p_round_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_status text;
  v_room_id uuid;
  v_layer integer;
  v_participant_count integer;
  v_roll_count integer;
  v_expected_layer_count integer;

  v_trace jsonb := '[]'::jsonb;
  v_step_index integer := 0;

  v_brewer_id text := null;
  v_brewer_source text := 'default';
  v_no_modifier_gain boolean := false;
  v_tied text[];

  -- per-player working state, parallel arrays indexed 1..n
  v_players text[] := array[]::text[];
  v_rolls integer[] := array[]::integer[];
  v_base numeric[] := array[]::numeric[];
  v_composed numeric[] := array[]::numeric[];
  v_snapshots numeric[] := array[]::numeric[];
  v_effects_json jsonb := '{}'::jsonb;   -- { player_id: [ normalised effect, ... ] }

  -- Phase 1 (Cast-Log resolution) working state
  v_has_counters boolean := false;
  v_negated_groups uuid[] := array[]::uuid[];
  v_redirect_map jsonb := '{}'::jsonb;   -- { card_instance_id::text: new_target_player_id }
  v_clr record;
  v_victim record;
  v_bf record;
  v_t jsonb;

  -- Phase 2 (ward projection) working state (issue #309)
  v_ward_map jsonb := '{}'::jsonb;   -- { player_id: [ { domain, polarity, block_earned_modifier, ward_seq, ward_cast_id, ward_card_name }, ... ] }
  v_ward_hit jsonb;
  v_ward_pol text;
  v_ward_idx integer;
  v_wb_before numeric;
  v_wb_after numeric;
  v_lghm_seq bigint;

  v_row record;
  v_el jsonb;
  v_pid text;
  v_i integer;
  v_local_idx integer;
  v_before numeric;
  v_after numeric;
  v_running numeric;
  v_eff_target text;
  v_disp_kind text;   -- issue #319: Phase 3 branch-aware display kind

  v_has_lghm boolean := false;
  v_lghm_cast record;
  v_high_roll_composed numeric;
  v_lowest_roll integer;

  v_override record;
  v_declared record;

  -- Phase 4b (issue #311) working state
  v_pm_targets text[] := array[]::text[];
  v_pm_running numeric;
  v_pm_row record;

  -- Phase 4b-pre (issue #342) working state
  v_gen integer;
  v_bl record;

  -- issue #351: layer-0 rollers whose roll was frozen (carried over from the
  -- prior generation on scrap because they hold a roll-domain ward). Set by
  -- _rr_scrap_round; empty on generation 0.
  v_frozen_rollers text[] := array[]::text[];
  v_fz_i integer;

  -- Pre-pass (issue #344) working state
  v_wb record;

  -- Phase 0 (issue #316: Effect Invocation) working state
  v_has_invocations boolean := false;
  v_inv record;
  v_src_row record;
  v_cp jsonb;
  v_row_cp jsonb;
  v_inv_instance uuid;
  v_copy_target text;
  v_copy_parent uuid;
  v_copy_role text;
  v_copy_ci jsonb;
begin
  select status, room_id, current_layer, replay_generation, replay_frozen_rollers
    into v_status, v_room_id, v_layer, v_gen, v_frozen_rollers
    from public.rounds
   where id = p_round_id
     for update;

  if v_status is null then
    raise exception 'resolve_round: round not found';
  end if;

  if v_status <> 'closed' then
    raise exception 'resolve_round: round is not closed';
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

  -- ======================================================================
  -- Tie-break reroll layers (layer > 0): no spell logic at all (issue #219).
  -- ======================================================================
  if v_layer > 0 then
    for v_row in
      select r.player_id, r.value, r.modifier_snapshot
        from public.rolls r
       where r.round_id = p_round_id and r.layer = v_layer
       order by r.player_id
    loop
      v_players := v_players || v_row.player_id;
      v_rolls := v_rolls || v_row.value;
      v_snapshots := v_snapshots || v_row.modifier_snapshot::numeric;
    end loop;

    v_tied := public._rr_pick_lowest(v_players, v_rolls, v_snapshots);

    if array_length(v_tied, 1) = 1 then
      return jsonb_build_object(
        'outcome', 'brewer', 'layer', v_layer,
        'brewer_id', v_tied[1], 'brewer_source', 'default',
        'tied_player_ids', null,
        'cups_made', v_participant_count, 'no_modifier_gain', false,
        'trace', '[]'::jsonb
      );
    end if;

    return jsonb_build_object(
      'outcome', 'tie', 'layer', v_layer,
      'brewer_id', null, 'brewer_source', null,
      'tied_player_ids', to_jsonb(v_tied),
      'cups_made', v_participant_count, 'no_modifier_gain', false,
      'trace', '[]'::jsonb
    );
  end if;

  -- ======================================================================
  -- Layer 0.
  -- ======================================================================

  -- Load this layer's rollers into the parallel working arrays.
  for v_row in
    select r.player_id, r.value, r.modifier_snapshot
      from public.rolls r
     where r.round_id = p_round_id and r.layer = 0
     order by r.player_id
  loop
    v_players := v_players || v_row.player_id;
    v_rolls := v_rolls || v_row.value;
    v_base := v_base || v_row.modifier_snapshot::numeric;
    v_composed := v_composed || v_row.modifier_snapshot::numeric;
    v_snapshots := v_snapshots || v_row.modifier_snapshot::numeric;
    v_effects_json := jsonb_set(v_effects_json, array[v_row.player_id], '[]'::jsonb, true);
  end loop;

  -- ------------------------------------------------------------------
  -- issue #351: roll-domain ward carry-over. On scrap for replay (#315),
  -- _rr_scrap_round kept the generation-0 layer-0 roll of every participant
  -- holding an active negative-polarity roll-domain ward (Cast-Iron Kettle is
  -- the charter case) instead of clearing it, so they do not re-roll in
  -- generation 1. Emit one `roll_frozen` Trace step per such roller on their
  -- own row -- before === after, so it never moves the composed value. Gated
  -- on replay_generation > 0, so generation-0 rounds are byte-identical.
  -- ------------------------------------------------------------------
  if coalesce(v_gen, 0) > 0 and array_length(v_frozen_rollers, 1) is not null then
    for v_fz_i in 1 .. coalesce(array_length(v_players, 1), 0) loop
      if v_players[v_fz_i] = any (v_frozen_rollers) then
        v_trace := v_trace || jsonb_build_array(public._rr_trace_step(
          v_step_index,
          'roll_frozen',
          jsonb_build_object(
            'cast_id', null,
            'active_effect_id', null,
            'card_name', null,
            'caster_player_id', null
          ),
          v_players[v_fz_i],
          jsonb_build_object('type', 'roll', 'value', v_rolls[v_fz_i]),
          jsonb_build_object('type', 'roll', 'value', v_rolls[v_fz_i])
        ));
        v_step_index := v_step_index + 1;
      end if;
    end loop;
  end if;

  -- ------------------------------------------------------------------
  -- Phase 0a: Effect Invocation -- materialise Saucerer's Apprentice copies
  -- (issue #316, spec §10). Runs BEFORE Phase 1 so a copied contested_negate
  -- flows through the counter machinery natively. For every live copy (not
  -- itself negated, source not broken, source caster not holding block_copy)
  -- insert one concrete spell_casts row per source effect row -- caster = the
  -- Apprentice, target = the Apprentice caster (a card-targeted counter keeps
  -- the source's parent_cast_id and re-resolves against the same card), all
  -- RNG copied verbatim from cast_inputs.copy_inputs so this stays pure. The
  -- guard on (source_cast_id, is_copy, generation) makes the insert
  -- idempotent, matching the Bitter Leech tick pattern (issue #342).
  -- ------------------------------------------------------------------
  select exists (
    select 1 from public.spell_casts
     where round_id = p_round_id
       and effect_kind is null
       and (cast_inputs ? 'copied_cast_id' or cast_inputs ? 'seized_cast_id')
  ) into v_has_invocations;

  if v_has_invocations then
    for v_inv in select * from public._rr_invocation_resolution(p_round_id) loop
      if v_inv.invocation_kind <> 'copy'
         or v_inv.invocation_negated
         or v_inv.source_broken
         or v_inv.ward_cast_id is not null then
        continue;
      end if;

      if exists (
        select 1 from public.spell_casts
         where round_id = p_round_id
           and source_cast_id = v_inv.invocation_cast_id
           and cast_inputs ? 'is_copy'
           and coalesce(generation, 0) = coalesce(v_gen, 0)
      ) then
        continue;
      end if;

      select card_instance_id into v_inv_instance
        from public.spell_casts where id = v_inv.invocation_cast_id;
      select cast_inputs -> 'copy_inputs' -> 'by_cast' into v_cp
        from public.spell_casts where id = v_inv.invocation_cast_id;
      v_cp := coalesce(v_cp, '{}'::jsonb);

      for v_src_row in
        select id, effect_kind, effect_params, parent_cast_id, reaction_window_id
          from public.spell_casts
         where card_instance_id = v_inv.source_group
         order by seq
      loop
        if v_src_row.effect_kind in ('contested_negate', 'redirect') then
          v_copy_target := null;
          v_copy_parent := v_src_row.parent_cast_id;
          v_copy_role   := 'CARD';
        else
          v_copy_target := v_inv.invocation_caster;
          v_copy_parent := null;
          v_copy_role   := 'CASTER';
        end if;

        -- this source row's fresh RNG, drawn at cast time by
        -- _rr_build_copy_inputs and keyed by the row's own id.
        v_row_cp := coalesce(v_cp -> v_src_row.id::text, '{}'::jsonb);
        v_copy_ci := jsonb_build_object('is_copy', true, 'copy_of_cast_id', v_src_row.id);
        if v_src_row.effect_kind = 'contested_negate' and v_row_cp ? 'dc_d20' then
          v_copy_ci := v_copy_ci
            || jsonb_build_object('dc_d20', (v_row_cp->>'dc_d20')::int, 'dc', (v_row_cp->>'dc')::int);
        elsif v_src_row.effect_kind = 'dice_modifier' and v_row_cp ? 'dice_roll' then
          v_copy_ci := v_copy_ci || jsonb_build_object('dice_roll', (v_row_cp->>'dice_roll')::int);
        elsif v_src_row.effect_kind in ('advantage', 'disadvantage', 'forced_reroll', 'roll_flip', 'roll_swap', 'roll_pair_transform')
              and v_row_cp ? 'roll_transform' then
          v_copy_ci := v_copy_ci || jsonb_build_object('roll_transform', v_row_cp -> 'roll_transform');
        end if;

        insert into public.spell_casts (
          round_id, caster_id, card_instance_id, target_player_id, target_pending,
          effect_kind, effect_params, cast_inputs, parent_cast_id, reaction_window_id,
          target_role, source_cast_id, generation
        )
        values (
          p_round_id, v_inv.invocation_caster, v_inv_instance, v_copy_target, false,
          v_src_row.effect_kind, v_src_row.effect_params, v_copy_ci, v_copy_parent,
          v_src_row.reaction_window_id, v_copy_role, v_inv.invocation_cast_id,
          coalesce(v_gen, 0)
        );
      end loop;
    end loop;
  end if;

  -- ------------------------------------------------------------------
  -- Phase 1: Cast-Log resolution (issue #307/#308).
  -- ------------------------------------------------------------------
  select exists (
    select 1 from public.spell_casts
     where round_id = p_round_id
       and effect_kind in ('contested_negate', 'redirect')
  ) into v_has_counters;

  if v_has_counters then
    v_negated_groups := array[]::uuid[];
    v_redirect_map := '{}'::jsonb;

    drop table if exists _rr_clr_rows;
    create temp table _rr_clr_rows on commit drop as
      select * from public._rr_cast_log_resolution(p_round_id);

    for v_clr in
      select * from _rr_clr_rows
    loop
      if v_clr.counter_kind = 'contested_negate'
         and v_clr.counter_succeeded
         and not v_clr.counter_negated then
        if not (v_clr.victim_group = any (v_negated_groups)) then
          v_negated_groups := v_negated_groups || v_clr.victim_group;
        end if;
      end if;

      if v_clr.redirect_to is not null then
        v_redirect_map := jsonb_set(
          v_redirect_map,
          array[v_clr.victim_cast_id::text],
          to_jsonb(v_clr.redirect_to),
          true
        );
      end if;
    end loop;

    update public.spell_casts
       set negated = (card_instance_id = any (v_negated_groups))
     where round_id = p_round_id;

    update public.spell_casts
       set redirected_to_cast_id = null
     where round_id = p_round_id and redirected_to_cast_id is not null;

    for v_clr in
      select * from _rr_clr_rows
     where redirect_to is not null
    loop
      if not (v_clr.victim_group = any (v_negated_groups)) then
        update public.spell_casts
           set redirected_to_cast_id = v_clr.counter_cast_id
         where id = v_clr.victim_cast_id;
      end if;
    end loop;

    for v_clr in
      select clr.*, sc.name as counter_card_name
        from _rr_clr_rows clr
        join public.spell_casts c on c.id = clr.counter_cast_id
        join public.spell_deck_instances sdi on sdi.id = c.card_instance_id
        join public.spell_cards sc on sc.id = sdi.card_id
       order by clr.counter_seq
    loop
      if v_clr.counter_kind = 'contested_negate' then
        v_trace := v_trace || jsonb_build_array(public._rr_trace_step(
          v_step_index,
          'contested_negate',
          jsonb_build_object(
            'cast_id', to_jsonb(v_clr.counter_cast_id),
            'active_effect_id', null,
            'card_name', to_jsonb(v_clr.counter_card_name),
            'caster_player_id', to_jsonb(v_clr.counter_caster)
          ),
          v_clr.victim_orig_target,
          jsonb_build_object('type', 'status', 'value', 'cast'),
          jsonb_build_object('type', 'status', 'value',
            case
              when v_clr.counter_negated then 'countered'
              when v_clr.counter_backfired then 'backfired'
              when v_clr.counter_succeeded then 'negated target'
              else 'no effect'
            end),
          jsonb_build_object(
            'dc_d20', v_clr.counter_dc_d20,
            'dc', v_clr.counter_dc,
            'outcome', case
              when v_clr.counter_backfired then 'backfired'
              when not v_clr.counter_negated and v_clr.counter_succeeded then 'applied'
              else 'no-op'
            end)
        ));
        v_step_index := v_step_index + 1;
      else
        v_trace := v_trace || jsonb_build_array(public._rr_trace_step(
          v_step_index,
          'redirect',
          jsonb_build_object(
            'cast_id', to_jsonb(v_clr.counter_cast_id),
            'active_effect_id', null,
            'card_name', to_jsonb(v_clr.counter_card_name),
            'caster_player_id', to_jsonb(v_clr.counter_caster)
          ),
          v_clr.redirect_to,
          jsonb_build_object('type', 'target', 'value', v_clr.victim_orig_target),
          jsonb_build_object('type', 'target', 'value',
            case when v_clr.counter_negated then v_clr.victim_orig_target else v_clr.redirect_to end)
        ));
        v_step_index := v_step_index + 1;
      end if;
    end loop;

    for v_victim in
      select distinct on (c.card_instance_id)
             c.card_instance_id as group_id,
             c.effect_kind,
             c.target_player_id,
             c.caster_id,
             sc.name as card_name
        from public.spell_casts c
        join public.spell_deck_instances sdi on sdi.id = c.card_instance_id
        join public.spell_cards sc on sc.id = sdi.card_id
       where c.round_id = p_round_id
         and c.card_instance_id = any (v_negated_groups)
       order by c.card_instance_id, c.seq
    loop
      v_trace := v_trace || jsonb_build_array(public._rr_trace_step(
        v_step_index,
        coalesce(v_victim.effect_kind, 'unknown'),
        jsonb_build_object(
          'cast_id', null,
          'active_effect_id', null,
          'card_name', to_jsonb(v_victim.card_name),
          'caster_player_id', to_jsonb(v_victim.caster_id)
        ),
        v_victim.target_player_id,
        jsonb_build_object('type', 'status', 'value', 'negated'),
        jsonb_build_object('type', 'status', 'value', 'negated'),
        jsonb_build_object('negated', true)
      ));
      v_step_index := v_step_index + 1;
    end loop;
  end if;

  -- ------------------------------------------------------------------
  -- Pre-pass (issue #344): ward-blocked modifier transfers & snapshots.
  --
  -- cast_spell_card stamped a _rr_ward_block_marker on the primary row of a
  -- Chai-nge of Heart / Tea Leaf / Spillage / Bes-Tea cast whose losing (or
  -- copied) side holds a matching ward. Re-assert whole-group negation (Phase
  -- 1 just cleared negated for the round when a counter was present) and emit
  -- one `warded` step per group. The existing negated filters then do the
  -- rest: Phase 4a drops the snapshot rows, Phase 4b's running sum drops the
  -- transfer rows (its target gather keeps them so both sides revert to base),
  -- and _rr_spell_modifier_delta excludes them from every later baseline.
  -- ------------------------------------------------------------------
  update public.spell_casts sc
     set negated = true
    from (
      select distinct card_instance_id
        from public.spell_casts
       where round_id = p_round_id
         and cast_inputs ? 'ward_blocked_by'
    ) g
   where sc.round_id = p_round_id
     and sc.card_instance_id = g.card_instance_id;

  for v_wb in
    select sc.id as cast_id, sc.caster_id,
           sc.cast_inputs ->> 'ward_blocked_by'          as ward_cast_id,
           sc.cast_inputs ->> 'ward_card_name'           as ward_card_name,
           sc.cast_inputs ->> 'ward_target'              as ward_target,
           (sc.cast_inputs ->> 'would_be_before')::numeric as wb_before,
           (sc.cast_inputs ->> 'would_be_after')::numeric  as wb_after,
           scn.name as card_name
      from public.spell_casts sc
      join public.spell_deck_instances sdi on sdi.id = sc.card_instance_id
      join public.spell_cards scn on scn.id = sdi.card_id
     where sc.round_id = p_round_id
       and sc.cast_inputs ? 'ward_blocked_by'
       and sc.cast_inputs ? 'ward_target'
     order by sc.seq
  loop
    v_trace := v_trace || jsonb_build_array(public._rr_trace_step(
      v_step_index,
      'warded',
      jsonb_build_object(
        'cast_id', to_jsonb(v_wb.cast_id),
        'active_effect_id', null,
        'card_name', to_jsonb(v_wb.card_name),
        'caster_player_id', to_jsonb(v_wb.caster_id)
      ),
      v_wb.ward_target,
      jsonb_build_object('type', 'modifier', 'value', v_wb.wb_before),
      jsonb_build_object('type', 'modifier', 'value', v_wb.wb_before),
      jsonb_build_object(
        'blocked_cast_id', to_jsonb(v_wb.cast_id),
        'ward_cast_id', to_jsonb(v_wb.ward_cast_id),
        'ward_card_name', to_jsonb(v_wb.ward_card_name),
        'target', to_jsonb(v_wb.ward_target),
        'would_be_before', v_wb.wb_before,
        'would_be_after', v_wb.wb_after,
        'outcome', 'blocked'
      )
    ));
    v_step_index := v_step_index + 1;
  end loop;

  -- ------------------------------------------------------------------
  -- Phase 0b: Effect Invocation -- seize retarget + copy / seize outcome
  -- (issue #316, spec §10). Runs AFTER Phase 1's counter block, which clears
  -- `negated` for the whole round when a counter is present -- so the seize
  -- collapse-negation of non-kept rows is re-asserted every run, the same way
  -- the #344 Pre-pass re-asserts ward-block negation.
  --
  --   * seize: the seized cast group retargets to its own caster. A fan-out
  --     (same effect_kind + params across N players) collapses to one CASTER
  --     row, the rest negated; a compound card keeps every distinct effect,
  --     each on the caster; already-executed eager roll rows are negated
  --     (Phase 3 unwinds them on the original target -- no re-apply).
  --   * a block_copy ward on the source caster, or a negated / broken-chain
  --     source, makes the copy / seize a no-op -- the card is still burned.
  -- ------------------------------------------------------------------
  if v_has_invocations then
    for v_inv in select * from public._rr_invocation_resolution(p_round_id) loop

      -- ---- block_copy ward: card burned, outcome blocked ----
      if v_inv.ward_cast_id is not null then
        -- clear any cache a prior resolve wrote before the ward was in play
        -- (defensive -- inputs are stable for a closed round, but keep the
        -- derivation and the cache in lock-step regardless).
        update public.spell_casts set seized_by_cast_id = null, copied_cast_id = null
         where round_id = p_round_id
           and (seized_by_cast_id = v_inv.invocation_cast_id or id = v_inv.invocation_cast_id);

        v_trace := v_trace || jsonb_build_array(public._rr_trace_step(
          v_step_index, 'warded',
          jsonb_build_object(
            'cast_id', to_jsonb(v_inv.invocation_cast_id),
            'active_effect_id', null,
            'card_name', to_jsonb(case when v_inv.invocation_kind = 'seize'
                                       then 'Brew-merang' else 'Saucerer''s Apprentice' end),
            'caster_player_id', to_jsonb(v_inv.invocation_caster)),
          coalesce(v_inv.source_caster, v_inv.invocation_caster),
          jsonb_build_object('type', 'status', 'value', 'cast'),
          jsonb_build_object('type', 'status', 'value', 'blocked'),
          jsonb_build_object(
            'blocked_cast_id', to_jsonb(v_inv.invocation_cast_id),
            'ward_cast_id', to_jsonb(v_inv.ward_cast_id),
            'ward_card_name', to_jsonb(v_inv.ward_card_name),
            'target', to_jsonb(coalesce(v_inv.source_caster, v_inv.invocation_caster)),
            'invocation_kind', v_inv.invocation_kind,
            'outcome', 'blocked')));
        v_step_index := v_step_index + 1;
        continue;
      end if;

      -- ---- negated invoker / broken source: no-op, card burned ----
      if v_inv.invocation_negated or v_inv.source_broken then
        update public.spell_casts set seized_by_cast_id = null, copied_cast_id = null
         where round_id = p_round_id
           and (seized_by_cast_id = v_inv.invocation_cast_id or id = v_inv.invocation_cast_id);

        v_trace := v_trace || jsonb_build_array(public._rr_trace_step(
          v_step_index, v_inv.invocation_kind,
          jsonb_build_object(
            'cast_id', to_jsonb(v_inv.invocation_cast_id),
            'active_effect_id', null,
            'card_name', to_jsonb(case when v_inv.invocation_kind = 'seize'
                                       then 'Brew-merang' else 'Saucerer''s Apprentice' end),
            'caster_player_id', to_jsonb(v_inv.invocation_caster)),
          coalesce(v_inv.source_caster, v_inv.invocation_caster),
          jsonb_build_object('type', 'status', 'value', 'cast'),
          jsonb_build_object('type', 'status', 'value', 'no effect'),
          jsonb_build_object(
            'invocation_kind', v_inv.invocation_kind,
            'outcome', 'no-op',
            'reason', case when v_inv.invocation_negated then 'countered' else 'source broken' end)));
        v_step_index := v_step_index + 1;
        continue;
      end if;

      -- ---- live copy: header step (materialised rows resolved in Phase 0a) ----
      if v_inv.invocation_kind = 'copy' then
        update public.spell_casts
           set copied_cast_id = v_inv.source_parent_cast_id
         where id = v_inv.invocation_cast_id;

        v_trace := v_trace || jsonb_build_array(public._rr_trace_step(
          v_step_index, 'copy',
          jsonb_build_object(
            'cast_id', to_jsonb(v_inv.invocation_cast_id),
            'active_effect_id', null,
            'card_name', to_jsonb('Saucerer''s Apprentice'::text),
            'caster_player_id', to_jsonb(v_inv.invocation_caster)),
          v_inv.invocation_caster,
          jsonb_build_object('type', 'status', 'value', 'cast'),
          jsonb_build_object('type', 'status', 'value', 'copied'),
          jsonb_build_object(
            'copied_cast_id', to_jsonb(v_inv.source_parent_cast_id),
            'landed_on', to_jsonb(v_inv.invocation_caster),
            'outcome', 'applied')));
        v_step_index := v_step_index + 1;
        continue;
      end if;

      -- ---- live seize: retarget the seized group to its own caster ----
      if not exists (
        select 1 from public.spell_casts
         where round_id = p_round_id
           and card_instance_id = v_inv.source_group
           and seized_by_cast_id = v_inv.invocation_cast_id
      ) then
        update public.spell_casts sc set
          target_player_id = case when r.rn = 1 and r.keepable
                                  then v_inv.source_caster else sc.target_player_id end,
          target_role      = case when r.rn = 1 and r.keepable
                                  then 'CASTER' else sc.target_role end,
          target_pending   = false,
          negated          = case when r.rn = 1 and r.keepable then sc.negated else true end,
          seized_by_cast_id = v_inv.invocation_cast_id,
          cast_inputs      = case when r.rn = 1 and r.keepable
                                  then coalesce(sc.cast_inputs, '{}'::jsonb)
                                       || jsonb_build_object('seized_kept', true)
                                  else sc.cast_inputs end
        from (
          select id,
                 (effect_kind is not null
                  and effect_kind not in
                    ('advantage', 'disadvantage', 'forced_reroll', 'roll_flip', 'roll_swap', 'roll_pair_transform')) as keepable,
                 row_number() over (partition by effect_kind, effect_params order by seq) as rn
            from public.spell_casts
           where round_id = p_round_id and card_instance_id = v_inv.source_group
        ) r
        where r.id = sc.id;
      end if;

      -- every run: re-assert negation on the non-kept seized rows.
      update public.spell_casts
         set negated = true
       where round_id = p_round_id
         and seized_by_cast_id = v_inv.invocation_cast_id
         and not coalesce((cast_inputs ->> 'seized_kept')::boolean, false);

      v_trace := v_trace || jsonb_build_array(public._rr_trace_step(
        v_step_index, 'seize',
        jsonb_build_object(
          'cast_id', to_jsonb(v_inv.invocation_cast_id),
          'active_effect_id', null,
          'card_name', to_jsonb('Brew-merang'::text),
          'caster_player_id', to_jsonb(v_inv.invocation_caster)),
        v_inv.source_caster,
        jsonb_build_object('type', 'status', 'value', 'cast'),
        jsonb_build_object('type', 'status', 'value', 'seized'),
        jsonb_build_object(
          'seized_by_cast_id', to_jsonb(v_inv.invocation_cast_id),
          'source_caster', to_jsonb(v_inv.source_caster),
          'outcome', 'applied')));
      v_step_index := v_step_index + 1;
    end loop;
  end if;

  -- ------------------------------------------------------------------
  -- Phase 2: ward projection (issue #309).
  --
  -- Load every active ward (spell_active_effects.effect_kind = 'ward')
  -- targeting a layer-0 roller into v_ward_map, keyed by target player, each
  -- carrying its source cast seq (ward_seq -- NULL when projected from a
  -- prior round or seeded). Modifier-domain wards filter Phase 4a / 4c below;
  -- block_earned_modifier suppresses the brewer's tea gain in Phase 5.
  -- Roll-domain wards were already applied as a pre-check in the eager shim
  -- and arrive as `warded` markers on cast_inputs.roll_transform that Phase 3
  -- turns into steps.
  -- ------------------------------------------------------------------
  select coalesce(jsonb_object_agg(t.pid, t.wards), '{}'::jsonb)
    into v_ward_map
    from (
      select sae.target_player_id as pid,
             jsonb_agg(jsonb_build_object(
               'domain', sae.effect_params -> 'domain',
               'polarity', sae.effect_params -> 'polarity',
               'block_earned_modifier', coalesce((sae.effect_params ->> 'block_earned_modifier')::boolean, false),
               -- #310: a ward whose source cast is in an EARLIER round always
               -- counts as earlier-seq than any effect cast this round
               -- (_rr_ward_hit treats a NULL ward_seq as "before every
               -- effect"); only a ward cast in THIS round keeps its real seq,
               -- for correct same-round ordering. This is the same rule
               -- _rr_active_ward_gate already applies via its
               -- `wc.round_id <> p_round_id` short-circuit -- Phase 2 just
               -- reads its own map so it has to encode it here. Behaviour is
               -- unchanged for real rounds: a prior-round ward's seq was
               -- already strictly below every current-round effect seq, and a
               -- carried-forward effect passes ord = NULL regardless.
               'ward_seq', case when wc.round_id = p_round_id then wc.seq else null end,
               'ward_cast_id', sae.source_cast_id,
               'ward_card_name', scw.name
             ) order by sae.created_at) as wards
        from public._rr_active_effects_as_of(v_room_id, p_round_id) sae
        join public.spell_cards scw on scw.id = sae.card_id
        left join public.spell_casts wc on wc.id = sae.source_cast_id
       where sae.room_id = v_room_id
         and sae.effect_kind = 'ward'
         and sae.target_player_id = any (v_players)
       group by sae.target_player_id
    ) t;

  -- ------------------------------------------------------------------
  -- Phase 3: roll-input accounting (issue #306/#308/#309/#317/#318/#319).
  -- issue #317: `fixed_roll` is a pre-roll kind recorded by submit_roll (via
  -- _rr_apply_fixed_roll) into cast_inputs.roll_transform at order 0; its
  -- recorded entry (normal or `warded`) flows through the generic branches
  -- below exactly like the reaction-window transforms.
  -- ------------------------------------------------------------------
  for v_i in 1 .. coalesce(array_length(v_players, 1), 0) loop
    v_pid := v_players[v_i];
    v_running := null;

    for v_row in
      select casts.id as cast_id,
             casts.seq as seq,
             casts.caster_id as caster_id,
             casts.effect_kind as kind,
             casts.negated as is_negated,
             sc.name as card_name,
             (rt.rt ->> 'order')::integer as ord,
             (rt.rt ->> 'op') as pair_op,   -- issue #318: chosen-pair op
             (pe.value ->> 'before')::numeric as p_before,
             (pe.value ->> 'after')::numeric as p_after,
             coalesce((pe.value -> 'warded')::text = 'true', false) as is_warded,
             (pe.value ->> 'would_be_after')::numeric as would_be_after,
             pe.value ->> 'ward_cast_id' as ward_cast_id,
             pe.value ->> 'ward_card_name' as ward_card_name,
             rt.rt -> 'condition' as condition   -- issue #319: conditional advantage
        from public.spell_casts casts
        join public.spell_deck_instances sdi on sdi.id = casts.card_instance_id
        join public.spell_cards sc on sc.id = sdi.card_id
        cross join lateral (select casts.cast_inputs -> 'roll_transform' as rt) rt
        cross join lateral jsonb_array_elements(rt.rt -> 'players') as pe(value)
       where casts.round_id = p_round_id
         and casts.effect_kind in ('advantage', 'disadvantage', 'forced_reroll', 'roll_flip', 'roll_swap', 'fixed_roll', 'roll_pair_transform')
         and casts.cast_inputs ? 'roll_transform'
         and pe.value ->> 'player_id' = v_pid
       order by (rt.rt ->> 'order')::integer, casts.seq
    loop
      -- issue #309: a roll-domain ward pre-empted this transform in the eager
      -- shim -- the roll was not mutated. Emit a `warded` step and keep the
      -- running value unchanged.
      if v_row.is_warded then
        v_before := coalesce(v_running, v_row.p_before);
        v_trace := v_trace || jsonb_build_array(public._rr_trace_step(
          v_step_index,
          'warded',
          jsonb_build_object(
            'cast_id', to_jsonb(v_row.cast_id),
            'active_effect_id', null,
            'card_name', to_jsonb(v_row.card_name),
            'caster_player_id', to_jsonb(v_row.caster_id)
          ),
          v_pid,
          jsonb_build_object('type', 'roll', 'value', v_before),
          jsonb_build_object('type', 'roll', 'value', v_before),
          jsonb_build_object(
            'blocked_cast_id', to_jsonb(v_row.cast_id),
            'ward_cast_id', to_jsonb(v_row.ward_cast_id),
            'ward_card_name', to_jsonb(v_row.ward_card_name),
            'target', to_jsonb(v_pid),
            'would_be_before', v_before,
            'would_be_after', coalesce(v_row.would_be_after, v_before),
            'outcome', 'blocked'
          )
        ));
        v_step_index := v_step_index + 1;
        continue;
      end if;

      -- issue #308: a NEGATED roll transform is logically unwound.
      if v_row.is_negated then
        v_running := coalesce(v_running, v_row.p_before);
        continue;
      end if;

      v_before := coalesce(v_running, v_row.p_before);
      v_after := v_row.p_after;
      v_running := v_after;

      -- issue #319: a conditional-advantage cast (Gambler's Infusion) keeps
      -- effect_kind 'advantage', but the branch its first die selected is
      -- recorded in roll_transform.condition. Name that branch on the step:
      -- 'advantage' / 'disadvantage' for a met threshold, else a zero-impact
      -- 'conditional_advantage' step (before === after).
      v_disp_kind := v_row.kind;
      if v_row.condition is not null then
        v_disp_kind := case v_row.condition ->> 'branch'
          when 'advantage' then 'advantage'
          when 'disadvantage' then 'disadvantage'
          else 'conditional_advantage'
        end;
      end if;

      v_trace := v_trace || jsonb_build_array(public._rr_trace_step(
        v_step_index,
        v_disp_kind,
        jsonb_build_object(
          'cast_id', to_jsonb(v_row.cast_id),
          'active_effect_id', null,
          'card_name', to_jsonb(v_row.card_name),
          'caster_player_id', to_jsonb(v_row.caster_id)
        ),
        v_pid,
        jsonb_build_object('type', 'roll', 'value', v_before),
        jsonb_build_object('type', 'roll', 'value', v_after),
        case
          -- issue #318: carry the chosen-pair op so the Recap renderer can
          -- tell swap / set-both-lower / set-both-higher apart.
          when v_row.pair_op is not null
            then jsonb_build_object('op', v_row.pair_op)
          -- issue #319: conditional advantage names which branch fired.
          when v_row.condition is not null
            then jsonb_build_object('condition', v_row.condition)
          else null
        end
      ));
      v_step_index := v_step_index + 1;
    end loop;

    -- issue #308: backfire re-applies the victim group's eager roll
    -- transforms once more onto the reactor (this player), after their own.
    if v_has_counters then
      for v_bf in
        select c.id as counter_cast_id, csc.name as card_name, c.caster_id,
               c.cast_inputs -> 'backfire' -> 'transforms' as transforms
          from _rr_clr_rows clr
          join public.spell_casts c on c.id = clr.counter_cast_id
          join public.spell_deck_instances csdi on csdi.id = c.card_instance_id
          join public.spell_cards csc on csc.id = csdi.card_id
         where clr.counter_backfired
           and clr.counter_caster = v_pid
         order by clr.counter_seq
      loop
        for v_t in
          select value
            from jsonb_array_elements(coalesce(v_bf.transforms, '[]'::jsonb)) t(value)
           order by (value->>'order')::int
        loop
          v_before := coalesce(v_running, v_rolls[v_i])::numeric;
          v_after := case v_t->>'kind'
            when 'disadvantage' then least(v_before,
              (v_t->'extra_dice'->>0)::numeric, (v_t->'extra_dice'->>1)::numeric)
            when 'advantage' then greatest(v_before,
              (v_t->'extra_dice'->>0)::numeric, (v_t->'extra_dice'->>1)::numeric)
            when 'forced_reroll' then (v_t->'extra_dice'->>0)::numeric
            when 'roll_flip' then 21 - v_before
            else v_before
          end;
          v_running := v_after;

          v_trace := v_trace || jsonb_build_array(public._rr_trace_step(
            v_step_index,
            v_t->>'kind',
            jsonb_build_object(
              'cast_id', to_jsonb(v_bf.counter_cast_id),
              'active_effect_id', null,
              'card_name', to_jsonb(v_bf.card_name),
              'caster_player_id', to_jsonb(v_bf.caster_id)
            ),
            v_pid,
            jsonb_build_object('type', 'roll', 'value', v_before),
            jsonb_build_object('type', 'roll', 'value', v_after),
            jsonb_build_object('backfire', true)
          ));
          v_step_index := v_step_index + 1;
        end loop;
      end loop;
    end if;

    if v_running is not null then
      v_rolls[v_i] := v_running::integer;
    end if;
  end loop;

  -- ------------------------------------------------------------------
  -- Phase 4a: gather modifier-bucket effects, normalise, bucket per
  -- target player in application order (spec section 6).
  -- ------------------------------------------------------------------
  for v_row in
    select eff.target_player_id, eff.group_id, eff.effect_kind, eff.effect_params, eff.cast_inputs,
           eff.cast_id, eff.active_effect_id, eff.card_name, eff.caster_player_id, eff.ord
      from (
        select casts.target_player_id,
               casts.card_instance_id as group_id,
               casts.effect_kind,
               casts.effect_params,
               casts.cast_inputs,
               casts.id as cast_id,
               null::uuid as active_effect_id,
               sc.name as card_name,
               casts.caster_id as caster_player_id,
               casts.seq as ord,
               casts.cast_at as ts
          from public.spell_casts casts
          join public.spell_deck_instances sdi on sdi.id = casts.card_instance_id
          join public.spell_cards sc on sc.id = sdi.card_id
         where casts.round_id = p_round_id
           and casts.target_pending = false
           and casts.negated = false
           and casts.effect_kind in
             ('flat_modifier', 'dice_modifier', 'modifier_multiplier', 'set_modifier')
           and sc.duration_rounds is null
        union all
        select sae.target_player_id,
               null::uuid as group_id,
               sae.effect_kind,
               sae.effect_params,
               null::jsonb as cast_inputs,
               null::uuid as cast_id,
               sae.id as active_effect_id,
               sc.name as card_name,
               sae.caster_id as caster_player_id,
               null::bigint as ord,
               sae.created_at as ts
          from public._rr_active_effects_as_of(v_room_id, p_round_id) sae
          join public.spell_cards sc on sc.id = sae.card_id
         where sae.room_id = v_room_id
           and sae.effect_kind in
             ('flat_modifier', 'dice_modifier', 'modifier_multiplier', 'set_modifier')
      ) eff
     order by eff.ord asc nulls first, eff.ts asc
  loop
    v_eff_target := coalesce(
      case when v_row.cast_id is not null
        then v_redirect_map ->> v_row.cast_id::text
      end,
      v_row.target_player_id
    );

    if not (v_eff_target = any (v_players)) then
      continue;
    end if;

    v_el := jsonb_build_object(
      'ord', coalesce(v_row.ord, 0),
      'kind', v_row.effect_kind,
      'cast_id', v_row.cast_id,
      'active_effect_id', v_row.active_effect_id,
      'card_name', v_row.card_name,
      'caster_player_id', v_row.caster_player_id,
      'target_player', v_eff_target
    );

    if v_row.effect_kind = 'flat_modifier' then
      v_el := v_el || jsonb_build_object('flat', coalesce((v_row.effect_params->>'delta')::numeric, 0));
    elsif v_row.effect_kind = 'dice_modifier' then
      -- #312: dice_modifier's flat contribution is the recorded dice_roll
      -- (raw, unsigned) * sign. An unrolled Pending Spell Die (no dice_roll
      -- key) contributes 0 -- resolve_round never runs with one outstanding
      -- (get_current_layer_rolls_if_complete gates on it, migration 0079).
      v_el := v_el || jsonb_build_object('flat',
        case
          when v_row.cast_inputs ? 'dice_roll'
            then (v_row.cast_inputs->>'dice_roll')::numeric
                 * coalesce((v_row.effect_params->>'sign')::numeric, 1)
          else 0
        end);
    elsif v_row.effect_kind = 'modifier_multiplier' then
      v_el := v_el || jsonb_build_object('mult', coalesce((v_row.effect_params->>'multiplier')::numeric, 1));
    elsif v_row.effect_kind = 'set_modifier' then
      v_el := v_el || jsonb_build_object('set', coalesce((v_row.effect_params->>'value')::numeric, 0));
    end if;

    -- issue #309: ward filter (Phase 2). Drop a modifier-domain effect whose
    -- computed polarity matches an EARLIER-SEQ ward on its effective target;
    -- emit a `warded` step instead of bucketing it. v_row.ord is the cast
    -- seq (NULL for a carried-forward persistent effect -- _rr_ward_hit then
    -- treats every ward as earlier).
    if v_ward_map ? v_eff_target then
      v_ward_idx := array_position(v_players, v_eff_target);
      v_ward_pol := public._rr_el_polarity(v_el, v_base[v_ward_idx]);
      v_ward_hit := public._rr_ward_hit(v_ward_map, v_eff_target, 'modifier', v_ward_pol, v_row.ord);

      if v_ward_hit is not null then
        v_wb_before := v_base[v_ward_idx];
        v_wb_after := public._rr_compose_modifier(v_base[v_ward_idx], jsonb_build_array(v_el));
        v_trace := v_trace || jsonb_build_array(public._rr_trace_step(
          v_step_index,
          'warded',
          jsonb_build_object(
            'cast_id', v_el -> 'cast_id',
            'active_effect_id', v_el -> 'active_effect_id',
            'card_name', v_el -> 'card_name',
            'caster_player_id', v_el -> 'caster_player_id'
          ),
          v_eff_target,
          jsonb_build_object('type', 'modifier', 'value', v_wb_before),
          jsonb_build_object('type', 'modifier', 'value', v_wb_after),
          jsonb_build_object(
            'blocked_cast_id', v_el -> 'cast_id',
            'ward_cast_id', v_ward_hit -> 'ward_cast_id',
            'ward_card_name', v_ward_hit -> 'ward_card_name',
            'target', to_jsonb(v_eff_target),
            'would_be_before', v_wb_before,
            'would_be_after', v_wb_after,
            'outcome', 'blocked'
          )
        ));
        v_step_index := v_step_index + 1;
        v_ward_hit := null;
        continue;
      end if;
      v_ward_hit := null;
    end if;

    v_effects_json := jsonb_set(
      v_effects_json,
      array[v_eff_target],
      (v_effects_json -> v_eff_target) || jsonb_build_array(v_el),
      true
    );
  end loop;

  -- issue #308: backfire re-buckets every lazy modifier row of a backfired
  -- counter's victim group onto the reactor.
  if v_has_counters then
    for v_bf in
      select clr.counter_cast_id, clr.counter_caster, clr.counter_seq,
             csc.name as counter_card_name, c.caster_id as counter_caster_id,
             pr.id as parent_row_id, pr.effect_kind as pr_kind,
             pr.effect_params as pr_params,
             c.cast_inputs -> 'backfire' -> 'dice_rolls' as dice_rolls
        from _rr_clr_rows clr
        join public.spell_casts c on c.id = clr.counter_cast_id
        join public.spell_deck_instances csdi on csdi.id = c.card_instance_id
        join public.spell_cards csc on csc.id = csdi.card_id
        join public.spell_casts pr on pr.card_instance_id = clr.victim_group
         and pr.effect_kind in
           ('flat_modifier', 'dice_modifier', 'modifier_multiplier', 'set_modifier')
       where clr.counter_backfired
       order by clr.counter_seq, pr.seq
    loop
      if not (v_bf.counter_caster = any (v_players)) then
        continue;
      end if;

      v_el := jsonb_build_object(
        'ord', v_bf.counter_seq,
        'kind', v_bf.pr_kind,
        'cast_id', v_bf.counter_cast_id,
        'active_effect_id', null,
        'card_name', v_bf.counter_card_name,
        'caster_player_id', v_bf.counter_caster_id,
        'target_player', v_bf.counter_caster,
        'backfire', true
      );

      if v_bf.pr_kind = 'flat_modifier' then
        v_el := v_el || jsonb_build_object('flat', coalesce((v_bf.pr_params->>'delta')::numeric, 0));
      elsif v_bf.pr_kind = 'dice_modifier' then
        v_el := v_el || jsonb_build_object('flat',
          coalesce((v_bf.dice_rolls ->> v_bf.parent_row_id::text)::numeric, 0)
          * coalesce((v_bf.pr_params->>'sign')::numeric, 1));
      elsif v_bf.pr_kind = 'modifier_multiplier' then
        v_el := v_el || jsonb_build_object('mult', coalesce((v_bf.pr_params->>'multiplier')::numeric, 1));
      elsif v_bf.pr_kind = 'set_modifier' then
        v_el := v_el || jsonb_build_object('set', coalesce((v_bf.pr_params->>'value')::numeric, 0));
      end if;

      -- issue #309: ward filter also applies to a backfired counter's
      -- re-bucketed rows landing on the reactor (spec §8).
      if v_ward_map ? v_bf.counter_caster then
        v_ward_idx := array_position(v_players, v_bf.counter_caster);
        v_ward_pol := public._rr_el_polarity(v_el, v_base[v_ward_idx]);
        v_ward_hit := public._rr_ward_hit(v_ward_map, v_bf.counter_caster, 'modifier', v_ward_pol, v_bf.counter_seq);

        if v_ward_hit is not null then
          v_wb_before := v_base[v_ward_idx];
          v_wb_after := public._rr_compose_modifier(v_base[v_ward_idx], jsonb_build_array(v_el));
          v_trace := v_trace || jsonb_build_array(public._rr_trace_step(
            v_step_index,
            'warded',
            jsonb_build_object(
              'cast_id', v_el -> 'cast_id',
              'active_effect_id', null,
              'card_name', v_el -> 'card_name',
              'caster_player_id', v_el -> 'caster_player_id'
            ),
            v_bf.counter_caster,
            jsonb_build_object('type', 'modifier', 'value', v_wb_before),
            jsonb_build_object('type', 'modifier', 'value', v_wb_after),
            jsonb_build_object(
              'blocked_cast_id', v_el -> 'cast_id',
              'ward_cast_id', v_ward_hit -> 'ward_cast_id',
              'ward_card_name', v_ward_hit -> 'ward_card_name',
              'target', to_jsonb(v_bf.counter_caster),
              'would_be_before', v_wb_before,
              'would_be_after', v_wb_after,
              'backfire', true,
              'outcome', 'blocked'
            )
          ));
          v_step_index := v_step_index + 1;
          v_ward_hit := null;
          continue;
        end if;
        v_ward_hit := null;
      end if;

      v_effects_json := jsonb_set(
        v_effects_json,
        array[v_bf.counter_caster],
        (v_effects_json -> v_bf.counter_caster) || jsonb_build_array(v_el),
        true
      );
    end loop;
  end if;

  -- Compose each player's final modifier, and emit one Trace step per
  -- effect with a running before/after over the prefix up to it.
  for v_i in 1 .. coalesce(array_length(v_players, 1), 0) loop
    v_pid := v_players[v_i];
    v_after := v_base[v_i];

    for v_local_idx, v_el in
      select o, value
        from jsonb_array_elements(v_effects_json -> v_pid) with ordinality as e(value, o)
       order by o
    loop
      v_before := v_after;
      v_after := public._rr_compose_modifier(
        v_base[v_i],
        (select coalesce(jsonb_agg(value order by o), '[]'::jsonb)
           from jsonb_array_elements(v_effects_json -> v_pid) with ordinality as e(value, o)
          where o <= v_local_idx)
      );

      v_trace := v_trace || jsonb_build_array(public._rr_trace_step(
        v_step_index,
        v_el ->> 'kind',
        jsonb_build_object(
          'cast_id', v_el -> 'cast_id',
          'active_effect_id', v_el -> 'active_effect_id',
          'card_name', v_el -> 'card_name',
          'caster_player_id', v_el -> 'caster_player_id'
        ),
        v_pid,
        jsonb_build_object('type', 'modifier', 'value', v_before),
        jsonb_build_object('type', 'modifier', 'value', v_after),
        case when v_el ? 'backfire'
          then jsonb_build_object('backfire', true)
          else '{}'::jsonb
        end
      ));
      v_step_index := v_step_index + 1;
    end loop;

    v_composed[v_i] := v_after;
  end loop;

  -- ------------------------------------------------------------------
  -- Phase 4c: lowest_gains_highest_modifier (Broken Biscuit).
  -- ------------------------------------------------------------------
  select true into v_has_lghm
    from public.spell_casts casts
    join public.spell_reaction_windows w on w.id = casts.reaction_window_id
   where w.round_id = p_round_id and w.layer = 0
     and casts.effect_kind = 'lowest_gains_highest_modifier'
     and casts.negated = false
   limit 1;

  if coalesce(v_has_lghm, false) and coalesce(array_length(v_players, 1), 0) > 0 then
    select casts.id as id, casts.seq as seq, casts.caster_id as caster_id, sc.name as name
      into v_lghm_cast
      from public.spell_casts casts
      join public.spell_reaction_windows w on w.id = casts.reaction_window_id
      join public.spell_deck_instances sdi on sdi.id = casts.card_instance_id
      join public.spell_cards sc on sc.id = sdi.card_id
     where w.round_id = p_round_id and w.layer = 0
       and casts.effect_kind = 'lowest_gains_highest_modifier'
       and casts.negated = false
     order by casts.seq
     limit 1;
    v_lghm_seq := v_lghm_cast.seq;

    v_lowest_roll := (select min(x) from unnest(v_rolls) x);

    select v_composed[array_position(v_players, t.pid)]
      into v_high_roll_composed
      from (
        select v_players[i] as pid
          from generate_subscripts(v_players, 1) i
         order by v_rolls[i] desc, v_players[i]
         limit 1
      ) t;

    for v_i in 1 .. array_length(v_players, 1) loop
      if v_rolls[v_i] = v_lowest_roll then
        -- issue #309: a warded tied-lowest roller is excluded from the lift
        -- (lowest_gains_highest_modifier is statically positive). Others are
        -- still lifted. The lghm cast is a reaction, so its seq is after any
        -- pre-roll ward.
        v_ward_hit := public._rr_ward_hit(v_ward_map, v_players[v_i], 'modifier', 'positive', v_lghm_seq);
        if v_ward_hit is not null then
          v_trace := v_trace || jsonb_build_array(public._rr_trace_step(
            v_step_index,
            'warded',
            jsonb_build_object(
              'cast_id', to_jsonb(v_lghm_cast.id),
              'active_effect_id', null,
              'card_name', to_jsonb(v_lghm_cast.name),
              'caster_player_id', to_jsonb(v_lghm_cast.caster_id)
            ),
            v_players[v_i],
            jsonb_build_object('type', 'modifier', 'value', v_composed[v_i]),
            jsonb_build_object('type', 'modifier', 'value', v_composed[v_i]),
            jsonb_build_object(
              'blocked_cast_id', to_jsonb(v_lghm_cast.id),
              'ward_cast_id', v_ward_hit -> 'ward_cast_id',
              'ward_card_name', v_ward_hit -> 'ward_card_name',
              'target', to_jsonb(v_players[v_i]),
              'would_be_before', v_composed[v_i],
              'would_be_after', v_high_roll_composed,
              'outcome', 'blocked'
            )
          ));
          v_step_index := v_step_index + 1;
          v_ward_hit := null;
          continue;
        end if;

        v_before := v_composed[v_i];
        v_after := v_high_roll_composed;
        v_composed[v_i] := v_after;

        v_trace := v_trace || jsonb_build_array(public._rr_trace_step(
          v_step_index,
          'lowest_gains_highest_modifier',
          jsonb_build_object(
            'cast_id', to_jsonb(v_lghm_cast.id),
            'active_effect_id', null,
            'card_name', to_jsonb(v_lghm_cast.name),
            'caster_player_id', to_jsonb(v_lghm_cast.caster_id)
          ),
          v_players[v_i],
          jsonb_build_object('type', 'modifier', 'value', v_before),
          jsonb_build_object('type', 'modifier', 'value', v_after)
        ));
        v_step_index := v_step_index + 1;
      end if;
    end loop;
  end if;

  -- ------------------------------------------------------------------
  -- Phase 4b: persistent modifier delta projection (issue #311, spec §9).
  --
  -- Spec §6 numbers this "4b" (adjacent to modifier composition), but it is
  -- coded here, after Phase 4c: the persistent rest-of-day delta is
  -- independent of the round-composed modifier and of 4c's in-place lift of
  -- v_composed, so ordering relative to 4a/4c is immaterial and running last
  -- avoids interleaving with the composed-array walk.
  --
  -- For every player targeted by a non-negated persistent_modifier_transfer
  -- or persistent_modifier_spend cast in THIS round, set the materialized
  -- room_players.modifier cache to base + rest-of-day spell delta and emit one
  -- Trace step per cast with a deterministic running before -> after. Players
  -- not touched by a transfer this round keep their existing modifier -- every
  -- non-spell writer (brewer gain, adjustments, admin tools) and Kettle
  -- Crash's imperative reset stay authoritative for them.
  --
  -- The recompute is absolute (base + full delta), so re-running resolve_round
  -- over the same inputs reproduces the same room_players.modifier and the
  -- same steps. The per-step `before` is derived from base + the delta of
  -- earlier-seq matching casts, never from the live room_players.modifier, so
  -- it does not drift on a second run.
  --
  -- ADR 0005 note: a transfer's `delta` is a cast-time snapshot of a mutable
  -- room_players.modifier (WILD branch 3/5 -- see cast_spell_card). The value
  -- is recorded in the Cast Log, so a replay reproduces it; the swap outcome
  -- is path-dependent on cast timing, the same grudging exception the ADR
  -- grants the eager shim. Within this slice only one snapshot-taking cast per
  -- round is reachable (a single Wild Brew Surge instance in the deck), so no
  -- same-round transfer reads another's not-yet-projected delta.
  -- ------------------------------------------------------------------
  -- Phase 4b-pre (issue #342): Bitter Leech per-round tick synthesis.
  --
  -- Each still-live Bitter Leech active effect (a persistent_modifier_transfer
  -- row carrying a 'per_round_delta') projects one -per_round_delta /
  -- +per_round_delta persistent_modifier_transfer pair into THIS round's Cast
  -- Log -- the target loses, the caster gains. The pair then flows through the
  -- ordinary Phase 4b projection and _rr_spell_modifier_delta /
  -- get_modifier_breakdown exactly like a Chai-nge / WILD transfer, so the
  -- breakdown reconciles for free. Written once per (round, source cast): a
  -- re-resolve finds the tick already present and skips the insert, and the
  -- absolute recompute below reproduces the same room_players.modifier.
  -- Liveness (cast round + next 2 rounds, then stop) is
  -- _rr_active_effects_as_of's call, off the card's duration_rounds = 3.
  for v_bl in
    select sae.source_cast_id,
           sae.target_player_id as victim_id,
           sae.caster_id        as beneficiary_id,
           coalesce((sae.effect_params ->> 'per_round_delta')::numeric, 1) as per_round_delta,
           src.card_instance_id
      from public._rr_active_effects_as_of(v_room_id, p_round_id) sae
      join public.spell_casts src on src.id = sae.source_cast_id
     where sae.room_id = v_room_id
       and sae.effect_kind = 'persistent_modifier_transfer'
       and sae.effect_params ? 'per_round_delta'
  loop
    if exists (
      select 1 from public.spell_casts t
       where t.round_id = p_round_id
         and t.source_cast_id = v_bl.source_cast_id
         and coalesce((t.cast_inputs ->> 'bitter_leech_tick')::boolean, false) = true
         -- generation-scoped like _rr_spell_modifier_delta (0085): a replay
         -- (#315) that bumps the round's replay_generation must re-emit the
         -- tick for the new generation, not skip on the prior one's rows.
         and coalesce(t.generation, 0) = coalesce(v_gen, 0)
    ) then
      continue;
    end if;

    insert into public.spell_casts (
      round_id, caster_id, card_instance_id, target_player_id,
      effect_kind, effect_params, cast_inputs, source_cast_id, generation
    )
    values (
      p_round_id, v_bl.beneficiary_id, v_bl.card_instance_id, v_bl.victim_id,
      'persistent_modifier_transfer', jsonb_build_object('delta', -v_bl.per_round_delta),
      jsonb_build_object('bitter_leech_tick', true), v_bl.source_cast_id, coalesce(v_gen, 0)
    );

    insert into public.spell_casts (
      round_id, caster_id, card_instance_id, target_player_id,
      effect_kind, effect_params, cast_inputs, source_cast_id, generation
    )
    values (
      p_round_id, v_bl.beneficiary_id, v_bl.card_instance_id, v_bl.beneficiary_id,
      'persistent_modifier_transfer', jsonb_build_object('delta', v_bl.per_round_delta),
      jsonb_build_object('bitter_leech_tick', true), v_bl.source_cast_id, coalesce(v_gen, 0)
    );
  end loop;

  -- Pre-pass (issue #344): a Bitter Leech tick landing on a warded victim is
  -- skipped -- both synthesised rows are negated, so the pair no-ops this
  -- round while the target gather below still reverts the victim's cache.
  -- Re-evaluated every round off the live ward map (Phase 2), so a later tick
  -- after the ward expires still applies. Runs over freshly synthesised AND
  -- pre-existing tick rows so a re-resolve re-asserts the same negation.
  for v_bl in
    select t.source_cast_id, t.target_player_id as victim_id
      from public.spell_casts t
     where t.round_id = p_round_id
       and coalesce((t.cast_inputs ->> 'bitter_leech_tick')::boolean, false) = true
       and coalesce((t.effect_params ->> 'delta')::numeric, 0) < 0
       and coalesce(t.generation, 0) = coalesce(v_gen, 0)
     group by t.source_cast_id, t.target_player_id
  loop
    if not (v_bl.victim_id = any (v_players)) then
      continue;
    end if;

    v_ward_hit := public._rr_ward_hit(v_ward_map, v_bl.victim_id, 'modifier', 'negative', null);
    if v_ward_hit is null then
      continue;
    end if;

    update public.spell_casts
       set negated = true
     where round_id = p_round_id
       and source_cast_id = v_bl.source_cast_id
       and coalesce((cast_inputs ->> 'bitter_leech_tick')::boolean, false) = true
       and coalesce(generation, 0) = coalesce(v_gen, 0);

    -- Bitter Leech's per_round_delta is always 1 (cast_spell_card, issue #342).
    v_wb_before := public._rr_base_modifier(v_room_id, v_bl.victim_id)
                 + public._rr_spell_modifier_delta(v_room_id, v_bl.victim_id, p_round_id);

    v_trace := v_trace || jsonb_build_array(public._rr_trace_step(
      v_step_index,
      'warded',
      jsonb_build_object(
        'cast_id', null,
        'active_effect_id', null,
        'card_name', to_jsonb('Bitter Leech'::text),
        'caster_player_id', null
      ),
      v_bl.victim_id,
      jsonb_build_object('type', 'modifier', 'value', v_wb_before),
      jsonb_build_object('type', 'modifier', 'value', v_wb_before),
      jsonb_build_object(
        'blocked_cast_id', null,
        'ward_cast_id', v_ward_hit -> 'ward_cast_id',
        'ward_card_name', v_ward_hit -> 'ward_card_name',
        'target', to_jsonb(v_bl.victim_id),
        'would_be_before', v_wb_before,
        'would_be_after', v_wb_before - 1,
        'outcome', 'blocked'
      )
    ));
    v_step_index := v_step_index + 1;
    v_ward_hit := null;
  end loop;

  -- issue #342: NO negated filter here -- a fully-negated Chai-nge (both
  -- sibling rows flipped by Phase 1) must still bring both players into the
  -- recompute so their caches revert to base + other-round deltas. The inner
  -- loop below still filters negated rows out of the running sum.
  select coalesce(array_agg(distinct sc.target_player_id), array[]::text[])
    into v_pm_targets
    from public.spell_casts sc
   where sc.round_id = p_round_id
     and sc.effect_kind in ('persistent_modifier_transfer', 'persistent_modifier_spend')
     and sc.target_player_id is not null;

  foreach v_pid in array v_pm_targets loop
    -- deterministic starting point: base + this player's transfer/spend delta
    -- from every OTHER round of the current generation.
    v_pm_running := public._rr_base_modifier(v_room_id, v_pid)
                  + public._rr_spell_modifier_delta(v_room_id, v_pid, p_round_id);

    for v_pm_row in
      select sc.id as cast_id, sc.seq, sc.caster_id, sc.effect_kind,
             coalesce((sc.effect_params ->> 'delta')::numeric, 0) as delta,
             scn.name as card_name
        from public.spell_casts sc
        join public.spell_deck_instances sdi on sdi.id = sc.card_instance_id
        join public.spell_cards scn on scn.id = sdi.card_id
       where sc.round_id = p_round_id
         and sc.target_player_id = v_pid
         and sc.effect_kind in ('persistent_modifier_transfer', 'persistent_modifier_spend')
         and coalesce(sc.negated, false) = false
         -- issue #342: skip the Bitter Leech anchor (no 'delta') and match
         -- _rr_spell_modifier_delta's generation filter so the running sum and
         -- the baseline it starts from never disagree after a replay (#315).
         and sc.effect_params ? 'delta'
         and coalesce(sc.generation, 0) = coalesce(v_gen, 0)
       order by sc.seq
    loop
      v_before := v_pm_running;
      v_pm_running := v_pm_running + v_pm_row.delta;

      v_trace := v_trace || jsonb_build_array(public._rr_trace_step(
        v_step_index,
        v_pm_row.effect_kind,
        jsonb_build_object(
          'cast_id', to_jsonb(v_pm_row.cast_id),
          'active_effect_id', null,
          'card_name', to_jsonb(v_pm_row.card_name),
          'caster_player_id', to_jsonb(v_pm_row.caster_id)
        ),
        v_pid,
        jsonb_build_object('type', 'modifier', 'value', v_before),
        jsonb_build_object('type', 'modifier', 'value', v_pm_running),
        jsonb_build_object('delta', v_pm_row.delta, 'rest_of_day', true)
      ));
      v_step_index := v_step_index + 1;
    end loop;

    update public.room_players
       set modifier = v_pm_running::integer
     where room_id = v_room_id and player_id = v_pid;
  end loop;

  -- ------------------------------------------------------------------
  -- Phase 5: brewer selection. Precedence declared > override > default.
  -- ------------------------------------------------------------------
  for v_declared in
    select sae.id, (sae.effect_params->>'number')::integer as number,
           sae.caster_id, sc.name as card_name
      from public._rr_active_effects_as_of(v_room_id, p_round_id) sae
      join public.spell_cards sc on sc.id = sae.card_id
     where sae.room_id = v_room_id
       and sae.effect_kind = 'declared_number_tea_maker'
     order by sae.created_at
  loop
    select r.player_id into v_pid
      from public.rolls r
     where r.round_id = p_round_id and r.layer = 0 and r.value = v_declared.number
     limit 1;

    if v_pid is not null then
      v_brewer_id := v_pid;
      v_brewer_source := 'declared_number';
      v_trace := v_trace || jsonb_build_array(public._rr_trace_step(
        v_step_index,
        'declared_number_tea_maker',
        jsonb_build_object(
          'cast_id', null,
          'active_effect_id', to_jsonb(v_declared.id),
          'card_name', to_jsonb(v_declared.card_name),
          'caster_player_id', to_jsonb(v_declared.caster_id)
        ),
        v_brewer_id,
        jsonb_build_object('type', 'status', 'value', 'pending'),
        jsonb_build_object('type', 'status', 'value', 'brewer')
      ));
      v_step_index := v_step_index + 1;
      exit;
    end if;
  end loop;

  if v_brewer_id is null then
    select casts.effect_params->>'mode' as mode,
           coalesce((casts.effect_params->>'no_modifier_gain')::boolean, false) as no_modifier_gain,
           casts.target_player_id as chosen_player_id,
           casts.target_pending as target_pending,
           casts.id as cast_id,
           casts.caster_id as caster_id,
           sc.name as card_name
      into v_override
      from public.spell_casts casts
      join public.spell_deck_instances sdi on sdi.id = casts.card_instance_id
      join public.spell_cards sc on sc.id = sdi.card_id
     where casts.round_id = p_round_id
       and casts.effect_kind = 'tea_maker_override'
       and casts.negated = false
     order by casts.cast_at desc, casts.seq desc
     limit 1;

    if v_override.mode is not null and not coalesce(v_override.target_pending, false) then
      if v_override.mode = 'chosen' then
        v_brewer_id := v_override.chosen_player_id;
      elsif v_override.mode = 'highest_roll' then
        select v_players[i] into v_brewer_id
          from generate_subscripts(v_players, 1) i
         order by v_rolls[i] desc, v_players[i]
         limit 1;
      else
        select r.player_id into v_brewer_id
          from public.rolls r
         where r.round_id = p_round_id and r.layer = 0
         order by r.modifier_snapshot desc, r.player_id
         limit 1;
      end if;

      v_no_modifier_gain := v_override.no_modifier_gain;
      v_brewer_source := 'tea_maker_override:' || v_override.mode;

      v_trace := v_trace || jsonb_build_array(public._rr_trace_step(
        v_step_index,
        'tea_maker_override',
        jsonb_build_object(
          'cast_id', to_jsonb(v_override.cast_id),
          'active_effect_id', null,
          'card_name', to_jsonb(v_override.card_name),
          'caster_player_id', to_jsonb(v_override.caster_id)
        ),
        v_brewer_id,
        jsonb_build_object('type', 'status', 'value', 'pending'),
        jsonb_build_object('type', 'status', 'value',
          case when v_no_modifier_gain then 'brewer (no modifier gain)' else 'brewer' end)
      ));
      v_step_index := v_step_index + 1;
    end if;
  end if;

  if v_brewer_id is null then
    v_tied := public._rr_pick_lowest(v_players, v_rolls, v_composed);

    if array_length(v_tied, 1) > 1 then
      update public.rounds set resolution_trace = v_trace where id = p_round_id;
      return jsonb_build_object(
        'outcome', 'tie', 'layer', 0,
        'brewer_id', null, 'brewer_source', null,
        'tied_player_ids', to_jsonb(v_tied),
        'cups_made', v_participant_count, 'no_modifier_gain', false,
        'trace', v_trace
      );
    end if;

    v_brewer_id := v_tied[1];
    v_brewer_source := 'default';
  end if;

  -- issue #309: a block_earned_modifier ward on the selected brewer (Eternal
  -- Steep) zeroes their tea-making modifier gain. resolve_round(uuid, text,
  -- integer, boolean) turns no_modifier_gain into a zero brewer gain. This is
  -- a property of the ward, not a competing cast, so it applies regardless of
  -- seq.
  if v_brewer_id is not null then
    select w.value into v_ward_hit
      from jsonb_array_elements(coalesce(v_ward_map -> v_brewer_id, '[]'::jsonb)) w
     where coalesce((w.value ->> 'block_earned_modifier')::boolean, false)
     limit 1;

    if v_ward_hit is not null then
      if not v_no_modifier_gain then
        v_trace := v_trace || jsonb_build_array(public._rr_trace_step(
          v_step_index,
          'warded',
          jsonb_build_object(
            'cast_id', null,
            'active_effect_id', null,
            'card_name', v_ward_hit -> 'ward_card_name',
            'caster_player_id', null
          ),
          v_brewer_id,
          jsonb_build_object('type', 'status', 'value', 'brewer'),
          jsonb_build_object('type', 'status', 'value', 'brewer (no modifier gain)'),
          jsonb_build_object(
            'blocked_cast_id', null,
            'ward_cast_id', v_ward_hit -> 'ward_cast_id',
            'ward_card_name', v_ward_hit -> 'ward_card_name',
            'target', to_jsonb(v_brewer_id),
            'would_be_before', to_jsonb('brewer'::text),
            'would_be_after', to_jsonb('brewer (no modifier gain)'::text),
            'outcome', 'blocked'
          )
        ));
        v_step_index := v_step_index + 1;
      end if;
      v_no_modifier_gain := true;
      v_ward_hit := null;
    end if;
  end if;

  update public.rounds set resolution_trace = v_trace where id = p_round_id;

  return jsonb_build_object(
    'outcome', 'brewer', 'layer', 0,
    'brewer_id', v_brewer_id, 'brewer_source', v_brewer_source,
    'tied_player_ids', null,
    'cups_made', v_participant_count, 'no_modifier_gain', v_no_modifier_gain,
    'trace', v_trace
  );
end;
$$;

revoke execute on function public.resolve_round(uuid) from public, anon;
grant execute on function public.resolve_round(uuid) to authenticated;
