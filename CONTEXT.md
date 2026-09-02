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

**Spell Card Rating**:
A 1–5 star score a player privately gives a catalog spell card (`spell_card_ratings`, one row per `(card_id, rater_player_id)`, upserted on re-rating, hard-deleted on withdrawal). Set from the card inspector in the rater's own Spell Collection via `rate_spell_card` / `withdraw_spell_card_rating`, both deriving the rater server-side. A card is rateable only when the rater has at least one non-negated cast of it in a resolved round of a non-test room; the rating row persists even if that eligibility later disappears (e.g. admin round deletion), and the inspector then shows the stars read-only. Unlike Brew Rating there is no in-app aggregate at all — no average, count, badge, or other-player view; RLS exposes a row only to its own rater. "Which spells are liked/disliked" is analysed straight off the table.
_Avoid_: spell review, spell feedback, spell score (ambiguous with roll/spell effect scoring).

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
A room-scoped readout (`get_modifier_breakdown`) splitting a player's live modifier into its three durable sources — cups made as brewer, logged Modifier Adjustments, and the Spell Modifier Delta (`spell_effects`). Since #311 made `room_players.modifier` a log-derived cache (`base + spell_delta`), the three sums reconcile to it for every player a persistent modifier transfer/spend has touched. Readable by any authenticated player, not just the subject.
_Avoid_: modifier history, modifier audit (implies a per-event ledger it doesn't keep).

**Spell Modifier Delta**:
The rest-of-day spell half of a player's `room_players.modifier` (issue #311, spec §9): the per-player sum of every non-negated `persistent_modifier_transfer` / `persistent_modifier_spend` Cast Log delta in the room, re-derived by `resolve_round` each run (`_rr_spell_modifier_delta`) and surfaced as the Modifier Breakdown's `spell_effects` column. Round-scoped modifier effects (Bes-Tea, Tea Leaf, Spillage) are **not** in it — they revert at round end via `composeModifier`.
_Avoid_: spell modifier (ambiguous with a round-scoped effect), modifier bonus.

**Pending Spell Draw**:
A player's earned-but-undrawn card slot after rolling a natural 1 or 20 (`pending_spell_draws`, one row per `(round_id, player_id)`). Recorded immediately at roll time via `record_pending_spell_draw`, regardless of round status — resolved later, in-app or against the physical deck, via `draw_pending_spell_card`/`draw_pending_spell_card_manual`. Never expires and is never voided by a later round resolving; a player who doesn't act can accumulate more than one across different rounds.
_Avoid_: pending draw (ambiguous with a keep-or-swap decision), spell trigger.

**Spell Draw Window**:
The gate on when a Pending Spell Draw's choice prompt (`SpellDrawChoicePanel`) is shown to the player who earned it: never before the earning round reaches `resolved` or `cancelled` (issue #248) — unlike the Rating/Order Windows, this window only ever opens, it never closes. Gates the prompt's *render* only; `record_pending_spell_draw` itself is ungated and always fires the instant the crit lands. Since `getActiveRound` never returns a `resolved` round, the prompt can't hang off `activeRound` — it's driven by its own query for the caller's oldest outstanding Pending Spell Draw, mirroring how `getMyRateableRound` looks up a resolved round independently of `activeRound`. When more than one Pending Spell Draw is outstanding, shown oldest-first, one at a time, with a count of others waiting.
_Avoid_: draw window (ambiguous with drawing from the deck itself), draw gate, resolution gate.

**Pending Spell Die**:
A `dice_modifier` spell effect (Six Sugars' 1d6, Cold Tea's and Slipped Spoon's 1d4) cast but not yet given its value — `spell_casts.effect_kind = 'dice_modifier'` with no `cast_inputs.dice_roll` key yet (issue #252; the sentinel was `resolved_value IS NULL` until that column was dropped in issue #312). Replaces the old behavior of resolving the die with a synchronous, player-invisible `random()` call at cast time: the card is still consumed and the cast row still created immediately, but the affected player now supplies the value afterward via `resolve_pending_spell_die_in_app`/`_manual`, offered the same in-app/manual/both choice their Roll Input Mode already gives the main d20 roll. A round's Layer 0 can't be treated as complete (`get_current_layer_rolls_if_complete`) while one is outstanding — resolving with the effect silently worth 0 would be wrong, not just incomplete. No new timeout guards this: a pre-roll cast (Cold Tea/Slipped Spoon) still outstanding once the existing 5-minute closed-round stall timer fires is auto-resolved by `resolve_stalled_pending_spell_dice`, the same timer's own new branch, not a separate clock; a Reaction-cast one (Six Sugars) rides the reaction window's own existing recovery instead.
_Avoid_: pending roll (ambiguous with the main d20 roll itself), dice roll gate.

**Late Declare**:
Declaring in for a round after it has already closed (issue #246) — narrower than ordinary Declaring In, which only works while a round is still `open`. Allowed only in the gap between `close_round` and the round's first submitted roll: once any roll exists for the round, the window is gone. A separate RPC (`declare_in_late`) from `declare_in`, not a relaxed check on it — same one-RPC-one-purpose split as `declare_in`/`withdraw_declaration`. Surfaced on the initial page as an "Add me in!" button, reusing the ordinary declare-in button's placement and behavior, shown only while the caller is eligible. Broadcasts the existing `player-declared-in` event so both the open-round roster and (newly) `RoundReveal` pick it up, and the existing `spell-cast-changed` event so any OPPONENT/PLAYER Action card still holding a deferred (`null`) target re-renders with the new player as a choosable target; a cast whose target is already set is not reopened.
_Avoid_: late join (collides with entering the Room itself, `enter_todays_room`), late add, retroactive declare.

**Proxy Roll**:
An admin-only action (`admin_proxy_roll`) that folds a player who's physically present at the table but hasn't opened the app that day into a genuinely live round, entering the value they read out loud on their behalf (issue #273). Distinct from Late Declare — that requires the player to already have a `room_players` row; this implicitly creates one, no prior login required. Eligible in the same window as Late Declare (round `open`, or `closed` with no rolls yet), extending the Test-Room-only `submit_roll_as`/`submit_manual_roll_as` (migration 0029) pattern to real rooms. The player becomes a full participant — normal modifier math, spell casting, a genuine reaction window — and the roll itself is flagged `rolls.entered_by_admin` so round history shows it as admin-entered without casting doubt on the value. No safeguard against duplicate entry, same as other admin tools (`admin_delete_round`).
_Avoid_: manual roll (ambiguous with a player's own manually-entered value), roll for others (that's the underlying Test Room mechanic this extends), backfill (that's Round Backfill, #274 — a whole round nobody logged into the app for).

**Round Backfill**:
An admin-gated, same-day-only bulk action (`admin_backfill_round`) that records an entire round nobody ever opened the app for — every participant's roll, and any tie-break reroll layer in full, entered up front in one transaction rather than replayed live. Distinct from Proxy Roll (`admin_proxy_roll`), which folds one absent-but-present player into an already-live round; here there's no live round at all. Spell casting is out of scope: only the roll-off/tie-break mechanics are replayed, reusing `advance_round_layer`/`resolve_round` unchanged so the result is indistinguishable from a live round's final shape. Implicitly creates each participant's `room_players` row for today, same as Proxy Roll. Shares Proxy Roll's per-roll `rolls.entered_by_admin` provenance flag, plus its own round-level `rounds.backfilled_by`/`backfilled_at`, surfaced on `/stats` as `stats_room_rounds.backfilled`.
_Avoid_: proxy roll (that's the single-player, live-round mechanic), retroactive round, manual round entry.

**Effect Kind**:
The classification of a single spell effect — one of the authoritative values on `spell_card_effects.effect_kind` (e.g. `flat_modifier`, `advantage`, `forced_reroll`, `roll_swap`, `tea_maker_override`, `contested_negate`). A catalog card maps to zero or more effects, each with its own kind, target role, params, and ordinal; the kind is what decides how the resolver applies it.
_Avoid_: effect type, spell type, effect_params (that's the per-effect config, not the classification).

**Cast Log**:
The append-only record of every spell cast in a round — `spell_casts` (one row per effect of a cast) plus the `spell_active_effects` it promotes. Under ADR 0005 (rebuild in progress) it is the authoritative input to round resolution: a round's outcome is a pure, deterministic function of its rolls, its Cast Log, and active effects, with nothing applied by side-effect that can't be reconstructed from the log.
_Avoid_: cast history, spell audit, effect log.

**Resolution Trace**:
The ordered, structured record a rebuilt `resolve_round` emits (ADR 0005) — one step per applied effect, carrying its kind, source cast, target, and before/after values. The game resolves the round from it, and the player-clarity surface renders it directly; there is no second explanation path.
_Avoid_: roll calculation (that's the current per-player display), effect breakdown, resolution log.

**Round Recap** (a.k.a. **the Ledger**):
The player-clarity surface over the Resolution Trace (#314) — the primary content of `RoundReveal` whenever a round has ≥ 1 cast. A tap-to-filter **cast strip** (one chip per cast, state `armed → on-stack → resolved{applied/negated/redirected/blocked/backfired/no-op}`) above a flat, **Recap-phase**-grouped list of step rows in resolution order. A round with no casts shows no Recap at all. Rendered from one pure function; room history re-renders past rounds with the same one.
_Avoid_: round summary, effect breakdown, roll calculation (the per-tile display, which stays).

**Recap phase**:
The band a Recap step falls in — `Before the roll`, `Reaction window`, or `Outcome` — derived from the source cast's window, not from Layer. Headers follow resolution order and repeat whenever the phase changes, so `Reaction window` can appear twice in one Recap. Distinct from **Layer** (tie-break reroll depth) and from a cast's own pre-roll/reaction timing.
_Avoid_: phase (bare — always qualify as "Recap phase"), stage, band, layer.

**Round replay** / **generation** / **scrapped attempt**:
Time for Brew (`effect_kind = 'round_replay'`, spec #302 §11, ADR 0005) scraps a just-resolved round and replays it as a fresh round from Layer 0 — not a recompute. `rounds.replay_generation` counts the passes: generation 0 is the original attempt, generation 1 the replay. `_rr_scrap_round` snapshots each scrapped generation's Recap payload (its Resolution Trace, brewer, rolls, tie-break layers) into `rounds.scrapped_generations` before deleting its rows. The **canonical view is generation 1**, headlined normally; each **scrapped attempt** hangs above it in a collapsed disclosure holding that generation's own Round Recap and its own nested reroll rows, kept separate from generation 1's Layers. The scrap is a labelled boundary between two Recaps, not a Trace step.
_Avoid_: pass (say "generation"), redo/rerun, do-over, replay layer (Layer is tie-break depth, not a generation).

**Effect Invocation**:
The three cards whose whole point is running *another* card's effect (spec #302 §10, ADR 0005): **Saucerer's Apprentice** copies a cast already on the reaction stack (the copy re-rolls its own RNG and resolves on the Apprentice caster; the original still resolves on its own target), **Genie in the Teapot** names a non-Epic Action card whose sole edition instance is `in_deck` and resolves its effect as if played (the named instance is never moved — ethereal), **Brew-merang** seizes another player's cast so it resolves on its own caster. The invoking `spell_casts` row carries only a pointer in `cast_inputs` (`copied_cast_id` / `invoked_card` / `seized_cast_id`); `resolve_round` derives the extra effect. Invocation is whole-cast — every effect row of the source or none — and invocation cards cannot invoke each other.
_Avoid_: effect copy (that's just Saucerer's), spell steal, replay (that's Round replay).

**Seize** (Brew-merang):
A resolver-derived outcome on a *seized* cast — its effects retargeted to its own caster, every original target dropped (a multi-target cast collapses to just the caster). Derived inside the same recursive, memoised negate fixpoint as `negated` (#308): countering the Brew-merang undoes the seize; Brew-merangs seize Brew-merangs to any depth. Recorded as `spell_casts.seized_by_cast_id` on the seized cast, written by `resolve_round` only. A `block_copy` ward (Bag for Life) on the seized cast's caster blocks the seize — the Brew-merang is still spent, outcome `blocked`.
_Avoid_: redirect (that's the reactor's own exposure onto the original caster), steal, negate.
