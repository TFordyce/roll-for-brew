-- get_open_reaction_window(uuid) -> table
--
-- The round's open reaction window (if any), plus whether the caller can act
-- on it and whether they've already passed this poll round -- what the
-- ribbon banner renders from. Issue #439: `eligible` is _is_reaction_source,
-- so a Courage Token holder with no Reaction card is prompted too. Otherwise
-- unchanged (0067).
--
-- Canonical source: this file is the source of truth for the function body.
-- Edit here and run `npm run build:migrations` -- do not hand-edit the
-- generated migration. See db/sql/README.md.

create or replace function public.get_open_reaction_window(p_round_id uuid)
returns table (window_id uuid, layer integer, poll_round integer, eligible boolean, already_passed boolean)
language plpgsql
security definer
set search_path = public
as $$
declare
  v_player_id text;
begin
  v_player_id := public.current_player_id(p_round_id);

  return query
    select w.id, w.layer, w.poll_round,
      public._is_reaction_source(p_round_id, v_player_id),
      public.has_passed_reaction_poll(w.id, w.poll_round, v_player_id)
      from public.spell_reaction_windows w
     where w.round_id = p_round_id and w.status = 'open'
     order by w.opened_at desc
     limit 1;
end;
$$;

revoke execute on function public.get_open_reaction_window(uuid) from public, anon;
grant execute on function public.get_open_reaction_window(uuid) to authenticated;
