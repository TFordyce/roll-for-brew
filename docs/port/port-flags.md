# Port flags (issue #536)

`public.port_flags` (migration `0158_port_flags.sql`) switches one TS wrapper between its SQL `.rpc` and the C# API.
`isPortEnabled(supabase, slice, roomId?)` in `src/lib/api/portFlags.ts` reads it: a room row beats the global row
(`room_id` null); no row or a read error means off (`.rpc`). A wrapper with no room id sees only the global row.

## Adding a flagged wrapper (#538, #565-568)

1. Add the endpoint in `api/` with `.Produces<T>()` and `.WithName("<wrapperName>")`.
2. `npm run gen:api` (needs the .NET SDK); commit `api/openapi/RollForBrew.Api.json` and `src/lib/api/schema.d.ts`.
3. Add a method to `ApiClient` in `src/lib/api/client.ts` (typed from `schema.d.ts`).
4. In the wrapper, keep the signature, add an optional trailing `api` injection param, and branch:
   `if (await isPortEnabled(supabase, "<wrapperName>", roomId)) return (await api().xxx()).field;` else the existing `.rpc`.
5. Unit-test both branches and room scoping like `src/lib/api/portFlags.test.ts`.

CI regenerates the contract and fails on `git diff` drift. The app needs `NEXT_PUBLIC_API_URL` (API base URL) wherever a flag is on.

## Flip on `getActingAs` (human step, not run by the agent)

Precondition: API deployed, `NEXT_PUBLIC_API_URL` set in Vercel, API `CORS_ORIGINS` includes the app origin.
The first slice has no room id, so the flag is global (all rooms), not Test-Room-only. Verify as an admin in the Test Room
(Acting As badge shows the same player as before; Network tab shows `GET /acting-as`).

```sql
insert into public.port_flags (slice, enabled) values ('getActingAs', true)
on conflict (slice, room_id) do update set enabled = true;
```

Rollback (instant, no deploy):

```sql
update public.port_flags set enabled = false where slice = 'getActingAs' and room_id is null;
-- or: delete from public.port_flags where slice = 'getActingAs';
```

Per-room scoping works by inserting `(slice, room_id)` rows (a room row overrides the global one); no wrapper passes a room id yet.

## Orders slice flags (#565, human step, not run by the agent)

Slices `submitOrder`, `getMyOrderForRound`, `getMyMostRecentOrder` (global rows; wrappers have no room id).
Endpoints: `PUT /rounds/{roundId}/order`, `GET /rounds/{roundId}/order`, `GET /orders/latest`. Same precondition and
rollback shape as `getActingAs`. Flip `submitOrder` first (the Order Window rules live in C# on that path).
The SQL `submit_order` and the `orders` grants stay until a 5-play-day soak; retirement is a separate human-gated step.

## Room entry and Acting As flags (#568, human step, not run by the agent)

Slices `enterTodaysRoom` (`POST /rooms/today/entry`) and `setActingAs` (`PUT /acting-as`), global rows only (no room id
exists before entry). Same precondition and rollback shape as `getActingAs`. `set_acting_as` stays admin-only; the
Test-Room-only override stays in `current_player_id` (SQL, bridged; ADR 0009 amendment). New problem codes (not RFBnn):
`admin_required_set_acting_as` (403), `acting_as_target_not_found` (404). The SQL `enter_todays_room`/`set_acting_as`
and their grants stay until a 5-play-day soak; retirement is a separate human-gated step. `current_player_id` stays.
