# Roll for Brew

A daily-room dice game where players declare in, roll, and resolve ties to pick who brews.

## Language

**Admin**:
A player flagged administrator-capable in the database (`players.is_admin`, granted only via migration — no in-app grant path). Being an Admin is necessary but not sufficient to reach the Test Room; Admin Mode must also be enabled.
_Avoid_: superuser, staff.

**Admin Mode**:
A per-browser toggle (cookie-backed, set from Settings) that, for a flagged Admin, reveals the Admin entry point on the username badge and allows the Test Room route to render. Disabling it hard-gates the route itself, not just the link. Toggling it never writes to the database.
_Avoid_: dev mode, admin flag (that's `is_admin`).

**Test Room**:
A single persistent room (`rooms.is_test`), excluded from daily room assignment (`enter_todays_room`) and from every `stats_*` leaderboard view. Its `date` is null — a Test Room isn't day-scoped the way a real room is. Used to puppet-test multiplayer flows without touching real game data.
_Avoid_: sandbox, staging room.

**Test Player**:
One of a fixed, persistent seeded roster of players (`players.is_test`) that only ever appears in the Test Room. Never logged into directly — only ever puppeted by an Admin who is Acting As them.
_Avoid_: fake player, bot, dummy account.

**Acting As**:
The player identity an Admin is currently puppeting. Held server-side as a per-admin pointer, not a client-supplied value. `current_player_id()` — the single chokepoint every mutating RPC already calls for caller identity — only honors the pointer when the round/room being acted on is the Test Room; for any real room it silently resolves to the Admin's true identity regardless of the pointer.
_Avoid_: impersonating, switched user, puppet target.

**End Test Session**:
The Admin action that cascade-deletes the Test Room's rounds, rolls, spell casts, and active effects, zeroes every Test Player's accumulated `room_players.modifier`, and resets the caller's Acting As pointer back to themselves. Leaves the Test Room and its Test Players intact for reuse, with the roster looking like a freshly-seeded room.
_Avoid_: purge, reset, wipe.

**Modifier Adjustment**:
A one-off, signed, reasoned change any player can log against any player's `room_players.modifier` for today's room (`modifier_adjustments`, append-only — rows are only ever inserted or deleted on undo, never updated). Logged from Settings via `log_modifier_adjustment`, which derives the actor server-side and applies the delta immediately; the actor can undo only their own most-recently-logged adjustment, and only within 5 minutes of logging it, via `delete_modifier_adjustment`.
_Avoid_: modifier override, manual roll, correction (that conflates it with a spell effect).
