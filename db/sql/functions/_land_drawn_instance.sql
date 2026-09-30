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
-- pending keep-or-swap decision" guard. Stale Biscuit (#401) hooks in here:
-- a live next_draw mark on p_player_id lands the card with its beneficiary.
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
  v_already_held boolean;
  v_needs_swap_decision boolean;
begin
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
  values (p_player_id, p_instance_id, p_trigger);

  return v_needs_swap_decision;
end;
$$;

revoke execute on function public._land_drawn_instance(text, uuid, text) from public, anon, authenticated;
