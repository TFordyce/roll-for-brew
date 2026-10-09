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

## `room_view` (slice 1c, #539)

`room_view` renders a room from the C# API's `GET /rooms/{id}/view` instead of the page's per-panel reads. Unlike `getActingAs` it is read with a room id, so it can be Test-Room-only (a room row beats the global row). With no row, or any API failure on load, both room pages render exactly as before.

What the flag changes (pages become shells around `RoomViewProvider` + `RoomScreen`):

* The server component runs room entry, calls the view server-to-server with the user's JWT and passes it as `initialView`.
* One store (`src/lib/room/roomViewStore.ts`) holds the view. A response lands only if its request sequence is newer **and** its `version` is not lower (equal is accepted: `rooms.version` is not bumped by SQL writes yet). Refetches coalesce into one follow-up.
* One channel listener refetches on the old broadcast names and `room-changed`; the store also refetches on resubscribe, tab visible and when `nextStallDeadline` passes. No polling, no `router.refresh()`.
* The panels' own `refresh` calls go through `useRoomRefresh()`: `store.refetch()` under the provider, `router.refresh()` otherwise.
* Interim `enforceStall(roomId)` (`src/app/rounds/enforceStall.ts`) runs the stall timeout and the replay auto-decline on mount, resync and the deadline timer. Delete it with slice 7 (StallCheck).
* The view drops a round the moment it resolves, so `RoomScreen` keeps `RoundReveal` mounted until its results timer fires (`onRevealed` / `onResultsDone`).
* The Test Room now shows the same panels as the home page (rating aside), driven by `viewer.panels`; its "Roll For" list is read from SQL in the browser (`LiveRollForOthers`) because the view has no per-other-player roll duties.

### Flip on in the Test Room (human step, not run by the agent)

Precondition: API deployed with the #538 view endpoint, `NEXT_PUBLIC_API_URL` set in Vercel, API `CORS_ORIGINS` includes the app origin.

```sql
insert into public.port_flags (slice, room_id, enabled)
select 'room_view', id, true from public.rooms where is_test
on conflict (slice, room_id) do update set enabled = true;
```

Verify as an admin in `/admin/test-room`: the Network tab shows `GET /rooms/{id}/view`, a declare / close / roll from a second tab updates the first without a document reload, and Acting As switching changes the viewer.

Rollback (instant, no deploy):

```sql
update public.port_flags set enabled = false where slice = 'room_view';
```
