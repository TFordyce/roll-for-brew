-- Cast-Log resolution phase: negate / redirect / WILD branch / recursive
-- counter chains, all derived from recorded Cast Log inputs (issue #307,
-- fourth implementation slice of the effect-application rebuild #302 /
-- ADR 0005).
--
-- Migration number: master's highest is 0077 (0077_cast_log_schema_expand);
-- the rebuild branch adds 0078 (resolve_round authoritative, #305), 0079
-- (eager shim, #306). This is 0080. Re-check at the integrate step
-- (branching strategy in #303) and renumber to sit after master's current
-- highest.
--
-- What changes
-- ------------
-- 1. cast_reaction_spell_card: the inline `random()` d20 for a
--    contested_negate cast is recorded into `cast_inputs.dc_d20` (a
--    server-RNG draw -> Cast Log), alongside the tier-derived-or-overridden
--    DC in `cast_inputs.dc`. `effect_params.dc` (from the card's
--    spell_card_effects row) overrides the tier default -- Saving Steep sets
--    {"dc": 10}, Tannin Tantrum omits it. resolved_value keeps the d20 in
--    parallel for legacy readers until #312. The in-place `negated` write
--    stays as a PROVISIONAL cache for live readers (the reaction stack, the
--    finalize shim's negated filter, the get_round_modifier_effects
--    preview); resolve_round Phase 1 recomputes it recursively and
--    overwrites it authoritatively. `redirect` stops doing an in-place
--    `target_player_id` UPDATE -- it writes a provisional
--    `redirected_to_cast_id` pointer instead, and resolve_round derives the
--    effective target.
--
-- 2. cast_spell_card: the WILD-dispatch cast row records its d6 branch pick
--    into `cast_inputs.branch` (in parallel with the existing
--    `resolved_value` / `effect_params.branch`). WILD branches 4 and 6
--    already insert real forced_reroll / tea_maker_override spell_casts
--    rows that flow through resolve_round's normal phases; branches 1/2/3/5
--    mutate room_players directly and belong to the persistent-modifier
--    slice (#297), untouched here.
--
-- 3. resolve_round(uuid) gains Phase 1 (Cast-Log resolution), run before
--    Phase 3 so every later phase and get_round_modifier_effects read a
--    fresh, authoritative `negated`:
--      * Recursive, memoised negation derivation over the reaction stack:
--        negated(X) = there exists a succeeded contested_negate counter C
--        targeting X's cast group where not negated(C). Walked top-of-stack
--        (highest seq) down; terminates because every counter targets a
--        strictly-lower seq. Counter-of-counter resolves to arbitrary depth.
--      * `redirect` retargets a countered cast's modifier effect onto the
--        redirector's own caster, from recorded state -- no in-place
--        target_player_id mutation.
--      * spell_casts.negated and spell_casts.redirected_to_cast_id are
--        rewritten as resolver-owned caches that always agree with a replay.
--      * Trace: one struck-through no-op step per negated cast group, one
--        target-change step per redirect, one outcome step per
--        contested_negate cast. The dc_d20 roll is never its own step.
--    Phase 4a buckets a redirected modifier effect against its effective
--    (post-redirect) target.
--
-- 4. get_round_modifier_effects: unchanged in shape and output. Its
--    `negated = false` filter now simply reflects the resolver's
--    authoritative derivation rather than an eager single-level write --
--    "the negated filter moves into the resolver" (spec §1 / #307). A
--    behaviour-relevant change to this RPC's output would break the
--    RollCalculation UI regression bar (branching strategy in #303), so it
--    is deliberately left alone.

-- ===========================================================================
-- 0. small shared helpers
-- ===========================================================================
-- Tier-derived contested_negate DC default (spec §1 / #307). Used by both
-- cast_reaction_spell_card (provisional write) and _rr_cast_log_resolution
-- (authoritative derivation) so the two can never drift apart.
create or replace function public._rr_tier_default_dc(p_tier text)
returns integer
language sql
immutable
as $$
  select case p_tier when 'common' then 2 when 'rare' then 5 else 10 end;
$$;

revoke execute on function public._rr_tier_default_dc(text) from public, anon;
grant execute on function public._rr_tier_default_dc(text) to authenticated;

-- Resolution Trace step (0078's 6-arg form) with extra top-level keys merged
-- in: an explicit `outcome` override where before/after alone don't imply it,
-- or `negated: true` for a struck-through step. p_extra wins on key collision.
-- The 6-arg form is unchanged and still used by every other phase.
create or replace function public._rr_trace_step(
  p_index integer, p_display_kind text, p_source_cast jsonb,
  p_target_player text, p_before jsonb, p_after jsonb, p_extra jsonb
)
returns jsonb
language sql
immutable
as $$
  select public._rr_trace_step(
           p_index, p_display_kind, p_source_cast, p_target_player, p_before, p_after
         ) || coalesce(p_extra, '{}'::jsonb);
$$;

revoke execute on function public._rr_trace_step(integer, text, jsonb, text, jsonb, jsonb, jsonb) from public, anon;
grant execute on function public._rr_trace_step(integer, text, jsonb, text, jsonb, jsonb, jsonb) to authenticated;

-- ===========================================================================
-- 1. _rr_cast_log_resolution -- recursive negate / redirect derivation
-- ===========================================================================
-- Returns one row per contested_negate / redirect cast in the round, with:
--   * whether that counter itself is negated (a higher counter countered it),
--   * whether its contest succeeded (dc_d20 >= dc; always true for redirect),
--   * the card_instance_id ("cast group") it targets and that group's current
--     target_player_id,
--   * for a redirect, the player the countered effect is moved onto (the
--     redirector's caster).
-- resolve_round folds these into the negated set / redirect map and the
-- Trace. Pure over (spell_casts + cast_inputs); no writes.

drop function if exists public._rr_cast_log_resolution(uuid);
create function public._rr_cast_log_resolution(p_round_id uuid)
returns table (
  counter_cast_id uuid,
  counter_kind text,
  counter_seq bigint,
  counter_negated boolean,
  counter_succeeded boolean,
  counter_caster text,
  victim_group uuid,
  victim_orig_target text,
  victim_caster text,
  redirect_to text
)
language plpgsql
stable
set search_path = public
as $$
declare
  v_counters jsonb := '[]'::jsonb;
  v_n integer;
  v_idx integer;
  v_pass integer;
  v_changed boolean;
  v_c jsonb;
  v_neg boolean;
begin
  -- Gather every contested_negate / redirect cast in the round together with
  -- the cast group it targets (parent_cast_id -> that cast's card_instance_id)
  -- and whether its contest passed. Ordered by seq so the fixpoint below
  -- walks the stack deterministically.
  select coalesce(jsonb_agg(entry order by (entry->>'seq')::bigint), '[]'::jsonb)
    into v_counters
    from (
      select jsonb_build_object(
               'counter_cast_id', c.id,
               'kind', c.effect_kind,
               'seq', c.seq,
               'caster_id', c.caster_id,
               -- the cast group this counter TARGETS (its parent's group)
               'target_group', tgt.card_instance_id,
               -- this counter's OWN cast group (what a counter-of-counter
               -- would in turn target)
               'own_group', c.card_instance_id,
               'victim_orig_target', tgt.target_player_id,
               'victim_caster', tgt.caster_id,
               'succeeded', case
                 when c.effect_kind = 'redirect' then true
                 else coalesce(
                   (c.cast_inputs->>'dc_d20')::int >= coalesce(
                     (c.cast_inputs->>'dc')::int,
                     public._rr_tier_default_dc(tcard.tier)),
                   false)
               end,
               'is_negated', false
             ) as entry
        from public.spell_casts c
        join public.spell_casts tgt on tgt.id = c.parent_cast_id
        join public.spell_deck_instances tsdi on tsdi.id = tgt.card_instance_id
        join public.spell_cards tcard on tcard.id = tsdi.card_id
       where c.round_id = p_round_id
         and c.effect_kind in ('contested_negate', 'redirect')
    ) s;

  v_n := jsonb_array_length(v_counters);
  if v_n = 0 then
    return;
  end if;

  -- Fixpoint: a counter is negated iff some higher-seq contested_negate
  -- targets ITS OWN cast group (d.target_group = v_c.own_group), succeeded,
  -- and is not itself negated. Since every contested_negate targets a
  -- strictly-lower seq, at most v_n passes converge (bounded here at
  -- 2*n + 2 as a safety net). This is what makes counter-of-counter chains
  -- resolve to arbitrary depth.
  for v_pass in 1 .. (2 * v_n + 2) loop
    v_changed := false;
    for v_idx in 0 .. v_n - 1 loop
      v_c := v_counters -> v_idx;
      v_neg := exists (
        select 1
          from jsonb_array_elements(v_counters) d
         where d.value->>'kind' = 'contested_negate'
           and (d.value->>'target_group') = (v_c->>'own_group')
           and (d.value->>'seq')::bigint > (v_c->>'seq')::bigint
           and (d.value->>'succeeded')::boolean
           and not (d.value->>'is_negated')::boolean
      );
      if v_neg is distinct from (v_c->>'is_negated')::boolean then
        v_counters := jsonb_set(v_counters, array[v_idx::text, 'is_negated'], to_jsonb(v_neg));
        v_changed := true;
      end if;
    end loop;
    exit when not v_changed;
  end loop;

  for v_idx in 0 .. v_n - 1 loop
    v_c := v_counters -> v_idx;
    counter_cast_id   := (v_c->>'counter_cast_id')::uuid;
    counter_kind      := v_c->>'kind';
    counter_seq       := (v_c->>'seq')::bigint;
    counter_negated   := (v_c->>'is_negated')::boolean;
    counter_succeeded := (v_c->>'succeeded')::boolean;
    counter_caster    := v_c->>'caster_id';
    victim_group      := (v_c->>'target_group')::uuid;
    victim_orig_target := v_c->>'victim_orig_target';
    victim_caster     := v_c->>'victim_caster';
    -- A redirect reflects the reactor's exposure back onto the countered
    -- cast's ORIGINAL caster (spec §8 -- "onto the original caster"); the
    -- classic Mug Mirror reflect. Null unless this is a live (non-negated)
    -- redirect.
    redirect_to := case
      when v_c->>'kind' = 'redirect' and not (v_c->>'is_negated')::boolean
        then v_c->>'victim_caster'
      else null
    end;
    return next;
  end loop;
end;
$$;

revoke execute on function public._rr_cast_log_resolution(uuid) from public, anon;
grant execute on function public._rr_cast_log_resolution(uuid) to authenticated;

comment on function public._rr_cast_log_resolution(uuid) is
  'Issue #307: recursive, memoised negate/redirect derivation over a round''s reaction stack, purely from recorded cast_inputs. One row per contested_negate / redirect cast: whether it is itself negated (counter-of-counter to any depth), whether its contest succeeded, the cast group it targets, and (for redirect) the player its effect moves onto. resolve_round Phase 1 consumes this.';

-- ===========================================================================
-- 2. cast_spell_card -- record WILD branch pick into cast_inputs.branch
-- ===========================================================================
-- The current (migration 0076) definition, with the sole change that both
-- wild_dispatch INSERTs now also write cast_inputs = { "branch": <d6> }. The
-- 0076 Kettle Crash special-case (reset_persistent_modifier -> live modifier
-- reset, #285) is carried through unchanged.

create or replace function public.cast_spell_card(
  p_round_id uuid, p_target_player_id text default null,
  p_chosen_player_ids text[] default null, p_declared_number integer default null
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
  v_casting_time text;
  v_target_stamp text;
  v_target_pending boolean := false;
  v_final_target text := p_target_player_id;
  v_cast_id uuid;
  v_effect record;
  v_row_target text;
  v_row_pending boolean;
  v_row_cast_id uuid;
  v_resolved_value numeric;
  v_dice_count integer;
  v_dice_sides integer;
  v_dice_sign integer;
  v_roll_total integer;
  v_effect_params jsonb;
  v_max_targets integer;
  v_chosen_id text;
  v_branch integer;
  v_other_id text;
  v_extreme_low text;
  v_extreme_high text;
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

  select sdi.id, sc.id, sc.casting_time, sc.target
    into v_instance_id, v_card_id, v_casting_time, v_target_stamp
    from public.spell_deck_instances sdi
    join public.spell_cards sc on sc.id = sdi.card_id
   where sdi.held_by_player = v_player_id and sdi.location = 'held';

  if v_instance_id is null then
    raise exception 'cast_spell_card: caller is not holding a card';
  end if;

  if v_casting_time <> 'A' then
    raise exception 'cast_spell_card: only Action cards can be cast pre-roll';
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
      update public.room_players set modifier = modifier + 3
       where room_id = v_room_id and player_id = v_player_id;
      v_effect_params := '{"delta": 3}'::jsonb;
    elsif v_branch = 3 then
      select player_id into v_other_id
        from public.room_players
       where room_id = v_room_id and player_id <> v_player_id
       order by random()
       limit 1;
      if v_other_id is not null then
        perform public.swap_room_player_modifiers(v_room_id, v_player_id, v_other_id);
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
        perform public.swap_room_player_modifiers(v_room_id, v_extreme_high, v_extreme_low);
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
        round_id, caster_id, card_instance_id, target_player_id, resolved_value,
        effect_kind, effect_params, cast_inputs
      )
      values (p_round_id, v_player_id, v_instance_id, null, v_branch,
              'wild_dispatch', '{"branch": 6}'::jsonb, jsonb_build_object('branch', v_branch));

      return v_cast_id;
    end if;

    insert into public.spell_casts (
      round_id, caster_id, card_instance_id, target_player_id, resolved_value,
      effect_kind, effect_params, cast_inputs
    )
    values (p_round_id, v_player_id, v_instance_id, null, v_branch,
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

      insert into public.spell_active_effects (
        room_id, target_player_id, caster_id, source_cast_id, card_id, effect_kind, effect_params, rounds_remaining
      )
      values (v_room_id, v_player_id, v_player_id, null, v_card_id, v_effect.effect_kind, v_effect_params, 9999);

      insert into public.spell_casts (
        round_id, caster_id, card_instance_id, target_player_id, effect_kind, effect_params, target_role
      )
      values (p_round_id, v_player_id, v_instance_id, null, v_effect.effect_kind, v_effect_params, v_effect.target_role)
      returning id into v_row_cast_id;

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
        v_resolved_value := null;

        if v_effect.effect_kind = 'dice_modifier' then
          v_dice_count := (regexp_match(v_effect_params ->> 'dice', '^(\d+)d(\d+)$'))[1]::integer;
          v_dice_sides := (regexp_match(v_effect_params ->> 'dice', '^(\d+)d(\d+)$'))[2]::integer;
          v_dice_sign := coalesce((v_effect_params ->> 'sign')::integer, 1);

          v_roll_total := 0;
          for i in 1..v_dice_count loop
            v_roll_total := v_roll_total + floor(random() * v_dice_sides + 1)::integer;
          end loop;

          v_resolved_value := v_roll_total * v_dice_sign;
        end if;

        insert into public.spell_casts (
          round_id, caster_id, card_instance_id, target_player_id, target_pending,
          effect_kind, effect_params, resolved_value, target_role
        )
        values (
          p_round_id, v_player_id, v_instance_id, v_chosen_id, false,
          v_effect.effect_kind, v_effect_params, v_resolved_value, v_effect.target_role
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

    v_resolved_value := null;

    insert into public.spell_casts (
      round_id, caster_id, card_instance_id, target_player_id, target_pending,
      effect_kind, effect_params, resolved_value, target_role
    )
    values (
      p_round_id, v_player_id, v_instance_id, v_row_target, v_row_pending,
      v_effect.effect_kind, v_effect_params, v_resolved_value, v_effect.target_role
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

  return v_cast_id;
end;
$$;

revoke execute on function public.cast_spell_card(uuid, text, text[], integer) from public, anon;
grant execute on function public.cast_spell_card(uuid, text, text[], integer) to authenticated;

-- ===========================================================================
-- 3. cast_reaction_spell_card -- record contested_negate d20 into cast_inputs;
--    redirect stops mutating target_player_id in place
-- ===========================================================================
-- Byte-for-byte the 0069 definition, with the sole changes in the
-- contested_negate / redirect tail of the per-effect loop (see header).

create or replace function public.cast_reaction_spell_card(
  p_round_id uuid, p_target_player_id text default null, p_target_cast_id uuid default null
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
  v_resolved_value numeric;
  v_dice_count integer;
  v_dice_sides integer;
  v_dice_sign integer;
  v_roll_total integer;
  v_target_tier text;
  v_target_target_player text;
  v_target_group uuid;
  v_dc integer;
  v_roll integer;
  v_participant record;
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
        v_resolved_value := null;

        if v_effect.effect_kind = 'dice_modifier' then
          v_dice_count := (regexp_match(v_effect.effect_params ->> 'dice', '^(\d+)d(\d+)$'))[1]::integer;
          v_dice_sides := (regexp_match(v_effect.effect_params ->> 'dice', '^(\d+)d(\d+)$'))[2]::integer;
          v_dice_sign := coalesce((v_effect.effect_params ->> 'sign')::integer, 1);

          v_roll_total := 0;
          for i in 1..v_dice_count loop
            v_roll_total := v_roll_total + floor(random() * v_dice_sides + 1)::integer;
          end loop;

          v_resolved_value := v_roll_total * v_dice_sign;
        end if;

        insert into public.spell_casts (
          round_id, caster_id, card_instance_id, target_player_id, target_pending,
          effect_kind, effect_params, resolved_value, parent_cast_id, reaction_window_id, target_role
        )
        values (
          p_round_id, v_player_id, v_instance_id, v_participant.player_id, false,
          v_effect.effect_kind, v_effect.effect_params, v_resolved_value, p_target_cast_id, v_window_id, v_effect.target_role
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

    v_resolved_value := null;

    insert into public.spell_casts (
      round_id, caster_id, card_instance_id, target_player_id, target_pending,
      effect_kind, effect_params, resolved_value, parent_cast_id, reaction_window_id, target_role
    )
    values (
      p_round_id, v_player_id, v_instance_id, v_row_target, false,
      v_effect.effect_kind, v_effect.effect_params, v_resolved_value, p_target_cast_id, v_window_id, v_effect.target_role
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
      -- resolved_value keeps the d20 in parallel for legacy readers (#312).
      update public.spell_casts
         set resolved_value = v_roll,
             cast_inputs = coalesce(cast_inputs, '{}'::jsonb)
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
    elsif v_effect.effect_kind = 'redirect' then
      update public.spell_casts set resolved_value = 1 where id = v_row_cast_id;

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

revoke execute on function public.cast_reaction_spell_card(uuid, text, uuid) from public, anon;
grant execute on function public.cast_reaction_spell_card(uuid, text, uuid) to authenticated;

-- ===========================================================================
-- 4. resolve_round(uuid) -- add Phase 1 (Cast-Log resolution)
-- ===========================================================================
-- Full redefinition of the 0079 function. The ONLY changes vs 0079:
--   * new Phase 1 block (between loading the layer-0 rollers and Phase 3):
--     recursive negate / redirect derivation via _rr_cast_log_resolution,
--     authoritative rewrite of spell_casts.negated /
--     spell_casts.redirected_to_cast_id, and Trace steps for negated /
--     redirected / contested_negate casts;
--   * Phase 4a carries casts.card_instance_id so a redirected modifier
--     effect buckets against its effective (post-redirect) target.
-- Everything else is byte-for-byte 0079.

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
begin
  select status, room_id, current_layer
    into v_status, v_room_id, v_layer
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
  -- Phase 1: Cast-Log resolution (issue #307).
  --
  -- Recursively derive which casts are negated (counter-of-counter to any
  -- depth) and which modifier effects are redirected, purely from the
  -- recorded reaction stack (contested_negate's cast_inputs.dc_d20, seq
  -- order). Rewrite the spell_casts.negated / spell_casts.redirected_to_
  -- cast_id caches so every later phase and get_round_modifier_effects read
  -- the authoritative derivation, and emit Trace steps. Skipped entirely
  -- (no writes, no steps) for a round with no contested_negate / redirect
  -- casts, so a zero-counter round stays byte-identical.
  -- ------------------------------------------------------------------
  select exists (
    select 1 from public.spell_casts
     where round_id = p_round_id
       and effect_kind in ('contested_negate', 'redirect')
  ) into v_has_counters;

  if v_has_counters then
    v_negated_groups := array[]::uuid[];
    v_redirect_map := '{}'::jsonb;

    -- Run the recursive negate/redirect derivation ONCE and memoise its rows
    -- for the three passes below (spec §pipeline-1: "one recursive, memoised
    -- counter-chain pass"). on commit drop clears it at RPC-txn end.
    drop table if exists _rr_clr_rows;
    create temp table _rr_clr_rows on commit drop as
      select * from public._rr_cast_log_resolution(p_round_id);

    for v_clr in
      select * from _rr_clr_rows
    loop
      -- A cast group is negated if a succeeded, non-negated contested_negate
      -- targets it.
      if v_clr.counter_kind = 'contested_negate'
         and v_clr.counter_succeeded
         and not v_clr.counter_negated then
        if not (v_clr.victim_group = any (v_negated_groups)) then
          v_negated_groups := v_negated_groups || v_clr.victim_group;
        end if;
      end if;

      -- A non-negated redirect moves its target group's effect onto the
      -- redirector's caster (last redirect by seq wins — _rr_cast_log_
      -- resolution already returns rows seq-asc).
      if v_clr.redirect_to is not null then
        v_redirect_map := jsonb_set(
          v_redirect_map,
          array[v_clr.victim_group::text],
          to_jsonb(v_clr.redirect_to),
          true
        );
      end if;
    end loop;

    -- Authoritative cache rewrite: negated is a pure function of the
    -- derivation for every cast in the round.
    update public.spell_casts
       set negated = (card_instance_id = any (v_negated_groups))
     where round_id = p_round_id;

    -- redirected_to_cast_id: clear, then re-point every redirected (and not
    -- also negated) group at its redirect cast.
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
         where round_id = p_round_id and card_instance_id = v_clr.victim_group;
      end if;
    end loop;

    -- Trace: one outcome step per contested_negate / redirect cast, plus one
    -- struck-through no-op step per negated victim group. The dc_d20 roll is
    -- never its own step.
    for v_clr in
      select clr.*, sc.name as counter_card_name
        from _rr_clr_rows clr
        join public.spell_casts c on c.id = clr.counter_cast_id
        join public.spell_deck_instances sdi on sdi.id = c.card_instance_id
        join public.spell_cards sc on sc.id = sdi.card_id
       order by clr.counter_seq
    loop
      if v_clr.counter_kind = 'contested_negate' then
        -- before ('cast') always differs from after, so outcome can't be
        -- derived from before/after alone -- pass it explicitly.
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
              when v_clr.counter_succeeded then 'negated target'
              else 'no effect'
            end),
          jsonb_build_object('outcome', case
            when not v_clr.counter_negated and v_clr.counter_succeeded then 'applied'
            else 'no-op'
          end)
        ));
        v_step_index := v_step_index + 1;
      else
        -- redirect: before/after target values imply outcome (6-arg form).
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

    -- Struck-through no-op step for each negated cast group (spec §8: negated
    -- steps stay visible, before -> after collapses to no-op).
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
  -- Phase 3: roll-input accounting (issue #306).
  -- ------------------------------------------------------------------
  for v_i in 1 .. coalesce(array_length(v_players, 1), 0) loop
    v_pid := v_players[v_i];
    v_running := null;

    for v_row in
      select casts.id as cast_id,
             casts.seq as seq,
             casts.caster_id as caster_id,
             casts.effect_kind as kind,
             sc.name as card_name,
             (rt.rt ->> 'order')::integer as ord,
             (pe.value ->> 'before')::numeric as p_before,
             (pe.value ->> 'after')::numeric as p_after
        from public.spell_casts casts
        join public.spell_deck_instances sdi on sdi.id = casts.card_instance_id
        join public.spell_cards sc on sc.id = sdi.card_id
        cross join lateral (select casts.cast_inputs -> 'roll_transform' as rt) rt
        cross join lateral jsonb_array_elements(rt.rt -> 'players') as pe(value)
       where casts.round_id = p_round_id
         and casts.negated = false
         and casts.effect_kind in ('advantage', 'disadvantage', 'forced_reroll', 'roll_flip', 'roll_swap')
         and casts.cast_inputs ? 'roll_transform'
         and pe.value ->> 'player_id' = v_pid
       order by (rt.rt ->> 'order')::integer, casts.seq
    loop
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

    if v_running is not null then
      v_rolls[v_i] := v_running::integer;
    end if;
  end loop;

  -- ------------------------------------------------------------------
  -- Phase 4a: gather modifier-bucket effects, normalise, bucket per
  -- target player in application order (spec section 6). A redirected
  -- effect (Phase 1) buckets against its effective post-redirect target.
  -- ------------------------------------------------------------------
  for v_row in
    select eff.target_player_id, eff.group_id, eff.effect_kind, eff.effect_params, eff.resolved_value, eff.cast_inputs,
           eff.cast_id, eff.active_effect_id, eff.card_name, eff.caster_player_id, eff.ord
      from (
        select casts.target_player_id,
               casts.card_instance_id as group_id,
               casts.effect_kind,
               casts.effect_params,
               casts.resolved_value,
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
               null::numeric as resolved_value,
               null::jsonb as cast_inputs,
               null::uuid as cast_id,
               sae.id as active_effect_id,
               sc.name as card_name,
               sae.caster_id as caster_player_id,
               null::bigint as ord,
               sae.created_at as ts
          from public.spell_active_effects sae
          join public.spell_cards sc on sc.id = sae.card_id
         where sae.room_id = v_room_id
           and sae.effect_kind in
             ('flat_modifier', 'dice_modifier', 'modifier_multiplier', 'set_modifier')
      ) eff
     order by eff.ord asc nulls first, eff.ts asc
  loop
    -- Effective target: a redirected cast group moves onto the redirector's
    -- caster (Phase 1).
    v_eff_target := coalesce(
      case when v_row.group_id is not null
        then v_redirect_map ->> v_row.group_id::text
      end,
      v_row.target_player_id
    );

    -- Only effects landing on an actual layer-0 roller shape the outcome.
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
      v_el := v_el || jsonb_build_object('flat',
        case
          when v_row.cast_inputs ? 'dice_roll'
            then (v_row.cast_inputs->>'dice_roll')::numeric
                 * coalesce((v_row.effect_params->>'sign')::numeric, 1)
          else coalesce(v_row.resolved_value, 0)
        end);
    elsif v_row.effect_kind = 'modifier_multiplier' then
      v_el := v_el || jsonb_build_object('mult', coalesce((v_row.effect_params->>'multiplier')::numeric, 1));
    elsif v_row.effect_kind = 'set_modifier' then
      v_el := v_el || jsonb_build_object('set', coalesce((v_row.effect_params->>'value')::numeric, 0));
    end if;

    v_effects_json := jsonb_set(
      v_effects_json,
      array[v_eff_target],
      (v_effects_json -> v_eff_target) || jsonb_build_array(v_el),
      true
    );
  end loop;

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
        jsonb_build_object('type', 'modifier', 'value', v_after)
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
    select casts.id as id, casts.caster_id as caster_id, sc.name as name
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
  -- Phase 5: brewer selection. Precedence declared > override > default.
  -- ------------------------------------------------------------------
  for v_declared in
    select sae.id, (sae.effect_params->>'number')::integer as number,
           sae.caster_id, sc.name as card_name
      from public.spell_active_effects sae
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
  'Authoritative layer-0 outcome resolver (issues #305/#306/#307, ADR 0005): Phase 1 recursively derives negate / redirect from the recorded reaction stack and rewrites the spell_casts.negated / redirected_to_cast_id caches; Phase 3 rebuilds every roller''s final roll from the eager shim''s recorded cast_inputs.roll_transform; Phases 4-5 own modifier composition and brewer selection. Emits the Resolution Trace into rounds.resolution_trace and returns { outcome, brewer_id, brewer_source, tied_player_ids, cups_made, no_modifier_gain, trace }. Pure and idempotent over its inputs. Layer > 0 bypasses all spell logic (issue #219).';
