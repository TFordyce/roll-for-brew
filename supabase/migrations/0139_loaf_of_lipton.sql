-- Roll Exemption + Loaf of Lipton (issue #433, spec #401 F5, design #393).
--
-- Loaf of Lipton (Rare, SELF, Action): "Skip your roll this round and make
-- tea automatically. You gain double the usual modifier."
--
-- Model:
--   * Roll Exemption: the catalog effect_params flag `exempt_from_rolling:
--     true` sits on the cast; there is no active-effect row. Its caster
--     doesn't roll Layer 0 -- no die, no stand-in value. _rr_roll_exemptions
--     is the one read; get_expected_layer_roller_ids leaves the caster out,
--     so the roll gate, Layer completeness, stall and the room page follow.
--     Countered (the whole card negated, once the layer-0 Reaction Window has
--     CLOSED): the caster is an expected roller again and rolls late; there
--     is no second window. Every participant exempt: Layer 0 is complete at
--     close. A Round replay's clean slate deletes the cast, so the caster
--     rolls normally in the replay.
--   * Loaf itself: a `chosen` self-override at tier 2 of the precedence
--     ladder (last cast wins), with modifier gain 2 * cups_made -- the new
--     `modifier_gain_multiplier`, read by _rr_select_tea_maker.
-- The function bodies are canonical in db/sql/functions/ and ship in the
-- generated migration that follows this one (ADR 0006).
--
-- This migration: the card's effect row and its un-bench.

-- ---------------------------------------------------------------------------
-- 1. Loaf of Lipton's effect row.
-- ---------------------------------------------------------------------------
insert into public.spell_card_effects (card_id, target_role, effect_kind, effect_params, ordinal)
select sc.id, 'CASTER', 'tea_maker_override',
       '{"mode": "chosen", "modifier_gain_multiplier": 2, "exempt_from_rolling": true}'::jsonb,
       0
  from public.spell_cards sc
 where sc.name = 'Loaf of Lipton'
   and not exists (
     select 1 from public.spell_card_effects sce where sce.card_id = sc.id
   );

-- ---------------------------------------------------------------------------
-- 2. Un-bench Loaf of Lipton. Guarded on location so this is a no-op where
--    0074 never ran; never touches an instance a player currently holds.
-- ---------------------------------------------------------------------------
update public.spell_deck_instances sdi
   set location = 'in_deck', held_by_player = null
  from public.spell_cards sc
 where sc.id = sdi.card_id
   and sc.name = 'Loaf of Lipton'
   and sdi.location = 'benched';
