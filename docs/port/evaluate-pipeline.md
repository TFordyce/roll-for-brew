# Evaluate pipeline: guide for #543, #544, #545

`Evaluator.Evaluate(RoundSnapshot, IDieRoller) -> Resolution` is the C# port of SQL `_rr_resolve_eval` (ADR 0010).
Code: `api/src/RollForBrew.Domain/Resolver/`. Pure: no I/O, no clock, no globals. Rules are frozen: reproduce SQL
exactly, including its quirks; Trace/Summary jsonb are byte-for-byte frozen; goldens never change.

## Shape

- `Evaluator` picks the round, returns early for a tie layer (`CurrentLayer > 0`: empty Trace, null Summary), else
  runs `Pipeline`, an ordered list of `EvalPhase` over one `EvalContext`.
- `EvalContext` is the private working copy. The snapshot stays immutable. Everything SQL kept in plpgsql variables,
  temp tables or cache columns lives here: `Casts` (mutable `WorkingCast` copies of this round's casts; flags that SQL
  writes to `spell_casts` - negated, redirected_to_cast_id, seized_by, copied, target - are written here and read back
  by later phases), `Players/Rolls/Base/Composed/Snapshots/DiceReduced` (the parallel arrays), `Effects`, `RedirectMap`,
  `WardMap`, `SkipMap`, `ClrRows` (the `_rr_cast_log_resolution` result), `Trace`, `Summary`, outcome fields.
- A phase is `EvalPhase { Id; Run(ctx) }`. It reads `ctx`, mutates `ctx`, and appends steps with `ctx.Emit(...)`
  (the step index is always the Trace length, as SQL's `v_step_index`). New casts SQL would `insert` (Apprentice copies,
  Calami-Tea ticks, Bitter Leech ticks) go through `ctx.AddCast`; they get the next `seq` and, in `Resolution.Derived`,
  are handed to Commit as `SynthesizedCasts`. Ids of synthesised rows must be deterministic (see 0a).
- `Resolution.Derived` carries the cache writes for Commit (#545): changed cast flags, synthesised casts, and
  `RoomPlayerModifiers` (Phase 4b fills `ctx.RoomPlayerModifierWrites`).

## Phase order (pinned by `EvaluatePipelineTests.Phase_order_...`)

`load-rollers, roll-frozen, roll-exemption, 0a, 1, 1-ward-blocked-prepass, 1-brewmageddon-prepass, 0b, 2, 3-pre, 3, 4a,
4c, 4b-pre, 4b, summary, 5, 6`. This is SQL execution order, not the tickets' numbering: 0b and 2 come after 1; **4c runs
before 4b**; 4b-pre (tick synthesis + its ward pre-pass) runs before 4b (the projection that reads its rows);
the Summary is built after 4b and before Phase 5. (The notes' "4c -> 4b -> 4b-pre" is wrong: in the SQL file the
Bitter Leech loop precedes the projection.) Adding a phase means changing that test on purpose.

## Pending phases and goldens

Unported parts throw `PhasePendingException(phaseId, reason)` only when the snapshot exercises them (never for a
round that doesn't), so a default answer is never silently wrong. The golden harness (`GoldenEvaluateTests`) turns
that into a named, counted set: `tests/RollForBrew.Tests/PendingGoldens.cs`. Rules:

- a scenario not in the set must match its golden byte-for-byte (fixture -> Evaluate -> `GoldenWriter.Render` -> compare);
- a scenario in the set must NOT match (the test fails with "remove it from PendingGoldens" when it starts passing);
- finish your phase, run the suite, delete the lines that now pass, replace the phase's `PhasePendingException` guard
  with the real port. The set must end empty. Never run the TS runner with `-u` or edit a golden.

State after #542: 72 scenarios, 25 pass, 47 pending. Guards to replace:

| Guard (file) | Pending scenarios first stop here | Owner |
|---|---|---|
| `Phase3PreDiceTick` (Phases34.cs): Calami-Tea tick synthesis. Needs `ctx.Dice` (`floor(random()*die+1)` becomes `Dice.Roll(die)`), skip if a tick row already exists for (source cast, generation) | 2 | #543 |
| `Phase3RollInputs`: persistent advantage (Prophe-Tea) branch only; the roll_transform walk, dice_tick, warded, negated and backfire re-application are ported | 0 | #543 |
| `Phase4cLowestGainsHighest` (Phases4.cs) | 2 | #543 |
| `Phase4bPreBitterLeech` | 1 | #543 |
| `Phase4bPersistentModifiers` (+ `_rr_base_modifier` / `_rr_spell_modifier_delta`, writes `ctx.RoomPlayerModifierWrites`) | 4 (incl. wild-2, -3, -5) | #543 / #545 |
| `Phase5TeaMaker` (PhasesClose.cs): only tier 4 default pick + Eternal Steep ward are ported; the guard fires for Brew Debt, Brewer Immunity, declared number, tea_maker_override, named_tea_maker_rolloff | 31 | #544 |
| `Phase6HeistsAndMarks`: card_heist and draw_redirect steps | 7 | #545 |

`Phase4a` (modifiers, ward filter, backfire re-bucketing, targeting_skip map), the Summary, `0a/0b/1/2`, the pre-passes,
roll_frozen and roll_exemption are complete. `Phase4a` was needed by the Phase 0-2 goldens, so it landed here.

## Things to know

- **Trace shape**: `TraceStep` has typed fixed keys plus `Extras` (the kind-specific top-level keys; extras win on
  collision, as `_rr_trace_step(...) || p_extra`). `outcome` defaults to no-op/applied from before == after.
  Serialise only through `TraceJson` (`ToNode` then `Pretty`/`ToJsonString`): keys are written in **jsonb order (shorter
  key first, then bytewise)**, numbers have no trailing zeros, `<`, `>`, `&` and non-ASCII are not escaped. Do not use
  default System.Text.Json for Trace/Summary.
- **Golden writer** (`tests/.../Harness/GoldenSupport.cs`) ports the TS `normaliseTrace`: player ids -> `P:label`,
  cast/effect ids -> `cast#N` / `fx#N` by first appearance (source_cast.cast_id, active_effect_id, ward_cast_id,
  blocked_cast_id, redirected_to_cast_id, in step order), other uuids `uuid#N`, `rolled` (and `would_be_after` on a
  Calami-Tea step) -> `"<rng>"`. Fixture ids need not equal golden tokens.
- **Ordering**: players are ordered by id *ordinally* (SQL `order by player_id`); uuid ordering (e.g. 1's negated-group
  steps `order by card_instance_id`) is the canonical-text ordinal (`Jb.UuidOrder`), not `Guid.CompareTo`.
- **jsonb reads**: use the `Jb` helpers (`Has` = `?`, `Text` = `->>`, `Flag` = `coalesce(...::boolean,false)`); a JSON null
  and a missing key both read as null but only the latter fails `Has`.
- **Snapshot gaps**: `RoundSnapshot` has no `spell_reaction_windows`. Two SQL checks ask about windows: roll-exemption
  ("a closed layer-0 window exists") is treated as closed (true at finalize), and Phase 4c's "cast is in a layer-0
  window" is approximated by `ReactionWindowId != null`. Fine for the corpus; #538/slice 2b (preview before the window
  closes) must add windows to the snapshot and fix both. `_brew_debt_due` is not ported (#544); until then a Brew Debt
  round throws pending from the all-rolled check.
- **Dice**: `IDieRoller` (`Dice/IDieRoller.cs`): `RandomDieRoller` (prod), `ScriptedDieRoller` (tests: replays a script,
  records `Requests`), `NoDiceRoller` (throws on any roll). The golden harness uses a constant roller. A dry-run flag
  does not exist: Preview is `Evaluate` without Commit, and the only dry-run effect (SQL skips the tick RNG) is the
  caller's choice of roller.
- **Errors**: `ResolveException` codes `resolve_round_not_found`, `resolve_round_not_all_rolled` (SQL raised plain exceptions).
- `scrappedGenerations` in a golden is the stored `rounds.scrapped_generations` column, passed through the writer
  from the round row; Evaluate does not produce it.
