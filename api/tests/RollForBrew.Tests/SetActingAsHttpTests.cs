using System.Net;
using System.Net.Http.Json;
using System.Text.Json;
using Npgsql;
using RollForBrew.Tests.Harness;

namespace RollForBrew.Tests;

public class SetActingAsHttpTests(ApiHost api) : IClassFixture<ApiHost>
{
    private Task<HttpResponseMessage> Set(TestUser u, string? target) =>
        api.Client(api.Token(u)).PutAsJsonAsync("/acting-as", new { targetPlayerId = target });

    private Task<string?> Pointer(string adminId) =>
        api.Db.Scalar<string>($"select acting_as_player_id from public.admin_acting_as where admin_player_id = '{adminId}'");

    private Task<long> PointerRows(string adminId) =>
        api.Db.Scalar<long>($"select count(*) from public.admin_acting_as where admin_player_id = '{adminId}'");

    private async Task<string> Code(HttpResponseMessage res)
    {
        Assert.Equal("application/problem+json", res.Content.Headers.ContentType?.MediaType);
        return (await res.Content.ReadFromJsonAsync<JsonElement>()).GetProperty("code").GetString()!;
    }

    private async Task<string?> Viewer(TestUser u, Guid room)
    {
        var res = await api.Client(api.Token(u)).GetAsync($"/rooms/{room}/view");
        Assert.Equal(HttpStatusCode.OK, res.StatusCode);
        return (await res.Content.ReadFromJsonAsync<JsonElement>()).GetProperty("viewer").GetProperty("playerId").GetString();
    }

    private async Task<Guid> RealRoom()
    {
        var id = Guid.NewGuid();
        await api.Db.Execute($"insert into public.rooms (id, date) values ('{id}', date '2001-01-01' + (random() * 8000)::int)");
        return id;
    }

    private Task<Guid> TestRoom() =>
        api.Db.Scalar<Guid>("select id from public.rooms where is_test and date is null limit 1");

    private Task Seat(Guid room, string playerId) =>
        api.Db.Execute($"insert into public.room_players (room_id, player_id) values ('{room}', '{playerId}')");

    private Task SetViaSql(TestUser u, string? target) => api.Db.AsCaller(u, async (conn, tx) =>
    {
        await using var fn = new NpgsqlCommand("select public.set_acting_as(@t)", conn, tx);
        fn.Parameters.Add(new NpgsqlParameter("t", NpgsqlTypes.NpgsqlDbType.Text) { Value = (object?)target ?? DBNull.Value });
        return await fn.ExecuteNonQueryAsync();
    });

    [Fact]
    public async Task Set_requires_a_token()
    {
        var res = await api.Client().PutAsJsonAsync("/acting-as", new { targetPlayerId = "x" });
        Assert.Equal(HttpStatusCode.Unauthorized, res.StatusCode);
    }

    [Fact]
    public async Task Non_admin_is_refused_and_nothing_is_written()
    {
        var plain = await api.Db.AddUser("sa-plain");
        await api.Db.AddUser("sa-plain-target");

        var res = await Set(plain, "sa-plain-target");

        Assert.Equal(HttpStatusCode.Forbidden, res.StatusCode);
        Assert.Equal("admin_required_set_acting_as", await Code(res));
        Assert.Equal(0, await PointerRows("sa-plain"));
    }

    [Fact]
    public async Task The_admin_check_comes_before_the_target_check()
    {
        var plain = await api.Db.AddUser("sa-plain-order");

        var res = await Set(plain, "nobody-here");

        Assert.Equal(HttpStatusCode.Forbidden, res.StatusCode);
    }

    [Fact]
    public async Task Admin_sets_changes_and_reads_back_the_pointer()
    {
        var admin = await api.Db.AddUser("sa-admin", admin: true);
        await api.Db.AddUser("sa-t1");
        await api.Db.AddUser("sa-t2");

        Assert.Equal(HttpStatusCode.NoContent, (await Set(admin, "sa-t1")).StatusCode);
        Assert.Equal("sa-t1", await Pointer("sa-admin"));

        Assert.Equal(HttpStatusCode.NoContent, (await Set(admin, "sa-t2")).StatusCode);
        Assert.Equal("sa-t2", await Pointer("sa-admin"));

        var get = await api.Client(api.Token(admin)).GetAsync("/acting-as");
        Assert.Equal("sa-t2", (await get.Content.ReadFromJsonAsync<JsonElement>()).GetProperty("actingAsPlayerId").GetString());
    }

    [Fact]
    public async Task Picking_yourself_or_null_clears_the_pointer_but_keeps_the_row()
    {
        var admin = await api.Db.AddUser("sa-clear", admin: true);
        await api.Db.AddUser("sa-clear-t");

        await Set(admin, "sa-clear-t");
        Assert.Equal(HttpStatusCode.NoContent, (await Set(admin, "sa-clear")).StatusCode);
        Assert.Null(await Pointer("sa-clear"));
        Assert.Equal(1, await PointerRows("sa-clear"));

        await Set(admin, "sa-clear-t");
        Assert.Equal(HttpStatusCode.NoContent, (await Set(admin, null)).StatusCode);
        Assert.Null(await Pointer("sa-clear"));
        Assert.Equal(1, await PointerRows("sa-clear"));
    }

    [Fact]
    public async Task Unknown_target_is_404_and_leaves_the_pointer_alone()
    {
        var admin = await api.Db.AddUser("sa-404", admin: true);
        await api.Db.AddUser("sa-keep");
        await Set(admin, "sa-keep");

        var res = await Set(admin, "nobody-here");

        Assert.Equal(HttpStatusCode.NotFound, res.StatusCode);
        Assert.Equal("acting_as_target_not_found", await Code(res));
        Assert.Equal("sa-keep", await Pointer("sa-404"));
    }

    [Theory]
    [InlineData("target")]
    [InlineData("self")]
    [InlineData("null")]
    public async Task Same_pointer_as_the_SQL_function(string pick)
    {
        var viaApi = await api.Db.AddUser($"sa-p-api-{pick}", admin: true);
        var viaSql = await api.Db.AddUser($"sa-p-sql-{pick}", admin: true);
        await api.Db.AddUser($"sa-p-t-{pick}");
        string? For(TestUser u) => pick switch { "target" => $"sa-p-t-{pick}", "self" => u.PlayerId, _ => null };

        Assert.Equal(HttpStatusCode.NoContent, (await Set(viaApi, For(viaApi))).StatusCode);
        await SetViaSql(viaSql, For(viaSql));

        Assert.Equal(await Pointer(viaSql.PlayerId), await Pointer(viaApi.PlayerId));
        Assert.Equal(await PointerRows(viaSql.PlayerId), await PointerRows(viaApi.PlayerId));
    }

    [Fact]
    public async Task The_SQL_function_and_the_endpoint_refuse_the_same_non_admin()
    {
        var plain = await api.Db.AddUser("sa-parity-plain");
        await Assert.ThrowsAsync<PostgresException>(() => SetViaSql(plain, null));
        Assert.Equal(HttpStatusCode.Forbidden, (await Set(plain, null)).StatusCode);
    }

    [Fact]
    public async Task The_acting_admin_stays_themselves_when_changing_the_pointer()
    {
        // ADR 0001: the override never applies outside a room, so a puppeting admin is still the admin here.
        var admin = await api.Db.AddUser("sa-still-admin", admin: true);
        await api.Db.AddUser("sa-puppet");
        await api.Db.AddUser("sa-puppet-2");
        await Set(admin, "sa-puppet");

        Assert.Equal(HttpStatusCode.NoContent, (await Set(admin, "sa-puppet-2")).StatusCode);

        Assert.Equal("sa-puppet-2", await Pointer("sa-still-admin"));
        Assert.Equal(0, await PointerRows("sa-puppet"));
    }

    [Fact]
    public async Task The_pointer_acts_in_the_Test_Room_and_never_in_a_real_room()
    {
        var admin = await api.Db.AddUser("sa-rooms", admin: true);
        await api.Db.AddUser("sa-rooms-target");
        var real = await RealRoom();
        var test = await TestRoom();
        await Seat(real, "sa-rooms");
        await Seat(test, "sa-rooms-target");

        Assert.Equal("sa-rooms", await Viewer(admin, test));

        await Set(admin, "sa-rooms-target");

        Assert.Equal("sa-rooms-target", await Viewer(admin, test));
        Assert.Equal("sa-rooms", await Viewer(admin, real));

        await Set(admin, "sa-rooms");
        Assert.Equal("sa-rooms", await Viewer(admin, test));
    }

    [Fact]
    public async Task A_demoted_admin_can_neither_set_nor_use_a_stale_pointer()
    {
        var admin = await api.Db.AddUser("sa-demoted", admin: true);
        await api.Db.AddUser("sa-demoted-target");
        var test = await TestRoom();
        await Seat(test, "sa-demoted");
        await Seat(test, "sa-demoted-target");
        await Set(admin, "sa-demoted-target");
        Assert.Equal("sa-demoted-target", await Viewer(admin, test));
        await api.Db.Execute("update public.players set is_admin = false where id = 'sa-demoted'");

        Assert.Equal(HttpStatusCode.Forbidden, (await Set(admin, null)).StatusCode);
        Assert.Equal("sa-demoted", await Viewer(admin, test));
    }

    [Fact]
    public async Task The_admin_comes_from_the_token_never_from_client_input()
    {
        var admin = await api.Db.AddUser("sa-own", admin: true);
        var other = await api.Db.AddUser("sa-other", admin: true);
        await api.Db.AddUser("sa-own-target");
        var client = api.Client(api.Token(admin));
        client.DefaultRequestHeaders.Add("X-Admin-Player-Id", other.PlayerId);

        var res = await client.PutAsJsonAsync($"/acting-as?adminPlayerId={other.PlayerId}",
            new { targetPlayerId = "sa-own-target", adminPlayerId = other.PlayerId });

        Assert.Equal(HttpStatusCode.NoContent, res.StatusCode);
        Assert.Equal("sa-own-target", await Pointer("sa-own"));
        Assert.Equal(0, await PointerRows("sa-other"));
    }

    [Fact]
    public async Task Concurrent_first_sets_by_one_admin_all_succeed()
    {
        var admin = await api.Db.AddUser("sa-race", admin: true);
        await api.Db.AddUser("sa-race-t");

        var results = await Task.WhenAll(Enumerable.Range(0, 5).Select(_ => Set(admin, "sa-race-t")));

        Assert.All(results, r => Assert.Equal(HttpStatusCode.NoContent, r.StatusCode));
        Assert.Equal(1, await PointerRows("sa-race"));
    }

    [Fact]
    public async Task User_with_no_auth_row_gets_a_problem_not_raw_sqlstate()
    {
        var res = await Set(new TestUser(Guid.NewGuid(), "sa-ghost"), null);
        var body = await res.Content.ReadAsStringAsync();

        Assert.Equal(HttpStatusCode.InternalServerError, res.StatusCode);
        Assert.Contains("internal_error", body);
        Assert.DoesNotContain("current_player_id", body);
    }
}
