-- GENERATED FROM db/sql/functions/ -- DO NOT EDIT
--
-- Written by `npm run build:migrations` from the canonical resolver-function
-- sources under db/sql/functions/. To change any function below, edit its
-- db/sql/functions/<name>.sql and re-run the build. See db/sql/README.md.
--
-- Functions in this migration:
--   _rr_resolve_eval
--   _rr_select_tea_maker
--   finalize_layer

-- BEGIN db/sql/functions/_rr_resolve_eval.sql
-- _rr_resolve_eval(p_round_id uuid, p_dry_run boolean) -> jsonb
--
-- The Resolver pipeline itself (Phases 0a/0b Effect Invocation, 1 Cast-Log
-- resolution, 2 ward projection, 3 roll-input accounting, 4a/4b/4c modifier
-- composition, 5 brewer selection -- delegated to _rr_select_tea_maker since
-- issue #451), returning the outcome object with its Resolution Trace
-- (`trace`) and layer-0 Resolution Summary (`players`). Split out of
-- resolve_round by issue #404 (ADR 0007).
--
-- It does NOT persist the Trace or the Summary -- resolve_round does that --
-- but it is not write-free either: it maintains Cast-Log caches that its own
-- later phases read back (materialised Apprentice copies, Calami-Tea and
-- Bitter Leech tick rows, negated / redirected / seize flags) and the
-- room_players.modifier cache (Phase 4b). Two callers only:
--   * resolve_round(uuid)  -- p_dry_run = false; the cache writes stick.
--   * _rr_resolve(uuid)    -- p_dry_run = true, inside a subtransaction it
--                             always rolls back, so nothing sticks.
-- p_dry_run changes exactly one thing: the Calami-Tea tick die is not rolled
-- (a dry run must not show a die the real resolve will re-roll).
--
-- Internal: no grant to authenticated.
--
-- Canonical source: this file is the source of truth for the function body.
-- Edit here and run `npm run build:migrations` -- do not hand-edit the
-- generated migration. See db/sql/README.md.

create or replace function public._rr_resolve_eval(p_round_id uuid, p_dry_run boolean)
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
  -- issue #404/#407: the layer-0 Resolution Summary (ADR 0007), one entry per
  -- layer-0 roller, built from the final working arrays just before Phase 5.
  v_summary jsonb := '[]'::jsonb;

  -- Phase 5 (issue #451): the selection result _rr_select_tea_maker returns.
  v_selection jsonb;
  v_brewer_id text := null;
  -- issue #425: the brewer's tea-making modifier gain. null = the normal
  -- cups_made, 0 = none, any other value is used as given.
  v_modifier_gain integer := null;
  v_tied text[];   -- layer > 0 only

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

  -- Phase 3-pre (issue #289): Calami-Tea per-round dice tick working state.
  v_dt record;
  v_dt_roll integer;
  v_dt_layer0_roll integer;
  v_dt_ward jsonb;
  -- issue #289: parallel to v_players -- true where a per_round_dice_tick
  -- (Calami-Tea) dragged this roller's value strictly below its running roll
  -- this round, so _rr_pick_lowest can keep them out of the natural-1 pool.
  v_dice_reduced boolean[] := array[]::boolean[];

  v_has_lghm boolean := false;
  v_lghm_cast record;
  v_high_roll_composed numeric;
  v_lowest_roll integer;

  -- issue #321 (Cloud of Cream / Targeting skip): players carrying a live
  -- `targeting_skip` active effect are dropped from highest/lowest-modifier
  -- *target selection* -- Phase 4c (lowest_gains_highest_modifier, both the
  -- highest-modifier source and the lowest beneficiary) and Phase 5
  -- (tea_maker_override mode `highest_modifier`) -- and the next eligible
  -- player is used. The flag never changes a skipped player's own composed
  -- modifier, nor the default lowest-roll brewer pick.
  v_skip_map jsonb := '{}'::jsonb;   -- { player_id: { ae_id, caster_id } }
  v_skip_players text[] := array[]::text[];
  v_lghm_natural text[] := array[]::text[];
  v_lghm_beneficiaries text[] := array[]::text[];
  v_lghm_high_pid text;
  v_lghm_plain_high_pid text;

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

  -- Pre-pass (issue #440: Brewmageddon) working state
  v_cc record;
  v_cc_source jsonb;

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

  -- issue #320: persistent advantage / disadvantage (Prophe-Tea) Phase 3
  v_has_persistent_adv boolean := false;
  v_pa_value integer;
  v_pa_discarded integer;
  v_pa_kept integer;
begin
  select status, room_id, current_layer, replay_generation, replay_frozen_rollers
    into v_status, v_room_id, v_layer, v_gen, v_frozen_rollers
    from public.rounds
   where id = p_round_id;

  if v_status is null then
    raise exception 'resolve_round: round not found';
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
        'cups_made', v_participant_count, 'modifier_gain', null, 'no_modifier_gain', false,
        'trace', '[]'::jsonb, 'players', null
      );
    end if;

    return jsonb_build_object(
      'outcome', 'tie', 'layer', v_layer,
      'brewer_id', null, 'brewer_source', null,
      'tied_player_ids', to_jsonb(v_tied),
      'cups_made', v_participant_count, 'modifier_gain', null, 'no_modifier_gain', false,
      'trace', '[]'::jsonb, 'players', null
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
    v_dice_reduced := v_dice_reduced || false;   -- issue #289: set in Phase 3
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
  -- Pre-pass (issue #440): Brewmageddon -- Compelled Cast and Forfeit.
  --
  -- Neither a `compel_cast` row nor a `forfeit` row changes a roll or a
  -- modifier: the compulsion happened at close_round / in the Compelled Cast
  -- step, and the compelled casts themselves are ordinary casts every later
  -- phase resolves as usual. This only explains them. One `compel_cast` step
  -- per live Brewmageddon naming its compelled set (a no-op when nobody held
  -- a card; a countered one already has Phase 1's negated step), then one
  -- `forfeit` step per Forfeit, in cast order, pointing back at it.
  -- ------------------------------------------------------------------
  for v_cc in
    select c.id as cast_id, c.caster_id, c.effect_kind, c.cast_inputs,
           scn.name as card_name
      from public.spell_casts c
      join public.spell_deck_instances sdi on sdi.id = c.card_instance_id
      join public.spell_cards scn on scn.id = sdi.card_id
     where c.round_id = p_round_id
       and ((c.effect_kind = 'compel_cast' and not c.negated) or c.effect_kind = 'forfeit')
     order by c.seq
  loop
    v_cc_source := jsonb_build_object(
      'cast_id', to_jsonb(v_cc.cast_id),
      'active_effect_id', null,
      'card_name', to_jsonb(v_cc.card_name),
      'caster_player_id', to_jsonb(v_cc.caster_id)
    );
    if v_cc.effect_kind = 'compel_cast' then
      v_trace := v_trace || jsonb_build_array(public._rr_trace_step(
        v_step_index,
        'compel_cast',
        v_cc_source,
        null,
        jsonb_build_object('type', 'status', 'value', 'cast'),
        jsonb_build_object('type', 'status', 'value', 'compelled'),
        jsonb_build_object(
          'compelled_player_ids', coalesce((
            select jsonb_agg(h -> 'player_id' order by h ->> 'player_id')
              from jsonb_array_elements(coalesce(v_cc.cast_inputs -> 'compelled', '[]'::jsonb)) h
          ), '[]'::jsonb),
          'outcome', case
            when jsonb_array_length(coalesce(v_cc.cast_inputs -> 'compelled', '[]'::jsonb)) > 0
              then 'applied' else 'no-op' end)
      ));
    else
      v_trace := v_trace || jsonb_build_array(public._rr_trace_step(
        v_step_index,
        'forfeit',
        v_cc_source,
        v_cc.caster_id,
        jsonb_build_object('type', 'status', 'value', 'held'),
        jsonb_build_object('type', 'status', 'value', 'forfeited'),
        jsonb_build_object(
          'compelled_by', v_cc.cast_inputs -> 'compelled_by',
          'reason', v_cc.cast_inputs -> 'reason',
          'outcome', 'no-op')
      ));
    end if;
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

  -- issue #320: is any live persistent advantage / disadvantage projection row
  -- in play this round? Gates the per-roller sub-block in Phase 3 so the common
  -- (no Prophe-Tea) path skips N projection lookups -- mirrors v_has_counters /
  -- v_has_invocations.
  select exists (
    select 1 from public._rr_active_effects_as_of(v_room_id, p_round_id) sae
     where sae.room_id = v_room_id
       and sae.effect_kind in ('advantage', 'disadvantage')
       and sae.target_player_id = any (v_players)
  ) into v_has_persistent_adv;

  -- ------------------------------------------------------------------
  -- Phase 3-pre (issue #289): Calami-Tea per-round dice tick synthesis.
  --
  -- Calami-Tea ("Choose up to 3 players. For the next 3 rounds, they each
  -- subtract 1d4 from their rolls.") is a persistent `per_round_dice_tick`
  -- active effect: one CHOSEN_PLAYERS anchor cast + one spell_active_effects
  -- row per target (rounds_remaining => 3 from the card's duration_rounds).
  -- The anchor itself carries no roll_transform, so it is inert past the
  -- projection -- exactly the Bitter Leech anchor pattern (Phase 4b-pre).
  --
  -- Each round the effect is live, this synthesises one child cast per target
  -- carrying a freshly-rolled 1dN in cast_inputs.roll_transform (kind
  -- 'per_round_dice_tick', order 2 -- after fixed_roll / advantage). The main
  -- Phase 3 walk below then subtracts that die from the target's roll and
  -- emits a `dice_tick` Trace step. Written once per (round, source cast,
  -- generation): a re-resolve finds the tick already present, skips the
  -- insert, and re-reads the recorded die, so the resolver stays deterministic
  -- and the per-tick RNG lives in the Cast Log (spec #302 Tier B primitive 6).
  -- Liveness (cast round + next 2, then stop) is _rr_active_effects_as_of's
  -- call, off the card's duration_rounds = 3.
  --
  -- Ward interaction: a negative-polarity roll-domain ward on the target
  -- (Cast-Iron Kettle) blocks the tick that round -- the synth row goes in
  -- negated (the walk's is_negated branch leaves the roll untouched) and a
  -- `warded` step is emitted here, mirroring Phase 4b-pre's Bitter Leech ward
  -- pre-pass. Re-evaluated every round off the live ward map, so a later tick
  -- after the ward expires still applies.
  -- ------------------------------------------------------------------
  for v_dt in
    select sae.source_cast_id,
           sae.target_player_id as victim_id,
           sae.caster_id        as caster_id,
           coalesce((sae.effect_params ->> 'die')::integer, 4)  as die,
           coalesce((sae.effect_params ->> 'sign')::integer, -1) as sign,
           src.card_instance_id
      from public._rr_active_effects_as_of(v_room_id, p_round_id) sae
      join public.spell_casts src on src.id = sae.source_cast_id
     where sae.room_id = v_room_id
       and sae.effect_kind = 'per_round_dice_tick'
  loop
    -- Only tick targets who actually rolled this layer-0 round.
    if not (v_dt.victim_id = any (v_players)) then
      continue;
    end if;

    -- generation-scoped idempotency, like Bitter Leech's Phase 4b-pre: a
    -- replay (#315) that bumps replay_generation must re-roll the tick for the
    -- new generation, not skip on the prior one's rows.
    if exists (
      select 1 from public.spell_casts t
       where t.round_id = p_round_id
         and t.source_cast_id = v_dt.source_cast_id
         and coalesce((t.cast_inputs ->> 'dice_tick')::boolean, false) = true
         and coalesce(t.generation, 0) = coalesce(v_gen, 0)
    ) then
      continue;
    end if;

    -- issue #409 (Provisional Recap): a dry run never rolls the die. The
    -- synth row goes in with `rolled` null, so the walk below subtracts 0 and
    -- the `dice_tick` step reads as pending (the Recap renders "subtracts a
    -- die"); the real die is rolled once, by the persisting resolve.
    v_dt_roll := case when p_dry_run then null
                      else floor(random() * v_dt.die + 1)::integer end;
    v_dt_ward := public._rr_ward_hit(v_ward_map, v_dt.victim_id, 'roll', 'negative', null);

    insert into public.spell_casts (
      round_id, caster_id, card_instance_id, target_player_id,
      effect_kind, effect_params, cast_inputs, source_cast_id, generation, negated
    )
    values (
      p_round_id, v_dt.caster_id, v_dt.card_instance_id, v_dt.victim_id,
      'per_round_dice_tick',
      jsonb_build_object('die', v_dt.die, 'sign', v_dt.sign, 'rolled', v_dt_roll),
      jsonb_build_object(
        'dice_tick', true,
        'roll_transform', jsonb_build_object(
          'kind', 'per_round_dice_tick',
          'order', 2,
          'die', v_dt.die,
          'sign', v_dt.sign,
          'rolled', v_dt_roll,
          'players', jsonb_build_array(jsonb_build_object(
            'player_id', v_dt.victim_id,
            'before', null,
            'after', null,
            'warded', v_dt_ward is not null
          ))
        )
      ),
      v_dt.source_cast_id, coalesce(v_gen, 0), v_dt_ward is not null
    );

    if v_dt_ward is not null then
      select r.value into v_dt_layer0_roll
        from public.rolls r
       where r.round_id = p_round_id and r.layer = 0 and r.player_id = v_dt.victim_id;

      v_trace := v_trace || jsonb_build_array(public._rr_trace_step(
        v_step_index,
        'warded',
        jsonb_build_object(
          'cast_id', null,
          'active_effect_id', null,
          'card_name', to_jsonb('Calami-Tea'::text),
          'caster_player_id', to_jsonb(v_dt.caster_id)
        ),
        v_dt.victim_id,
        jsonb_build_object('type', 'roll', 'value', v_dt_layer0_roll),
        jsonb_build_object('type', 'roll', 'value', v_dt_layer0_roll),
        jsonb_build_object(
          'blocked_cast_id', null,
          'ward_cast_id', v_dt_ward -> 'ward_cast_id',
          'ward_card_name', v_dt_ward -> 'ward_card_name',
          'target', to_jsonb(v_dt.victim_id),
          'would_be_before', v_dt_layer0_roll,
          -- same floor the live application uses (Phase 3 walk: greatest(1, ...))
          'would_be_after', greatest(1, v_dt_layer0_roll + v_dt.sign * v_dt_roll),
          'outcome', 'blocked'
        )
      ));
      v_step_index := v_step_index + 1;
    end if;
  end loop;

  -- ------------------------------------------------------------------
  -- Phase 3: roll-input accounting (issue #306/#308/#309/#317/#318/#319).
  -- issue #317: `fixed_roll` is a pre-roll kind recorded by submit_roll (via
  -- _rr_apply_fixed_roll) into cast_inputs.roll_transform at order 0; its
  -- recorded entry (normal or `warded`) flows through the generic branches
  -- below exactly like the reaction-window transforms.
  -- issue #289: a synthesised `per_round_dice_tick` child cast (Calami-Tea,
  -- order 2) flows through the same generic branches -- it carries a recorded
  -- `rolled` die the walk subtracts from the roll.
  -- ------------------------------------------------------------------
  for v_i in 1 .. coalesce(array_length(v_players, 1), 0) loop
    v_pid := v_players[v_i];
    v_running := null;

    -- issue #320: persistent advantage / disadvantage (Prophe-Tea). A
    -- rest-of-day advantage lives as a spell_active_effects projection row --
    -- no spell_casts row this round, so nothing for the roll_transform walk
    -- below to pick up. Advantage resolves at submit_roll, BEFORE the reaction
    -- window (spec section 2), so emit its clarity step FIRST and seed
    -- v_running with the advantage-kept die: a later reaction-window transform
    -- on the same roller then chains off it instead of collapsing this step to
    -- a zero-impact one. v_rolls is never touched -- the eager shim already
    -- kept the right die. Skipped for a roller who also has an advantage /
    -- disadvantage spell_casts row this round (its cast round): the walk emits
    -- that step itself. AC note (#320): with no cast row on a projection-only
    -- round there is nothing in the Cast Log to record before->after onto, and
    -- spec section 5 forbids mutating the projection row per round -- the kept
    -- die + rolls.discarded_value (persisted by the shim, migration 0049/0051)
    -- are the durable record the resolver adopts here without re-running RNG.
    if v_has_persistent_adv then
      for v_row in
        select sae.id as effect_id, sae.effect_kind as kind,
               sae.caster_id as caster_id, scp.name as card_name
          from public._rr_active_effects_as_of(v_room_id, p_round_id) sae
          join public.spell_cards scp on scp.id = sae.card_id
         where sae.room_id = v_room_id
           and sae.effect_kind in ('advantage', 'disadvantage')
           and sae.target_player_id = v_pid
           and not exists (
             select 1 from public.spell_casts c
              where c.round_id = p_round_id
                and c.target_player_id = v_pid
                and c.target_pending = false
                and c.effect_kind in ('advantage', 'disadvantage')
           )
         order by sae.created_at
      loop
        select r.value, r.discarded_value into v_pa_value, v_pa_discarded
          from public.rolls r
         where r.round_id = p_round_id and r.layer = 0 and r.player_id = v_pid;

        -- The advantage-kept die is rolls.value UNLESS a later reaction-window
        -- transform overwrote it -- in which case that transform recorded the
        -- value it read (the kept die) as its own `before`. Take the earliest
        -- recorded `before` if there is one, else rolls.value.
        select (pe.value ->> 'before')::integer
          into v_pa_kept
          from public.spell_casts casts
          cross join lateral jsonb_array_elements(
            casts.cast_inputs -> 'roll_transform' -> 'players') as pe(value)
         where casts.round_id = p_round_id
           and casts.effect_kind in
             ('advantage', 'disadvantage', 'forced_reroll', 'roll_flip',
              'roll_swap', 'fixed_roll', 'roll_pair_transform', 'per_round_dice_tick')
           and casts.cast_inputs ? 'roll_transform'
           and pe.value ->> 'player_id' = v_pid
         order by (casts.cast_inputs -> 'roll_transform' ->> 'order')::integer,
                  casts.seq
         limit 1;
        v_pa_kept := coalesce(v_pa_kept, v_pa_value);

        v_after := v_pa_kept::numeric;
        if v_pa_discarded is null then
          -- advantage and disadvantage cancelled to a single die, or a fixed
          -- roll suppressed the second draw: a zero-impact step.
          v_before := v_after;
        elsif v_row.kind = 'advantage' then
          v_before := least(v_pa_kept, v_pa_discarded)::numeric;
        else
          v_before := greatest(v_pa_kept, v_pa_discarded)::numeric;
        end if;

        v_running := v_after;   -- the roll_transform walk chains from the kept die

        v_trace := v_trace || jsonb_build_array(public._rr_trace_step(
          v_step_index,
          v_row.kind,
          jsonb_build_object(
            'cast_id', null,
            'active_effect_id', to_jsonb(v_row.effect_id),
            'card_name', to_jsonb(v_row.card_name),
            'caster_player_id', to_jsonb(v_row.caster_id)
          ),
          v_pid,
          jsonb_build_object('type', 'roll', 'value', v_before),
          jsonb_build_object('type', 'roll', 'value', v_after)
        ));
        v_step_index := v_step_index + 1;
      end loop;
    end if;

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
             rt.rt -> 'condition' as condition,   -- issue #319: conditional advantage
             (rt.rt ->> 'rolled')::numeric as tick_rolled,   -- issue #289: per-round dice tick
             (rt.rt ->> 'sign')::numeric as tick_sign,
             (rt.rt ->> 'die')::integer as tick_die
        from public.spell_casts casts
        join public.spell_deck_instances sdi on sdi.id = casts.card_instance_id
        join public.spell_cards sc on sc.id = sdi.card_id
        cross join lateral (select casts.cast_inputs -> 'roll_transform' as rt) rt
        cross join lateral jsonb_array_elements(rt.rt -> 'players') as pe(value)
       where casts.round_id = p_round_id
         and casts.effect_kind in ('advantage', 'disadvantage', 'forced_reroll', 'roll_flip', 'roll_swap', 'fixed_roll', 'roll_pair_transform', 'per_round_dice_tick')
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

      -- issue #308: a NEGATED roll transform is logically unwound. issue #289:
      -- a warded Calami-Tea tick arrives here (synth row negated in Phase
      -- 3-pre, `warded` step already emitted) -- p_before is null, so v_running
      -- stays untouched and the roll is unchanged.
      if v_row.is_negated then
        v_running := coalesce(v_running, v_row.p_before);
        continue;
      end if;

      -- issue #289: Calami-Tea per-round dice tick. The die was rolled and
      -- recorded in Phase 3-pre (cast_inputs.roll_transform.rolled); subtract
      -- it (sign = -1) from the running roll and emit a `dice_tick` step.
      -- p_before / p_after are null on a synth tick row -- the value is derived
      -- from the running roll, not the recorded pair, so a re-resolve over the
      -- same recorded die reproduces the same result.
      if v_row.kind = 'per_round_dice_tick' then
        v_before := coalesce(v_running, v_rolls[v_i])::numeric;
        v_after := greatest(1, v_before + coalesce(v_row.tick_sign, -1) * coalesce(v_row.tick_rolled, 0));
        v_running := v_after;

        -- issue #289 (Tom's call): a roll dragged down here is not a natural 1
        -- -- flag it so _rr_pick_lowest keeps it out of the nat-1 auto-lose
        -- pool. Only when the value actually dropped (a raw 1 hitting the floor
        -- is still a natural 1).
        if v_after < v_before then
          v_dice_reduced[v_i] := true;
        end if;

        v_trace := v_trace || jsonb_build_array(public._rr_trace_step(
          v_step_index,
          'dice_tick',
          jsonb_build_object(
            'cast_id', to_jsonb(v_row.cast_id),
            'active_effect_id', null,
            'card_name', to_jsonb(v_row.card_name),
            'caster_player_id', to_jsonb(v_row.caster_id)
          ),
          v_pid,
          jsonb_build_object('type', 'roll', 'value', v_before),
          jsonb_build_object('type', 'roll', 'value', v_after),
          jsonb_build_object(
            'die', v_row.tick_die,
            'rolled', v_row.tick_rolled,
            'sign', coalesce(v_row.tick_sign, -1)
          )
        ));
        v_step_index := v_step_index + 1;
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
      -- (the _layer_is_complete hold keeps Layer finalization from running).
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
  -- issue #321 (Cloud of Cream): collect the players carrying a live
  -- `targeting_skip` active effect, keyed for Trace attribution. Read once
  -- here; consumed by Phase 4c and Phase 5 below. DISTINCT ON so two Cloud of
  -- Cream instances on one player collapse to their earliest.
  -- ------------------------------------------------------------------
  select coalesce(
           jsonb_object_agg(pid, jsonb_build_object('ae_id', ae_id, 'caster_id', caster_id)),
           '{}'::jsonb)
    into v_skip_map
    from (
      select distinct on (sae.target_player_id)
             sae.target_player_id as pid, sae.id as ae_id, sae.caster_id as caster_id
        from public._rr_active_effects_as_of(v_room_id, p_round_id) sae
       where sae.room_id = v_room_id
         and sae.effect_kind = 'targeting_skip'
         and sae.target_player_id is not null
       order by sae.target_player_id, sae.created_at
    ) s;
  v_skip_players := array(select jsonb_object_keys(v_skip_map));

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

    -- The plain highest roller (roll desc, then player id asc) -- kept for
    -- issue #321 Trace attribution below.
    select v_players[i] into v_lghm_plain_high_pid
      from generate_subscripts(v_players, 1) i
     order by v_rolls[i] desc, v_players[i]
     limit 1;

    -- issue #321: the "highest modifier" source. Normally the plain highest
    -- roller's composed modifier; a Cloud of Cream holder is skipped and the
    -- next-highest non-skipped roller is used. If every roller is skipped,
    -- fall back to the plain highest so the lift still resolves.
    select v_players[i] into v_lghm_high_pid
      from generate_subscripts(v_players, 1) i
     where not (v_players[i] = any (v_skip_players))
     order by v_rolls[i] desc, v_players[i]
     limit 1;
    if v_lghm_high_pid is null then
      v_lghm_high_pid := v_lghm_plain_high_pid;
    end if;
    v_high_roll_composed := v_composed[array_position(v_players, v_lghm_high_pid)];

    -- issue #321 Trace: the plain highest roller was skipped off the source.
    if v_lghm_plain_high_pid is not null
       and v_lghm_plain_high_pid <> v_lghm_high_pid
       and (v_skip_map ? v_lghm_plain_high_pid) then
      v_trace := v_trace || jsonb_build_array(public._rr_trace_step(
        v_step_index,
        'targeting_skip',
        jsonb_build_object(
          'cast_id', null,
          'active_effect_id', v_skip_map -> v_lghm_plain_high_pid -> 'ae_id',
          'card_name', to_jsonb('Cloud of Cream'::text),
          'caster_player_id', v_skip_map -> v_lghm_plain_high_pid -> 'caster_id'
        ),
        v_lghm_plain_high_pid,
        jsonb_build_object('type', 'status', 'value', 'targetable'),
        jsonb_build_object('type', 'status', 'value', 'skipped')
      ));
      v_step_index := v_step_index + 1;
    end if;

    -- issue #321: beneficiaries. Normally every tied-lowest roller; a Cloud
    -- of Cream holder among them is skipped and the lift moves to the next
    -- eligible (non-skipped) roller in roll-ascending order, keeping the
    -- beneficiary count the same ("apply to the next player instead").
    select coalesce(array_agg(v_players[i] order by v_rolls[i], v_players[i]), array[]::text[])
      into v_lghm_natural
      from generate_subscripts(v_players, 1) i
     where v_rolls[i] = v_lowest_roll;

    if coalesce(array_length(v_skip_players, 1), 0) = 0
       or not (v_lghm_natural && v_skip_players) then
      v_lghm_beneficiaries := v_lghm_natural;
    else
      select coalesce(array_agg(pid order by rk), array[]::text[])
        into v_lghm_beneficiaries
        from (
          select v_players[i] as pid,
                 row_number() over (order by v_rolls[i], v_players[i]) as rk
            from generate_subscripts(v_players, 1) i
           where not (v_players[i] = any (v_skip_players))
        ) s
       where rk <= coalesce(array_length(v_lghm_natural, 1), 0);
      -- every roller skipped -> nobody eligible; keep the natural set.
      if coalesce(array_length(v_lghm_beneficiaries, 1), 0) = 0 then
        v_lghm_beneficiaries := v_lghm_natural;
      end if;
    end if;

    -- issue #321 Trace: one step per natural beneficiary the skip removed.
    foreach v_pid in array v_lghm_natural loop
      if (v_skip_map ? v_pid) and not (v_pid = any (v_lghm_beneficiaries)) then
        v_trace := v_trace || jsonb_build_array(public._rr_trace_step(
          v_step_index,
          'targeting_skip',
          jsonb_build_object(
            'cast_id', null,
            'active_effect_id', v_skip_map -> v_pid -> 'ae_id',
            'card_name', to_jsonb('Cloud of Cream'::text),
            'caster_player_id', v_skip_map -> v_pid -> 'caster_id'
          ),
          v_pid,
          jsonb_build_object('type', 'status', 'value', 'targetable'),
          jsonb_build_object('type', 'status', 'value', 'skipped')
        ));
        v_step_index := v_step_index + 1;
      end if;
    end loop;

    foreach v_pid in array v_lghm_beneficiaries loop
      v_i := array_position(v_players, v_pid);
      -- issue #309: a warded beneficiary is excluded from the lift
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
  -- Resolution Summary (issue #407, ADR 0007): each layer-0 roller's final
  -- values as Phase 5 compares them -- roll after every roll-input transform,
  -- roll-time modifier, composed modifier, total, and nat standing by
  -- _rr_pick_lowest's own rule (a Calami-Tea-floored 1 is not a natural 1).
  -- Phase 5 moves none of these, so the summary is final here.
  -- ------------------------------------------------------------------
  select coalesce(jsonb_agg(jsonb_build_object(
           'player_id', v_players[i],
           'roll', v_rolls[i],
           'snapshot', v_snapshots[i],
           'composed', v_composed[i],
           'total', v_rolls[i] + v_composed[i],
           'nat', case
             when v_rolls[i] = 1 and not coalesce(v_dice_reduced[i], false) then 'nat1'
             when v_rolls[i] = 20 then 'nat20'
           end,
           'dice_reduced', coalesce(v_dice_reduced[i], false)
         ) order by i), '[]'::jsonb)
    into v_summary
    from generate_subscripts(v_players, 1) i;

  -- ------------------------------------------------------------------
  -- Phase 5: brewer selection -- the Tea-Maker Precedence Ladder (ADR 0005,
  -- #425 amendment), in its own module since issue #451. It takes the
  -- Resolution Summary as its roll input and returns one selection result:
  -- the outcome, Tea Maker, brewer source, ladder modifier gain, tie pool and
  -- the Trace steps it emitted from v_step_index.
  -- ------------------------------------------------------------------
  v_selection := public._rr_select_tea_maker(
    p_round_id, v_summary, v_redirect_map, v_skip_map, v_step_index
  );
  v_trace := v_trace || (v_selection -> 'steps');
  v_step_index := v_step_index + jsonb_array_length(v_selection -> 'steps');
  v_brewer_id := v_selection ->> 'brewer_id';
  v_modifier_gain := (v_selection ->> 'modifier_gain')::integer;

  -- issue #309: a block_earned_modifier ward on the selected brewer (Eternal
  -- Steep) zeroes their tea-making modifier gain: modifier_gain 0, which
  -- resolve_round(uuid, text, integer, integer) writes as a zero brewer gain.
  -- This is a property of the ward, not a competing cast, so it applies
  -- regardless of seq -- and over an override's own gain (#425). A tie, or a
  -- Loose Leaf roll-off (#431), names no brewer, so it never reaches here.
  if v_brewer_id is not null then
    select w.value into v_ward_hit
      from jsonb_array_elements(coalesce(v_ward_map -> v_brewer_id, '[]'::jsonb)) w
     where coalesce((w.value ->> 'block_earned_modifier')::boolean, false)
     limit 1;

    if v_ward_hit is not null then
      if v_modifier_gain is distinct from 0 then
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
      v_modifier_gain := 0;
      v_ward_hit := null;
    end if;
  end if;

  -- ------------------------------------------------------------------
  -- Phase 6 (issue #438): Tea Heist outcomes. The resolver only DECIDES and
  -- traces here (moved / fizzled / countered) -- this body also runs as the
  -- Provisional Recap's rolled-back dry run, so the card itself is moved by
  -- finalize_layer's commit step (_rr_apply_heists), per the ADR 0005 #383
  -- amendment. Emitted for a tie too, since a tie's layer-0 Trace is the one
  -- the round keeps.
  -- ------------------------------------------------------------------
  v_trace := v_trace || public._rr_heist_trace(p_round_id, v_step_index);

  -- The one layer-0 return, built from the selection result.
  return jsonb_build_object(
    'outcome', v_selection -> 'outcome', 'layer', 0,
    'brewer_id', v_brewer_id, 'brewer_source', v_selection -> 'brewer_source',
    'tied_player_ids', v_selection -> 'tied_player_ids',
    'cups_made', v_participant_count, 'modifier_gain', v_modifier_gain,
    -- compat alias for callers still reading the yes/no (#425)
    'no_modifier_gain', coalesce(v_modifier_gain = 0, false),
    -- issue #429: the Earl title transfer finalize_layer writes, or null
    'earl_transfer', v_selection -> 'earl_transfer',
    'trace', v_trace, 'players', v_summary
  );
end;
$$;

revoke execute on function public._rr_resolve_eval(uuid, boolean) from public, anon, authenticated;

comment on function public._rr_resolve_eval(uuid, boolean) is
  'Issue #404 (ADR 0007): the body of the authoritative layer-0 resolver, split out of resolve_round. Returns { outcome, layer, brewer_id, brewer_source, tied_player_ids, cups_made, modifier_gain (null = cups_made, 0 = none, else as given; issue #425), no_modifier_gain (compat alias: modifier_gain = 0), earl_transfer (issue #429: the Earl title transfer finalize_layer writes, or null), trace, players } without persisting the Trace or the Resolution Summary. Maintains its own Cast-Log / modifier caches, so callers either keep them (resolve_round) or roll them back (_rr_resolve). p_dry_run skips the Calami-Tea tick RNG. Internal.';
-- END db/sql/functions/_rr_resolve_eval.sql

-- BEGIN db/sql/functions/_rr_select_tea_maker.sql
-- _rr_select_tea_maker(uuid, jsonb, jsonb, jsonb, integer) -> jsonb
--
-- Issue #451: Phase 5 of the Resolver pipeline -- tea-maker selection by the
-- Tea-Maker Precedence Ladder (ADR 0005, #425 amendment), extracted from
-- _rr_resolve_eval. Phases 0-4 hand it what it needs:
--   p_summary       the layer-0 Resolution Summary (ADR 0007): each roller's
--                   post-shim roll, composed modifier and dice_reduced flag,
--                   in the pipeline's player order.
--   p_redirect_map  Phase 1's { card_instance_id: new_target } redirects.
--   p_skip_map      the Cloud of Cream `targeting_skip` map ({ player_id:
--                   { ae_id, caster_id } }).
--   p_step_index    the Trace step cursor; steps are numbered from here.
--
-- Returns one selection result:
--   { outcome          'brewer' | 'tie' | 'rolloff'
--     brewer_id        the Tea Maker (null on a tie or a roll-off)
--     brewer_source    'declared_number' | 'tea_maker_override:<mode>' |
--                      'default' (null on a tie or a roll-off)
--     modifier_gain    the ladder's gain (null = cups_made, 0 = none, else as
--                      given; null on a tie or a roll-off). The Eternal Steep
--                      ward is applied by the caller -- the ward phase is
--                      orthogonal to the ladder.
--     tied_player_ids  the Tie-Break Reroll pool (null for a brewer); for a
--                      roll-off (issue #431, Loose Leaf), the named holder
--                      then every roller tied at second-lowest
--     earl_transfer    issue #429: { active_effect_id, from_player_id,
--                      to_player_id, cast_id } when an override forced tea on
--                      the Earl, else null. Decided here; finalize_layer's
--                      commit step writes it (_rr_apply_earl_title).
--     steps            the Resolution Trace steps it emitted, in order }
-- The outcome is a tag so a later outcome (the Loose Leaf `rolloff`, #431)
-- or a pre-ladder rule (the Brew Debt round, #432) is one more branch ahead
-- of the single return, not another exit. An `earl_transfer` can come back
-- with a `rolloff` (the forced ex-Earl holds Loose Leaf): finalize_layer
-- writes it when it commits the roll-off.
--
-- Read-only. It reads the round, the live active effects and the Cast Log,
-- never writes, so it is safe under both resolve_round and the rolled-back
-- _rr_resolve dry run.
--
-- Rolls: the ladder's tiers do not all read the same roll value. The
-- declared-number match and the `highest_modifier` pick read the raw `rolls`
-- table; `highest_roll`, `conditional_chosen` and the default pick read the
-- post-shim summary. Kept as-is by #451 (a no-behaviour-change extraction);
-- each read is marked.
--
-- Internal: no grant to authenticated.
--
-- Canonical source: this file is the source of truth for the function body.
-- Edit here and run `npm run build:migrations` -- do not hand-edit the
-- generated migration. See db/sql/README.md.

create or replace function public._rr_select_tea_maker(
  p_round_id uuid, p_summary jsonb, p_redirect_map jsonb, p_skip_map jsonb, p_step_index integer
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_room_id uuid;
  v_started_at timestamptz;

  v_steps jsonb := '[]'::jsonb;
  v_step_index integer := p_step_index;

  v_outcome text := 'brewer';
  v_brewer_id text := null;
  v_brewer_source text := 'default';
  v_modifier_gain integer := null;
  v_tied text[];

  -- the Resolution Summary unpacked into the parallel arrays _rr_pick_lowest
  -- takes, in summary order
  v_players text[];
  v_rolls integer[];
  v_composed numeric[];
  v_dice_reduced boolean[];

  -- tier 0: { player_id: { ae_id, caster_id, card_name, override_proof, mode } }
  v_immune jsonb;
  -- issue #429 (Earl of Earl Grey): an override naming the Earl passes the
  -- title to its caster. Decided here, written by finalize_layer.
  v_earl_transfer jsonb := null;
  v_skip_players text[];

  v_declared record;
  v_pid text;

  -- tier 2: the override walk and its one mode dispatch
  v_row record;
  v_override record;
  -- true when v_override holds the tier-2 winner and it can act (its target
  -- isn't still pending). A plain flag, so an unassigned v_override is never
  -- read (PL/pgSQL doesn't short-circuit a field reference).
  v_override_live boolean := false;
  v_target text;
  v_inert_after text;
  v_inert_extra jsonb;
  v_prev_round uuid;
  v_cond_target_roll integer;
  v_cond_caster_roll integer;
  v_plain_high text;
  -- issue #430: whether Phase 1 rewrote `negated` (the round has counters)
  v_has_counters boolean;

  -- tier 4: the lowest-roller pool, Brewer Candidates only
  v_pool_players text[];
  v_pool_rolls integer[];
  v_pool_composed numeric[];
  v_pool_reduced boolean[];

  -- tier 3 (issue #431): the Loose Leaf roll-off
  v_rolloff record;
  v_rolloff_lineup integer[];
  v_rolloff_second_roll integer;
  v_rolloff_second_composed numeric;
  v_rolloff_opponents text[];
  v_rolloff_after text;
  v_rolloff_extra jsonb;
begin
  select room_id, started_at into v_room_id, v_started_at
    from public.rounds where id = p_round_id;

  select coalesce(array_agg(e ->> 'player_id' order by ord), array[]::text[]),
         coalesce(array_agg((e ->> 'roll')::integer order by ord), array[]::integer[]),
         coalesce(array_agg((e ->> 'composed')::numeric order by ord), array[]::numeric[]),
         coalesce(array_agg((e ->> 'dice_reduced')::boolean order by ord), array[]::boolean[])
    into v_players, v_rolls, v_composed, v_dice_reduced
    from jsonb_array_elements(p_summary) with ordinality as s(e, ord);

  v_skip_players := array(select jsonb_object_keys(p_skip_map));

  -- Phase 1's own test for whether it ran.
  select exists (
    select 1 from public.spell_casts
     where round_id = p_round_id
       and effect_kind in ('contested_negate', 'redirect')
  ) into v_has_counters;

  -- ------------------------------------------------------------------
  -- Tier 0 (issue #428, ADR 0005): Brewer Immunity is not a pass of its
  -- own -- it is read here, directly (never through the Phase 2 ward
  -- filter), and every tier below asks _rr_is_brewer_candidate. An immune
  -- candidate is no match at any tier: a declared-number roller, an
  -- override target and the lowest-roller pool all skip them and fall
  -- through. One entry per player; an override-proof row (The Last Cuppa)
  -- is preferred, then any immunity other than the Earl title (issue #429):
  -- an Earl who is immune for another reason too is passed over like anyone
  -- immune, not forced.
  -- ------------------------------------------------------------------
  select coalesce(jsonb_object_agg(im.target_player_id, im.info), '{}'::jsonb)
    into v_immune
    from (
      select distinct on (sae.target_player_id)
             sae.target_player_id,
             jsonb_build_object(
               'ae_id', sae.id,
               'caster_id', sae.caster_id,
               'card_name', sc.name,
               'override_proof', coalesce((sae.effect_params ->> 'override_proof')::boolean, false),
               'mode', sae.effect_params ->> 'mode'
             ) as info
        from public._rr_active_effects_as_of(v_room_id, p_round_id) sae
        join public.spell_cards sc on sc.id = sae.card_id
       where sae.effect_kind = 'brewer_immunity'
       order by sae.target_player_id,
                coalesce((sae.effect_params ->> 'override_proof')::boolean, false) desc,
                (sae.effect_params ->> 'mode' = 'earl') asc,
                sae.created_at
    ) im;

  -- ------------------------------------------------------------------
  -- Tier 1: declared number (Inscribed Saucer), oldest first.
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
    -- Raw `rolls` value, not the post-shim roll (see the header).
    select r.player_id into v_pid
      from public.rolls r
     where r.round_id = p_round_id and r.layer = 0 and r.value = v_declared.number
       and public._rr_is_brewer_candidate(v_immune, r.player_id)
     order by r.player_id
     limit 1;

    if v_pid is not null then
      v_brewer_id := v_pid;
      v_brewer_source := 'declared_number';
      v_steps := v_steps || jsonb_build_array(public._rr_trace_step(
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

    -- issue #428: only non-candidates matched -- each is passed over and
    -- the next declared number (or the next tier) is tried.
    for v_pid in
      select r.player_id
        from public.rolls r
       where r.round_id = p_round_id and r.layer = 0 and r.value = v_declared.number
         and not public._rr_is_brewer_candidate(v_immune, r.player_id)
       order by r.player_id
    loop
      v_steps := v_steps || jsonb_build_array(public._rr_brewer_immunity_step(
        v_step_index, v_immune -> v_pid, v_pid, 'declared_number', v_declared.card_name
      ));
      v_step_index := v_step_index + 1;
    end loop;
  end loop;

  -- ------------------------------------------------------------------
  -- Tier 2: tea-maker override, last cast wins. Walk the overrides newest
  -- first; one that can't act (an inert Last Drip, #426, or a PG Tipped
  -- whose condition fails, #427) never enters the contest -- it leaves a
  -- no-op Trace step with its reason and the next-newest is considered.
  -- ------------------------------------------------------------------
  if v_brewer_id is null then
    for v_row in
      -- issue #425: an explicit `modifier_gain` number wins; the legacy
      -- `no_modifier_gain: true` (Drip Tray) reads as 0; otherwise null.
      select casts.effect_params->>'mode' as mode,
             casts.effect_params->>'condition' as condition,
             coalesce(
               (casts.effect_params->>'modifier_gain')::integer,
               case when coalesce((casts.effect_params->>'no_modifier_gain')::boolean, false)
                    then 0 end
             ) as modifier_gain,
             -- issue #427: a Phase 1 redirect (bounced back onto the cast's
             -- caster) retargets an override the same way it does a
             -- modifier cast in Phase 4a.
             coalesce(p_redirect_map ->> casts.id::text, casts.target_player_id) as chosen_player_id,
             coalesce(casts.target_pending, false) as target_pending,
             casts.id as cast_id,
             casts.caster_id as caster_id,
             sc.name as card_name,
             -- issue #430 (Tea Party Revolt): the lowest roller names the
             -- target after layer 0 is rolled.
             casts.effect_params->>'picker' as picker,
             casts.target_player_id as picked_player_id,
             casts.cast_inputs->>'revolt_picked_by' as picked_by,
             coalesce(casts.cast_inputs ? 'revolt_pick_abandoned', false) as pick_abandoned
        from public.spell_casts casts
        join public.spell_deck_instances sdi on sdi.id = casts.card_instance_id
        join public.spell_cards sc on sc.id = sdi.card_id
       where casts.round_id = p_round_id
         and casts.effect_kind = 'tea_maker_override'
         -- issue #430: a Revolt abandoned by stall is negated, but still
         -- traced so the Recap can say why it did nothing -- unless a counter
         -- negated it. With counters, Phase 1 has rewritten `negated` to the
         -- counter result alone, so a negated row was countered; without,
         -- only stall negates one.
         and (casts.negated = false
              or (casts.cast_inputs ? 'revolt_pick_abandoned' and not v_has_counters))
       order by casts.cast_at desc, casts.seq desc
    loop
      -- One mode dispatch: each mode resolves this override to a target
      -- (v_target) or to an inert outcome (v_inert_after + v_inert_extra,
      -- carrying the `override_reason`). Adding a mode means one branch
      -- here plus the CHECK on spell_casts / spell_card_effects.
      v_target := null;
      v_inert_after := null;
      v_inert_extra := null;

      if v_row.mode = 'prev_round_highest' then
        -- issue #426 (Last Drip): the room's most recent resolved round
        -- before this one -> its highest layer-0 roller (ties: lowest
        -- modifier_snapshot, then lowest player_id). Resolved even for a
        -- pending cast, as before #451.
        v_prev_round := null;
        select pr.id into v_prev_round
          from public.rounds pr
         where pr.room_id = v_room_id
           and pr.status = 'resolved'
           and pr.id <> p_round_id
           and pr.started_at < v_started_at
         order by pr.started_at desc, pr.id
         limit 1;

        if v_prev_round is not null then
          select r.player_id into v_target
            from public.rolls r
           where r.round_id = v_prev_round and r.layer = 0
           order by r.value desc, r.modifier_snapshot asc, r.player_id asc
           limit 1;
        end if;

        if v_target is null
           or not exists (
             select 1 from public.round_participants rp
              where rp.round_id = p_round_id and rp.player_id = v_target
           ) then
          v_inert_after := 'no effect';
          v_inert_extra := jsonb_build_object(
            'outcome', 'no-op',
            'override_reason', case when v_target is null
                                    then 'no_previous_round' else 'target_absent' end);
        end if;

      elsif v_row.picker = 'lowest_roller'
            and (v_row.pick_abandoned or v_row.picked_player_id is null) then
        -- issue #430 (Tea Party Revolt): no pick, so it never enters.
        -- `pick_abandoned`: stall cleared it. `pick_pending`: only seen by
        -- a dry run (the Provisional Recap) -- layer 0 is held incomplete
        -- until the pick is made.
        v_inert_after := 'no effect';
        v_inert_extra := jsonb_build_object(
          'outcome', 'no-op',
          'override_reason', case when v_row.pick_abandoned
                                  then 'pick_abandoned' else 'pick_pending' end);

      elsif v_row.target_pending then
        -- a deferred Wild Brew Surge pick: the override still wins, and
        -- names nobody.
        null;

      elsif v_row.mode = 'chosen' then
        v_target := v_row.chosen_player_id;

      elsif v_row.mode = 'conditional_chosen' then
        -- issue #427 (PG Tipped): enters only if the target's layer-0 roll
        -- is lower than the caster's.
        if v_row.condition is distinct from 'target_below_caster' then
          raise exception 'resolve_round: unsupported conditional_chosen condition %', v_row.condition;
        end if;

        -- Post-shim summary rolls. A player with no layer-0 roll has
        -- nothing to compare, so the condition fails.
        v_cond_target_roll := v_rolls[array_position(v_players, v_row.chosen_player_id)];
        v_cond_caster_roll := v_rolls[array_position(v_players, v_row.caster_id)];

        v_target := v_row.chosen_player_id;
        if not coalesce(v_cond_target_roll < v_cond_caster_roll, false) then
          v_inert_after := 'condition not met';
          v_inert_extra := jsonb_build_object(
            'outcome', 'no-op',
            'override_reason', 'condition_not_met',
            'override_condition', v_row.condition,
            'target_roll', v_cond_target_roll,
            'caster_roll', v_cond_caster_roll
          );
        end if;

      elsif v_row.mode = 'highest_roll' then
        -- Post-shim summary rolls.
        select v_players[i] into v_target
          from generate_subscripts(v_players, 1) i
         order by v_rolls[i] desc, v_players[i]
         limit 1;

      elsif v_row.mode = 'highest_modifier' then
        -- issue #321: a Cloud of Cream holder is skipped and the
        -- next-highest `modifier_snapshot` roller is picked; if every roller
        -- is skipped, fall back to the plain highest. Raw `rolls` table
        -- snapshot (see the header).
        select r.player_id into v_plain_high
          from public.rolls r
         where r.round_id = p_round_id and r.layer = 0
         order by r.modifier_snapshot desc, r.player_id
         limit 1;

        select r.player_id into v_target
          from public.rolls r
         where r.round_id = p_round_id and r.layer = 0
           and not (r.player_id = any (v_skip_players))
         order by r.modifier_snapshot desc, r.player_id
         limit 1;

        if v_target is null then
          v_target := v_plain_high;
        elsif v_plain_high is not null
              and v_plain_high <> v_target
              and (p_skip_map ? v_plain_high) then
          v_steps := v_steps || jsonb_build_array(public._rr_trace_step(
            v_step_index,
            'targeting_skip',
            jsonb_build_object(
              'cast_id', null,
              'active_effect_id', p_skip_map -> v_plain_high -> 'ae_id',
              'card_name', to_jsonb('Cloud of Cream'::text),
              'caster_player_id', p_skip_map -> v_plain_high -> 'caster_id'
            ),
            v_plain_high,
            jsonb_build_object('type', 'status', 'value', 'targetable'),
            jsonb_build_object('type', 'status', 'value', 'skipped')
          ));
          v_step_index := v_step_index + 1;
        end if;

      else
        -- issue #425: unreachable -- the mode set is closed (CHECK on
        -- spell_casts and spell_card_effects) and every mode is handled
        -- above. A guard, not a code path.
        raise exception 'resolve_round: unsupported tea_maker_override mode %', v_row.mode;
      end if;

      if v_inert_after is not null then
        v_steps := v_steps || jsonb_build_array(public._rr_override_step(
          v_step_index, v_row.cast_id, v_row.card_name, v_row.caster_id,
          v_target, v_inert_after, v_inert_extra
        ));
        v_step_index := v_step_index + 1;
        continue;
      end if;

      -- the newest override that can act wins
      v_override := v_row;
      v_override_live := not v_row.target_pending;
      exit;
    end loop;

    if v_override_live then
      if v_target is not null
         and v_immune -> v_target ->> 'mode' = 'earl'
         and v_override.caster_id is distinct from v_target then
        -- issue #429 (ADR 0005 tier 0's one exception): forcing tea on the
        -- Earl passes the title to the override's caster FIRST, and the
        -- override then lands on the ex-Earl, who brews (the branch below).
        -- Any mode counts as a force. Only decided and traced here -- this
        -- also runs under the Provisional Recap's rolled-back dry run (ADR
        -- 0007) -- and finalize_layer's commit step writes it
        -- (_rr_apply_earl_title). An Earl immune for another reason too
        -- isn't `earl` in v_immune, and an override the Earl cast on
        -- themselves can't pass the title to its own holder: both fall
        -- through as plain immunity.
        v_earl_transfer := jsonb_build_object(
          'active_effect_id', v_immune -> v_target -> 'ae_id',
          'from_player_id', v_target,
          'to_player_id', v_override.caster_id,
          'cast_id', v_override.cast_id
        );

        v_steps := v_steps || jsonb_build_array(public._rr_trace_step(
          v_step_index,
          'earl_transfer',
          jsonb_build_object(
            'cast_id', null,
            'active_effect_id', v_immune -> v_target -> 'ae_id',
            'card_name', v_immune -> v_target -> 'card_name',
            'caster_player_id', v_immune -> v_target -> 'caster_id'
          ),
          v_target,
          jsonb_build_object('type', 'status', 'value', 'earl'),
          jsonb_build_object('type', 'status', 'value', 'title passed'),
          jsonb_build_object(
            'new_earl_player_id', v_override.caster_id,
            'forcing_card_name', v_override.card_name
          )
        ));
        v_step_index := v_step_index + 1;
      end if;

      if v_target is not null
         and v_earl_transfer is null
         and not public._rr_is_brewer_candidate(v_immune, v_target) then
        -- issue #428: an immune override target falls through to the default
        -- pick, whatever the mode. (Override-proof immunity -- The Last
        -- Cuppa -- always does; a forced Earl passed the title above
        -- instead, issue #429.)
        v_steps := v_steps || jsonb_build_array(public._rr_brewer_immunity_step(
          v_step_index, v_immune -> v_target, v_target, 'tea_maker_override', v_override.card_name
        ));
        v_step_index := v_step_index + 1;
      else
        -- A live override that resolved to nobody (e.g. a `highest_roll`
        -- with no rollers) still records its gain and step and falls
        -- through to the default pick, as before #451.
        v_brewer_id := v_target;
        v_modifier_gain := v_override.modifier_gain;
        v_brewer_source := 'tea_maker_override:' || v_override.mode;
        v_steps := v_steps || jsonb_build_array(public._rr_override_step(
          v_step_index, v_override.cast_id, v_override.card_name, v_override.caster_id,
          v_brewer_id,
          case when v_modifier_gain = 0 then 'brewer (no modifier gain)' else 'brewer' end,
          -- issue #430: who made a Tea Party Revolt pick.
          case when v_override.picked_by is not null
               then jsonb_build_object('picked_by', v_override.picked_by) end
        ));
        v_step_index := v_step_index + 1;
      end if;
    end if;
  end if;

  -- ------------------------------------------------------------------
  -- Tier 4: default lowest roller (post-shim summary values). issue #289:
  -- v_dice_reduced excludes a Calami-Tea-floored roll from the natural-1
  -- auto-lose pool (a real natural 1 still brews).
  --
  -- issue #428: the pool is Brewer Candidates only, so the next-lowest
  -- roller brews. Each non-candidate the unfiltered pick named gets a skip
  -- step. No roller a candidate: immunity gives way, and the round ties
  -- across every participant still in it (a Tie-Break Reroll, the normal
  -- tie path at finalize_layer). That pool is `round_participants`, not the
  -- rollers -- kept as-is by #451.
  -- ------------------------------------------------------------------
  if v_brewer_id is null then
    v_tied := public._rr_pick_lowest(v_players, v_rolls, v_composed, v_dice_reduced);

    -- A fast path, and the gate on the all-immune give-way: with no live
    -- immunity the unfiltered pick stands. Skip steps read their payload from
    -- the immunity map, since today "not a candidate" means "immune". Both
    -- assumptions go when Roll Exemption (#433) / Tea Cosy (#434) widen
    -- _rr_is_brewer_candidate.
    if v_immune <> '{}'::jsonb then
      select array_agg(v_players[i] order by i), array_agg(v_rolls[i] order by i),
             array_agg(v_composed[i] order by i), array_agg(v_dice_reduced[i] order by i)
        into v_pool_players, v_pool_rolls, v_pool_composed, v_pool_reduced
        from generate_subscripts(v_players, 1) i
       where public._rr_is_brewer_candidate(v_immune, v_players[i]);

      if v_pool_players is null then
        select array_agg(rp.player_id order by rp.player_id) into v_tied
          from public.round_participants rp
         where rp.round_id = p_round_id and rp.excluded_at is null;

        v_steps := v_steps || jsonb_build_array(public._rr_trace_step(
          v_step_index,
          'brewer_immunity',
          jsonb_build_object('cast_id', null, 'active_effect_id', null, 'card_name', null, 'caster_player_id', null),
          null,
          jsonb_build_object('type', 'status', 'value', 'immune'),
          jsonb_build_object('type', 'status', 'value',
            case when array_length(v_tied, 1) > 1 then 'tie' else 'brewer' end),
          jsonb_build_object('immunity_tier', 'all_immune', 'skipped_card_name', null)
        ));
        v_step_index := v_step_index + 1;
      else
        foreach v_pid in array v_tied loop
          if not public._rr_is_brewer_candidate(v_immune, v_pid) then
            v_steps := v_steps || jsonb_build_array(public._rr_brewer_immunity_step(
              v_step_index, v_immune -> v_pid, v_pid, 'lowest_roller', null
            ));
            v_step_index := v_step_index + 1;
          end if;
        end loop;

        v_tied := public._rr_pick_lowest(v_pool_players, v_pool_rolls, v_pool_composed, v_pool_reduced);
      end if;
    end if;

    if array_length(v_tied, 1) > 1 then
      v_outcome := 'tie';
      v_brewer_source := null;
      v_modifier_gain := null;
    else
      v_brewer_id := v_tied[1];
      v_brewer_source := 'default';
      v_tied := null;
    end if;
  end if;

  -- ------------------------------------------------------------------
  -- Tier 3 (issue #431): Loose Leaf roll-off. Keyed to the final named
  -- brewer, whichever tier named them, so it runs after the default pick.
  -- The holder's armed effect is a `named_tea_maker_rolloff` Cast Log row
  -- for this round, aimed at them (SELF); a counter negates it in Phase 1.
  -- The line-up is the layer-0 rollers -- the brewer and the Brewer
  -- Candidates -- ordered by post-shim roll, then composed modifier. The
  -- opponents are every roller other than the holder sharing the
  -- second-place (roll, modifier): a tie there sends them all into the
  -- roll-off, never a player-id tiebreak. There are none when fewer than
  -- three are in the line-up -- in a two-player round the "second-lowest"
  -- is the top roller -- or when the holder alone is second-lowest: the
  -- card then does nothing. Otherwise the outcome is an unfinished
  -- `rolloff`, which finalize_layer commits like a tie: a Tie-Break Reroll
  -- Layer for the holder and the opponents, where the lowest roll brews
  -- with normal modifier gain.
  -- ------------------------------------------------------------------
  if v_brewer_id is not null then
    select casts.id, casts.caster_id, sc.name as card_name
      into v_rolloff
      from public.spell_casts casts
      join public.spell_deck_instances sdi on sdi.id = casts.card_instance_id
      join public.spell_cards sc on sc.id = sdi.card_id
     where casts.round_id = p_round_id
       and casts.effect_kind = 'named_tea_maker_rolloff'
       and casts.negated = false
       and casts.target_player_id = v_brewer_id
     order by casts.cast_at, casts.seq
     limit 1;

    if found then
      select array_agg(i order by i)
        into v_rolloff_lineup
        from generate_subscripts(v_players, 1) i
       where v_players[i] = v_brewer_id
          or public._rr_is_brewer_candidate(v_immune, v_players[i]);

      if coalesce(array_length(v_rolloff_lineup, 1), 0) >= 3 then
        select v_rolls[i], v_composed[i]
          into v_rolloff_second_roll, v_rolloff_second_composed
          from unnest(v_rolloff_lineup) i
         order by v_rolls[i], v_composed[i]
        offset 1 limit 1;

        -- all of them roll off; listed by player id only so the order is
        -- stable, never to pick between them
        select array_agg(v_players[i] order by v_players[i])
          into v_rolloff_opponents
          from unnest(v_rolloff_lineup) i
         where v_players[i] <> v_brewer_id
           and v_rolls[i] = v_rolloff_second_roll
           and v_composed[i] = v_rolloff_second_composed;
      end if;

      if v_rolloff_opponents is not null then
        v_rolloff_after := 'rolloff';
        v_rolloff_extra := jsonb_build_object('rolloff_opponent_ids', to_jsonb(v_rolloff_opponents));
      else
        v_rolloff_after := 'no effect';
        v_rolloff_extra := jsonb_build_object('outcome', 'no-op', 'rolloff_reason', 'no_second_lowest');
      end if;

      v_steps := v_steps || jsonb_build_array(public._rr_trace_step(
        v_step_index,
        'named_tea_maker_rolloff',
        jsonb_build_object(
          'cast_id', to_jsonb(v_rolloff.id),
          'active_effect_id', null,
          'card_name', to_jsonb(v_rolloff.card_name),
          'caster_player_id', to_jsonb(v_rolloff.caster_id)
        ),
        v_brewer_id,
        jsonb_build_object('type', 'status', 'value', 'brewer'),
        jsonb_build_object('type', 'status', 'value', v_rolloff_after),
        v_rolloff_extra
      ));
      v_step_index := v_step_index + 1;

      if v_rolloff_opponents is not null then
        v_outcome := 'rolloff';
        v_tied := array[v_brewer_id] || v_rolloff_opponents;
        v_brewer_id := null;
        v_brewer_source := null;
        v_modifier_gain := null;
      end if;
    end if;
  end if;

  return jsonb_build_object(
    'outcome', v_outcome,
    'brewer_id', v_brewer_id,
    'brewer_source', v_brewer_source,
    'modifier_gain', v_modifier_gain,
    'tied_player_ids', to_jsonb(v_tied),
    'earl_transfer', v_earl_transfer,
    'steps', v_steps
  );
end;
$$;

revoke execute on function public._rr_select_tea_maker(uuid, jsonb, jsonb, jsonb, integer) from public, anon, authenticated;

comment on function public._rr_select_tea_maker(uuid, jsonb, jsonb, jsonb, integer) is
  'Issue #451 (ADR 0005 #425 amendment): Phase 5 of the Resolver pipeline -- tea-maker selection by the Tea-Maker Precedence Ladder (tier 0 Brewer Immunity via _rr_is_brewer_candidate, tier 1 declared number, tier 2 tea_maker_override last-cast-wins, tier 4 default lowest roller, then tier 3 the Loose Leaf roll-off keyed to the named brewer against every roller tied at second-lowest, issue #431). Takes the layer-0 Resolution Summary, Phase 1 redirects, the targeting_skip map and the Trace step cursor; returns { outcome brewer|tie|rolloff, brewer_id, brewer_source, modifier_gain, tied_player_ids, earl_transfer (issue #429: the Earl title transfer finalize_layer writes, or null), steps }. Read-only. Called by _rr_resolve_eval only. Internal.';
-- END db/sql/functions/_rr_select_tea_maker.sql

-- BEGIN db/sql/functions/finalize_layer.sql
-- finalize_layer(p_round_id uuid) -> jsonb
--
-- Layer finalization (ADR 0008, issue #414) in one locked transaction. Takes
-- the round row lock first -- the same lock resolve_round takes, so the nested
-- resolve_round call below reuses it -- then does nothing unless the round can
-- finalize: it is `closed`, the current Layer is complete (_layer_is_complete,
-- no caller-identity gate), and at Layer 0 a reaction window exists and is
-- closed. Otherwise:
--   1. runs the eager roll-input shim in the documented order (ADR 0005):
--      forced rerolls, then flip, then swap, then chosen-pair. Each apply_*
--      records its before->after into the Cast Log (cast_inputs.roll_transform)
--      as it always has;
--   2. calls resolve_round(uuid), the persisting resolver, unchanged;
--   3. commits the outcome -- brewer: write the resolution (modifier gain
--      included, issue #425), move any Tea Heist card (_rr_apply_heists,
--      issue #438), write the Earl of Earl Grey title (_rr_apply_earl_title,
--      issue #429) and record any pending Round Replay; tie: advance to the
--      next Layer with the tied players. A Loose Leaf roll-off (issue #431)
--      commits the way a tie does -- a Tie-Break Reroll Layer for the named
--      holder and the second-lowest roller -- and returns a tie-shaped outcome
--      marked `rolloff`. It also writes any Earl title transfer decided with
--      it now, since the deciding Layer's resolve won't return it again.
--
-- The Inscribed Saucer declared-number trigger needs no separate write: since
-- #310 its sentinel is a duration-1 projection row that ages out once this
-- round resolves, so committing the resolution in this transaction is what
-- burns it -- exactly once.
--
-- Never raises for who the caller is or for losing a race: a second caller
-- blocks on the lock, then finds the round resolved (or on the next Layer)
-- and returns noop. Called by the round-advancement module
-- (src/app/rounds/advanceRound.ts).
--
-- Canonical source: this file is the source of truth for the function body.
-- Edit here and run `npm run build:migrations` -- do not hand-edit the
-- generated migration. See db/sql/README.md.

create or replace function public.finalize_layer(p_round_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_status text;
  v_layer integer;
  v_target text;
  v_out jsonb;
  v_brewer_id text;
  v_cups_made integer;
  v_modifier_gain integer;
  v_tied text[];
  v_next_layer integer;
  v_replay_pending boolean;
  v_rolls jsonb;
begin
  select status, current_layer into v_status, v_layer
    from public.rounds
   where id = p_round_id
     for update;

  if v_status is null then
    return jsonb_build_object('outcome', 'noop', 'reason', 'round_not_found');
  end if;

  if v_status <> 'closed' then
    return jsonb_build_object('outcome', 'noop', 'reason', 'round_not_closed');
  end if;

  if v_layer = 0 then
    -- Opening Layer 0's window is advance_layer's job; finalization only ever
    -- follows a window that has closed.
    if not exists (
      select 1 from public.spell_reaction_windows
       where round_id = p_round_id and layer = 0
    ) then
      return jsonb_build_object('outcome', 'noop', 'reason', 'no_window');
    end if;

    if exists (
      select 1 from public.spell_reaction_windows
       where round_id = p_round_id and layer = 0 and status = 'open'
    ) then
      return jsonb_build_object('outcome', 'noop', 'reason', 'window_open');
    end if;
  end if;

  if not public._layer_is_complete(p_round_id, v_layer) then
    -- issue #430: `revolt_pick_pending` when rolled but waiting on a Tea
    -- Party Revolt pick.
    return jsonb_build_object('outcome', 'noop', 'reason', public._layer_hold_reason(p_round_id, v_layer));
  end if;

  -- 1. The eager roll-input shim (ADR 0005): forced rerolls, flip, swap,
  -- chosen-pair -- "flip before swap before chosen-pair" is the documented
  -- tie of record for a player hit by more than one.
  for v_target in
    select t.target_player_id from public.get_forced_reroll_targets(p_round_id, v_layer) t
  loop
    perform public.apply_forced_reroll(p_round_id, v_layer, v_target);
  end loop;

  if public.has_active_cast_kind(p_round_id, v_layer, 'roll_flip') then
    perform 1 from public.apply_roll_flip(p_round_id, v_layer);
  end if;

  if public.has_active_cast_kind(p_round_id, v_layer, 'roll_swap') then
    perform 1 from public.apply_roll_swap(p_round_id, v_layer);
  end if;

  if public.has_active_cast_kind(p_round_id, v_layer, 'roll_pair_transform') then
    perform 1 from public.apply_roll_pair_transform(p_round_id, v_layer);
  end if;

  -- 2. The persisting resolver.
  v_out := public.resolve_round(p_round_id);

  -- 3. Commit the outcome.
  if v_out ->> 'outcome' in ('tie', 'rolloff') then
    select array_agg(t) into v_tied
      from jsonb_array_elements_text(v_out -> 'tied_player_ids') t;

    v_next_layer := public.advance_round_layer(p_round_id, v_tied);

    -- issue #431: an Earl forced into a Loose Leaf roll-off has still been
    -- forced, so the title passes now: the roll-off Layer's resolve carries
    -- no transfer. Idempotent, like its later call on the brewer commit.
    if v_out ->> 'outcome' = 'rolloff' then
      perform public._rr_apply_earl_title(p_round_id, v_out -> 'earl_transfer');
    end if;

    return jsonb_build_object(
      'outcome', 'tie',
      'layer', v_next_layer,
      'tied_player_ids', to_jsonb(v_tied),
      'rolloff', v_out ->> 'outcome' = 'rolloff');
  end if;

  v_brewer_id := v_out ->> 'brewer_id';
  v_cups_made := (v_out ->> 'cups_made')::integer;

  -- issue #425: the modifier gain number (null = cups_made, 0 = none, else
  -- as given); typed, so it binds the integer overload, not the yes/no alias.
  v_modifier_gain := (v_out ->> 'modifier_gain')::integer;

  perform public.resolve_round(p_round_id, v_brewer_id, v_cups_made, v_modifier_gain);

  -- Tea Heist (issue #438, ADR 0005 #383 amendment): the resolver only
  -- traced each Heist; the card moves here, with the resolution write.
  perform public._rr_apply_heists(p_round_id);

  -- Earl of Earl Grey (issue #429): likewise the resolver only decided any
  -- title transfer; it is written here, and an Earl displaced this round
  -- (by a transfer or a fresh cast) has its row ended.
  perform public._rr_apply_earl_title(p_round_id, v_out -> 'earl_transfer');

  v_replay_pending := public.record_pending_round_replay(p_round_id);

  -- The Layer's final (post-shim) rolls, for the round-revealed broadcast.
  v_rolls := public._layer_rolls_json(p_round_id, v_layer);

  return jsonb_build_object(
    'outcome', 'brewer',
    'layer', v_layer,
    'brewer_id', v_brewer_id,
    'cups_made', v_cups_made,
    'rolls', v_rolls,
    'replay_pending', v_replay_pending);
end;
$$;

revoke execute on function public.finalize_layer(uuid) from public, anon;
grant execute on function public.finalize_layer(uuid) to authenticated;

comment on function public.finalize_layer(uuid) is
  'Layer finalization (ADR 0008, issue #414). Locks the round, then returns { outcome: "noop", reason } unless the round is closed, its current Layer is complete, and (at Layer 0) its reaction window exists and is closed -- reasons: round_not_found, round_not_closed, no_window, window_open, layer_incomplete, revolt_pick_pending (rolled, but a Tea Party Revolt pick is outstanding; issue #430). Otherwise, in one transaction: runs the eager roll-input shim (forced rerolls, flip, swap, chosen-pair; ADR 0005), calls resolve_round(uuid) unchanged, and commits the outcome. Returns { outcome: "brewer", layer, brewer_id, cups_made, rolls: [{ player_id, value, discarded_value, entered_by_admin }], replay_pending } after writing the resolution (its modifier gain included, issue #425), moving any Tea Heist card (issue #438), writing the Earl of Earl Grey title (issue #429) and recording any pending Round Replay; or { outcome: "tie", layer, tied_player_ids, rolloff } after advancing to the next Layer (layer is the new one; rolloff true when it is a Loose Leaf roll-off, issue #431, which also writes any Earl title transfer decided with it). Never raises for caller identity or a lost race.';
-- END db/sql/functions/finalize_layer.sql

