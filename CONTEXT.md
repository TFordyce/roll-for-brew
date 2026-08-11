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
A player's saved default for how they take tea and how they take coffee — one row per `(player_id, drink_type)` in `usual_drinks`, holding a `milk` (Dairy/Oat/Soy/None), `sugar` (None/Sprinkle/Half Tsp/1 Tsp/1.5 Tsp/2 Tsp/3 Tsp), and `decaf` (boolean, default false) pick. Global, not room-scoped; written directly by the owning player under RLS, no RPC involved, matching Player Setting's shape. Tea and coffee are independent rows — a player can have one, both, or neither set, and each can be decaf independently of the other.
_Avoid_: preference, default order, profile.

**Order**:
A round participant's pick of tea or coffee for a specific round — one row per `(round_id, player_id)` in `orders`, upserted on re-pick via `submit_order`, which derives the acting player server-side and is gated by the Order Window. Decoupled from declaring in (ADR 0004): a player can Order before, after, or without declaring, and can change their Order any time the window is open. Its milk/sugar/decaf are never stored on the Order itself — the Menu reads them live from the player's current Usual (ADR 0003).
_Avoid_: selection, drink choice, declaration (that's declare-in).

**Order Window**:
The period a round's Order stays submittable or changeable: open from the round reaching `open` status all the way through `resolved`, then closes once the room's *next* round resolves — same closing rule as the Rating Window, but opening much earlier. Enforced server-side in `submit_order`.
_Avoid_: ordering deadline, grace period.

**Menu**:
The live, per-round list of who's ordered what: every participant who has an Order, their drink type, and their current Usual's milk/sugar/decaf — or an explicit "no preference set" marker when they've never set a Usual for that drink. A participant with no Order simply doesn't appear; there's no "no drink" row. Stays accurate after the round resolves, since it's always a live join (ADR 0003), never a snapshot. The `round_menu` DB view itself only joins `round_participants` × `orders` × `usual_drinks`; display names are joined in separately on the client against `round_participants`.
_Avoid_: drinks list, order summary, roster (that's the round's participant list).

**Layer**:
A round's roll attempt number, starting at 0 (`rounds.current_layer`, `rolls.layer`): layer 0 is the original roll, layer 1+ is a Tie-Break Reroll. Advantage/disadvantage spell effects are scoped to layer 0 only.
_Avoid_: round (a round can span several layers), attempt, phase.

**Tie-Break Reroll**:
A reroll forced when two or more players tie at the current Layer; it always draws a single unmodified d20 — spells and reactions are exempt at any layer above 0.
_Avoid_: tie-break (ambiguous between the event and the whole resolution phase), reroll (too generic — doesn't imply the spell/reaction exemption).

**Reroll Chain**:
A player's ordered sequence of rolls across a round's Layers, from the original layer-0 roll through every Tie-Break Reroll that followed it. Rendered in `RoundReveal` as a nested, indented row per layer.
_Avoid_: reroll history, layer history (that's the raw `get_round_layer_history` data this is built from).

**Modifier Jitter**:
A purely visual cue on `RollCalculation`'s modifier term: a shake animation that fades in once a player's live `room_players.modifier` crosses +8, intensifying to full at +14. No DB backing — display-only. Thresholds are provisional, pending player feedback.
_Avoid_: danger cue, warning animation.

**Admin Round Deletion**:
An admin-gated, reason-required hard delete of a round (`admin_delete_round`) that also reverts the round's `brewer_modifier_gain` from the brewer's modifier before deleting. Logs to its own append-only, service-role-only audit table (`admin_round_deletions`) with no in-app viewer.
_Avoid_: undo, purge, admin undo.

**Admin Adjustment Deletion**:
An admin-gated, reason-required hard delete of a Modifier Adjustment (`admin_delete_modifier_adjustment`) that bypasses Modifier Adjustment's own actor-only/5-minute-undo limits — any admin can delete any adjustment, regardless of who logged it or when. Logs to its own append-only, service-role-only audit table (`admin_modifier_adjustment_deletions`) with no in-app viewer, distinct from the player-facing `modifier_adjustments` log itself.
_Avoid_: undo (that's the player's own `delete_modifier_adjustment`), purge, admin undo.

**Modifier Breakdown**:
A room-scoped readout (`get_modifier_breakdown`) splitting a player's live modifier into its two known, durable sources — cups made as brewer, and logged Modifier Adjustments — without reconciling against `room_players.modifier` or accounting for spell-effect deltas, which have no durable per-source ledger. Readable by any authenticated player, not just the subject.
_Avoid_: modifier history, modifier audit (implies completeness it doesn't have).

**Pending Spell Draw**:
A player's earned-but-undrawn card slot after rolling a natural 1 or 20 (`pending_spell_draws`, one row per `(round_id, player_id)`). Recorded immediately at roll time via `record_pending_spell_draw`, regardless of round status — resolved later, in-app or against the physical deck, via `draw_pending_spell_card`/`draw_pending_spell_card_manual`. Never expires and is never voided by a later round resolving; a player who doesn't act can accumulate more than one across different rounds.
_Avoid_: pending draw (ambiguous with a keep-or-swap decision), spell trigger.

**Spell Draw Window**:
The gate on when a Pending Spell Draw's choice prompt (`SpellDrawChoicePanel`) is shown to the player who earned it: never before the earning round reaches `resolved` or `cancelled` (issue #248) — unlike the Rating/Order Windows, this window only ever opens, it never closes. Gates the prompt's *render* only; `record_pending_spell_draw` itself is ungated and always fires the instant the crit lands. Since `getActiveRound` never returns a `resolved` round, the prompt can't hang off `activeRound` — it's driven by its own query for the caller's oldest outstanding Pending Spell Draw, mirroring how `getMyRateableRound` looks up a resolved round independently of `activeRound`. When more than one Pending Spell Draw is outstanding, shown oldest-first, one at a time, with a count of others waiting.
_Avoid_: draw window (ambiguous with drawing from the deck itself), draw gate, resolution gate.

**Pending Spell Die**:
A `dice_modifier` spell effect (Six Sugars' 1d6, Cold Tea's and Slipped Spoon's 1d4) cast but not yet given its value — `spell_casts.effect_kind = 'dice_modifier'` with `resolved_value` still null (issue #252). Replaces the old behavior of resolving the die with a synchronous, player-invisible `random()` call at cast time: the card is still consumed and the cast row still created immediately, but the affected player now supplies the value afterward via `resolve_pending_spell_die_in_app`/`_manual`, offered the same in-app/manual/both choice their Roll Input Mode already gives the main d20 roll. A round's Layer 0 can't be treated as complete (`get_current_layer_rolls_if_complete`) while one is outstanding — resolving with the effect silently worth 0 would be wrong, not just incomplete — so it blocks that round's own resolution with no expiry and no separate timeout, the same "waits with no deadline" posture as a Pending Spell Draw.
_Avoid_: pending roll (ambiguous with the main d20 roll itself), dice roll gate.

**Late Declare**:
Declaring in for a round after it has already closed (issue #246) — narrower than ordinary Declaring In, which only works while a round is still `open`. Allowed only in the gap between `close_round` and the round's first submitted roll: once any roll exists for the round, the window is gone. A separate RPC (`declare_in_late`) from `declare_in`, not a relaxed check on it — same one-RPC-one-purpose split as `declare_in`/`withdraw_declaration`. Surfaced on the initial page as an "Add me in!" button, reusing the ordinary declare-in button's placement and behavior, shown only while the caller is eligible. Broadcasts the existing `player-declared-in` event so both the open-round roster and (newly) `RoundReveal` pick it up, and the existing `spell-cast-changed` event so any OPPONENT/PLAYER Action card still holding a deferred (`null`) target re-renders with the new player as a choosable target; a cast whose target is already set is not reopened.
_Avoid_: late join (collides with entering the Room itself, `enter_todays_room`), late add, retroactive declare.
