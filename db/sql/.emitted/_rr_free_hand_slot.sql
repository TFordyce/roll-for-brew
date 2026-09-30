-- _rr_free_hand_slot(p_player_id text) -> text
--
-- The hand cap (migration 0018: one `held` and one `pending_swap` instance per
-- player) as one question: where would a card handed to this player land?
-- `held` if their hand is empty, `pending_swap` (a keep-or-swap choice) if
-- they already hold one, null if both slots are taken. Used by Tea Heist
-- (issue #438) -- the move to the thief (_rr_heist_outcomes /
-- _rr_apply_heists) and the replay return to the victim (_rr_scrap_round).
--
-- Canonical source: this file is the source of truth for the function body.
-- Edit here and run `npm run build:migrations` -- do not hand-edit the
-- generated migration. See db/sql/README.md.

create or replace function public._rr_free_hand_slot(p_player_id text)
returns text
language sql
stable
security definer
set search_path = public
as $$
  select case
    when not exists (
      select 1 from public.spell_deck_instances
       where held_by_player = p_player_id and location = 'held'
    ) then 'held'
    when not exists (
      select 1 from public.spell_deck_instances
       where held_by_player = p_player_id and location = 'pending_swap'
    ) then 'pending_swap'
  end;
$$;

revoke execute on function public._rr_free_hand_slot(text) from public, anon, authenticated;

comment on function public._rr_free_hand_slot(text) is
  'Issue #438: where a card handed to this player lands under the 0018 hand cap -- held (empty hand), pending_swap (already holding one), or null (both slots taken). Internal.';
