-- Brewer immunity + The Last Cuppa (issue #428, spec #401 F2, design #381).
--
-- The Last Cuppa (Epic, SELF, Action): "You cannot be the tea-maker for the
-- rest of the day under any circumstance. No card, force, mark, or curse can
-- override this."
--
-- Model (ADR 0005 precedence ladder, tier 0):
--   * One active-effect kind, `brewer_immunity`, discriminated by
--     effect_params.mode in ('tea_cosy', 'last_cuppa', 'earl'). This slice
--     ships `last_cuppa`; Tea Cosy and Earl of Earl Grey reuse the kind.
--   * The Last Cuppa's effect row is CASTER / brewer_immunity
--     {mode: 'last_cuppa', persist: true, undispellable: true,
--      override_proof: true}. The generic cast loop records one Cast Log row
--     and record_active_effect_if_persistent promotes it to an unbounded
--     projection row (the #320 `persist` pattern) -- rooms are daily, so
--     unbounded is "the rest of the day".
--   * Phase 5 of the resolver reads the immunity directly (not through the
--     Phase 2 ward filter) and skips an immune player at every tier: a
--     declared-number match, an override target and the lowest-roller pool.
--     Everyone immune and no override: immunity gives way and the round ties
--     across all participants (a Tie-Break Reroll).
--   * Dispel-resistance is a separate property of the row: the new
--     spell_active_effects.is_undispellable flag, which every dispel path
--     skips.
-- The function bodies are canonical in db/sql/functions/ and ship in the
-- generated migration that follows this one (ADR 0006).
--
-- This migration: the effect_kind CHECK widening, the is_undispellable
-- column, The Last Cuppa's effect row and its un-bench.

-- ---------------------------------------------------------------------------
-- 1. effect_kind CHECK constraints -- add `brewer_immunity` to all three.
--    Must run BEFORE the effect-row insert in section 3. Lists carried
--    forward from 0119 (spell_card_effects / spell_casts) and 0100
--    (spell_active_effects).
-- ---------------------------------------------------------------------------
alter table public.spell_card_effects drop constraint spell_card_effects_effect_kind_check;
alter table public.spell_card_effects add constraint spell_card_effects_effect_kind_check
  check (effect_kind in (
    'flat_modifier', 'dice_modifier', 'modifier_multiplier', 'set_modifier',
    'advantage', 'disadvantage', 'dispel',
    'forced_reroll', 'contested_negate', 'redirect',
    'reset_persistent_modifier',
    'roll_swap', 'roll_flip', 'fixed_roll', 'roll_pair_transform', 'lowest_gains_highest_modifier',
    'tea_maker_override', 'declared_number_tea_maker', 'wild_dispatch',
    'ward', 'persistent_modifier_transfer', 'persistent_modifier_spend',
    'round_replay', 'draw_redirect', 'targeting_skip', 'per_round_dice_tick',
    'card_heist', 'compel_cast', 'brewer_immunity'
  ));

alter table public.spell_casts drop constraint spell_casts_effect_kind_check;
alter table public.spell_casts add constraint spell_casts_effect_kind_check
  check (effect_kind is null or effect_kind in (
    'flat_modifier', 'dice_modifier', 'modifier_multiplier', 'set_modifier',
    'advantage', 'disadvantage', 'dispel',
    'forced_reroll', 'contested_negate', 'redirect',
    'reset_persistent_modifier',
    'roll_swap', 'roll_flip', 'fixed_roll', 'roll_pair_transform', 'lowest_gains_highest_modifier',
    'tea_maker_override', 'declared_number_tea_maker', 'wild_dispatch',
    'ward', 'persistent_modifier_transfer', 'persistent_modifier_spend',
    'round_replay', 'draw_redirect', 'targeting_skip', 'per_round_dice_tick',
    'card_heist', 'compel_cast', 'forfeit', 'brewer_immunity'
  ));

alter table public.spell_active_effects drop constraint spell_active_effects_effect_kind_check;
alter table public.spell_active_effects add constraint spell_active_effects_effect_kind_check
  check (effect_kind in (
    'flat_modifier', 'dice_modifier', 'modifier_multiplier', 'set_modifier',
    'declared_number_tea_maker',
    'advantage', 'disadvantage',
    'ward', 'persistent_modifier_transfer', 'persistent_modifier_spend',
    'round_replay', 'draw_redirect', 'targeting_skip', 'per_round_dice_tick',
    'brewer_immunity'
  ));

-- ---------------------------------------------------------------------------
-- 2. spell_active_effects.is_undispellable. Set at promotion from the effect
--    row's `undispellable` marker (record_active_effect_if_persistent). No
--    existing active effect was immune to dispel, so every current row is
--    false.
-- ---------------------------------------------------------------------------
alter table public.spell_active_effects
  add column is_undispellable boolean not null default false;

comment on column public.spell_active_effects.is_undispellable is
  'Issue #428 (spec #401 F2): no dispel can end this effect. Every dispel path '
  'skips it: get_dispellable_active_effects never offers it, end_active_effect '
  'refuses it, a compelled Detox does not count it as a legal target, and '
  '_rr_active_effects_as_of ignores any dispel cast naming it. Set from the '
  'effect row''s `undispellable` marker; The Last Cuppa is the only user.';

-- ---------------------------------------------------------------------------
-- 3. The Last Cuppa's effect row. duration_rounds stays NULL ("rest of the
--    day" = unbounded); the `persist` marker is what promotes it.
--    `override_proof` is the "no card, force, mark, or curse" half of the
--    card: an override naming the holder never gets past it (an Earl, whose
--    immunity is not override-proof, will transfer the title instead).
-- ---------------------------------------------------------------------------
insert into public.spell_card_effects (card_id, target_role, effect_kind, effect_params)
values (
  (select id from public.spell_cards where name = 'The Last Cuppa'),
  'CASTER', 'brewer_immunity',
  '{"mode": "last_cuppa", "persist": true, "undispellable": true, "override_proof": true}'::jsonb
);

-- ---------------------------------------------------------------------------
-- 4. Un-bench The Last Cuppa. Guarded on location so this is a no-op where
--    0074 never ran; never touches an instance a player currently holds.
-- ---------------------------------------------------------------------------
update public.spell_deck_instances sdi
   set location = 'in_deck', held_by_player = null
  from public.spell_cards sc
 where sc.id = sdi.card_id
   and sc.name = 'The Last Cuppa'
   and sdi.location = 'benched';
