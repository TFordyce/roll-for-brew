using Npgsql;
using RollForBrew.Api.Auth;
using RollForBrew.Api.Data;
using RollForBrew.Api.Problems;
using RollForBrew.Tests.Harness;

namespace RollForBrew.Tests;

public class RoomStoreTests : IAsyncLifetime
{
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

    private static Caller CallerFor(TestUser u) => new(u.AuthId.ToString(), $$"""{"sub":"{{u.AuthId}}","role":"authenticated"}""");

    [Fact]
    public void Pooler_settings_are_forced_whatever_the_configured_string_says()
    {
        var cs = RoomStore.ApplyPoolerSettings("Host=h;Username=u;Max Auto Prepare=20;Multiplexing=true;Maximum Pool Size=100;No Reset On Close=false");
        var b = new NpgsqlConnectionStringBuilder(cs);
        Assert.Equal(0, b.MaxAutoPrepare);
        Assert.True(b.NoResetOnClose);
        Assert.False(b.Multiplexing);
        Assert.Equal(5, b.MaxPoolSize);
    }

    [Fact]
    public async Task Claims_reach_bridged_sql_so_current_player_id_resolves_the_google_sub()
    {
        var u = await _db.AddUser("g-claims");
        var id = await _store.Read(CallerFor(u), s => s.CurrentPlayerId());
        Assert.Equal("g-claims", id);
    }

    [Fact]
    public async Task Claims_do_not_leak_to_the_next_touch_on_the_same_pooled_connection()
    {
        var u = await _db.AddUser("g-leak");
        await _store.Read(CallerFor(u), s => s.CurrentPlayerId());

        await using var conn = await _ds.OpenConnectionAsync();
        await using var cmd = new NpgsqlCommand("select coalesce(current_setting('request.jwt.claims', true), '')", conn);
        Assert.Equal("", (string?)await cmd.ExecuteScalarAsync());
    }

    [Fact]
    public async Task Read_is_read_only()
    {
        var u = await _db.AddUser("g-ro");
        var ex = await Assert.ThrowsAsync<PostgresException>(() => _store.Read(CallerFor(u), async s =>
        {
            await using var cmd = new NpgsqlCommand("insert into public.admin_acting_as (admin_player_id) values ('g-ro')", s.Connection, s.Transaction);
            return await cmd.ExecuteNonQueryAsync();
        }));
        Assert.Equal("25006", ex.SqlState);
    }

    [Fact]
    public async Task Filler_commits_through_ef_on_the_same_transaction()
    {
        var u = await _db.AddUser("g-fill", admin: true);
        await _store.Filler(CallerFor(u), async s =>
        {
            s.Db.AdminActingAs.Add(new AdminActingAs { AdminPlayerId = "g-fill", ActingAsPlayerId = null });
            await s.Db.SaveChangesAsync();
            return 0;
        });
        Assert.Equal(1L, await _db.Scalar<long>("select count(*) from public.admin_acting_as where admin_player_id = 'g-fill'"));
    }

    [Fact]
    public async Task Filler_rolls_back_when_the_work_throws()
    {
        var u = await _db.AddUser("g-roll", admin: true);
        await Assert.ThrowsAsync<InvalidOperationException>(() => _store.Filler<int>(CallerFor(u), async s =>
        {
            s.Db.AdminActingAs.Add(new AdminActingAs { AdminPlayerId = "g-roll" });
            await s.Db.SaveChangesAsync();
            throw new InvalidOperationException("boom");
        }));
        Assert.Equal(0L, await _db.Scalar<long>("select count(*) from public.admin_acting_as where admin_player_id = 'g-roll'"));
    }

    [Fact]
    public async Task Sql_raised_rfb_is_translated_to_its_named_problem()
    {
        await _db.Execute("""
            create function public.test_raise_rfb() returns void language plpgsql as $f$
            begin raise exception 'round is closed' using errcode = 'RFB01', detail = 'extra'; end $f$;
            grant execute on function public.test_raise_rfb() to rfb_api;
            """);
        var u = await _db.AddUser("g-rfb");
        var ex = await Assert.ThrowsAsync<ProblemException>(() => _store.Filler(CallerFor(u), async s =>
        {
            await using var cmd = new NpgsqlCommand("select public.test_raise_rfb()", s.Connection, s.Transaction);
            await cmd.ExecuteNonQueryAsync();
            return 0;
        }));
        Assert.Equal("round_not_open_for_rolling", ex.Code);
        Assert.Equal(409, ex.Status);
    }

    [Fact]
    public async Task Non_rfb_postgres_errors_pass_through_unmapped()
    {
        var u = await _db.AddUser("g-other");
        await Assert.ThrowsAsync<PostgresException>(() => _store.Read(CallerFor(u), async s =>
        {
            await using var cmd = new NpgsqlCommand("select 1/0", s.Connection, s.Transaction);
            return await cmd.ExecuteScalarAsync();
        }));
    }
}
