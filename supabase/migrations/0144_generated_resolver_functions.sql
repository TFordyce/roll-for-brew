-- GENERATED FROM db/sql/functions/ -- DO NOT EDIT
--
-- Written by `npm run build:migrations` from the canonical resolver-function
-- sources under db/sql/functions/. To change any function below, edit its
-- db/sql/functions/<name>.sql and re-run the build. See db/sql/README.md.
--
-- Functions in this migration:
--   _apply_crit_redirect
--   _rr_active_effects_as_of
--   _rr_draw_redirect_trace
--   _rr_resolve_eval
--   _rr_scrap_round
--   record_active_effect_if_persistent

-- BEGIN db/sql/functions/_apply_crit_redirect.sql
-- _apply_crit_redirect(uuid, text) -> text
--
-- Issue #435 (spec #401 F6, #383 Q5): the shared crit-redirect hook. Given
-- that p_player_id just rolled a nat 1 / nat 20 in p_round_id, returns the
-- player the crit's spell draw goes to. NULL means the draw fizzles.
--
-- Called from all three crit entry points, before the draw is recorded for
-- anyone:
--   * record_pending_spell_draw (the client's pending-draw record);
--   * admin_proxy_roll (its direct pending_spell_draws insert);
--   * draw_spell_card_as when given a round (the Test-room puppet path, which
--     draws immediately and has no pending row).
-- Returning the recipient rather than rewriting a pending row keeps the
-- puppet path on the same hook.
--
-- Issue #436 (Marked for Brew): the oldest live `next_crit` draw_redirect
-- mark on the roller fires -- oldest first by created_at, then id. "Live" is
-- _rr_active_effects_as_of as of this round (not countered, not spent,
-- inside the target's 5 participated rounds after the cast); a mark never
-- fires in its own cast round. Firing spends it for good: the source cast
-- records cast_inputs.consumed_by_round = this round, and
-- draw_redirect_outcome:
--   * `redirected` -- the draw goes to the beneficiary (the mark's caster);
--   * `fizzled`    -- the beneficiary already has a pending draw this round
--                     (pending_spell_draws is keyed by round + player), so
--                     the redirect fizzles and the roller keeps their own
--                     draw. Checked here, not left to the callers' `on
--                     conflict do nothing`, so a spent mark never silently
--                     drops a draw. The puppet path draws without a pending
--                     row, so there it can only collide with a pending row
--                     from an in-app or proxied crit; the Test room is
--                     admin-only, so that is accepted.
-- Only the first mark fires per crit; any others wait for the next one. A
-- second crit in the same round (a tie-break layer) finds the fired mark
-- spent and draws for the roller.
--
-- Internal: no grant; only reached from the SECURITY DEFINER entry points.
--
-- Canonical source: this file is the source of truth for the function body.
-- Edit here and run `npm run build:migrations` -- do not hand-edit the
-- generated migration. See db/sql/README.md.

create or replace function public._apply_crit_redirect(p_round_id uuid, p_player_id text)
returns text
language plpgsql
set search_path = public
as $$
declare
  v_room_id uuid;
  v_started_at timestamptz;
  v_mark record;
  v_outcome text;
begin
  select room_id, started_at into v_room_id, v_started_at
    from public.rounds
   where id = p_round_id;

  select sae.caster_id as beneficiary_id, sae.source_cast_id
    into v_mark
    from public._rr_active_effects_as_of(v_room_id, p_round_id) sae
    join public.spell_casts src on src.id = sae.source_cast_id
    join public.rounds src_round on src_round.id = src.round_id
   where sae.target_player_id = p_player_id
     and sae.effect_kind = 'draw_redirect'
     and sae.effect_params ->> 'trigger' = 'next_crit'
     and src_round.started_at < v_started_at
   order by sae.created_at, sae.id
   limit 1;

  if not found then
    return p_player_id;
  end if;

  v_outcome := case
    when exists (
      select 1 from public.pending_spell_draws
       where round_id = p_round_id and player_id = v_mark.beneficiary_id
    ) then 'fizzled'
    else 'redirected'
  end;

  update public.spell_casts
     set cast_inputs = coalesce(cast_inputs, '{}'::jsonb)
                       || jsonb_build_object(
                            'consumed_by_round', p_round_id,
                            'draw_redirect_outcome', v_outcome
                          )
   where id = v_mark.source_cast_id;

  return case when v_outcome = 'redirected' then v_mark.beneficiary_id else p_player_id end;
end;
$$;

revoke execute on function public._apply_crit_redirect(uuid, text) from public, anon, authenticated;
-- END db/sql/functions/_apply_crit_redirect.sql

-- BEGIN db/sql/functions/_rr_active_effects_as_of.sql
-- _rr_active_effects_as_of(uuid, uuid) -> setof spell_active_effects
--
-- The projection row source (issue #310, migration 0084): the
-- spell_active_effects rows LIVE as of p_as_of_round_id. Drop-in for
-- `from public.spell_active_effects sae` in any reader that has a room id and
-- a round id in scope.
--
-- A row is live as of the given round iff ALL of:
--   * its source cast is not negated;
--   * its duration is not exhausted: rounds_remaining IS NULL (unbounded), OR
--     the number of resolved rounds in [source-cast's round .started_at,
--     as-of round .started_at) is < rounds_remaining
--     (_rr_effect_rounds_elapsed);
--   * it has not been dispelled at or before the as-of round: no non-negated
--     'dispel' cast whose effect_params.ended_effect_id names this row sits
--     in a round started on/before the as-of round;
--   * it has not been spent (issue #435, spec #401 F6): its source cast
--     records neither cast_inputs.consumed_by_round nor
--     cast_inputs.consumed_by_draw. A one-shot effect (a Draw Redirect mark)
--     writes one of these when it fires. Unlike a dispel this is not bounded
--     by the as-of round -- a fired mark is spent for good, even to an as-of
--     read of an earlier round, and a Round replay scrap does not restore it
--     (#383 Q2), because the card it moved survives the scrap.
--
--   * its participated-rounds window is open (issue #436, Marked for Brew):
--     a row whose effect_params carries participated_rounds_after_cast = n
--     is live while its target has taken part in fewer than n resolved
--     rounds strictly after the source cast's round and before the as-of
--     round (_rr_participated_rounds_elapsed, counted from the room's next
--     round after the cast round). Live in the cast round itself, so the
--     roster badge shows the mark at once; _apply_crit_redirect separately
--     never fires a mark in its cast round. Rows without the key ignore it.
--
--   * it has not been ended in or before the as-of round (issue #429):
--     ended_in_round_id is null, or names a round started after the as-of
--     round.
--
-- An is_undispellable row (issue #428: The Last Cuppa) skips the dispel
-- check -- no dispel cast can end it, even one that names it.
--
-- One Earl (issue #429, Earl of Earl Grey): of the Earl title rows
-- (`brewer_immunity`, mode `earl`) live by the rules above, only the newest
-- (created_at, then id) is returned. A new Earl displaces the old one from
-- the round the title is taken in -- before finalize_layer has ended the old
-- row -- and a countered or dispelled newer title leaves the older one
-- standing until something actually ends it.
--
-- Body from migration 0084 plus the spent and participated-window conditions; grants merge 0084
-- (authenticated) and 0108 (service_role, the integration suite's seam).
--
-- Canonical source: this file is the source of truth for the function body.
-- Edit here and run `npm run build:migrations` -- do not hand-edit the
-- generated migration. See db/sql/README.md.

create or replace function public._rr_active_effects_as_of(
  p_room_id uuid, p_as_of_round_id uuid
)
returns setof public.spell_active_effects
language sql
stable
set search_path = public
as $$
  -- Not SECURITY DEFINER: like _rr_active_ward_gate (0082), this is only ever
  -- reached from within a SECURITY DEFINER reader, so it runs with that
  -- reader's privileges. A direct call by `authenticated` hits RLS on
  -- spell_active_effects (no select policy) and returns nothing -- the room
  -- membership gate stays with the public-facing RPCs.
  with as_of as (
    select started_at from public.rounds where id = p_as_of_round_id
  ),
  live as (
    select sae.*
      from public.spell_active_effects sae
      join public.spell_casts src on src.id = sae.source_cast_id
      join public.rounds src_round on src_round.id = src.round_id
      left join public.rounds ended_round on ended_round.id = sae.ended_in_round_id
     where sae.room_id = p_room_id
       and coalesce(src.negated, false) = false
       and src.cast_inputs ->> 'consumed_by_round' is null
       and src.cast_inputs ->> 'consumed_by_draw' is null
       and (
         sae.rounds_remaining is null
         or public._rr_effect_rounds_elapsed(
              p_room_id, src_round.started_at, (select started_at from as_of)
            ) < sae.rounds_remaining
       )
       and (
         sae.effect_params ->> 'participated_rounds_after_cast' is null
         or public._rr_participated_rounds_elapsed(
              p_room_id, sae.target_player_id,
              -- the room's first round after the cast round; NULL (none yet)
              -- counts nothing
              (select min(nr.started_at) from public.rounds nr
                where nr.room_id = p_room_id and nr.started_at > src_round.started_at),
              (select started_at from as_of)
            ) < (sae.effect_params ->> 'participated_rounds_after_cast')::integer
       )
       and (
         sae.is_undispellable
         or not exists (
           select 1
             from public.spell_casts dc
             join public.rounds dr on dr.id = dc.round_id
            where dc.effect_kind = 'dispel'
              and dc.effect_params ->> 'ended_effect_id' = sae.id::text
              and coalesce(dc.negated, false) = false
              and dr.started_at <= (select started_at from as_of)
         )
       )
       and (
         ended_round.id is null
         or ended_round.started_at > (select started_at from as_of)
       )
  )
  select l.*
    from live l
   where not (
     l.effect_kind = 'brewer_immunity'
     and l.effect_params ->> 'mode' = 'earl'
     and exists (
       select 1
         from live newer
         join public.spell_casts newer_src on newer_src.id = newer.source_cast_id
         join public.rounds newer_round on newer_round.id = newer_src.round_id
        where newer.effect_kind = 'brewer_immunity'
          and newer.effect_params ->> 'mode' = 'earl'
          and (newer.created_at, newer.id) > (l.created_at, l.id)
          -- only a title cast by the as-of round displaces: a historical read
          -- still sees that round's Earl
          and newer_round.started_at <= (select started_at from as_of)
     )
   );
$$;

revoke execute on function public._rr_active_effects_as_of(uuid, uuid) from public, anon;
grant execute on function public._rr_active_effects_as_of(uuid, uuid) to authenticated, service_role;

comment on function public._rr_active_effects_as_of(uuid, uuid) is
  'Issue #310: the spell_active_effects rows live as of a given round -- '
  'source cast not negated, duration not exhausted (resolved-round count '
  'since the source round), not dispelled at/before the round (an '
  'is_undispellable row, #428, never is), (#435) '
  'not spent (source cast_inputs.consumed_by_round / consumed_by_draw), '
  '(#436) inside its participated-rounds window (effect_params.'
  'participated_rounds_after_cast, counted after the cast round), and '
  '(#429) not ended in or before the round (ended_in_round_id). Of the Earl '
  'title rows only the newest live one is returned -- one Earl per room. '
  'The shared row source for every reader that treats spell_active_effects '
  'as current game state (the ward gate/map, dispel/room badge readers, '
  'resolve_round''s phases).';
-- END db/sql/functions/_rr_active_effects_as_of.sql

-- BEGIN db/sql/functions/_rr_draw_redirect_trace.sql
-- _rr_draw_redirect_trace(p_round_id uuid, p_start_index integer) -> jsonb
--
-- Marked for Brew's Resolution Trace steps (issue #436): `draw_redirect`
-- steps, numbered from p_start_index. Appended by _rr_resolve_eval's final
-- phase, after Tea Heist's. Status-only, target = the marked player, source
-- cast = the mark's cast (its caster is the beneficiary):
--   * `marked`     -- a non-negated Marked for Brew cast in this round placed
--                     its mark (outcome `applied`). A countered cast gets
--                     Phase 1's negated-victim step instead, so none here;
--   * `redirected` -- a mark fired on a crit this round and the draw went to
--                     the beneficiary (outcome `applied`). The mark's cast
--                     may be from an earlier round;
--   * `fizzled`    -- a mark fired this round but the beneficiary already had
--                     a pending draw, so the target kept theirs (`no-op`).
-- Fired steps read what _apply_crit_redirect recorded at roll time
-- (cast_inputs.consumed_by_round / draw_redirect_outcome), so they decide
-- nothing. A crit in a tie-break layer fires after the layer-0 Trace is
-- written, so its step does not appear. Saucerer's Apprentice copies
-- (cast_inputs.is_copy) project no mark and are left out.
--
-- Canonical source: this file is the source of truth for the function body.
-- Edit here and run `npm run build:migrations` -- do not hand-edit the
-- generated migration. See db/sql/README.md.

create or replace function public._rr_draw_redirect_trace(p_round_id uuid, p_start_index integer)
returns jsonb
language sql
stable
security definer
set search_path = public
as $$
  with steps as (
    select c.id as cast_id, c.caster_id, c.target_player_id, sc.name as card_name,
           'marked' as outcome, 0 as kind_order, c.seq
      from public.spell_casts c
      join public.spell_deck_instances sdi on sdi.id = c.card_instance_id
      join public.spell_cards sc on sc.id = sdi.card_id
     where c.round_id = p_round_id
       and c.effect_kind = 'draw_redirect'
       and c.target_player_id is not null
       and not coalesce(c.negated, false)
       and not coalesce(c.cast_inputs ? 'is_copy', false)
    union all
    select c.id, c.caster_id, c.target_player_id, sc.name,
           c.cast_inputs ->> 'draw_redirect_outcome', 1, c.seq
      from public.spell_casts c
      join public.spell_deck_instances sdi on sdi.id = c.card_instance_id
      join public.spell_cards sc on sc.id = sdi.card_id
     where c.effect_kind = 'draw_redirect'
       and c.cast_inputs ->> 'consumed_by_round' = p_round_id::text
  )
  select coalesce(jsonb_agg(
           public._rr_trace_step(
             p_start_index + (s.ord - 1)::integer,
             'draw_redirect',
             jsonb_build_object(
               'cast_id', to_jsonb(s.cast_id),
               'active_effect_id', null,
               'card_name', to_jsonb(s.card_name),
               'caster_player_id', to_jsonb(s.caster_id)
             ),
             s.target_player_id,
             jsonb_build_object('type', 'status', 'value', case when s.outcome = 'marked' then null else 'marked' end),
             jsonb_build_object('type', 'status', 'value', s.outcome),
             jsonb_build_object('outcome', case when s.outcome = 'fizzled' then 'no-op' else 'applied' end)
           ) order by s.ord
         ), '[]'::jsonb)
    from (
      select steps.*, row_number() over (order by kind_order, seq, cast_id) as ord
        from steps
    ) s;
$$;

revoke execute on function public._rr_draw_redirect_trace(uuid, integer) from public, anon, authenticated;

comment on function public._rr_draw_redirect_trace(uuid, integer) is
  'Issue #436 (Marked for Brew): the resolver''s final-phase draw_redirect Trace steps -- marked (a mark cast this round), redirected / fizzled (a mark that fired on a crit this round, read from the cast_inputs _apply_crit_redirect wrote), numbered from p_start_index. Decides nothing. Internal.';
-- END db/sql/functions/_rr_draw_redirect_trace.sql

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

  -- Phase 6 (issues #438 / #436): Tea Heist's steps, so Marked for Brew's
  -- number on after them.
  v_heist_steps jsonb;
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
  -- issue #433 (Roll Exemption): one `roll_exemption` step per Participant
  -- who skipped their layer-0 roll, on their own row and pointing at the
  -- exempting cast, so the Round Recap explains the missing die. A
  -- countered caster who rolled late is not exempt and gets no step.
  -- ------------------------------------------------------------------
  for v_row in
    select ex.player_id, ex.cast_id, ex.card_name
      from public._rr_roll_exemptions(p_round_id) ex
     order by ex.player_id
  loop
    v_trace := v_trace || jsonb_build_array(public._rr_trace_step(
      v_step_index,
      'roll_exemption',
      jsonb_build_object(
        'cast_id', to_jsonb(v_row.cast_id),
        'active_effect_id', null,
        'card_name', to_jsonb(v_row.card_name),
        'caster_player_id', to_jsonb(v_row.player_id)
      ),
      v_row.player_id,
      jsonb_build_object('type', 'status', 'value', 'rolls'),
      jsonb_build_object('type', 'status', 'value', 'skipped')
    ));
    v_step_index := v_step_index + 1;
  end loop;

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
  -- the round keeps. Marked for Brew's draw_redirect steps (issue #436)
  -- follow.
  -- ------------------------------------------------------------------
  v_heist_steps := public._rr_heist_trace(p_round_id, v_step_index);
  v_trace := v_trace || v_heist_steps;

  -- Issue #436: Marked for Brew's draw_redirect steps -- marks placed this
  -- round, and marks that fired on a crit this round (read from what
  -- _apply_crit_redirect recorded at roll time; decides nothing).
  v_trace := v_trace || public._rr_draw_redirect_trace(
    p_round_id, v_step_index + jsonb_array_length(v_heist_steps)
  );

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
    -- issue #432: the Brew IOU / Brew Debt record finalize_layer writes, or null
    'brewer_record', v_selection -> 'brewer_record',
    'trace', v_trace, 'players', v_summary
  );
end;
$$;

revoke execute on function public._rr_resolve_eval(uuid, boolean) from public, anon, authenticated;

comment on function public._rr_resolve_eval(uuid, boolean) is
  'Issue #404 (ADR 0007): the body of the authoritative layer-0 resolver, split out of resolve_round. Returns { outcome, layer, brewer_id, brewer_source, tied_player_ids, cups_made, modifier_gain (null = cups_made, 0 = none, else as given; issue #425), no_modifier_gain (compat alias: modifier_gain = 0), earl_transfer (issue #429: the Earl title transfer finalize_layer writes, or null), brewer_record (issue #432: { source brew_iou|brew_debt, cast_id } finalize_layer writes to rounds.brewer_source, or null), trace, players } without persisting the Trace or the Resolution Summary. Maintains its own Cast-Log / modifier caches, so callers either keep them (resolve_round) or roll them back (_rr_resolve). p_dry_run skips the Calami-Tea tick RNG. Internal.';
-- END db/sql/functions/_rr_resolve_eval.sql

-- BEGIN db/sql/functions/_rr_scrap_round.sql
-- _rr_scrap_round(uuid) -> void
--
-- Atomic scrap of a resolved round for replay (issue #315 / #351):
-- snapshots the generation, backs the round out to a freshly-closed
-- generation-1 round, recomputes modifier caches. Internal -- called
-- only by confirm_round_replay. Verbatim from migration 0092.
--
-- Canonical source: this file is the source of truth for the function body.
-- Edit here and run `npm run build:migrations` -- do not hand-edit the
-- generated migration. See db/sql/README.md.

create or replace function public._rr_scrap_round(p_round_id uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_room_id uuid;
  v_status text;
  v_gen integer;
  v_brewer_id text;
  v_cups_made integer;
  v_gain integer;
  v_resolved_at timestamptz;
  v_trace jsonb;
  v_summary jsonb;
  v_snapshot jsonb;
  v_affected text[];
  v_roll_warded text[];
  v_pid text;
  v_heist record;
  v_slot text;
begin
  select room_id, status, replay_generation, brewer_id, cups_made,
         brewer_modifier_gain, resolved_at, resolution_trace, resolution_summary
    into v_room_id, v_status, v_gen, v_brewer_id, v_cups_made,
         v_gain, v_resolved_at, v_trace, v_summary
    from public.rounds
   where id = p_round_id
   for update;

  if v_room_id is null then
    raise exception '_rr_scrap_round: round not found';
  end if;
  if v_status <> 'resolved' then
    raise exception '_rr_scrap_round: round is not resolved (status %)', v_status;
  end if;

  -- Snapshot generation N's Recap payload before the delete pass removes it.
  v_snapshot := jsonb_build_object(
    'generation', v_gen,
    'brewer_id', v_brewer_id,
    'cups_made', v_cups_made,
    'brewer_modifier_gain', v_gain,
    'resolved_at', v_resolved_at,
    'resolution_trace', coalesce(v_trace, '[]'::jsonb),
    -- issue #408: the generation's own layer-0 Resolution Summary (ADR 0007),
    -- so its disclosure rows show that attempt's totals. null when the
    -- generation was resolved before summaries existed.
    'players', v_summary,
    'rolls', coalesce((
      select jsonb_agg(jsonb_build_object(
               'player_id', r.player_id, 'layer', r.layer, 'value', r.value,
               'modifier_snapshot', r.modifier_snapshot,
               'discarded_value', r.discarded_value,
               'entered_by_admin', r.entered_by_admin)
             order by r.layer, r.player_id)
        from public.rolls r
       where r.round_id = p_round_id
    ), '[]'::jsonb),
    'layer_participants', coalesce((
      select jsonb_agg(jsonb_build_object(
               'layer', rlp.layer, 'player_id', rlp.player_id)
             order by rlp.layer, rlp.player_id)
        from public.round_layer_participants rlp
       where rlp.round_id = p_round_id
    ), '[]'::jsonb)
  );

  -- Every player whose modifier cache generation N could have moved. The
  -- brewer's tea-making gain and both sides of any persistent-modifier
  -- transfer / spend are the known movers (spec §9), but rather than track
  -- the exact set, recompute for every round participant plus the brewer
  -- (cheap -- a handful of players -- and immune to a missed effect kind).
  -- Captured BEFORE the delete pass removes the participant rows' basis.
  select coalesce(array_agg(distinct p), array[]::text[])
    into v_affected
    from (
      select v_brewer_id as p where v_brewer_id is not null
      union
      select rp.player_id
        from public.round_participants rp
       where rp.round_id = p_round_id
      union
      select sc.target_player_id
        from public.spell_casts sc
       where sc.round_id = p_round_id
         and sc.effect_kind in ('persistent_modifier_transfer', 'persistent_modifier_spend')
         and sc.target_player_id is not null
    ) t
   where p is not null;

  -- issue #351: participants holding an active NEGATIVE-polarity roll-domain
  -- ward as of this round keep their generation-0 layer-0 roll instead of
  -- re-rolling in generation 1. Cast-Iron Kettle (polarity {negative}, domain
  -- {modifier, roll}) is the charter case and the only current card that
  -- matches; Jinxed Biscuit is roll-domain but positive so it is excluded
  -- ("Jinxed Biscuit: no interaction" -- decision: Tom, 2026-09-02), and the
  -- modifier-only wards (Bag for Life, Eternal Steep) are excluded by domain.
  -- The carry-over is flat once a ward matches -- polarity only gates which
  -- wards trigger it, not whether a given roll is worth freezing. Computed
  -- BEFORE the spell_casts delete below, since _rr_active_effects_as_of reads
  -- the Cast Log for a ward cast in this very round.
  select coalesce(array_agg(distinct sae.target_player_id), array[]::text[])
    into v_roll_warded
    from public._rr_active_effects_as_of(v_room_id, p_round_id) sae
   where sae.room_id = v_room_id
     and sae.effect_kind = 'ward'
     and sae.effect_params -> 'domain' ? 'roll'
     and sae.effect_params -> 'polarity' ? 'negative'
     and sae.target_player_id in (
       select rp.player_id from public.round_participants rp
        where rp.round_id = p_round_id
     );

  update public.rounds
     set scrapped_generations = scrapped_generations || jsonb_build_array(v_snapshot)
   where id = p_round_id;

  -- Mark Time for Brew's own cast(s) scrapped -- the spec's "written at
  -- confirm time" audit record, and the guard (alongside replay_generation)
  -- that stops a second pending row ever being created for this round.
  perform public._rr_mark_replay_cast_scrapped(p_round_id, true);

  -- Clean casting slate: no pass-1 casts carry into generation 1; cards spent
  -- in pass 1 stay spent (cast_spell_card / cast_reaction_spell_card already
  -- returned / discarded the instance at cast time -- deleting the log row
  -- does not restore it). Deleting a spell_casts row cascades its promoted
  -- spell_active_effects rows away (0084: source_cast_id NOT NULL, ON DELETE
  -- CASCADE), so pass-1-promoted active effects revert and effect-duration
  -- ticks un-happen: _rr_active_effects_as_of counts resolved rounds since the
  -- source cast, and un-resolving this round drops it from that count.
  --
  -- Issue #436 (#383 Q2): a Draw Redirect mark spent inside this generation
  -- (Marked for Brew; its source cast records cast_inputs.consumed_by_round)
  -- is deliberately NOT restored. The crit draw it redirected sits in
  -- pending_spell_draws, which the scrap leaves alone, so the beneficiary
  -- keeps the card -- restoring the mark would let it pay out twice. A mark
  -- cast in an earlier round is not deleted below either; only this round's
  -- casts are, and a mark cast in this round cannot have fired yet.
  --
  -- Issue #438 (Tea Heist, ADR 0005 #383 amendment): a Heist the scrapped
  -- attempt carried out (finalize_layer stamped cast_inputs.heist_moved) is
  -- reversed -- the card goes back to the victim if the thief still holds it
  -- (held or keep-or-swap). It lands in the victim's held slot, their
  -- keep-or-swap slot if they have drawn since (_rr_free_hand_slot), or back
  -- in the deck if both are full. Runs before the delete below removes the cast that records it.
  -- The Tea Heist card itself stays spent.
  for v_heist in
    select c.caster_id, c.target_player_id as victim_id,
           (c.cast_inputs ->> 'stolen_instance_id')::uuid as instance_id
      from public.spell_casts c
     where c.round_id = p_round_id
       and c.effect_kind = 'card_heist'
       and coalesce((c.cast_inputs ->> 'heist_moved')::boolean, false)
  loop
    v_slot := coalesce(public._rr_free_hand_slot(v_heist.victim_id), 'in_deck');

    update public.spell_deck_instances
       set location = v_slot,
           held_by_player = case when v_slot = 'in_deck' then null else v_heist.victim_id end
     where id = v_heist.instance_id
       and held_by_player = v_heist.caster_id
       and location in ('held', 'pending_swap');
  end loop;

  -- Issue #429: every effect the scrapped attempt ended (ended_in_round_id)
  -- is un-ended. Today that is only an Earl of Earl Grey title displaced by
  -- finalize_layer's _rr_apply_earl_title. The title row it
  -- gave the override's caster hangs off that override cast, so the delete
  -- below takes it away.
  update public.spell_active_effects
     set ended_in_round_id = null
   where ended_in_round_id = p_round_id;

  delete from public.spell_casts
   where round_id = p_round_id and effect_kind <> 'round_replay';

  -- The kept round_replay cast still points at generation N's reaction window;
  -- drop that reference before the window rows go (spell_casts.reaction_window_id
  -- is NO ACTION, not cascade).
  update public.spell_casts
     set reaction_window_id = null
   where round_id = p_round_id and effect_kind = 'round_replay';

  -- issue #351: a roll-domain ward holder keeps their generation-0 layer-0
  -- roll (they do not re-roll in generation 1); every other roll -- theirs
  -- at tie-break layers included -- is cleared so the rest of the table
  -- rolls fresh. v_roll_warded is empty in the ordinary case, so this is
  -- an unconditional delete then.
  delete from public.rolls
   where round_id = p_round_id
     and not (layer = 0 and player_id = any (v_roll_warded));
  delete from public.round_layer_participants where round_id = p_round_id;
  delete from public.spell_reaction_windows where round_id = p_round_id;

  -- Discard generation-0 Brew Ratings; Orders (a separate table) carry over
  -- unchanged (spec §11).
  delete from public.brew_ratings where round_id = p_round_id;

  -- Back the round out to a freshly-closed generation-1 round awaiting layer-0
  -- rolls. closed_at = now() restarts the existing 5-minute stall clock for
  -- generation 1. brewer_modifier_gain -> 0 and the cache recompute below back
  -- out the brewer's tea-making gain (base = sum of cups_made over rounds
  -- brewed, per _rr_base_modifier).
  update public.rounds
     set status = 'closed',
         current_layer = 0,
         brewer_id = null,
         cups_made = null,
         brewer_modifier_gain = 0,
         -- issue #432: a scrapped paying round owes its Brew Debt again; a
         -- scrapped Brew IOU round never created one (its cast is gone too)
         brewer_source = null,
         brewer_source_cast_id = null,
         resolved_at = null,
         resolution_trace = null,
         resolution_summary = null,
         replay_generation = replay_generation + 1,
         replay_frozen_rollers = v_roll_warded,
         closed_at = now()
   where id = p_round_id;

  foreach v_pid in array v_affected loop
    perform public._rr_recompute_modifier_cache(v_room_id, v_pid);
  end loop;
end;
$$;

revoke execute on function public._rr_scrap_round(uuid) from public, anon, authenticated;

comment on function public._rr_scrap_round(uuid) is
  'Issue #315: atomic scrap of a resolved round for replay -- snapshots the '
  'generation into rounds.scrapped_generations (issue #408: including its '
  'Resolution Summary as players), deletes its rolls / spell_casts '
  '(cascading promoted active effects) / reaction windows / layer participants / '
  'Brew Ratings (issue #438: first returning any Tea Heist card the thief '
  'still holds to its victim; issue #429: restoring any Earl title it ended), backs the round out to a freshly-closed generation-1 round, '
  'bumps replay_generation, and recomputes room_players.modifier for the brewer '
  'and every round participant. Issue #351: a participant holding an active '
  'roll-domain ward keeps their generation-0 layer-0 roll (no re-roll in '
  'generation 1); the frozen roster is written to rounds.replay_frozen_rollers. '
  'Internal -- called only by confirm_round_replay.';
-- END db/sql/functions/_rr_scrap_round.sql

-- BEGIN db/sql/functions/record_active_effect_if_persistent.sql
-- record_active_effect_if_persistent(uuid, text, text, uuid, text, jsonb, uuid) -> void
--
-- Promotes one Cast Log row to a spell_active_effects projection row when its
-- effect outlives the cast: a positive-duration card, a ward, or an effect
-- row carrying the `persist` marker (unbounded, rounds_remaining NULL).
-- Applies ward-blocks-ward suppression.
--
-- Body from migration 0097 plus issue #428 (spec #401 F2):
--   * a `brewer_immunity` effect row marked persist = true (The Last Cuppa)
--     is promoted unbounded, exactly as a persistent advantage is;
--   * the row's `undispellable` marker is copied to
--     spell_active_effects.is_undispellable, which every dispel path skips.
-- and issue #436: a `draw_redirect` effect row marked persist = true (Marked
-- for Brew's mark) is promoted unbounded too -- its window is counted in the
-- target's participated rounds by _rr_active_effects_as_of, not in
-- rounds_remaining.
--
-- Canonical source: this file is the source of truth for the function body.
-- Edit here and run `npm run build:migrations` -- do not hand-edit the
-- generated migration. See db/sql/README.md.

create or replace function public.record_active_effect_if_persistent(
  p_room_id uuid, p_caster_id text, p_target_player_id text, p_card_id uuid,
  p_effect_kind text, p_effect_params jsonb, p_source_cast_id uuid
)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_duration integer;
  v_new_seq bigint;
  v_new_round uuid;
begin
  select duration_rounds into v_duration
    from public.spell_cards
   where id = p_card_id;

  -- Non-ward persistent effects still need a positive duration; a NULL there
  -- means "not persistent" for them (unchanged from 0032) -- EXCEPT an
  -- effect row explicitly marked persist = true: Prophe-Tea's rest-of-day
  -- advantage (issue #320) and The Last Cuppa's rest-of-day brewer immunity
  -- (issue #428), and Marked for Brew's Draw Redirect mark (issue #436).
  -- Those record an unbounded row exactly as a NULL-duration ward does.
  if v_duration is null
     and p_effect_kind <> 'ward'
     and not (
       p_effect_kind in ('advantage', 'disadvantage', 'brewer_immunity', 'draw_redirect')
       and coalesce((p_effect_params ->> 'persist')::boolean, false)
     )
  then
    return;
  end if;

  -- Ward-blocks-ward (spec section 7): a strictly earlier-seq ward on this
  -- target whose domain AND polarity sets overlap this incoming ward
  -- suppresses it. A ward already recorded whose source cast is in an earlier
  -- round (or has no source cast) always counts as earlier.
  if p_effect_kind = 'ward' then
    select seq, round_id into v_new_seq, v_new_round
      from public.spell_casts where id = p_source_cast_id;

    if exists (
      select 1
        from public.spell_active_effects sae
        left join public.spell_casts wc on wc.id = sae.source_cast_id
       where sae.room_id = p_room_id
         and sae.target_player_id = p_target_player_id
         and sae.effect_kind = 'ward'
         and public._rr_ward_wards_ward(sae.effect_params, p_effect_params)
         and (
           wc.id is null
           or v_new_seq is null
           or wc.round_id is distinct from v_new_round
           or wc.seq < v_new_seq
         )
    ) then
      return;
    end if;
  end if;

  insert into public.spell_active_effects (
    room_id, target_player_id, caster_id, source_cast_id, card_id,
    effect_kind, effect_params, rounds_remaining, is_undispellable
  )
  values (
    p_room_id, p_target_player_id, p_caster_id, p_source_cast_id, p_card_id,
    p_effect_kind, p_effect_params,
    v_duration,   -- NULL for an unbounded ward / persistent effect
    coalesce((p_effect_params ->> 'undispellable')::boolean, false)
  );
end;
$$;

revoke execute on function public.record_active_effect_if_persistent(uuid, text, text, uuid, text, jsonb, uuid) from public, anon;
-- END db/sql/functions/record_active_effect_if_persistent.sql

