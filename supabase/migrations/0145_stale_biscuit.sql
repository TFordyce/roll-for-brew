-- Stale Biscuit (issue #437, spec #401, design #383).
--
-- Stale Biscuit (Rare, OPPONENT, Action): "Mark a target. The very next card
-- they would draw goes to you instead."
--
-- Model: a Draw Redirect mark that fires at draw time.
--   * The cast's one effect row, TARGET / draw_redirect
--     `{trigger: next_draw, persist: true}`, is promoted to an unbounded
--     spell_active_effects row on the target (record_active_effect_if_persistent:
--     `persist`, as for Marked for Brew). The beneficiary is the row's
--     caster_id. No time limit: the mark waits for the target's next draw.
--   * _land_drawn_instance, shared by all four draw RPCs (in-app, manual,
--     Test-room puppet, legacy immediate), fires the target's oldest live
--     `next_draw` mark once its cast round has resolved: the drawn card lands
--     with the beneficiary -- 'held', or 'pending_swap' for a keep-or-swap
--     choice if they already hold one -- and the mark is spent
--     (cast_inputs.consumed_by_draw + draw_redirect_outcome). A beneficiary
--     whose hand is full (held + pending_swap) makes the redirect fizzle: the
--     mark is spent and the target keeps the card.
--   * One crit can fire a Marked for Brew mark and then a Stale Biscuit mark:
--     the crit's draw goes to the Marked for Brew beneficiary, whose own draw
--     then lands with their Stale Biscuit beneficiary.
--   * Countered: the negated source cast leaves no live mark.
--   * The Resolution Trace's `marked` step covers the cast round; each
--     draw_redirect step now carries `redirect_trigger`.
-- The function bodies are canonical in db/sql/functions/ and ship in the
-- generated migration that follows this one (ADR 0006).
--
-- This migration: the card's effect row and its un-bench.

-- ---------------------------------------------------------------------------
-- 1. Stale Biscuit's effect row.
-- ---------------------------------------------------------------------------
insert into public.spell_card_effects (card_id, target_role, effect_kind, effect_params, ordinal)
select sc.id, 'TARGET', 'draw_redirect',
       '{"trigger": "next_draw", "persist": true}'::jsonb,
       0
  from public.spell_cards sc
 where sc.name = 'Stale Biscuit'
   and not exists (
     select 1 from public.spell_card_effects sce where sce.card_id = sc.id
   );

-- ---------------------------------------------------------------------------
-- 2. Un-bench Stale Biscuit. Guarded on location so this is a no-op where
--    0074 never ran; never touches an instance a player currently holds.
-- ---------------------------------------------------------------------------
update public.spell_deck_instances sdi
   set location = 'in_deck', held_by_player = null
  from public.spell_cards sc
 where sc.id = sdi.card_id
   and sc.name = 'Stale Biscuit'
   and sdi.location = 'benched';
