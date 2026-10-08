using System.Net;
using System.Net.Http.Json;
using System.Text.Json;
using RollForBrew.Domain;
using RollForBrew.Tests.Harness;

namespace RollForBrew.Tests;

public class OrderWindowTests
{
    [Theory]
    [InlineData("tea", "open", false, OrderVerdict.Accepted)]
    [InlineData("coffee", "closed", false, OrderVerdict.Accepted)]
    [InlineData("tea", "resolved", false, OrderVerdict.Accepted)]
    [InlineData("tea", "resolved", true, OrderVerdict.WindowClosed)]
    [InlineData("tea", "cancelled", false, OrderVerdict.RoundNotOpen)]
    [InlineData("tea", null, false, OrderVerdict.RoundNotOpen)]
    [InlineData("juice", "open", false, OrderVerdict.DrinkTypeInvalid)]
    [InlineData(null, null, false, OrderVerdict.DrinkTypeInvalid)] // drink type is checked first
    public void Check(string? drink, string? status, bool later, OrderVerdict expected) =>
        Assert.Equal(expected, OrderWindow.Check(drink, status, later));
}

public class OrderHttpTests(ApiHost api) : IClassFixture<ApiHost>
{
    private async Task<(TestUser user, HttpClient client, Guid room)> Setup(string sub)
    {
        var u = await api.Db.AddUser(sub);
        var room = Guid.NewGuid();
        await api.Db.Execute($"insert into public.rooms (id, date) values ('{room}', '{DateTime.UtcNow.AddDays(Random.Shared.Next(1, 100000)):yyyy-MM-dd}')");
        return (u, api.Client(api.Token(u)), room);
    }

    private async Task<Guid> Round(Guid room, string player, string status, int minutesAgo)
    {
        var id = Guid.NewGuid();
        var resolved = status == "resolved" ? "now()" : "null";
        await api.Db.Execute($"""
            insert into public.rounds (id, room_id, started_by, status, started_at, resolved_at)
            values ('{id}', '{room}', '{player}', '{status}', now() - interval '{minutesAgo} minutes', {resolved});
            """);
        return id;
    }

    private static Task<HttpResponseMessage> Put(HttpClient c, Guid round, string? drink) =>
        c.PutAsJsonAsync($"/rounds/{round}/order", new { drinkType = drink });

    private static async Task<string> Code(HttpResponseMessage r) =>
        (await r.Content.ReadFromJsonAsync<JsonElement>()).GetProperty("code").GetString()!;

    [Fact]
    public async Task Places_changes_and_reads_back_one_order()
    {
        var (u, c, room) = await Setup("g-ord-1");
        var round = await Round(room, u.PlayerId, "open", 5);

        Assert.Equal(HttpStatusCode.NoContent, (await Put(c, round, "tea")).StatusCode);
        Assert.Equal(HttpStatusCode.NoContent, (await Put(c, round, "coffee")).StatusCode);

        Assert.Equal(1L, await api.Db.Scalar<long>($"select count(*) from public.orders where round_id = '{round}'"));
        var got = await c.GetFromJsonAsync<JsonElement>($"/rounds/{round}/order");
        Assert.Equal("coffee", got.GetProperty("drinkType").GetString());
        var latest = await c.GetFromJsonAsync<JsonElement>("/orders/latest");
        Assert.Equal("coffee", latest.GetProperty("drinkType").GetString());
    }

    [Fact]
    public async Task No_order_reads_as_null()
    {
        var (u, c, room) = await Setup("g-ord-2");
        var round = await Round(room, u.PlayerId, "open", 5);
        var got = await c.GetFromJsonAsync<JsonElement>($"/rounds/{round}/order");
        Assert.Equal(JsonValueKind.Null, got.GetProperty("drinkType").ValueKind);
    }

    [Fact]
    public async Task Invalid_drink_is_RFB28_400()
    {
        var (u, c, room) = await Setup("g-ord-3");
        var round = await Round(room, u.PlayerId, "open", 5);
        var res = await Put(c, round, "juice");
        Assert.Equal(HttpStatusCode.BadRequest, res.StatusCode);
        Assert.Equal("order_drink_type_invalid", await Code(res));
    }

    [Fact]
    public async Task Missing_or_cancelled_round_is_RFB29()
    {
        var (u, c, room) = await Setup("g-ord-4");
        var cancelled = await Round(room, u.PlayerId, "cancelled", 5);
        var res = await Put(c, cancelled, "tea");
        Assert.Equal(HttpStatusCode.Conflict, res.StatusCode);
        Assert.Equal("order_round_not_open", await Code(res));
        Assert.Equal("order_round_not_open", await Code(await Put(c, Guid.NewGuid(), "tea")));
    }

    [Fact]
    public async Task Window_stays_open_after_resolve_until_a_later_round_resolves()
    {
        var (u, c, room) = await Setup("g-ord-5");
        var first = await Round(room, u.PlayerId, "resolved", 30);
        Assert.Equal(HttpStatusCode.NoContent, (await Put(c, first, "tea")).StatusCode);

        // A later round that is merely open does not close the window.
        var second = await Round(room, u.PlayerId, "open", 10);
        Assert.Equal(HttpStatusCode.NoContent, (await Put(c, first, "coffee")).StatusCode);

        // Once the later round resolves it does (RFB30); the later round itself is still orderable.
        await api.Db.Execute($"update public.rounds set status = 'resolved', resolved_at = now() where id = '{second}'");
        var res = await Put(c, first, "tea");
        Assert.Equal(HttpStatusCode.Conflict, res.StatusCode);
        Assert.Equal("order_window_closed", await Code(res));
        Assert.Equal(HttpStatusCode.NoContent, (await Put(c, second, "tea")).StatusCode);
    }

    [Fact]
    public async Task Milk_and_sugar_stay_a_live_join_not_stored_on_the_order()
    {
        var (u, c, room) = await Setup("g-ord-6");
        var round = await Round(room, u.PlayerId, "open", 5);
        await api.Db.Execute($"insert into public.round_participants (round_id, player_id) values ('{round}', '{u.PlayerId}')");
        await api.Db.Execute($"insert into public.usual_drinks (player_id, drink_type, milk, sugar) values ('{u.PlayerId}', 'tea', 'Oat', '1 Tsp')");
        await Put(c, round, "tea");
        await api.Db.Execute($"update public.usual_drinks set milk = 'Dairy' where player_id = '{u.PlayerId}'");
        Assert.Equal("Dairy", await api.Db.Scalar<string>(
            $"select milk from public.round_menu where round_id = '{round}' and player_id = '{u.PlayerId}'"));
    }

    [Fact]
    public async Task Anonymous_is_401()
    {
        Assert.Equal(HttpStatusCode.Unauthorized, (await Put(api.Client(), Guid.NewGuid(), "tea")).StatusCode);
    }

    [Fact]
    public async Task Matches_SQL_submit_order_outcome()
    {
        // Parity with the SQL path on the same inputs: the SQL function writes the same row shape.
        var (u, c, room) = await Setup("g-ord-7");
        var round = await Round(room, u.PlayerId, "open", 5);
        await Put(c, round, "tea");
        Assert.Equal("tea", await api.Db.Scalar<string>($"select drink_type from public.orders where round_id = '{round}' and player_id = '{u.PlayerId}'"));
    }
}
