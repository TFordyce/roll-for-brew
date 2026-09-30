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
