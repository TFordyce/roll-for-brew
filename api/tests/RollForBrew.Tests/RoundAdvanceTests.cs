using System.Text.Json.Nodes;
using Npgsql;
using RollForBrew.Api.Auth;
using RollForBrew.Api.Data;
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
