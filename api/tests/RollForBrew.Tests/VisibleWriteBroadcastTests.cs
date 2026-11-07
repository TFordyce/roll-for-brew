using Npgsql;
using RollForBrew.Api.Data;
using RollForBrew.Api.ModifierAdjustments;
using RollForBrew.Api.Orders;
using RollForBrew.Api.Problems;
using RollForBrew.Api.RoundBackfill;
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

    private async Task<(TestUser Actor, TestUser Admin, Guid Room)> TodayRoomWithTarget()
    {
        var actor = await _db.AddUser("vw-actor");
        var admin = await _db.AddUser("vw-admin", admin: true);
        await _db.Execute($"""
            insert into public.rooms (date) values ({Today});
            insert into public.room_players (room_id, player_id, modifier) select id, 'vw-actor', 0 from public.rooms where date = {Today};
            """);
        return (actor, admin, await _db.Scalar<Guid>($"select id from public.rooms where date = {Today}"));
    }

    private Task<Guid> Adjust(TestUser u, int delta) =>
        _store.Filler(CallerOf(u), s => ModAdjRules.Log(s, "vw-actor", delta, "spilled the milk", default));

    private Task<int> Undo(TestUser u, Guid id) =>
        _store.Filler(CallerOf(u), async s => { await ModAdjRules.Undo(s, id, default); return 0; });

    private Task<int> AdminDelete(TestUser u, Guid id) =>
        _store.Filler(CallerOf(u), async s => { await ModAdjRules.AdminDelete(s, id, "not fair", default); return 0; });

    [Fact]
    public async Task Each_modifier_adjustment_write_announces_the_roster_change()
    {
        var (actor, admin, room) = await TodayRoomWithTarget();

        await Undo(actor, await Adjust(actor, 2));
        await AdminDelete(admin, await Adjust(actor, -1));

        Assert.Equal(new[] { 1L, 2L, 3L, 4L }, await _db.RoomChangedVersions(room));
    }

    [Fact]
    public async Task A_modifier_adjustment_write_that_fails_at_commit_announces_nothing()
    {
        var (actor, admin, room) = await TodayRoomWithTarget();
        var id = await Adjust(actor, 2);
        await _db.FailCommitsThatBroadcast();

        await Assert.ThrowsAsync<PostgresException>(() => Adjust(actor, 1));
        await Assert.ThrowsAsync<PostgresException>(() => Undo(actor, id));
        await Assert.ThrowsAsync<PostgresException>(() => AdminDelete(admin, id));

        Assert.Equal(new[] { 1L }, await _db.RoomChangedVersions(room));
        Assert.Equal(2, await _db.Scalar<int>($"select modifier from public.room_players where room_id = '{room}'"));
    }

    // Hosted realtime.send catches every failure and RAISEs a WARNING instead (ADR 0011).
    private Task SwallowSends() => _db.Execute("""
        create or replace function realtime.send(payload jsonb, event text, topic text, private boolean default true)
        returns void language plpgsql as $f$
        begin raise warning 'ErrorSendingBroadcastMessage: boom'; end $f$;
        """);

    [Fact]
    public async Task A_swallowed_send_still_saves_seats_orders_and_adjustments()
    {
        var (u, room, round) = await OpenRound();
        var (actor, _, today) = await TodayRoomWithTarget();
        await SwallowSends();

        await Order(u, round, "tea");
        await Adjust(actor, 2);
        await Enter(await _db.AddUser("vw-late"));

        Assert.Equal(1L, await _db.Scalar<long>("select count(*) from public.orders"));
        Assert.Equal(1L, await Version(room));
        Assert.Equal(2, await _db.Scalar<int>($"select modifier from public.room_players where room_id = '{today}' and player_id = 'vw-actor'"));
        Assert.Equal(1L, await _db.Scalar<long>($"select count(*) from public.room_players where room_id = '{today}' and player_id = 'vw-late'"));
        Assert.Equal(2L, await Version(today));
        Assert.Equal(0L, await _db.Messages());
    }

    [Fact]
    public async Task A_swallowed_send_rolls_a_backfill_back()
    {
        var (_, admin, today) = await TodayRoomWithTarget();
        await _db.AddUser("vw-b");
        await SwallowSends();

        var ex = await Assert.ThrowsAsync<ProblemException>(() => RoundBackfillRules.Run(_store, CallerOf(admin),
            new BackfillRequest(["vw-actor", "vw-b"], [[new BackfillEntry("vw-actor", 3), new BackfillEntry("vw-b", 12)]])));

        Assert.Equal("broadcast_failed", ex.Code);
        Assert.Equal(0L, await _db.Scalar<long>("select count(*) from public.rounds"));
        Assert.Equal(0L, await Version(today));
    }
}
