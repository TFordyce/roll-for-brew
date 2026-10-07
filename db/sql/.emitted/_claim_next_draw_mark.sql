-- _claim_next_draw_mark(text) -> table(beneficiary_id text, source_cast_id uuid)
--
-- Issue #471: the one read of "does this player have a live Stale Biscuit
-- mark", shared by _land_drawn_instance (a draw fires it) and
-- admin_allocate_spell_card (an allocation warns about it, or fires it when
-- the admin picks the beneficiary). Lifted out of _land_drawn_instance (#437).
--
-- Returns the oldest live `next_draw` draw_redirect mark on p_player_id --
-- oldest first by created_at, then id -- or no row. "Live" is
-- _rr_active_effects_as_of in the mark's room as of that room's latest round
-- (not countered, not spent, not dispelled), and the mark's cast round has
-- resolved, so a counter still to come in that round cannot un-happen a
-- redirect. The mark's cast row is locked FOR UPDATE and re-checked unspent,
-- so two concurrent callers never spend one mark twice; the caller spends it
-- (cast_inputs.consumed_by_draw / draw_redirect_outcome) in the same
-- transaction, or leaves it live.
--
-- Internal: no grant; only reached from SECURITY DEFINER RPCs.
--
-- Canonical source: this file is the source of truth for the function body.
-- Edit here and run `npm run build:migrations` -- do not hand-edit the
-- generated migration. See db/sql/README.md.

create or replace function public._claim_next_draw_mark(p_player_id text)
returns table (beneficiary_id text, source_cast_id uuid)
language plpgsql
set search_path = public
as $$
declare
  v_mark record;
begin
  loop
    select m.caster_id as beneficiary_id, m.source_cast_id
      into v_mark
      from (
        select distinct sae.room_id
          from public.spell_active_effects sae
         where sae.target_player_id = p_player_id
           and sae.effect_kind = 'draw_redirect'
           and sae.effect_params ->> 'trigger' = 'next_draw'
      ) mark_room
      cross join lateral (
        select r.id from public.rounds r
         where r.room_id = mark_room.room_id
         order by r.started_at desc
         limit 1
      ) latest
      cross join lateral public._rr_active_effects_as_of(mark_room.room_id, latest.id) m
      join public.spell_casts src on src.id = m.source_cast_id
      join public.rounds src_round on src_round.id = src.round_id
     where m.target_player_id = p_player_id
       and m.effect_kind = 'draw_redirect'
       and m.effect_params ->> 'trigger' = 'next_draw'
       and src_round.resolved_at is not null
     order by m.created_at, m.id
     limit 1;

    if not found then
      return;
    end if;

    -- Still unspent once locked: claim it. Otherwise a concurrent caller
    -- just spent it -- look again.
    perform 1 from public.spell_casts
     where id = v_mark.source_cast_id
       and cast_inputs ->> 'consumed_by_draw' is null
       for update;
    if found then
      beneficiary_id := v_mark.beneficiary_id;
      source_cast_id := v_mark.source_cast_id;
      return next;
      return;
    end if;
  end loop;
end;
$$;

revoke execute on function public._claim_next_draw_mark(text) from public, anon, authenticated;

comment on function public._claim_next_draw_mark(text) is
  'Issue #471: the player''s oldest live next_draw Draw Redirect mark (Stale Biscuit) -- beneficiary + source cast, its cast row locked and unspent -- or no row. Shared by _land_drawn_instance and admin_allocate_spell_card; the caller spends it. Internal.';
