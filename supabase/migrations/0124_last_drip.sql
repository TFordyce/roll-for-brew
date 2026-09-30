-- Last Drip (issue #426, spec #401, design #380).
--
-- Last Drip (Common, TABLE, Action): "Force the winner of the previous round
-- to make tea instead. They gain no modifier from this tea-making."
--
-- Model: a table-wide tea_maker_override with mode `prev_round_highest`
-- (reserved by #425) and modifier_gain 0, at tier 2 of the precedence ladder
-- (ADR 0005). It's a catalog effect row -- the same shape as Drip Tray and
-- Topsy-Tea -- so cast_spell_card's generic loop records it with no by-name
-- branch, and Genie in the Teapot can invoke it. The target is picked at
-- resolve, by _rr_resolve_eval's Phase 5: the room's most recent resolved
-- round -> its highest layer-0 roll (ties: lowest modifier_snapshot, then
-- lowest player_id). Inert, with a no-op Trace step and a reason, when there's
-- no previous resolved round or that player isn't a Participant this round.
-- That body is canonical in db/sql/functions/ and ships in the generated
-- migration that follows this one (ADR 0006).
--
-- This migration: the catalog effect row and the un-bench.

insert into public.spell_card_effects (card_id, target_role, effect_kind, effect_params)
select sc.id, 'TABLE', 'tea_maker_override', '{"mode": "prev_round_highest", "modifier_gain": 0}'::jsonb
  from public.spell_cards sc
 where sc.name = 'Last Drip'
   and not exists (
     select 1 from public.spell_card_effects e where e.card_id = sc.id
   );

-- Un-bench Last Drip. Guarded on location so this is a no-op where 0074 never
-- ran; never touches an instance a player currently holds.
update public.spell_deck_instances sdi
   set location = 'in_deck', held_by_player = null
  from public.spell_cards sc
 where sc.id = sdi.card_id
   and sc.name = 'Last Drip'
   and sdi.location = 'benched';
