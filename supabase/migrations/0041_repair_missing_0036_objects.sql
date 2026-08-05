-- Repairs live-DB drift: pushing the grant-privileges migration below
-- (originally 0041, renumbered to 0042 so this repair runs first — see
-- note there) failed with "relation public.pending_spell_draws does not
-- exist", proving that table (and almost certainly the rest of
-- 0036_manual_spell_card_draw.sql's objects — record_pending_spell_draw,
-- get_pending_spell_draw, draw_pending_spell_card,
-- draw_pending_spell_card_manual) were never actually created live,
-- despite `supabase migration list` showing 0036 as applied. That command
-- only confirms a row exists in the migration history table, not that the
-- DDL ran — the most likely explanation is the 0036/0037 numbering
-- collision between PR #127 (this file, stayed 0036) and PR #125
-- (renumbered 0036→0037 by PR #129): live's history picked up a "0036"
-- entry from that collision that doesn't correspond to this file's actual
-- content.
--
-- Every statement below is copied verbatim from 0036 and is safe to
-- re-run whether or not each object already exists live: create table if
-- not exists, create or replace function, and idempotent grant/revoke are
-- all no-ops on a second run. The one exception is create policy, which
-- errors if the policy already exists — guarded here with drop policy if
-- exists first (0036 itself never needed that guard, since it was a brand
-- new table).

create table if not exists public.pending_spell_draws (
  round_id uuid not null references public.rounds (id) on delete cascade,
  player_id text not null references public.players (id) on delete cascade,
  trigger text not null check (trigger in ('nat1', 'nat20')),
  created_at timestamptz not null default now(),
  primary key (round_id, player_id)
);

alter table public.pending_spell_draws enable row level security;

drop policy if exists "pending_spell_draws are readable by their own player" on public.pending_spell_draws;

create policy "pending_spell_draws are readable by their own player"
  on public.pending_spell_draws for select
  to authenticated
  using (player_id = public.current_player_id(pending_spell_draws.round_id));

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
