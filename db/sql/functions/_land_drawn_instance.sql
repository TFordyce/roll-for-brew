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
-- draw_redirect mark on p_player_id fires (_claim_next_draw_mark, #471, which
-- defines "live" and locks the mark). Firing spends the mark for good: the
-- source cast records cast_inputs.consumed_by_draw (the spell_draws row) and
-- draw_redirect_outcome:
--   * `redirected` -- the card lands with the beneficiary (the mark's caster)
--     in their free hand slot (_rr_free_hand_slot): 'held', or 'pending_swap'
--     for a keep-or-swap choice. The beneficiary did not roll, so a nat 1's
--     forced swap does not apply to them, and the drawer's own hand is
--     untouched. The spell_draws row names the beneficiary (it is their
--     card); the drawer gets needs_swap_decision = false.
--   * `fizzled`    -- the beneficiary's hand is full (held + pending_swap), so
--     the mark is spent and the drawer lands the card as normal.
-- Only one mark fires per draw.
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
  v_outcome text;
  v_draw_id uuid;
  v_already_held boolean;
  v_needs_swap_decision boolean;
begin
  select * into v_mark from public._claim_next_draw_mark(p_player_id);

  if v_mark.source_cast_id is not null then
    v_slot := public._rr_free_hand_slot(v_mark.beneficiary_id);
    v_outcome := case when v_slot is null then 'fizzled' else 'redirected' end;

    if v_outcome = 'redirected' then
      update public.spell_deck_instances
         set location = v_slot, held_by_player = v_mark.beneficiary_id
       where id = p_instance_id;

      insert into public.spell_draws (player_id, card_instance_id, trigger)
      values (v_mark.beneficiary_id, p_instance_id, p_trigger)
      returning id into v_draw_id;

      v_needs_swap_decision := false;
    end if;
  end if;

  -- No mark, or it fizzled: the drawer lands the card as before.
  if v_outcome is distinct from 'redirected' then
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

  if v_outcome is not null then
    update public.spell_casts
       set cast_inputs = coalesce(cast_inputs, '{}'::jsonb)
                         || jsonb_build_object(
                              'consumed_by_draw', v_draw_id,
                              'draw_redirect_outcome', v_outcome
                            )
     where id = v_mark.source_cast_id;
  end if;

  return v_needs_swap_decision;
end;
$$;

revoke execute on function public._land_drawn_instance(text, uuid, text) from public, anon, authenticated;

comment on function public._land_drawn_instance(text, uuid, text) is
  'Issue #435: places a just-drawn instance in the drawer''s hand (held / pending_swap / nat-1 forced swap) and logs the spell_draws row; returns needs_swap_decision. (#437) First fires the drawer''s oldest live next_draw Draw Redirect mark (Stale Biscuit): the card lands with the beneficiary''s free hand slot, or the redirect fizzles on a full hand; the mark is spent via cast_inputs.consumed_by_draw / draw_redirect_outcome. Internal.';
