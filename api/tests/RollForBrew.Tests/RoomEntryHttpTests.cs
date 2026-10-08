using System.Net;
using System.Net.Http.Json;
using System.Text.Json;
using RollForBrew.Tests.Harness;

namespace RollForBrew.Tests;

public class RoomEntryHttpTests(ApiHost api) : IClassFixture<ApiHost>
{
    private const string Today = "(now() at time zone 'Europe/London')::date";

    private Task<HttpResponseMessage> Enter(TestUser u) =>
        api.Client(api.Token(u)).PostAsync("/rooms/today/entry", null);

    private Task<HttpResponseMessage> SetAs(TestUser u, string? target) =>
        api.Client(api.Token(u)).PutAsJsonAsync("/acting-as", new { targetPlayerId = target });

    [Fact]
    public async Task Enter_requires_a_token()
    {
        var res = await api.Client().PostAsync("/rooms/today/entry", null);
        Assert.Equal(HttpStatusCode.Unauthorized, res.StatusCode);
        Assert.Equal("application/problem+json", res.Content.Headers.ContentType?.MediaType);
    }

    [Fact]
    public async Task Enter_creates_todays_room_and_the_callers_seat_and_is_idempotent()
    {
        var a = await api.Db.AddUser("re-a");
        var b = await api.Db.AddUser("re-b");

        var r1 = await Enter(a);
        Assert.Equal(HttpStatusCode.OK, r1.StatusCode);
        var id1 = (await r1.Content.ReadFromJsonAsync<JsonElement>()).GetProperty("roomId").GetGuid();
        var id2 = (await (await Enter(a)).Content.ReadFromJsonAsync<JsonElement>()).GetProperty("roomId").GetGuid();
        var id3 = (await (await Enter(b)).Content.ReadFromJsonAsync<JsonElement>()).GetProperty("roomId").GetGuid();

        Assert.Equal(id1, id2);
        Assert.Equal(id1, id3);
        Assert.Equal(1, await api.Db.Scalar<long>($"select count(*) from public.rooms where date = {Today} and not is_test"));
        Assert.Equal(1, await api.Db.Scalar<long>($"select count(*) from public.room_players where room_id = '{id1}' and player_id = 're-a'"));
        Assert.Equal(1, await api.Db.Scalar<long>($"select count(*) from public.room_players where room_id = '{id1}' and player_id = 're-b'"));
    }

    [Fact]
    public async Task Enter_returns_the_same_room_the_SQL_function_returns()
    {
        var u = await api.Db.AddUser("re-parity");
        var viaApi = (await (await Enter(u)).Content.ReadFromJsonAsync<JsonElement>()).GetProperty("roomId").GetGuid();
        var viaSql = await api.Db.Scalar<Guid>($"select id from public.rooms where date = {Today} and not is_test");
        Assert.Equal(viaSql, viaApi);
    }

    [Fact]
    public async Task Set_requires_a_token()
    {
        var res = await api.Client().PutAsJsonAsync("/acting-as", new { targetPlayerId = "x" });
        Assert.Equal(HttpStatusCode.Unauthorized, res.StatusCode);
    }

    [Fact]
    public async Task Non_admin_cannot_set_acting_as_and_nothing_is_written()
    {
        var u = await api.Db.AddUser("sa-plain");
        await api.Db.AddUser("sa-plain-target");
        var res = await SetAs(u, "sa-plain-target");
        Assert.Equal(HttpStatusCode.Forbidden, res.StatusCode);
        Assert.Equal("admin_required_set_acting_as", (await res.Content.ReadFromJsonAsync<JsonElement>()).GetProperty("code").GetString());
        Assert.Equal(0, await api.Db.Scalar<long>("select count(*) from public.admin_acting_as where admin_player_id = 'sa-plain'"));
    }

    [Fact]
    public async Task Admin_sets_changes_and_clears_the_pointer()
    {
        var admin = await api.Db.AddUser("sa-admin", admin: true);
        await api.Db.AddUser("sa-t1");
        await api.Db.AddUser("sa-t2");

        Assert.Equal(HttpStatusCode.NoContent, (await SetAs(admin, "sa-t1")).StatusCode);
        Assert.Equal("sa-t1", await api.Db.Scalar<string>("select acting_as_player_id from public.admin_acting_as where admin_player_id = 'sa-admin'"));
        Assert.Equal(HttpStatusCode.NoContent, (await SetAs(admin, "sa-t2")).StatusCode);
        Assert.Equal("sa-t2", await api.Db.Scalar<string>("select acting_as_player_id from public.admin_acting_as where admin_player_id = 'sa-admin'"));

        // Picking yourself clears it, exactly like SQL nullif(target, caller).
        Assert.Equal(HttpStatusCode.NoContent, (await SetAs(admin, "sa-admin")).StatusCode);
        Assert.Null(await api.Db.Scalar<string>("select acting_as_player_id from public.admin_acting_as where admin_player_id = 'sa-admin'"));

        // And GET /acting-as reads back what PUT wrote.
        await SetAs(admin, "sa-t1");
        var get = await api.Client(api.Token(admin)).GetAsync("/acting-as");
        Assert.Equal("sa-t1", (await get.Content.ReadFromJsonAsync<JsonElement>()).GetProperty("actingAsPlayerId").GetString());
    }

    [Fact]
    public async Task Unknown_target_is_404_and_leaves_the_pointer_alone()
    {
        var admin = await api.Db.AddUser("sa-admin-404", admin: true);
        await api.Db.AddUser("sa-keep");
        await SetAs(admin, "sa-keep");
        var res = await SetAs(admin, "nobody-here");
        Assert.Equal(HttpStatusCode.NotFound, res.StatusCode);
        Assert.Equal("acting_as_target_not_found", (await res.Content.ReadFromJsonAsync<JsonElement>()).GetProperty("code").GetString());
        Assert.Equal("sa-keep", await api.Db.Scalar<string>("select acting_as_player_id from public.admin_acting_as where admin_player_id = 'sa-admin-404'"));
    }

    [Fact]
    public async Task A_null_target_clears_the_pointer()
    {
        var admin = await api.Db.AddUser("sa-admin-null", admin: true);
        await api.Db.AddUser("sa-nt");
        await SetAs(admin, "sa-nt");
        Assert.Equal(HttpStatusCode.NoContent, (await SetAs(admin, null)).StatusCode);
        Assert.Null(await api.Db.Scalar<string>("select acting_as_player_id from public.admin_acting_as where admin_player_id = 'sa-admin-null'"));
    }

    [Fact]
    public async Task The_pointer_only_acts_in_the_Test_Room_never_in_a_real_room()
    {
        // ADR 0001 / 0002: the override is the resolver's job. A set pointer must not change who a real room sees.
        var admin = await api.Db.AddUser("sa-admin-room", admin: true);
        await api.Db.AddUser("sa-room-target");
        await SetAs(admin, "sa-room-target");
        var realRoom = (await (await Enter(admin)).Content.ReadFromJsonAsync<JsonElement>()).GetProperty("roomId").GetGuid();
        var testRoom = await api.Db.Scalar<Guid>("select id from public.rooms where is_test limit 1");

        Assert.Equal("sa-admin-room", await ScalarAsClaims(admin, realRoom));
        Assert.Equal("sa-room-target", await ScalarAsClaims(admin, testRoom));
    }

    private async Task<string?> ScalarAsClaims(TestUser u, Guid room)
    {
        await using var conn = new Npgsql.NpgsqlConnection(api.Db.AdminConnectionString);
        await conn.OpenAsync();
        await using var tx = await conn.BeginTransactionAsync();
        await using (var set = new Npgsql.NpgsqlCommand("select set_config('request.jwt.claims', @c, true)", conn, tx))
        {
            set.Parameters.AddWithValue("c", $$"""{"sub":"{{u.AuthId}}","role":"authenticated"}""");
            await set.ExecuteNonQueryAsync();
        }
        await using var fn = new Npgsql.NpgsqlCommand($"select public.current_player_id(null, '{room}')", conn, tx);
        return (string?)await fn.ExecuteScalarAsync();
    }
}
