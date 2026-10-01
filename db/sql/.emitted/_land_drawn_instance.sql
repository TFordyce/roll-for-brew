-- _land_drawn_instance(text, uuid, text) -> boolean
--
-- Issue #435 (spec #401 F6, #383 Q5): puts a just-drawn spell_deck_instances
-- row into p_player_id's hand and logs the draw. Returns needs_swap_decision.
-- Replaces the placement block the four draw RPCs (draw_spell_card,
-- draw_spell_card_as, draw_pending_spell_card, draw_pending_spell_card_manual)
-- each carried a copy of (0018 / 0034 / 0036, last restated in 0070):
--   * empty hand -> 'held';
--   * already holding a card, nat 20 -> parked as 'pending_swap' for the
--     keep-or-swap choice;
--   * already holding a card, nat 1 -> forced swap (0070, #267): the held card
--     goes back to 'in_deck' and the new one is seated as 'held', no choice.
-- Then one spell_draws row for the player.
--
-- The callers keep their own instance pick and their own "already has a
-- pending keep-or-swap decision" guard.
--
-- Issue #437 (Stale Biscuit): before placing, the oldest live `next_draw`
-- draw_redirect mark on p_player_id fires -- oldest first by created_at, then
-- id. "Live" is _rr_active_effects_as_of in the mark's room as of that room's
-- latest round (not countered, not spent, not dispelled), and the mark's cast
-- round has resolved, so a counter still to come in that round cannot
-- un-happen a redirect. Firing spends the mark for good: the source cast
-- records cast_inputs.consumed_by_draw (the spell_draws row) and
-- draw_redirect_outcome:
--   * `redirected` -- the card lands with the beneficiary (the mark's caster)
--     in their free hand slot (_rr_free_hand_slot): 'held', or 'pending_swap'
--     for a keep-or-swap choice. The beneficiary did not roll, so a nat 1's
--     forced swap does not apply to them, and the drawer's own hand is
--     untouched. The spell_draws row names the beneficiary (it is their
--     card); the drawer gets needs_swap_decision = false.
--   * `fizzled`    -- the beneficiary's hand is full (held + pending_swap), so
--     the mark is spent and the drawer lands the card as normal.
-- Only one mark fires per draw. The mark's cast row is locked and re-checked,
-- so two concurrent draws by the target never spend one mark twice.
--
-- Internal: no grant; only reached from the SECURITY DEFINER draw RPCs.
--
-- Canonical source: this file is the source of truth for the function body.
-- Edit here and run `npm run build:migrations` -- do not hand-edit the
-- generated migration. See db/sql/README.md.

create or replace function public._land_drawn_instance(
  p_player_id text, p_instance_id uuid, p_trigger text
)
returns boolean
language plpgsql
set search_path = public
as $$
declare
  v_mark record;
  v_slot text;
  v_draw_id uuid;
  v_already_held boolean;
  v_needs_swap_decision boolean;
begin
  loop
    select m.caster_id as beneficiary_id, m.source_cast_id
      into v_mark
      from (
        select distinct sae.room_id
          from public.spell_active_effects sae
         where sae.target_player_id = p_player_id
           and sae.effect_kind = 'draw_redirect'
           and sae.effect_params ->> 'trigger' = 'next_draw'
      ) mark_room
      cross join lateral (
        select r.id from public.rounds r
         where r.room_id = mark_room.room_id
         order by r.started_at desc
         limit 1
      ) latest
      cross join lateral public._rr_active_effects_as_of(mark_room.room_id, latest.id) m
      join public.spell_casts src on src.id = m.source_cast_id
      join public.rounds src_round on src_round.id = src.round_id
     where m.target_player_id = p_player_id
       and m.effect_kind = 'draw_redirect'
       and m.effect_params ->> 'trigger' = 'next_draw'
       and src_round.resolved_at is not null
     order by m.created_at, m.id
     limit 1;

    exit when not found;

    -- Still unspent once locked: this draw fires it. Otherwise a concurrent
    -- draw just spent it -- look again.
    perform 1 from public.spell_casts
     where id = v_mark.source_cast_id
       and cast_inputs ->> 'consumed_by_draw' is null
       for update;
    exit when found;
  end loop;

  if v_mark.source_cast_id is not null then
    v_slot := public._rr_free_hand_slot(v_mark.beneficiary_id);

    if v_slot is not null then
      update public.spell_deck_instances
         set location = v_slot, held_by_player = v_mark.beneficiary_id
       where id = p_instance_id;

      insert into public.spell_draws (player_id, card_instance_id, trigger)
      values (v_mark.beneficiary_id, p_instance_id, p_trigger)
      returning id into v_draw_id;

      v_needs_swap_decision := false;
    end if;
  end if;

  if v_draw_id is null then
    v_already_held := exists (
      select 1 from public.spell_deck_instances
       where held_by_player = p_player_id and location = 'held'
    );

    if v_already_held and p_trigger = 'nat1' then
      update public.spell_deck_instances
         set location = 'in_deck', held_by_player = null
       where held_by_player = p_player_id and location = 'held';

      update public.spell_deck_instances
         set location = 'held', held_by_player = p_player_id
       where id = p_instance_id;

      v_needs_swap_decision := false;
    else
      update public.spell_deck_instances
         set location = case when v_already_held then 'pending_swap' else 'held' end,
             held_by_player = p_player_id
       where id = p_instance_id;

      v_needs_swap_decision := v_already_held;
    end if;

    insert into public.spell_draws (player_id, card_instance_id, trigger)
    values (p_player_id, p_instance_id, p_trigger)
    returning id into v_draw_id;
  end if;

  if v_mark.source_cast_id is not null then
    update public.spell_casts
       set cast_inputs = coalesce(cast_inputs, '{}'::jsonb)
                         || jsonb_build_object(
                              'consumed_by_draw', v_draw_id,
                              'draw_redirect_outcome',
                              case when v_slot is null then 'fizzled' else 'redirected' end
                            )
     where id = v_mark.source_cast_id;
  end if;

  return v_needs_swap_decision;
end;
$$;

revoke execute on function public._land_drawn_instance(text, uuid, text) from public, anon, authenticated;
