# Order milk/sugar is a live join, not a snapshot

An Order (`orders`) records only `round_id`, `player_id`, and `drink_type` — no `milk`/`sugar` columns. The Menu (`round_menu`) reads a player's milk/sugar for their Order by joining out to their *current* `usual_drinks` row at query time, rather than copying those values onto the Order when it's submitted.

This means editing a Usual retroactively changes what every Menu that references it displays — including for already-resolved rounds. A player who fixes a typo in their Usual after brewing has already happened will see that fix reflected if they (or the brewer) look at that round's Menu again later.

The alternative — snapshotting milk/sugar onto the Order at submit time — would give each round's Menu a stable, historically-accurate record of what was actually asked for at the time, immune to later edits. That's a defensible property for some domains (an audit trail, an order history), but it isn't the one this feature is optimizing for: the Menu's job is to tell the brewer what to make *right now*, not to be a historical ledger. A live join is also simpler — no extra columns, no snapshot-vs-source drift to reason about, no migration needed if Usual ever grows a new field.

## Considered

- **Snapshot milk/sugar onto the Order at submit time** — rejected: optimizes for historical accuracy over current usefulness, and the domain has no stated need for "what did I ask for that day" as distinct from "what do I usually ask for."
- **Snapshot, with a manual "resync to my current Usual" action** — rejected: reintroduces the same staleness problem by default, just with an escape hatch; adds UI and an RPC for a case the live join handles automatically.
