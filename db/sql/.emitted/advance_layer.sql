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
