-- resolve_round becomes the authoritative outcome resolver for a round's
-- layer 0 (issue #305, second implementation slice of the effect-application
-- rebuild #302 / ADR 0005). It takes over pipeline phases 4-5 -- modifier
-- composition and brewer selection -- and emits a structured Resolution
-- Trace, replacing the TS-side fan-out in
-- src/app/rounds/layerResolution.ts:applyLayerOutcome (getRoundModifierEffects
-- + composeModifier + getTeaMakerOverride + resolveDeclaredNumberTeaMaker +
-- resolveLayer) with one SQL call.
--
-- Scope of THIS slice (a deliberately delegating one -- branching strategy
-- in #303):
--   * Owns: composeModifier semantics ((persistent x product of multipliers)
--     + sum of flats; set_modifier absolute for the round, two -> last by
--     seq), lowest_gains_highest_modifier as pure modifier math on the
--     COMPOSED modifiers, tea_maker_override (chosen / highest_roll /
--     highest_modifier, no_modifier_gain), declared_number_tea_maker, and
--     the default lowest-roll+composed-modifier pick with tie -> new layer.
--   * Still delegates: roll-input transforms (advantage / forced_reroll /
--     roll_flip / roll_swap stay eager in finalizeReactionWindow -- #306
--     folds them in) and negate / redirect / WILD / seize (the cast-log
--     resolution phase -- #307/#308 fold them in). This function honours the
--     `negated` flag those RPCs already write, exactly as
--     get_round_modifier_effects did.
--   * Does NOT persist the round outcome itself: the TS orchestration keeps
--     calling the legacy 4-arg resolve_round (banks the brewer's modifier
--     gain, ticks spell_active_effects) / advance_round_layer for a tie, byte
--     for byte as before. #312 collapses the two functions.
--
-- Overloads the existing resolve_round(uuid, text, integer, boolean) by
-- arity -- every direct caller of that (roll-and-resolve tests,
-- admin_backfill_round, admin_delete_round's revert accounting) is untouched.
--
-- Determinism invariant (ADR 0005): over a 'closed' round, resolve_round(uuid)
-- is a PURE function of (rolls, spell_casts + recorded inputs,
-- spell_active_effects projection). It mutates nothing except
-- rounds.resolution_trace (which it overwrites identically on every run), so
-- re-running it over the same closed round yields the same outcome and the
-- same Trace. In particular it does NOT consume the declared_number_tea_maker
-- one-shot -- it only reads it to decide precedence and emit the Trace step.
-- The orchestrator (applyLayerOutcome) burns that effect via
-- resolve_declared_number_tea_maker once, adjacent to the brewer persist.

-- ---------------------------------------------------------------------------
-- 1. rounds.resolution_trace -- the persisted Resolution Trace
-- ---------------------------------------------------------------------------

-- Nullable, no default: pre-existing resolved rounds have no Trace and that
-- is fine -- the Round Recap surface (#314) shows a Trace only when one
-- exists, and a zero-cast round legitimately has an empty one. resolve_round
-- overwrites it on every run, so it always agrees with a replay.
alter table public.rounds add column if not exists resolution_trace jsonb;

-- ---------------------------------------------------------------------------
-- 2. _rr_compose_modifier -- composeModifier() in SQL
-- ---------------------------------------------------------------------------

-- Mirrors src/lib/game/modifierBucket.ts:composeModifier exactly. p_effects
-- is a jsonb array of normalised effect entries in application order, each
-- one of:
--   { "ord": <bigint>, "set":  <numeric> }   -- set_modifier    (absolute)
--   { "ord": <bigint>, "mult": <numeric> }   -- modifier_multiplier
--   { "ord": <bigint>, "flat": <numeric> }   -- flat_modifier / dice_modifier
-- Any `set` present wins outright -- and two of them resolve to the LAST by
-- `ord` (spec section 6.4a; the retired TS path took the first, but only
-- ever with a single set in the catalog, so this is behaviour-identical for
-- every existing scenario). Otherwise: base x product(multipliers) +
-- sum(flats).
create or replace function public._rr_compose_modifier(p_base numeric, p_effects jsonb)
returns numeric
language plpgsql
immutable
as $$
declare
  v_el jsonb;
  v_set_value numeric := null;
  v_set_ord bigint := null;
  v_mult numeric := 1;
  v_flat numeric := 0;
begin
  for v_el in select value from jsonb_array_elements(coalesce(p_effects, '[]'::jsonb)) as t(value)
  loop
    if v_el ? 'set' then
      if v_set_ord is null or (v_el->>'ord')::bigint >= v_set_ord then
        v_set_value := (v_el->>'set')::numeric;
        v_set_ord := (v_el->>'ord')::bigint;
      end if;
    elsif v_el ? 'mult' then
      v_mult := v_mult * (v_el->>'mult')::numeric;
    elsif v_el ? 'flat' then
      v_flat := v_flat + (v_el->>'flat')::numeric;
    end if;
  end loop;

  if v_set_value is not null then
    return v_set_value;
  end if;
  return p_base * v_mult + v_flat;
end;
$$;

revoke execute on function public._rr_compose_modifier(numeric, jsonb) from public, anon;
grant execute on function public._rr_compose_modifier(numeric, jsonb) to authenticated;

-- ---------------------------------------------------------------------------
-- 3. _rr_trace_step -- one Resolution Trace step object
-- ---------------------------------------------------------------------------

-- The renderer (#314) owns wording; this emits fields only. `outcome` is
-- derived: a step whose before == after applied but changed nothing (spec
-- section 3 -- zero-impact steps are emitted, never filtered).
create or replace function public._rr_trace_step(
  p_index integer, p_display_kind text, p_source_cast jsonb,
  p_target_player text, p_before jsonb, p_after jsonb
)
returns jsonb
language sql
immutable
as $$
  select jsonb_build_object(
    'index', p_index,
    'display_kind', p_display_kind,
    'source_cast', p_source_cast,
    'target_player', p_target_player,
    'before', p_before,
    'after', p_after,
    'outcome', case when p_before = p_after then 'no-op' else 'applied' end
  );
$$;

revoke execute on function public._rr_trace_step(integer, text, jsonb, text, jsonb, jsonb) from public, anon;
grant execute on function public._rr_trace_step(integer, text, jsonb, text, jsonb, jsonb) to authenticated;

-- ---------------------------------------------------------------------------
-- 4. resolveLayer precedence, in SQL
-- ---------------------------------------------------------------------------

-- resolveLayer (src/lib/game/resolveLayer.ts) over parallel
-- (player, roll, modifier) arrays: any nat-1 forces the decision among just
-- the nat-1 rollers on lowest modifier; else if every roller hit 20, lowest
-- modifier among all; else nat-20 rollers are excluded and lowest
-- roll+modifier wins. Returns the winning player id (1 element) or the tied
-- roster (> 1), player-id-sorted for a stable result. `p_modifier` is the
-- COMPOSED modifier for layer 0 and the raw persistent snapshot for a
-- tie-break reroll layer -- the only difference between the two paths, so
-- they share this one implementation.
create or replace function public._rr_pick_lowest(
  p_players text[], p_rolls integer[], p_modifier numeric[]
)
returns text[]
language plpgsql
immutable
as $$
declare
  v_result text[];
  v_min numeric;
begin
  if exists (select 1 from unnest(p_rolls) x where x = 1) then
    select min(p_modifier[i]) into v_min
      from generate_subscripts(p_players, 1) i where p_rolls[i] = 1;
    select array_agg(p_players[i] order by p_players[i]) into v_result
      from generate_subscripts(p_players, 1) i
     where p_rolls[i] = 1 and p_modifier[i] = v_min;
    return v_result;
  end if;

  if not exists (select 1 from unnest(p_rolls) x where x <> 20) then
    select min(p_modifier[i]) into v_min from generate_subscripts(p_players, 1) i;
    select array_agg(p_players[i] order by p_players[i]) into v_result
      from generate_subscripts(p_players, 1) i where p_modifier[i] = v_min;
    return v_result;
  end if;

  select min(p_rolls[i] + p_modifier[i]) into v_min
    from generate_subscripts(p_players, 1) i where p_rolls[i] <> 20;
  select array_agg(p_players[i] order by p_players[i]) into v_result
    from generate_subscripts(p_players, 1) i
   where p_rolls[i] <> 20 and (p_rolls[i] + p_modifier[i]) = v_min;
  return v_result;
end;
$$;

revoke execute on function public._rr_pick_lowest(text[], integer[], numeric[]) from public, anon;
grant execute on function public._rr_pick_lowest(text[], integer[], numeric[]) to authenticated;

-- ---------------------------------------------------------------------------
-- 5. resolve_round(p_round_id uuid) -- the authoritative layer-0 resolver
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

  v_row record;
  v_el jsonb;
  v_pid text;
  v_i integer;
  v_local_idx integer;
  v_before numeric;
  v_after numeric;

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

  -- Same precondition guard the legacy 4-arg resolve_round already raises
  -- (0057) -- kept here for parity, since this security-definer function is
  -- grantable to any authenticated caller and should not trust its input.
  -- A 'resolved' round is deliberately rejected: this function is a pure
  -- read over the pre-resolution state, and the orchestrator has by then
  -- burned the declared_number one-shot, so a re-run would derive from
  -- different inputs. Post-resolution replay/audit is a later slice's job
  -- (spec sections 35-37).
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
  -- Resolve on each player's plain persistent modifier snapshot; no Trace.
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
  -- Phase 4a: gather modifier-bucket effects (same source set as
  -- get_round_modifier_effects, 0051, minus the participant gate and
  -- minus advantage/disadvantage), normalise, and bucket per target
  -- player in application order.
  --
  -- Ordering (spec section 6): within a phase, spell_casts.seq ascending.
  -- spell_active_effects rows carry no seq -- they were promoted in an
  -- earlier round, so they compose first, ordered among themselves by
  -- created_at.
  -- ------------------------------------------------------------------
  for v_row in
    select eff.target_player_id, eff.effect_kind, eff.effect_params, eff.resolved_value,
           eff.cast_id, eff.active_effect_id, eff.card_name, eff.caster_player_id, eff.ord
      from (
        select casts.target_player_id,
               casts.effect_kind,
               casts.effect_params,
               casts.resolved_value,
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
               sae.effect_kind,
               sae.effect_params,
               null::numeric as resolved_value,
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
    -- Only effects landing on an actual layer-0 roller shape the outcome.
    if not (v_row.target_player_id = any (v_players)) then
      continue;
    end if;

    v_el := jsonb_build_object(
      'ord', coalesce(v_row.ord, 0),
      'kind', v_row.effect_kind,
      'cast_id', v_row.cast_id,
      'active_effect_id', v_row.active_effect_id,
      'card_name', v_row.card_name,
      'caster_player_id', v_row.caster_player_id,
      'target_player', v_row.target_player_id
    );

    if v_row.effect_kind = 'flat_modifier' then
      v_el := v_el || jsonb_build_object('flat', coalesce((v_row.effect_params->>'delta')::numeric, 0));
    elsif v_row.effect_kind = 'dice_modifier' then
      v_el := v_el || jsonb_build_object('flat', coalesce(v_row.resolved_value, 0));
    elsif v_row.effect_kind = 'modifier_multiplier' then
      v_el := v_el || jsonb_build_object('mult', coalesce((v_row.effect_params->>'multiplier')::numeric, 1));
    elsif v_row.effect_kind = 'set_modifier' then
      v_el := v_el || jsonb_build_object('set', coalesce((v_row.effect_params->>'value')::numeric, 0));
    end if;

    v_effects_json := jsonb_set(
      v_effects_json,
      array[v_row.target_player_id],
      (v_effects_json -> v_row.target_player_id) || jsonb_build_array(v_el),
      true
    );
  end loop;

  -- Compose each player's final modifier, and emit one Trace step per
  -- effect with a running before/after over the prefix up to it (so the
  -- steps read as a ledger ending at the composed total).
  for v_i in 1 .. coalesce(array_length(v_players, 1), 0) loop
    v_pid := v_players[v_i];
    v_after := v_base[v_i];  -- compose over the empty prefix == the base

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
  -- Phase 4c: lowest_gains_highest_modifier (Broken Biscuit) -- pure
  -- modifier math on the COMPOSED modifiers (spec section 6.4c). Every
  -- tied-lowest roller (by raw roll) has their composed modifier SET to
  -- the highest roller's composed modifier ("lifted to equal").
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

  -- declared_number_tea_maker (Inscribed Saucer): first live declared
  -- number that matches a raw layer-0 roll wins. READ ONLY here -- the
  -- orchestrator burns the one-shot via resolve_declared_number_tea_maker
  -- once it commits the brewer, so re-running resolve_round(uuid) over the
  -- same inputs stays identical.
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

  -- tea_maker_override (Drip Tray / Topsy-Tea / Wild Brew Surge branch 6):
  -- latest un-negated override cast. A still-pending 'chosen' target is
  -- treated as absent (layer resolves normally, retried later).
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
        -- highest_modifier: the raw persistent snapshot, NOT the composed
        -- modifier this function just built. An override decides the brewer
        -- "regardless of totals" (card text) and bypasses the modifier
        -- bucket entirely, so "highest modifier" means the player's
        -- standing persistent modifier -- matching the retired TS path
        -- (sort by modifierSnapshot). player_id breaks an exact tie.
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

  -- Default: lowest raw roll + composed modifier, resolveLayer precedence.
  -- A tie spawns the next reroll layer.
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
  'Authoritative layer-0 outcome resolver (issue #305, ADR 0005): owns modifier composition and brewer selection, emits the Resolution Trace into rounds.resolution_trace, and returns { outcome, brewer_id, brewer_source, tied_player_ids, cups_made, no_modifier_gain, trace }. Pure over its inputs -- it does not flip the round to resolved and does not consume the declared_number one-shot; the caller persists via resolve_round(uuid, text, integer, boolean) / advance_round_layer and burns the one-shot via resolve_declared_number_tea_maker. Layer > 0 bypasses all spell logic (issue #219).';
