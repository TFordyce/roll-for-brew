-- Round Recap and Round Backfill through the API (spec #533, slice 2b-2, issue #548). Additive.
--
-- Two flags, both seeded OFF, each routing one TS wrapper. They are separate from
-- 'advanceRoundAuthoritative' so a problem in one can be rolled back without touching a round
-- in play, and neither depends on who decides advancement. Flips are human steps:
-- docs/port/recap-backfill-bridges.md.
--
-- The API needs no new grant: it reads and writes these tables under the rfb_api role's DML
-- (0157), and calls no new SQL function. get_round_recap, _rr_resolve and admin_backfill_round
-- are the rollback and stay until #549.

insert into public.port_flags (slice, enabled)
values ('getRoundRecap', false), ('adminBackfillRound', false)
on conflict (slice, room_id) do nothing;
