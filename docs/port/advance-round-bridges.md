# Round advance bridges (slice 2a-5, #546)

The evaluator shadow: every live layer advancement also runs C# `Evaluate` beside SQL.
The C# API loads the snapshot, evaluates, pre-writes only the roll-bearing writes (the
synthesized casts), then calls the bridged SQL entry point **inside its own transaction**.
SQL stays authoritative: the caller gets SQL's outcome payload, in the same shape the RPC
returns today. Diffs between the candidate and what SQL wrote are logged at Error with the
marker `rfb-shadow-diff` (room id, round id, the raw snapshot, the normalized candidate and
SQL's jsonb — enough to reproduce as a golden) and never served; Cloud Run error reporting
is the alert. This file is the bridge list the ticket's exit 1 asks for. Keep it current:
**revoke the `rfb_api` EXECUTE grant (migration `0162`) as each function dies in slice 2b.**

## Flow (one API transaction per advance call)

1. Round-row `select … for update` (`RoomStore.Advance`, ADR 0012's minimal write path).
2. `RoundSnapshot` loaded in one batched round trip.
3. `Evaluate(snapshot, roundId, dice)` — the shadow candidate, never served.
4. Pre-write the roll-bearing writes from `Commit(Resolution)`: the synthesized
   `spell_casts` rows (Saucerer's Apprentice copies and Calami-Tea dice ticks), with `seq`
   left identity-assigned in Commit order. This is the spec's "existing tick rows mean only
   missing ticks roll": the bridged resolver's own idempotency guards (`dice_tick` /
   `is_copy` per generation) then make SQL replay C#'s rolls instead of rolling fresh.
   The pre-writes are bridge fuel, not state — their lifecycle is
   **insert → bridge call → delete by the exact ids inserted, unless the call finalized**
   (below), all inside this one transaction. A warded tick is never pre-written: its roll
   is never applied (it collapses to `<rng>`), so SQL needs no replay, and pre-writing it
   would suppress SQL's own synthesis — whose `warded` step the candidate's trace does
   carry — for a false diff.
5. Bridge call (below) — SQL commits authoritative state and returns its outcome payload.
   When the outcome finalizes nothing — any `noop`, or `windowOpened` with a null
   `finalization` (the window stays open) — the pre-written rows are deleted again, so
   nothing synthesized survives into an open window: a ward cast as a reaction still
   negates a tick, and the window-close call re-runs `Evaluate` on the post-window
   snapshot and pre-writes fresh, exactly where the SQL-only path synthesizes.
6. Read back what SQL wrote (`resolution_trace` / `resolution_summary` jsonb and the
   resolution columns) and diff against the candidate through the goldens' normalized-JSON
   comparison (`Domain.TraceNormaliser`, shared with the golden renderer). The diff covers
   every finalization: `brewer`/`tie` at the payload's top level, and `advance_layer`'s
   nested `finalization` block when the window opened and closed on the spot (nobody
   eligible to react, so no player could cast into it — the candidate evaluated the same
   state SQL resolves). A non-finalizing outcome has nothing to examine: no diff, no skip.
7. Return SQL's payload unchanged. Broadcasts stay TS-side, exactly as today.

## Write bridges (still SQL, EXECUTE granted to `rfb_api` by migration `0162`)

| Function | Called from | Notes |
|---|---|---|
| `advance_layer(round)` | `POST /rounds/{id}/advance` | opens the layer-0 reaction window or finalizes |
| `finalize_layer(round)` | `POST /rounds/{id}/finalize` | shim + resolve + commit, payload unchanged |

Nothing else is granted: their `security definer` internals (`resolve_round`, `_rr_*`,
`apply_forced_reroll`, …) run as the function owner. **SQL-deletion list: empty** — slice
2a deletes no SQL; slice 2b deletes the resolver subtree and revokes these grants.

## Flag

`port_flags` row `('advanceRound', enabled)` (global; a Test Room row overrides it),
seeded **disabled** by migration `0162`. The wrappers read it per request
(`src/lib/supabase/roundAdvancement.ts`); the API needs `NEXT_PUBLIC_API_URL` wherever the
flag is on. Flag flips are human steps (outside play hours):

```sql
-- Test Room first
insert into public.port_flags (slice, room_id, enabled)
  select 'advanceRound', id, true from public.rooms where is_test;
-- then global
insert into public.port_flags (slice, enabled) values ('advanceRound', true)
on conflict (slice, room_id) do update set enabled = true;
```

Rollback (instant, no deploy): `update public.port_flags set enabled = false where slice = 'advanceRound';`
(the API path and the RPC path commit through the same SQL, so flipping is safe
mid-round). Exit gate: 10 consecutive play-days with zero `rfb-shadow-diff` and green
goldens, tracked on #546.

## Die-coordination survey (resolver SQL `random()` sites, latest definitions)

Category **(a) — persisted, pre-written from C#** (no fresh roll can diverge):

* `_rr_resolve_eval` Phase 3-pre, the Calami-Tea `per_round_dice_tick` synthesis
  (latest: `0149`, ~line 1253): rolls `floor(random()*die+1)` and persists it in the
  inserted `spell_casts` row (`effect_params.rolled` + `cast_inputs.roll_transform.rolled`),
  idempotent per `(round, source_cast, generation)`. The shadow pre-writes exactly that row
  (C#'s deterministic `rfb-dice-tick:{source}:{gen}` id), so SQL's exists-check skips and
  re-reads C#'s roll. Seam 2 asserts the row count, the deterministic id and the scripted
  value.
* Copy synthesis (Phase 0a) draws no fresh RNG (copied verbatim from
  `cast_inputs.copy_inputs`), and is pre-written for the same reason: one seq order.

Category **(b) — rolled fresh by SQL with no C# counterpart** (diff normalization, never
silently ignored):

* `apply_forced_reroll`'s d20 (called from `finalize_layer`'s eager roll-input shim,
  together with the transform-recording for `roll_flip` / `roll_swap` /
  `roll_pair_transform`). The shim runs inside the bridge, **after** the candidate was
  evaluated; `Evaluate` only applies transforms already recorded on casts
  (`Phase3RollInputs` skips casts without `cast_inputs.roll_transform`), so the candidate
  cannot carry the shim's outcomes. The shadow therefore **skips the diff** and logs
  `rfb-shadow-skip` (reason `unapplied roll-transform casts`) whenever the snapshot holds
  any cast of those kinds without a recorded transform. The same guard covers
  `advance_layer`'s attach step (`attach_pre_roll_forced_reroll_casts` /
  `attach_pre_roll_roll_pair_transform_casts`), which stamps exactly those kinds with the
  new window's id right before the shim transforms them. When slice 2b ports the shim into
  the C# `AdvanceRound` (fresh rolls via `IDieRoller`), the skip and this paragraph go.

Category **(c) — outside the advance path** (cannot reach the bridges; no normalization
needed): cast-time rolls in `cast_spell_card` (WILD d6 branch, the `order by random()`
other-player pick, CHOSEN_PLAYERS dice totals; `0150`), reaction rolls in
`cast_reaction_spell_card` (table dice totals, the contested-negate d20; `0148`), the
player d20s in `submit_roll` / `submit_roll_as`, deck draws, `close_round`'s placeholder
fan-out, pending-die resolution, and the stall/report reads. These are slice 3–6 entry
points, not callees of `advance_layer` / `finalize_layer`.

## The nested finalization is comparable (SQL trace, #546)

`advance_layer`'s `windowOpened` + `window_closed: true` outcome opens the window, closes
it and finalizes in one call, so the diff runs against the nested `finalization` block. The
SQL trace that decided the candidate is comparable — nothing window-time can reach the
resolution:

* `open_reaction_window` inserts the window, attaches pre-roll
  `forced_reroll`/`roll_pair_transform` casts, counts eligible reaction holders and — at
  zero — closes immediately, all inside the one locked call. No player can cast into a
  window that never sits open.
* The attach step stamps only shim-guarded kinds, so whenever it mutates anything the
  `rfb-shadow-skip` guard above has already skipped the diff.
* `_forfeit_untargetable_compelled_reactions` cannot fire here: an outstanding compelled
  Reaction cast implies its holder still holds the Reaction-timed card, and any held
  Reaction-timed card keeps the window open — not the nested path.
* The window row itself is resolution-invisible: the only resolver read of
  `spell_reaction_windows` is the Broken-Biscuit `lowest_gains_highest_modifier` join on
  `casts.reaction_window_id` (the C# side gates the same way), and a brand-new window has
  no casts stamped with its id — only Reaction casts carry window ids.

## Deliberately out of the diff

* The payload's `rolls` array (post-shim final rolls) — the candidate has no counterpart.
* `replay_pending` — follows from a surviving `round_replay` cast, which the `Resolution`
  does not carry; any real disagreement behind it fires via negation or the trace.
* `rounds.brewer_source` is compared as the brewer-record source only
  (`'brew_iou'`/`'brew_debt'`); the resolver's `'default'` label is not persisted.
* A tie payload carries the layer SQL advanced to; the candidate the layer that tied
  (compared as `candidate.Layer + 1`).
* RNG-drawn trace values collapse to `<rng>` and ids to stable aliases — the same
  normalization the goldens use, so a clean shadow pass means the goldens' oracle agrees.
