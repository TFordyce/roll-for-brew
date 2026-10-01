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
