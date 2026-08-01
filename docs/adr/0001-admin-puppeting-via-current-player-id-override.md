# Admin puppeting via a `current_player_id()` override, scoped to the Test Room

Every mutating RPC (`declare_in`, `submit_roll`, `start_round`, spell casts, reactions — 45 call sites across 13 migrations) derives the acting player from `public.current_player_id()`, never from a client-supplied parameter, specifically so identity "can't be spoofed" (see comment at `0004_round_lifecycle.sql:59-63`). Rather than add an admin-override parameter to every one of those RPCs, we teach `current_player_id()` itself a second branch: if the real caller (via `auth.uid()`) is flagged `players.is_admin` and has a server-side Acting As pointer set, AND the round/room the RPC call is operating on is flagged `rooms.is_test`, it returns the pointed-at player id instead of the caller's own. For any non-test room, the override is ignored outright regardless of the pointer or the caller's admin status.

This makes every existing and future RPC puppet-capable for free, without touching their signatures — but it does mean the identity chokepoint the whole authorization model leans on now has an admin branch, which a future reader needs this note to understand. The room-scoping is a deliberate safety property, not an implementation detail: it makes "puppet mode leaks into a real game" structurally impossible rather than merely discouraged by a UI toggle.

## Considered

- **Explicit `p_acting_as` parameter on every RPC** — rejected: touches ~20 SQL function signatures and every TS server-action wrapper, and undermines the entire reason `current_player_id()` exists as a single chokepoint.
- **Client-supplied header/claim for "acting as"** — rejected: `current_player_id()` is `security definer`; trusting client input here would reopen the exact spoofing hole the original design closed.
- **Global toggle (override applies to any room, not just Test Room)** — rejected: relies on the admin remembering to toggle off; see [0002](./0002-test-room-modeled-as-a-dateless-room.md) for how the Test Room itself is isolated, and Q11 of the design discussion for why global scoping was rejected.
