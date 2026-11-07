using Npgsql;
using RollForBrew.Api.Data;
using RollForBrew.Api.Orders;
using RollForBrew.Api.RoomEntry;
using RollForBrew.Tests.Harness;
using static RollForBrew.Tests.RoundRecapParityTests;

namespace RollForBrew.Tests;

/// <summary>Spec #533, 7 Nov 2026: every ported write that changes what another player sees
/// bumps <c>rooms.version</c> and sends <c>room-changed</c> carrying it, in its transaction.
/// Delivered on commit, nothing on rollback. Each test owns its database, because the
/// rollback cases make every broadcasting commit fail.</summary>
public class VisibleWriteBroadcastTests : IAsyncLifetime
{
    private const string Today = "(now() at time zone 'Europe/London')::date";

    private TestDatabase _db = null!;
    private NpgsqlDataSource _ds = null!;
    private RoomStore _store = null!;

    public async Task InitializeAsync()
    {
        _db = await TestPostgres.CreateDatabase();
        _ds = RoomStore.BuildDataSource(_db.ApiConnectionString);
        _store = new RoomStore(_ds);
    }

    public async Task DisposeAsync()
    {
        await _ds.DisposeAsync();
        await _db.DisposeAsync();
    }

    private Task<Guid> Enter(TestUser u) => _store.Filler(CallerOf(u), s => RoomEntryEndpoints.Enter(s, default));

    private Task<long> Version(Guid room) => _db.Scalar<long>($"select version from public.rooms where id = '{room}'");

    [Fact]
    public async Task A_new_seat_announces_its_version_and_re_entering_announces_nothing()
    {
        var a = await _db.AddUser("vw-a");
        var b = await _db.AddUser("vw-b");

        var room = await Enter(a);
        Assert.Equal(new[] { 1L }, await _db.RoomChangedVersions(room));

        await Enter(a);
        Assert.Equal(1L, await Version(room));
        Assert.Equal(new[] { 1L }, await _db.RoomChangedVersions(room));

        await Enter(b);
        Assert.Equal(new[] { 1L, 2L }, await _db.RoomChangedVersions(room));
    }

    [Fact]
    public async Task A_seat_that_fails_at_commit_announces_nothing()
    {
        var a = await _db.AddUser("vw-a");
        await _db.FailCommitsThatBroadcast();

        await Assert.ThrowsAsync<PostgresException>(() => Enter(a));

        Assert.Equal(0L, await _db.Messages());
        Assert.Equal(0L, await _db.Scalar<long>("select count(*) from public.room_players where player_id = 'vw-a'"));
    }

    private async Task<(TestUser Player, Guid Room, Guid Round)> OpenRound()
    {
        var u = await _db.AddUser("vw-o");
        var room = Guid.NewGuid();
        var round = Guid.NewGuid();
        await _db.Execute($"""
            insert into public.rooms (id, date) values ('{room}', '2026-01-01');
            insert into public.rounds (id, room_id, started_by, status, started_at) values ('{round}', '{room}', 'vw-o', 'open', now());
            insert into public.round_participants (round_id, player_id) values ('{round}', 'vw-o');
            """);
        return (u, room, round);
    }

    private Task<int> Order(TestUser u, Guid round, string drink) =>
        _store.Filler(CallerOf(u), async s => { await OrderRules.Submit(s, round, drink, default); return 0; });

    [Fact]
    public async Task An_order_announces_its_version_each_time_it_lands_on_the_menu()
    {
        var (u, room, round) = await OpenRound();

        await Order(u, round, "tea");
        await Order(u, round, "coffee");

        Assert.Equal(new[] { 1L, 2L }, await _db.RoomChangedVersions(room));
    }

    [Fact]
    public async Task An_order_that_fails_at_commit_announces_nothing()
    {
        var (u, _, round) = await OpenRound();
        await _db.FailCommitsThatBroadcast();

        await Assert.ThrowsAsync<PostgresException>(() => Order(u, round, "tea"));

        Assert.Equal(0L, await _db.Messages());
        Assert.Equal(0L, await _db.Scalar<long>("select count(*) from public.orders"));
    }
}
