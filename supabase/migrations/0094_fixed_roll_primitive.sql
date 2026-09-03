-- Tier A primitive 1 -- Fixed-roll (issue #317, spec #302 section 12 / ADR 0005).
--
-- Migration number: this branch merged rebuild/effect-resolver after PR #356
-- (issue #316, Effect Invocation) landed migration 0093, so this slice is
-- 0094. Sibling slices #318 / #319 (PR #358, migration 0095) race the same
-- numbers -- re-check and renumber to sit after master's current highest at
-- the #303 integrate-and-verify gate.
--
-- What changes
-- ------------
-- A `fixed_roll` effect kind sets one player's layer-0 d20 to a card-configured
-- constant and records the before->after into spell_casts.cast_inputs under the
-- existing `roll_transform` key, so resolve_round Phase 3 adopts it with no
-- recomputation -- exactly the eager-shim pattern the other five roll-input
-- kinds use (issue #306). It unlocks two Action cards, both un-benched here:
--
--   * Steady Hand      (common, SELF)     -- "treat your d20 as a 10"  -> value 10
--   * Sleeping Camomile (rare,  OPPONENT) -- "counts as a natural 1"   -> value 1
--
--   cast_inputs -> 'roll_transform' = {
--     "kind":    "fixed_roll",
--     "order":   0,                    -- earliest: it replaces the die; a
--                                        later flip / swap chains off it,
--     "players": [ { "player_id": <text>, "before": <int>, "after": <int>
--                    -- warded: "warded": true, "would_be_after": <int>,
--                    --         "ward_cast_id": <uuid>, "ward_card_name": <text>,
--                    --         "before" == "after" (unmutated roll) } ]
--   }
--
-- Recording point: submit_roll / submit_roll_as (like advantage / disadvantage
-- -- fixed_roll is a pre-roll Action kind, not a reaction-window one), factored
-- into the shared helper `_rr_apply_fixed_roll`. The affected player still
-- submits a roll; its value is forced. The card text's "skip your roll" /
-- "does not roll" is honoured in spirit only -- a genuine exempt-from-rolling
-- state (Tea Cosy) is a separate Tier B primitive (#294) and out of scope here.
--
-- Advantage / disadvantage on the same player as a non-warded fixed_roll: a
-- fixed die has nothing to take advantage on, so the second draw and its
-- roll_transform recording are skipped -- the advantage / disadvantage cast
-- simply records nothing and contributes nothing in Phase 3. (Pathological:
-- needs two self-buff casts on one player.) A warded fixed_roll does not
-- suppress it -- the ward blocked the fix, so the real roll + advantage stand.
--
-- Ward interaction: a matching earlier-seq roll-domain ward on the affected
-- player is a pre-apply check in submit_roll (via _rr_active_ward_gate, spec
-- section 7). Polarity is computed from the constant vs the rolled value
-- (constant > roll -> positive, < -> negative, == -> neutral, never warded),
-- mirroring roll_flip. A warded fixed_roll makes NO mutation -- the player
-- keeps their rolled d20 -- and records a `warded` marker that resolve_round
-- Phase 3 turns into one `warded` Trace step (outcome `blocked`).
--
-- resolve_round: the only change is adding 'fixed_roll' to Phase 3's
-- effect-kind filter. The recorded entry (normal or warded) flows through the
-- generic Phase 3 branches -- adopt / logical-unwind-if-negated / warded-step
-- -- with no new code path. A negated fixed_roll (countered) is logically
-- unwound: the resolver adopts the recorded `before` (the real roll).

-- ===========================================================================
-- 1. effect_kind CHECK constraints -- add 'fixed_roll'
-- ===========================================================================
-- Last set in 0083 (contract slice). spell_active_effects is left untouched --
-- fixed_roll never persists a row.

alter table public.spell_card_effects drop constraint spell_card_effects_effect_kind_check;
alter table public.spell_card_effects add constraint spell_card_effects_effect_kind_check
  check (effect_kind in (
    'flat_modifier', 'dice_modifier', 'modifier_multiplier', 'set_modifier',
    'advantage', 'disadvantage', 'dispel',
    'forced_reroll', 'contested_negate', 'redirect',
    'reset_persistent_modifier',
    'roll_swap', 'roll_flip', 'fixed_roll', 'lowest_gains_highest_modifier',
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
    'roll_swap', 'roll_flip', 'fixed_roll', 'lowest_gains_highest_modifier',
    'tea_maker_override', 'declared_number_tea_maker', 'wild_dispatch',
    'ward', 'persistent_modifier_transfer', 'persistent_modifier_spend',
    'round_replay', 'draw_redirect'
  ));

-- ===========================================================================
-- 2. spell_card_effects rows for Steady Hand / Sleeping Camomile
-- ===========================================================================
-- delete-then-insert so the migration is idempotent on re-run.

delete from public.spell_card_effects
 where card_id in (
   select id from public.spell_cards where name in ('Steady Hand', 'Sleeping Camomile')
 );

insert into public.spell_card_effects (card_id, target_role, effect_kind, effect_params, ordinal)
select id, 'CASTER', 'fixed_roll', '{"value": 10}'::jsonb, 0
  from public.spell_cards where name = 'Steady Hand';

insert into public.spell_card_effects (card_id, target_role, effect_kind, effect_params, ordinal)
select id, 'TARGET', 'fixed_roll', '{"value": 1}'::jsonb, 0
  from public.spell_cards where name = 'Sleeping Camomile';

-- ===========================================================================
-- 3. Un-bench both instances (issue #284: return them to the draw pool)
-- ===========================================================================
-- Guarded on location = 'benched' so it is a no-op where 0074 never ran and
-- never disturbs a held instance.

update public.spell_deck_instances sdi
   set location = 'in_deck', held_by_player = null
  from public.spell_cards sc
 where sc.id = sdi.card_id
   and sc.name in ('Steady Hand', 'Sleeping Camomile')
   and sdi.location = 'benched';

-- ===========================================================================
-- 4. _rr_apply_fixed_roll -- the fixed-roll eager shim
-- ===========================================================================
-- Factored out so submit_roll and submit_roll_as carry one call, not a
-- duplicated ~35-line block each (cf. _rr_active_ward_gate). Given the fixed
-- cast + the value the player rolled, it records the before->after into the
-- cast's cast_inputs.roll_transform (kind 'fixed_roll', order 0 -- it replaces
-- the die, so a later flip / swap chains off it) and returns the constant to
-- persist. An earlier-seq roll-domain ward pre-empts the override: it records
-- a `warded` marker (before == after, plus would_be_after / ward_cast_id /
-- ward_card_name -- same shape as apply_forced_reroll's) and returns the
-- rolled value unchanged. A no-op returning the rolled value when the player
-- has no such cast or the layer is > 0.
--
-- `applied` = "the die was replaced": false for no-cast AND for warded, so the
-- caller runs its normal advantage / disadvantage path in both those cases and
-- skips it only when the fix actually took effect (a fixed die has nothing to
-- take advantage on).

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

comment on function public._rr_apply_fixed_roll(uuid, text, integer, uuid, integer) is
  'Issue #317: the fixed-roll eager shim (Steady Hand / Sleeping Camomile). Records a non-negated fixed_roll cast''s before->after into cast_inputs.roll_transform (order 0) and returns (constant, applied=true); an earlier-seq roll-domain ward instead records a `warded` marker and returns (rolled_value, applied=false). A no-op returning (rolled_value, false) when there is no such cast or the layer is > 0. Called by submit_roll / submit_roll_as before the rolls insert; resolve_round Phase 3 adopts the recorded entry.';

-- ===========================================================================
-- 4b. submit_roll / submit_roll_as -- call the fixed-roll shim
-- ===========================================================================
-- Re-emitted from 0079. The ONLY change vs 0079 is the _rr_apply_fixed_roll
-- call just after the initial d20 draw, plus gating the advantage /
-- disadvantage draw + recording on `not v_fixed_applied` (a fixed die has
-- nothing to take advantage on). The advantage / disadvantage bodies
-- themselves are byte-for-byte 0079.

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
  v_has_advantage boolean;
  v_has_disadvantage boolean;
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

  v_has_advantage := v_layer = 0 and exists (
    select 1 from public.spell_casts
     where round_id = p_round_id and target_player_id = v_player_id
       and target_pending = false and effect_kind = 'advantage'
  );
  v_has_disadvantage := v_layer = 0 and exists (
    select 1 from public.spell_casts
     where round_id = p_round_id and target_player_id = v_player_id
       and target_pending = false and effect_kind = 'disadvantage'
  );

  v_value := floor(random() * 20 + 1)::integer;
  v_first_value := v_value;
  v_discarded_value := null;
  v_cancelled := v_has_advantage and v_has_disadvantage;

  -- issue #317: fixed-roll shim. Records the before->after (order 0) and
  -- returns the constant; a roll-domain ward instead records a `warded`
  -- marker and returns v_first_value with applied=false.
  select f.value, f.applied into v_value, v_fixed_applied
    from public._rr_apply_fixed_roll(p_round_id, v_player_id, v_layer, v_room_id, v_first_value) f;

  -- A fixed die has nothing to take advantage / disadvantage on, so skip the
  -- second draw + its recording when the override took effect. Bodies below
  -- are byte-for-byte 0079.
  if not v_fixed_applied and v_has_advantage <> v_has_disadvantage then
    v_second_value := floor(random() * 20 + 1)::integer;
    if v_has_advantage then
      v_discarded_value := least(v_first_value, v_second_value);
      v_value := greatest(v_first_value, v_second_value);
    else
      v_discarded_value := greatest(v_first_value, v_second_value);
      v_value := least(v_first_value, v_second_value);
    end if;
  end if;

  insert into public.rolls (round_id, player_id, layer, value, input_mode, modifier_snapshot, discarded_value)
  values (p_round_id, v_player_id, v_layer, v_value, 'in_app', v_modifier, v_discarded_value);

  -- Record the roll transform onto the advantage / disadvantage cast(s).
  if not v_fixed_applied and (v_has_advantage or v_has_disadvantage) then
    if v_cancelled then
      v_dice := jsonb_build_array(v_first_value);
    elsif v_second_value is not null then
      v_dice := jsonb_build_array(v_first_value, v_second_value);
    else
      v_dice := jsonb_build_array(v_first_value);
    end if;

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
       and casts.effect_kind in ('advantage', 'disadvantage');
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
  );
  v_has_disadvantage := v_layer = 0 and exists (
    select 1 from public.spell_casts
     where round_id = p_round_id and target_player_id = p_player_id
       and target_pending = false and effect_kind = 'disadvantage'
  );

  v_value := floor(random() * 20 + 1)::integer;
  v_first_value := v_value;
  v_discarded_value := null;
  v_cancelled := v_has_advantage and v_has_disadvantage;

  -- issue #317: fixed-roll shim -- see submit_roll. Kept in lockstep.
  select f.value, f.applied into v_value, v_fixed_applied
    from public._rr_apply_fixed_roll(p_round_id, p_player_id, v_layer, v_room_id, v_first_value) f;

  if not v_fixed_applied and v_has_advantage <> v_has_disadvantage then
    v_second_value := floor(random() * 20 + 1)::integer;
    if v_has_advantage then
      v_discarded_value := least(v_first_value, v_second_value);
      v_value := greatest(v_first_value, v_second_value);
    else
      v_discarded_value := greatest(v_first_value, v_second_value);
      v_value := least(v_first_value, v_second_value);
    end if;
  end if;

  insert into public.rolls (round_id, player_id, layer, value, input_mode, modifier_snapshot, discarded_value)
  values (p_round_id, p_player_id, v_layer, v_value, 'in_app', v_modifier, v_discarded_value);

  if not v_fixed_applied and (v_has_advantage or v_has_disadvantage) then
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
       and casts.effect_kind in ('advantage', 'disadvantage');
  end if;

  return v_value;
end;
$$;

revoke execute on function public.submit_roll_as(uuid, text) from public, anon;
grant execute on function public.submit_roll_as(uuid, text) to authenticated;

-- ===========================================================================
-- 5. resolve_round(uuid) -- Phase 3 adopts the recorded fixed_roll value
-- ===========================================================================
-- Re-emitted from 0093 (issue #316's Phase 0a/0b invocation body -- this
-- branch merged rebuild/effect-resolver after #316 landed) with 'fixed_roll'
-- added to the Phase 3 effect-kind filter (one line) + a Phase 3 comment.
-- Everything else is byte-for-byte 0093.
--
-- Sibling slices #318 (chosen-pair) and #319 (conditional advantage, PR #358,
-- migration 0095) also re-emit resolve_round / submit_roll* -- their bodies
-- and the migration numbering reconcile at the #303 integrate-and-verify gate.

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
        elsif v_src_row.effect_kind in ('advantage', 'disadvantage', 'forced_reroll', 'roll_flip', 'roll_swap')
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
                    ('advantage', 'disadvantage', 'forced_reroll', 'roll_flip', 'roll_swap')) as keepable,
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
  -- Phase 3: roll-input accounting (issue #306/#308/#309/#317).
  -- issue #317: `fixed_roll` (Steady Hand = 10, Sleeping Camomile = 1) is a
  -- pre-roll kind recorded by submit_roll (via _rr_apply_fixed_roll) into
  -- cast_inputs.roll_transform at order 0 -- it replaces the die, and any
  -- later flip/swap chains off it. Its recorded entry (normal or `warded`)
  -- flows through the generic branches below exactly like the reaction-window
  -- transforms.
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
             (pe.value ->> 'before')::numeric as p_before,
             (pe.value ->> 'after')::numeric as p_after,
             coalesce((pe.value -> 'warded')::text = 'true', false) as is_warded,
             (pe.value ->> 'would_be_after')::numeric as would_be_after,
             pe.value ->> 'ward_cast_id' as ward_cast_id,
             pe.value ->> 'ward_card_name' as ward_card_name
        from public.spell_casts casts
        join public.spell_deck_instances sdi on sdi.id = casts.card_instance_id
        join public.spell_cards sc on sc.id = sdi.card_id
        cross join lateral (select casts.cast_inputs -> 'roll_transform' as rt) rt
        cross join lateral jsonb_array_elements(rt.rt -> 'players') as pe(value)
       where casts.round_id = p_round_id
         and casts.effect_kind in ('advantage', 'disadvantage', 'forced_reroll', 'roll_flip', 'roll_swap', 'fixed_roll')
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

      v_trace := v_trace || jsonb_build_array(public._rr_trace_step(
        v_step_index,
        v_row.kind,
        jsonb_build_object(
          'cast_id', to_jsonb(v_row.cast_id),
          'active_effect_id', null,
          'card_name', to_jsonb(v_row.card_name),
          'caster_player_id', to_jsonb(v_row.caster_id)
        ),
        v_pid,
        jsonb_build_object('type', 'roll', 'value', v_before),
        jsonb_build_object('type', 'roll', 'value', v_after)
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

comment on function public.resolve_round(uuid) is
  'Authoritative layer-0 outcome resolver (issues #305-#311 / #316 / #317 / #342 / #344 / #351, ADR 0005): Phase 0a materialises Saucerer''s Apprentice copies + Phase 0b retargets Brew-merang seizes / renders copy / seize / block_copy outcomes (issue #316); Phase 1 negate / redirect / backfire; a Pre-pass re-asserts whole-group negation on a ward-blocked Chai-nge / Tea Leaf / Spillage / Bes-Tea and emits its `warded` step (issue #344); Phase 2 ward projection; Phase 3 roll-input accounting; Phase 4a modifier composition; Phase 4c lowest_gains_highest_modifier; Phase 4b-pre synthesises each live Bitter Leech tick as a persistent_modifier_transfer pair, then negates a tick pair landing on a warded victim (issue #344); Phase 4b re-derives room_players.modifier = base + persistent spell delta for every player a transfer / spend cast touched this round (issue #311); Phase 5 brewer selection. Emits the Resolution Trace. In a replay generation (replay_generation > 0) it also emits a `roll_frozen` step for each roller whose roll _rr_scrap_round carried over for a negative-polarity roll-domain ward (issue #351). Pure and idempotent over its inputs. Layer > 0 bypasses all spell logic (issue #219).';

