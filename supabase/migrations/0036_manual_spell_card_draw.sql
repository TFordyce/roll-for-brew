-- Physical-deck spell card draw override: lets a player who drew a real
-- card from the physical deck at the table tell the app which one, instead
-- of always taking the app's own random draw ("players will definitely
-- prefer drawing from the deck IRL").
--
-- This requires splitting the trigger from the draw. Previously
-- draw_spell_card ran synchronously, inside the same request as
-- submit_roll/submit_manual_roll, the instant a nat-1/nat-20 landed
-- (src/app/rounds/roundActionHelpers.ts's maybeDrawSpellCard) — there was
-- never a moment to ask "how did you draw?". pending_spell_draws below is
-- that moment: submit_roll/submit_manual_roll's callers now record a
-- pending trigger instead of drawing immediately, and the two functions
-- at the bottom resolve it either randomly (mirroring draw_spell_card) or
-- against a specific card the player names.
--
-- One row per (round_id, player_id): a player can't roll again in the same
-- round before this resolves, so there's never more than one trigger
-- awaiting a choice.
create table if not exists public.pending_spell_draws (
  round_id uuid not null references public.rounds (id) on delete cascade,
  player_id text not null references public.players (id) on delete cascade,
  trigger text not null check (trigger in ('nat1', 'nat20')),
  created_at timestamptz not null default now(),
  primary key (round_id, player_id)
);

alter table public.pending_spell_draws enable row level security;

create policy "pending_spell_draws are readable by their own player"
  on public.pending_spell_draws for select
  to authenticated
  using (player_id = public.current_player_id(pending_spell_draws.round_id));

-- No insert/update/delete policies: writes only via the security-definer
-- functions below, same pattern as spell_deck_instances/spell_draws (0018).

-- Records that a nat-1/nat-20 has fired for the caller this round, without
-- drawing yet — called in place of the old immediate draw_spell_card call.
-- Idempotent (on conflict do nothing): a retried call for the same round/
-- player (e.g. the stale-round-race retry path, isStaleRoundError) must
-- not clobber a choice already in flight.
create or replace function public.record_pending_spell_draw(p_round_id uuid, p_trigger text)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_player_id text;
begin
  v_player_id := public.current_player_id(p_round_id);

  if p_trigger not in ('nat1', 'nat20') then
    raise exception 'record_pending_spell_draw: invalid trigger %', p_trigger;
  end if;

  insert into public.pending_spell_draws (round_id, player_id, trigger)
  values (p_round_id, v_player_id, p_trigger)
  on conflict (round_id, player_id) do nothing;
end;
$$;

revoke execute on function public.record_pending_spell_draw(uuid, text) from public, anon;
grant execute on function public.record_pending_spell_draw(uuid, text) to authenticated;

-- The caller's own pending trigger for this round, if any — feeds the
-- "how did you draw?" prompt (SpellDrawChoicePanel.tsx).
create or replace function public.get_pending_spell_draw(p_round_id uuid)
returns table (trigger text)
language plpgsql
security definer
set search_path = public
as $$
declare
  v_player_id text;
begin
  v_player_id := public.current_player_id(p_round_id);

  return query
    select psd.trigger
      from public.pending_spell_draws psd
     where psd.round_id = p_round_id and psd.player_id = v_player_id;
end;
$$;

revoke execute on function public.get_pending_spell_draw(uuid) from public, anon;
grant execute on function public.get_pending_spell_draw(uuid) to authenticated;

-- Resolves a pending trigger with the app's own uniformly-random draw (the
-- "draw in-app" choice) — same instance-selection/hold/swap logic as
-- draw_spell_card (0018/0026), restated here so the trigger comes from the
-- pending row itself (not a client-supplied parameter) and the row is
-- consumed atomically with the draw. Deck exhaustion still clears the
-- pending row (returning no rows) rather than leaving the player stuck
-- with a dangling prompt — the same "skip silently" fallback
-- draw_spell_card's header comment already documents as an explicitly
-- unresolved edge case.
create or replace function public.draw_pending_spell_card(p_round_id uuid)
returns table (instance_id uuid, needs_swap_decision boolean)
language plpgsql
security definer
set search_path = public
as $$
declare
  v_player_id text;
  v_trigger text;
  v_new_instance_id uuid;
  v_already_held boolean;
begin
  v_player_id := public.current_player_id(p_round_id);

  select trigger into v_trigger
    from public.pending_spell_draws
   where round_id = p_round_id and player_id = v_player_id;

  if v_trigger is null then
    raise exception 'draw_pending_spell_card: caller has no pending spell draw for this round';
  end if;

  v_already_held := exists (
    select 1 from public.spell_deck_instances
     where held_by_player = v_player_id and location = 'held'
  );

  if exists (
    select 1 from public.spell_deck_instances
     where held_by_player = v_player_id and location = 'pending_swap'
  ) then
    raise exception 'draw_pending_spell_card: caller already has a pending keep-or-swap decision';
  end if;

  select id into v_new_instance_id
    from public.spell_deck_instances
   where location = 'in_deck'
   order by random()
   limit 1
     for update skip locked;

  delete from public.pending_spell_draws where round_id = p_round_id and player_id = v_player_id;

  if v_new_instance_id is null then
    return;
  end if;

  update public.spell_deck_instances
     set location = case when v_already_held then 'pending_swap' else 'held' end,
         held_by_player = v_player_id
   where id = v_new_instance_id;

  insert into public.spell_draws (player_id, card_instance_id, trigger)
  values (v_player_id, v_new_instance_id, v_trigger);

  instance_id := v_new_instance_id;
  needs_swap_decision := v_already_held;
  return next;
end;
$$;

revoke execute on function public.draw_pending_spell_card(uuid) from public, anon;
grant execute on function public.draw_pending_spell_card(uuid) to authenticated;

-- Resolves a pending trigger with the specific card the caller says they
-- physically drew from the real deck. Unlike the admin-only
-- draw_spell_card_as forced draw (0034, whose header note is explicit that
-- *real gameplay's randomness must never be steerable from a form field*),
-- this isn't steering randomness — the physical shuffle already happened
-- at the table; the player is reporting its outcome instead of the app
-- generating its own. Still requires an in-deck instance of exactly that
-- card to exist, the same in-deck check draw_spell_card_as's forced branch
-- uses, so a physical/digital desync (that card's instance already held by
-- someone else, or the table's actual deck has drifted from the app's)
-- surfaces as a clear, retryable error rather than silently corrupting
-- deck state. RFB06 is a new custom SQLSTATE (following RFB01-05's
-- convention, 0013/0019/0020/0023) so the UI can show a friendly message
-- instead of a raw crash. The pending row is deliberately left in place on
-- this error (unlike the success path) so the player can retry with a
-- corrected card.
create or replace function public.draw_pending_spell_card_manual(p_round_id uuid, p_card_id uuid)
returns table (instance_id uuid, needs_swap_decision boolean)
language plpgsql
security definer
set search_path = public
as $$
declare
  v_player_id text;
  v_trigger text;
  v_new_instance_id uuid;
  v_already_held boolean;
begin
  v_player_id := public.current_player_id(p_round_id);

  select trigger into v_trigger
    from public.pending_spell_draws
   where round_id = p_round_id and player_id = v_player_id;

  if v_trigger is null then
    raise exception 'draw_pending_spell_card_manual: caller has no pending spell draw for this round';
  end if;

  v_already_held := exists (
    select 1 from public.spell_deck_instances
     where held_by_player = v_player_id and location = 'held'
  );

  if exists (
    select 1 from public.spell_deck_instances
     where held_by_player = v_player_id and location = 'pending_swap'
  ) then
    raise exception 'draw_pending_spell_card_manual: caller already has a pending keep-or-swap decision';
  end if;

  select id into v_new_instance_id
    from public.spell_deck_instances
   where card_id = p_card_id and location = 'in_deck'
     for update skip locked;

  if v_new_instance_id is null then
    raise exception 'draw_pending_spell_card_manual: that card is not currently in the deck'
      using errcode = 'RFB06';
  end if;

  delete from public.pending_spell_draws where round_id = p_round_id and player_id = v_player_id;

  update public.spell_deck_instances
     set location = case when v_already_held then 'pending_swap' else 'held' end,
         held_by_player = v_player_id
   where id = v_new_instance_id;

  insert into public.spell_draws (player_id, card_instance_id, trigger)
  values (v_player_id, v_new_instance_id, v_trigger);

  instance_id := v_new_instance_id;
  needs_swap_decision := v_already_held;
  return next;
end;
$$;

revoke execute on function public.draw_pending_spell_card_manual(uuid, uuid) from public, anon;
grant execute on function public.draw_pending_spell_card_manual(uuid, uuid) to authenticated;

comment on function public.draw_pending_spell_card_manual(uuid, uuid) is
  'Raises RFB06 when the claimed card has no currently-in-deck instance — a physical/digital desync the table needs to reconcile. The pending draw row is left in place so the player can retry.';
