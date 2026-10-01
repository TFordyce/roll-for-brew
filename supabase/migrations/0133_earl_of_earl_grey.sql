-- Earl of Earl Grey (issue #429, spec #401, design #381).
--
-- Earl of Earl Grey (Epic, SELF, Action): "Take the title of Earl. While
-- Earl, you cannot be tea-maker -- the next-lowest roller makes tea instead.
-- If a card would force tea on you, pass the title to its caster: they become
-- Earl, you lose immunity."
--
-- Model (ADR 0005 precedence ladder, tier 0; builds on #428):
--   * The title is a `brewer_immunity` active effect, mode `earl`, unbounded
--     via the `persist` marker. Dispellable, and not override-proof.
--   * One Earl per room, a read-time rule rather than a constraint:
--     _rr_active_effects_as_of treats only the newest live title
--     row in the room as live, so a new Earl displaces the old one from the
--     round it is cast in; finalize_layer then ends the displaced row
--     (ended_in_round_id) when the round really resolves, so a later dispel of
--     the new Earl can't hand the title back.
--   * Phase 5: an override naming the Earl passes the title to the override's
--     caster first, then lands on the ex-Earl, who brews. The resolver only
--     decides and traces the transfer (an `earl_transfer` step); like a Tea
--     Heist (ADR 0005 #383 amendment) finalize_layer's commit step writes it,
--     so the Provisional Recap's dry run (ADR 0007) never moves the title.
--   * A Round replay scrap un-ends whatever the scrapped attempt ended; the
--     new holder's row goes with the override cast it hangs off.
-- The function bodies are canonical in db/sql/functions/ and ship in the
-- generated migration that follows this one (ADR 0006).
--
-- This migration: the ended_in_round_id column, the card's effect row and its
-- un-bench.

-- ---------------------------------------------------------------------------
-- 1. spell_active_effects.ended_in_round_id -- the round an effect was ended
--    in when it is ended by something other than a dispel cast. The row is not
--    live as of that round or any later one (_rr_active_effects_as_of). Today
--    only an Earl title superseded by a newer Earl writes it. SET NULL on
--    round delete: deleting the round un-happens the ending, as it does the
--    casts made in it.
-- ---------------------------------------------------------------------------
alter table public.spell_active_effects
  add column ended_in_round_id uuid references public.rounds(id) on delete set null;

comment on column public.spell_active_effects.ended_in_round_id is
  'Issue #429 (spec #401): the round this effect was ended in, when ended by '
  'something other than a dispel cast -- an Earl of Earl Grey title displaced '
  'by a newer Earl (cast, or passed on by a force). Not live as of that round '
  'or later (_rr_active_effects_as_of). Written by finalize_layer''s commit '
  'step (_rr_apply_earl_title); cleared by _rr_scrap_round for the scrapped '
  'round.';

create index spell_active_effects_ended_in_round_id_idx
  on public.spell_active_effects (ended_in_round_id)
  where ended_in_round_id is not null;

-- ---------------------------------------------------------------------------
-- 2. Earl of Earl Grey's effect row. duration_rounds stays NULL; the
--    `persist` marker promotes it unbounded (#320 / #428 pattern). No
--    `undispellable`, no `override_proof`: a Detox can end the title, and a
--    force transfers it instead of bouncing off.
-- ---------------------------------------------------------------------------
insert into public.spell_card_effects (card_id, target_role, effect_kind, effect_params)
values (
  (select id from public.spell_cards where name = 'Earl of Earl Grey'),
  'CASTER', 'brewer_immunity',
  '{"mode": "earl", "persist": true}'::jsonb
);

-- ---------------------------------------------------------------------------
-- 3. Un-bench Earl of Earl Grey. Guarded on location so this is a no-op where
--    0074 never ran; never touches an instance a player currently holds.
-- ---------------------------------------------------------------------------
update public.spell_deck_instances sdi
   set location = 'in_deck', held_by_player = null
  from public.spell_cards sc
 where sc.id = sdi.card_id
   and sc.name = 'Earl of Earl Grey'
   and sdi.location = 'benched';
