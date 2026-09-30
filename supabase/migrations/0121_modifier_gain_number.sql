-- Issue #425 (spec #401 F1): the tea_maker_override mode is a closed set.
--
-- Enforced on both the catalog (spell_card_effects) and the Cast Log
-- (spell_casts), so an unknown or missing mode is rejected on write:
--   highest_modifier | highest_roll | chosen | prev_round_highest | conditional_chosen
-- prev_round_highest (Last Drip) and conditional_chosen (PG Tipped) are
-- reserved for their card slices; until then the resolver leaves them out of
-- the override contest.
--
-- The rest of #425 -- the modifier gain number through _rr_resolve_eval,
-- finalize_layer and the resolve_round(uuid, text, integer, integer) write --
-- is function-only and lives in db/sql/functions/ (generated migration 0122).

alter table public.spell_card_effects
  add constraint spell_card_effects_tea_maker_override_mode_check
  check (
    effect_kind <> 'tea_maker_override'
    or coalesce(effect_params ->> 'mode', '') in (
      'highest_modifier', 'highest_roll', 'chosen', 'prev_round_highest', 'conditional_chosen')
  );

alter table public.spell_casts
  add constraint spell_casts_tea_maker_override_mode_check
  check (
    effect_kind is distinct from 'tea_maker_override'
    or coalesce(effect_params ->> 'mode', '') in (
      'highest_modifier', 'highest_roll', 'chosen', 'prev_round_highest', 'conditional_chosen')
  );
