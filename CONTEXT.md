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

**Brew Rating**:
A 1–5 star score a round's non-brewer participants may give the brewer's tea/coffee (`brew_ratings`, one row per rater per round, upserted on re-rating rather than versioned). Submitted and edited via `submit_brew_rating`, withdrawn via `withdraw_brew_rating` — both derive the rater server-side and are gated by the Rating Window. Only ever visible to the brewer as an aggregate average (`stats_brew_rating_all_time`/`_last_30_days`); individual scores are never exposed to the brewer, by RLS, not just by convention.
_Avoid_: review, feedback, score (ambiguous with roll/spell scoring).

**Rating Window**:
The period a round's Brew Rating stays submittable or editable: open from the round's resolution until the room's *next* round resolves, then permanently closed — no fixed timer, unlike Modifier Adjustment's 5-minute undo limit. Enforced server-side in `submit_brew_rating`/`withdraw_brew_rating` by checking the target round is still the room's most-recently-resolved one.
_Avoid_: rating deadline, grace period.

**Usual**:
A player's saved default for how they take tea and how they take coffee — one row per `(player_id, drink_type)` in `usual_drinks`, holding a `milk` (Dairy/Oat/Soy/None) and `sugar` (None/Sprinkle/Half Tsp/1 Tsp/1.5 Tsp/2 Tsp/3 Tsp) pick. Global, not room-scoped; written directly by the owning player under RLS, no RPC involved, matching Player Setting's shape. Tea and coffee are independent rows — a player can have one, both, or neither set.
_Avoid_: preference, default order, profile.

**Order**:
A round participant's pick of tea or coffee for a specific round — one row per `(round_id, player_id)` in `orders`, upserted on re-pick via `submit_order`, which derives the acting player server-side and is gated by the Order Window. Decoupled from declaring in (ADR 0004): a player can Order before, after, or without declaring, and can change their Order any time the window is open. Its milk/sugar are never stored on the Order itself — the Menu reads them live from the player's current Usual (ADR 0003).
_Avoid_: selection, drink choice, declaration (that's declare-in).

**Order Window**:
The period a round's Order stays submittable or changeable: open from the round reaching `open` status all the way through `resolved`, then closes once the room's *next* round resolves — same closing rule as the Rating Window, but opening much earlier. Enforced server-side in `submit_order`.
_Avoid_: ordering deadline, grace period.

**Menu**:
The live, per-round list of who's ordered what (`round_menu`), joining `round_participants` × `orders` × `usual_drinks` × `players`: every participant who has an Order, their drink type, and their current Usual's milk/sugar — or an explicit "no preference set" marker when they've never set a Usual for that drink. A participant with no Order simply doesn't appear; there's no "no drink" row. Stays accurate after the round resolves, since it's always a live join (ADR 0003), never a snapshot.
_Avoid_: drinks list, order summary, roster (that's the round's participant list).
