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

The two offending files were left as-is at the time. *Superseded by #422 (below):
they now use a dedicated Test Room, and nothing mutates today's room.*

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

## #422 — six full-suite reds after the round-advancement chain (2026-09-30)

Four failures were seen in full-suite runs on the #417 branch and two more on the
#411 branch. Every one reproduced on a fresh `db reset` stack at master `866d377`,
or was driven red on purpose. **None was a product regression.** `submit_order`
(0062) and `withdraw_brew_rating` (0058) are unchanged since they shipped, and
#414–#416 didn't touch them.

Isolated on a fresh stack, all five files passed: brew-ratings 12/12,
usual-order-menu 18/18, ward-phase 21/21, ward-transfer 7/7, regression-net
30/30. The first fresh full-suite run gave `4 failed | 516 passed (520)`.

| Test | Evidence | Class |
|---|---|---|
| brew-ratings › rejects withdraw once the rating window has closed (RFB27) | `expected null to be truthy`, the *submit* is rejected before the withdraw | today's-room pollution |
| usual-order-menu › submit_order › stays open through a round's own resolution | `expected { code: 'RFB30', … } to be null` | today's-room pollution |
| ward-transfer › Bitter Leech tick on a warded victim | teardown: `… violates foreign key constraint "spell_casts_target_player_id_fkey"` | teardown race (flake, 1 in 6 even run alone) |
| trace-snapshot › 3-pre-calami-tea-tick-warded | same teardown error (#411 saw the `rounds_started_by_fkey` variant) | same teardown race |
| regression-net › Wild Brew Surge (both tests) | `expected -7 to be -5` / `expected +0 to be 1` | today's-room pollution (leaked players) |
| ward-phase › submit_roll_as blocks a static advantage … admin-puppet path | not reproduced: green alone, in the full suite and 3× on a polluted stack; no error text was captured | not reproduced; its pollution source is removed |

### 1. Window tests vs. rounds resolved in today's room

The Order Window (RFB30) and Rating Window (RFB27) both close on **any newer
resolved round in the same room**. Both tests seed rounds backdated an hour into
today's shared room. Any round that another file resolved there in the last hour
closes the window early. **Fix:** both files use `signUpSignInIntoNonTestRoom`,
brew-ratings for the whole file and usual-order-menu for its `submit_order`
block.

### 2. Silent round-delete race in `createTestCleanup`

`spell_casts.source_cast_id` (0085) has no `ON DELETE` clause, and it points
across rounds. A later round's Bitter Leech / Calami-Tea tick rows reference the
cast in the earlier round. Cleanup deleted the tracked rounds concurrently and
ignored their errors. So when the earlier round's delete ran first, it was
rejected with `spell_casts_source_cast_id_fkey` (confirmed with a tagged log).
Its casts survived, and they then blocked the player delete. **Fix:**
`deleteRounds` retries failed round deletes until a pass makes no progress, and
throws on a real leak instead of swallowing it. The Leech test went from 1 red
in 6 to 10/10 green, and Calami-Tea 5/5.

Each leaked player also stays in today's room, which feeds #3. The same FK
also affects the product's `admin_delete_round`, filed separately as #441.

### 3. Wild Brew Surge picks a random stranger from today's room

Branches 3 and 5 pick the swap partner from **every** `room_players` row
(`order by random()`). Today's room collects every player a teardown ever
leaked. With 8 strangers planted there, the tests went red 4 out of 4, with
exactly the reported deltas. **Fix:** a new `seedDedicatedRoom(admin, cleanup,
playerIds)` makes a null-dated room with exactly those `room_players`, and the
WBS tests call `start_round({ p_room_id })` on it. Green 4/4 on the same
polluted stack.

### 4. `is_test` flips fork today's room

`ward-phase` and `draw-spell-card-as-forced-nat1` flipped today's shared room to
`is_test = true`, as recorded under #338 above. That does more than empty the
stats views. The `rooms_date_key` index only covers `not is_test` rooms, so the
next `enter_todays_room` inserts a **second** today-dated room. Both it and
`start_round()` then `select id … where date = today` with no `not is_test`
filter and no `STRICT`, and each takes whichever row comes back first. Nothing
outside the tests ever sets `is_test` on a dated room, so the product is not
affected. **Fix:** both tests now use `seedDedicatedRoom(…, { isTest: true })`.
No test in the suite mutates today's room any more. Ward-phase's
`openAndCloseRound` also passes `p_room_id` explicitly.

### Rule of thumb going forward

If a test's assertion depends on *who else* is in the room, or on *what else
resolved* there, it belongs in `seedDedicatedRoom` / `seedNonTestRoom`, not in
today's shared room.

## Telling regression from noise later

If a `stats_*` / `brew-rating` / `spell-card-ratings` test goes red, reset the
stack (`npx supabase db reset`) and re-run before treating it as a regression —
historically these fail on accumulated state or cross-file `is_test` pollution,
not on code.
