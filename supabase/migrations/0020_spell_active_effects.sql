-- Spell Cards 4/5: lasting/persistent effects (issue #69, child of the
-- spell-cards spec map #65). Blocked-by #67's pre-roll casting (0019),
-- whose targeting and modifier-bucket composition this reuses.
--
-- spell_active_effects tracks effects that outlive a single round/cast,
-- deliberately separate from spell_casts (which stays the per-cast audit
-- log): duration bookkeeping (rounds_remaining, decremented once per
-- resolved round) lives only here, so a round's modifier-bucket read never
-- has to duplicate this state into a per-round row.
--
-- Two catalog cards are wired end-to-end to exercise this: Caffeine Crash
-- (rare, OPPONENT) — "target's modifier is treated as -1 for the next 2
-- rounds" — proves a persistent effect composes numerically into
-- get_round_modifier_effects across rounds and then expires; Cloud of Cream
-- (common, SELF) — "for the next 2 rounds your modifier is hidden" — is a
-- common-tier persistent effect for Lesser Detox (common-tier-only, per its
-- card text) to target and end early. Every other card's duration/polarity
-- stays null/unmapped, same narrow-scope convention as 0017/0019.
create table if not exists public.spell_active_effects (
  id uuid primary key default gen_random_uuid(),
  room_id uuid not null references public.rooms (id) on delete cascade,
  target_player_id text not null references public.players (id),
  caster_id text not null references public.players (id),
  source_cast_id uuid references public.spell_casts (id) on delete set null,
  card_id uuid not null references public.spell_cards (id),
  effect_kind text not null
    check (effect_kind in ('flat_modifier', 'dice_modifier', 'modifier_multiplier', 'set_modifier', 'hidden_modifier')),
  effect_params jsonb not null default '{}'::jsonb,
  rounds_remaining integer not null check (rounds_remaining > 0),
  created_at timestamptz not null default now()
);

alter table public.spell_active_effects enable row level security;

-- No direct select policy: badge visibility (which player, which polarity)
-- is a narrow, deliberately-shaped read via get_room_active_effects below —
-- same reasoning as spell_casts having no direct select policy (0019).
-- No insert/update/delete policies: writes only via the security-definer
-- functions below.

-- Cards need a declared duration (persistent) and, for the roster badge,
-- a polarity (red for negative/debuff, gold for positive/buff) — both null
-- for the many cards not yet mapped to a concrete effect, same convention
-- as effect_kind/effect_params staying null until a card is wired up.
alter table public.spell_cards add column if not exists duration_rounds integer check (duration_rounds is null or duration_rounds > 0);
alter table public.spell_cards add column if not exists polarity text check (polarity is null or polarity in ('positive', 'negative'));

alter table public.spell_cards drop constraint if exists spell_cards_effect_kind_check;
alter table public.spell_cards add constraint spell_cards_effect_kind_check
  check (effect_kind in ('flat_modifier', 'dice_modifier', 'modifier_multiplier', 'set_modifier', 'advantage', 'disadvantage', 'hidden_modifier', 'dispel'));

update public.spell_cards
   set effect_kind = 'set_modifier', effect_params = '{"value": -1}'::jsonb,
       duration_rounds = 2, polarity = 'negative'
 where name = 'Caffeine Crash';

update public.spell_cards
   set effect_kind = 'hidden_modifier', effect_params = '{}'::jsonb,
       duration_rounds = 2, polarity = 'positive'
 where name = 'Cloud of Cream';

-- Lesser Detox never creates a persistent effect of its own (it ends one) —
-- effect_params.tiers is the tier scope its card text specifies ("a Common
-- card"), read by end_active_effect/get_dispellable_active_effects below.
update public.spell_cards
   set effect_kind = 'dispel', effect_params = '{"tiers": ["common"]}'::jsonb
 where name = 'Lesser Detox';

-- Shared by cast_spell_card and set_spell_cast_target below: once a cast's
-- final target is known, records a spell_active_effects row if (and only
-- if) the cast card has a declared duration — a no-op for every other card,
-- which keeps composing into get_round_modifier_effects via spell_casts
-- alone, unchanged from 0019.
create or replace function public.record_active_effect_if_persistent(
  p_room_id uuid, p_caster_id text, p_target_player_id text, p_card_id uuid, p_source_cast_id uuid
)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_duration integer;
  v_effect_kind text;
  v_effect_params jsonb;
begin
  select duration_rounds, effect_kind, effect_params
    into v_duration, v_effect_kind, v_effect_params
    from public.spell_cards
   where id = p_card_id;

  if v_duration is null then
    return;
  end if;

  insert into public.spell_active_effects (
    room_id, target_player_id, caster_id, source_cast_id, card_id,
    effect_kind, effect_params, rounds_remaining
  )
  values (
    p_room_id, p_target_player_id, p_caster_id, p_source_cast_id, p_card_id,
    v_effect_kind, v_effect_params, v_duration
  );
end;
$$;

revoke execute on function public.record_active_effect_if_persistent(uuid, text, text, uuid, uuid) from public, anon;

-- Redefines cast_spell_card (0019) to additionally record a persistent
-- effect once the card's final target is known at cast time (SELF cards
-- always are; OPPONENT/PLAYER cards only when not deferred). Everything
-- else — targeting rules, dice-modifier resolution, the RFB03 stale-round
-- race — is unchanged from 0019.
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
  v_player_id := public.current_player_id();

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

-- Redefines set_spell_cast_target (0019) to record a persistent effect once
-- a deferred OPPONENT/PLAYER cast's target is finally known — the only path
-- for a persistent card whose target wasn't decidable at cast time (e.g.
-- Caffeine Crash armed before declare-in closed). Everything else is
-- unchanged from 0019.
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
  v_player_id := public.current_player_id();

  select round_id, caster_id, target_pending
    into v_round_id, v_caster_id, v_target_pending
    from public.spell_casts
   where id = p_cast_id;

  if v_round_id is null then
    raise exception 'set_spell_cast_target: cast not found';
  end if;

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

-- Redefines get_round_modifier_effects (0019) to union in the room's
-- currently-active persistent effects alongside this round's own resolved
-- casts — reading spell_active_effects directly rather than copying its
-- state into a spell_casts row each round, per the map's data-model note.
-- hidden_modifier (Cloud of Cream) and dispel (never persistent) fall
-- outside the effect_kind filter here, same as advantage/disadvantage.
--
-- The spell_casts branch excludes casts of persistent cards (sc.duration_
-- rounds is not null) — record_active_effect_if_persistent already gave
-- that same cast a spell_active_effects row covering this round onward, so
-- reading both branches unfiltered would double-count it on the round it
-- was cast (harmless for "set" kinds since composeModifier's set lookup is
-- idempotent on duplicates, but wrong for flat/multiplier kinds, and wrong
-- either way against this function's "no duplicated effect state" contract).
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
  v_player_id := public.current_player_id();

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

-- Redefines resolve_round (0016) to decrement every active effect in the
-- resolving round's room by one round and drop any that have run out —
-- expiry-on-schedule happens here, once per completed round (not per reroll
-- layer, which advance_round_layer handles separately and never calls this
-- function), so a duration counts calendar rounds regardless of how many
-- reroll layers a given round took.
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

  v_expected_layer_count := public.count_expected_layer_rollers(p_round_id, v_layer);

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

  update public.spell_active_effects
     set rounds_remaining = rounds_remaining - 1
   where room_id = v_room_id;

  delete from public.spell_active_effects
   where room_id = v_room_id and rounds_remaining <= 0;
end;
$$;

revoke execute on function public.resolve_round(uuid, text, integer) from public, anon;
grant execute on function public.resolve_round(uuid, text, integer) to authenticated;

-- Every currently-active effect in a room, for the roster's stackable
-- effect badge (red for negative/gold for positive, user story 24) — not
-- restricted to the caller's own effects, since badges are visible to
-- everyone in the room. Restricted to room members, same trust boundary as
-- get_round_modifier_effects.
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
  v_player_id := public.current_player_id();

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

-- Shared by get_dispellable_active_effects and end_active_effect below (the
-- two callers that need to know what dispel-relevant card, if any, the
-- caller currently holds), factored out to avoid a third copy of the
-- "held card joined with its catalog row" query already duplicated between
-- cast_spell_card (carried over from 0019) and these two.
create or replace function public.get_held_card_effect(p_player_id text)
returns table (instance_id uuid, casting_time text, effect_kind text, effect_params jsonb)
language plpgsql
security definer
set search_path = public
as $$
begin
  return query
    select sdi.id, sc.casting_time, sc.effect_kind, sc.effect_params
      from public.spell_deck_instances sdi
      join public.spell_cards sc on sc.id = sdi.card_id
     where sdi.held_by_player = p_player_id and sdi.location = 'held';
end;
$$;

revoke execute on function public.get_held_card_effect(text) from public, anon;

-- The active effects the caller's currently-held card can end early (the
-- Lesser Detox target picker), scoped to the given round's room and to the
-- tiers the held card's effect_params.tiers lists. Returns nothing (not an
-- error) if the caller isn't holding a dispel-kind card, so the UI can call
-- this unconditionally the same way get_my_pending_casts is called.
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
  v_player_id := public.current_player_id();

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

-- Ends another player's active effect early (Lesser Detox, user story per
-- issue #69's AC: "by tier scope as specified in the catalog"). Cast like
-- any other Action card during declare-in (round 'open', RFB03 on the same
-- stale-round race), but targets an effect id rather than a player id, so it
-- doesn't go through cast_spell_card's SELF/OPPONENT/PLAYER-only targeting.
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
  v_player_id := public.current_player_id();

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

-- Redefines get_my_spell_cards (0018) to also return effect_kind, so the
-- client can distinguish a dispel-kind held card (which needs the
-- get_dispellable_active_effects target picker, not the plain cast form)
-- without guessing from casting_time/target alone.
create or replace function public.get_my_spell_cards()
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
  v_player_id := public.current_player_id();

  return query
    select sdi.id, sdi.location, sc.name, sc.casting_time, sc.target, sc.tier, sc.effect_text, sc.effect_kind
      from public.spell_deck_instances sdi
      join public.spell_cards sc on sc.id = sdi.card_id
     where sdi.held_by_player = v_player_id
       and sdi.location in ('held', 'pending_swap');
end;
$$;

revoke execute on function public.get_my_spell_cards() from public, anon;
grant execute on function public.get_my_spell_cards() to authenticated;

comment on function public.end_active_effect(uuid, uuid) is
  'Raises RFB03 (round not open for pre-roll casting) for the same stale-round race pattern as cast_spell_card.';
