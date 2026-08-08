# Order's milk/sugar is a live join to Usual, not a snapshot

An Order (a player's per-round tea/coffee pick) never re-specifies milk or sugar — it inherits them from the player's matching Usual (`usual_tea`/`usual_coffee`). The question is whether that inheritance is captured once, at pick time, or read fresh every time the Menu is displayed.

We chose the live join: the Menu always shows whatever the player's Usual currently says, for every Order that references it — including Orders on already-`resolved` rounds. There is no per-Order copy of milk/sugar anywhere in the schema; the Menu is a computed join across `round_participants` × `orders` × `usual_tea`/`usual_coffee`, not a materialized or snapshotted row.

The deliberate tradeoff: if a player edits their Usual mid-round (or even after resolution, since Orders stay editable through `resolved` — see [0004](./0004-order-decoupled-from-declare-in.md)), every Menu referencing that Usual shifts under whoever's reading it, including a brewer who already started making the drinks. This was chosen anyway on the reasoning that a Usual is a standing statement of "how I currently take my tea/coffee" — if it's wrong, the player fixing it should fix it everywhere, not leave old Menus quietly stale. A future reader debugging "why did the tea list change" should look here first.

## Considered

- **Snapshot at pick-time** (Order stores its own copy of milk/sugar) — rejected: the append-only, point-in-time style used by Modifier Adjustment would have been the safer default (immune to retroactive edits), but the user preferred the live join explicitly during design discussion.
