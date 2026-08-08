-- Brew Rating (issue #209, part of #208): the brew_ratings table plus the
-- submit/withdraw RPCs a non-brewer round participant uses to rate a
-- brewer's tea/coffee 1-5 stars. Mirrors modifier_adjustments' (0052) shape
-- for actor resolution and security definer usage -- security definer,
-- actor always resolved server-side via current_player_id(), custom RFBxx
-- errcodes documented via comment on function.
--
-- Unlike modifier_adjustments (world-readable), brew_ratings' RLS hides raw
-- rows from everyone except the rater who created them -- the brewer must
-- never see individual scores or who gave them, only the aggregate. The
-- stats_brew_rating_* views (next ticket, 0059) are the only sanctioned way
-- anyone else ever sees a signal off this table, and deliberately do not use
-- security_invoker for exactly that reason.
create table if not exists public.brew_ratings (
  id uuid primary key default gen_random_uuid(),
  round_id uuid not null references public.rounds (id) on delete cascade,
  brewer_id text not null references public.players (id) on delete cascade,
  rater_player_id text not null references public.players (id) on delete cascade,
  score integer not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint brew_ratings_score_range check (score between 1 and 5),
  constraint brew_ratings_round_rater_unique unique (round_id, rater_player_id)
);

-- Powers the "most recent non-brewer round" and "rating window" lookups
-- submit_brew_rating/withdraw_brew_rating both do, and the aggregate views'
-- group-by-brewer scans.
create index if not exists brew_ratings_brewer_id_idx on public.brew_ratings (brewer_id);
create index if not exists brew_ratings_rater_player_id_idx on public.brew_ratings (rater_player_id, round_id);

alter table public.brew_ratings enable row level security;

-- Scoped to the rater alone -- covers "I can see my own rating to show it
-- back to me as already-submitted." No policy grants the brewer or any
-- other player row access at all.
create policy "brew ratings are readable by their own rater"
  on public.brew_ratings for select
  to authenticated
  using (rater_player_id = public.current_player_id());

-- No insert/update/delete policies -- the only writers are the security
-- definer functions below, which bypass RLS as table owner.

-- Every table created since 0017 needs its own explicit grant (0042/issue
-- #137's lesson, restated in 0052) -- without it, PostgREST returns
-- "permission denied" before RLS even gets a say.
grant all on public.brew_ratings to service_role;
grant select on public.brew_ratings to authenticated;

-- Submits or edits (upsert-on-conflict) the caller's own rating of a
-- resolved round's brewer. Enforces, in order: score in range; the round
-- exists and is resolved; the caller participated in it; the caller isn't
-- its brewer (a brewer can't rate themself); the round is the caller's own
-- most-recent round as a non-brewer participant (no backlog of older rounds
-- -- ever, per spec); and the Rating Window is still open (no newer round in
-- the same room has resolved yet).
create or replace function public.submit_brew_rating(
  p_round_id uuid,
  p_score integer
)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_rater_id text;
  v_round public.rounds%rowtype;
  v_rating_id uuid;
begin
  v_rater_id := public.current_player_id();

  if p_score is null or p_score < 1 or p_score > 5 then
    raise exception 'submit_brew_rating: score must be between 1 and 5'
      using errcode = 'RFB22';
  end if;

  select * into v_round from public.rounds where id = p_round_id;

  if v_round.id is null or v_round.status <> 'resolved' then
    raise exception 'submit_brew_rating: round not found or not resolved'
      using errcode = 'RFB23';
  end if;

  if not exists (
    select 1 from public.round_participants
     where round_id = p_round_id and player_id = v_rater_id
  ) then
    raise exception 'submit_brew_rating: caller did not participate in this round'
      using errcode = 'RFB24';
  end if;

  if v_round.brewer_id = v_rater_id then
    raise exception 'submit_brew_rating: the brewer cannot rate themself'
      using errcode = 'RFB25';
  end if;

  -- "Most recent round only": reject if the caller also participated
  -- (as non-brewer) in some other round that resolved later than this one --
  -- regardless of room, since only one room is ever active at a time.
  if exists (
    select 1
      from public.rounds r
      join public.round_participants rp on rp.round_id = r.id
     where rp.player_id = v_rater_id
       and r.status = 'resolved'
       and r.brewer_id is distinct from v_rater_id
       and r.resolved_at > v_round.resolved_at
  ) then
    raise exception 'submit_brew_rating: only the caller''s most recent non-brewer round can be rated'
      using errcode = 'RFB26';
  end if;

  -- Rating Window: closes the moment any round in the same room resolves
  -- after this one, whether or not the caller participated in it.
  if exists (
    select 1 from public.rounds r
     where r.room_id = v_round.room_id
       and r.status = 'resolved'
       and r.resolved_at > v_round.resolved_at
  ) then
    raise exception 'submit_brew_rating: the rating window has closed'
      using errcode = 'RFB27';
  end if;

  insert into public.brew_ratings (round_id, brewer_id, rater_player_id, score)
  values (p_round_id, v_round.brewer_id, v_rater_id, p_score)
  on conflict (round_id, rater_player_id)
  do update set score = excluded.score, updated_at = now()
  returning id into v_rating_id;

  return v_rating_id;
end;
$$;

revoke execute on function public.submit_brew_rating(uuid, integer) from public, anon;
grant execute on function public.submit_brew_rating(uuid, integer) to authenticated;

comment on function public.submit_brew_rating(uuid, integer) is
  'Raises RFB22 for a score outside 1-5, RFB23 when the round does not exist or is not resolved, RFB24 when the caller did not participate in it, RFB25 when the caller is the round''s brewer, RFB26 when a newer round exists where the caller also participated as non-brewer, RFB27 once a newer round in the same room has resolved (Rating Window closed).';

-- Withdraws (hard-deletes, no soft-delete -- consistent with
-- delete_modifier_adjustment) the caller's own rating for a round.
-- Re-checks the same Rating Window condition as submit_brew_rating -- the
-- undo window is the rating window, per spec. Withdrawing a rating that was
-- never submitted is a no-op: the delete matches zero rows and the function
-- returns successfully.
create or replace function public.withdraw_brew_rating(p_round_id uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_rater_id text;
  v_round public.rounds%rowtype;
begin
  v_rater_id := public.current_player_id();

  select * into v_round from public.rounds where id = p_round_id;

  if v_round.id is null then
    raise exception 'withdraw_brew_rating: round not found'
      using errcode = 'RFB23';
  end if;

  if exists (
    select 1 from public.rounds r
     where r.room_id = v_round.room_id
       and r.status = 'resolved'
       and r.resolved_at > v_round.resolved_at
  ) then
    raise exception 'withdraw_brew_rating: the rating window has closed'
      using errcode = 'RFB27';
  end if;

  delete from public.brew_ratings
   where round_id = p_round_id and rater_player_id = v_rater_id;
end;
$$;

revoke execute on function public.withdraw_brew_rating(uuid) from public, anon;
grant execute on function public.withdraw_brew_rating(uuid) to authenticated;

comment on function public.withdraw_brew_rating(uuid) is
  'Hard-deletes the caller''s own rating for a round (no-op if none exists). Raises RFB23 when the round does not exist, RFB27 once a newer round in the same room has resolved (Rating Window closed).';
