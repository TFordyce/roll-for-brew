-- The stats_* views (0006) are queryable views, not tables, so RLS
-- policies can't attach to them directly — Supabase's security advisor
-- flags them "Unrestricted" for that reason. They're already safe today
-- (grant select is scoped to `authenticated` only, never anon/public), but
-- by default a view runs with its owner's privileges rather than the
-- querying user's, so it would silently keep bypassing RLS on
-- rounds/round_participants/players even if that RLS were tightened later.
-- security_invoker makes each view run as the calling user instead, so it
-- always reflects whatever RLS is actually in force on the underlying
-- tables.
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
