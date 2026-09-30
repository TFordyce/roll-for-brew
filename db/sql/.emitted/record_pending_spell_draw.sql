-- record_pending_spell_draw(uuid, text) -> void
--
-- Records that the caller's nat 1 / nat 20 has fired this round, without
-- drawing yet (0036, re-created by 0041) -- the client's crit entry point
-- (maybeRecordPendingSpellDraw).
--
-- Issue #435 (spec #401 F6): the row is recorded for _apply_crit_redirect's
-- recipient rather than the roller outright; a NULL recipient (a fizzled
-- redirect) records nothing. A no-op redirect today, so behaviour is
-- unchanged.
--
-- Canonical source: this file is the source of truth for the function body.
-- Edit here and run `npm run build:migrations` -- do not hand-edit the
-- generated migration. See db/sql/README.md.

create or replace function public.record_pending_spell_draw(p_round_id uuid, p_trigger text)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_player_id text;
  v_recipient text;
begin
  v_player_id := public.current_player_id(p_round_id);

  if p_trigger not in ('nat1', 'nat20') then
    raise exception 'record_pending_spell_draw: invalid trigger %', p_trigger;
  end if;

  v_recipient := public._apply_crit_redirect(p_round_id, v_player_id);
  if v_recipient is null then
    return;
  end if;

  insert into public.pending_spell_draws (round_id, player_id, trigger)
  values (p_round_id, v_recipient, p_trigger)
  on conflict (round_id, player_id) do nothing;
end;
$$;

revoke execute on function public.record_pending_spell_draw(uuid, text) from public, anon;
grant execute on function public.record_pending_spell_draw(uuid, text) to authenticated;
