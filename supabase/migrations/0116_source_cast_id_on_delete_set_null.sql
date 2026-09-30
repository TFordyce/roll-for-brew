-- Issue #441: admin_delete_round fails (23503) on a drain's origin round.
--
-- spell_casts.source_cast_id (0085) was added with no ON DELETE action as a
-- same-round sibling link for a two-sided persistent_modifier_transfer. The
-- Bitter Leech and Calami-Tea per-round tick synthesis in resolve_round later
-- started writing it across rounds: a tick row in round N points at the origin
-- cast in an earlier round. Deleting the origin round cascades to its
-- spell_casts, that cascade is blocked by the later rounds' tick rows, and
-- admin_delete_round raises 23503.
--
-- Decision (#441 triage): ON DELETE SET NULL. Deleting a round undoes it going
-- forward and never rewrites rounds that were not deleted -- the same shape as
-- spell_active_effects.source_cast_id (0084, ON DELETE CASCADE):
--   * the drain's spell_active_effects row cascades away with its origin cast,
--     so the drain stops ticking;
--   * tick rows already written in later, undeleted rounds stay and stay
--     applied (the modifier log keeps them), with source_cast_id now null.
-- The resolver's source_cast_id readers are safe with null: tick synthesis is
-- driven off live active effects (gone with the origin), and the per-round
-- de-dup / ward re-negation lookups key on a live effect's cast id, which a
-- null row never matches. negated is never reset on re-resolve, so an orphaned
-- tick keeps whatever negation it already had.
--
-- Refusing the delete (new RFB code) and ON DELETE CASCADE (which would erase
-- tick rows from undeleted rounds) were considered and rejected.

alter table public.spell_casts
  drop constraint if exists spell_casts_source_cast_id_fkey;

alter table public.spell_casts
  add constraint spell_casts_source_cast_id_fkey
  foreign key (source_cast_id) references public.spell_casts (id) on delete set null;

comment on column public.spell_casts.source_cast_id is
  'Provenance link to another spell_casts row. Two uses: (1) sibling link for '
  'a two-sided persistent_modifier_transfer (spec §9) -- the target-side row '
  'points at the caster-side row in the same round; (2) a synthesised '
  'per-round tick (Bitter Leech bitter_leech_tick, Calami-Tea dice_tick) '
  'points at its origin cast, possibly in an earlier round. ON DELETE SET NULL '
  '(issue #441): deleting the origin round leaves later rounds'' tick rows in '
  'place, still applied, with this column null. Whole-cast negation keys off '
  'card_instance_id, not this column.';
