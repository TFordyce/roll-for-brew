-- Acting As puppeting + End Test Session (issue #102). Vocabulary and
-- rationale: CONTEXT.md, docs/adr/0001-admin-puppeting-via-current-player-id-override.md.
--
-- The server-side Acting As pointer: one row per admin, null acting_as_player_id
-- means "acting as self". No RLS select/insert/update policies are granted to
-- authenticated — every access goes through the security-definer functions
-- below, so the pointer can never be read or forged by a raw client query
-- (same "no direct policy" convention as spell_casts/spell_active_effects).
create table if not exists public.admin_acting_as (
  admin_player_id text primary key references public.players (id) on delete cascade,
  acting_as_player_id text references public.players (id) on delete set null
);

alter table public.admin_acting_as enable row level security;

-- current_player_id() (0004_round_lifecycle.sql) gains an optional
-- round/room-context parameter. Existing call sites that pass no arguments
-- (RLS policies and RPCs with no round/room in scope — player_settings,
-- spell_deck_instances/spell_draws direct reads, etc.) keep resolving to the
-- real caller exactly as before, since with no context there is nothing to
-- check the pointer against. Call sites that DO have a round or room in
-- scope are updated below to pass it through, so the override can apply —
-- but only when that round/room is the Test Room (ADR 0002) and the real
-- caller is a flagged admin with a non-null pointer. p_round_id is resolved
-- to its room internally so callers only ever need to pass whichever one
-- they already have in hand.
drop function if exists public.current_player_id();

create function public.current_player_id(p_round_id uuid default null, p_room_id uuid default null)
returns text
language plpgsql
security definer
set search_path = public
as $$
declare
  v_real_player_id text;
  v_room_id uuid;
  v_is_admin boolean;
  v_acting_as text;
begin
  select coalesce(u.raw_user_meta_data ->> 'sub', u.id::text)
    into v_real_player_id
    from auth.users u
   where u.id = auth.uid();

  if v_real_player_id is null then
    raise exception 'current_player_id: no authenticated user';
  end if;

  v_room_id := p_room_id;
  if v_room_id is null and p_round_id is not null then
    select room_id into v_room_id from public.rounds where id = p_round_id;
  end if;

  if v_room_id is not null then
    select p.is_admin, a.acting_as_player_id
      into v_is_admin, v_acting_as
      from public.players p
      left join public.admin_acting_as a on a.admin_player_id = p.id
     where p.id = v_real_player_id;

    if coalesce(v_is_admin, false) and v_acting_as is not null
       and exists (select 1 from public.rooms where id = v_room_id and is_test) then
      return v_acting_as;
    end if;
  end if;

  return v_real_player_id;
end;
$$;

revoke execute on function public.current_player_id(uuid, uuid) from public, anon;
grant execute on function public.current_player_id(uuid, uuid) to authenticated;

-- Sets/clears the caller's Acting As pointer. Admin-only; picking your own
-- real id clears the pointer (acting as self), same as never having set one.
create or replace function public.set_acting_as(p_target_player_id text)
returns void
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
    raise exception 'set_acting_as: caller is not an admin';
  end if;

  if p_target_player_id is not null and not exists (
    select 1 from public.players where id = p_target_player_id
  ) then
    raise exception 'set_acting_as: target player not found';
  end if;

  insert into public.admin_acting_as (admin_player_id, acting_as_player_id)
  values (v_caller, nullif(p_target_player_id, v_caller))
  on conflict (admin_player_id) do update set acting_as_player_id = excluded.acting_as_player_id;
end;
$$;

revoke execute on function public.set_acting_as(text) from public, anon;
grant execute on function public.set_acting_as(text) to authenticated;

-- The caller's own current pointer (or null), for the switcher to show which
-- selection is active. Never takes a target parameter, so it can't be used
-- to read another admin's pointer.
create or replace function public.get_acting_as()
returns text
language plpgsql
security definer
set search_path = public
as $$
declare
  v_caller text;
  v_acting_as text;
begin
  v_caller := public.current_player_id();

  select acting_as_player_id into v_acting_as
    from public.admin_acting_as
   where admin_player_id = v_caller;

  return v_acting_as;
end;
$$;

revoke execute on function public.get_acting_as() from public, anon;
grant execute on function public.get_acting_as() to authenticated;

-- Cascade-deletes the Test Room's rounds (and everything that cascades from
-- a round via existing FKs — round_participants, round_layer_participants,
-- rolls, spell_casts, spell_reaction_windows/passes) plus the Test Room's
-- active effects (spell_active_effects references room_id directly, not
-- round_id, so it isn't reached by the round cascade and needs its own
-- delete). Leaves the room row, its room_players roster, and every player
-- row untouched — held/pending spell cards are likewise left alone, since
-- the acceptance criteria scope End Test Session to rounds/rolls/casts/
-- effects only.
create or replace function public.end_test_session()
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_caller text;
  v_is_admin boolean;
  v_test_room_id uuid;
begin
  v_caller := public.current_player_id();

  select is_admin into v_is_admin from public.players where id = v_caller;
  if not coalesce(v_is_admin, false) then
    raise exception 'end_test_session: caller is not an admin';
  end if;

  select id into v_test_room_id from public.rooms where is_test limit 1;
  if v_test_room_id is null then
    raise exception 'end_test_session: test room not found';
  end if;

  delete from public.spell_active_effects where room_id = v_test_room_id;
  delete from public.rounds where room_id = v_test_room_id;
end;
$$;

revoke execute on function public.end_test_session() from public, anon;
grant execute on function public.end_test_session() to authenticated;

-- rolls' select policy (0005) now passes the row's own round_id through, so
-- an admin puppeting a Test Player can read that player's in-progress roll
-- (still gated the same way for everyone else: your own roll, or anyone's
-- once the round is resolved).
drop policy if exists "rolls are readable by the roller, or by anyone once resolved" on public.rolls;

create policy "rolls are readable by the roller, or by anyone once resolved"
  on public.rolls for select
  to authenticated
  using (
    player_id = public.current_player_id(rolls.round_id)
    or exists (
      select 1 from public.rounds r
       where r.id = rolls.round_id and r.status = 'resolved'
    )
  );

-- start_round (0004) gains an optional target-room parameter so it can open
-- a round in the dateless Test Room, which enter_todays_room's date lookup
-- can never find. Real gameplay is unaffected: the TS wrapper still calls
-- this with no arguments, so p_room_id defaults null and today's-room-by-
-- date lookup behaves exactly as before.
drop function if exists public.start_round();

create function public.start_round(p_room_id uuid default null)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_player_id text;
  v_date date;
  v_room_id uuid;
  v_round_id uuid;
begin
  if p_room_id is not null then
    v_room_id := p_room_id;
  else
    v_date := (now() at time zone 'Europe/London')::date;
    select id into v_room_id from public.rooms where date = v_date;
  end if;

  if v_room_id is null then
    raise exception 'start_round: no room for today';
  end if;

  v_player_id := public.current_player_id(null, v_room_id);

  insert into public.rounds (room_id, started_by, status)
  values (v_room_id, v_player_id, 'open')
  returning id into v_round_id;

  insert into public.round_participants (round_id, player_id)
  values (v_round_id, v_player_id);

  return v_round_id;
end;
$$;

revoke execute on function public.start_round(uuid) from public, anon;
grant execute on function public.start_round(uuid) to authenticated;

create or replace function public.declare_in(p_round_id uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_player_id text;
  v_status text;
  v_room_id uuid;
begin
  v_player_id := public.current_player_id(p_round_id);

  select status, room_id into v_status, v_room_id
    from public.rounds
   where id = p_round_id;

  if v_status is null then
    raise exception 'declare_in: round not found';
  end if;

  if v_status <> 'open' then
    raise exception 'declare_in: round is not open for declarations'
      using errcode = 'RFB05';
  end if;

  if not exists (
    select 1 from public.room_players
     where room_id = v_room_id and player_id = v_player_id
  ) then
    raise exception 'declare_in: caller is not present in this round''s room';
  end if;

  insert into public.round_participants (round_id, player_id)
  values (p_round_id, v_player_id)
  on conflict (round_id, player_id) do nothing;
end;
$$;

revoke execute on function public.declare_in(uuid) from public, anon;
grant execute on function public.declare_in(uuid) to authenticated;

create or replace function public.close_round(p_round_id uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_player_id text;
  v_status text;
  v_started_by text;
  v_declared_count integer;
begin
  v_player_id := public.current_player_id(p_round_id);

  select status, started_by into v_status, v_started_by
    from public.rounds
   where id = p_round_id
   for update;

  if v_status is null then
    raise exception 'close_round: round not found';
  end if;

  if v_status <> 'open' then
    raise exception 'close_round: round is not open';
  end if;

  if v_started_by <> v_player_id then
    raise exception 'close_round: only the round starter can close declarations';
  end if;

  select count(*) into v_declared_count
    from public.round_participants
   where round_id = p_round_id;

  if v_declared_count < 2 then
    raise exception 'close_round: at least 2 players must declare in before closing';
  end if;

  update public.rounds set status = 'closed', closed_at = now() where id = p_round_id;
end;
$$;

revoke execute on function public.close_round(uuid) from public, anon;
grant execute on function public.close_round(uuid) to authenticated;

create or replace function public.submit_roll(p_round_id uuid)
returns integer
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
  v_second_value integer;
  v_has_advantage boolean;
  v_has_disadvantage boolean;
begin
  v_player_id := public.current_player_id(p_round_id);

  select status, room_id, current_layer into v_status, v_room_id, v_layer
    from public.rounds
   where id = p_round_id;

  if v_status is null then
    raise exception 'submit_roll: round not found';
  end if;

  if v_status <> 'closed' then
    raise exception 'submit_roll: round is not closed for rolling'
      using errcode = 'RFB01';
  end if;

  if not public.is_expected_layer_roller(p_round_id, v_player_id, v_layer) then
    raise exception 'submit_roll: caller is not expected to roll in the current layer'
      using errcode = 'RFB02';
  end if;

  select modifier into v_modifier
    from public.room_players
   where room_id = v_room_id and player_id = v_player_id;

  v_has_advantage := exists (
    select 1 from public.spell_casts
     where round_id = p_round_id and target_player_id = v_player_id
       and target_pending = false and effect_kind = 'advantage'
  );
  v_has_disadvantage := exists (
    select 1 from public.spell_casts
     where round_id = p_round_id and target_player_id = v_player_id
       and target_pending = false and effect_kind = 'disadvantage'
  );

  v_value := floor(random() * 20 + 1)::integer;

  if v_has_advantage <> v_has_disadvantage then
    v_second_value := floor(random() * 20 + 1)::integer;
    if v_has_advantage then
      v_value := greatest(v_value, v_second_value);
    else
      v_value := least(v_value, v_second_value);
    end if;
  end if;

  insert into public.rolls (round_id, player_id, layer, value, input_mode, modifier_snapshot)
  values (p_round_id, v_player_id, v_layer, v_value, 'in_app', v_modifier);

  return v_value;
end;
$$;

revoke execute on function public.submit_roll(uuid) from public, anon;
grant execute on function public.submit_roll(uuid) to authenticated;

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
  v_layer integer;
  v_modifier integer;
begin
  if p_value is null or p_value < 1 or p_value > 20 then
    raise exception 'submit_manual_roll: value must be between 1 and 20';
  end if;

  v_player_id := public.current_player_id(p_round_id);

  select status, room_id, current_layer into v_status, v_room_id, v_layer
    from public.rounds
   where id = p_round_id;

  if v_status is null then
    raise exception 'submit_manual_roll: round not found';
  end if;

  if v_status <> 'closed' then
    raise exception 'submit_manual_roll: round is not closed for rolling'
      using errcode = 'RFB01';
  end if;

  if not public.is_expected_layer_roller(p_round_id, v_player_id, v_layer) then
    raise exception 'submit_manual_roll: caller is not expected to roll in the current layer'
      using errcode = 'RFB02';
  end if;

  select modifier into v_modifier
    from public.room_players
   where room_id = v_room_id and player_id = v_player_id;

  insert into public.rolls (round_id, player_id, layer, value, input_mode, modifier_snapshot)
  values (p_round_id, v_player_id, v_layer, p_value, 'manual', v_modifier);
end;
$$;

revoke execute on function public.submit_manual_roll(uuid, integer) from public, anon;
grant execute on function public.submit_manual_roll(uuid, integer) to authenticated;

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
  v_player_id := public.current_player_id(p_round_id);

  select current_layer into v_layer from public.rounds where id = p_round_id;

  if v_layer is null then
    raise exception 'get_current_layer_rolls_if_complete: round not found';
  end if;

  if not public.is_expected_layer_roller(p_round_id, v_player_id, v_layer) then
    raise exception 'get_current_layer_rolls_if_complete: caller is not expected to roll in the current layer'
      using errcode = 'RFB02';
  end if;

  v_expected_count := public.count_expected_layer_rollers(p_round_id, v_layer);

  select count(*) into v_roll_count
    from public.rolls r
   where r.round_id = p_round_id and r.layer = v_layer;

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

create or replace function public.cast_spell_card(p_round_id uuid, p_target_player_id text default null)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_player_id text;
  v_status text;
  v_room_id uuid;
  v_instance_id uuid;
  v_card_id uuid;
  v_casting_time text;
  v_target_stamp text;
  v_effect_kind text;
  v_effect_params jsonb;
  v_resolved_value numeric;
  v_target_pending boolean := false;
  v_final_target text := p_target_player_id;
  v_cast_id uuid;
  v_dice_count integer;
  v_dice_sides integer;
  v_dice_sign integer;
  v_roll_total integer;
begin
  v_player_id := public.current_player_id(p_round_id);

  select status, room_id into v_status, v_room_id from public.rounds where id = p_round_id;

  if v_status is null then
    raise exception 'cast_spell_card: round not found';
  end if;

  if v_status <> 'open' then
    raise exception 'cast_spell_card: round is not open for pre-roll casting'
      using errcode = 'RFB03';
  end if;

  select sdi.id, sc.id, sc.casting_time, sc.target, sc.effect_kind, sc.effect_params
    into v_instance_id, v_card_id, v_casting_time, v_target_stamp, v_effect_kind, v_effect_params
    from public.spell_deck_instances sdi
    join public.spell_cards sc on sc.id = sdi.card_id
   where sdi.held_by_player = v_player_id and sdi.location = 'held';

  if v_instance_id is null then
    raise exception 'cast_spell_card: caller is not holding a card';
  end if;

  if v_casting_time <> 'A' then
    raise exception 'cast_spell_card: only Action cards can be cast pre-roll';
  end if;

  if v_target_stamp = 'SELF' then
    if p_target_player_id is not null and p_target_player_id <> v_player_id then
      raise exception 'cast_spell_card: this card can only target yourself';
    end if;
    v_final_target := v_player_id;
  elsif v_target_stamp in ('OPPONENT', 'PLAYER') then
    if p_target_player_id is null then
      v_target_pending := true;
      v_final_target := null;
    else
      if v_target_stamp = 'OPPONENT' and p_target_player_id = v_player_id then
        raise exception 'cast_spell_card: this card cannot target yourself';
      end if;
      if not exists (
        select 1 from public.round_participants
         where round_id = p_round_id and player_id = p_target_player_id
      ) then
        raise exception 'cast_spell_card: target is not a participant in this round';
      end if;
    end if;
  else
    raise exception 'cast_spell_card: % -targeted cards cannot be cast pre-roll yet', v_target_stamp;
  end if;

  update public.spell_deck_instances
     set location = 'in_deck', held_by_player = null
   where id = v_instance_id;

  if v_effect_kind = 'dice_modifier' then
    v_dice_count := (regexp_match(v_effect_params ->> 'dice', '^(\d+)d(\d+)$'))[1]::integer;
    v_dice_sides := (regexp_match(v_effect_params ->> 'dice', '^(\d+)d(\d+)$'))[2]::integer;
    v_dice_sign := coalesce((v_effect_params ->> 'sign')::integer, 1);

    v_roll_total := 0;
    for i in 1..v_dice_count loop
      v_roll_total := v_roll_total + floor(random() * v_dice_sides + 1)::integer;
    end loop;

    v_resolved_value := v_roll_total * v_dice_sign;
  end if;

  insert into public.spell_casts (
    round_id, caster_id, card_instance_id, target_player_id, target_pending,
    effect_kind, effect_params, resolved_value
  )
  values (
    p_round_id, v_player_id, v_instance_id, v_final_target, v_target_pending,
    v_effect_kind, v_effect_params, v_resolved_value
  )
  returning id into v_cast_id;

  if v_final_target is not null then
    perform public.record_active_effect_if_persistent(v_room_id, v_player_id, v_final_target, v_card_id, v_cast_id);
  end if;

  return v_cast_id;
end;
$$;

revoke execute on function public.cast_spell_card(uuid, text) from public, anon;
grant execute on function public.cast_spell_card(uuid, text) to authenticated;

create or replace function public.set_spell_cast_target(p_cast_id uuid, p_target_player_id text)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_player_id text;
  v_round_id uuid;
  v_room_id uuid;
  v_caster_id text;
  v_target_pending boolean;
  v_status text;
  v_target_stamp text;
  v_card_id uuid;
begin
  select round_id, caster_id, target_pending
    into v_round_id, v_caster_id, v_target_pending
    from public.spell_casts
   where id = p_cast_id;

  if v_round_id is null then
    raise exception 'set_spell_cast_target: cast not found';
  end if;

  v_player_id := public.current_player_id(v_round_id);

  if v_caster_id <> v_player_id then
    raise exception 'set_spell_cast_target: only the caster can set this cast''s target';
  end if;

  if not v_target_pending then
    raise exception 'set_spell_cast_target: this cast is not awaiting a target';
  end if;

  select status, room_id into v_status, v_room_id from public.rounds where id = v_round_id;

  if v_status <> 'closed' then
    raise exception 'set_spell_cast_target: round is not yet closed for targeting'
      using errcode = 'RFB03';
  end if;

  select sc.target, sc.id into v_target_stamp, v_card_id
    from public.spell_casts casts
    join public.spell_deck_instances sdi on sdi.id = casts.card_instance_id
    join public.spell_cards sc on sc.id = sdi.card_id
   where casts.id = p_cast_id;

  if v_target_stamp = 'OPPONENT' and p_target_player_id = v_player_id then
    raise exception 'set_spell_cast_target: this card cannot target yourself';
  end if;

  if not exists (
    select 1 from public.round_participants
     where round_id = v_round_id and player_id = p_target_player_id
  ) then
    raise exception 'set_spell_cast_target: target is not a participant in this round';
  end if;

  update public.spell_casts
     set target_player_id = p_target_player_id, target_pending = false
   where id = p_cast_id;

  perform public.record_active_effect_if_persistent(v_room_id, v_caster_id, p_target_player_id, v_card_id, p_cast_id);
end;
$$;

revoke execute on function public.set_spell_cast_target(uuid, text) from public, anon;
grant execute on function public.set_spell_cast_target(uuid, text) to authenticated;

create or replace function public.get_round_modifier_effects(p_round_id uuid)
returns table (target_player_id text, effect_kind text, effect_params jsonb, resolved_value numeric)
language plpgsql
security definer
set search_path = public
as $$
declare
  v_player_id text;
  v_room_id uuid;
begin
  v_player_id := public.current_player_id(p_round_id);

  if not exists (
    select 1 from public.round_participants
     where round_id = p_round_id and player_id = v_player_id
  ) then
    raise exception 'get_round_modifier_effects: caller is not a participant in this round';
  end if;

  select room_id into v_room_id from public.rounds where id = p_round_id;

  return query
    select casts.target_player_id, casts.effect_kind, casts.effect_params, casts.resolved_value
      from public.spell_casts casts
      join public.spell_deck_instances sdi on sdi.id = casts.card_instance_id
      join public.spell_cards sc on sc.id = sdi.card_id
     where casts.round_id = p_round_id
       and casts.target_pending = false
       and casts.negated = false
       and casts.effect_kind in ('flat_modifier', 'dice_modifier', 'modifier_multiplier', 'set_modifier')
       and sc.duration_rounds is null
    union all
    select sae.target_player_id, sae.effect_kind, sae.effect_params, null::numeric
      from public.spell_active_effects sae
     where sae.room_id = v_room_id
       and sae.effect_kind in ('flat_modifier', 'dice_modifier', 'modifier_multiplier', 'set_modifier');
end;
$$;

revoke execute on function public.get_round_modifier_effects(uuid) from public, anon;
grant execute on function public.get_round_modifier_effects(uuid) to authenticated;

create or replace function public.get_my_pending_casts(p_round_id uuid)
returns table (cast_id uuid, card_name text, target text)
language plpgsql
security definer
set search_path = public
as $$
declare
  v_player_id text;
begin
  v_player_id := public.current_player_id(p_round_id);

  return query
    select casts.id, sc.name, sc.target
      from public.spell_casts casts
      join public.spell_deck_instances sdi on sdi.id = casts.card_instance_id
      join public.spell_cards sc on sc.id = sdi.card_id
     where casts.round_id = p_round_id
       and casts.caster_id = v_player_id
       and casts.target_pending = true;
end;
$$;

revoke execute on function public.get_my_pending_casts(uuid) from public, anon;
grant execute on function public.get_my_pending_casts(uuid) to authenticated;

create or replace function public.get_dispellable_active_effects(p_round_id uuid)
returns table (
  effect_id uuid, target_player_id text, target_display_name text, card_name text, tier text
)
language plpgsql
security definer
set search_path = public
as $$
declare
  v_player_id text;
  v_room_id uuid;
  v_effect_kind text;
  v_effect_params jsonb;
  v_tiers text[];
begin
  v_player_id := public.current_player_id(p_round_id);

  select room_id into v_room_id from public.rounds where id = p_round_id;

  if v_room_id is null then
    raise exception 'get_dispellable_active_effects: round not found';
  end if;

  select gh.effect_kind, gh.effect_params
    into v_effect_kind, v_effect_params
    from public.get_held_card_effect(v_player_id) gh;

  if v_effect_kind is distinct from 'dispel' then
    return;
  end if;

  select array(select jsonb_array_elements_text(v_effect_params -> 'tiers')) into v_tiers;

  return query
    select sae.id, sae.target_player_id, coalesce(p.display_name, p.email), sc2.name, sc2.tier
      from public.spell_active_effects sae
      join public.spell_cards sc2 on sc2.id = sae.card_id
      join public.players p on p.id = sae.target_player_id
     where sae.room_id = v_room_id
       and sc2.tier = any(v_tiers);
end;
$$;

revoke execute on function public.get_dispellable_active_effects(uuid) from public, anon;
grant execute on function public.get_dispellable_active_effects(uuid) to authenticated;

create or replace function public.end_active_effect(p_round_id uuid, p_effect_id uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_player_id text;
  v_status text;
  v_room_id uuid;
  v_instance_id uuid;
  v_casting_time text;
  v_effect_kind text;
  v_effect_params jsonb;
  v_tiers text[];
  v_target_player_id text;
  v_target_tier text;
  v_target_room_id uuid;
begin
  v_player_id := public.current_player_id(p_round_id);

  select status, room_id into v_status, v_room_id from public.rounds where id = p_round_id;

  if v_status is null then
    raise exception 'end_active_effect: round not found';
  end if;

  if v_status <> 'open' then
    raise exception 'end_active_effect: round is not open for pre-roll casting'
      using errcode = 'RFB03';
  end if;

  select gh.instance_id, gh.casting_time, gh.effect_kind, gh.effect_params
    into v_instance_id, v_casting_time, v_effect_kind, v_effect_params
    from public.get_held_card_effect(v_player_id) gh;

  if v_instance_id is null then
    raise exception 'end_active_effect: caller is not holding a card';
  end if;

  if v_effect_kind <> 'dispel' then
    raise exception 'end_active_effect: held card cannot end active effects';
  end if;

  if v_casting_time <> 'A' then
    raise exception 'end_active_effect: only Action cards can be cast pre-roll';
  end if;

  select array(select jsonb_array_elements_text(v_effect_params -> 'tiers')) into v_tiers;

  select sae.target_player_id, sc2.tier, sae.room_id
    into v_target_player_id, v_target_tier, v_target_room_id
    from public.spell_active_effects sae
    join public.spell_cards sc2 on sc2.id = sae.card_id
   where sae.id = p_effect_id;

  if v_target_player_id is null then
    raise exception 'end_active_effect: active effect not found';
  end if;

  if v_target_room_id <> v_room_id then
    raise exception 'end_active_effect: active effect is not in this room';
  end if;

  if not (v_target_tier = any(v_tiers)) then
    raise exception 'end_active_effect: held card cannot end a % effect', v_target_tier;
  end if;

  delete from public.spell_active_effects where id = p_effect_id;

  update public.spell_deck_instances
     set location = 'in_deck', held_by_player = null
   where id = v_instance_id;

  insert into public.spell_casts (
    round_id, caster_id, card_instance_id, target_player_id, effect_kind, effect_params
  )
  values (
    p_round_id, v_player_id, v_instance_id, v_target_player_id, 'dispel',
    jsonb_build_object('ended_effect_id', p_effect_id)
  );
end;
$$;

revoke execute on function public.end_active_effect(uuid, uuid) from public, anon;
grant execute on function public.end_active_effect(uuid, uuid) to authenticated;

create or replace function public.get_room_active_effects(p_room_id uuid)
returns table (
  effect_id uuid, target_player_id text, card_name text, tier text, polarity text, rounds_remaining integer
)
language plpgsql
security definer
set search_path = public
as $$
declare
  v_player_id text;
begin
  v_player_id := public.current_player_id(null, p_room_id);

  if not exists (
    select 1 from public.room_players
     where room_id = p_room_id and player_id = v_player_id
  ) then
    raise exception 'get_room_active_effects: caller is not a member of this room';
  end if;

  return query
    select sae.id, sae.target_player_id, sc.name, sc.tier, sc.polarity, sae.rounds_remaining
      from public.spell_active_effects sae
      join public.spell_cards sc on sc.id = sae.card_id
     where sae.room_id = p_room_id;
end;
$$;

revoke execute on function public.get_room_active_effects(uuid) from public, anon;
grant execute on function public.get_room_active_effects(uuid) to authenticated;

create or replace function public.get_open_reaction_window(p_round_id uuid)
returns table (window_id uuid, layer integer, poll_round integer, eligible boolean, already_passed boolean)
language plpgsql
security definer
set search_path = public
as $$
declare
  v_player_id text;
begin
  v_player_id := public.current_player_id(p_round_id);

  return query
    select w.id, w.layer, w.poll_round,
      exists (
        select 1 from public.spell_deck_instances sdi
        join public.spell_cards sc on sc.id = sdi.card_id
       where sdi.held_by_player = v_player_id and sdi.location = 'held' and sc.casting_time = 'R'
         and exists (
           select 1 from public.round_participants rp
            where rp.round_id = p_round_id and rp.player_id = v_player_id
         )
      ),
      exists (
        select 1 from public.spell_reaction_passes p
         where p.window_id = w.id and p.poll_round = w.poll_round and p.player_id = v_player_id
      )
      from public.spell_reaction_windows w
     where w.round_id = p_round_id and w.status = 'open'
     order by w.opened_at desc
     limit 1;
end;
$$;

revoke execute on function public.get_open_reaction_window(uuid) from public, anon;
grant execute on function public.get_open_reaction_window(uuid) to authenticated;

create or replace function public.cast_reaction_spell_card(
  p_round_id uuid, p_target_player_id text default null, p_target_cast_id uuid default null
)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_player_id text;
  v_window_id uuid;
  v_instance_id uuid;
  v_card_id uuid;
  v_casting_time text;
  v_target_stamp text;
  v_effect_kind text;
  v_effect_params jsonb;
  v_resolved_value numeric;
  v_final_target text := p_target_player_id;
  v_cast_id uuid;
  v_dice_count integer;
  v_dice_sides integer;
  v_dice_sign integer;
  v_roll_total integer;
  v_target_tier text;
  v_target_target_player text;
  v_dc integer;
  v_roll integer;
begin
  v_player_id := public.current_player_id(p_round_id);

  select id into v_window_id
    from public.spell_reaction_windows
   where round_id = p_round_id and status = 'open'
   order by opened_at desc
   limit 1
     for update;

  if v_window_id is null then
    raise exception 'cast_reaction_spell_card: no open reaction window for this round'
      using errcode = 'RFB04';
  end if;

  if not exists (
    select 1 from public.round_participants
     where round_id = p_round_id and player_id = v_player_id
  ) then
    raise exception 'cast_reaction_spell_card: caller is not a participant in this round';
  end if;

  select sdi.id, sc.id, sc.casting_time, sc.target, sc.effect_kind, sc.effect_params
    into v_instance_id, v_card_id, v_casting_time, v_target_stamp, v_effect_kind, v_effect_params
    from public.spell_deck_instances sdi
    join public.spell_cards sc on sc.id = sdi.card_id
   where sdi.held_by_player = v_player_id and sdi.location = 'held';

  if v_instance_id is null then
    raise exception 'cast_reaction_spell_card: caller is not holding a card';
  end if;

  if v_casting_time <> 'R' then
    raise exception 'cast_reaction_spell_card: only Reaction cards can be cast into a reaction window';
  end if;

  if v_target_stamp = 'CARD' then
    if p_target_cast_id is null then
      raise exception 'cast_reaction_spell_card: this card requires a target cast';
    end if;
    select casts.target_player_id, sc2.tier
      into v_target_target_player, v_target_tier
      from public.spell_casts casts
      join public.spell_deck_instances sdi2 on sdi2.id = casts.card_instance_id
      join public.spell_cards sc2 on sc2.id = sdi2.card_id
     where casts.id = p_target_cast_id and casts.round_id = p_round_id;

    if v_target_tier is null then
      raise exception 'cast_reaction_spell_card: target cast not found in this round';
    end if;
    v_final_target := null;
  elsif v_target_stamp = 'SELF' then
    v_final_target := v_player_id;
  elsif v_target_stamp in ('OPPONENT', 'PLAYER') then
    if p_target_player_id is null then
      raise exception 'cast_reaction_spell_card: this card requires a target player';
    end if;
    if v_target_stamp = 'OPPONENT' and p_target_player_id = v_player_id then
      raise exception 'cast_reaction_spell_card: this card cannot target yourself';
    end if;
    if not exists (
      select 1 from public.round_participants
       where round_id = p_round_id and player_id = p_target_player_id
    ) then
      raise exception 'cast_reaction_spell_card: target is not a participant in this round';
    end if;
  else
    raise exception 'cast_reaction_spell_card: % -targeted cards cannot be cast as a reaction yet', v_target_stamp;
  end if;

  update public.spell_deck_instances
     set location = 'in_deck', held_by_player = null
   where id = v_instance_id;

  if v_effect_kind = 'dice_modifier' then
    v_dice_count := (regexp_match(v_effect_params ->> 'dice', '^(\d+)d(\d+)$'))[1]::integer;
    v_dice_sides := (regexp_match(v_effect_params ->> 'dice', '^(\d+)d(\d+)$'))[2]::integer;
    v_dice_sign := coalesce((v_effect_params ->> 'sign')::integer, 1);

    v_roll_total := 0;
    for i in 1..v_dice_count loop
      v_roll_total := v_roll_total + floor(random() * v_dice_sides + 1)::integer;
    end loop;

    v_resolved_value := v_roll_total * v_dice_sign;
  end if;

  insert into public.spell_casts (
    round_id, caster_id, card_instance_id, target_player_id, target_pending,
    effect_kind, effect_params, resolved_value, parent_cast_id, reaction_window_id
  )
  values (
    p_round_id, v_player_id, v_instance_id, v_final_target, false,
    v_effect_kind, v_effect_params, v_resolved_value, p_target_cast_id, v_window_id
  )
  returning id into v_cast_id;

  if v_effect_kind = 'contested_negate' then
    v_dc := case v_target_tier when 'common' then 2 when 'rare' then 5 else 10 end;
    v_roll := floor(random() * 20 + 1)::integer;

    update public.spell_casts set resolved_value = v_roll where id = v_cast_id;

    if v_roll >= v_dc then
      update public.spell_casts set negated = true where id = p_target_cast_id;
    end if;
  elsif v_effect_kind = 'redirect' then
    update public.spell_casts set resolved_value = 1 where id = v_cast_id;

    if v_target_target_player is not null then
      update public.spell_casts set target_player_id = v_player_id where id = p_target_cast_id;
    end if;
  end if;

  update public.spell_reaction_windows
     set poll_round = poll_round + 1
   where id = v_window_id;

  return v_cast_id;
end;
$$;

revoke execute on function public.cast_reaction_spell_card(uuid, text, uuid) from public, anon;
grant execute on function public.cast_reaction_spell_card(uuid, text, uuid) to authenticated;

create or replace function public.pass_reaction_window(p_round_id uuid)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
declare
  v_player_id text;
  v_window_id uuid;
  v_poll_round integer;
  v_eligible_count integer;
  v_passed_count integer;
  v_closed boolean := false;
begin
  v_player_id := public.current_player_id(p_round_id);

  select id, poll_round into v_window_id, v_poll_round
    from public.spell_reaction_windows
   where round_id = p_round_id and status = 'open'
   order by opened_at desc
   limit 1
     for update;

  if v_window_id is null then
    raise exception 'pass_reaction_window: no open reaction window for this round'
      using errcode = 'RFB04';
  end if;

  insert into public.spell_reaction_passes (window_id, poll_round, player_id)
  values (v_window_id, v_poll_round, v_player_id)
  on conflict (window_id, poll_round, player_id) do nothing;

  select count(*) into v_eligible_count
    from public.spell_deck_instances sdi
    join public.spell_cards sc on sc.id = sdi.card_id
    join public.round_participants rp on rp.player_id = sdi.held_by_player
   where sdi.location = 'held' and sc.casting_time = 'R' and rp.round_id = p_round_id;

  select count(*) into v_passed_count
    from public.spell_reaction_passes p
    join public.spell_deck_instances sdi on sdi.held_by_player = p.player_id
    join public.spell_cards sc on sc.id = sdi.card_id
    join public.round_participants rp on rp.player_id = sdi.held_by_player
   where p.window_id = v_window_id and p.poll_round = v_poll_round
     and sdi.location = 'held' and sc.casting_time = 'R' and rp.round_id = p_round_id;

  if v_passed_count >= v_eligible_count then
    update public.spell_reaction_windows set status = 'closed', closed_at = now()
     where id = v_window_id;
    v_closed := true;
  end if;

  return v_closed;
end;
$$;

revoke execute on function public.pass_reaction_window(uuid) from public, anon;
grant execute on function public.pass_reaction_window(uuid) to authenticated;

-- get_my_spell_cards/draw_spell_card/resolve_card_swap (0018/0020) gain an
-- optional room-context parameter: spell_deck_instances holds are global,
-- not round-scoped (see 0018's header comment), so unlike the round-flow
-- RPCs above there's no round id to derive a room from — callers pass the
-- room id they already have directly. Real gameplay call sites are
-- unaffected: passing no argument keeps resolving to the real caller.
drop function if exists public.get_my_spell_cards();

create function public.get_my_spell_cards(p_room_id uuid default null)
returns table (
  instance_id uuid,
  location text,
  card_name text,
  casting_time text,
  target text,
  tier text,
  effect_text text,
  effect_kind text
)
language plpgsql
security definer
set search_path = public
as $$
declare
  v_player_id text;
begin
  v_player_id := public.current_player_id(null, p_room_id);

  return query
    select sdi.id, sdi.location, sc.name, sc.casting_time, sc.target, sc.tier, sc.effect_text, sc.effect_kind
      from public.spell_deck_instances sdi
      join public.spell_cards sc on sc.id = sdi.card_id
     where sdi.held_by_player = v_player_id
       and sdi.location in ('held', 'pending_swap');
end;
$$;

revoke execute on function public.get_my_spell_cards(uuid) from public, anon;
grant execute on function public.get_my_spell_cards(uuid) to authenticated;

drop function if exists public.draw_spell_card(text);

create function public.draw_spell_card(p_trigger text, p_room_id uuid default null)
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
  v_player_id := public.current_player_id(null, p_room_id);

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

revoke execute on function public.draw_spell_card(text, uuid) from public, anon;
grant execute on function public.draw_spell_card(text, uuid) to authenticated;

drop function if exists public.resolve_card_swap(boolean);

create function public.resolve_card_swap(p_keep_new boolean, p_room_id uuid default null)
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
  v_player_id := public.current_player_id(null, p_room_id);

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

revoke execute on function public.resolve_card_swap(boolean, uuid) from public, anon;
grant execute on function public.resolve_card_swap(boolean, uuid) to authenticated;
