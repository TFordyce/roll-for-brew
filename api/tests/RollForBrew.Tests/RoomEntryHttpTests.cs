using System.Net;
using System.Net.Http.Json;
using System.Text.Json;
using Npgsql;
using RollForBrew.Tests.Harness;

namespace RollForBrew.Tests;

public class RoomEntryHttpTests(ApiHost api) : IClassFixture<ApiHost>
{
    private const string Today = "(now() at time zone 'Europe/London')::date";

    private Task<HttpResponseMessage> Enter(TestUser u) =>
        api.Client(api.Token(u)).PostAsync("/rooms/today/entry", null);

    private async Task<Guid> EnteredRoom(TestUser u)
    {
        var res = await Enter(u);
        Assert.Equal(HttpStatusCode.OK, res.StatusCode);
        return (await res.Content.ReadFromJsonAsync<JsonElement>()).GetProperty("roomId").GetGuid();
    }

    private Task<long> Seats(Guid room, string playerId) =>
        api.Db.Scalar<long>($"select count(*) from public.room_players where room_id = '{room}' and player_id = '{playerId}'");

    private async Task<Guid> EnterViaSql(TestUser u)
    {
        await using var conn = new NpgsqlConnection(api.Db.AdminConnectionString);
        await conn.OpenAsync();
        await using var tx = await conn.BeginTransactionAsync();
        await using (var set = new NpgsqlCommand("select set_config('request.jwt.claims', @c, true)", conn, tx))
        {
            set.Parameters.AddWithValue("c", $$"""{"sub":"{{u.AuthId}}","role":"authenticated"}""");
            await set.ExecuteNonQueryAsync();
        }
        await using var fn = new NpgsqlCommand("select public.enter_todays_room()", conn, tx);
        var id = (Guid)(await fn.ExecuteScalarAsync())!;
        await tx.CommitAsync();
        return id;
    }

    [Fact]
    public async Task Entry_requires_a_token()
    {
        var res = await api.Client().PostAsync("/rooms/today/entry", null);
        Assert.Equal(HttpStatusCode.Unauthorized, res.StatusCode);
        Assert.Equal("application/problem+json", res.Content.Headers.ContentType?.MediaType);
    }

    [Fact]
    public async Task Entry_creates_todays_room_and_seats_the_caller_idempotently()
    {
        var a = await api.Db.AddUser("re-a");
        var b = await api.Db.AddUser("re-b");

        var first = await EnteredRoom(a);
        Assert.Equal(first, await EnteredRoom(a));
        Assert.Equal(first, await EnteredRoom(b));

        Assert.Equal(1, await api.Db.Scalar<long>($"select count(*) from public.rooms where date = {Today} and not is_test"));
        Assert.Equal(first, await api.Db.Scalar<Guid>($"select id from public.rooms where date = {Today} and not is_test"));
        Assert.Equal(1, await Seats(first, "re-a"));
        Assert.Equal(1, await Seats(first, "re-b"));
    }

    [Fact]
    public async Task Entry_and_the_SQL_function_agree_on_the_room_either_way_round()
    {
        var viaApiFirst = await api.Db.AddUser("re-parity-api");
        var viaSqlSecond = await api.Db.AddUser("re-parity-sql");

        var room = await EnteredRoom(viaApiFirst);
        Assert.Equal(room, await EnterViaSql(viaSqlSecond));
        Assert.Equal(room, await EnterViaSql(viaApiFirst));
        Assert.Equal(room, await EnteredRoom(viaSqlSecond));

        Assert.Equal(1, await Seats(room, "re-parity-api"));
        Assert.Equal(1, await Seats(room, "re-parity-sql"));
    }

    [Fact]
    public async Task Entry_keeps_an_existing_seats_modifier()
    {
        var u = await api.Db.AddUser("re-mod");
        var room = await EnteredRoom(u);
        await api.Db.Execute($"update public.room_players set modifier = 3 where room_id = '{room}' and player_id = 're-mod'");

        await EnteredRoom(u);

        Assert.Equal(3, await api.Db.Scalar<int>($"select modifier from public.room_players where room_id = '{room}' and player_id = 're-mod'"));
    }

    [Fact]
    public async Task Concurrent_first_entries_all_land_in_one_room()
    {
        var users = await Task.WhenAll(Enumerable.Range(0, 5).Select(i => api.Db.AddUser($"re-race-{i}")));

        var rooms = await Task.WhenAll(users.Select(EnteredRoom));

        Assert.Single(rooms.Distinct());
    }

    [Fact]
    public async Task An_admin_with_a_pointer_is_seated_as_themselves_never_as_the_target()
    {
        var admin = await api.Db.AddUser("re-admin", admin: true);
        await api.Db.AddUser("re-target");
        await api.Db.Execute("insert into public.admin_acting_as (admin_player_id, acting_as_player_id) values ('re-admin', 're-target')");

        var room = await EnteredRoom(admin);

        Assert.Equal(1, await Seats(room, "re-admin"));
        Assert.Equal(0, await Seats(room, "re-target"));
    }

    [Fact]
    public async Task The_seat_comes_from_the_token_never_from_client_input()
    {
        var u = await api.Db.AddUser("re-honest");
        await api.Db.AddUser("re-spoofed");
        var client = api.Client(api.Token(u));
        client.DefaultRequestHeaders.Add("X-Acting-As", "re-spoofed");

        var res = await client.PostAsJsonAsync("/rooms/today/entry?playerId=re-spoofed", new { playerId = "re-spoofed" });

        Assert.Equal(HttpStatusCode.OK, res.StatusCode);
        var room = (await res.Content.ReadFromJsonAsync<JsonElement>()).GetProperty("roomId").GetGuid();
        Assert.Equal(1, await Seats(room, "re-honest"));
        Assert.Equal(0, await Seats(room, "re-spoofed"));
    }

    [Fact]
    public async Task Entry_never_lands_in_the_Test_Room()
    {
        var u = await api.Db.AddUser("re-not-test");
        var testRoom = await api.Db.Scalar<Guid>("select id from public.rooms where is_test and date is null limit 1");

        Assert.NotEqual(testRoom, await EnteredRoom(u));
        Assert.Equal(0, await Seats(testRoom, "re-not-test"));
    }

    [Fact]
    public async Task User_with_no_auth_row_gets_a_problem_and_nothing_is_written()
    {
        var ghost = new TestUser(Guid.NewGuid(), "re-ghost");
        var res = await Enter(ghost);

        Assert.Equal(HttpStatusCode.InternalServerError, res.StatusCode);
        Assert.Contains("internal_error", await res.Content.ReadAsStringAsync());
        Assert.Equal(0, await api.Db.Scalar<long>("select count(*) from public.room_players where player_id = 're-ghost'"));
    }
}
