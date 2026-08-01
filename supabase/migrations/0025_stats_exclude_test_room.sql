-- Excludes the Test Room (0024) from every stats_* leaderboard/history view
-- (0006), so a round manually placed there can never affect real household
-- stats. Each view is recreated with an added join through to rooms and a
-- "not rooms.is_test" filter; security_invoker doesn't survive
-- create-or-replace, so it's re-applied at the end.

create or replace view public.stats_cups_made_all_time as
select
  r.brewer_id as player_id,
  p.display_name,
  p.email,
  sum(r.cups_made) as cups_made
from public.rounds r
join public.rooms ro on ro.id = r.room_id
join public.players p on p.id = r.brewer_id
where r.status = 'resolved' and not ro.is_test
group by r.brewer_id, p.display_name, p.email
order by cups_made desc;

create or replace view public.stats_cups_made_last_30_days as
select
  r.brewer_id as player_id,
  p.display_name,
  p.email,
  sum(r.cups_made) as cups_made
from public.rounds r
join public.rooms ro on ro.id = r.room_id
join public.players p on p.id = r.brewer_id
where r.status = 'resolved' and not ro.is_test and r.resolved_at >= now() - interval '30 days'
group by r.brewer_id, p.display_name, p.email
order by cups_made desc;

create or replace view public.stats_rounds_lost_all_time as
with played as (
  select distinct rp.player_id
  from public.round_participants rp
  join public.rounds r on r.id = rp.round_id
  join public.rooms ro on ro.id = r.room_id
  where r.status = 'resolved' and not ro.is_test
),
losses as (
  select r.brewer_id as player_id, count(*) as rounds_lost
  from public.rounds r
  join public.rooms ro on ro.id = r.room_id
  where r.status = 'resolved' and not ro.is_test
  group by r.brewer_id
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

create or replace view public.stats_rounds_lost_last_30_days as
with played as (
  select distinct rp.player_id
  from public.round_participants rp
  join public.rounds r on r.id = rp.round_id
  join public.rooms ro on ro.id = r.room_id
  where r.status = 'resolved' and not ro.is_test and r.resolved_at >= now() - interval '30 days'
),
losses as (
  select r.brewer_id as player_id, count(*) as rounds_lost
  from public.rounds r
  join public.rooms ro on ro.id = r.room_id
  where r.status = 'resolved' and not ro.is_test and r.resolved_at >= now() - interval '30 days'
  group by r.brewer_id
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

create or replace view public.stats_loss_percentage_all_time as
with played as (
  select rp.player_id, count(*) as rounds_played
  from public.round_participants rp
  join public.rounds r on r.id = rp.round_id
  join public.rooms ro on ro.id = r.room_id
  where r.status = 'resolved' and not ro.is_test
  group by rp.player_id
),
losses as (
  select r.brewer_id as player_id, count(*) as rounds_lost
  from public.rounds r
  join public.rooms ro on ro.id = r.room_id
  where r.status = 'resolved' and not ro.is_test
  group by r.brewer_id
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

create or replace view public.stats_loss_percentage_last_30_days as
with played as (
  select rp.player_id, count(*) as rounds_played
  from public.round_participants rp
  join public.rounds r on r.id = rp.round_id
  join public.rooms ro on ro.id = r.room_id
  where r.status = 'resolved' and not ro.is_test and r.resolved_at >= now() - interval '30 days'
  group by rp.player_id
),
losses as (
  select r.brewer_id as player_id, count(*) as rounds_lost
  from public.rounds r
  join public.rooms ro on ro.id = r.room_id
  where r.status = 'resolved' and not ro.is_test and r.resolved_at >= now() - interval '30 days'
  group by r.brewer_id
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

create or replace view public.stats_modifier_peak_all_time as
with brewer_rounds as (
  select
    r.room_id,
    r.brewer_id as player_id,
    sum(r.cups_made) over (
      partition by r.room_id, r.brewer_id
      order by r.resolved_at
      rows between unbounded preceding and current row
    ) as running_modifier
  from public.rounds r
  join public.rooms ro on ro.id = r.room_id
  where r.status = 'resolved' and not ro.is_test
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

create or replace view public.stats_modifier_peak_last_30_days as
with brewer_rounds as (
  select
    r.room_id,
    r.brewer_id as player_id,
    sum(r.cups_made) over (
      partition by r.room_id, r.brewer_id
      order by r.resolved_at
      rows between unbounded preceding and current row
    ) as running_modifier
  from public.rounds r
  join public.rooms ro on ro.id = r.room_id
  where r.status = 'resolved' and not ro.is_test and r.resolved_at >= now() - interval '30 days'
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

create or replace view public.stats_room_history as
select
  ro.id as room_id,
  ro.date,
  count(r.id) as resolved_round_count
from public.rooms ro
left join public.rounds r on r.room_id = ro.id and r.status = 'resolved'
where not ro.is_test
group by ro.id, ro.date
order by ro.date desc;

create or replace view public.stats_room_rounds as
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
join public.rooms ro on ro.id = r.room_id
join public.players starter on starter.id = r.started_by
join public.players brewer on brewer.id = r.brewer_id
where r.status = 'resolved' and not ro.is_test
order by r.resolved_at desc;

alter view public.stats_cups_made_all_time set (security_invoker = on);
alter view public.stats_cups_made_last_30_days set (security_invoker = on);
alter view public.stats_rounds_lost_all_time set (security_invoker = on);
alter view public.stats_rounds_lost_last_30_days set (security_invoker = on);
alter view public.stats_loss_percentage_all_time set (security_invoker = on);
alter view public.stats_loss_percentage_last_30_days set (security_invoker = on);
alter view public.stats_modifier_peak_all_time set (security_invoker = on);
alter view public.stats_modifier_peak_last_30_days set (security_invoker = on);
alter view public.stats_room_history set (security_invoker = on);
alter view public.stats_room_rounds set (security_invoker = on);
