-- Decaf preference for Usual tea/coffee (issue #237, scoped from a grilling
-- session on 2026-08-09; see CONTEXT.md's Usual/Order/Menu entries). Decaf
-- is per drink-type, not a single global flag -- a player's tea and coffee
-- Usuals track it independently, same as milk/sugar already do. It's a hard
-- requirement on the Usual ("always decaf"), not an order-time override:
-- there's no decaf column on `orders`, and `round_menu` reads it live from
-- `usual_drinks` the same way it already reads milk/sugar (ADR 0003).
alter table public.usual_drinks
  add column decaf boolean not null default false;

-- Recreate round_menu (0062) to also select decaf. The data is available
-- live here; RoundMenu.tsx's on-screen treatment of it is deferred to a
-- separate prototype issue (#238) -- this migration only makes the column
-- readable, it doesn't decide how it's displayed.
drop view public.round_menu;

create view public.round_menu
with (security_invoker = on) as
select
  rp.round_id,
  rp.player_id,
  o.drink_type,
  ud.milk,
  ud.sugar,
  ud.decaf,
  (ud.player_id is null) as no_preference_set
from public.round_participants rp
join public.orders o on o.round_id = rp.round_id and o.player_id = rp.player_id
left join public.usual_drinks ud on ud.player_id = rp.player_id and ud.drink_type = o.drink_type;

grant select on public.round_menu to authenticated;
