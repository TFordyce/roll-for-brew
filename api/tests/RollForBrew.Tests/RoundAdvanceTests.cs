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

        var payload = await _store.Advance(Caller, roundId, (round, s) => shadow.Run(s, round, roundId, ShadowAdvance.Bridge.AdvanceLayer, log));

        // SQL stayed authoritative and its payload passes through unchanged.
        Assert.Equal("brewer", (string?)payload!["outcome"]);
        Assert.Equal("g-p2", (string?)payload["brewer_id"]); // the lowest total brews

        // SQL replayed C#'s scripted roll instead of rolling its own: exactly one
        // dice_tick row, carrying C#'s deterministic id and rolled value.
        Assert.Equal(1L, await _db.Scalar<long>($"select count(*) from public.spell_casts where round_id = '{roundId}' and cast_inputs ? 'dice_tick'"));
        var castId = await _db.Scalar<string>($"select id::text from public.spell_casts where round_id = '{roundId}' and cast_inputs ? 'dice_tick'");
        Assert.Equal(Ids.Deterministic($"rfb-dice-tick:{await _db.Scalar<string>($"select id::text from public.spell_casts where round_id = '{roundId}' and effect_kind = 'per_round_dice_tick'")}:0").ToString(), castId);
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

        var payload = await _store.Advance(Caller, roundId, (round, s) => shadow.Run(s, round, roundId, ShadowAdvance.Bridge.AdvanceLayer, log));

        // Nobody holds a reaction card, so SQL opens the window and closes it on the
        // spot, finalizing inline: the payload carries both the window and the result.
        Assert.Equal("windowOpened", (string?)payload!["outcome"]);
        Assert.Equal(true, (bool?)payload["window_closed"]);
        Assert.Equal("brewer", (string?)payload["finalization"]!["outcome"]);
        Assert.Equal(1L, await _db.Scalar<long>($"select count(*) from public.spell_reaction_windows where round_id = '{roundId}'"));
        Assert.NotNull(await _db.Scalar<string>($"select resolution_trace from public.rounds where id = '{roundId}'"));
    }

    [Fact]
    public async Task The_finalize_bridge_finalizes_directly_and_passes_sql_through()
    {
        var (roomId, roundId) = await SeedClosedRound();
        await SeedClosedWindow(roundId);
        var log = new CapturingLogger();
        var shadow = new ShadowAdvance(new ScriptedDieRoller());

        var payload = await _store.Advance(Caller, roundId, (round, s) => shadow.Run(s, round, roundId, ShadowAdvance.Bridge.FinalizeLayer, log));

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

        var payload = await _store.Advance(Caller, roundId, (round, s) => shadow.Run(s, round, roundId, ShadowAdvance.Bridge.AdvanceLayer, log));

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

        var payload = await _store.Advance(Caller, missing, (round, s) => shadow.Run(s, round, missing, ShadowAdvance.Bridge.AdvanceLayer, log));

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

        await _store.Advance(Caller, roundId, (round, s) => shadow.Run(s, round, roundId, ShadowAdvance.Bridge.AdvanceLayer, log));

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

        var payload = await _store.Advance(Caller, roundId, (round, s) => shadow.Run(s, round, roundId, ShadowAdvance.Bridge.AdvanceLayer, log));

        Assert.NotNull(payload);
        Assert.Contains(log.Records, r => r.Message.Contains(ShadowAdvance.SkipMarker) && r.Message.Contains("roll-transform"));
        Assert.DoesNotContain(log.Records, r => r.Message.Contains(ShadowAdvance.DiffMarker));
    }

    private async Task SeedClosedWindow(Guid roundId)
    {
        await _db.Execute($$"""
            insert into public.spell_reaction_windows (id, round_id, layer, status, poll_round, opened_at, closed_at)
              values ('66666666-6666-4666-8666-666666666666', '{{roundId}}', 0, 'closed', 1, now(), now());
            """);
    }

    private async Task SeedCalamiTick(Guid roomId, Guid roundId, string victim)
    {
        await _db.Execute($$"""
            insert into public.spell_deck_instances (id, card_id, location, held_by_player)
              select '33333333-3333-4333-8333-333333333333', id, 'held', 'g-p2' from public.spell_cards where name = 'Calami-Tea';
            insert into public.spell_casts (id, round_id, caster_id, card_instance_id, target_player_id, effect_kind, effect_params)
              values ('44444444-4444-4444-8444-444444444444', '{{roundId}}', 'g-p2', '33333333-3333-4333-8333-333333333333', '{{victim}}', 'per_round_dice_tick', '{}');
            insert into public.spell_active_effects (id, room_id, target_player_id, caster_id, source_cast_id, card_id, effect_kind, effect_params, rounds_remaining)
              values ('55555555-5555-4555-8555-555555555555', '{{roomId}}', '{{victim}}', 'g-p2', '44444444-4444-4444-8444-444444444444',
                      (select id from public.spell_cards where name = 'Calami-Tea'), 'per_round_dice_tick', '{"die": 4, "sign": -1}', 3);
            """);
    }

    /// <summary>A closed layer-0 round with two participants; <paramref name="complete"/>
    /// gives both a roll so SQL and C# agree the layer is ready to resolve.</summary>
    internal async Task<(Guid RoomId, Guid RoundId)> SeedClosedRound(
        bool complete = true, Guid? roundId = null, string p1 = "g-adv", string p2 = "g-p2", int v1 = 17, int v2 = 6)
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
            insert into public.rooms (id, date) values ('{room}', '2026-01-01');
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
    public List<(LogLevel Level, string Message)> Records { get; } = [];

    public IDisposable? BeginScope<TState>(TState state) where TState : notnull => null;
    public bool IsEnabled(LogLevel logLevel) => true;
    public void Log<TState>(LogLevel logLevel, EventId eventId, TState state, Exception? exception, Func<TState, Exception?, string> formatter) =>
        Records.Add((logLevel, formatter(state, exception)));
}
