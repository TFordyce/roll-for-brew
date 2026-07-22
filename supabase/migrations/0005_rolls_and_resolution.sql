-- Roll & resolve — happy path (issue #19). Layer-0 in-app rolls, and
-- resolution via the round-resolution engine (#15) invoked from the
-- Next.js server-action layer (src/app/rounds/actions.ts), not duplicated
-- in SQL. Tie and nat-1/nat-20 UI wiring beyond the engine's own precedence
-- (already exercised by resolveLayer's unit tests) are out of scope here;
-- a tie outcome simply leaves the round 'closed' for a later ticket.
create table if not exists public.rolls (
  round_id uuid not null references public.rounds (id) on delete cascade,
  player_id text not null references public.players (id) on delete cascade,
  layer integer not null default 0,
  value integer not null check (value between 1 and 20),
  input_mode text not null check (input_mode in ('in_app', 'manual')),
  modifier_snapshot integer not null,
  rolled_at timestamptz not null default now(),
  primary key (round_id, player_id, layer)
);

alter table public.rolls enable row level security;

-- "A player cannot see any roll (including their own reveal) until they
-- have personally submitted their roll": a player can always read their
-- own row (that's the "personal reveal" the moment they submit), and
-- everyone can read every row once the round is resolved (the
-- simultaneous-reveal moment, at which point the data isn't sensitive
-- anymore) — but nobody can peek at another still-in-progress player's row
-- before resolution.
create policy "rolls are readable by the roller, or by anyone once resolved"
  on public.rolls for select
  to authenticated
  using (
    player_id = public.current_player_id()
    or exists (
      select 1 from public.rounds r
       where r.id = rolls.round_id and r.status = 'resolved'
    )
  );

-- No insert/update/delete policies: writes only via the security-definer
-- functions below, same pattern as rounds/round_participants in 0004.

-- Submits the caller's layer-0 roll for a closed round. The die value is
-- generated server-side (not taken as a parameter) so an in-app roll can't
-- be spoofed by the client — this is the "in_app" input mode; manual entry
-- (trusted client-supplied value) is a later ticket. modifier_snapshot is
-- captured now from room_players so the roll's history is self-describing
-- even after the modifier moves on. Idempotency: a repeat call hits the
-- (round_id, player_id, layer) primary key and fails cleanly (23505).
create or replace function public.submit_roll(p_round_id uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_player_id text;
  v_status text;
  v_room_id uuid;
  v_modifier integer;
  v_value integer;
begin
  v_player_id := public.current_player_id();

  select status, room_id into v_status, v_room_id
    from public.rounds
   where id = p_round_id;

  if v_status is null then
    raise exception 'submit_roll: round not found';
  end if;

  if v_status <> 'closed' then
    raise exception 'submit_roll: round is not closed for rolling';
  end if;

  if not exists (
    select 1 from public.round_participants
     where round_id = p_round_id and player_id = v_player_id
  ) then
    raise exception 'submit_roll: caller did not declare in for this round';
  end if;

  select modifier into v_modifier
    from public.room_players
   where room_id = v_room_id and player_id = v_player_id;

  v_value := floor(random() * 20 + 1)::integer;

  insert into public.rolls (round_id, player_id, layer, value, input_mode, modifier_snapshot)
  values (p_round_id, v_player_id, 0, v_value, 'in_app', v_modifier);
end;
$$;

revoke execute on function public.submit_roll(uuid) from public, anon;
grant execute on function public.submit_roll(uuid) to authenticated;

-- Returns every layer-0 roll for a round once (and only once) every
-- declared participant has rolled — an empty set otherwise. Security
-- definer so it can see every participant's row regardless of the
-- roller-only RLS policy above, but restricted to callers who are
-- themselves a participant in this round: without that check this would
-- be a side door letting any authenticated player read a full layer the
-- instant it completes, ahead of (and regardless of) resolve_round ever
-- running — the same "hidden until revealed" guarantee the RLS policy
-- enforces for direct table reads. This is the read side of the "server
-- calls the round-resolution engine" step in the spec: the caller (a
-- Next.js server action) feeds these rows into resolveLayer()
-- (src/lib/game/resolveLayer.ts).
create or replace function public.get_layer0_rolls_if_complete(p_round_id uuid)
returns table (player_id text, value integer, modifier_snapshot integer)
language plpgsql
security definer
set search_path = public
as $$
declare
  v_player_id text;
  v_participant_count integer;
  v_roll_count integer;
begin
  v_player_id := public.current_player_id();

  if not exists (
    select 1 from public.round_participants
     where round_id = p_round_id and player_id = v_player_id
  ) then
    raise exception 'get_layer0_rolls_if_complete: caller is not a participant in this round';
  end if;

  select count(*) into v_participant_count
    from public.round_participants
   where round_id = p_round_id;

  select count(*) into v_roll_count
    from public.rolls
   where round_id = p_round_id and layer = 0;

  if v_roll_count < v_participant_count then
    return;
  end if;

  return query
    select r.player_id, r.value, r.modifier_snapshot
      from public.rolls r
     where r.round_id = p_round_id and r.layer = 0;
end;
$$;

revoke execute on function public.get_layer0_rolls_if_complete(uuid) from public, anon;
grant execute on function public.get_layer0_rolls_if_complete(uuid) to authenticated;

-- Applies a single-brewer resolution the server already computed via the
-- round-resolution engine: writes rounds.brewer_id/cups_made/status/
-- resolved_at and increments the brewer's room_players.modifier by
-- cups_made, atomically (one function invocation = one transaction). Locks
-- the round row so two concurrent resolve attempts (e.g. a retried request)
-- can't double-apply the modifier increment. cups_made must equal the
-- round's actual participant count (the spec's "denormalized count of
-- layer-0 participants") rather than trusting an arbitrary client value,
-- and the brewer must actually be a participant who has rolled — bounding
-- what a caller can make this function do, even though (consistent with
-- every other RPC in this schema) the *comparison itself* is trusted to
-- have been computed correctly by the caller's own server-side engine call.
create or replace function public.resolve_round(p_round_id uuid, p_brewer_id text, p_cups_made integer)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_status text;
  v_room_id uuid;
  v_participant_count integer;
  v_roll_count integer;
begin
  select status, room_id into v_status, v_room_id
    from public.rounds
   where id = p_round_id
   for update;

  if v_status is null then
    raise exception 'resolve_round: round not found';
  end if;

  if v_status <> 'closed' then
    raise exception 'resolve_round: round is not closed';
  end if;

  if not exists (
    select 1 from public.round_participants
     where round_id = p_round_id and player_id = p_brewer_id
  ) then
    raise exception 'resolve_round: brewer is not a participant in this round';
  end if;

  select count(*) into v_participant_count
    from public.round_participants
   where round_id = p_round_id;

  select count(*) into v_roll_count
    from public.rolls
   where round_id = p_round_id and layer = 0;

  if v_roll_count < v_participant_count then
    raise exception 'resolve_round: not all participants have rolled yet';
  end if;

  if p_cups_made <> v_participant_count then
    raise exception 'resolve_round: cups_made must equal the round''s participant count';
  end if;

  update public.rounds
     set status = 'resolved',
         brewer_id = p_brewer_id,
         cups_made = p_cups_made,
         resolved_at = now()
   where id = p_round_id;

  update public.room_players
     set modifier = modifier + p_cups_made
   where room_id = v_room_id and player_id = p_brewer_id;
end;
$$;

revoke execute on function public.resolve_round(uuid, text, integer) from public, anon;
grant execute on function public.resolve_round(uuid, text, integer) to authenticated;
