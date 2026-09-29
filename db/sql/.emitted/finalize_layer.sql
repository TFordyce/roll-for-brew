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
--   3. commits the outcome -- brewer: write the resolution (no-modifier-gain
--      included) and record any pending Round Replay; tie: advance to the next
--      Layer with the tied players.
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
    return jsonb_build_object('outcome', 'noop', 'reason', 'layer_incomplete');
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

  perform public.resolve_round(
    p_round_id, v_brewer_id, v_cups_made,
    coalesce((v_out ->> 'no_modifier_gain')::boolean, false));

  v_replay_pending := public.record_pending_round_replay(p_round_id);

  -- The Layer's final (post-shim) rolls, for the round-revealed broadcast.
  select coalesce(jsonb_agg(jsonb_build_object(
           'player_id', r.player_id,
           'value', r.value,
           'discarded_value', r.discarded_value,
           'entered_by_admin', r.entered_by_admin)
           order by r.player_id), '[]'::jsonb)
    into v_rolls
    from public.rolls r
   where r.round_id = p_round_id and r.layer = v_layer;

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
  'Layer finalization (ADR 0008, issue #414). Locks the round, then returns { outcome: "noop", reason } unless the round is closed, its current Layer is complete, and (at Layer 0) its reaction window exists and is closed -- reasons: round_not_found, round_not_closed, no_window, window_open, layer_incomplete. Otherwise, in one transaction: runs the eager roll-input shim (forced rerolls, flip, swap, chosen-pair; ADR 0005), calls resolve_round(uuid) unchanged, and commits the outcome. Returns { outcome: "brewer", layer, brewer_id, cups_made, rolls: [{ player_id, value, discarded_value, entered_by_admin }], replay_pending } after writing the resolution (no-modifier-gain included) and recording any pending Round Replay; or { outcome: "tie", layer, tied_player_ids } after advancing to the next Layer (layer is the new one). Never raises for caller identity or a lost race.';
