-- Brew IOU (issue #432, spec #401, design #382).
--
-- Brew IOU (Rare, OPPONENT, Action): "Choose a target to make tea this round;
-- you make it next round, no roll required."
--
-- Model (ADR 0005 precedence ladder; Brew Debt note beside it):
--   * This round: a plain `chosen` tea_maker_override at tier 2. Its catalog
--     row carries `creates_brew_debt: true`, which is what marks the
--     override as Brew IOU to the resolver.
--   * The debt: when that override actually names the Tea Maker, the
--     resolution commit records it on the round -- rounds.brewer_source =
--     'brew_iou', brewer_source_cast_id = the cast. No debt if the cast was
--     countered, out-ranked, fell through on an immune target, or the named
--     target went into a Loose Leaf roll-off.
--   * Debt liveness is derived (_brew_debt_due): a `brew_iou` round exists
--     for the cast and no `brew_debt` round does, searched across all of the
--     Debtor's rooms, oldest first. The first state that carries across
--     rooms and days.
--   * The debt round: the Debtor's next round as a Participant. Nobody
--     rolls; it resolves at close with the Debtor as Tea Maker and records
--     ('brew_debt', cast) on that round. An immune Debtor plays normally and
--     still owes.
--   * Replay-safe with no special case: scrapping the paying round clears its
--     brewer_source (the debt is owed again); scrapping the Brew IOU round
--     deletes the cast (SET NULL here) and clears its brewer_source, so the
--     debt never existed. Deleting a round does the same.
-- The function bodies are canonical in db/sql/functions/ and ship in the
-- generated migration that follows this one (ADR 0006).
--
-- This migration: the two rounds columns, the card's effect row and its
-- un-bench.

-- ---------------------------------------------------------------------------
-- 1. rounds.brewer_source / brewer_source_cast_id -- what made the Tea Maker
--    brew, when it is something a later round reads back. Written by
--    finalize_layer's commit; null for every other resolution.
-- ---------------------------------------------------------------------------
alter table public.rounds
  add column brewer_source text
    check (brewer_source in ('brew_iou', 'brew_debt')),
  add column brewer_source_cast_id uuid
    references public.spell_casts(id) on delete set null;

comment on column public.rounds.brewer_source is
  'Issue #432 (spec #401): what made the Tea Maker brew, when a later round '
  'reads it back. ''brew_iou'' -- a Brew IOU override picked the Tea Maker, '
  'so its caster owes a Brew Debt; ''brew_debt'' -- this round paid that '
  'debt. Null otherwise. Written by finalize_layer; cleared by '
  '_rr_scrap_round.';

comment on column public.rounds.brewer_source_cast_id is
  'Issue #432: the Brew IOU cast behind brewer_source (the same cast on both '
  'the Brew IOU round and the round that pays it). SET NULL when the cast is '
  'deleted (a Round replay scrap of the Brew IOU round).';

create index rounds_brewer_source_cast_id_idx
  on public.rounds (brewer_source_cast_id)
  where brewer_source is not null;

-- ---------------------------------------------------------------------------
-- 2. Brew IOU's effect row: a plain `chosen` override on the target, normal
--    modifier gain (no `modifier_gain`), flagged as creating a Brew Debt.
-- ---------------------------------------------------------------------------
insert into public.spell_card_effects (card_id, target_role, effect_kind, effect_params, ordinal)
select sc.id, 'TARGET', 'tea_maker_override',
       '{"mode": "chosen", "creates_brew_debt": true}'::jsonb,
       0
  from public.spell_cards sc
 where sc.name = 'Brew IOU'
   and not exists (
     select 1 from public.spell_card_effects sce where sce.card_id = sc.id
   );

-- ---------------------------------------------------------------------------
-- 3. Un-bench Brew IOU. Guarded on location so this is a no-op where 0074
--    never ran; never touches an instance a player currently holds.
-- ---------------------------------------------------------------------------
update public.spell_deck_instances sdi
   set location = 'in_deck', held_by_player = null
  from public.spell_cards sc
 where sc.id = sdi.card_id
   and sc.name = 'Brew IOU'
   and sdi.location = 'benched';
