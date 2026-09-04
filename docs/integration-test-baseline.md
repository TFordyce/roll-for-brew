# Integration-suite baseline

Recorded for issue #338 (which subsumed #328's "catalogue the baseline" ask).

## How to reproduce

```
npx supabase db reset          # fresh stack, all migrations applied in order
npm run test:integration:local # or: npx vitest run tests/integration
```

`vitest` runs with `fileParallelism: false` (see `vitest.config.ts`); the whole
suite shares one local Supabase stack **and one "today's room"** — the room
`enter_todays_room` returns, joined by every `signUpSignInAndEnterRoom` call and
never deleted between tests.

## What the "26 red tests" (#328) actually were

Two distinct things, both now fixed under #338:

### 1. Shared-stack rot (the bulk)

On a long-lived dev stack, `schema_migrations` rows were present but earlier
DDL / data effects had drifted, and rows from prior runs had piled up. On a
freshly `db reset` stack, run in isolation, these files are green:
`stats.test.ts`, `brew-rating-stats.test.ts`, `spell-card-ratings.test.ts`,
`yorkshire-terror.test.ts`, `room-auto-creation.test.ts`.

### 2. Cross-file pollution of "today's room" (real, reproducible on a clean stack)

`draw-spell-card-as-forced-nat1.test.ts` and `ward-phase.test.ts` each flip
today's shared room to `is_test = true` for their own assertions and never
restore it. `enter_todays_room` doesn't reset the flag, so **every later file
that seeds real rounds into today's room and cares about `is_test`** breaks:

- all `stats_*` views filter `not rooms.is_test` → they return zero rows →
  `stats.test.ts` (8) and `brew-rating-stats.test.ts` (4) fail with `PGRST116`
  / `NaN` / empty-array assertions.
- `rate_spell_card` requires the qualifying cast's round to be in a non-test
  room → `spell-card-ratings.test.ts` (6) fail with `RFB43`.

This is why those files pass in isolation but fail in a full-suite run.

**Fix:** `tests/integration/setup.ts` gains `seedNonTestRoom(admin, cleanup)`
(a fresh `is_test = false` room with a null `date` — the `rooms_date_key`
partial unique index is `on (date) where not is_test`, and NULLs never collide
there) and `signUpSignInIntoNonTestRoom(...)`, which is
`signUpSignInAndEnterRoom` with `roomId` pointing at one of those instead of
today's shared room. `stats.test.ts`, `brew-rating-stats.test.ts` and
`spell-card-ratings.test.ts` route their `signUp` helper through it, so they no
longer depend on today's shared room. `rounds` / `round_participants` / `rooms`
are world-readable to `authenticated` (RLS `using (true)`), so a signed-in
client still reads rounds seeded there with no `room_players` membership.

Note: ADR 0002 treats a null `rooms.date` as the Test Room's defining property
and warns that sentinel dates "read as real data". A null-dated *non*-test room
is the mirror-image anomaly; it's tolerated only because it never leaves the
test suite (nothing in the app makes one, and `stats_room_history` — the only
reader that surfaces `date` — just sorts it last).

The two offending files were left as-is — the leak is theirs, but nothing
outside the three fixed files currently depends on today's room's `is_test`.
If a fourth file ever does, it should use `seedDedicatedRoom` too (or those two
tests should stop mutating the shared room).

## Genuine product defects found and fixed

Filed as #376 and #377; both fixed together in **migration
`0102_round_menu_decaf_and_grant.sql`** (one `drop view` / `create view` /
re-`grant`, mirroring `0063`).

1. **`round_menu` not granted to `service_role`** (#376) — `0062`/`0063` grant the
   view only to `authenticated`, though the same migration grants its base
   tables `usual_drinks`/`orders` to `service_role`. Five
   `usual-order-menu.test.ts` `round_menu` tests read it through the
   service-role admin client and hit `42501 permission denied for view
   round_menu`. No product path changes — the app reads `round_menu` as
   `authenticated`.

2. **`round_menu.decaf` returned `null`** (#377) for a participant with no matching
   Usual — fixing (1) unmasked it (the test couldn't read the view before).
   `usual_drinks.decaf` is `not null default false`; both
   `src/lib/supabase/menu.ts` (`decaf: boolean`) and the test assume the view
   never yields null there. The view now selects `coalesce(ud.decaf, false)`.

## Test-only fixes

- **`admin-delete-modifier-adjustment.test.ts`** — the "deletes an adjustment
  logged by someone else" test never called `makeAdmin` on its admin actor,
  so `RFB19` ("caller is not an admin") was the *correct* RPC response. Added
  `await makeAdmin(adminSub)`.
- **`room-auto-creation.test.ts`** — the "does not duplicate the room" test
  asserted a global `count` of today-dated rooms, which made it hostage to
  whatever else had already created the shared room. Rewritten to assert
  `enter_todays_room` idempotency + a per-player `room_players` count.
- **`yorkshire-terror.test.ts`** — no change; the file on `master` is already
  the reconciled version and its `in_deck` literal is correct (0075 ships an
  idempotent un-bench).

No test is `it.skip`/`describe.skip`-ped for a #338 reason.

## Telling regression from noise later

If a `stats_*` / `brew-rating` / `spell-card-ratings` test goes red, reset the
stack (`npx supabase db reset`) and re-run before treating it as a regression —
historically these fail on accumulated state or cross-file `is_test` pollution,
not on code.
