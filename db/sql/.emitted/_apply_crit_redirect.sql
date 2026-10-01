-- _apply_crit_redirect(uuid, text) -> text
--
-- Issue #435 (spec #401 F6, #383 Q5): the shared crit-redirect hook. Given
-- that p_player_id just rolled a nat 1 / nat 20 in p_round_id, returns the
-- player the crit's spell draw goes to. Callers record nothing on a NULL
-- (reserved; no redirect returns one today).
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
-- Issue #436 (Marked for Brew): the oldest live `next_crit` draw_redirect
-- mark on the roller fires -- oldest first by created_at, then id. "Live" is
-- _rr_active_effects_as_of as of this round (not countered, not spent,
-- inside the target's 5 participated rounds after the cast); a mark never
-- fires in its own cast round. Firing spends it for good: the source cast
-- records cast_inputs.consumed_by_round = this round, consumed_at_layer,
-- consumed_in_generation and draw_redirect_outcome:
--   * `redirected` -- the draw goes to the beneficiary (the mark's caster);
--   * `fizzled`    -- the beneficiary already has a pending draw this round
--                     (pending_spell_draws is keyed by round + player), so
--                     the redirect fizzles and the roller keeps their own
--                     draw. Checked here, not left to the callers' `on
--                     conflict do nothing`, so a spent mark never silently
--                     drops a draw. The puppet path draws without a pending
--                     row, so there it can only collide with a pending row
--                     from an in-app or proxied crit; the Test room is
--                     admin-only, so that is accepted.
-- Only the first mark fires per crit; any others wait for the next one. A
-- second crit in the same round (a tie-break layer) finds the fired mark
-- spent and draws for the roller.
--
-- Idempotent per crit: firing also records the round's current_layer and
-- replay_generation. A repeat call for the same player, round, layer and
-- generation -- a retried request, not a new crit -- returns the recipient
-- already chosen instead of drawing a second time for the roller. A crit in
-- a tie-break layer or a Round replay's next generation is a new crit.
--
-- Concurrency: every crit takes a transaction-scoped advisory lock on its
-- recipient's draw slot (round, player) before returning, and a firing mark
-- takes (round, roller) and (round, beneficiary) in a fixed order and
-- re-reads. So a crit landing on the same slot waits for the other's insert,
-- and the fizzle check sees it.
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
declare
  v_room_id uuid;
  v_started_at timestamptz;
  v_layer integer;
  v_generation integer;
  v_mark record;
  v_fired record;
  v_outcome text;
begin
  select room_id, started_at, current_layer, replay_generation
    into v_room_id, v_started_at, v_layer, v_generation
    from public.rounds
   where id = p_round_id;

  for pass in 1..2 loop
    -- A retry of a crit this hook already handled: same answer again.
    select src.caster_id as beneficiary_id, src.cast_inputs ->> 'draw_redirect_outcome' as outcome
      into v_fired
      from public.spell_casts src
     where src.effect_kind = 'draw_redirect'
       and src.target_player_id = p_player_id
       and src.cast_inputs ->> 'consumed_by_round' = p_round_id::text
       and (src.cast_inputs ->> 'consumed_at_layer')::integer = v_layer
       and (src.cast_inputs ->> 'consumed_in_generation')::integer = v_generation
     limit 1;

    if found then
      return case when v_fired.outcome = 'redirected' then v_fired.beneficiary_id else p_player_id end;
    end if;

    select sae.caster_id as beneficiary_id, sae.source_cast_id
      into v_mark
      from public._rr_active_effects_as_of(v_room_id, p_round_id) sae
      join public.spell_casts src on src.id = sae.source_cast_id
      join public.rounds src_round on src_round.id = src.round_id
     where sae.target_player_id = p_player_id
       and sae.effect_kind = 'draw_redirect'
       and sae.effect_params ->> 'trigger' = 'next_crit'
       and src_round.started_at < v_started_at
     order by sae.created_at, sae.id
     limit 1;

    if not found then
      -- The roller's own slot, so a redirect landing on them waits for
      -- this draw's insert. One lock only: never part of a deadlock.
      perform pg_advisory_xact_lock(hashtextextended(p_round_id::text || ':' || p_player_id, 0));
      return p_player_id;
    end if;

    exit when pass = 2;

    -- Lock both draw slots in a fixed order, then re-read: a concurrent
    -- crit may have spent the mark while this one waited.
    perform pg_advisory_xact_lock(hashtextextended(p_round_id::text || ':' || x, 0))
       from unnest(array[p_player_id, v_mark.beneficiary_id]) as x
      order by x;
  end loop;

  v_outcome := case
    when exists (
      select 1 from public.pending_spell_draws
       where round_id = p_round_id and player_id = v_mark.beneficiary_id
    ) then 'fizzled'
    else 'redirected'
  end;

  update public.spell_casts
     set cast_inputs = coalesce(cast_inputs, '{}'::jsonb)
                       || jsonb_build_object(
                            'consumed_by_round', p_round_id,
                            'consumed_at_layer', v_layer,
                            'consumed_in_generation', v_generation,
                            'draw_redirect_outcome', v_outcome
                          )
   where id = v_mark.source_cast_id;

  return case when v_outcome = 'redirected' then v_mark.beneficiary_id else p_player_id end;
end;
$$;

revoke execute on function public._apply_crit_redirect(uuid, text) from public, anon, authenticated;
