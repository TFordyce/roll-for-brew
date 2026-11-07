# Broadcasts are in-transaction versioned hints; clients refetch one room view

## Status

accepted — 2026-10-08. Decided on the C# port map ([#476](https://github.com/TFordyce/roll-for-brew/issues/476)): [Decide realtime broadcasts after commit](https://github.com/TFordyce/roll-for-brew/issues/486), [Decide the room-view DTO and client room store](https://github.com/TFordyce/roll-for-brew/issues/494).

## Decision

- **Sender.** The API calls `public.rfb_broadcast(topic, event, payload)` **inside the write's transaction**. It is a `postgres`-owned `security definer` wrapper with `search_path = ''` and EXECUTE to `rfb_api` only, and it runs `realtime.send(payload, event, 'room:<id>', private => false)`. `rfb_api` cannot call `realtime.send` itself: it has no usage on the `realtime` schema and `postgres` cannot grant it (verified on [#532](https://github.com/TFordyce/roll-for-brew/issues/532)). The wrapper is plumbing, not rules logic, so it stays in Postgres after the port. Postgres delivers the message only on commit, the actor never waits on a send, and nothing is lost between commit and send. `realtime.send` turns failures into a `WarnSendingBroadcastMessage` warning, so by default the API treats that warning as an error and rolls back (503 `broadcast_failed`). Amended 2026-11-07 ([spec #533](https://github.com/TFordyce/roll-for-brew/issues/533)): Room entry, Orders and Modifier Adjustments send with `Announce.BestEffort`. A swallowed send there is logged as `rfb-broadcast-unsent` and the write still commits, with `rooms.version` bumped, so other clients catch up on their next refetch (resubscribe, tab visible, or the next broadcast). A dropped hint should never stop someone ordering tea or taking a seat. Round advancement and Round Backfill stay `Announce.Required`, because a resolution nobody hears about leaves the table waiting on a round that has already finished. Whoever commits a write sends its broadcast. Unported TS actions keep `httpSend`, switched to the new vocabulary.
- **Vocabulary.** The 9 refetch-only events collapse into `room-changed { version }`. `layer-rolls-revealed`, `round-revealed` and `layer-tied` stay for animation only, each also carrying `version`. Rule: a view fetched with no broadcast at all must render the same end state.
- **Version.** `rooms.version` is a counter bumped by API writes inside their transaction. An empty write list bumps nothing and broadcasts nothing.
- **Visible writes announce themselves** (amended 2026-11-07, [spec #533](https://github.com/TFordyce/roll-for-brew/issues/533)). Every ported write that changes what another player sees bumps `rooms.version` and sends `room-changed` carrying it, even when its SQL original sent nothing. Fillers do it through `StoreSession.BumpAndAnnounce`. That covers Round Backfill, Room entry (only when a seat is created), Orders (the round's menu lists every participant's order), and Modifier Adjustment log, undo and admin delete (roster modifiers). Two writes stay silent because no other viewer's room view changes. Brew Ratings and Spell Card Ratings reach the view only as the rater's own `MyScore`, and no aggregate is shown in the room. Set Acting As changes only the admin's own view, and their own client refetches.
- **Receiver.** Clients refetch `GET /rooms/{id}/view`. It returns one per-viewer screen model, `{ version, room, viewer }`, computed in C# from the `RoundSnapshot`. A small `useSyncExternalStore` room store applies a response only if its request is newer **and** its `version` is not lower, and it coalesces refetches. The store also refetches on resubscribe and when the tab becomes visible. There's no polling and no `router.refresh()`.
- **Channel** stays public `room:<id>`, because payloads carry no private state.

## Considered

- **Send after commit from the API over REST.** Kept only as a fallback if hosted delivery of `private => false` fails the slice-0 check. It adds a send the actor waits on, and the event is lost if the process dies between commit and send.
- **Outbox table + DB trigger / `pg_notify`.** Rejected: it needs a session-mode connection or a worker, which conflicts with the transaction pooler and scale-to-zero.
- **Fat broadcasts carrying state.** Rejected: payloads would need per-viewer secrecy, so the channel would have to go private, and a lost message would still leave a stale client.
- **Keep `router.refresh()`.** Rejected: each event triggers about 44 serial reads on every device. That is the measured cause of the sluggish live updates.

## Consequences

- Live updates cost one API request per device per change. That comes to about 46k Realtime messages and 55k Cloud Run requests a month, roughly 15–40x inside the free tiers.
- Until every write is ported, unported SQL paths send `room-changed` with no version. The client's request-sequence rule covers that gap.
