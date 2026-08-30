-- Cast Log schema expand (issue #304, first slice of the effect-application
-- rebuild #302 / ADR 0005). Pure additive expansion: adds the columns and
-- widens the CHECK constraints that the rest of the rebuild (#305-#321) writes
-- against, with nothing yet reading the new shape. Every existing test stays
-- green; no RPC or TS path reads the new columns.
--
-- Numbered 0077: it is the first migration on the shared integration branch
-- `rebuild/effect-resolver` (#303), sitting directly after master's current
-- highest (0076). Later rebuild slices number upward from here; the integrator
-- renumbers the whole branch past master's highest at the integrate step.
--
-- Deliberately NOT in this migration -- these belong to the contract slice
-- (#312), which carries the only behaviour-relevant diff of the rebuild:
--   * no backfill of spell_casts.resolved_value into cast_inputs
--   * resolved_value is NOT dropped
--   * the three dead effect kinds (hidden_modifier, persistent_modifier_delta,
--     persistent_modifier_swap) are NOT retired

-- ---------------------------------------------------------------------------
-- 1. Cast Log columns on spell_casts (spec §4 -- three zones)
-- ---------------------------------------------------------------------------

-- Recorded-inputs zone: server-RNG draws and unreconstructable human choices
-- (die roll, contest d20, WILD branch pick, deferred target, persistent-
-- modifier snapshots). Written by the cast / player-choice RPCs; read by
-- resolve_round. Nullable with no default -- a cast that has recorded nothing
-- leaves it NULL rather than '{}', keeping "never recorded anything"
-- distinguishable (the pending-spell-die sentinel #305 relies on this).
alter table public.spell_casts add column if not exists cast_inputs jsonb;

-- Resolver-output cache zone: materialized derivations that must always agree
-- with a fresh replay. Written by resolve_round only. Each points at the
-- spell_casts row that acted on this cast (redirect / Brew-merang seize /
-- Saucerer's Apprentice copy).
alter table public.spell_casts
  add column if not exists redirected_to_cast_id uuid references public.spell_casts (id);
alter table public.spell_casts
  add column if not exists seized_by_cast_id uuid references public.spell_casts (id);
alter table public.spell_casts
  add column if not exists copied_cast_id uuid references public.spell_casts (id);

-- ---------------------------------------------------------------------------
-- 2. Replay generation counters (spec §11 -- Round Replay / Time for Brew)
-- ---------------------------------------------------------------------------

-- rounds.replay_generation: 0 = original resolution, 1 = post-scrap replay.
-- {rolls, spell_casts, spell_reaction_windows}.generation: which generation the
-- row belongs to. Pass-1 rows are retained at generation 0 -- nothing is
-- destroyed on replay. Uniqueness / PK changes that let generation 1 rows
-- coexist with generation 0 land with the replay slice (#315), not here.
alter table public.rounds
  add column if not exists replay_generation integer not null default 0;
alter table public.rolls
  add column if not exists generation integer not null default 0;
alter table public.spell_casts
  add column if not exists generation integer not null default 0;
alter table public.spell_reaction_windows
  add column if not exists generation integer not null default 0;

-- ---------------------------------------------------------------------------
-- 3. Widen the three effect_kind CHECK constraints (spec §16 -- new kinds)
-- ---------------------------------------------------------------------------

-- New kinds the rebuild introduces:
--   ward                          -- immunity layer (spec §7)
--   persistent_modifier_transfer  -- signed rest-of-day transfer, paired rows
--   persistent_modifier_spend     -- one-way self-burn (Tea-tally Spent)
--   round_replay                  -- Time for Brew (spec §11)
--   draw_redirect                 -- #298 Group B mark; declared here for the
--                                    shared CHECK migration, used later
-- The retired kinds (hidden_modifier, persistent_modifier_delta,
-- persistent_modifier_swap) stay in every list -- #312 removes them.

alter table public.spell_card_effects drop constraint if exists spell_card_effects_effect_kind_check;
alter table public.spell_card_effects add constraint spell_card_effects_effect_kind_check
  check (effect_kind in (
    'flat_modifier', 'dice_modifier', 'modifier_multiplier', 'set_modifier',
    'advantage', 'disadvantage', 'hidden_modifier', 'dispel',
    'forced_reroll', 'contested_negate', 'redirect',
    'reset_persistent_modifier', 'persistent_modifier_delta', 'persistent_modifier_swap',
    'roll_swap', 'roll_flip', 'lowest_gains_highest_modifier',
    'tea_maker_override', 'declared_number_tea_maker', 'wild_dispatch',
    'ward', 'persistent_modifier_transfer', 'persistent_modifier_spend',
    'round_replay', 'draw_redirect'
  ));

alter table public.spell_casts drop constraint if exists spell_casts_effect_kind_check;
alter table public.spell_casts add constraint spell_casts_effect_kind_check
  check (effect_kind is null or effect_kind in (
    'flat_modifier', 'dice_modifier', 'modifier_multiplier', 'set_modifier',
    'advantage', 'disadvantage', 'hidden_modifier', 'dispel',
    'forced_reroll', 'contested_negate', 'redirect',
    'reset_persistent_modifier', 'persistent_modifier_delta', 'persistent_modifier_swap',
    'roll_swap', 'roll_flip', 'lowest_gains_highest_modifier',
    'tea_maker_override', 'declared_number_tea_maker', 'wild_dispatch',
    'ward', 'persistent_modifier_transfer', 'persistent_modifier_spend',
    'round_replay', 'draw_redirect'
  ));

-- spell_active_effects additionally gains advantage / disadvantage (Tier A
-- primitive 4, Prophe-Tea -- persistent advantage as an active effect).
alter table public.spell_active_effects drop constraint if exists spell_active_effects_effect_kind_check;
alter table public.spell_active_effects add constraint spell_active_effects_effect_kind_check
  check (effect_kind in (
    'flat_modifier', 'dice_modifier', 'modifier_multiplier', 'set_modifier', 'hidden_modifier',
    'declared_number_tea_maker',
    'advantage', 'disadvantage',
    'ward', 'persistent_modifier_transfer', 'persistent_modifier_spend',
    'round_replay', 'draw_redirect'
  ));
