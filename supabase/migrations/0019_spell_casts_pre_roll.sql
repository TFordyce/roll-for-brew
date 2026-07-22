-- Spell Cards 2/5: pre-roll Action casting (issue #67, child of the
-- spell-cards spec map #65). Blocked-by #66's schema (0017/0018) for the
-- held card that casting consumes.
--
-- Scope: only Action-timing, SELF/OPPONENT/PLAYER-targeted casting during
-- the declare-in window (rounds.status = 'open'). Reaction casting, and
-- TABLE/CARD/WILD-targeted cards, are out of scope for this ticket (later
-- children of #65) and rejected here with a plain error rather than
-- half-handled.
--
-- Two-phase targeting (user stories 22/23): an OPPONENT/PLAYER card can be
-- armed (cast) with no target while the round is still 'open' — the full
-- participant roster isn't final yet — and the actual target is filled in
-- later via set_spell_cast_target once the round is 'closed' and the roster
-- is locked. SELF cards never defer: the target is always the caster.
create table if not exists public.spell_casts (
  id uuid primary key default gen_random_uuid(),
  round_id uuid not null references public.rounds (id) on delete cascade,
  caster_id text not null references public.players (id),
  card_instance_id uuid not null references public.spell_deck_instances (id),
  target_player_id text references public.players (id),
  target_pending boolean not null default false,
  effect_kind text,
  effect_params jsonb,
  resolved_value numeric,
  -- Self-referencing per the map's data model (user story 39), for the
  -- LIFO reaction stack a later ticket reconstructs order from. Unused by
  -- this ticket's pre-roll-only casting (there's nothing to react to yet),
  -- but included now so that later ticket isn't a schema migration on top
  -- of this one.
  parent_cast_id uuid references public.spell_casts (id),
  cast_at timestamptz not null default now()
);

alter table public.spell_casts enable row level security;

-- No direct select policy: casts aren't a player's private data (badges
-- should eventually surface who's under what effect), but "who cast what
-- when" isn't yet spec'd as a general read surface either — the
-- get_round_modifier_effects RPC below is the sole, narrowly-scoped read
-- path for now, same reasoning as get_layer0_rolls_if_complete restricting
-- reads to round participants rather than opening a broad table policy.
-- No insert/update/delete policies: writes only via the security-definer
-- functions below.

-- Casts an Action card the caller currently holds, for the given round,
-- during that round's declare-in window (status = 'open' — the pre-roll
-- casting window per the map, not a separate phase). Moves the held
-- instance back to 'in_deck' immediately (return-after-use, reshuffled —
-- same convention as #66's swap flow, see 0018's header comment on why
-- there's no separate 'discarded' location).
--
-- p_target_player_id is required for SELF cards to be null or the caller,
-- optional for OPPONENT/PLAYER cards (null defers to set_spell_cast_target
-- once declare-in closes), and TABLE/CARD/WILD cards are rejected outright
-- (out of scope here).
create or replace function public.cast_spell_card(p_round_id uuid, p_target_player_id text default null)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_player_id text;
  v_status text;
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

  select status into v_status from public.rounds where id = p_round_id;

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

  if v_effect_kind = 'dice_modifier' and not v_target_pending then
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

  return v_cast_id;
end;
$$;

revoke execute on function public.cast_spell_card(uuid, text) from public, anon;
grant execute on function public.cast_spell_card(uuid, text) to authenticated;

-- Fills in the deferred target for a cast made while the round was still
-- 'open' (user story 23) — only callable by the cast's own caster, only
-- once the round has closed (roster final), and only while that cast is
-- still awaiting a target.
create or replace function public.set_spell_cast_target(p_cast_id uuid, p_target_player_id text)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_player_id text;
  v_round_id uuid;
  v_caster_id text;
  v_target_pending boolean;
  v_status text;
  v_target_stamp text;
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

  select status into v_status from public.rounds where id = v_round_id;

  if v_status <> 'closed' then
    raise exception 'set_spell_cast_target: round is not yet closed for targeting'
      using errcode = 'RFB03';
  end if;

  select sc.target into v_target_stamp
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
end;
$$;

revoke execute on function public.set_spell_cast_target(uuid, text) from public, anon;
grant execute on function public.set_spell_cast_target(uuid, text) to authenticated;

-- The resolved (non-pending) modifier-bucket effects in play for a round,
-- for the caller to fold into each LayerEntry.modifier before calling
-- resolveLayer (src/lib/game/resolveLayer.ts stays untouched — this is the
-- "shape the LayerEntry values fed into it" seam the map's spec calls for).
-- advantage/disadvantage are deliberately excluded: those affect how the raw
-- d20 itself is generated (submit_roll, below), not the modifier bucket.
-- Restricted to callers who are round participants, same trust boundary as
-- get_layer0_rolls_if_complete.
create or replace function public.get_round_modifier_effects(p_round_id uuid)
returns table (target_player_id text, effect_kind text, effect_params jsonb, resolved_value numeric)
language plpgsql
security definer
set search_path = public
as $$
declare
  v_player_id text;
begin
  v_player_id := public.current_player_id();

  if not exists (
    select 1 from public.round_participants
     where round_id = p_round_id and player_id = v_player_id
  ) then
    raise exception 'get_round_modifier_effects: caller is not a participant in this round';
  end if;

  return query
    select casts.target_player_id, casts.effect_kind, casts.effect_params, casts.resolved_value
      from public.spell_casts casts
     where casts.round_id = p_round_id
       and casts.target_pending = false
       and casts.effect_kind in ('flat_modifier', 'dice_modifier', 'modifier_multiplier', 'set_modifier');
end;
$$;

revoke execute on function public.get_round_modifier_effects(uuid) from public, anon;
grant execute on function public.get_round_modifier_effects(uuid) to authenticated;

-- Redefines submit_roll to honour an active advantage/disadvantage cast
-- (user stories 27/28: roll the d20 twice, keep the higher/lower raw
-- value — matches D&D verbatim). If a player somehow has both active at
-- once they cancel out to a single ordinary roll, the same way D&D's own
-- advantage/disadvantage stacking rule works. Everything else about this
-- function (RFB01/RFB02 gating, modifier_snapshot capture) is unchanged
-- from 0013 — resolveLayer's nat-1/nat-20 detection still only ever sees
-- rolls.value, which is always a single raw d20 value regardless of how
-- many dice were physically rolled to produce it.
--
-- Now returns the final kept value (previously void): submitRollAction
-- (src/app/rounds/actions.ts) needs it to detect a nat-1/nat-20 on the
-- caller's own roll and trigger draw_spell_card — the in-app roll is
-- generated entirely server-side, so there's no other way for the caller
-- to know the value without a second round trip. Postgres won't let
-- create-or-replace change a function's return type, so the old void-
-- returning version has to be dropped first.
drop function if exists public.submit_roll(uuid);

create function public.submit_roll(p_round_id uuid)
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
  v_player_id := public.current_player_id();

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

-- The caller's own casts still awaiting a target for a round (user story
-- 23's target-picker UI), joined with the card name for display. Restricted
-- to the caster themselves — same as every other "my own state" RPC in
-- this feature (get_my_spell_cards in 0018).
create or replace function public.get_my_pending_casts(p_round_id uuid)
returns table (cast_id uuid, card_name text, target text)
language plpgsql
security definer
set search_path = public
as $$
declare
  v_player_id text;
begin
  v_player_id := public.current_player_id();

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

comment on function public.cast_spell_card(uuid, text) is
  'Raises RFB03 (round not open for pre-roll casting) for the same stale-round race pattern as submit_roll''s RFB01/RFB02.';
comment on function public.set_spell_cast_target(uuid, text) is
  'Raises RFB03 (round not yet closed for targeting) for the same stale-round race pattern.';
