-- Spell Cards 1/5: deck-instance state + draw/hold/swap (issue #66).
--
-- spell_deck_instances tracks one row per physical card instance (65 total,
-- one per spell_cards row — the deck has no duplicate card names, so
-- "one physical instance per catalog name" collapses to a 1:1 seed here).
-- Global/persistent state (user story 37): not scoped to a room/day, so a
-- held card survives room/day rollover untouched.
--
-- location has four values, not three, to make the keep-or-swap decision an
-- explicit, separate step rather than something draw_spell_card resolves
-- unilaterally: 'in_deck' (undrawn, eligible to be drawn), 'held'
-- (belongs to held_by_player, done deciding), and 'pending_swap' (just
-- drawn while the player already held a card — parked here, still
-- attributed to held_by_player, until resolve_card_swap says which of the
-- two the player is keeping). There is no lingering 'discarded' location:
-- per user story 7 / AC "reshuffled, not removed", a card that isn't kept
-- goes straight back to 'in_deck' — it's immediately eligible to be drawn
-- again, which is exactly what "shuffled back into the shared deck" means.
create table if not exists public.spell_deck_instances (
  id uuid primary key default gen_random_uuid(),
  card_id uuid not null references public.spell_cards (id),
  location text not null default 'in_deck'
    check (location in ('in_deck', 'held', 'pending_swap')),
  held_by_player text references public.players (id)
);

-- At most one instance can be 'held' per player (the hold cap, user story 5)
-- — enforced here rather than only in application logic so a concurrent
-- draw can't race past the RPC's own check.
create unique index if not exists spell_deck_instances_one_held_per_player
  on public.spell_deck_instances (held_by_player)
  where location = 'held';

-- Same cap for the parked pending-swap slot: a player can only be mid-way
-- through one keep-or-swap decision at a time (they can't hold a second
-- card, so they can't draw a third one until the current decision resolves —
-- draw_spell_card enforces this explicitly rather than relying on this index
-- alone, but the index closes the same race window as the one above).
create unique index if not exists spell_deck_instances_one_pending_per_player
  on public.spell_deck_instances (held_by_player)
  where location = 'pending_swap';

alter table public.spell_deck_instances enable row level security;

-- The deck stays blind (user story 9: no contents, no remaining count) and a
-- held card is visible only to its holder (user story 4) — so the only rows
-- a player can read directly are their own held_by_player rows. In_deck rows
-- (held_by_player is null) are never selectable by anyone; the draw RPC
-- (security definer) is the only thing that ever reads them.
create policy "spell_deck_instances are readable only by their holder"
  on public.spell_deck_instances for select
  to authenticated
  using (held_by_player = public.current_player_id());

-- No insert/update/delete policies: writes only via the security-definer
-- functions below, same pattern as rounds/round_participants (0004).

create table if not exists public.spell_draws (
  id uuid primary key default gen_random_uuid(),
  player_id text not null references public.players (id),
  card_instance_id uuid not null references public.spell_deck_instances (id),
  trigger text not null check (trigger in ('nat1', 'nat20')),
  drawn_at timestamptz not null default now()
);

alter table public.spell_draws enable row level security;

create policy "spell_draws are readable by the drawing player"
  on public.spell_draws for select
  to authenticated
  using (player_id = public.current_player_id());

-- Seeds exactly one deck instance per catalog card — the 65-physical-card
-- deck this feature models has no duplicate names, so instance count always
-- equals catalog row count. Guarded by not-exists so re-running this
-- migration (or a future seed correction) can't double-seed instances for a
-- card that already has one.
insert into public.spell_deck_instances (card_id)
select sc.id
  from public.spell_cards sc
 where not exists (
   select 1 from public.spell_deck_instances sdi where sdi.card_id = sc.id
 );

-- Draws one uniformly-random in-deck instance for the caller (user stories
-- 1/2/36: uniform per physical instance, rarity emerges only from the
-- catalog's uneven counts). A card's own resolution roll never calls this —
-- callers only invoke it from the main round roll's nat-1/nat-20 check
-- (src/app/rounds/actions.ts), which is exactly what scopes the trigger the
-- way user story 32 requires; this function has no way to distinguish "main
-- roll" from any other roll itself, so that scoping is entirely the
-- caller's responsibility.
--
-- Returns the drawn instance's id and whether a keep-or-swap decision is now
-- pending (the caller already held a card), or null if the deck is
-- momentarily exhausted (every instance simultaneously held/pending) — the
-- deck-exhaustion fallback is an explicitly unresolved edge case upstream
-- (map #65's Out of Scope), so skipping the draw silently rather than
-- erroring is the least-surprising behaviour until that's decided.
create or replace function public.draw_spell_card(p_trigger text)
returns table (instance_id uuid, needs_swap_decision boolean)
language plpgsql
security definer
set search_path = public
as $$
declare
  v_player_id text;
  v_new_instance_id uuid;
  v_already_held boolean;
begin
  v_player_id := public.current_player_id();

  if p_trigger not in ('nat1', 'nat20') then
    raise exception 'draw_spell_card: invalid trigger %', p_trigger;
  end if;

  v_already_held := exists (
    select 1 from public.spell_deck_instances
     where held_by_player = v_player_id and location = 'held'
  );

  if exists (
    select 1 from public.spell_deck_instances
     where held_by_player = v_player_id and location = 'pending_swap'
  ) then
    raise exception 'draw_spell_card: caller already has a pending keep-or-swap decision';
  end if;

  select id into v_new_instance_id
    from public.spell_deck_instances
   where location = 'in_deck'
   order by random()
   limit 1
     for update skip locked;

  if v_new_instance_id is null then
    return;
  end if;

  update public.spell_deck_instances
     set location = case when v_already_held then 'pending_swap' else 'held' end,
         held_by_player = v_player_id
   where id = v_new_instance_id;

  insert into public.spell_draws (player_id, card_instance_id, trigger)
  values (v_player_id, v_new_instance_id, p_trigger);

  instance_id := v_new_instance_id;
  needs_swap_decision := v_already_held;
  return next;
end;
$$;

revoke execute on function public.draw_spell_card(text) from public, anon;
grant execute on function public.draw_spell_card(text) to authenticated;

-- Resolves a pending keep-or-swap decision (user story 6): p_keep_new true
-- keeps the newly-drawn card and reshuffles the previously-held one back to
-- 'in_deck'; false keeps the old one and reshuffles the new one instead.
-- Either way exactly one instance ends up 'held' for the caller and the
-- other goes back to 'in_deck' — never permanently removed (user story 7).
create or replace function public.resolve_card_swap(p_keep_new boolean)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_player_id text;
  v_held_id uuid;
  v_pending_id uuid;
begin
  v_player_id := public.current_player_id();

  select id into v_held_id
    from public.spell_deck_instances
   where held_by_player = v_player_id and location = 'held';

  select id into v_pending_id
    from public.spell_deck_instances
   where held_by_player = v_player_id and location = 'pending_swap';

  if v_pending_id is null then
    raise exception 'resolve_card_swap: caller has no pending keep-or-swap decision';
  end if;

  if p_keep_new then
    update public.spell_deck_instances set location = 'in_deck', held_by_player = null
     where id = v_held_id;
    update public.spell_deck_instances set location = 'held'
     where id = v_pending_id;
  else
    update public.spell_deck_instances set location = 'in_deck', held_by_player = null
     where id = v_pending_id;
  end if;
end;
$$;

revoke execute on function public.resolve_card_swap(boolean) from public, anon;
grant execute on function public.resolve_card_swap(boolean) to authenticated;

-- The caller's own held/pending-swap card(s) joined with the catalog, for
-- the docked widget and swap prompt. Security definer so it can join
-- spell_cards regardless of RLS nuance, but it only ever returns rows for
-- the caller (current_player_id()), preserving "visible only to the
-- holder" (user story 4) the same way the table's own RLS policy does.
create or replace function public.get_my_spell_cards()
returns table (
  instance_id uuid,
  location text,
  card_name text,
  casting_time text,
  target text,
  tier text,
  effect_text text
)
language plpgsql
security definer
set search_path = public
as $$
declare
  v_player_id text;
begin
  v_player_id := public.current_player_id();

  return query
    select sdi.id, sdi.location, sc.name, sc.casting_time, sc.target, sc.tier, sc.effect_text
      from public.spell_deck_instances sdi
      join public.spell_cards sc on sc.id = sdi.card_id
     where sdi.held_by_player = v_player_id
       and sdi.location in ('held', 'pending_swap');
end;
$$;

revoke execute on function public.get_my_spell_cards() from public, anon;
grant execute on function public.get_my_spell_cards() to authenticated;
