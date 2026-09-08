-- One-off recovery for a round stranded on "Reaction Window Open" forever
-- (issue #387): casting the last held Reaction card reopened the chaining
-- poll but left nobody eligible to Pass, so close_reaction_window never
-- fired and the round can't finalize. Migration 0104 stops this happening
-- going forward, and stallEnforcement.ts now self-heals such a window ~5
-- minutes after the round closed -- so once both are deployed this script is
-- only needed for a round already stuck before the deploy.
--
-- HOW TO RUN: paste into the Supabase dashboard SQL editor for the prod
-- project and run STEP 1, then STEP 2. It must run as `postgres` (the SQL
-- editor does): the finalize RPCs (resolve_round, apply_roll_flip, ...)
-- grant EXECUTE to `authenticated` only, not `service_role`, so a
-- service-role script (supabase-js) CANNOT do this. STEP 2 briefly injects
-- a participant's JWT claim into the transaction so the SECURITY DEFINER
-- helpers that call current_player_id() (get_current_layer_rolls_if_complete)
-- resolve an identity; the claim is transaction-local (set_config(..., true))
-- and gone at COMMIT.
--
-- STEP 2 runs finalizeReactionWindow + applyLayerOutcome
-- (src/app/rounds/layerResolution.ts) by hand: close the window, apply its
-- forced_reroll / roll_flip / roll_swap / roll_pair_transform casts in the
-- documented order, then resolve_round to pick the brewer (or advance to a
-- tie-break layer). It does NOT emit the realtime broadcasts the app path
-- does -- players' devices pick the resolved round up on their next refresh.

-- ---------------------------------------------------------------------------
-- STEP 1 (read-only): confirm what's stranded before running STEP 2.
-- ---------------------------------------------------------------------------
select w.id                                    as window_id,
       w.round_id,
       w.layer,
       w.poll_round,
       w.status,
       r.status                                as round_status,
       r.closed_at,
       public.count_eligible_reaction_holders(w.round_id) as eligible_holders,
       exists (
         select 1 from public.rolls x
          where x.round_id = w.round_id and x.layer = w.layer
       ) as has_rolls
  from public.spell_reaction_windows w
  join public.rounds r on r.id = w.round_id
 where w.status = 'open'
   and r.status = 'closed'
 order by w.opened_at desc;

-- ---------------------------------------------------------------------------
-- STEP 2: recover. Targets the single stranded window (open window on a
-- closed round with zero eligible holders). Aborts if there is not exactly
-- one -- hard-code v_round_id in that case.
-- ---------------------------------------------------------------------------
do $$
declare
  v_round_id uuid;
  v_window_id uuid;
  v_layer integer;
  v_actor_player text;
  v_actor_uid uuid;
  v_match_count integer;
  v_target record;
  v_outcome jsonb;
  v_brewer text;
  v_cups integer;
  v_no_mod boolean;
begin
  -- --- locate the stranded round (as postgres, before any claim is set) ---
  select count(*) into v_match_count
    from public.spell_reaction_windows w
    join public.rounds r on r.id = w.round_id
   where w.status = 'open' and r.status = 'closed'
     and public.count_eligible_reaction_holders(w.round_id) = 0;

  if v_match_count = 0 then
    raise exception 'No stranded reaction window found (open window, closed round, zero eligible holders). Nothing to do.';
  elsif v_match_count > 1 then
    raise exception 'More than one stranded window -- hard-code v_round_id below and re-run.';
  end if;

  select w.round_id, w.id, w.layer
    into v_round_id, v_window_id, v_layer
    from public.spell_reaction_windows w
    join public.rounds r on r.id = w.round_id
   where w.status = 'open' and r.status = 'closed'
     and public.count_eligible_reaction_holders(w.round_id) = 0;
  -- To force a specific round instead, comment out the block above and set:
  --   v_round_id := '<round-uuid>';
  --   select id, layer into v_window_id, v_layer
  --     from public.spell_reaction_windows
  --    where round_id = v_round_id and status = 'open'
  --    order by opened_at desc limit 1;

  raise notice 'Recovering round % (window %, layer %)', v_round_id, v_window_id, v_layer;

  -- --- inject a participant's JWT claim for current_player_id() ---
  select rp.player_id into v_actor_player
    from public.round_participants rp
    join public.rolls x on x.round_id = rp.round_id and x.player_id = rp.player_id and x.layer = v_layer
   where rp.round_id = v_round_id
   limit 1;

  if v_actor_player is null then
    raise exception 'Round % has no roller on layer % -- not the #387 shape; investigate manually.', v_round_id, v_layer;
  end if;

  select u.id into v_actor_uid
    from auth.users u
   where coalesce(u.raw_user_meta_data ->> 'sub', u.id::text) = v_actor_player;

  if v_actor_uid is null then
    raise exception 'Could not map participant % to an auth.users row.', v_actor_player;
  end if;

  perform set_config('request.jwt.claims', json_build_object('sub', v_actor_uid::text, 'role', 'authenticated')::text, true);
  raise notice 'Acting as participant % for the finalize sequence.', v_actor_player;

  -- --- finalizeReactionWindow ---
  if not exists (select 1 from public.get_current_layer_rolls_if_complete(v_round_id)) then
    raise exception 'Layer is not roll-complete for round % -- not the #387 shape; investigate manually.', v_round_id;
  end if;

  perform public.close_reaction_window(v_window_id);
  raise notice 'Window closed.';

  for v_target in
    select target_player_id from public.get_forced_reroll_targets(v_round_id, v_layer)
  loop
    perform public.apply_forced_reroll(v_round_id, v_layer, v_target.target_player_id);
    raise notice 'apply_forced_reroll: %', v_target.target_player_id;
  end loop;

  if public.has_active_cast_kind(v_round_id, v_layer, 'roll_flip') then
    perform public.apply_roll_flip(v_round_id, v_layer);
    raise notice 'apply_roll_flip applied.';
  end if;
  if public.has_active_cast_kind(v_round_id, v_layer, 'roll_swap') then
    perform public.apply_roll_swap(v_round_id, v_layer);
    raise notice 'apply_roll_swap applied.';
  end if;
  if public.has_active_cast_kind(v_round_id, v_layer, 'roll_pair_transform') then
    perform public.apply_roll_pair_transform(v_round_id, v_layer);
    raise notice 'apply_roll_pair_transform applied.';
  end if;

  -- --- applyLayerOutcome ---
  v_outcome := public.resolve_round(v_round_id);
  raise notice 'resolve_round outcome: %', v_outcome;

  if v_outcome ->> 'outcome' = 'brewer' then
    v_brewer := v_outcome ->> 'brewer_id';
    v_cups   := (v_outcome ->> 'cups_made')::integer;
    v_no_mod := coalesce((v_outcome ->> 'no_modifier_gain')::boolean, false);

    if v_outcome ->> 'brewer_source' = 'declared_number' then
      perform public.resolve_declared_number_tea_maker(v_round_id, v_layer);
    end if;

    perform public.resolve_round(v_round_id, v_brewer, v_cups, v_no_mod);
    raise notice 'Round resolved. Brewer %, cups %.', v_brewer, v_cups;
  else
    perform public.advance_round_layer(
      v_round_id,
      (select array_agg(value) from jsonb_array_elements_text(v_outcome -> 'tied_player_ids'))
    );
    raise notice 'Layer tied -> advanced to tie-break layer %.', (v_outcome ->> 'layer');
  end if;
end $$;

-- ---------------------------------------------------------------------------
-- STEP 3 (read-only): confirm the round resolved.
-- ---------------------------------------------------------------------------
-- select id, status, brewer_id, cups_made, resolved_at
--   from public.rounds where id = '<round-uuid>';
