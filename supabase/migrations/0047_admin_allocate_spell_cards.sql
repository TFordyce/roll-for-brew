-- Admin spell card allocation (issue #154): lets an admin directly assign or
-- unassign a catalog card's held_by_player, reconciling the app's record of
-- who holds which physical card with what's actually in players' hands at
-- the table. The current (4th) edition deck was in physical play for about
-- a month before the app tracked per-card holding, and new players keep
-- joining mid-edition already holding a card IRL, so this needs to be a
-- reusable tool, not a one-off backfill script.
--
-- Unlike draw_spell_card_as (0034), which is hard-locked to the Test Room
-- (`is_test`) so its randomness-steering stays a safe testing exception,
-- this deliberately operates on real players/instances -- the whole point
-- is reconciling real people's real hands. It's a direct state edit, not a
-- "draw" in the gameplay sense, but it still inserts a spell_draws row (not
-- just held_by_player) using a new 'admin_allocation' trigger value, since
-- the Spell Collection page (0039) derives "discovered" purely from
-- spell_draws.draw_count -- without this, every backfilled card would
-- incorrectly show as undiscovered for players who've had it in hand for
-- weeks.
alter table public.spell_draws drop constraint spell_draws_trigger_check;
alter table public.spell_draws add constraint spell_draws_trigger_check
  check (trigger in ('nat1', 'nat20', 'admin_allocation'));

-- Backfills a missing spell_deck_instances row for any catalog card that
-- doesn't have one yet. 0018 seeded exactly one instance per card that
-- existed at the time (65), but 0037's later v2 catalog import (the 6 cards
-- taking the catalog to 71) never got a matching instances backfill --
-- those 6 cards have sat undrawable, with no physical-instance row at all,
-- ever since. The issue is explicit that this admin table lists "all 71"
-- catalog cards, so this needs fixing here rather than silently omitting
-- them from the bulk table below.
insert into public.spell_deck_instances (card_id)
select sc.id
  from public.spell_cards sc
 where not exists (
   select 1 from public.spell_deck_instances sdi where sdi.card_id = sc.id
 );

-- Every catalog card plus its current physical-instance state, for the
-- /admin/cards bulk table. Admin-only: spell_deck_instances' own RLS (0018)
-- only lets a player see their *own* held row, so an admin needs this
-- security-definer escape hatch to see who holds what across the whole
-- player base -- the same disclosure tradeoff draw_spell_card_as/
-- get_in_deck_spell_cards (0034) already made for the Test Room, just
-- site-wide instead of Test-Room-scoped.
create or replace function public.admin_get_card_assignments()
returns table (
  card_id uuid,
  name text,
  tier text,
  instance_id uuid,
  location text,
  held_by_player text,
  held_by_display_name text,
  held_by_email text
)
language plpgsql
security definer
set search_path = public
as $$
declare
  v_caller text;
  v_is_admin boolean;
begin
  v_caller := public.current_player_id();

  select is_admin into v_is_admin from public.players where id = v_caller;
  if not coalesce(v_is_admin, false) then
    raise exception 'admin_get_card_assignments: caller is not an admin';
  end if;

  return query
    select sc.id, sc.name, sc.tier, sdi.id, sdi.location, sdi.held_by_player,
           p.display_name, p.email
      from public.spell_cards sc
      join public.spell_deck_instances sdi on sdi.card_id = sc.id
      left join public.players p on p.id = sdi.held_by_player
     order by sc.tier, sc.name;
end;
$$;

revoke execute on function public.admin_get_card_assignments() from public, anon;
grant execute on function public.admin_get_card_assignments() to authenticated;

-- Assigns a catalog card to a player as "held", recording it as a
-- spell_draws row (trigger = 'admin_allocation') the same way every other
-- draw path does (0018/0034/0036), so the Spell Collection page picks it up
-- as discovered. Blocks -- rather than silently reassigning -- if the card
-- is already held/pending-swap by someone else, or the target already
-- holds/is mid-swap-decision on a different card: both are enforced today
-- via unique partial indexes on spell_deck_instances (0018), and the issue
-- is explicit that a physical/digital desync here should surface as a clear
-- error for the admin to resolve by hand (unassign first), not an
-- auto-reassignment that could paper over a real mismatch. RFB07/RFB08 are
-- new custom SQLSTATEs following the RFB01-06 convention (0013 onward) so
-- the UI can show a friendly, distinguishing message for each case instead
-- of a raw crash.
create or replace function public.admin_allocate_spell_card(p_card_id uuid, p_player_id text)
returns table (instance_id uuid)
language plpgsql
security definer
set search_path = public
as $$
declare
  v_caller text;
  v_is_admin boolean;
  v_instance_id uuid;
  v_current_location text;
  v_current_holder text;
  v_current_holder_name text;
  v_target_current_card text;
begin
  v_caller := public.current_player_id();

  select is_admin into v_is_admin from public.players where id = v_caller;
  if not coalesce(v_is_admin, false) then
    raise exception 'admin_allocate_spell_card: caller is not an admin';
  end if;

  if not exists (select 1 from public.players where id = p_player_id) then
    raise exception 'admin_allocate_spell_card: target player does not exist';
  end if;

  select sdi.id, sdi.location, sdi.held_by_player
    into v_instance_id, v_current_location, v_current_holder
    from public.spell_deck_instances sdi
   where sdi.card_id = p_card_id
     for update;

  if v_instance_id is null then
    raise exception 'admin_allocate_spell_card: unknown card';
  end if;

  if v_current_location <> 'in_deck' then
    select coalesce(p.display_name, p.email) into v_current_holder_name
      from public.players p where p.id = v_current_holder;

    raise exception 'admin_allocate_spell_card: that card is already held by %',
      coalesce(v_current_holder_name, v_current_holder)
      using errcode = 'RFB07';
  end if;

  select sc.name into v_target_current_card
    from public.spell_deck_instances sdi
    join public.spell_cards sc on sc.id = sdi.card_id
   where sdi.held_by_player = p_player_id and sdi.location in ('held', 'pending_swap');

  if v_target_current_card is not null then
    raise exception 'admin_allocate_spell_card: that player already holds %', v_target_current_card
      using errcode = 'RFB08';
  end if;

  update public.spell_deck_instances
     set location = 'held', held_by_player = p_player_id
   where id = v_instance_id;

  insert into public.spell_draws (player_id, card_instance_id, trigger)
  values (p_player_id, v_instance_id, 'admin_allocation');

  instance_id := v_instance_id;
  return next;
end;
$$;

revoke execute on function public.admin_allocate_spell_card(uuid, text) from public, anon;
grant execute on function public.admin_allocate_spell_card(uuid, text) to authenticated;

comment on function public.admin_allocate_spell_card(uuid, text) is
  'Raises RFB07 when the card is already held/pending-swap by someone else, RFB08 when the target player already holds/is mid-swap-decision on a different card. Both require the admin to unassign first rather than auto-reassigning.';

-- Returns a held/pending-swap card to in_deck -- the "explicit unassign
-- first" half of the conflict handling above (issue #154). Same reset shape
-- as resolve_card_swap's discard branch (0018), just admin-triggered rather
-- than the player's own keep-or-swap choice, and deliberately leaves
-- spell_draws untouched: that history is an append-only log of what was
-- ever drawn, not a mirror of current possession.
create or replace function public.admin_unassign_spell_card(p_card_id uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_caller text;
  v_is_admin boolean;
  v_instance_id uuid;
  v_current_location text;
begin
  v_caller := public.current_player_id();

  select is_admin into v_is_admin from public.players where id = v_caller;
  if not coalesce(v_is_admin, false) then
    raise exception 'admin_unassign_spell_card: caller is not an admin';
  end if;

  select sdi.id, sdi.location into v_instance_id, v_current_location
    from public.spell_deck_instances sdi
   where sdi.card_id = p_card_id
     for update;

  if v_instance_id is null then
    raise exception 'admin_unassign_spell_card: unknown card';
  end if;

  if v_current_location = 'in_deck' then
    raise exception 'admin_unassign_spell_card: that card is not currently assigned to anyone'
      using errcode = 'RFB09';
  end if;

  update public.spell_deck_instances
     set location = 'in_deck', held_by_player = null
   where id = v_instance_id;
end;
$$;

revoke execute on function public.admin_unassign_spell_card(uuid) from public, anon;
grant execute on function public.admin_unassign_spell_card(uuid) to authenticated;

comment on function public.admin_unassign_spell_card(uuid) is
  'Raises RFB09 when the card is already in_deck (nothing to unassign).';
