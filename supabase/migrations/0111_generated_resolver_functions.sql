-- GENERATED FROM db/sql/functions/ -- DO NOT EDIT
--
-- Written by `npm run build:migrations` from the canonical resolver-function
-- sources under db/sql/functions/. To change any function below, edit its
-- db/sql/functions/<name>.sql and re-run the build. See db/sql/README.md.
--
-- Functions in this migration:
--   _layer_is_complete
--   _layer_rolls_json
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
--     awaiting its target, issue #325).
-- Same rules as get_current_layer_rolls_if_complete (0098), which keeps its
-- identity gate until round advancement finishes moving over (spec #412).
--
-- Internal: called by advance_layer and finalize_layer, which run with
-- definer rights.
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

  return true;
end;
$$;

revoke execute on function public._layer_is_complete(uuid, integer) from public, anon, authenticated;

comment on function public._layer_is_complete(uuid, integer) is
  'Issue #414 (ADR 0008): Layer completeness with no caller-identity gate -- every expected roller has rolled and, at Layer 0, no Pending Spell Die is outstanding and no Deferred Forced-Reroll Target hold is in place. Internal to round advancement.';
-- END db/sql/functions/_layer_is_complete.sql

-- BEGIN db/sql/functions/_layer_rolls_json.sql
-- _layer_rolls_json(p_round_id uuid, p_layer integer) -> jsonb
--
-- A Layer's rolls as the JSON array the round-advancement outcomes carry
-- (ADR 0008): [{ player_id, value, discarded_value, entered_by_admin }],
-- ordered by player. advance_layer returns it as the raw rolls for "layer
-- rolls revealed"; finalize_layer returns it as the final (post-transform)
-- rolls for "round revealed".
--
-- Internal: called by advance_layer and finalize_layer, which run with
-- definer rights.
--
-- Canonical source: this file is the source of truth for the function body.
-- Edit here and run `npm run build:migrations` -- do not hand-edit the
-- generated migration. See db/sql/README.md.

create or replace function public._layer_rolls_json(p_round_id uuid, p_layer integer)
returns jsonb
language sql
stable
security definer
set search_path = public
as $$
  select coalesce(jsonb_agg(jsonb_build_object(
           'player_id', r.player_id,
           'value', r.value,
           'discarded_value', r.discarded_value,
           'entered_by_admin', r.entered_by_admin)
           order by r.player_id), '[]'::jsonb)
    from public.rolls r
   where r.round_id = p_round_id and r.layer = p_layer;
$$;

revoke execute on function public._layer_rolls_json(uuid, integer) from public, anon, authenticated;

comment on function public._layer_rolls_json(uuid, integer) is
  'Issue #415 (ADR 0008): a Layer''s rolls as [{ player_id, value, discarded_value, entered_by_admin }] ordered by player -- the rolls payload advance_layer and finalize_layer return. Internal to round advancement.';
-- END db/sql/functions/_layer_rolls_json.sql

-- BEGIN db/sql/functions/advance_layer.sql
-- advance_layer(p_round_id uuid) -> jsonb
--
-- Layer completion (ADR 0008, issue #415): what happens once the current
-- Layer's rolls are all in. Takes the round row lock first -- the same lock
-- finalize_layer and resolve_round take, so the nested calls below reuse it --
-- then does nothing unless the round is `closed` and its current Layer is
-- complete (_layer_is_complete: every expected roller has rolled, and at
-- Layer 0 no Pending Spell Die or Deferred Forced-Reroll Target hold). Then:
--   * Layer 0 with no reaction window yet: opens it (open_reaction_window,
--     which attaches the pre-roll forced_reroll and chosen-pair casts). If
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
    return jsonb_build_object('outcome', 'noop', 'reason', 'layer_incomplete');
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
  'Layer completion (ADR 0008, issue #415). Locks the round, then returns { outcome: "noop", reason } unless the round is closed and its current Layer is complete -- reasons: round_not_found, round_not_closed, layer_incomplete, window_open. At Layer 0 with no reaction window it opens one and returns { outcome: "windowOpened", layer: 0, window_closed, finalization, layer_rolls }, where finalization is finalize_layer''s outcome when nobody was eligible to react (the window closed on the spot) and null otherwise. At Layer 0 with a closed window, or at a Tie-Break Reroll Layer, it returns finalize_layer''s outcome ({ outcome: "brewer", ... } or { outcome: "tie", ... }). layer_rolls -- { layer, rolls: [{ player_id, value, discarded_value, entered_by_admin }] }, the raw pre-transform rolls -- is present only on the call that first finds the Layer complete. Never opens a second window; never raises for caller identity or a lost race.';
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
  'Layer finalization (ADR 0008, issue #414). Locks the round, then returns { outcome: "noop", reason } unless the round is closed, its current Layer is complete, and (at Layer 0) its reaction window exists and is closed -- reasons: round_not_found, round_not_closed, no_window, window_open, layer_incomplete. Otherwise, in one transaction: runs the eager roll-input shim (forced rerolls, flip, swap, chosen-pair; ADR 0005), calls resolve_round(uuid) unchanged, and commits the outcome. Returns { outcome: "brewer", layer, brewer_id, cups_made, rolls: [{ player_id, value, discarded_value, entered_by_admin }], replay_pending } after writing the resolution (no-modifier-gain included) and recording any pending Round Replay; or { outcome: "tie", layer, tied_player_ids } after advancing to the next Layer (layer is the new one). Never raises for caller identity or a lost race.';
-- END db/sql/functions/finalize_layer.sql

