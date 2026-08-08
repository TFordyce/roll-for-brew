# Order decoupled from declare-in

Declaring in (`round_participants`, via `declare_in`) and placing an Order (`orders`, via `submit_order`) are two separate actions with two separate RPCs, not one combined step. A player can declare in without ever placing an Order, place an Order before declaring in, or do either in any order — right up through the round resolving, since the Order Window stays open that long (see the `submit_order` RPC comment, `0062_usual_order_menu.sql`).

Folding Order selection into `declare_in` would force every declaration through an extra required (or awkwardly optional) parameter, and would mean a player who wants to change their drink mid-round has no clean single-purpose action to call — they'd be re-declaring just to change a drink choice, muddying what declare-in means (a roster commitment) with what Order means (a drink pick that can keep changing). Keeping them independent also matches user story 6 directly: players may want to decide their drink before or after declaring, or without declaring at all if they're not participating in the round themselves (not a real case here since only participants can order, but the *timing* independence is the point).

## Considered

- **Order as a required parameter on `declare_in`** — rejected: forces a drink decision at the moment of committing to the round, contradicting user story 6's "decide before or after declaring" and blocking the late-change story (user story 9) without a second RPC anyway.
- **Order as an optional parameter on `declare_in`, with a separate change RPC for later edits** — rejected: two ways to set the same thing (one bundled, one standalone) for no real benefit — the standalone RPC alone already covers every case.
