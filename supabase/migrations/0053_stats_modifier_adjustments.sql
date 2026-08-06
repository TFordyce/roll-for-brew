-- Adjustments reflected in Stats (issue #185, part of #182): folds
-- modifier_adjustments (0052) into the "highest modifier reached"
-- leaderboard and exposes a room's adjustments in the Stats page's
-- per-room history drill-down.
--
-- stats_modifier_peak_{all_time,last_30_days} (0006, last touched by
-- 0025's test-room exclusion): the running-sum source that used to be
-- round-loss bumps alone (rounds.cups_made at resolved_at) becomes a union
-- of two event streams per (room_id, player_id) -- round-loss bumps and
-- adjustment deltas (modifier_adjustments.delta at created_at) -- ordered
-- by their own timestamp before the running sum is taken. This is the only
-- way to get a true chronological interleaving: an adjustment landing
-- between two round losses can change which point is the peak, which a
-- "sum adjustments on top of the round-loss peak" approximation would get
-- wrong. The last-30-days variant filters each stream by its own
-- timestamp column against the cutoff before the union, same as today's
-- single-stream filtering.
create or replace view public.stats_modifier_peak_all_time as
with events as (
  select r.room_id, r.brewer_id as player_id, r.resolved_at as ts, r.cups_made as delta
  from public.rounds r
  join public.rooms ro on ro.id = r.room_id
  where r.status = 'resolved' and not ro.is_test
  union all
  select ma.room_id, ma.target_player_id as player_id, ma.created_at as ts, ma.delta
  from public.modifier_adjustments ma
  join public.rooms ro on ro.id = ma.room_id
  where not ro.is_test
),
running as (
  select
    room_id,
    player_id,
    sum(delta) over (
      partition by room_id, player_id
      order by ts
      rows between unbounded preceding and current row
    ) as running_modifier
  from events
)
select
  running.player_id,
  p.display_name,
  p.email,
  max(running.running_modifier) as peak_modifier
from running
join public.players p on p.id = running.player_id
group by running.player_id, p.display_name, p.email
order by peak_modifier desc;

create or replace view public.stats_modifier_peak_last_30_days as
with events as (
  select r.room_id, r.brewer_id as player_id, r.resolved_at as ts, r.cups_made as delta
  from public.rounds r
  join public.rooms ro on ro.id = r.room_id
  where r.status = 'resolved' and not ro.is_test and r.resolved_at >= now() - interval '30 days'
  union all
  select ma.room_id, ma.target_player_id as player_id, ma.created_at as ts, ma.delta
  from public.modifier_adjustments ma
  join public.rooms ro on ro.id = ma.room_id
  where not ro.is_test and ma.created_at >= now() - interval '30 days'
),
running as (
  select
    room_id,
    player_id,
    sum(delta) over (
      partition by room_id, player_id
      order by ts
      rows between unbounded preceding and current row
    ) as running_modifier
  from events
)
select
  running.player_id,
  p.display_name,
  p.email,
  max(running.running_modifier) as peak_modifier
from running
join public.players p on p.id = running.player_id
group by running.player_id, p.display_name, p.email
order by peak_modifier desc;

-- security_invoker doesn't survive create-or-replace (0025's note applies
-- here too), so it's re-applied for both views.
alter view public.stats_modifier_peak_all_time set (security_invoker = on);
alter view public.stats_modifier_peak_last_30_days set (security_invoker = on);

-- Per-room history drill-down: a room's adjustments (actor, target, delta,
-- reason, timestamp), sibling to stats_room_rounds -- joined to players
-- twice (actor and target) the same way stats_room_rounds joins
-- starter/brewer.
create view public.stats_room_adjustments as
select
  ma.room_id,
  ma.id as adjustment_id,
  ma.created_at,
  ma.delta,
  ma.reason,
  actor.id as actor_id,
  actor.display_name as actor_display_name,
  actor.email as actor_email,
  target.id as target_id,
  target.display_name as target_display_name,
  target.email as target_email
from public.modifier_adjustments ma
join public.rooms ro on ro.id = ma.room_id
join public.players actor on actor.id = ma.actor_player_id
join public.players target on target.id = ma.target_player_id
where not ro.is_test
order by ma.created_at desc;

grant select on public.stats_room_adjustments to authenticated;
alter view public.stats_room_adjustments set (security_invoker = on);
