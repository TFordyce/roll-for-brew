-- Spell Cards 3/5: the unified, no-timer, poll-driven reaction window
-- (issue #68, child of the spec map #65). Blocked-by #67 (0019), whose
-- casting/targeting plumbing and modifier-bucket composition this reuses.
--
-- Model: a reaction window is opened for a specific (round, layer) once that
-- layer's rolls are known, and stays open until every currently-eligible
-- holder of a Reaction-timing card has passed within the same poll round.
-- Casting a Reaction card (on the roll, or on another cast — chaining)
-- bumps the window's poll_round, which invalidates every earlier pass (they
-- were passes for a round of polling that's now moot) and gives every
-- still-eligible holder another chance to react. There is no timeout at any
-- layer, matching the base game's stall-timeout only ever applying to
-- declare-in/roll/tie-break-reroll stages.
--
-- contested_negate/redirect resolve immediately at cast time (not deferred
-- to window-close): a reaction targeting an earlier cast on the stack is
-- itself always the most-recently-cast thing in the round, so resolving its
-- contest roll as soon as it's cast already gives the LIFO ordering the map
-- calls for (the newest cast's fate-deciding roll always happens before the
-- older cast it targets is ever read for its own modifier-bucket effect,
-- which only happens later at layer-finalize time).
create table public.spell_reaction_windows (
  id uuid primary key default gen_random_uuid(),
  round_id uuid not null references public.rounds (id) on delete cascade,
  layer integer not null,
  status text not null default 'open' check (status in ('open', 'closed')),
  poll_round integer not null default 1,
  opened_at timestamptz not null default now(),
  closed_at timestamptz
);

-- At most one open window per round at a time — a layer's window must close
-- (fully pass) before the next layer (a tie reroll, or this same layer
-- finalizing) can open its own.
create unique index spell_reaction_windows_one_open_per_round
  on public.spell_reaction_windows (round_id)
  where status = 'open';

alter table public.spell_reaction_windows enable row level security;

-- No select policy: window state is read only through the narrowly-scoped
-- RPCs below, same convention as spell_casts (0019).

create table public.spell_reaction_passes (
  id uuid primary key default gen_random_uuid(),
  window_id uuid not null references public.spell_reaction_windows (id) on delete cascade,
  poll_round integer not null,
  player_id text not null references public.players (id),
  passed_at timestamptz not null default now(),
  unique (window_id, poll_round, player_id)
);

alter table public.spell_reaction_passes enable row level security;

-- Ties a reaction cast to the window it was cast into, and the fate a
-- contested_negate/redirect reaction decided for the cast it targeted.
-- parent_cast_id (0019) already carries "which cast is this reacting to";
-- negated is the outcome of a successful contested_negate against this cast.
-- seq gives every cast (pre-roll or reaction) a strict, gap-tolerant total
-- order independent of timestamp precision, for LIFO stack display/resolution.
alter table public.spell_casts add column reaction_window_id uuid references public.spell_reaction_windows (id);
alter table public.spell_casts add column negated boolean not null default false;
alter table public.spell_casts add column seq bigint generated always as identity;

alter table public.spell_cards drop constraint spell_cards_effect_kind_check;
alter table public.spell_cards add constraint spell_cards_effect_kind_check
  check (effect_kind in (
    'flat_modifier', 'dice_modifier', 'modifier_multiplier', 'set_modifier',
    'advantage', 'disadvantage', 'forced_reroll', 'contested_negate', 'redirect'
  ));

alter table public.spell_casts drop constraint if exists spell_casts_effect_kind_check;
alter table public.spell_casts add constraint spell_casts_effect_kind_check
  check (effect_kind is null or effect_kind in (
    'flat_modifier', 'dice_modifier', 'modifier_multiplier', 'set_modifier',
    'advantage', 'disadvantage', 'forced_reroll', 'contested_negate', 'redirect'
  ));

-- Maps a first Reaction/counterspell slice of the catalog onto the new
-- primitives, per the map's "mapping all 65 cards is a follow-up task" scope
-- note — just enough to exercise contested_negate, redirect, and
-- forced-reroll-in-place end to end. tier is read live from the target
-- card's tier column at resolution time (not duplicated into params) for
-- contested_negate and redirect, per the map's decision.
update public.spell_cards set effect_kind = 'contested_negate', effect_params = '{}'::jsonb
 where name = 'Tannin Tantrum';
update public.spell_cards set effect_kind = 'redirect', effect_params = '{}'::jsonb
 where name = 'Mug Mirror';
update public.spell_cards set effect_kind = 'forced_reroll', effect_params = '{}'::jsonb
 where name in ('Double Dunk', 'Re-Steep');
update public.spell_cards set effect_kind = 'forced_reroll', effect_params = '{}'::jsonb
 where name = 'Milk First?';

-- Opens (or reopens the layer's) reaction window once a layer's rolls are
-- known, called right after the layer-reveal broadcast and before the layer
-- is finalized into a brewer/tie outcome. If nobody currently eligible holds
-- a Reaction card, the window closes itself immediately (nothing to poll) so
-- the caller can finalize the layer in the same request without an idle
-- round trip. Returns the window's id and whether it's already closed.
create or replace function public.open_reaction_window(p_round_id uuid, p_layer integer)
returns table (window_id uuid, is_closed boolean)
language plpgsql
security definer
set search_path = public
as $$
declare
  v_room_id uuid;
  v_window_id uuid;
  v_eligible_count integer;
begin
  select room_id into v_room_id from public.rounds where id = p_round_id;

  if v_room_id is null then
    raise exception 'open_reaction_window: round not found';
  end if;

  insert into public.spell_reaction_windows (round_id, layer)
  values (p_round_id, p_layer)
  returning id into v_window_id;

  select count(*) into v_eligible_count
    from public.spell_deck_instances sdi
    join public.spell_cards sc on sc.id = sdi.card_id
    join public.room_players rp on rp.player_id = sdi.held_by_player
   where sdi.location = 'held' and sc.casting_time = 'R' and rp.room_id = v_room_id;

  if v_eligible_count = 0 then
    update public.spell_reaction_windows set status = 'closed', closed_at = now()
     where id = v_window_id;
  end if;

  window_id := v_window_id;
  is_closed := v_eligible_count = 0;
  return next;
end;
$$;

revoke execute on function public.open_reaction_window(uuid, integer) from public, anon;
grant execute on function public.open_reaction_window(uuid, integer) to authenticated;

-- The round's currently-open reaction window (there is at most one), along
-- with whether the caller is presently eligible to act on it (holds a
-- Reaction card) and whether they've already passed this poll round. Null
-- rows (no open window) mean there's nothing to show.
create or replace function public.get_open_reaction_window(p_round_id uuid)
returns table (window_id uuid, layer integer, poll_round integer, eligible boolean, already_passed boolean)
language plpgsql
security definer
set search_path = public
as $$
declare
  v_player_id text;
begin
  v_player_id := public.current_player_id();

  return query
    select w.id, w.layer, w.poll_round,
      exists (
        select 1 from public.spell_deck_instances sdi
        join public.spell_cards sc on sc.id = sdi.card_id
       where sdi.held_by_player = v_player_id and sdi.location = 'held' and sc.casting_time = 'R'
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

-- The reaction stack for the round's currently-open window, oldest first
-- (seq order) — the trigger cast (if any) plus every reaction cast onto it
-- so far, for the ribbon banner's "what's happened so far" display and the
-- CARD-target picker for a further contested_negate/redirect reaction.
create or replace function public.get_reaction_stack(p_round_id uuid)
returns table (
  cast_id uuid, card_name text, caster_id text, caster_name text,
  target_stamp text, negated boolean, parent_cast_id uuid
)
language plpgsql
security definer
set search_path = public
as $$
begin
  return query
    select casts.id, sc.name, casts.caster_id, coalesce(p.display_name, p.email),
      sc.target, casts.negated, casts.parent_cast_id
      from public.spell_casts casts
      join public.spell_deck_instances sdi on sdi.id = casts.card_instance_id
      join public.spell_cards sc on sc.id = sdi.card_id
      join public.players p on p.id = casts.caster_id
      join public.spell_reaction_windows w on w.id = casts.reaction_window_id
     where w.round_id = p_round_id and w.status = 'open'
     order by casts.seq asc;
end;
$$;

revoke execute on function public.get_reaction_stack(uuid) from public, anon;
grant execute on function public.get_reaction_stack(uuid) to authenticated;

-- Casts the caller's held Reaction card into the round's currently-open
-- window. p_target_cast_id targets an existing entry on the stack (required
-- for CARD-target cards: contested_negate, redirect); p_target_player_id
-- targets a player directly (SELF/OPPONENT/PLAYER cards) — the roster is
-- already final by the time a reaction window can be open, so unlike
-- cast_spell_card (0019) there's no deferred-target case here.
--
-- contested_negate and redirect resolve their own roll/effect immediately
-- (see header comment); every other effect_kind is left for finalize-time
-- (get_round_modifier_effects for the modifier bucket, forced_reroll for
-- layerResolution.ts's in-place reroll step) the same way pre-roll casts
-- already are. Reopens the poll (bumps poll_round) so every other eligible
-- holder gets another chance to respond to this new cast (chaining).
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
  v_player_id := public.current_player_id();

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

  -- A card's own resolution roll (the DC check below) is generated with the
  -- same floor(random()*20+1) primitive submit_roll uses, but it never
  -- touches the rolls table or draw_spell_card — the nat-1/nat-20 draw
  -- trigger stays scoped to the main round roll only (user story 32).
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

-- Records the caller's pass for the window's current poll round, then closes
-- the window if every currently-eligible holder (any Reaction-card holder in
-- the round's room, recomputed fresh — not restricted to whoever was
-- eligible when the window opened) has now passed within that same poll
-- round. Returns whether the window is now closed, so the caller knows
-- whether to finalize the layer.
create or replace function public.pass_reaction_window(p_round_id uuid)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
declare
  v_player_id text;
  v_room_id uuid;
  v_window_id uuid;
  v_poll_round integer;
  v_eligible_count integer;
  v_passed_count integer;
  v_closed boolean := false;
begin
  v_player_id := public.current_player_id();

  select room_id into v_room_id from public.rounds where id = p_round_id;

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
    join public.room_players rp on rp.player_id = sdi.held_by_player
   where sdi.location = 'held' and sc.casting_time = 'R' and rp.room_id = v_room_id;

  select count(*) into v_passed_count
    from public.spell_reaction_passes p
    join public.spell_deck_instances sdi on sdi.held_by_player = p.player_id
    join public.spell_cards sc on sc.id = sdi.card_id
    join public.room_players rp on rp.player_id = sdi.held_by_player
   where p.window_id = v_window_id and p.poll_round = v_poll_round
     and sdi.location = 'held' and sc.casting_time = 'R' and rp.room_id = v_room_id;

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

-- Every currently-active forced_reroll cast's target player, for the given
-- round/layer's reaction window — layerResolution.ts's finalize step rerolls
-- each in place on the rolls table (getForcedRerollTargets/applyForcedReroll
-- below) before re-running resolveLayer, distinct from the tie-break
-- mechanism's new-layer spawn.
create or replace function public.get_forced_reroll_targets(p_round_id uuid, p_layer integer)
returns table (target_player_id text)
language plpgsql
security definer
set search_path = public
as $$
begin
  return query
    select distinct casts.target_player_id
      from public.spell_casts casts
      join public.spell_reaction_windows w on w.id = casts.reaction_window_id
     where w.round_id = p_round_id and w.layer = p_layer
       and casts.effect_kind = 'forced_reroll'
       and casts.negated = false
       and casts.target_player_id is not null;
end;
$$;

revoke execute on function public.get_forced_reroll_targets(uuid, integer) from public, anon;
grant execute on function public.get_forced_reroll_targets(uuid, integer) to authenticated;

-- Replaces a player's already-recorded roll for a round/layer in place (a
-- forced-reroll-in-place effect, e.g. Double Dunk/Milk First?) and returns
-- the new value, for layerResolution.ts to fold into a fresh resolveLayer
-- call. Same "caller-computed, RPC persists" trust boundary as
-- advance_round_layer/resolve_round.
create or replace function public.apply_forced_reroll(p_round_id uuid, p_layer integer, p_player_id text)
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  v_value integer;
begin
  v_value := floor(random() * 20 + 1)::integer;

  update public.rolls
     set value = v_value
   where round_id = p_round_id and layer = p_layer and player_id = p_player_id
  returning value into v_value;

  if v_value is null then
    raise exception 'apply_forced_reroll: no existing roll for % at round %, layer %', p_player_id, p_round_id, p_layer;
  end if;

  return v_value;
end;
$$;

revoke execute on function public.apply_forced_reroll(uuid, integer, text) from public, anon;
grant execute on function public.apply_forced_reroll(uuid, integer, text) to authenticated;

-- Redefines get_round_modifier_effects (0019) to exclude a cast that a
-- successful contested_negate reaction has since negated — a negated cast's
-- modifier-bucket effect must never apply, whether it was a pre-roll Action
-- cast or a Reaction cast itself. Otherwise unchanged.
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
       and casts.negated = false
       and casts.effect_kind in ('flat_modifier', 'dice_modifier', 'modifier_multiplier', 'set_modifier');
end;
$$;

revoke execute on function public.get_round_modifier_effects(uuid) from public, anon;
grant execute on function public.get_round_modifier_effects(uuid) to authenticated;

comment on function public.cast_reaction_spell_card(uuid, text, uuid) is
  'Raises RFB04 (no open reaction window) for the same stale-round race pattern as submit_roll''s RFB01/RFB02 and cast_spell_card''s RFB03.';
comment on function public.pass_reaction_window(uuid) is
  'Raises RFB04 (no open reaction window) for the same stale-round race pattern.';
