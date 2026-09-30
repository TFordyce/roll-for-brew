-- PG Tipped (issue #427, spec #401 / wayfinder map #379, design #380).
--
-- PG Tipped (Rare, OPPONENT, Action): "Choose a target. If they roll lower
-- than you this round, they make tea regardless of anyone else. Target gains
-- no modifier from this round."
--
-- Model: a tea_maker_override in mode `conditional_chosen`, condition
-- `target_below_caster`, modifier_gain 0. The target is picked at cast with
-- the existing opponent picker, so cast_spell_card's generic effect-row path
-- records it -- no by-name branch. The resolver's Phase 5 compares the
-- target's and caster's layer-0 rolls (after the roll-input shim): target
-- lower -> the target brews with no modifier gain; otherwise a "condition not
-- met" no-op Trace step and the cast never enters the last-cast-wins contest.
-- That behaviour lives in db/sql/functions/_rr_resolve_eval.sql (generated
-- migration that follows this one, ADR 0006).
--
-- Wording (spec #401 Further Notes): the gain is suppressed only when PG
-- Tipped itself forces the brew (the #380 reading), not when the target
-- brews for some other reason.
--
-- This migration: the catalog effect row and the un-bench.

insert into public.spell_card_effects (card_id, target_role, effect_kind, effect_params, ordinal)
select sc.id, 'TARGET', 'tea_maker_override',
       '{"mode": "conditional_chosen", "condition": "target_below_caster", "modifier_gain": 0}'::jsonb,
       0
  from public.spell_cards sc
 where sc.name = 'PG Tipped'
   and not exists (
     select 1 from public.spell_card_effects sce where sce.card_id = sc.id
   );

-- Un-bench PG Tipped. Guarded on location so this is a no-op where 0074 never
-- ran; never touches an instance a player currently holds.
update public.spell_deck_instances sdi
   set location = 'in_deck', held_by_player = null
  from public.spell_cards sc
 where sc.id = sdi.card_id
   and sc.name = 'PG Tipped'
   and sdi.location = 'benched';
