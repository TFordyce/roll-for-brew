-- Usual / Order / Menu data layer (issue #224, part of #223): the
-- usual_drinks and orders tables, the submit_order RPC, and the round_menu
-- read view. No UI here -- this is the full data layer only.
--
-- usual_drinks mirrors player_settings' (0008) shape exactly: a simple
-- per-player preference row with no cross-player side effects, so it's
-- written directly by the owning player under RLS rather than through a
-- security-definer RPC. Unlike player_settings, though, SELECT is
-- world-readable rather than own-row-only -- see the grant/policy comment
-- below, and issue #223's "Read-access clarification".
create table if not exists public.usual_drinks (
  player_id text not null references public.players (id) on delete cascade,
  drink_type text not null check (drink_type in ('tea', 'coffee')),
  milk text not null check (milk in ('Dairy', 'Oat', 'Soy', 'None')),
  sugar text not null
    check (sugar in ('None', 'Sprinkle', 'Half Tsp', '1 Tsp', '1.5 Tsp', '2 Tsp', '3 Tsp')),
  updated_at timestamptz not null default now(),
  primary key (player_id, drink_type)
);

alter table public.usual_drinks enable row level security;

-- World-readable, same posture as round_participants/players (issue #223's
-- explicit read-access clarification) -- the round_menu view below relies on
-- being able to read *any* player's current Usual, not just the querying
-- player's own. The "Menu only shows round participants" property comes
-- from the view's join through round_participants, not from locking this
-- table down.
create policy "usual_drinks are readable by authenticated users"
  on public.usual_drinks for select
  to authenticated
  using (true);

create policy "usual_drinks are insertable by their own player"
  on public.usual_drinks for insert
  to authenticated
  with check (player_id = public.current_player_id());

create policy "usual_drinks are updatable by their own player"
  on public.usual_drinks for update
  to authenticated
  using (player_id = public.current_player_id())
  with check (player_id = public.current_player_id());

-- No delete policy -- editing a Usual is always an upsert (insert or
-- update), never a removal; there's no "clear my Usual" story in the spec.

grant all on public.usual_drinks to service_role;
grant select, insert, update on public.usual_drinks to authenticated;

-- orders: one row per (round_id, player_id), upserted on re-pick -- same
-- shape as brew_ratings (0058). Unlike usual_drinks, orders has no
-- cross-player-visible write path other than the security-definer RPC
-- below: the acting player is always derived server-side, matching every
-- other round-scoped write in this codebase.
create table if not exists public.orders (
  round_id uuid not null references public.rounds (id) on delete cascade,
  player_id text not null references public.players (id) on delete cascade,
  drink_type text not null check (drink_type in ('tea', 'coffee')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (round_id, player_id)
);

alter table public.orders enable row level security;

-- World-readable, same posture as round_participants/players -- see the
-- usual_drinks policy comment above; the round_menu view needs to read
-- every participant's Order, not just the caller's own.
create policy "orders are readable by authenticated users"
  on public.orders for select
  to authenticated
  using (true);

-- No insert/update/delete policies -- the only writer is submit_order
-- below, which bypasses RLS as table owner (security definer).

grant all on public.orders to service_role;
grant select on public.orders to authenticated;

-- Submits or changes (upsert-on-repick) the caller's own Order for a round.
-- The Order Window is open from the round's 'open' status all the way
-- through 'resolved' -- wider than the Rating Window (submit_brew_rating,
-- 0058), which only opens once the round resolves -- and closes the same
-- way: once the room's *next* round resolves. Ordering is by started_at
-- rather than resolved_at (unlike submit_brew_rating) because the target
-- round here may itself still be open/closed with no resolved_at yet, and
-- rounds_one_active_per_round (0004) guarantees started_at ordering already
-- matches round succession order within a room.
create or replace function public.submit_order(
  p_round_id uuid,
  p_drink_type text
)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_player_id text;
  v_round public.rounds%rowtype;
begin
  v_player_id := public.current_player_id();

  if p_drink_type is null or p_drink_type not in ('tea', 'coffee') then
    raise exception 'submit_order: drink_type must be tea or coffee'
      using errcode = 'RFB28';
  end if;

  select * into v_round from public.rounds where id = p_round_id;

  if v_round.id is null or v_round.status not in ('open', 'closed', 'resolved') then
    raise exception 'submit_order: round not found or not open for ordering'
      using errcode = 'RFB29';
  end if;

  -- Order Window: closes the moment any round in the same room, started
  -- later than this one, resolves -- whether or not the caller ordered in
  -- it, matching the Rating Window's "any round in the room" rule.
  if exists (
    select 1 from public.rounds r
     where r.room_id = v_round.room_id
       and r.started_at > v_round.started_at
       and r.status = 'resolved'
  ) then
    raise exception 'submit_order: the order window has closed'
      using errcode = 'RFB30';
  end if;

  insert into public.orders (round_id, player_id, drink_type)
  values (p_round_id, v_player_id, p_drink_type)
  on conflict (round_id, player_id)
  do update set drink_type = excluded.drink_type, updated_at = now();
end;
$$;

revoke execute on function public.submit_order(uuid, text) from public, anon;
grant execute on function public.submit_order(uuid, text) to authenticated;

comment on function public.submit_order(uuid, text) is
  'Raises RFB28 for a drink_type other than tea/coffee, RFB29 when the round does not exist or is cancelled, RFB30 once a newer round in the same room has resolved (Order Window closed).';

-- round_menu: the Menu read path (issue #223 decision -- view or RPC,
-- implementer's choice). A plain join, following getRoundParticipants'
-- (src/lib/supabase/rounds.ts) pattern of a filterable read surface rather
-- than inventing new access machinery -- callers filter by round_id the
-- same way they already do against round_participants.
--
-- Inner-joins orders, so a participant with no Order simply doesn't appear
-- (user story 18) -- there's no explicit "no drink" row. Left-joins
-- usual_drinks on (player_id, drink_type) so milk/sugar come back null,
-- with no_preference_set true, when the player has never set a Usual for
-- their ordered drink (user story 10/14). security_invoker is on, safe
-- because every underlying table here is world-readable under RLS -- this
-- is a live join, not a snapshot (ADR 0003): editing a Usual after a round
-- resolves changes what that round's Menu returns.
create view public.round_menu
with (security_invoker = on) as
select
  rp.round_id,
  rp.player_id,
  o.drink_type,
  ud.milk,
  ud.sugar,
  (ud.player_id is null) as no_preference_set
from public.round_participants rp
join public.orders o on o.round_id = rp.round_id and o.player_id = rp.player_id
left join public.usual_drinks ud on ud.player_id = rp.player_id and ud.drink_type = o.drink_type;

grant select on public.round_menu to authenticated;
