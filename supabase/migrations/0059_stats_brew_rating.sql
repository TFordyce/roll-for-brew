-- Brew Rating stats aggregation (issue #210, part of #208): the
-- stats_brew_rating_{all_time,last_30_days} view pair, aggregating
-- brew_ratings (0058) into a per-brewer average. Follows the stats_*
-- family shape (stats_modifier_peak_{all_time,last_30_days}, 0053, as the
-- most recent example) -- join rounds -> rooms, filter "where not
-- ro.is_test". Exposes only avg(score) per brewer -- deliberately no
-- count(*) at all, not just hidden in the UI, per the "no rating count
-- shown" spec decision, so there's no accidental way to infer sample size
-- from the API surface.
--
-- Deviation from the rest of the stats_* family: these two views must NOT
-- set security_invoker = on. Every other stats_* view uses
-- security_invoker so it runs as the querying user, which is safe because
-- the underlying tables are world-readable. brew_ratings is the opposite --
-- its RLS (0058) deliberately hides raw rows from everyone but the rater
-- who created them -- so these views must run as the view owner (the
-- default, security_invoker unset/off) to see across all raters' hidden
-- rows and produce a real aggregate. This is a conscious, documented
-- exception: do not "fix" it back to the family default, or the aggregate
-- silently collapses to just the querying user's own rating.
create view public.stats_brew_rating_all_time as
select
  br.brewer_id as player_id,
  avg(br.score) as average_score
from public.brew_ratings br
join public.rounds r on r.id = br.round_id
join public.rooms ro on ro.id = r.room_id
where not ro.is_test
group by br.brewer_id;

grant select on public.stats_brew_rating_all_time to authenticated;

create view public.stats_brew_rating_last_30_days as
select
  br.brewer_id as player_id,
  avg(br.score) as average_score
from public.brew_ratings br
join public.rounds r on r.id = br.round_id
join public.rooms ro on ro.id = r.room_id
where not ro.is_test and br.created_at >= now() - interval '30 days'
group by br.brewer_id;

grant select on public.stats_brew_rating_last_30_days to authenticated;
