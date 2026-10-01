-- _rr_apply_earl_title(p_round_id uuid, p_transfer jsonb) -> void
--
-- Earl of Earl Grey's title bookkeeping (issue #429, spec #401, design #381).
-- Called only by finalize_layer's commit step, in the same transaction as the
-- resolution write -- never by the resolver, whose body also runs as the
-- Provisional Recap's rolled-back dry run (ADR 0007). The Tea Heist pattern
-- (ADR 0005 #383 amendment): the resolver decides, the committer writes.
--
--   1. The transfer. p_transfer is resolve_round's `earl_transfer` decision
--      ({ active_effect_id, from_player_id, to_player_id, cast_id }) or null.
--      It inserts a fresh title row for the override's caster, hanging off
--      the override cast (so a Round replay scrap, which deletes that cast,
--      takes it away again), copying the old row's card.
--   2. One Earl. _rr_active_effects_as_of already treats only the newest live
--      title row in the room as live; this ends every older title row still
--      open (ended_in_round_id = this round) -- the one the transfer just
--      displaced, or the one a fresh Earl cast displaced this round -- so a
--      later dispel of the new Earl can't hand the title back.
--
-- Safe to repeat: the transfer insert is skipped when the cast already
-- carries a title row, and the ending only touches open rows.
--
-- Canonical source: this file is the source of truth for the function body.
-- Edit here and run `npm run build:migrations` -- do not hand-edit the
-- generated migration. See db/sql/README.md.

create or replace function public._rr_apply_earl_title(p_round_id uuid, p_transfer jsonb)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_room_id uuid;
  v_earl record;
begin
  select room_id into v_room_id from public.rounds where id = p_round_id;

  if p_transfer is not null and jsonb_typeof(p_transfer) = 'object' then
    insert into public.spell_active_effects (
      room_id, target_player_id, caster_id, source_cast_id, card_id,
      effect_kind, effect_params, rounds_remaining
    )
    select v_room_id, p_transfer ->> 'to_player_id', p_transfer ->> 'to_player_id',
           (p_transfer ->> 'cast_id')::uuid, old.card_id,
           'brewer_immunity',
           jsonb_build_object(
             'mode', 'earl', 'persist', true,
             'transferred_from_effect_id', old.id
           ),
           null
      from public.spell_active_effects old
     where old.id = (p_transfer ->> 'active_effect_id')::uuid
       and not exists (
         select 1 from public.spell_active_effects dup
          where dup.source_cast_id = (p_transfer ->> 'cast_id')::uuid
            and dup.effect_kind = 'brewer_immunity'
       );
  end if;

  -- The Earl as of this round, after any transfer.
  select sae.id, sae.created_at into v_earl
    from public._rr_active_effects_as_of(v_room_id, p_round_id) sae
   where sae.effect_kind = 'brewer_immunity'
     and sae.effect_params ->> 'mode' = 'earl';

  if not found then
    return;
  end if;

  update public.spell_active_effects sae
     set ended_in_round_id = p_round_id
   where sae.room_id = v_room_id
     and sae.effect_kind = 'brewer_immunity'
     and sae.effect_params ->> 'mode' = 'earl'
     and sae.ended_in_round_id is null
     and (sae.created_at, sae.id) < (v_earl.created_at, v_earl.id);
end;
$$;

revoke execute on function public._rr_apply_earl_title(uuid, jsonb) from public, anon, authenticated;

comment on function public._rr_apply_earl_title(uuid, jsonb) is
  'Issue #429 (Earl of Earl Grey): writes resolve_round''s earl_transfer decision (a new title row for the override''s caster, hanging off the override cast) and ends every older open Earl title row in the room (ended_in_round_id), leaving one Earl. Called only by finalize_layer''s commit step, so the Provisional Recap''s dry run never moves the title. Idempotent. Internal.';
