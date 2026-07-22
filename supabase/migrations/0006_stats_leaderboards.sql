-- Stats & leaderboard tab (issue #23). Four ranked leaderboards plus a
-- per-room history drill-down, each computed live over public.rounds /
-- public.round_participants — deliberately no maintained summary table, so
-- these numbers can never drift from the rounds that actually happened.
--
-- Every leaderboard is exposed as a pair of plain SQL views (one all-time,
-- one last-30-days) rather than a single parameterised function: the
-- 30-day cutoff is a fixed, non-user-adjustable window, so two views per
-- stat is simpler than a table function for the same result, and it means
-- the toggle in the app is just "pick the other view name" rather than an
-- RPC call. All underlying tables (rounds, round_participants, players) are
-- already readable by any authenticated user (see 0001/0004's "using
-- (true)" policies), so these views need no security-definer wrapper of
-- their own — just an explicit grant to authenticated.
--
-- "Lost a round" = was rounds.brewer_id on a resolved round (see 0005's
-- resolve_round). "Highest modifier ever reached" has no dedicated
-- column — room_players.modifier is a live, per-room/per-day running value
-- that resets to 0 for every new room — so it's derived here as the
-- running sum of cups_made over a brewer's resolved rounds within one room,
-- ordered by resolved_at, which is exactly how resolve_round built it up in
-- the first place; the last-30-days variant recomputes that running sum
-- using only rounds resolved in the last 30 days, so a room whose rounds
-- straddle the cutoff will show a lower "peak" for the trailing window than
-- all-time, which is the intended (if approximate) reading of "reached
-- within this period".

-- Most cups made: total cups_made across a player's resolved rounds as
-- brewer.
create view public.stats_cups_made_all_time as
select
  r.brewer_id as player_id,
  p.display_name,
  p.email,
  sum(r.cups_made) as cups_made
from public.rounds r
join public.players p on p.id = r.brewer_id
where r.status = 'resolved'
group by r.brewer_id, p.display_name, p.email
order by cups_made desc;

create view public.stats_cups_made_last_30_days as
select
  r.brewer_id as player_id,
  p.display_name,
  p.email,
  sum(r.cups_made) as cups_made
from public.rounds r
join public.players p on p.id = r.brewer_id
where r.status = 'resolved' and r.resolved_at >= now() - interval '30 days'
group by r.brewer_id, p.display_name, p.email
order by cups_made desc;

grant select on public.stats_cups_made_all_time to authenticated;
grant select on public.stats_cups_made_last_30_days to authenticated;

-- Fewest rounds lost ("luckiest"): every player who has participated in at
-- least one resolved round, with how many of those they lost (brewed) —
-- coalesced to 0 so a player who has played but never brewed ranks top,
-- rather than being absent from the leaderboard entirely.
create view public.stats_rounds_lost_all_time as
with played as (
  select distinct rp.player_id
  from public.round_participants rp
  join public.rounds r on r.id = rp.round_id
  where r.status = 'resolved'
),
losses as (
  select brewer_id as player_id, count(*) as rounds_lost
  from public.rounds
  where status = 'resolved'
  group by brewer_id
)
select
  pl.player_id,
  p.display_name,
  p.email,
  coalesce(l.rounds_lost, 0) as rounds_lost
from played pl
join public.players p on p.id = pl.player_id
left join losses l on l.player_id = pl.player_id
order by rounds_lost asc;

create view public.stats_rounds_lost_last_30_days as
with played as (
  select distinct rp.player_id
  from public.round_participants rp
  join public.rounds r on r.id = rp.round_id
  where r.status = 'resolved' and r.resolved_at >= now() - interval '30 days'
),
losses as (
  select brewer_id as player_id, count(*) as rounds_lost
  from public.rounds
  where status = 'resolved' and resolved_at >= now() - interval '30 days'
  group by brewer_id
)
select
  pl.player_id,
  p.display_name,
  p.email,
  coalesce(l.rounds_lost, 0) as rounds_lost
from played pl
join public.players p on p.id = pl.player_id
left join losses l on l.player_id = pl.player_id
order by rounds_lost asc;

grant select on public.stats_rounds_lost_all_time to authenticated;
grant select on public.stats_rounds_lost_last_30_days to authenticated;

-- Loss percentage: rounds_lost / rounds_played (as a participant in a
-- resolved round), as a share of the same "played" population as the
-- rounds-lost leaderboard above, so the two stay consistent with each
-- other.
create view public.stats_loss_percentage_all_time as
with played as (
  select rp.player_id, count(*) as rounds_played
  from public.round_participants rp
  join public.rounds r on r.id = rp.round_id
  where r.status = 'resolved'
  group by rp.player_id
),
losses as (
  select brewer_id as player_id, count(*) as rounds_lost
  from public.rounds
  where status = 'resolved'
  group by brewer_id
)
select
  pl.player_id,
  p.display_name,
  p.email,
  pl.rounds_played,
  coalesce(l.rounds_lost, 0) as rounds_lost,
  round(coalesce(l.rounds_lost, 0)::numeric / pl.rounds_played * 100, 1) as loss_percentage
from played pl
join public.players p on p.id = pl.player_id
left join losses l on l.player_id = pl.player_id
order by loss_percentage asc;

create view public.stats_loss_percentage_last_30_days as
with played as (
  select rp.player_id, count(*) as rounds_played
  from public.round_participants rp
  join public.rounds r on r.id = rp.round_id
  where r.status = 'resolved' and r.resolved_at >= now() - interval '30 days'
  group by rp.player_id
),
losses as (
  select brewer_id as player_id, count(*) as rounds_lost
  from public.rounds
  where status = 'resolved' and resolved_at >= now() - interval '30 days'
  group by brewer_id
)
select
  pl.player_id,
  p.display_name,
  p.email,
  pl.rounds_played,
  coalesce(l.rounds_lost, 0) as rounds_lost,
  round(coalesce(l.rounds_lost, 0)::numeric / pl.rounds_played * 100, 1) as loss_percentage
from played pl
join public.players p on p.id = pl.player_id
left join losses l on l.player_id = pl.player_id
order by loss_percentage asc;

grant select on public.stats_loss_percentage_all_time to authenticated;
grant select on public.stats_loss_percentage_last_30_days to authenticated;

-- Highest modifier ever reached: the running total of cups_made a brewer
-- has accumulated within a single room (mirroring resolve_round's own
-- "modifier += cups_made" increment), maxed across all of a player's rooms.
create view public.stats_modifier_peak_all_time as
with brewer_rounds as (
  select
    room_id,
    brewer_id as player_id,
    sum(cups_made) over (
      partition by room_id, brewer_id
      order by resolved_at
      rows between unbounded preceding and current row
    ) as running_modifier
  from public.rounds
  where status = 'resolved'
)
select
  br.player_id,
  p.display_name,
  p.email,
  max(br.running_modifier) as peak_modifier
from brewer_rounds br
join public.players p on p.id = br.player_id
group by br.player_id, p.display_name, p.email
order by peak_modifier desc;

create view public.stats_modifier_peak_last_30_days as
with brewer_rounds as (
  select
    room_id,
    brewer_id as player_id,
    sum(cups_made) over (
      partition by room_id, brewer_id
      order by resolved_at
      rows between unbounded preceding and current row
    ) as running_modifier
  from public.rounds
  where status = 'resolved' and resolved_at >= now() - interval '30 days'
)
select
  br.player_id,
  p.display_name,
  p.email,
  max(br.running_modifier) as peak_modifier
from brewer_rounds br
join public.players p on p.id = br.player_id
group by br.player_id, p.display_name, p.email
order by peak_modifier desc;

grant select on public.stats_modifier_peak_all_time to authenticated;
grant select on public.stats_modifier_peak_last_30_days to authenticated;

-- Per-room history drill-down: one row per room (day) with how many
-- resolved rounds it had, newest first, for the "pick a past day" list.
create view public.stats_room_history as
select
  ro.id as room_id,
  ro.date,
  count(r.id) as resolved_round_count
from public.rooms ro
left join public.rounds r on r.room_id = ro.id and r.status = 'resolved'
group by ro.id, ro.date
order by ro.date desc;

grant select on public.stats_room_history to authenticated;

-- Per-room history drill-down: that day's resolved rounds (starter, brewer,
-- cups_made), for the app to filter by room_id once a day is picked.
create view public.stats_room_rounds as
select
  r.room_id,
  r.id as round_id,
  r.resolved_at,
  r.cups_made,
  starter.id as starter_id,
  starter.display_name as starter_display_name,
  starter.email as starter_email,
  brewer.id as brewer_id,
  brewer.display_name as brewer_display_name,
  brewer.email as brewer_email
from public.rounds r
join public.players starter on starter.id = r.started_by
join public.players brewer on brewer.id = r.brewer_id
where r.status = 'resolved'
order by r.resolved_at desc;

grant select on public.stats_room_rounds to authenticated;
