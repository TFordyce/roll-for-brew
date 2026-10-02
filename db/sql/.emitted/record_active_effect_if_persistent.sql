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
-- and issue #439: a `courage_token` effect row marked persist = true
-- (Liquid Courage's Courage Token) is promoted unbounded too -- its 3 rounds
-- are the recipient's participated rounds from the gift round, counted by
-- _rr_active_effects_as_of.
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
  -- (issue #428), Marked for Brew's Draw Redirect mark (issue #436) and
  -- Liquid Courage's Courage Token (issue #439).
  -- Those record an unbounded row exactly as a NULL-duration ward does.
  if v_duration is null
     and p_effect_kind <> 'ward'
     and not (
       p_effect_kind in ('advantage', 'disadvantage', 'brewer_immunity', 'draw_redirect', 'courage_token')
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
