-- GENERATED FROM db/sql/functions/ -- DO NOT EDIT
--
-- Written by `npm run build:migrations` from the canonical resolver-function
-- sources under db/sql/functions/. To change any function below, edit its
-- db/sql/functions/<name>.sql and re-run the build. See db/sql/README.md.
--
-- Functions in this migration:
--   _layer_is_complete
--   _rr_select_tea_maker
--   advance_layer
--   finalize_layer

-- BEGIN db/sql/functions/_layer_is_complete.sql
-- _layer_is_complete(p_round_id uuid, p_layer integer) -> boolean
--
-- The Layer-completeness rules (ADR 0008, issue #414) with no caller-identity
-- gate: whether a round can advance does not depend on who asks. A Layer is
-- complete once every expected roller has rolled and, at Layer 0, neither hold
-- is in place:
--   * a Pending Spell Die (a dice_modifier cast with no rolled value yet,
--     issue #252);
--   * a Deferred Forced-Reroll Target (a pre-roll forced_reroll cast still
--     awaiting its target, issue #325);
--   * the Compelled Cast step (issue #440): a compelled Action cast still
--     owed to Brewmageddon. Nobody can roll then anyway (is_expected_layer_
--     roller), so this only makes the rule explicit here too;
--   * a Tea Party Revolt pick (issue #430): a Revolt cast whose target the
--     lowest roller hasn't named yet (_revolt_pick_outstanding). advance_layer
--     and finalize_layer report this hold as `revolt_pick_pending`.
-- The single Layer-completeness read: the identity-gated and stall-resolution
-- variants it replaced were dropped in issue #417.
--
-- Internal: called by advance_layer and finalize_layer, which run with
-- definer rights. Players can't call it; the service role can (tests).
--
-- Canonical source: this file is the source of truth for the function body.
-- Edit here and run `npm run build:migrations` -- do not hand-edit the
-- generated migration. See db/sql/README.md.

create or replace function public._layer_is_complete(p_round_id uuid, p_layer integer)
returns boolean
language plpgsql
stable
security definer
set search_path = public
as $$
begin
  if (select count(*) from public.rolls where round_id = p_round_id and layer = p_layer)
     < public.count_expected_layer_rollers(p_round_id, p_layer) then
    return false;
  end if;

  if p_layer = 0 and exists (
    select 1 from public.spell_casts
     where round_id = p_round_id and effect_kind = 'dice_modifier'
       and not coalesce(cast_inputs ? 'dice_roll', false)
  ) then
    return false;
  end if;

  if p_layer = 0 and exists (
    select 1 from public.spell_casts
     where round_id = p_round_id
       and effect_kind = 'forced_reroll'
       and target_pending = true
       and negated = false
       and reaction_window_id is null
  ) then
    return false;
  end if;

  if p_layer = 0 and public._compelled_cast_step_open(p_round_id) then
    return false;
  end if;

  if p_layer = 0 and public._revolt_pick_outstanding(p_round_id) then
    return false;
  end if;

  return true;
end;
$$;

revoke execute on function public._layer_is_complete(uuid, integer) from public, anon, authenticated;
-- The integration suites read completeness directly with the service role.
grant execute on function public._layer_is_complete(uuid, integer) to service_role;

comment on function public._layer_is_complete(uuid, integer) is
  'Issue #414 (ADR 0008): Layer completeness with no caller-identity gate -- every expected roller has rolled and, at Layer 0, no Pending Spell Die is outstanding, no Deferred Forced-Reroll Target hold is in place, and no compelled Action cast is still owed (issue #440), and no Tea Party Revolt pick is outstanding (issue #430). Internal to round advancement.';
-- END db/sql/functions/_layer_is_complete.sql

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
--   { outcome          'brewer' | 'tie'
--     brewer_id        the Tea Maker (null on a tie)
--     brewer_source    'declared_number' | 'tea_maker_override:<mode>' |
--                      'default' (null on a tie)
--     modifier_gain    the ladder's gain (null = cups_made, 0 = none, else as
--                      given; null on a tie). The Eternal Steep ward is
--                      applied by the caller -- the ward phase is orthogonal
--                      to the ladder.
--     tied_player_ids  the Tie-Break Reroll pool (null for a brewer)
--     steps            the Resolution Trace steps it emitted, in order }
-- The outcome is a tag so a later outcome (the Loose Leaf `rolloff`, #431)
-- or a pre-ladder rule (the Brew Debt round, #432) is one more branch ahead
-- of the single return, not another exit.
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

  -- tier 0: { player_id: { ae_id, caster_id, card_name, override_proof } }
  v_immune jsonb;
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
  -- is preferred.
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
               'override_proof', coalesce((sae.effect_params ->> 'override_proof')::boolean, false)
             ) as info
        from public._rr_active_effects_as_of(v_room_id, p_round_id) sae
        join public.spell_cards sc on sc.id = sae.card_id
       where sae.effect_kind = 'brewer_immunity'
       order by sae.target_player_id,
                coalesce((sae.effect_params ->> 'override_proof')::boolean, false) desc,
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
         and not public._rr_is_brewer_candidate(v_immune, v_target) then
        -- issue #428: an immune override target falls through to the default
        -- pick, whatever the mode. (Override-proof immunity -- The Last
        -- Cuppa -- always does; the Earl slice gives a non-override-proof
        -- `earl` holder a title transfer here instead.)
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

  return jsonb_build_object(
    'outcome', v_outcome,
    'brewer_id', v_brewer_id,
    'brewer_source', v_brewer_source,
    'modifier_gain', v_modifier_gain,
    'tied_player_ids', to_jsonb(v_tied),
    'steps', v_steps
  );
end;
$$;

revoke execute on function public._rr_select_tea_maker(uuid, jsonb, jsonb, jsonb, integer) from public, anon, authenticated;

comment on function public._rr_select_tea_maker(uuid, jsonb, jsonb, jsonb, integer) is
  'Issue #451 (ADR 0005 #425 amendment): Phase 5 of the Resolver pipeline -- tea-maker selection by the Tea-Maker Precedence Ladder (tier 0 Brewer Immunity via _rr_is_brewer_candidate, tier 1 declared number, tier 2 tea_maker_override last-cast-wins, tier 4 default lowest roller). Takes the layer-0 Resolution Summary, Phase 1 redirects, the targeting_skip map and the Trace step cursor; returns { outcome brewer|tie, brewer_id, brewer_source, modifier_gain, tied_player_ids, steps }. Read-only. Called by _rr_resolve_eval only. Internal.';
-- END db/sql/functions/_rr_select_tea_maker.sql

-- BEGIN db/sql/functions/advance_layer.sql
-- advance_layer(p_round_id uuid) -> jsonb
--
-- Layer completion (ADR 0008, issue #415): what happens once the current
-- Layer's rolls are all in. Takes the round row lock first -- the same lock
-- finalize_layer and resolve_round take, so the nested calls below reuse it --
-- then does nothing unless the round is `closed` and its current Layer is
-- complete (_layer_is_complete: every expected roller has rolled, and at
-- Layer 0 no Pending Spell Die, Deferred Forced-Reroll Target or Tea Party
-- Revolt pick hold -- the last reported as `revolt_pick_pending`). Then:
--   * Layer 0 with no reaction window yet: opens it (open_reaction_window,
--     which attaches the pre-roll forced_reroll and chosen-pair casts),
--     first forfeiting any compelled Reaction card with no legal target
--     (issue #440: a Reaction card's target is checked when the window
--     opens). If
--     nobody is eligible to react the window closes on the spot and Layer
--     finalization (finalize_layer) runs in this same call.
--   * Layer 0 with a window: an open window is a noop -- the window finishes
--     normally, so a Pending Spell Die resolved mid-window only unblocks
--     finalization -- and a closed one performs Layer finalization.
--   * A Tie-Break Reroll Layer (> 0): performs Layer finalization. No window
--     is ever opened above Layer 0.
--
-- Never opens a second window, and never raises for who the caller is or for
-- losing a race: a second caller blocks on the lock, then finds the window
-- already there (or the round moved on) and returns noop.
--
-- The call that first finds the Layer complete -- the one that opens Layer
-- 0's window, or that finalizes a Tie-Break Reroll Layer -- also returns the
-- Layer's raw (pre-transform) rolls as `layer_rolls`, for the "layer rolls
-- revealed" broadcast. Called by the round-advancement module
-- (src/app/rounds/advanceRound.ts).
--
-- Canonical source: this file is the source of truth for the function body.
-- Edit here and run `npm run build:migrations` -- do not hand-edit the
-- generated migration. See db/sql/README.md.

create or replace function public.advance_layer(p_round_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_status text;
  v_layer integer;
  v_window_closed boolean;
  v_layer_rolls jsonb;
  v_finalization jsonb;
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

  if not public._layer_is_complete(p_round_id, v_layer) then
    -- issue #430: `revolt_pick_pending` when rolled but waiting on a Tea
    -- Party Revolt pick.
    return jsonb_build_object('outcome', 'noop', 'reason', public._layer_hold_reason(p_round_id, v_layer));
  end if;

  if v_layer = 0 and exists (
    select 1 from public.spell_reaction_windows
     where round_id = p_round_id and layer = 0
  ) then
    if exists (
      select 1 from public.spell_reaction_windows
       where round_id = p_round_id and layer = 0 and status = 'open'
    ) then
      return jsonb_build_object('outcome', 'noop', 'reason', 'window_open');
    end if;

    -- A closed window: the rolls were revealed when it opened.
    return public.finalize_layer(p_round_id);
  end if;

  -- First to find this Layer complete: capture its raw rolls for the reveal
  -- before any roll transform rewrites them.
  v_layer_rolls := jsonb_build_object(
    'layer', v_layer,
    'rolls', public._layer_rolls_json(p_round_id, v_layer));

  if v_layer > 0 then
    return public.finalize_layer(p_round_id)
      || jsonb_build_object('layer_rolls', v_layer_rolls);
  end if;

  perform public._forfeit_untargetable_compelled_reactions(p_round_id);

  select o.is_closed into v_window_closed
    from public.open_reaction_window(p_round_id, 0) o;

  if v_window_closed then
    v_finalization := public.finalize_layer(p_round_id);
  end if;

  return jsonb_build_object(
    'outcome', 'windowOpened',
    'layer', 0,
    'window_closed', v_window_closed,
    'finalization', v_finalization,
    'layer_rolls', v_layer_rolls);
end;
$$;

revoke execute on function public.advance_layer(uuid) from public, anon;
grant execute on function public.advance_layer(uuid) to authenticated;

comment on function public.advance_layer(uuid) is
  'Layer completion (ADR 0008, issue #415). Locks the round, then returns { outcome: "noop", reason } unless the round is closed and its current Layer is complete -- reasons: round_not_found, round_not_closed, layer_incomplete, revolt_pick_pending (rolled, but a Tea Party Revolt pick is outstanding; issue #430), window_open. At Layer 0 with no reaction window it opens one and returns { outcome: "windowOpened", layer: 0, window_closed, finalization, layer_rolls }, where finalization is finalize_layer''s outcome when nobody was eligible to react (the window closed on the spot) and null otherwise. At Layer 0 with a closed window, or at a Tie-Break Reroll Layer, it returns finalize_layer''s outcome ({ outcome: "brewer", ... } or { outcome: "tie", ... }). layer_rolls -- { layer, rolls: [{ player_id, value, discarded_value, entered_by_admin }] }, the raw pre-transform rolls -- is present only on the call that first finds the Layer complete. Never opens a second window; never raises for caller identity or a lost race.';
-- END db/sql/functions/advance_layer.sql

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
--      issue #438) and record any pending Round Replay; tie: advance to the
--      next Layer with the tied players.
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
  if v_out ->> 'outcome' = 'tie' then
    select array_agg(t) into v_tied
      from jsonb_array_elements_text(v_out -> 'tied_player_ids') t;

    v_next_layer := public.advance_round_layer(p_round_id, v_tied);

    return jsonb_build_object(
      'outcome', 'tie',
      'layer', v_next_layer,
      'tied_player_ids', to_jsonb(v_tied));
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
  'Layer finalization (ADR 0008, issue #414). Locks the round, then returns { outcome: "noop", reason } unless the round is closed, its current Layer is complete, and (at Layer 0) its reaction window exists and is closed -- reasons: round_not_found, round_not_closed, no_window, window_open, layer_incomplete, revolt_pick_pending (rolled, but a Tea Party Revolt pick is outstanding; issue #430). Otherwise, in one transaction: runs the eager roll-input shim (forced rerolls, flip, swap, chosen-pair; ADR 0005), calls resolve_round(uuid) unchanged, and commits the outcome. Returns { outcome: "brewer", layer, brewer_id, cups_made, rolls: [{ player_id, value, discarded_value, entered_by_admin }], replay_pending } after writing the resolution (its modifier gain included, issue #425), moving any Tea Heist card (issue #438) and recording any pending Round Replay; or { outcome: "tie", layer, tied_player_ids } after advancing to the next Layer (layer is the new one). Never raises for caller identity or a lost race.';
-- END db/sql/functions/finalize_layer.sql

