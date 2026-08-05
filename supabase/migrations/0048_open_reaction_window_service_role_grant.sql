-- Fix #146: open_reaction_window is granted EXECUTE to `authenticated` only
-- (0021), so a service-role (admin/test) client calling it directly --
-- needed to force-open a reaction window without going through a real
-- player's turn -- gets a 42501 permission-denied error, even though the
-- function is security definer and RLS-bypassing service_role should be
-- able to call it like every other server-side surface (see 0015, 0042).
grant execute on function public.open_reaction_window(uuid, integer) to service_role;
