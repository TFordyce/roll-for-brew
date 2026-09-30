-- _apply_crit_redirect(uuid, text) -> text
--
-- Issue #435 (spec #401 F6, #383 Q5): the shared crit-redirect hook. Given
-- that p_player_id just rolled a nat 1 / nat 20 in p_round_id, returns the
-- player the crit's spell draw goes to. NULL means the draw fizzles.
--
-- Called from all three crit entry points, before the draw is recorded for
-- anyone:
--   * record_pending_spell_draw (the client's pending-draw record);
--   * admin_proxy_roll (its direct pending_spell_draws insert);
--   * draw_spell_card_as when given a round (the Test-room puppet path, which
--     draws immediately and has no pending row).
-- Returning the recipient rather than rewriting a pending row keeps the
-- puppet path on the same hook.
--
-- A no-op for now: every crit draws for the roller. Marked for Brew (#401)
-- fills it in -- the oldest live next_crit draw_redirect mark on the roller
-- names the beneficiary, and firing it records consumption on the mark's
-- source cast.
--
-- Internal: no grant; only reached from the SECURITY DEFINER entry points.
--
-- Canonical source: this file is the source of truth for the function body.
-- Edit here and run `npm run build:migrations` -- do not hand-edit the
-- generated migration. See db/sql/README.md.

create or replace function public._apply_crit_redirect(p_round_id uuid, p_player_id text)
returns text
language plpgsql
set search_path = public
as $$
begin
  return p_player_id;
end;
$$;

revoke execute on function public._apply_crit_redirect(uuid, text) from public, anon, authenticated;
