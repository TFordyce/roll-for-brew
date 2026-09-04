-- round_menu: grant the view to service_role (#376), and stop decaf coming
-- back null (#377). Both surfaced by the usual-order-menu integration tests
-- under #338 (Cluster C).
--
-- Two defects the tests surfaced once they could actually read the view:
--
-- 1. 0062/0063 grant round_menu only to `authenticated`, even though the
--    same 0062 migration grants its base tables (usual_drinks, orders) to
--    `service_role`. The Menu read path in the app goes through an
--    authenticated client (src/lib/supabase/menu.ts), so this is not a
--    product bug -- but the integration tests read the view through the
--    service-role admin client to assert across every participant's row at
--    once, and hit `42501 permission denied for view round_menu`.
--
-- 2. 0063 added `decaf` to the view as a bare `ud.decaf`. usual_drinks.decaf
--    is `not null default false` and has no "unset" state -- unlike
--    milk/sugar, which are nullable and legitimately come back null when a
--    player has no Usual for the ordered drink. But the left join still
--    yields SQL NULL for `ud.decaf` on a miss. Both consumers already
--    assume it can't: src/lib/supabase/menu.ts types the field
--    `decaf: boolean` ("`false` (not `null`) when noPreferenceSet"), and
--    the test asserts `decaf: false` alongside `no_preference_set: true`.
--
-- Recreate the view (0063 byte-for-byte except `coalesce(ud.decaf, false)`)
-- and grant SELECT to both roles. `drop view` without cascade matches 0063;
-- round_menu is a leaf view with no SQL dependents.
drop view public.round_menu;

create view public.round_menu
with (security_invoker = on) as
select
  rp.round_id,
  rp.player_id,
  o.drink_type,
  ud.milk,
  ud.sugar,
  coalesce(ud.decaf, false) as decaf,
  (ud.player_id is null) as no_preference_set
from public.round_participants rp
join public.orders o on o.round_id = rp.round_id and o.player_id = rp.player_id
left join public.usual_drinks ud on ud.player_id = rp.player_id and ud.drink_type = o.drink_type;

grant select on public.round_menu to authenticated;
grant select on public.round_menu to service_role;
