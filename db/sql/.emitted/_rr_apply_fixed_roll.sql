-- _rr_apply_fixed_roll(uuid, text, integer, uuid, integer) -> record
--
-- Eager-shim helper for the fixed_roll primitive (Steady Hand, Sleeping
-- Camomile): returns the pinned die value and whether it applied, ward-
-- gated. Verbatim from migration 0096.
--
-- Canonical source: this file is the source of truth for the function body.
-- Edit here and run `npm run build:migrations` -- do not hand-edit the
-- generated migration. See db/sql/README.md.

create or replace function public._rr_apply_fixed_roll(
  p_round_id uuid, p_player_id text, p_layer integer,
  p_room_id uuid, p_rolled_value integer
)
returns table (value integer, applied boolean)
language plpgsql
security definer
set search_path = public
as $$
declare
  v_fixed_value integer;
  v_before_seq bigint;
  v_polarity text;
  v_warded boolean := false;
  v_ward record;
begin
  if p_layer <> 0 then
    return query select p_rolled_value, false;
    return;
  end if;

  select (sc.effect_params ->> 'value')::integer, sc.seq
    into v_fixed_value, v_before_seq
    from public.spell_casts sc
   where sc.round_id = p_round_id
     and sc.target_player_id = p_player_id
     and sc.target_pending = false
     and sc.effect_kind = 'fixed_roll'
     and sc.negated = false            -- pre-resolve invariant; negation is
   order by sc.seq                     -- resolver-written (Phase 1)
   limit 1;

  if v_fixed_value is null then
    return query select p_rolled_value, false;
    return;
  end if;

  -- Polarity of the fix vs what the player actually rolled, mirroring
  -- roll_flip's "computed from the actual pre-value" (spec section 7). A
  -- neutral fix (constant == roll) is never warded.
  v_polarity := case
    when v_fixed_value > p_rolled_value then 'positive'
    when v_fixed_value < p_rolled_value then 'negative'
    else 'neutral' end;

  -- issue #318 merge fix: v_ward must be assigned before the UPDATE below
  -- references v_ward.* -- PL/pgSQL rejects a field ref on a never-assigned
  -- record at plan time even inside the untaken CASE branch. A no-row gate
  -- result otherwise leaves it unassigned.
  select null::uuid as ward_cast_id, null::text as ward_card_name into v_ward;
  if v_polarity <> 'neutral' then
    select g.ward_cast_id, g.ward_card_name into v_ward
      from public._rr_active_ward_gate(
        p_room_id, p_player_id, 'roll', v_polarity, p_round_id, v_before_seq) g;
    v_warded := found;
  end if;

  update public.spell_casts casts
     set cast_inputs = coalesce(casts.cast_inputs, '{}'::jsonb) || jsonb_build_object(
           'roll_transform', jsonb_build_object(
             'kind', 'fixed_roll',
             'order', 0,
             'players', jsonb_build_array(
               case when v_warded then jsonb_build_object(
                 'player_id', p_player_id,
                 'before', p_rolled_value,
                 'after', p_rolled_value,
                 'warded', true,
                 'would_be_after', v_fixed_value,
                 'ward_cast_id', v_ward.ward_cast_id,
                 'ward_card_name', v_ward.ward_card_name
               ) else jsonb_build_object(
                 'player_id', p_player_id,
                 'before', p_rolled_value,
                 'after', v_fixed_value
               ) end
             )
           ))
   where casts.round_id = p_round_id
     and casts.target_player_id = p_player_id
     and casts.target_pending = false
     and casts.effect_kind = 'fixed_roll'
     and casts.negated = false;

  if v_warded then
    return query select p_rolled_value, false;
  else
    return query select v_fixed_value, true;
  end if;
end;
$$;

revoke execute on function public._rr_apply_fixed_roll(uuid, text, integer, uuid, integer) from public, anon;
grant execute on function public._rr_apply_fixed_roll(uuid, text, integer, uuid, integer) to authenticated;
