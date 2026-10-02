-- get_my_courage_tokens(uuid) -> table
--
-- Issue #439: the caller's live, unspent Courage Tokens as of the round,
-- oldest first, with who gave each -- what the Reaction banner offers to
-- spend. Spendable only in a Layer-0 window (spend_courage_token checks); the
-- banner reads the window's layer.
--
-- Canonical source: this file is the source of truth for the function body.
-- Edit here and run `npm run build:migrations` -- do not hand-edit the
-- generated migration. See db/sql/README.md.

create or replace function public.get_my_courage_tokens(p_round_id uuid)
returns table (effect_id uuid, giver_player_id text, giver_display_name text, dice text)
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_player_id text;
begin
  v_player_id := public.current_player_id(p_round_id);

  return query
    select t.effect_id, t.caster_id, coalesce(p.display_name, p.email), t.dice
      from public._unspent_courage_tokens(p_round_id, v_player_id) t
      join public.players p on p.id = t.caster_id;
end;
$$;

revoke execute on function public.get_my_courage_tokens(uuid) from public, anon;
grant execute on function public.get_my_courage_tokens(uuid) to authenticated;
