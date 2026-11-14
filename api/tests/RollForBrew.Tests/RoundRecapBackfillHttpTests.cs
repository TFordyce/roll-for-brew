using System.Net;
using System.Net.Http.Json;
using System.Text.Json;
using RollForBrew.Tests.Harness;

namespace RollForBrew.Tests;

/// <summary>The HTTP seam for #548: the JWT names the actor, nothing in the request can, and a
/// refusal speaks problem+json with the code and detail the TS wrappers read.</summary>
public class RoundRecapBackfillHttpTests(ApiHost api) : IClassFixture<ApiHost>
{
    private async Task<JsonElement> Problem(HttpResponseMessage res, HttpStatusCode status, string code)
    {
        Assert.Equal(status, res.StatusCode);
        Assert.Equal("application/problem+json", res.Content.Headers.ContentType?.MediaType);
        var json = await res.Content.ReadFromJsonAsync<JsonElement>();
        Assert.Equal(code, json.GetProperty("code").GetString());
        return json;
    }

    private async Task<Guid> SeedRound(string p1, string p2)
    {
        var room = Guid.NewGuid();
        var round = Guid.NewGuid();
        await api.Db.Execute($"""
            insert into public.players (id, email) values ('{p2}', '{p2}@example.test') on conflict do nothing;
            insert into public.rooms (id, date) values ('{room}', '{DateTime.UtcNow.AddDays(Random.Shared.Next(1000, 100000)):yyyy-MM-dd}');
            insert into public.rounds (id, room_id, started_by, status, started_at, closed_at) values
              ('{round}', '{room}', '{p1}', 'closed', '2026-01-01 09:00+00', '2026-01-01 09:01+00');
            insert into public.round_participants (round_id, player_id) values ('{round}', '{p1}'), ('{round}', '{p2}');
            insert into public.room_players (room_id, player_id, modifier) values ('{room}', '{p1}', 0), ('{room}', '{p2}', 0);
            insert into public.rolls (round_id, player_id, layer, value, input_mode, modifier_snapshot) values
              ('{round}', '{p1}', 0, 17, 'in_app', 0), ('{round}', '{p2}', 0, 6, 'in_app', 0);
            """);
        return round;
    }

    [Fact]
    public async Task The_recap_needs_a_token() =>
        await Problem(await api.Client().GetAsync($"/rounds/{Guid.NewGuid()}/recap"), HttpStatusCode.Unauthorized, "unauthenticated");

    [Fact]
    public async Task The_recap_is_never_cached_and_previews_a_ready_round()
    {
        var u = await api.Db.AddUser("g-recap");
        var round = await SeedRound("g-recap", "g-recap-2");
        var res = await api.Client(api.Token(u)).GetAsync($"/rounds/{round}/recap");
        Assert.Equal(HttpStatusCode.OK, res.StatusCode);
        Assert.True(res.Headers.CacheControl?.NoStore);
        var json = await res.Content.ReadFromJsonAsync<JsonElement>();
        Assert.True(json.GetProperty("provisional").GetBoolean());
        Assert.Equal(2, json.GetProperty("players").GetArrayLength());
    }

    [Fact]
    public async Task The_recap_refuses_a_stranger_and_a_missing_round()
    {
        var round = await SeedRound(await PlayerId("g-recap-owner"), "g-recap-owner-2");
        var stranger = await api.Db.AddUser("g-recap-stranger");
        await Problem(await api.Client(api.Token(stranger)).GetAsync($"/rounds/{round}/recap"), HttpStatusCode.Forbidden, "recap_not_in_room");
        await Problem(await api.Client(api.Token(stranger)).GetAsync($"/rounds/{Guid.NewGuid()}/recap"), HttpStatusCode.NotFound, "round_not_found");
    }

    private async Task<string> PlayerId(string sub) => (await api.Db.AddUser(sub)).PlayerId;

    private static object Body(string a, string b, int va, int vb) => new
    {
        participantIds = new[] { a, b },
        layers = new[] { new[] { new { playerId = a, value = va }, new { playerId = b, value = vb } } },
    };

    [Fact]
    public async Task Backfill_needs_a_token() =>
        await Problem(await api.Client().PostAsJsonAsync("/rounds/backfill", Body("a", "b", 5, 12)), HttpStatusCode.Unauthorized, "unauthenticated");

    [Fact]
    public async Task Backfill_refuses_a_non_admin_with_the_message_the_form_shows()
    {
        var u = await api.Db.AddUser("g-bf-pleb");
        var json = await Problem(
            await api.Client(api.Token(u)).PostAsJsonAsync("/rounds/backfill", Body("g-bf-pleb", "g-bf-pleb", 5, 12)),
            HttpStatusCode.Forbidden, "admin_required_backfill");
        Assert.Equal("admin_backfill_round: caller is not an admin", json.GetProperty("detail").GetString());
    }

    [Fact]
    public async Task Backfill_returns_the_round_and_a_bad_layer_is_a_400()
    {
        var u = await api.Db.AddUser("g-bf-admin", admin: true);
        var a = await api.Db.AddUser("g-bf-a");
        var b = await api.Db.AddUser("g-bf-b");
        var client = api.Client(api.Token(u));

        var tied = await Problem(await client.PostAsJsonAsync("/rounds/backfill", Body(a.PlayerId, b.PlayerId, 10, 10)),
            HttpStatusCode.BadRequest, "backfill_layer_still_tied");
        Assert.Equal("admin_backfill_round: layer 0 is still tied — a further layer is required", tied.GetProperty("detail").GetString());

        var res = await client.PostAsJsonAsync("/rounds/backfill", Body(a.PlayerId, b.PlayerId, 5, 12));
        Assert.Equal(HttpStatusCode.OK, res.StatusCode);
        var round = (await res.Content.ReadFromJsonAsync<JsonElement>()).GetProperty("roundId").GetGuid();
        Assert.Equal(a.PlayerId, await api.Db.Scalar<string>($"select brewer_id from public.rounds where id = '{round}'"));
    }
}
