-- Spell Cards 1/5 (issue #66): per-instance deck state and the draw/hold/
-- swap loop. The deck and holds are global/persistent state, orthogonal to
-- the existing one-room-per-day model (US37) — spell_deck_instances and
-- spell_draws carry no room_id/day scoping at all.
--
-- One physical instance per catalog row: the deck is 65 cards total (20
-- Common / 33 Rare / 12 Epic), which is exactly the 65-row catalog seeded in
-- 0017 — there is no card with more than one physical copy, so "one row per
-- catalog name" and "one row per physical instance" coincide and the seed
-- below is a straight 1:1 insert.
create table if not exists public.spell_deck_instances (
  id uuid primary key default gen_random_uuid(),
  spell_card_id uuid not null references public.spell_cards (id),
  location text not null check (location in ('in_deck', 'discarded', 'held')) default 'in_deck',
  held_by_player_id text references public.players (id) on delete set null,
  updated_at timestamptz not null default now()
);

-- A player holds at most one card at a time (US5): enforced as a partial
-- unique index (only one row can be simultaneously location = 'held' with
-- this held_by_player_id), rather than purely trusted to application logic.
-- A card mid-swap-decision (drawn while already holding one) is parked at
-- 'discarded' — not 'held' — precisely so it never collides with this index;
-- resolve_spell_card_swap below is what returns it to either 'held' or
-- 'in_deck' once the player actually decides.
create unique index if not exists one_held_card_per_player
  on public.spell_deck_instances (held_by_player_id)
  where location = 'held' and held_by_player_id is not null;

alter table public.spell_deck_instances enable row level security;

-- The deck stays blind (US9): no policy exposes in_deck/discarded rows to
-- any app role at all (only service_role, which bypasses RLS, can see the
-- full deck — e.g. for tests/admin tooling). A player can read only the one
-- instance they currently hold, which is exactly the "docked widget on my
-- own screen only" requirement (US3/US4) and nothing more — no deck
-- contents, no remaining count, not even other players' held cards.
create policy "spell_deck_instances are readable only by their current holder"
  on public.spell_deck_instances for select
  to authenticated
  using (held_by_player_id = public.current_player_id());

-- No insert/update/delete policies: writes only via draw_spell_card /
-- resolve_spell_card_swap below, same pattern as every other gated table.

-- Draw + cast history (spell_casts is a later ticket). previously_held_
-- instance_id / swap_resolved_at / kept_instance_id are all null for a draw
-- that resolved immediately (the drawing player held nothing) and are only
-- populated for a draw that required a keep-or-swap decision (US6).
create table if not exists public.spell_draws (
  id uuid primary key default gen_random_uuid(),
  player_id text not null references public.players (id) on delete cascade,
  round_id uuid not null references public.rounds (id) on delete cascade,
  drawn_instance_id uuid not null references public.spell_deck_instances (id),
  previously_held_instance_id uuid references public.spell_deck_instances (id),
  kept_instance_id uuid references public.spell_deck_instances (id),
  swap_resolved_at timestamptz,
  drawn_at timestamptz not null default now()
);

alter table public.spell_draws enable row level security;

-- Draw history is player-private (mirrors the deck's own blindness) — a
-- draw is never revealed to anyone but the drawer, unlike rolls (which
-- become visible to everyone once a round resolves).
create policy "spell_draws are readable only by the drawing player"
  on public.spell_draws for select
  to authenticated
  using (player_id = public.current_player_id());

-- No insert/update/delete policies: writes only via draw_spell_card /
-- resolve_spell_card_swap below.

insert into public.spell_deck_instances (spell_card_id, location)
select id, 'in_deck' from public.spell_cards;

-- Draws one uniformly-random in-deck instance for the caller (US36: rarity
-- comes only from the catalog's uneven instance counts, so this is a flat
-- uniform pick with no per-tier weighting). `for update skip locked` makes
-- the pick-and-claim atomic against concurrent draws (e.g. two players in
-- the same layer both rolling a nat 1/20 at once) without a table-wide lock.
--
-- If the caller already holds a card, this does NOT overwrite it: the new
-- instance is parked at 'discarded' (drawn, unclaimed, off to the side) and
-- the spell_draws row is left with previously_held_instance_id set and
-- swap_resolved_at null, so the app can prompt the keep-or-swap choice
-- (US6) and resolve it via resolve_spell_card_swap. If the caller holds
-- nothing, the draw resolves immediately: the new instance goes straight to
-- 'held' and the spell_draws row is written already-resolved
-- (kept_instance_id = drawn_instance_id, swap_resolved_at = now()).
--
-- Deck-exhaustion (no in-deck instances left) is an explicitly out-of-scope
-- edge case (issue #65) — this simply skips the draw (returns null) rather
-- than raising, since with 65 instances and a 1-card-per-player cap it
-- cannot occur under any realistic play session.
create or replace function public.draw_spell_card(p_round_id uuid)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_player_id text;
  v_new_instance_id uuid;
  v_held_instance_id uuid;
  v_draw_id uuid;
begin
  v_player_id := public.current_player_id();

  if not exists (select 1 from public.rounds where id = p_round_id) then
    raise exception 'draw_spell_card: round not found';
  end if;

  select id into v_new_instance_id
    from public.spell_deck_instances
   where location = 'in_deck'
   order by random()
   limit 1
   for update skip locked;

  if v_new_instance_id is null then
    return null;
  end if;

  select id into v_held_instance_id
    from public.spell_deck_instances
   where held_by_player_id = v_player_id and location = 'held';

  if v_held_instance_id is null then
    update public.spell_deck_instances
       set location = 'held', held_by_player_id = v_player_id, updated_at = now()
     where id = v_new_instance_id;

    insert into public.spell_draws (
      player_id, round_id, drawn_instance_id, kept_instance_id, swap_resolved_at
    ) values (
      v_player_id, p_round_id, v_new_instance_id, v_new_instance_id, now()
    ) returning id into v_draw_id;
  else
    update public.spell_deck_instances
       set location = 'discarded', updated_at = now()
     where id = v_new_instance_id;

    insert into public.spell_draws (
      player_id, round_id, drawn_instance_id, previously_held_instance_id
    ) values (
      v_player_id, p_round_id, v_new_instance_id, v_held_instance_id
    ) returning id into v_draw_id;
  end if;

  return v_draw_id;
end;
$$;

revoke execute on function public.draw_spell_card(uuid) from public, anon;
grant execute on function public.draw_spell_card(uuid) to authenticated;

-- Resolves a pending keep-or-swap decision (US6/US7): the non-kept instance
-- flips back to 'in_deck' — reshuffled, never removed — and, if the new
-- card was chosen, it becomes 'held' in the kept card's place. Only the
-- drawing player can resolve their own pending draw, and only once.
create or replace function public.resolve_spell_card_swap(p_draw_id uuid, p_keep_new boolean)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_player_id text;
  v_drawn_instance_id uuid;
  v_previously_held_instance_id uuid;
  v_kept_instance_id uuid;
begin
  v_player_id := public.current_player_id();

  select drawn_instance_id, previously_held_instance_id
    into v_drawn_instance_id, v_previously_held_instance_id
    from public.spell_draws
   where id = p_draw_id
     and player_id = v_player_id
     and previously_held_instance_id is not null
     and swap_resolved_at is null
   for update;

  if v_drawn_instance_id is null then
    raise exception 'resolve_spell_card_swap: no pending swap decision for this draw'
      using errcode = 'RFB03';
  end if;

  if p_keep_new then
    update public.spell_deck_instances
       set location = 'in_deck', held_by_player_id = null, updated_at = now()
     where id = v_previously_held_instance_id;

    update public.spell_deck_instances
       set location = 'held', held_by_player_id = v_player_id, updated_at = now()
     where id = v_drawn_instance_id;

    v_kept_instance_id := v_drawn_instance_id;
  else
    update public.spell_deck_instances
       set location = 'in_deck', held_by_player_id = null, updated_at = now()
     where id = v_drawn_instance_id;

    v_kept_instance_id := v_previously_held_instance_id;
  end if;

  update public.spell_draws
     set swap_resolved_at = now(), kept_instance_id = v_kept_instance_id
   where id = p_draw_id;
end;
$$;

revoke execute on function public.resolve_spell_card_swap(uuid, boolean) from public, anon;
grant execute on function public.resolve_spell_card_swap(uuid, boolean) to authenticated;

-- RFB03 joins the RFB01/RFB02 family (supabase/migrations/
-- 0013_stale_round_error_codes.sql) for the same reason: a stable code the
-- caller can classify by, rather than matching the exception message. Covers
-- "no matching pending swap decision" for any reason (wrong caller, no such
-- draw, or already resolved by a concurrent request) — all of which mean
-- the same thing to the UI: the decision moved on, refresh rather than crash.
comment on function public.resolve_spell_card_swap(uuid, boolean) is
  'Raises RFB03 when there is no pending swap decision matching p_draw_id for the caller — already resolved, not the caller''s own draw, or no such draw.';

grant select on public.spell_deck_instances to authenticated;
grant select on public.spell_draws to authenticated;
grant all on public.spell_deck_instances to service_role;
grant all on public.spell_draws to service_role;
