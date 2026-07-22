-- Tie-break and nat-1/nat-20 recursion, wired live (issue #20). A layer
-- resolving to a tie (per the engine's own precedence, src/lib/game/
-- resolveLayer.ts) is no longer a dead end: the tied subset rerolls in a new
-- layer, reapplying their current modifier, recursing with no hardcoded cap
-- until a single brewer emerges. This migration adds the persisted state
-- needed to know, at any point, which layer is currently live and who is
-- expected to roll in it — the engine itself stays pure/stateless and stays
-- in TS (src/app/rounds/actions.ts); SQL only persists the layer transition
-- the caller already computed, same trust boundary as resolve_round below.

-- Which layer is currently accepting rolls for this round. Layer 0's
-- expected rollers are round_participants (unchanged from #18/#19); layer
-- N > 0's expected rollers are round_layer_participants below.
alter table public.rounds add column if not exists current_layer integer not null default 0;

-- The tied subset who must roll a given reroll layer (layer 0 isn't stored
-- here — round_participants already covers it, and every round starts at
-- layer 0 so there's nothing to seed). Populated by advance_round_layer
-- when a layer resolves to a tie; append-only, same pattern as
-- round_participants.
create table if not exists public.round_layer_participants (
  round_id uuid not null references public.rounds (id) on delete cascade,
  layer integer not null,
  player_id text not null references public.players (id) on delete cascade,
  primary key (round_id, layer, player_id)
);

alter table public.round_layer_participants enable row level security;

create policy "round_layer_participants are readable by authenticated users"
  on public.round_layer_participants for select
  to authenticated
  using (true);

-- No insert/update/delete policies: writes only via advance_round_layer.

-- Shared "is this player expected to roll in this round's given layer"
-- check, used by submit_roll and get_current_layer_rolls_if_complete so the
-- two RPCs agree on exactly the same rule rather than drifting apart.
create or replace function public.is_expected_layer_roller(
  p_round_id uuid,
  p_player_id text,
  p_layer integer
)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
begin
  if p_layer = 0 then
    return exists (
      select 1 from public.round_participants
       where round_id = p_round_id and player_id = p_player_id
    );
  end if;

  return exists (
    select 1 from public.round_layer_participants
     where round_id = p_round_id and layer = p_layer and player_id = p_player_id
  );
end;
$$;

revoke execute on function public.is_expected_layer_roller(uuid, text, integer) from public, anon;
grant execute on function public.is_expected_layer_roller(uuid, text, integer) to authenticated;

-- Submits the caller's roll for the round's *current* layer (previously
-- hardcoded to layer 0 — #19's happy path never needed a reroll). The layer
-- is derived server-side from rounds.current_layer, never a client
-- parameter, so a caller can't roll ahead of or behind where the round
-- actually is. Idempotency unchanged: a repeat call for the same layer hits
-- the (round_id, player_id, layer) primary key and fails cleanly (23505).
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
  v_layer integer;
  v_modifier integer;
  v_value integer;
begin
  v_player_id := public.current_player_id();

  select status, room_id, current_layer into v_status, v_room_id, v_layer
    from public.rounds
   where id = p_round_id;

  if v_status is null then
    raise exception 'submit_roll: round not found';
  end if;

  if v_status <> 'closed' then
    raise exception 'submit_roll: round is not closed for rolling';
  end if;

  if not public.is_expected_layer_roller(p_round_id, v_player_id, v_layer) then
    raise exception 'submit_roll: caller is not expected to roll in the current layer';
  end if;

  select modifier into v_modifier
    from public.room_players
   where room_id = v_room_id and player_id = v_player_id;

  v_value := floor(random() * 20 + 1)::integer;

  insert into public.rolls (round_id, player_id, layer, value, input_mode, modifier_snapshot)
  values (p_round_id, v_player_id, v_layer, v_value, 'in_app', v_modifier);
end;
$$;

-- Superseded by get_current_layer_rolls_if_complete below, which covers
-- layer 0 (and every later layer) generically — nothing else calls this.
drop function if exists public.get_layer0_rolls_if_complete(uuid);

-- Returns every roll for the round's *current* layer once (and only once)
-- every expected roller for that layer has rolled — an empty set otherwise.
-- Security definer so it can see every roller's row regardless of the
-- roller-only RLS policy on rolls, but restricted to callers who are
-- themselves expected to roll this layer (same "hidden until revealed"
-- guarantee as #19's get_layer0_rolls_if_complete, now layer-generic). The
-- returned layer number lets the caller (submitRollAction) know which layer
-- it just resolved, since the round's current_layer may have moved on by
-- the time a slow request reads it again.
create or replace function public.get_current_layer_rolls_if_complete(p_round_id uuid)
returns table (layer integer, player_id text, value integer, modifier_snapshot integer)
language plpgsql
security definer
set search_path = public
as $$
declare
  v_player_id text;
  v_layer integer;
  v_expected_count integer;
  v_roll_count integer;
begin
  v_player_id := public.current_player_id();

  select current_layer into v_layer from public.rounds where id = p_round_id;

  if v_layer is null then
    raise exception 'get_current_layer_rolls_if_complete: round not found';
  end if;

  if not public.is_expected_layer_roller(p_round_id, v_player_id, v_layer) then
    raise exception 'get_current_layer_rolls_if_complete: caller is not expected to roll in the current layer';
  end if;

  if v_layer = 0 then
    select count(*) into v_expected_count
      from public.round_participants
     where round_id = p_round_id;
  else
    select count(*) into v_expected_count
      from public.round_layer_participants
     where round_id = p_round_id and layer = v_layer;
  end if;

  select count(*) into v_roll_count
    from public.rolls
   where round_id = p_round_id and layer = v_layer;

  if v_roll_count < v_expected_count then
    return;
  end if;

  return query
    select r.layer, r.player_id, r.value, r.modifier_snapshot
      from public.rolls r
     where r.round_id = p_round_id and r.layer = v_layer;
end;
$$;

revoke execute on function public.get_current_layer_rolls_if_complete(uuid) from public, anon;
grant execute on function public.get_current_layer_rolls_if_complete(uuid) to authenticated;

-- Persists a tie outcome the caller already computed via resolveLayer:
-- records the tied subset as round_layer_participants for the next layer
-- and advances rounds.current_layer, atomically. Locks the round row so two
-- concurrent callers resolving the same completed layer (e.g. the last two
-- tied players' requests racing) can't both advance the layer. Each tied
-- player id must have actually rolled in the layer being left, bounding
-- what a caller can make this function do — consistent with resolve_round's
-- own trust boundary below, the *comparison* (who's tied) is trusted to
-- have been computed correctly by the caller's own resolveLayer call.
create or replace function public.advance_round_layer(p_round_id uuid, p_tied_player_ids text[])
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  v_status text;
  v_layer integer;
  v_next_layer integer;
  v_player_id text;
begin
  select status, current_layer into v_status, v_layer
    from public.rounds
   where id = p_round_id
   for update;

  if v_status is null then
    raise exception 'advance_round_layer: round not found';
  end if;

  if v_status <> 'closed' then
    raise exception 'advance_round_layer: round is not closed';
  end if;

  if p_tied_player_ids is null or array_length(p_tied_player_ids, 1) < 2 then
    raise exception 'advance_round_layer: at least 2 tied players required';
  end if;

  foreach v_player_id in array p_tied_player_ids loop
    if not public.is_expected_layer_roller(p_round_id, v_player_id, v_layer) then
      raise exception 'advance_round_layer: % did not roll in the current layer', v_player_id;
    end if;
  end loop;

  v_next_layer := v_layer + 1;

  insert into public.round_layer_participants (round_id, layer, player_id)
  select p_round_id, v_next_layer, unnest(p_tied_player_ids)
  on conflict do nothing;

  update public.rounds set current_layer = v_next_layer where id = p_round_id;

  return v_next_layer;
end;
$$;

revoke execute on function public.advance_round_layer(uuid, text[]) from public, anon;
grant execute on function public.advance_round_layer(uuid, text[]) to authenticated;

-- Applies a single-brewer resolution the server already computed via the
-- round-resolution engine, same as #19 — now generalized off
-- rounds.current_layer instead of a hardcoded layer 0, so the final write
-- path fires correctly whichever layer the round actually resolved on.
-- cups_made still must equal the round's *original* participant count (not
-- the narrower tied-subset size of whatever layer resolved it) — the number
-- of cups the brewer owes everyone who played this round, unchanged by how
-- many reroll layers it took to find them.
create or replace function public.resolve_round(p_round_id uuid, p_brewer_id text, p_cups_made integer)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_status text;
  v_room_id uuid;
  v_layer integer;
  v_participant_count integer;
  v_expected_layer_count integer;
  v_roll_count integer;
begin
  select status, room_id, current_layer into v_status, v_room_id, v_layer
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

  if v_layer = 0 then
    v_expected_layer_count := v_participant_count;
  else
    select count(*) into v_expected_layer_count
      from public.round_layer_participants
     where round_id = p_round_id and layer = v_layer;
  end if;

  select count(*) into v_roll_count
    from public.rolls
   where round_id = p_round_id and layer = v_layer;

  if v_roll_count < v_expected_layer_count then
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
