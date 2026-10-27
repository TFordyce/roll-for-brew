using System.Text.Json.Nodes;
using Microsoft.Extensions.Logging;
using Npgsql;
using RollForBrew.Api.Auth;
using RollForBrew.Api.Data;
using RollForBrew.Api.Problems;
using RollForBrew.Api.RoundAdvance;
using RollForBrew.Domain.Dice;
using RollForBrew.Domain.Resolver;
using RollForBrew.Tests.Harness;

namespace RollForBrew.Tests;

/// <summary>
/// Seam 2 for the evaluator shadow (#546): the transactional advance path in
/// <see cref="RoomStore"/> plus the shadow flow (snapshot, Evaluate, roll pre-writes,
/// the advance_layer/finalize_layer bridges, the diff against what SQL wrote).
/// </summary>
public class RoundAdvanceTests : IAsyncLifetime
{
    private TestDatabase _db = null!;
    private NpgsqlDataSource _ds = null!;
    private RoomStore _store = null!;
    private TestUser _user = null!;

    public async Task InitializeAsync()
    {
        _db = await TestPostgres.CreateDatabase();
        _ds = RoomStore.BuildDataSource(_db.ApiConnectionString);
        _store = new RoomStore(_ds);
        _user = await _db.AddUser("g-adv");
    }

    public async Task DisposeAsync()
    {
        await _ds.DisposeAsync();
        await _db.DisposeAsync();
    }

    private Caller Caller => new(_user.AuthId.ToString(), $$"""{"sub":"{{_user.AuthId}}","role":"authenticated"}""");

    [Fact]
    public async Task Advance_locks_the_round_sets_the_claims_guc_and_hands_back_the_round_context()
    {
        var (roomId, roundId) = await SeedClosedRound();

        var (seen, claims) = await _store.Advance(Caller, roundId, async (round, s) =>
        {
            await using var cmd = new NpgsqlCommand("select current_setting('request.jwt.claims')", s.Connection, s.Transaction);
            var c = (string)(await cmd.ExecuteScalarAsync())!;
            return (round, c);
        });

        Assert.NotNull(seen);
        Assert.Equal(roundId, seen!.RoundId);
        Assert.Equal(roomId, seen.RoomId);
        Assert.Equal("closed", seen.Status);
        Assert.Equal(0, seen.CurrentLayer);
        Assert.Equal(Caller.ClaimsJson, claims);
    }

    [Fact]
    public async Task Advance_on_a_missing_round_hands_back_a_null_lock_instead_of_throwing()
    {
        var missing = Guid.NewGuid();
        var (seen, _) = await _store.Advance(Caller, missing, (round, _) => Task.FromResult((round, "")));
        Assert.Null(seen);
    }

    [Fact]
    public async Task Advance_rolls_everything_back_when_the_work_raises()
    {
        var (roomId, roundId) = await SeedClosedRound();
        await Assert.ThrowsAsync<InvalidOperationException>(() => _store.Advance<object?>(Caller, roundId, async (round, s) =>
        {
            await using var cmd = new NpgsqlCommand(
                "update public.room_players set modifier = 9 where room_id = @r", s.Connection, s.Transaction);
            cmd.Parameters.AddWithValue("r", round!.RoomId);
            await cmd.ExecuteNonQueryAsync();
            throw new InvalidOperationException("boom");
        }));
        Assert.Equal(0L, await _db.Scalar<long>($"select count(*) from public.room_players where room_id = '{roomId}' and modifier = 9"));
    }

    [Fact]
    public async Task Sql_raised_rfb_through_the_advance_path_is_translated_to_its_named_problem()
    {
        await _db.Execute("""
            create function public.test_raise_rfb() returns void language plpgsql as $f$
            begin raise exception 'no' using errcode = 'RFB01'; end $f$;
            grant execute on function public.test_raise_rfb() to rfb_api;
            """);
        var (_, roundId) = await SeedClosedRound();
        var ex = await Assert.ThrowsAsync<ProblemException>(() => _store.Advance<object?>(Caller, roundId, async (_, s) =>
        {
            await using var cmd = new NpgsqlCommand("select public.test_raise_rfb()", s.Connection, s.Transaction);
            await cmd.ExecuteNonQueryAsync();
            return null;
        }));
        Assert.Equal("round_not_open_for_rolling", ex.Code);
    }

    // ------------------------------------------------------------------
    // The shadow flow (#546): evaluate beside the bridge, pre-write C#'s
    // rolls, diff against what SQL wrote, pass SQL's payload through.
    // ------------------------------------------------------------------

    [Fact]
    public async Task A_complete_layer_finalizes_through_the_bridge_with_sql_authoritative_and_no_fresh_dice()
    {
        var (roomId, roundId) = await SeedClosedRound();
        await SeedCalamiTick(roomId, roundId, victim: "g-adv");
        await SeedClosedWindow(roundId);
        var log = new CapturingLogger();
        var shadow = new ShadowAdvance(new ScriptedDieRoller(3));

        var payload = await _store.Advance(Caller, roundId, (round, s) => shadow.Run(s, round, ShadowAdvance.Bridge.AdvanceLayer, log));

        // SQL stayed authoritative and its payload passes through unchanged.
        Assert.Equal("brewer", (string?)payload!["outcome"]);
        Assert.Equal("g-p2", (string?)payload["brewer_id"]); // the lowest total brews

        // SQL replayed C#'s scripted roll instead of rolling its own: exactly one
        // dice_tick row, carrying C#'s deterministic id and rolled value.
        Assert.Equal(1L, await _db.Scalar<long>($"select count(*) from public.spell_casts where round_id = '{roundId}' and cast_inputs ? 'dice_tick'"));
        var castId = await _db.Scalar<string>($"select id::text from public.spell_casts where round_id = '{roundId}' and cast_inputs ? 'dice_tick'");
        var srcCastId = await _db.Scalar<string>($"select id::text from public.spell_casts where round_id = '{roundId}' and effect_kind = 'per_round_dice_tick'");
        Assert.Equal(Ids.Deterministic($"rfb-dice-tick:{roundId}:{srcCastId}:0").ToString(), castId);
        Assert.Equal("3", await _db.Scalar<string>($"select effect_params ->> 'rolled' from public.spell_casts where round_id = '{roundId}' and cast_inputs ? 'dice_tick'"));

        // SQL wrote its authoritative resolution and the shadow agreed: no diff marker.
        Assert.NotNull(await _db.Scalar<string>($"select resolution_trace from public.rounds where id = '{roundId}'"));
        Assert.NotNull(await _db.Scalar<string>($"select resolution_summary from public.rounds where id = '{roundId}'"));
        Assert.Equal("g-p2", await _db.Scalar<string>($"select brewer_id from public.rounds where id = '{roundId}'"));
        Assert.DoesNotContain(log.Records, r => r.Message.Contains(ShadowAdvance.DiffMarker));
    }

    [Fact]
    public async Task A_layer_that_opens_its_reaction_window_passes_the_window_outcome_through()
    {
        var (roomId, roundId) = await SeedClosedRound();
        var log = new CapturingLogger();
        var shadow = new ShadowAdvance(new ScriptedDieRoller());

        var payload = await _store.Advance(Caller, roundId, (round, s) => shadow.Run(s, round, ShadowAdvance.Bridge.AdvanceLayer, log));

        // Nobody holds a reaction card, so SQL opens the window and closes it on the
        // spot, finalizing inline: the payload carries both the window and the result.
        Assert.Equal("windowOpened", (string?)payload!["outcome"]);
        Assert.Equal(true, (bool?)payload["window_closed"]);
        Assert.Equal("brewer", (string?)payload["finalization"]!["outcome"]);
        Assert.Equal(1L, await _db.Scalar<long>($"select count(*) from public.spell_reaction_windows where round_id = '{roundId}'"));
        Assert.NotNull(await _db.Scalar<string>($"select resolution_trace from public.rounds where id = '{roundId}'"));
        // The nested finalization is a real finalization: the shadow examined it
        // (and agreed), not skipped it and not let it pass silently.
        Assert.DoesNotContain(log.Records, r => r.Message.Contains(ShadowAdvance.SkipMarker));
        Assert.DoesNotContain(log.Records, r => r.Message.Contains(ShadowAdvance.DiffMarker));
    }

    [Fact]
    public async Task An_open_window_leaves_no_synthesized_rows_behind_after_the_advance_commits()
    {
        var (roomId, roundId) = await SeedClosedRound();
        await SeedCalamiTick(roomId, roundId, victim: "g-adv");
        // A held Reaction card keeps the window open, so the advance cannot finalize
        // (g-adv: g-p2 is already holding the Calami-Tea, and the hold cap is one).
        await SeedHeldReactionCard("g-adv");
        var log = new CapturingLogger();
        var shadow = new ShadowAdvance(new ScriptedDieRoller(3));

        var payload = await _store.Advance(Caller, roundId, (round, s) => shadow.Run(s, round, ShadowAdvance.Bridge.AdvanceLayer, log));

        Assert.Equal("windowOpened", (string?)payload!["outcome"]);
        Assert.Equal(false, (bool?)payload["window_closed"]);
        Assert.Null((string?)payload["finalization"]); // jsonb null, not an absent key
        // The pre-written tick did not survive the non-finalizing outcome: the next
        // call re-evaluates and pre-writes fresh, so nothing freezes mid-window.
        Assert.Equal(0L, await _db.Scalar<long>(
            $"select count(*) from public.spell_casts where round_id = '{roundId}' and cast_inputs ? 'dice_tick'"));
        Assert.Equal("open", await _db.Scalar<string>($"select status from public.spell_reaction_windows where round_id = '{roundId}'"));
        Assert.Null(await _db.Scalar<string>($"select resolution_trace from public.rounds where id = '{roundId}'"));
        // No finalization happened, so there was nothing to examine: no diff and no skip.
        Assert.DoesNotContain(log.Records, r => r.Message.Contains(ShadowAdvance.DiffMarker));
        Assert.DoesNotContain(log.Records, r => r.Message.Contains(ShadowAdvance.SkipMarker));
    }

    [Fact]
    public async Task The_window_close_finalize_re_synthesizes_and_diffs_clean()
    {
        var (roomId, roundId) = await SeedClosedRound();
        await SeedCalamiTick(roomId, roundId, victim: "g-adv");
        await SeedHeldReactionCard("g-adv");
        // A fresh shadow (and scripted die) per call, as production's per-request
        // instance: each call evaluates and rolls its own tick.
        await _store.Advance(Caller, roundId, (round, s) => new ShadowAdvance(new ScriptedDieRoller(3))
            .Run(s, round, ShadowAdvance.Bridge.AdvanceLayer, new CapturingLogger()));

        // The window closes (in play: every eligible holder passes), then the
        // finalize bridge runs: it synthesizes the tick then, with the window's
        // final state in the snapshot, and SQL replays C#'s roll.
        await CloseWindow(roundId);
        var log = new CapturingLogger();
        var payload = await _store.Advance(Caller, roundId, (round, s) => new ShadowAdvance(new ScriptedDieRoller(3))
            .Run(s, round, ShadowAdvance.Bridge.FinalizeLayer, log));

        Assert.Equal("brewer", (string?)payload!["outcome"]);
        Assert.Equal(1L, await _db.Scalar<long>($"select count(*) from public.spell_casts where round_id = '{roundId}' and cast_inputs ? 'dice_tick'"));
        Assert.Equal("3", await _db.Scalar<string>($"select effect_params ->> 'rolled' from public.spell_casts where round_id = '{roundId}' and cast_inputs ? 'dice_tick'"));
        Assert.Equal("g-p2", await _db.Scalar<string>($"select brewer_id from public.rounds where id = '{roundId}'"));
        Assert.DoesNotContain(log.Records, r => r.Message.Contains(ShadowAdvance.DiffMarker));
        Assert.DoesNotContain(log.Records, r => r.Message.Contains(ShadowAdvance.SkipMarker));
    }

    [Fact]
    public async Task An_evaluate_exception_skips_at_warning_with_the_exception_attached()
    {
        // Cloud Run's default severity filter drops Information logs entirely, so a
        // skip logged below Warning makes the degradation invisible in production —
        // the skip must carry the caught exception, or the capture round reads as
        // "no diff, no skip, no exception" with SQL's own rolls persisted.
        var (roomId, roundId) = await SeedClosedRound();
        await SeedCalamiTick(roomId, roundId, victim: "g-adv");
        await SeedClosedWindow(roundId);
        var log = new CapturingLogger();
        var payload = await _store.Advance(Caller, roundId, (round, s) => new ShadowAdvance(
                new ScriptedDieRoller(3),
                (_, _, _) => throw new InvalidOperationException("production snapshot shape"))
            .Run(s, round, ShadowAdvance.Bridge.FinalizeLayer, log));

        Assert.Equal("brewer", (string?)payload!["outcome"]); // SQL stays authoritative
        var skip = Assert.Single(log.Records, r => r.Message.Contains(ShadowAdvance.SkipMarker));
        Assert.Equal(LogLevel.Warning, skip.Level);
        Assert.Equal("production snapshot shape", skip.Exception?.Message);
        Assert.DoesNotContain(log.Records, r => r.Message.Contains(ShadowAdvance.DiffMarker));
    }

    [Fact]
    public async Task A_ward_cast_during_the_window_negates_the_tick_exactly_like_the_sql_only_path()
    {
        // The same scenario twice: once through the shadow, once through today's
        // SQL-only rpc path. The ward enters mid-window, so the tick's negation may
        // only be decided when the round finalizes — the fix must land both engines
        // on the identical state.
        // The hold cap is one card per player: the Calami-Tea instance sits in the
        // deck (the tick runs off its active effect, not the hold), freeing a
        // participant to hold the Reaction card that keeps each window open.
        var (shadowRoom, shadowRound) = await SeedClosedRound();
        await SeedCalamiTick(shadowRoom, shadowRound, victim: "g-adv", held: false);
        await SeedHeldReactionCard("g-adv");
        await _store.Advance(Caller, shadowRound, (round, s) => new ShadowAdvance(new ScriptedDieRoller(3))
            .Run(s, round, ShadowAdvance.Bridge.AdvanceLayer, new CapturingLogger()));
        await SeedWardCast(shadowRoom, shadowRound, target: "g-adv", caster: "g-adv");
        await CloseWindow(shadowRound);
        var log = new CapturingLogger();
        await _store.Advance(Caller, shadowRound, (round, s) => new ShadowAdvance(new ScriptedDieRoller(3))
            .Run(s, round, ShadowAdvance.Bridge.FinalizeLayer, log));

        var (sqlRoom, sqlRound) = await SeedClosedRound(date: "2026-01-02"); // rooms.date is unique
        await SeedCalamiTick(sqlRoom, sqlRound, victim: "g-adv", held: false);
        await SeedHeldReactionCard("g-p2");
        await _db.Execute($"select public.advance_layer('{sqlRound}')");
        await SeedWardCast(sqlRoom, sqlRound, target: "g-adv", caster: "g-adv");
        await CloseWindow(sqlRound);
        await _db.Execute($"select public.finalize_layer('{sqlRound}')");

        // Pinned negation outcome: the warded tick applies nothing, in both engines.
        foreach (var round in new[] { shadowRound, sqlRound })
        {
            Assert.True(await _db.Scalar<bool>(
                $"select negated from public.spell_casts where round_id = '{round}' and cast_inputs ? 'dice_tick'"),
                "the synthesized tick must end up negated (warded)");
            Assert.Equal("g-p2", await _db.Scalar<string>($"select brewer_id from public.rounds where id = '{round}'"));
            Assert.Equal(17, await _db.Scalar<int>($"select value from public.rolls where round_id = '{round}' and player_id = 'g-adv'"));
        }

        // And the shadow agreed with SQL through the goldens' normalized comparison.
        Assert.DoesNotContain(log.Records, r => r.Message.Contains(ShadowAdvance.DiffMarker));
        var (shadowTrace, shadowSummary) = await TraceAndSummary(shadowRound);
        var (sqlTrace, sqlSummary) = await TraceAndSummary(sqlRound);
        var roster = new Dictionary<string, string>();
        Assert.True(TraceNormaliser.NodesEqual(
                TraceNormaliser.NormaliseTrace(shadowTrace, roster), TraceNormaliser.NormaliseTrace(sqlTrace, roster)),
            "shadow and sql-only traces diverge");
        Assert.True(TraceNormaliser.NodesEqual(
                TraceNormaliser.NormaliseSummary(shadowSummary, roster), TraceNormaliser.NormaliseSummary(sqlSummary, roster)),
            "shadow and sql-only summaries diverge");
    }

    [Fact]
    public async Task The_finalize_bridge_finalizes_directly_and_passes_sql_through()
    {
        var (roomId, roundId) = await SeedClosedRound();
        await SeedClosedWindow(roundId);
        var log = new CapturingLogger();
        var shadow = new ShadowAdvance(new ScriptedDieRoller());

        var payload = await _store.Advance(Caller, roundId, (round, s) => shadow.Run(s, round, ShadowAdvance.Bridge.FinalizeLayer, log));

        Assert.Equal("brewer", (string?)payload!["outcome"]);
        Assert.NotNull(await _db.Scalar<string>($"select resolution_summary from public.rounds where id = '{roundId}'"));
        Assert.DoesNotContain(log.Records, r => r.Message.Contains(ShadowAdvance.DiffMarker));
    }

    [Fact]
    public async Task An_incomplete_layer_noops_and_writes_nothing()
    {
        var (roomId, roundId) = await SeedClosedRound(complete: false);
        var log = new CapturingLogger();
        var shadow = new ShadowAdvance(new ScriptedDieRoller());

        var payload = await _store.Advance(Caller, roundId, (round, s) => shadow.Run(s, round, ShadowAdvance.Bridge.AdvanceLayer, log));

        Assert.Equal("noop", (string?)payload!["outcome"]);
        Assert.Equal("layer_incomplete", (string?)payload["reason"]);
        Assert.Equal(0L, await _db.Scalar<long>($"select count(*) from public.spell_reaction_windows where round_id = '{roundId}'"));
        Assert.Null(await _db.Scalar<string>($"select resolution_trace from public.rounds where id = '{roundId}'"));
        Assert.Equal(0L, await _db.Scalar<long>($"select count(*) from public.spell_casts where round_id = '{roundId}'"));
    }

    [Fact]
    public async Task A_missing_round_noops_like_the_rpc()
    {
        var missing = Guid.NewGuid();
        var log = new CapturingLogger();
        var shadow = new ShadowAdvance();

        var payload = await _store.Advance(Caller, missing, (round, s) => shadow.Run(s, round, ShadowAdvance.Bridge.AdvanceLayer, log));

        Assert.Equal("noop", (string?)payload!["outcome"]);
        Assert.Equal("round_not_found", (string?)payload["reason"]);
    }

    [Fact]
    public async Task A_forced_mismatch_logs_the_diff_marker_with_golden_reproduction_context()
    {
        var (roomId, roundId) = await SeedClosedRound();
        await SeedClosedWindow(roundId);
        var log = new CapturingLogger();
        var shadow = new ShadowAdvance(new ScriptedDieRoller(), evaluate: (snapshot, id, dice) =>
        {
            var r = Evaluator.Evaluate(snapshot, id, dice);
            return r with { BrewerId = "g-adv" }; // force the candidate to disagree (SQL brews g-p2)
        });

        await _store.Advance(Caller, roundId, (round, s) => shadow.Run(s, round, ShadowAdvance.Bridge.AdvanceLayer, log));

        var diff = Assert.Single(log.Records, r => r.Level == LogLevel.Error && r.Message.Contains(ShadowAdvance.DiffMarker));
        Assert.Contains(roundId.ToString(), diff.Message);
        Assert.Contains(roomId.ToString(), diff.Message);
        Assert.Contains("brewer", diff.Message);
        Assert.Contains("\"snapshot\"", diff.Message);
    }

    [Fact]
    public async Task Unapplied_shim_transforms_skip_the_diff_instead_of_firing_a_false_diff()
    {
        var (roomId, roundId) = await SeedClosedRound();
        await SeedClosedWindow(roundId);
        var log = new CapturingLogger();
        var shadow = new ShadowAdvance(new ScriptedDieRoller());
        // A forced reroll the finalize shim would normally have recorded a transform
        // for; the candidate is evaluated without it, so the diff is skipped (and
        // said so), never raised as a false mismatch.
        await _db.Execute($$"""
            insert into public.spell_deck_instances (id, card_id, location, held_by_player)
              select '11111111-1111-4111-8111-111111111111', id, 'held', 'g-p2' from public.spell_cards limit 1;
            insert into public.spell_casts (id, round_id, caster_id, card_instance_id, target_player_id, effect_kind, cast_inputs, negated)
              values ('22222222-2222-4222-8222-222222222222', '{{roundId}}', 'g-p2', '11111111-1111-4111-8111-111111111111', 'g-adv', 'forced_reroll', '{}', false);
            """);

        var payload = await _store.Advance(Caller, roundId, (round, s) => shadow.Run(s, round, ShadowAdvance.Bridge.AdvanceLayer, log));

        Assert.NotNull(payload);
        Assert.Contains(log.Records, r => r.Message.Contains(ShadowAdvance.SkipMarker) && r.Message.Contains("roll-transform"));
        Assert.DoesNotContain(log.Records, r => r.Message.Contains(ShadowAdvance.DiffMarker));
    }

    [Fact]
    public async Task A_persistent_tick_effect_carrying_across_rounds_finalizes_clean()
    {
        // Regression for the 2026-10-22 production wedge (round 30ddd9f7): round A
        // resolved with three Calami-Tea casts and three persistent live effects
        // (rounds_remaining 3); one effect targets test-player-4, who is NOT a
        // participant of the next round. Round B closes with three rolls and no
        // eligible reaction holder — the advance must finalize without raising.
        var room = Guid.NewGuid();
        var roundA = Guid.NewGuid();
        var roundB = Guid.NewGuid();
        var instance = Guid.NewGuid();
        var casts = new[] { Guid.NewGuid(), Guid.NewGuid(), Guid.NewGuid() };
        var victims = new[] { "t-2", "t-4", "t-3" };
        var inserts = new List<string>
        {
            $"""
            insert into public.players (id, email) values
              ('t-1', 't-1@x.test'), ('t-2', 't-2@x.test'), ('t-3', 't-3@x.test'), ('t-4', 't-4@x.test');
            insert into public.rooms (id, date) values ('{room}', '2026-01-05');
            insert into public.room_players (room_id, player_id, modifier) values
              ('{room}', 't-1', 7), ('{room}', 't-2', 6), ('{room}', 't-3', 7), ('{room}', 't-4', 0);
            insert into public.rounds (id, room_id, started_by, status, started_at, closed_at) values
              ('{roundA}', '{room}', 't-1', 'resolved', '2026-01-05 09:00+00', '2026-01-05 09:10+00'),
              ('{roundB}', '{room}', 't-1', 'closed',   '2026-01-05 10:00+00', '2026-01-05 10:05+00');
            insert into public.round_participants (round_id, player_id) values
              ('{roundA}', 't-1'), ('{roundA}', 't-2'), ('{roundA}', 't-4'), ('{roundA}', 't-3'),
              ('{roundB}', 't-1'), ('{roundB}', 't-2'), ('{roundB}', 't-3');
            insert into public.rolls (round_id, player_id, layer, value, input_mode, modifier_snapshot) values
              ('{roundB}', 't-2', 0, 8, 'in_app', 6), ('{roundB}', 't-1', 0, 10, 'in_app', 7), ('{roundB}', 't-3', 0, 10, 'in_app', 7);
            insert into public.spell_deck_instances (id, card_id, location)
              select '{instance}', id, 'in_deck' from public.spell_cards where name = 'Calami-Tea';
            """,
        };
        for (var i = 0; i < 3; i++)
            inserts.Add($$"""
                insert into public.spell_casts (id, round_id, caster_id, card_instance_id, target_player_id, effect_kind, effect_params)
                  values ('{{casts[i]}}', '{{roundA}}', 't-1', '{{instance}}', '{{victims[i]}}', 'per_round_dice_tick', '{"die": 4, "sign": -1}');
                insert into public.spell_active_effects (id, room_id, target_player_id, caster_id, source_cast_id, card_id, effect_kind, effect_params, rounds_remaining)
                  values ('{{Guid.NewGuid()}}', '{{room}}', '{{victims[i]}}', 't-1', '{{casts[i]}}',
                          (select id from public.spell_cards where name = 'Calami-Tea'), 'per_round_dice_tick', '{"die": 4, "sign": -1, "max_targets": 3}', 3);
                """);
        // the non-participant holds a reaction card (Mug Mirror), as in production
        inserts.Add($"""
            insert into public.spell_deck_instances (id, card_id, location, held_by_player)
              select '{Guid.NewGuid()}', id, 'held', 't-4' from public.spell_cards where name = 'Mug Mirror';
            """);
        foreach (var sql in inserts) await _db.Execute(sql);

        var log = new CapturingLogger();
        var shadow = new ShadowAdvance(new ScriptedDieRoller(3));

        var payload = await _store.Advance(Caller, roundB, (round, s) => shadow.Run(s, round, ShadowAdvance.Bridge.AdvanceLayer, log));

        Assert.NotNull(payload);
    }

    [Fact]
    public async Task A_layer_1_rolloff_resolution_diffs_clean_despite_layer_0_trace_and_summary()
    {
        // The 2026-10-27 11:19Z production diff (round f9e9dac2): a Loose Leaf
        // rolloff carried the round to layer 1, and the resolving advance compared
        // C#'s fresh layer-1 resolution — no trace, no players — against
        // rounds.resolution_trace/resolution_summary, which layer 0 had filled and
        // which layer > 0 never rewrites (issue #219: layer > 0 persists nothing).
        // The columns are not the layer-1 resolution's output; the comparison at
        // layer > 0 must not hold the candidate against them.
        var room = Guid.NewGuid();
        var round = Guid.NewGuid();
        var instance = Guid.NewGuid();
        var rolloffCast = Guid.NewGuid();
        await _db.Execute($$$"""
            insert into public.players (id, email) values
              ('t-1', 't-1@x.test'), ('t-2', 't-2@x.test'), ('t-3', 't-3@x.test'), ('t-4', 't-4@x.test');
            insert into public.rooms (id, date) values ('{{{room}}}', '2026-01-05');
            insert into public.room_players (room_id, player_id, modifier) values
              ('{{{room}}}', 't-1', 0), ('{{{room}}}', 't-2', 0), ('{{{room}}}', 't-3', 0), ('{{{room}}}', 't-4', 0);
            insert into public.rounds (id, room_id, started_by, status, started_at, closed_at, current_layer, resolution_trace, resolution_summary) values
              ('{{{round}}}', '{{{room}}}', 't-1', 'closed', '2026-01-05 09:00+00', '2026-01-05 09:05+00', 1,
               '[{"after":{"type":"status","value":"rolloff"},"index":0,"before":{"type":"status","value":"brewer"},"outcome":"applied","source_cast":{"cast_id":"{{{rolloffCast}}}","card_name":"Loose Leaf","active_effect_id":null,"caster_player_id":"t-2"},"display_kind":"named_tea_maker_rolloff","target_player":"t-2","rolloff_opponent_ids":["t-1"]}]',
               '[{"nat":null,"roll":10,"total":10,"composed":0,"snapshot":0,"player_id":"t-1","dice_reduced":false},{"nat":null,"roll":5,"total":5,"composed":0,"snapshot":0,"player_id":"t-2","dice_reduced":false},{"nat":null,"roll":17,"total":17,"composed":0,"snapshot":0,"player_id":"t-3","dice_reduced":false},{"nat":null,"roll":19,"total":19,"composed":0,"snapshot":0,"player_id":"t-4","dice_reduced":false}]');
            insert into public.round_participants (round_id, player_id) values
              ('{{{round}}}', 't-1'), ('{{{round}}}', 't-2'), ('{{{round}}}', 't-3'), ('{{{round}}}', 't-4');
            insert into public.round_layer_participants (round_id, layer, player_id) values
              ('{{{round}}}', 1, 't-1'), ('{{{round}}}', 1, 't-2');
            insert into public.rolls (round_id, player_id, layer, value, input_mode, modifier_snapshot) values
              ('{{{round}}}', 't-1', 0, 10, 'in_app', 0), ('{{{round}}}', 't-2', 0, 5, 'in_app', 0),
              ('{{{round}}}', 't-3', 0, 17, 'in_app', 0), ('{{{round}}}', 't-4', 0, 19, 'in_app', 0),
              ('{{{round}}}', 't-1', 1, 16, 'in_app', 0), ('{{{round}}}', 't-2', 1, 20, 'in_app', 0);
            insert into public.spell_deck_instances (id, card_id, location)
              select '{{{instance}}}', id, 'in_deck' from public.spell_cards where name = 'Loose Leaf';
            insert into public.spell_casts (id, round_id, caster_id, card_instance_id, target_player_id, effect_kind, effect_params)
              values ('{{{rolloffCast}}}', '{{{round}}}', 't-2', '{{{instance}}}', 't-2', 'named_tea_maker_rolloff', '{}');
            """);
        await SeedClosedWindow(round);
        var log = new CapturingLogger();

        var payload = await _store.Advance(Caller, round, (r, s) => new ShadowAdvance(new ConstantDieRoller(3))
            .Run(s, r, ShadowAdvance.Bridge.AdvanceLayer, log));

        Assert.Equal("brewer", (string?)payload!["outcome"]);
        Assert.Equal("t-1", (string?)payload["brewer_id"]); // the lower layer-1 roll
        Assert.DoesNotContain(log.Records, r => r.Message.Contains(ShadowAdvance.DiffMarker));
        Assert.DoesNotContain(log.Records, r => r.Message.Contains(ShadowAdvance.SkipMarker));
    public async Task A_tick_persisted_by_an_earlier_round_does_not_collide_when_the_effect_lives_on()
    {
        // 2026-10-22 22:29Z production 500 (round 22fd4e1e; same signature as the
        // 07:44Z one): the tick salt was rfb-dice-tick:{sourceCastId}:{gen} with
        // replay_generation 0 in both rounds, so a persistent Calami-Tea effect
        // living into a second round re-emitted the id its first-round tick
        // already had, and the pre-write's plain INSERT hit spell_casts_pkey.
        // The salt is round-scoped now; the earlier round's tick keeps its id.
        var room = Guid.NewGuid();
        var roundA = Guid.NewGuid();
        var roundB = Guid.NewGuid();
        var instance = Guid.NewGuid();
        var srcA = Guid.NewGuid();
        var tickA = Ids.Deterministic($"rfb-dice-tick:{srcA}:0"); // the old, collision-prone scheme
        await _db.Execute($"""
            insert into public.players (id, email) values ('t-1', 't-1@x.test'), ('t-2', 't-2@x.test');
            insert into public.rooms (id, date) values ('{room}', '2026-01-05');
            insert into public.room_players (room_id, player_id, modifier) values ('{room}', 't-1', 0), ('{room}', 't-2', 0);
            insert into public.rounds (id, room_id, started_by, status, started_at, closed_at) values
              ('{roundA}', '{room}', 't-1', 'resolved', '2026-01-05 09:00+00', '2026-01-05 09:10+00'),
              ('{roundB}', '{room}', 't-1', 'closed',   '2026-01-05 10:00+00', '2026-01-05 10:05+00');
            insert into public.round_participants (round_id, player_id) values
              ('{roundA}', 't-1'), ('{roundA}', 't-2'), ('{roundB}', 't-1'), ('{roundB}', 't-2');
            insert into public.rolls (round_id, player_id, layer, value, input_mode, modifier_snapshot) values
              ('{roundB}', 't-1', 0, 10, 'in_app', 0), ('{roundB}', 't-2', 0, 8, 'in_app', 0);
            insert into public.spell_deck_instances (id, card_id, location)
              select '{instance}', id, 'in_deck' from public.spell_cards where name = 'Calami-Tea';
            """);
        await _db.Execute($$"""
            insert into public.spell_casts (id, round_id, caster_id, card_instance_id, target_player_id, effect_kind, effect_params)
              values ('{{srcA}}', '{{roundA}}', 't-2', '{{instance}}', 't-1', 'per_round_dice_tick', '{"die": 4, "sign": -1}');
            insert into public.spell_active_effects (id, room_id, target_player_id, caster_id, source_cast_id, card_id, effect_kind, effect_params, rounds_remaining)
              values ('{{Guid.NewGuid()}}', '{{room}}', 't-1', 't-2', '{{srcA}}',
                      (select id from public.spell_cards where name = 'Calami-Tea'), 'per_round_dice_tick', '{"die": 4, "sign": -1, "max_targets": 3}', 3);
            """);
        await _db.Execute($$$"""
            insert into public.spell_casts (id, round_id, caster_id, card_instance_id, target_player_id, effect_kind, effect_params, cast_inputs, generation, source_cast_id)
              values ('{{{tickA}}}', '{{{roundA}}}', 't-2', '{{{instance}}}', 't-1', 'per_round_dice_tick',
                      '{"die": 4, "sign": -1, "rolled": 4}',
                      '{"dice_tick": true, "roll_transform": {"kind": "per_round_dice_tick", "order": 2, "die": 4, "sign": -1, "rolled": 4, "players": [{"player_id": "t-1", "before": null, "after": null, "warded": false}]}}',
                      0, '{{{srcA}}}');
            """);
        await SeedClosedWindow(roundB);
        var log = new CapturingLogger();

        var payload = await _store.Advance(Caller, roundB, (round, s) => new ShadowAdvance(new ConstantDieRoller(3))
            .Run(s, round, ShadowAdvance.Bridge.FinalizeLayer, log));

        Assert.Equal("brewer", (string?)payload!["outcome"]);
        Assert.DoesNotContain(log.Records, r => r.Message.Contains(ShadowAdvance.SkipMarker));
        var expectedId = Ids.Deterministic($"rfb-dice-tick:{roundB}:{srcA}:0").ToString();
        Assert.NotEqual(tickA.ToString(), expectedId);
        Assert.Equal(expectedId, await _db.Scalar<string>(
            $"select id::text from public.spell_casts where round_id = '{roundB}' and cast_inputs ? 'dice_tick'"));
        Assert.Equal("3", await _db.Scalar<string>(
            $"select effect_params ->> 'rolled' from public.spell_casts where round_id = '{roundB}' and cast_inputs ? 'dice_tick'"));
        Assert.Equal(1L, await _db.Scalar<long>(
            $"select count(*) from public.spell_casts where id = '{tickA}'")); // round A's tick untouched
    }

    private async Task SeedClosedWindow(Guid roundId)
    {
        await _db.Execute($$"""
            insert into public.spell_reaction_windows (id, round_id, layer, status, poll_round, opened_at, closed_at)
              values ('66666666-6666-4666-8666-666666666666', '{{roundId}}', 0, 'closed', 1, now(), now());
            """);
    }

    private async Task SeedCalamiTick(Guid roomId, Guid roundId, string victim, bool held = true)
    {
        var instance = Guid.NewGuid();
        var cast = Guid.NewGuid();
        await _db.Execute($$"""
            insert into public.spell_deck_instances (id, card_id, location, held_by_player)
              select '{{instance}}', id, '{{(held ? "held" : "in_deck")}}', {{(held ? "'g-p2'" : "null")}} from public.spell_cards where name = 'Calami-Tea';
            insert into public.spell_casts (id, round_id, caster_id, card_instance_id, target_player_id, effect_kind, effect_params)
              values ('{{cast}}', '{{roundId}}', 'g-p2', '{{instance}}', '{{victim}}', 'per_round_dice_tick', '{}');
            insert into public.spell_active_effects (id, room_id, target_player_id, caster_id, source_cast_id, card_id, effect_kind, effect_params, rounds_remaining)
              values ('{{Guid.NewGuid()}}', '{{roomId}}', '{{victim}}', 'g-p2', '{{cast}}',
                      (select id from public.spell_cards where name = 'Calami-Tea'), 'per_round_dice_tick', '{"die": 4, "sign": -1}', 3);
            """);
    }

    /// <summary>A held Reaction card, so <c>count_eligible_reaction_holders</c> keeps
    /// the layer-0 window open and the advance cannot finalize.</summary>
    private async Task SeedHeldReactionCard(string player)
    {
        var instance = Guid.NewGuid();
        await _db.Execute($$"""
            insert into public.spell_deck_instances (id, card_id, location, held_by_player)
              select '{{instance}}', id, 'held', '{{player}}' from public.spell_cards where name = 'Six Sugars';
            """);
    }

    /// <summary>A Cast-Iron Kettle ward (roll domain, negative polarity) on
    /// <paramref name="target"/> — the rows <c>cast_reaction_spell_card</c> writes,
    /// seeded directly so the ward can enter mid-window in a test.</summary>
    private async Task SeedWardCast(Guid roomId, Guid roundId, string target, string caster)
    {
        var instance = Guid.NewGuid();
        var cast = Guid.NewGuid();
        await _db.Execute($$"""
            insert into public.spell_deck_instances (id, card_id, location, held_by_player)
              select '{{instance}}', id, 'in_deck', null from public.spell_cards where name = 'Cast-Iron Kettle';
            insert into public.spell_casts (id, round_id, caster_id, card_instance_id, target_player_id, effect_kind, effect_params)
              values ('{{cast}}', '{{roundId}}', '{{caster}}', '{{instance}}', '{{target}}',
                      'ward', '{"domain": ["roll"], "polarity": ["negative"]}');
            insert into public.spell_active_effects (id, room_id, target_player_id, caster_id, source_cast_id, card_id, effect_kind, effect_params)
              values ('{{Guid.NewGuid()}}', '{{roomId}}', '{{target}}', '{{caster}}', '{{cast}}',
                      (select id from public.spell_cards where name = 'Cast-Iron Kettle'), 'ward', '{"domain": ["roll"], "polarity": ["negative"]}');
            """);
    }

    private async Task CloseWindow(Guid roundId) =>
        await _db.Execute($"update public.spell_reaction_windows set status = 'closed', closed_at = now() where round_id = '{roundId}' and status = 'open'");

    private async Task<(JsonArray Trace, JsonArray Summary)> TraceAndSummary(Guid roundId) =>
        (JsonNode.Parse((await _db.Scalar<string>($"select resolution_trace from public.rounds where id = '{roundId}'"))!)!.AsArray(),
         JsonNode.Parse((await _db.Scalar<string>($"select resolution_summary from public.rounds where id = '{roundId}'"))!)!.AsArray());

    /// <summary>A closed layer-0 round with two participants; <paramref name="complete"/>
    /// gives both a roll so SQL and C# agree the layer is ready to resolve.</summary>
    internal async Task<(Guid RoomId, Guid RoundId)> SeedClosedRound(
        bool complete = true, Guid? roundId = null, string p1 = "g-adv", string p2 = "g-p2", int v1 = 17, int v2 = 6,
        string date = "2026-01-01")
    {
        var room = Guid.NewGuid();
        var round = roundId ?? Guid.NewGuid();
        if (!await PlayerExists(p2)) await _db.Execute($"insert into public.players (id, email) values ('{p2}', '{p2}@example.test')");
        var rolls = complete
            ? $"""
              insert into public.rolls (round_id, player_id, layer, value, input_mode, modifier_snapshot) values
                ('{round}', '{p1}', 0, {v1}, 'in_app', 0), ('{round}', '{p2}', 0, {v2}, 'in_app', 0);
              """
            : "";
        await _db.Execute($"""
            insert into public.rooms (id, date) values ('{room}', '{date}');
            insert into public.rounds (id, room_id, started_by, status, started_at, closed_at) values
              ('{round}', '{room}', '{p1}', 'closed', '2026-01-01 09:00+00', '2026-01-01 09:01+00');
            insert into public.round_participants (round_id, player_id) values ('{round}', '{p1}'), ('{round}', '{p2}');
            insert into public.room_players (room_id, player_id, modifier) values ('{room}', '{p1}', 0), ('{room}', '{p2}', 0);
            {rolls}
            """);
        return (room, round);
    }

    private async Task<bool> PlayerExists(string id) =>
        (await _db.Scalar<long>($"select count(*) from public.players where id = '{id}'")) > 0;
}

/// <summary>Records (level, message) pairs so tests can assert on the shadow's markers.</summary>
public sealed class CapturingLogger : ILogger
{
    public List<(LogLevel Level, string Message, Exception? Exception)> Records { get; } = [];

    public IDisposable? BeginScope<TState>(TState state) where TState : notnull => null;
    public bool IsEnabled(LogLevel logLevel) => true;
    public void Log<TState>(LogLevel logLevel, EventId eventId, TState state, Exception? exception, Func<TState, Exception?, string> formatter) =>
        Records.Add((logLevel, formatter(state, exception), exception));
}
