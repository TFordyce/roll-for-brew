using System.Net;
using System.Net.Http.Json;
using System.Text.Json;
using Npgsql;
using RollForBrew.Tests.Harness;

namespace RollForBrew.Tests;

public class ActingAsHttpTests(ApiHost api) : IClassFixture<ApiHost>
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
        var res = await api.Client().GetAsync("/acting-as");
        Assert.Equal(HttpStatusCode.Unauthorized, res.StatusCode);
        Assert.Equal("unauthenticated", (await Problem(res)).GetProperty("code").GetString());
    }

    [Fact]
    public async Task Garbage_token_is_401_problem()
    {
        var res = await api.Client("not-a-jwt").GetAsync("/acting-as");
        Assert.Equal(HttpStatusCode.Unauthorized, res.StatusCode);
        await Problem(res);
    }

    [Fact]
    public async Task Expired_token_is_401()
    {
        var u = await api.Db.AddUser("g-expired");
        var res = await api.Client(api.Token(u, TimeSpan.FromHours(-1))).GetAsync("/acting-as");
        Assert.Equal(HttpStatusCode.Unauthorized, res.StatusCode);
    }

    [Fact]
    public async Task Token_signed_by_a_foreign_key_is_401()
    {
        var u = await api.Db.AddUser("g-foreign");
        var res = await api.Client(api.Foreign(u)).GetAsync("/acting-as");
        Assert.Equal(HttpStatusCode.Unauthorized, res.StatusCode);
    }

    [Fact]
    public async Task Wrong_audience_and_wrong_issuer_are_401()
    {
        var u = await api.Db.AddUser("g-aud");
        Assert.Equal(HttpStatusCode.Unauthorized,
            (await api.Client(api.Token(u, audience: "someone-else")).GetAsync("/acting-as")).StatusCode);
        Assert.Equal(HttpStatusCode.Unauthorized,
            (await api.Client(api.Token(u, issuer: "https://evil.example/auth/v1")).GetAsync("/acting-as")).StatusCode);
    }

    [Fact]
    public async Task Admin_with_no_pointer_gets_null()
    {
        var admin = await api.Db.AddUser("g-admin-null", admin: true);
        var res = await api.Client(api.Token(admin)).GetAsync("/acting-as");
        Assert.Equal(HttpStatusCode.OK, res.StatusCode);
        Assert.Equal(JsonValueKind.Null, (await res.Content.ReadFromJsonAsync<JsonElement>()).GetProperty("actingAsPlayerId").ValueKind);
    }

    [Fact]
    public async Task Returns_the_same_value_as_get_acting_as()
    {
        var admin = await api.Db.AddUser("g-admin", admin: true);
        await api.Db.AddUser("g-target");
        await api.Db.Execute("insert into public.admin_acting_as (admin_player_id, acting_as_player_id) values ('g-admin', 'g-target')");

        var res = await api.Client(api.Token(admin)).GetAsync("/acting-as");
        Assert.Equal(HttpStatusCode.OK, res.StatusCode);
        var viaApi = (await res.Content.ReadFromJsonAsync<JsonElement>()).GetProperty("actingAsPlayerId").GetString();

        await using var conn = new NpgsqlConnection(api.Db.AdminConnectionString);
        await conn.OpenAsync();
        await using var tx = await conn.BeginTransactionAsync();
        await using (var set = new NpgsqlCommand("select set_config('request.jwt.claims', @c, true)", conn, tx))
        {
            set.Parameters.AddWithValue("c", $$"""{"sub":"{{admin.AuthId}}","role":"authenticated"}""");
            await set.ExecuteNonQueryAsync();
        }
        await using var fn = new NpgsqlCommand("select public.get_acting_as()", conn, tx);
        var viaSql = (string?)await fn.ExecuteScalarAsync();

        Assert.Equal("g-target", viaSql);
        Assert.Equal(viaSql, viaApi);
    }

    [Fact]
    public async Task Acting_as_is_never_client_supplied()
    {
        var admin = await api.Db.AddUser("g-admin-own", admin: true);
        var other = await api.Db.AddUser("g-admin-other", admin: true);
        await api.Db.AddUser("g-other-target");
        await api.Db.Execute("insert into public.admin_acting_as (admin_player_id, acting_as_player_id) values ('g-admin-other', 'g-other-target')");

        var client = api.Client(api.Token(admin));
        client.DefaultRequestHeaders.Add("X-Acting-As", "g-other-target");
        client.DefaultRequestHeaders.Add("X-Admin-Player-Id", other.PlayerId);
        var res = await client.GetAsync($"/acting-as?adminPlayerId={other.PlayerId}&actingAs=g-other-target&player={other.PlayerId}");

        Assert.Equal(HttpStatusCode.OK, res.StatusCode);
        Assert.Equal(JsonValueKind.Null, (await res.Content.ReadFromJsonAsync<JsonElement>()).GetProperty("actingAsPlayerId").ValueKind);
    }

    [Fact]
    public async Task User_with_no_auth_row_gets_a_problem_not_raw_sqlstate()
    {
        var ghost = new TestUser(Guid.NewGuid(), "ghost");
        var res = await api.Client(api.Token(ghost)).GetAsync("/acting-as");
        var body = await res.Content.ReadAsStringAsync();
        Assert.Equal(HttpStatusCode.InternalServerError, res.StatusCode);
        Assert.Equal("application/problem+json", res.Content.Headers.ContentType?.MediaType);
        Assert.Contains("internal_error", body);
        Assert.DoesNotContain("P0001", body);
        Assert.DoesNotContain("current_player_id", body);
    }

    [Fact]
    public async Task Health_stays_anonymous()
    {
        Assert.Equal(HttpStatusCode.OK, (await api.Client().GetAsync("/health")).StatusCode);
    }
}
