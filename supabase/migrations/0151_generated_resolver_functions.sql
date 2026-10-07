-- GENERATED FROM db/sql/functions/ -- DO NOT EDIT
--
-- Written by `npm run build:migrations` from the canonical resolver-function
-- sources under db/sql/functions/. To change any function below, edit its
-- db/sql/functions/<name>.sql and re-run the build. See db/sql/README.md.
--
-- Functions in this migration:
--   _is_reaction_source

-- BEGIN db/sql/functions/_is_reaction_source.sql
-- _is_reaction_source(uuid, text) -> boolean
--
-- Issue #439: whether p_player_id has a Reaction Source (GLOSSARY.md) in
-- p_round_id -- the one predicate behind every Reaction-eligibility read:
-- opening and holding a window (count_eligible_reaction_holders), passing it
-- (pass_reaction_window), the players being waited on (pending players, the
-- Skip vote, the stall timeout: _reaction_window_waiting_on) and the caller's
-- own `eligible` (get_open_reaction_window).
--
-- A Reaction Source is, for a round participant who is not stall-excluded:
--   * a held Reaction-timed card (holds_usable_reaction_card, unchanged); or
--   * a live, unspent Courage Token (_unspent_courage_tokens), but only while
--     the round is at Layer 0 and the player has a Layer-0 roll -- the token
--     adds to that roll, so a tie-break window, or a player with no roll
--     (Roll Exemption, stall-excluded), has nothing to spend it on.
--
-- Issue #463: a stall-excluded participant (round_participants.excluded_at)
-- is never a Reaction Source, whatever they hold -- they have stalled out, so
-- counting them would hold the window open until the reaction timeout.
-- Tie-break exclusion (round_layer_participants) needs no check: windows only
-- open at Layer 0.
--
-- plpgsql, not sql: the body is not validated at create time, so the
-- generated migration may create this before _unspent_courage_tokens.
--
-- Canonical source: this file is the source of truth for the function body.
-- Edit here and run `npm run build:migrations` -- do not hand-edit the
-- generated migration. See db/sql/README.md.

create or replace function public._is_reaction_source(p_round_id uuid, p_player_id text)
returns boolean
language plpgsql
stable
security definer
set search_path = public
as $$
begin
  return exists (
           select 1 from public.round_participants rp
            where rp.round_id = p_round_id and rp.player_id = p_player_id
              and rp.excluded_at is null
         )
     and (
       public.holds_usable_reaction_card(p_player_id)
       or (
         (select current_layer from public.rounds where id = p_round_id) = 0
         and exists (
           select 1 from public.rolls
            where round_id = p_round_id and player_id = p_player_id and layer = 0
         )
         and exists (select 1 from public._unspent_courage_tokens(p_round_id, p_player_id))
       )
     );
end;
$$;

revoke execute on function public._is_reaction_source(uuid, text) from public, anon, authenticated;
grant execute on function public._is_reaction_source(uuid, text) to service_role;
-- END db/sql/functions/_is_reaction_source.sql

