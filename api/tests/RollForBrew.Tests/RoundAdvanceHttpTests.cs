using System.Net;
using System.Net.Http.Json;
using System.Text.Json;
using RollForBrew.Tests.Harness;

namespace RollForBrew.Tests;

/// <summary>
/// Seam 3 for the evaluator shadow (#546): the endpoints validate the JWT, resolve
/// the actor server-side (the request carries no player identity at all), return
/// SQL's payload unchanged, and speak problem+json on failure.
/// </summary>
public class RoundAdvanceHttpTests(ApiHost api) : IClassFixture<ApiHost>
{
    private static async Task<JsonElement> Problem(HttpResponseMessage res)
    {
        Assert.Equal("application/problem+json", res.Content.Headers.ContentType?.MediaType);
        var json = await res.Content.ReadFromJsonAsync<JsonElement>();
        Assert.True(json.TryGetProperty("code", out _));
        Assert.True(json.TryGetProperty("title", out _));
        Assert.Equal((int)res.StatusCode, json.GetProperty("status").GetInt32());
        return json;
    }

    [Fact]
    public async Task Missing_token_is_401_problem()
    {
        var res = await api.Client().PostAsync($"/rounds/{Guid.NewGuid()}/advance", null);
        Assert.Equal(HttpStatusCode.Unauthorized, res.StatusCode);
        Assert.Equal("unauthenticated", (await Problem(res)).GetProperty("code").GetString());
    }

    [Fact]
    public async Task Garbage_token_is_401_problem()
    {
        var res = await api.Client("not-a-jwt").PostAsync($"/rounds/{Guid.NewGuid()}/finalize", null);
        Assert.Equal(HttpStatusCode.Unauthorized, res.StatusCode);
        await Problem(res);
    }

    [Fact]
    public async Task Advance_on_a_missing_round_returns_sqls_noop_payload()
    {
        var u = await api.Db.AddUser("g-adv-http");
        var res = await api.Client(api.Token(u)).PostAsync($"/rounds/{Guid.NewGuid()}/advance", null);
        Assert.Equal(HttpStatusCode.OK, res.StatusCode);
        var payload = await res.Content.ReadFromJsonAsync<JsonElement>();
        Assert.Equal("noop", payload.GetProperty("outcome").GetString());
        Assert.Equal("round_not_found", payload.GetProperty("reason").GetString());
    }

    [Fact]
    public async Task Finalize_runs_the_shadow_bridge_and_passes_sqls_outcome_through()
    {
        var u = await api.Db.AddUser("g-adv-fin");
        var round = await SeedFinalizableRound("g-adv-fin", "g-adv-fin-2");
        var res = await api.Client(api.Token(u)).PostAsync($"/rounds/{round}/finalize", null);
        Assert.Equal(HttpStatusCode.OK, res.StatusCode);
        var payload = await res.Content.ReadFromJsonAsync<JsonElement>();
        Assert.Equal("brewer", payload.GetProperty("outcome").GetString());
        Assert.Equal("g-adv-fin-2", payload.GetProperty("brewer_id").GetString()); // the lowest total brews
        Assert.Equal("g-adv-fin-2", await api.Db.Scalar<string>($"select brewer_id from public.rounds where id = '{round}'"));
    }

    [Fact]
    public async Task Advance_finalizes_when_the_window_already_closed()
    {
        var u = await api.Db.AddUser("g-adv-adv");
        var round = await SeedFinalizableRound("g-adv-adv", "g-adv-adv-2");
        var res = await api.Client(api.Token(u)).PostAsync($"/rounds/{round}/advance", null);
        Assert.Equal(HttpStatusCode.OK, res.StatusCode);
        var payload = await res.Content.ReadFromJsonAsync<JsonElement>();
        Assert.Equal("brewer", payload.GetProperty("outcome").GetString());
    }

    private async Task<Guid> SeedFinalizableRound(string p1, string p2)
    {
        var room = Guid.NewGuid();
        var round = Guid.NewGuid();
        // p1 already exists (AddUser); only p2 is new here.
        await api.Db.Execute($"""
            insert into public.players (id, email) values ('{p2}', '{p2}@example.test');
            insert into public.rooms (id, date) values ('{room}', '{DateTime.UtcNow.AddDays(Random.Shared.Next(1, 100000)):yyyy-MM-dd}');
            insert into public.rounds (id, room_id, started_by, status, started_at, closed_at) values
              ('{round}', '{room}', '{p1}', 'closed', '2026-01-01 09:00+00', '2026-01-01 09:01+00');
            insert into public.round_participants (round_id, player_id) values ('{round}', '{p1}'), ('{round}', '{p2}');
            insert into public.room_players (room_id, player_id, modifier) values ('{room}', '{p1}', 0), ('{room}', '{p2}', 0);
            insert into public.rolls (round_id, player_id, layer, value, input_mode, modifier_snapshot) values
              ('{round}', '{p1}', 0, 17, 'in_app', 0), ('{round}', '{p2}', 0, 6, 'in_app', 0);
            insert into public.spell_reaction_windows (id, round_id, layer, status, poll_round, opened_at, closed_at)
              values ('{Guid.NewGuid()}', '{round}', 0, 'closed', 1, now(), now());
            """);
        return round;
    }
}
