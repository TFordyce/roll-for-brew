-- Spell draws on the C# API (spec #533, slice 4, issue #553). Additive.
--
-- 1. Four port flags, seeded OFF, one per TS wrapper. Each routes that wrapper to the API
--    (`useApiForRound`); with no row or the row off, the wrapper keeps its SQL `.rpc`, which is the
--    rollback. Flips are human steps: docs/port/spell-draws-bridges.md.
-- 2. EXECUTE for rfb_api on the card-landing bridge (_land_drawn_instance) and the two functions it
--    calls (_lock_next_draw_mark, _rr_free_hand_slot). The crit-redirect bridge and its callees were
--    granted in 0167. Repo policy revokes PUBLIC execute, so DML alone is not enough (0157).
--    record_pending_spell_draw, draw_pending_spell_card, draw_pending_spell_card_manual and
--    draw_spell_card_as get NO grant: C# replaced them.
insert into public.port_flags (slice, enabled)
select s, false
  from unnest(array[
    'recordPendingSpellDraw', 'drawPendingSpellCard', 'drawPendingSpellCardManual', 'drawSpellCardAs'
  ]) as s
on conflict (slice, room_id) do nothing;

grant execute on function public._land_drawn_instance(text, uuid, text) to rfb_api;
grant execute on function public._lock_next_draw_mark(text) to rfb_api;
grant execute on function public._rr_free_hand_slot(text) to rfb_api;
