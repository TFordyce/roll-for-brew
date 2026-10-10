# Delivery audit — the #572 integration merge and follow-ups (10 Oct 2026)

PR #572 merged the code for fifteen tickets in one 23,512-line integration branch on 9 Oct at 20:06 UTC, bulk-closing them with `Closes #N`. The per-slice exit gates from the [spec](https://github.com/TFordyce/roll-for-brew/issues/533) could not run inside that shape, and the tracker's closed states diverged from what master actually contains. This note records what landed, what didn't, and which exit criteria have genuinely run, so the remaining gates — slice 1's stability window (#541) and the evaluator shadow (#546) — stand on checked ground.

## Timeline

| When (UTC) | What |
|---|---|
| 8 Oct 22:55 | #573 — admin allocation migration renumbered 0153 → 0156 (parallel-migration collision) |
| 9 Oct 20:06 | **#572** — 23,512 additions / 171 files: slices 0, 0a, 1a–1d (partial), 2a-1…2a-4 (partial), Filler #565–#568. Closed #534–#540, #542–#545, #565–#568 |
| 9 Oct 22:06 | #574 — `rfb_api` grant on the schema-gate table (slice 0a leftover) |
| 9 Oct 22:30 | #575 — room view endpoint re-landed ("the work PR #572 missed", #538) |
| 9 Oct 22:38 | #576 — TS client room store + `RoomScreen` behind the `room_view` flag (ticketed against #539, a review-fixes ticket; no dedicated ticket existed) |
| 9 Oct 22:53 | #577 — TS broadcast senders switch to `room-changed` (#540) |
| 9–10 Oct | #578–#580 — comment-stripping sweeps across ~460 files, including the new port code |
| 10 Oct | `room_view` flag flipped global (human DB step), starting slice 1's exit-3 window |

## What holds

- CI on master is green throughout: `dotnet build` + `dotnet test` (goldens included), TS typecheck/unit/`verify:migrations`, contract drift — and the gate the spec actually relies on at runtime survived the process mess: every slice is still switched per-request by a `port_flags` row, with the unflagged path untouched and a failed flag read falling back to the old page.
- Slice 1 (room view) is substantively built and tested at the seams the spec names — see the exit-1 checklist on #541.
- Writes still go through SQL; the C# API serves reads only. No cutover has happened that the open tickets (#541, #546 onward) don't still govern.

## Where the ledger diverged — corrections made 10 Oct

Four tickets closed by #572 whose content is stubbed or absent on master. Each is reopened with evidence; recovered work is preserved on branches.

| Ticket | State on master | Action |
|---|---|---|
| #543 (phases 3–4c) | All five sites are `PhasePendingException` stubs: `Phases34.cs:11,30`, `Phases4.cs:128,138,148` | **Reopened.** The implementation existed only as uncommitted worktree state; recovered to `port/543-phases-3-4c-wip` (based on the slice's original tip `c8acdf8`). Never ran against the phase 3 / 4a–4c goldens. |
| #544 (phase 05 tea-maker) | Partial: Brew Debt, Brewer Immunity / declared-number tiers, `tea_maker_override` / Loose Leaf tiers still stub (`Evaluator.cs:75`, `PhasesClose.cs:54–58`) | **Reopened**, scoped to the stubbed branches. |
| #545 (phases 5–6, wild, Commit) | Mostly landed: `Phase5TeaMaker` and `Phase6HeistsAndMarks` wired in `Evaluator.cs`; `card_heist` / `draw_redirect` trace steps still stub (`PhasesClose.cs:70`) | **Reopened**, scoped to the stub. All-72-goldens-green is not honestly met while a wild scenario can throw. |
| #568 (room entry + set Acting As) | Nothing: no endpoints on master; first paint still calls the SQL `enter_todays_room` RPC | **Reopened.** Acceptable slice-1 coexistence, but the Filler never landed. The branch tip deleted in the 10 Oct cleanup (`a390580`) was recovered to `port/568-room-entry-wip`; it never had a PR or CI run. |

#543's recovery matters beyond bookkeeping: it is the seed of the work #546's shadow gate and the 2b cutover need, and it blocks any wild-scenario golden that rolls dice ticks or persistent advantage.

## Slice 1 exit-1 audit — summary

Full checklist with file references is on #541. Verdict: **built**. Verified with tests: endpoint shape + `no-store`, one-trip snapshot load, store ordering rules (request sequence + version) and coalescing, six secrecy pins plus HTTP-level holder-only hands, flag gating and fallback, single channel listener with retired events pinned, writes still `.rpc` + `revalidatePath`. Known gaps, none blocking the window: no test pins the provider wiring (`enforceStall` triggers), the both-pages-one-endpoint invariant, the first-paint sequence, or the writes-stay-rpc invariant; holder-only Pending Spell Draw has no pinning test; `room-changed` carries no version from unported senders (deliberate and pinned); room entry is #568's remaining work.

## Rules going forward

1. **One PR per slice ticket.** The PR body carries the bridge list and SQL-deletion list (spec story 28) and closes the ticket via `fixes #N`. Bulk integration branches don't close tickets.
2. **Closure means content.** An issue closes when its content is on master and covered by the tests its acceptance criteria name. A closed issue found unlanded is reopened with evidence.
3. **No integration merges inside agent worktrees.** Work lands through PRs; worktrees are wiped at session end.
4. **Flag flips stay a recorded human step**: outside play hours, test room first, then global, recorded on the slice's ticket (exit 2 before exit 3).
5. **The recovery branches** (`port/543-phases-3-4c-wip`, `port/568-room-entry-wip`) are starting points, not deliverables: each needs porting onto current master, goldens green, and a normal PR before its ticket can close again.
