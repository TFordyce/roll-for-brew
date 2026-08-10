-- Gates the "how did you draw?" prompt (SpellDrawChoicePanel) on the
-- earning round having actually resolved or been cancelled (issue #248,
-- Spell Draw Window in CONTEXT.md).
--
-- Previously src/app/page.tsx showed the prompt whenever
-- get_pending_spell_draw(activeRound.id) returned a row and activeRound
-- was set — with no check on the round's own status, so it could fire
-- while the round was still open/closed, mid-tie-break, or mid-reaction-
-- window (root cause behind issue #251, patched at the symptom layer by
-- 0064). get_pending_spell_draw itself is unaffected — it stays a plain
-- per-round lookup, unchanged.
--
-- get_my_pending_spell_draw below is this ticket's actual fix: the
-- caller's own oldest outstanding pending_spell_draws row whose round has
-- reached 'resolved' or 'cancelled', plus a count of any other eligible
-- rows still waiting behind it (queued oldest-first, one shown at a time —
-- pending_spell_draws has no expiry, so a player who ignores the prompt
-- across rounds can accumulate more than one). Rows still sitting on an
-- open/closed round aren't counted as "waiting" — they haven't earned
-- their moment yet.
--
-- Mirrors the *design* getMyRateableRound (src/lib/supabase/brewRatings.ts)
-- already established: its own dedicated, activeRound-independent query
-- rather than reusing an existing round-scoped lookup, since getActiveRound
-- (src/lib/supabase/rounds.ts) never returns a resolved round to hang this
-- off of. Unlike getMyRateableRound (a plain client-side read — every table
-- it touches is already readable under existing RLS), this one goes through
-- a security-definer RPC instead: pending_spell_draws' own RLS policy is
-- round-scoped (current_player_id(round_id)), which has no round to check
-- against when finding the oldest eligible row across every round at once.
create or replace function public.get_my_pending_spell_draw()
returns table (round_id uuid, trigger text, other_count bigint)
language plpgsql
security definer
set search_path = public
as $$
declare
  v_player_id text;
begin
  v_player_id := public.current_player_id();

  return query
    with eligible as (
      select psd.round_id, psd.trigger, psd.created_at
        from public.pending_spell_draws psd
        join public.rounds r on r.id = psd.round_id
       where psd.player_id = v_player_id
         and r.status in ('resolved', 'cancelled')
    )
    select e.round_id, e.trigger, (select count(*) - 1 from eligible) as other_count
      from eligible e
     order by e.created_at asc
     limit 1;
end;
$$;

revoke execute on function public.get_my_pending_spell_draw() from public, anon;
grant execute on function public.get_my_pending_spell_draw() to authenticated;
