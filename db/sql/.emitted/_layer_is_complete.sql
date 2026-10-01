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
-- A Layer 0 with zero expected rollers (issue #432: a debt round, where
-- nobody rolls) is complete as it stands -- no hold there can wait on a roll.
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
declare
  v_expected integer;
begin
  v_expected := public.count_expected_layer_rollers(p_round_id, p_layer);

  if p_layer = 0 and v_expected = 0 then
    return true;
  end if;

  if (select count(*) from public.rolls where round_id = p_round_id and layer = p_layer)
     < v_expected then
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
  'Issue #414 (ADR 0008): Layer completeness with no caller-identity gate -- every expected roller has rolled and, at Layer 0, no Pending Spell Die is outstanding, no Deferred Forced-Reroll Target hold is in place, and no compelled Action cast is still owed (issue #440), and no Tea Party Revolt pick is outstanding (issue #430). A Layer 0 with zero expected rollers (issue #432: a debt round) is complete as it stands. Internal to round advancement.';
