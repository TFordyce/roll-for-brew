-- Counterspell-unwind + Saving Steep natural-1 backfire (issue #308, fifth
-- implementation slice of the effect-application rebuild #302 / ADR 0005 §8).
--
-- Migration number: master's highest is 0077 (0077_cast_log_schema_expand);
-- the rebuild branch adds 0078 (resolve_round authoritative, #305), 0079
-- (eager shim, #306), 0080 (cast-log resolution phase, #307). This is 0081.
-- Re-check at the integrate step (branching strategy in #303) and renumber
-- to sit after master's current highest.
--
-- What changes
-- ------------
-- 1. Saving Steep enters the game. It gets a `contested_negate` effect row
--    with `effect_params.dc = 10` (0080 already taught cast_reaction_spell_card
--    and _rr_cast_log_resolution to honour an `effect_params.dc` override),
--    and its deck instance is flipped back out of `benched` (#284) into the
--    draw pool.
--
-- 2. `contested_negate` gains a THIRD branch on the recorded d20. 0080
--    handled two: `dc_d20 >= dc` negates the whole target cast group;
--    anything else is a contest lost (the countered cast composes as normal,
--    the counter is a no-op). This slice adds the natural-1 BACKFIRE:
--      * `cast_reaction_spell_card` -- on `dc_d20 = 1` for a card that
--        carries the backfire behaviour (only Saving Steep, detected by its
--        `effect_params.dc` being present is NOT the signal; the signal is
--        that we record a `cast_inputs.backfire` object here). It draws every
--        extra server-RNG the re-application needs and records it:
--          cast_inputs.backfire = {
--            "transforms": [ { "kind": <eager kind>, "order": <1..4>,
--                              "extra_dice": [<d20>, ...] }, ... ],
--            "dice_rolls": { "<victim dice_modifier cast id>": <raw total>, ... }
--          }
--        Nothing is mutated in place -- the resolver adopts these, same
--        hybrid-eager model as #306.
--      * `resolve_round` Phase 1 -- a backfired counter does NOT negate its
--        victim (the countered cast still resolves on its own target(s)), and
--        its Trace outcome is the new `backfired` (not `no-op`). The
--        contested_negate Trace step now also carries `dc_d20` / `dc` as
--        structured fields so the renderer can say "rolled a 4 vs DC 10" on
--        a contest lost (spec §8 Trace).
--      * `resolve_round` Phase 3 -- for the reactor, after their own recorded
--        roll transforms, re-apply each backfired counter's
--        `backfire.transforms` onto their running roll (double disadvantage
--        => 3 dice, take the lowest; forced_reroll => the recorded extra
--        d20; roll_flip => 21 - v; roll_swap on a lone target self-cancels).
--        One nested Trace step per transform, `{ "backfire": true }`,
--        source_cast = the Saving Steep cast.
--      * `resolve_round` Phase 4a -- for each backfired counter, re-bucket
--        every lazy modifier row of the victim group onto the reactor, same
--        params, same sign, dice drawn from `backfire.dice_rolls`. One nested
--        `{ "backfire": true }` Trace step per row.
--
-- 3. `redirect` (Mug Mirror) is scoped to the reactor's OWN exposure. 0080
--    keyed the redirect map on the victim CAST GROUP, so a redirect against
--    one row of a multi-target (TABLE / ALL_OTHER_PLAYERS) cast wrongly moved
--    every target's row onto the original caster. The map is now keyed on the
--    specific targeted `spell_casts.id` (`_rr_cast_log_resolution` returns it
--    as `victim_cast_id`); every other target of the countered cast still
--    takes their hit. #287 (Mug Mirror: redirect doesn't unwind an
--    already-applied effect) closes against this -- there is no in-place
--    apply to unwind; re-resolution simply buckets the one row elsewhere.
--
-- Determinism invariant is preserved: resolve_round mutates only
-- rounds.resolution_trace and the negated / redirected_to_cast_id caches, and
-- reproduces the same outcome + Trace on every run. All backfire RNG is drawn
-- once, at cast time, into cast_inputs.

-- ===========================================================================
-- 1. _rr_cast_log_resolution -- add victim_cast_id, dc fields, backfire flag;
--    redirect is now reported per targeted row, not per cast group
-- ===========================================================================

drop function if exists public._rr_cast_log_resolution(uuid);
create function public._rr_cast_log_resolution(p_round_id uuid)
returns table (
  counter_cast_id uuid,
  counter_kind text,
  counter_seq bigint,
  counter_negated boolean,
  counter_succeeded boolean,
  counter_backfired boolean,
  counter_dc_d20 integer,
  counter_dc integer,
  counter_caster text,
  victim_group uuid,
  victim_cast_id uuid,
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
  -- the cast it targets (parent_cast_id), that cast's group
  -- (card_instance_id) and original target, and whether its contest passed.
  -- Ordered by seq so the fixpoint below walks the stack deterministically.
  select coalesce(jsonb_agg(entry order by (entry->>'seq')::bigint), '[]'::jsonb)
    into v_counters
    from (
      select jsonb_build_object(
               'counter_cast_id', c.id,
               'kind', c.effect_kind,
               'seq', c.seq,
               'caster_id', c.caster_id,
               'target_group', tgt.card_instance_id,
               'target_cast_id', c.parent_cast_id,
               'own_group', c.card_instance_id,
               'victim_orig_target', tgt.target_player_id,
               'victim_caster', tgt.caster_id,
               'dc_d20', (c.cast_inputs->>'dc_d20')::int,
               'dc', case
                 when c.effect_kind = 'redirect' then null
                 else coalesce(
                   (c.cast_inputs->>'dc')::int,
                   public._rr_tier_default_dc(tcard.tier))
               end,
               'has_backfire', coalesce(c.cast_inputs ? 'backfire', false),
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
  -- targets ITS OWN cast group, succeeded, and is not itself negated. Bounded
  -- at 2*n + 2 passes as a safety net; converges because every counter
  -- targets a strictly-lower seq.
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
    -- Backfire: a Saving Steep-style counter (it recorded a cast_inputs.backfire
    -- payload at cast time -- only a natural 1 does) that is not itself
    -- negated. A backfired counter never negates its victim.
    counter_backfired := (v_c->>'has_backfire')::boolean
                         and not (v_c->>'is_negated')::boolean;
    counter_dc_d20    := (v_c->>'dc_d20')::int;
    counter_dc        := (v_c->>'dc')::int;
    counter_caster    := v_c->>'caster_id';
    victim_group      := (v_c->>'target_group')::uuid;
    victim_cast_id    := (v_c->>'target_cast_id')::uuid;
    victim_orig_target := v_c->>'victim_orig_target';
    victim_caster     := v_c->>'victim_caster';
    -- A live (non-negated) redirect reflects the reactor's own exposure --
    -- the single targeted row -- back onto the countered cast's ORIGINAL
    -- caster (spec §8: "onto the original caster"; classic Mug Mirror).
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
  'Issue #307/#308: recursive, memoised negate / redirect / backfire derivation over a round''s reaction stack, purely from recorded cast_inputs. One row per contested_negate / redirect cast: whether it is itself negated (counter-of-counter to any depth), whether its contest succeeded, whether it BACKFIRED (natural 1 on a Saving Steep-style counter), the recorded dc_d20 / effective dc, the specific targeted spell_casts.id and its group, and (for redirect) the player its effect moves onto. resolve_round Phase 1 consumes this.';

-- ===========================================================================
-- 2. _rr_record_backfire -- draw + record the backfire RNG at cast time
-- ===========================================================================
-- Called from cast_reaction_spell_card the instant a contested_negate rolls a
-- natural 1. Walks the victim cast group's effect rows and records, into the
-- counter's own cast_inputs.backfire, every server-RNG draw the resolver will
-- need to re-apply each row onto the reactor. Draws nothing that the resolver
-- can re-derive (flat / multiplier / set deltas, roll_flip's 21 - v).

create or replace function public._rr_record_backfire(
  p_counter_cast_id uuid, p_victim_group uuid
)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_row record;
  v_transforms jsonb := '[]'::jsonb;
  v_dice_rolls jsonb := '{}'::jsonb;
  v_extra jsonb;
  v_order integer;
  v_dice_count integer;
  v_dice_sides integer;
  v_total integer;
  i integer;
begin
  -- Eager (roll-input) kinds: one transform entry per DISTINCT kind in the
  -- victim group, with any extra d20 draws the re-application consumes.
  for v_row in
    select distinct effect_kind
      from public.spell_casts
     where card_instance_id = p_victim_group
       and effect_kind in ('advantage', 'disadvantage', 'forced_reroll', 'roll_flip', 'roll_swap')
  loop
    v_extra := '[]'::jsonb;
    if v_row.effect_kind in ('advantage', 'disadvantage') then
      v_order := 1;
      v_extra := jsonb_build_array(
        floor(random() * 20 + 1)::integer,
        floor(random() * 20 + 1)::integer
      );
    elsif v_row.effect_kind = 'forced_reroll' then
      v_order := 2;
      v_extra := jsonb_build_array(floor(random() * 20 + 1)::integer);
    elsif v_row.effect_kind = 'roll_flip' then
      v_order := 3;
    else
      v_order := 4;   -- roll_swap: no counterpart on a lone target
    end if;

    v_transforms := v_transforms || jsonb_build_array(jsonb_build_object(
      'kind', v_row.effect_kind,
      'order', v_order,
      'extra_dice', v_extra
    ));
  end loop;

  -- Lazy dice_modifier rows: draw each one's own die now, keyed by row id.
  for v_row in
    select id, effect_params
      from public.spell_casts
     where card_instance_id = p_victim_group
       and effect_kind = 'dice_modifier'
  loop
    v_dice_count := (regexp_match(v_row.effect_params ->> 'dice', '^(\d+)d(\d+)$'))[1]::integer;
    v_dice_sides := (regexp_match(v_row.effect_params ->> 'dice', '^(\d+)d(\d+)$'))[2]::integer;
    if v_dice_count is null or v_dice_sides is null then
      continue;
    end if;
    v_total := 0;
    for i in 1 .. v_dice_count loop
      v_total := v_total + floor(random() * v_dice_sides + 1)::integer;
    end loop;
    v_dice_rolls := jsonb_set(v_dice_rolls, array[v_row.id::text], to_jsonb(v_total), true);
  end loop;

  update public.spell_casts
     set cast_inputs = coalesce(cast_inputs, '{}'::jsonb) || jsonb_build_object(
           'backfire', jsonb_build_object(
             'transforms', v_transforms,
             'dice_rolls', v_dice_rolls
           ))
   where id = p_counter_cast_id;
end;
$$;

revoke execute on function public._rr_record_backfire(uuid, uuid) from public, anon;
grant execute on function public._rr_record_backfire(uuid, uuid) to authenticated;

comment on function public._rr_record_backfire(uuid, uuid) is
  'Issue #308: at contested_negate natural-1 time, records into the counter''s cast_inputs.backfire every server-RNG draw resolve_round needs to re-apply each of the victim cast group''s effect rows onto the reactor (double disadvantage''s extra dice, a forced_reroll''s extra d20, each dice_modifier''s own die). Draws nothing re-derivable.';

-- ===========================================================================
-- 3. cast_reaction_spell_card -- record the backfire payload on a natural 1
-- ===========================================================================
-- The 0080 definition, with one added call in the contested_negate tail.

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

      -- Natural 1: this counter BACKFIRES (spec �8). It does not negate the
      -- victim; instead resolve_round re-applies every effect row of the
      -- victim group once more onto the reactor. Draw + record every extra
      -- server-RNG that re-application needs, now, into cast_inputs.backfire.
      if v_roll = 1 and v_target_group is not null then
        perform public._rr_record_backfire(v_row_cast_id, v_target_group);
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
-- 4. resolve_round(uuid) -- backfired outcome (Phase 1), backfire eager
--    re-application (Phase 3), backfire lazy re-application (Phase 4a),
--    per-row redirect scoping (Phase 4a). Otherwise byte-for-byte 0080.
-- ===========================================================================

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
  v_bf record;      -- issue #308: a backfired counter + one of its re-applied rows
  v_t jsonb;        -- issue #308: one backfire.transforms entry

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
      -- issue #308: scope the redirect to the reactor's OWN targeted row
      -- (victim_cast_id), not the whole victim group -- a redirect against
      -- one row of a TABLE / ALL_OTHER_PLAYERS cast leaves every other
      -- target's row untouched.
      if v_clr.redirect_to is not null then
        v_redirect_map := jsonb_set(
          v_redirect_map,
          array[v_clr.victim_cast_id::text],
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
         where id = v_clr.victim_cast_id;
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
              when v_clr.counter_backfired then 'backfired'
              when v_clr.counter_succeeded then 'negated target'
              else 'no effect'
            end),
          -- dc_d20 / dc travel with every contested_negate step so the
          -- renderer can say "rolled a 4 vs DC 10" on a contest lost (�8).
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
             casts.negated as is_negated,
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
         and casts.effect_kind in ('advantage', 'disadvantage', 'forced_reroll', 'roll_flip', 'roll_swap')
         and casts.cast_inputs ? 'roll_transform'
         and pe.value ->> 'player_id' = v_pid
       order by (rt.rt ->> 'order')::integer, casts.seq
    loop
      -- issue #308: a NEGATED roll transform is logically unwound -- the
      -- resolver adopts its recorded `before` and never consumes the extra
      -- physical die (spec §8). The eager mutation to rolls.value stays as a
      -- cache the resolver ignores. (A negate of one link in a multi-transform
      -- chain re-threads only approximately -- no live card combo produces
      -- that, and Phase 1 already emits the struck-through group step.)
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
    -- Double disadvantage => 3 dice, take the lowest; forced_reroll => the
    -- recorded extra d20; roll_flip => 21 - v; roll_swap self-cancels on a
    -- lone target. One nested Trace step each, under the Saving Steep cast.
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
    -- issue #308: redirect is keyed on the specific targeted cast row
    -- (victim_cast_id), so only the reactor's own exposure moves.
    v_eff_target := coalesce(
      case when v_row.cast_id is not null
        then v_redirect_map ->> v_row.cast_id::text
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

  -- issue #308: backfire re-buckets every lazy modifier row of a backfired
  -- counter's victim group onto the reactor, same params, same sign, with
  -- dice_modifier deltas drawn from the recorded backfire.dice_rolls. Ordered
  -- last (counter seq) so it lands after the victim's own effect, which still
  -- resolves normally on its own target.
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
  'Authoritative layer-0 outcome resolver (issues #305/#306/#307/#308, ADR 0005): Phase 1 recursively derives negate / redirect / natural-1 backfire from the recorded reaction stack and rewrites the spell_casts.negated / redirected_to_cast_id caches; Phase 3 rebuilds every roller''s final roll from the eager shim''s recorded cast_inputs.roll_transform (unwinding a negated transform to its recorded before, re-applying a backfired counter''s transforms onto the reactor); Phases 4-5 own modifier composition and brewer selection (a redirect moves only the reactor''s own row; a backfire re-buckets the victim group''s lazy rows onto the reactor). Emits the Resolution Trace into rounds.resolution_trace and returns { outcome, brewer_id, brewer_source, tied_player_ids, cups_made, no_modifier_gain, trace }. Pure and idempotent over its inputs. Layer > 0 bypasses all spell logic (issue #219).';

-- ===========================================================================
-- 5. Saving Steep enters play
-- ===========================================================================
-- Card text: "Roll a d20. On 10+, the card has no effect. On a nat 1, the
-- effect is doubled against you." That is a contested_negate with a fixed
-- DC of 10 (0080 honours effect_params.dc) plus the natural-1 backfire above.
-- It is a common-tier CARD-stamped Reaction, exactly like Tannin Tantrum, so
-- target_role = 'TARGET' (cast_reaction_spell_card resolves CARD -> null
-- final target and reads p_target_cast_id).

insert into public.spell_card_effects (card_id, target_role, effect_kind, effect_params, ordinal)
select sc.id, 'TARGET', 'contested_negate', '{"dc": 10}'::jsonb, 0
  from public.spell_cards sc
 where sc.name = 'Saving Steep'
   and not exists (
     select 1 from public.spell_card_effects e where e.card_id = sc.id
   );

-- The bench migration (#284) parked Saving Steep's deck instance at
-- location = 'benched'. Now that it resolves, flip it back into the draw
-- pool. Guarded on location so this is a no-op if #284 has not run, and it
-- never disturbs an instance a player is currently holding.
update public.spell_deck_instances sdi
   set location = 'in_deck', held_by_player = null
  from public.spell_cards sc
 where sc.id = sdi.card_id
   and sc.name = 'Saving Steep'
   and sdi.location = 'benched';
