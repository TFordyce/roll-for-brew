-- Widens spell_draws read access from "the drawing player only" to any
-- authenticated player, excluding test players' draws — so the Collection
-- feature (#130) can show any player's full draw history. No change to
-- spell_cards (already broadly readable) or spell_deck_instances
-- (current-holder state stays private — out of scope, see #132).

-- spell_draws has never had a table-level grant for authenticated (only
-- read through RPCs / the drawing player's own rows so far); site-wide
-- reads need the Data API role to be able to touch the table at all,
-- same pattern as the grants in 0015.
grant select on public.spell_draws to authenticated;

drop policy if exists "spell_draws are readable by the drawing player" on public.spell_draws;

create policy "spell_draws are readable site-wide excluding test players"
  on public.spell_draws for select
  to authenticated
  using (
    exists (
      select 1 from public.players p
      where p.id = spell_draws.player_id and not p.is_test
    )
  );
