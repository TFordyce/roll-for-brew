-- Manual roll entry + input-mode settings (issue #22). player_settings is a
-- simple per-player preference row with no cross-player side effects (unlike
-- rooms/rounds/rolls), so unlike those tables it's written directly by the
-- owning player under RLS rather than through a security-definer RPC — the
-- "own row only" `using`/`with check` clause is the only invariant that
-- matters here, and the enum is already enforced by the check constraint.
create table if not exists public.player_settings (
  player_id text primary key references public.players (id) on delete cascade,
  roll_input_mode text not null default 'in_app_only'
    check (roll_input_mode in ('in_app_only', 'manual_only', 'both')),
  updated_at timestamptz not null default now()
);

alter table public.player_settings enable row level security;

create policy "player_settings are readable by their own player"
  on public.player_settings for select
  to authenticated
  using (player_id = public.current_player_id());

create policy "player_settings are insertable by their own player"
  on public.player_settings for insert
  to authenticated
  with check (player_id = public.current_player_id());

create policy "player_settings are updatable by their own player"
  on public.player_settings for update
  to authenticated
  using (player_id = public.current_player_id())
  with check (player_id = public.current_player_id());

-- Submits the caller's own manually-entered layer-0 roll for a closed round —
-- the "manual" counterpart to submit_roll (0005). The value is client-supplied
-- and trusted with no verification beyond the 1-20 range check (the spec's
-- "no verification beyond range"; the table's own check constraint would
-- catch an out-of-range value too, but this gives a clearer error). Every
-- other gate (round closed, caller declared in, one roll per round via the
-- (round_id, player_id, layer) primary key) matches submit_roll exactly, so
-- the two land in the same rolls table under the same hidden-until-
-- personally-submitted RLS policy regardless of which input mode produced
-- the row.
create or replace function public.submit_manual_roll(p_round_id uuid, p_value integer)
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
begin
  if p_value is null or p_value < 1 or p_value > 20 then
    raise exception 'submit_manual_roll: value must be between 1 and 20';
  end if;

  v_player_id := public.current_player_id();

  select status, room_id into v_status, v_room_id
    from public.rounds
   where id = p_round_id;

  if v_status is null then
    raise exception 'submit_manual_roll: round not found';
  end if;

  if v_status <> 'closed' then
    raise exception 'submit_manual_roll: round is not closed for rolling';
  end if;

  if not exists (
    select 1 from public.round_participants
     where round_id = p_round_id and player_id = v_player_id
  ) then
    raise exception 'submit_manual_roll: caller did not declare in for this round';
  end if;

  select modifier into v_modifier
    from public.room_players
   where room_id = v_room_id and player_id = v_player_id;

  insert into public.rolls (round_id, player_id, layer, value, input_mode, modifier_snapshot)
  values (p_round_id, v_player_id, 0, p_value, 'manual', v_modifier);
end;
$$;

revoke execute on function public.submit_manual_roll(uuid, integer) from public, anon;
grant execute on function public.submit_manual_roll(uuid, integer) to authenticated;
