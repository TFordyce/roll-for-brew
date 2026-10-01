-- Tea Cosy (issue #434, spec #401).
--
-- Tea Cosy (Rare, SELF, Action): "You are exempt from rolling this round. You
-- cannot be the tea-maker."
--
-- Model: two primitives that already exist, on one effect row.
--   * Brewer Immunity (#428): CASTER / brewer_immunity, mode `tea_cosy`. The
--     card's duration_rounds = 1, so record_active_effect_if_persistent
--     promotes a rounds_remaining = 1 row -- live in the cast round only
--     (_rr_active_effects_as_of). No `persist`, no `undispellable` and no
--     `override_proof`: a dispel can end it, and an override naming the
--     caster falls through like any immunity.
--   * Roll Exemption (#433): `exempt_from_rolling: true` on the same row, so
--     the cast carries it and _rr_roll_exemptions exempts the caster.
-- Countered, both halves go together: the negated source cast makes the
-- immunity row not live, and the caster rolls late once the layer-0 Reaction
-- Window closes. A Round replay's clean slate deletes the cast and, with it,
-- the promoted row. A dispel (Greater Detox) ends the immunity row only: the
-- exemption rides on the cast, so the caster still doesn't roll but can be
-- named by a `chosen` override. Every participant on Tea Cosy: no layer-0 roll is
-- expected, the round resolves at close, and immunity gives way to a
-- Tie-Break Reroll among them all (_rr_select_tea_maker).
--
-- No function body changes: the generated migration that follows this one
-- (ADR 0006) re-emits _rr_is_brewer_candidate for its header comment only.

-- ---------------------------------------------------------------------------
-- 1. One round of immunity.
-- ---------------------------------------------------------------------------
update public.spell_cards
   set duration_rounds = 1
 where name = 'Tea Cosy';

-- ---------------------------------------------------------------------------
-- 2. Tea Cosy's effect row.
-- ---------------------------------------------------------------------------
insert into public.spell_card_effects (card_id, target_role, effect_kind, effect_params, ordinal)
select sc.id, 'CASTER', 'brewer_immunity',
       '{"mode": "tea_cosy", "exempt_from_rolling": true}'::jsonb,
       0
  from public.spell_cards sc
 where sc.name = 'Tea Cosy'
   and not exists (
     select 1 from public.spell_card_effects sce where sce.card_id = sc.id
   );

-- ---------------------------------------------------------------------------
-- 3. Un-bench Tea Cosy. Guarded on location so this is a no-op where 0074
--    never ran; never touches an instance a player currently holds.
-- ---------------------------------------------------------------------------
update public.spell_deck_instances sdi
   set location = 'in_deck', held_by_player = null
  from public.spell_cards sc
 where sc.id = sdi.card_id
   and sc.name = 'Tea Cosy'
   and sdi.location = 'benched';
