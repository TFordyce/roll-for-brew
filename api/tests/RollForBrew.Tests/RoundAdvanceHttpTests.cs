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

    [Fact]
    public async Task With_the_authority_flag_off_the_shadow_runs_and_nothing_changes_for_players()
    {
        var u = await api.Db.AddUser("g-off");
        var round = await SeedFinalizableRound("g-off", "g-off-2");
        var res = await api.Client(api.Token(u)).PostAsync($"/rounds/{round}/finalize", null);
        var payload = await res.Content.ReadFromJsonAsync<JsonElement>();
        Assert.Equal("brewer", payload.GetProperty("outcome").GetString());
        Assert.False(payload.TryGetProperty("version", out _));
        Assert.Equal(0L, await RoomVersion(round));
        Assert.Equal(0L, await SentFor(round));
    }

    [Fact]
    public async Task A_room_row_makes_c_sharp_authoritative_for_that_room_only()
    {
        var u = await api.Db.AddUser("g-on");
        var round = await SeedFinalizableRound("g-on", "g-on-2");
        var other = await SeedFinalizableRound("g-on", "g-on-3");
        await api.Db.Execute($"insert into public.port_flags (slice, room_id, enabled) select 'advanceRoundAuthoritative', room_id, true from public.rounds where id = '{round}'");

        var res = await api.Client(api.Token(u)).PostAsync($"/rounds/{round}/finalize", null);
        Assert.Equal(HttpStatusCode.OK, res.StatusCode);
        var payload = await res.Content.ReadFromJsonAsync<JsonElement>();
        Assert.Equal("brewer", payload.GetProperty("outcome").GetString());
        Assert.Equal("g-on-2", payload.GetProperty("brewer_id").GetString());
        Assert.Equal(1, payload.GetProperty("version").GetInt64());
        Assert.Equal(1L, await RoomVersion(round));
        Assert.Equal("g-on-2", await api.Db.Scalar<string>($"select brewer_id from public.rounds where id = '{round}'"));
        Assert.Equal(1L, await SentFor(round));
        Assert.Equal("round-revealed", await api.Db.Scalar<string>($"select m.event from realtime.messages m join public.rounds r on m.topic = 'room:' || r.room_id where r.id = '{round}'"));

        var otherRes = await api.Client(api.Token(u)).PostAsync($"/rounds/{other}/finalize", null);
        Assert.False((await otherRes.Content.ReadFromJsonAsync<JsonElement>()).TryGetProperty("version", out _));
        Assert.Equal(0L, await RoomVersion(other));
    }

    [Fact]
    public async Task Rolling_the_flag_back_mid_round_returns_the_next_call_to_the_shadow()
    {
        var u = await api.Db.AddUser("g-back");
        var round = await SeedFinalizableRound("g-back", "g-back-2", v1: 6, v2: 6);
        await api.Db.Execute($"insert into public.port_flags (slice, room_id, enabled) select 'advanceRoundAuthoritative', room_id, true from public.rounds where id = '{round}'");

        var tie = await (await api.Client(api.Token(u)).PostAsync($"/rounds/{round}/finalize", null)).Content.ReadFromJsonAsync<JsonElement>();
        Assert.Equal("tie", tie.GetProperty("outcome").GetString());
        Assert.Equal(1, tie.GetProperty("version").GetInt64());

        await api.Db.Execute($"""
            update public.port_flags set enabled = false where slice = 'advanceRoundAuthoritative' and room_id = (select room_id from public.rounds where id = '{round}');
            insert into public.rolls (round_id, player_id, layer, value, input_mode, modifier_snapshot) values
              ('{round}', 'g-back', 1, 3, 'in_app', 0), ('{round}', 'g-back-2', 1, 9, 'in_app', 0);
            """);

        var done = await (await api.Client(api.Token(u)).PostAsync($"/rounds/{round}/advance", null)).Content.ReadFromJsonAsync<JsonElement>();
        Assert.Equal("brewer", done.GetProperty("outcome").GetString());
        Assert.Equal("g-back", done.GetProperty("brewer_id").GetString());
        Assert.False(done.TryGetProperty("version", out _));
        Assert.Equal(1L, await RoomVersion(round));
    }

    [Fact]
    public async Task A_noop_under_authority_carries_no_version_so_the_ts_action_still_sends()
    {
        var u = await api.Db.AddUser("g-noop");
        var round = await SeedFinalizableRound("g-noop", "g-noop-2");
        await api.Db.Execute($"""
            insert into public.port_flags (slice, room_id, enabled) select 'advanceRoundAuthoritative', room_id, true from public.rounds where id = '{round}';
            update public.rounds set status = 'resolved', brewer_id = 'g-noop' where id = '{round}';
            """);
        var payload = await (await api.Client(api.Token(u)).PostAsync($"/rounds/{round}/advance", null)).Content.ReadFromJsonAsync<JsonElement>();
        Assert.Equal("round_not_closed", payload.GetProperty("reason").GetString());
        Assert.False(payload.TryGetProperty("version", out _));
        Assert.Equal(0L, await SentFor(round));
    }

    private Task<long> RoomVersion(Guid round) =>
        api.Db.Scalar<long>($"select rm.version from public.rooms rm join public.rounds r on r.room_id = rm.id where r.id = '{round}'");

    private Task<long> SentFor(Guid round) =>
        api.Db.Scalar<long>($"select count(*) from realtime.messages m join public.rounds r on m.topic = 'room:' || r.room_id where r.id = '{round}'");

    private async Task<Guid> SeedFinalizableRound(string p1, string p2, int v1 = 17, int v2 = 6)
    {
        var room = Guid.NewGuid();
        var round = Guid.NewGuid();
        // p1 already exists (AddUser); only p2 is new here.
        await api.Db.Execute($"""
            insert into public.players (id, email) values ('{p2}', '{p2}@example.test') on conflict do nothing;
            insert into public.rooms (id, date) values ('{room}', '{DateTime.UtcNow.AddDays(Random.Shared.Next(1, 100000)):yyyy-MM-dd}');
            insert into public.rounds (id, room_id, started_by, status, started_at, closed_at) values
              ('{round}', '{room}', '{p1}', 'closed', '2026-01-01 09:00+00', '2026-01-01 09:01+00');
            insert into public.round_participants (round_id, player_id) values ('{round}', '{p1}'), ('{round}', '{p2}');
            insert into public.room_players (room_id, player_id, modifier) values ('{room}', '{p1}', 0), ('{room}', '{p2}', 0);
            insert into public.rolls (round_id, player_id, layer, value, input_mode, modifier_snapshot) values
              ('{round}', '{p1}', 0, {v1}, 'in_app', 0), ('{round}', '{p2}', 0, {v2}, 'in_app', 0);
            insert into public.spell_reaction_windows (id, round_id, layer, status, poll_round, opened_at, closed_at)
              values ('{Guid.NewGuid()}', '{round}', 0, 'closed', 1, now(), now());
            """);
        return round;
    }
}
