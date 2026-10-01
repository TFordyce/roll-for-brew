-- Marked for Brew (issue #436, spec #401, design #383).
--
-- Marked for Brew (Rare, OPPONENT, Action): "Mark a target. Within the next 5
-- rounds they take part in, the first time they roll a nat 1 or nat 20, you
-- draw the card instead."
--
-- Model: a Draw Redirect mark.
--   * The cast's one effect row, TARGET / draw_redirect
--     `{trigger: next_crit, persist: true, participated_rounds_after_cast: 5}`,
--     is promoted to an unbounded spell_active_effects row on the target
--     (record_active_effect_if_persistent: `persist`). The beneficiary is the
--     row's caster_id. A deferred target is projected once it is set, as for
--     any OPPONENT card.
--   * The 5-round window is participated rounds, not room rounds:
--     _rr_active_effects_as_of keeps the mark live while the target has taken
--     part in fewer than 5 resolved rounds after the cast round. Rooms are
--     daily, so a mark dies with its day.
--   * _apply_crit_redirect, at all three crit entry points, hands the
--     target's crit draw to the oldest live mark's beneficiary (never in the
--     cast round itself) and spends the mark: cast_inputs.consumed_by_round
--     plus draw_redirect_outcome. A beneficiary who already has a pending
--     draw that round makes the redirect fizzle -- the mark is still spent,
--     and the target keeps their own draw.
--   * Countered: the negated source cast leaves no live mark. A Round replay
--     does not restore a spent mark (_rr_scrap_round).
--   * The Resolution Trace gets a `draw_redirect` step: `marked` in the cast
--     round, `redirected` / `fizzled` in the round it fires.
-- The function bodies are canonical in db/sql/functions/ and ship in the
-- generated migration that follows this one (ADR 0006).
--
-- This migration: the card's effect row and its un-bench.

-- ---------------------------------------------------------------------------
-- 1. Marked for Brew's effect row.
-- ---------------------------------------------------------------------------
insert into public.spell_card_effects (card_id, target_role, effect_kind, effect_params, ordinal)
select sc.id, 'TARGET', 'draw_redirect',
       '{"trigger": "next_crit", "persist": true, "participated_rounds_after_cast": 5}'::jsonb,
       0
  from public.spell_cards sc
 where sc.name = 'Marked for Brew'
   and not exists (
     select 1 from public.spell_card_effects sce where sce.card_id = sc.id
   );

-- ---------------------------------------------------------------------------
-- 2. Un-bench Marked for Brew. Guarded on location so this is a no-op where
--    0074 never ran; never touches an instance a player currently holds.
-- ---------------------------------------------------------------------------
update public.spell_deck_instances sdi
   set location = 'in_deck', held_by_player = null
  from public.spell_cards sc
 where sc.id = sdi.card_id
   and sc.name = 'Marked for Brew'
   and sdi.location = 'benched';
