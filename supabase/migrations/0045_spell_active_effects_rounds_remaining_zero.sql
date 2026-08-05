-- Fix #144: resolve_round's decrement-then-delete flow writes
-- rounds_remaining = 0 for any effect expiring on the round being resolved,
-- which spell_active_effects_rounds_remaining_check (`> 0`) rejects --
-- failing the whole resolution transaction instead of quietly expiring the
-- effect on its final round.
--
-- Widen the constraint to `>= 0` so the transient "about to expire" value
-- is allowed to be written; resolve_round's very next statement deletes any
-- row that reached rounds_remaining <= 0 before the transaction commits, so
-- no row is ever observably left at 0. Negative values remain rejected, so
-- no caller can under-decrement past expiry.
alter table public.spell_active_effects drop constraint spell_active_effects_rounds_remaining_check;
alter table public.spell_active_effects add constraint spell_active_effects_rounds_remaining_check
  check (rounds_remaining >= 0);
