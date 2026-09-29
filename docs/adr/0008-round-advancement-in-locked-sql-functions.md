# Round advancement runs in locked SQL functions; TS only routes events and broadcasts

## Status

accepted — 2026-09-29. Decided in an /improve-codebase-architecture review (candidate #2) and the grilling that followed it.

## Decision

Moving a round forward once a Layer's rolls are in used to be coordinated from TypeScript. There were three functions (`resolveCompletedLayerIfAny`, `finalizeReactionWindow`, `applyLayerOutcome`) and about ten call sites, and each call site picked which one to run next. Every step was a separate RPC. The rules "never finalize while the reaction window is open" and "never open a second window" lived only in the callers. The code for "the window closed, so finalize" was written five times, each copy reading a different "closed" signal. Stall recovery went round the whole thing and called `applyLayerOutcome` directly.

Advancement now has one entry point on each side:

- **Two SQL functions own the rules and the atomicity** (canonical source in `db/sql/functions/`, ADR 0006):
  - `advance_layer(round_id)` locks the round. At Layer 0 it opens the reaction window (at most one per round), and if nobody is eligible to react it finalizes straight away. At a Layer above 0 it finalizes directly.
  - `finalize_layer(round_id)` performs **Layer finalization** in one transaction:
    1. Lock the round.
    2. Do nothing while a window is open or the Layer is incomplete.
    3. Run the eager roll-input shim (forced reroll, flip, swap, chosen-pair; ADR 0005).
    4. Call `resolve_round`, which is unchanged and still pure.
    5. Commit the outcome: burn the declared number, then either write the resolution and record any pending round replay, or advance to the Tie-Break Reroll Layer.

  Both functions return an outcome (`brewer` / `tie` / `windowOpened` / `noop` with a reason). Neither raises because the caller lost a race or isn't a roller: whether a round can advance does not depend on who asks.
- **One TS module, `advanceRound(supabase, roundId, event)`, routes events.** Its events are `layerRolled`, `pendingDieResolved`, `deferredTargetSet`, `reactionWindowChanged` and `stallCleared`. The event only names what triggered the call and decides which SQL function may run: `reactionWindowChanged` may only finalize, and every other event goes through `advance_layer`. The event carries no claims about state; the locked read in SQL decides whether anything happens. The module sends every broadcast that advancing caused (layer rolls revealed, round revealed, layer tied, round replay changed). The caller still broadcasts its own write and revalidates.
- **Stall only clears the blockage** (exclude a player, auto-resolve a die, abandon a deferred target, close a stranded window), then raises `stallCleared` like any other caller.

## Considered

- **Keep coordinating from TS behind one deeper TS module.** Rejected: the steps would still be separate RPCs. Two finalizes racing could both run the eager shim, and the round could be left half-committed between `resolve_round` and its commit writes. The "window still open" check would be a read that can go stale before the finalize runs.
- **A state-driven TS interface, `advanceRound(roundId)` with no event.** Rejected in favour of events: an event records the caller's intent and lets the module refuse steps that event should never cause. For example, a pass can never open a window. The SQL still re-reads state before every step.
- **Fold commit and window-opening into `resolve_round` itself.** Rejected: `resolve_round` stays a pure, idempotent function of its inputs (ADR 0005), and the Provisional Recap depends on that. The new functions wrap it and don't change it.

## Consequences

- `get_current_layer_rolls_if_complete` and `get_completed_layer_rolls_for_stall_resolution`, along with their identity gates and TS wrappers, are replaced by the locked read inside `advance_layer` / `finalize_layer`. RFB02 stays on the *write* RPCs only.
- These behaviours change, and each one fixes a bug:
  - a stranded window recovered on a spectator's page render no longer throws RFB02, so the round is no longer stuck;
  - a pending die resolved while the window is still open no longer finalizes early;
  - two concurrent finalizes produce exactly one resolution;
  - a die or deferred target cleared by stall now gets its reaction window and roll transforms.
- The three per-function deps types collapse to one fake-able seam. TS unit tests check which SQL function each event calls and which broadcast each outcome sends. Advancement behaviour itself is covered by integration tests against the SQL functions.
- A Layer 0 reaction window can still be held open indefinitely by an eligible holder who never passes. That is a game-rules gap tracked on its own, not something this decision covers.
