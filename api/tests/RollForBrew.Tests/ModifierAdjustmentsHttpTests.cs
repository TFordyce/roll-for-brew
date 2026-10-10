using System.Net;
using System.Net.Http.Json;
using System.Text.Json;
using RollForBrew.Tests.Harness;

namespace RollForBrew.Tests;

public class ModifierAdjustmentsHttpTests(ApiHost api) : IClassFixture<ApiHost>
{
    private static int _seq;

    private async Task<TestUser> User(string tag, bool admin = false) =>
        await api.Db.AddUser($"{tag}-{Interlocked.Increment(ref _seq)}", admin);

    private async Task<Guid> TodayRoom(params TestUser[] players)
    {
        await api.Db.Execute("insert into public.rooms (date) values ((now() at time zone 'Europe/London')::date) on conflict (date) where not is_test do nothing");
        var room = await api.Db.Scalar<Guid>("select id from public.rooms where date = (now() at time zone 'Europe/London')::date and not is_test");
        foreach (var p in players)
            await api.Db.Execute($"insert into public.room_players (room_id, player_id, modifier) values ('{room}', '{p.PlayerId}', 0) on conflict do nothing");
        return room;
    }

    private Task<HttpResponseMessage> Log(TestUser actor, string target, int delta, string? reason) =>
        api.Client(api.Token(actor)).PostAsJsonAsync("/modifier-adjustments", new { targetPlayerId = target, delta, reason });

    private static async Task<string> Code(HttpResponseMessage res) =>
        (await res.Content.ReadFromJsonAsync<JsonElement>()).GetProperty("code").GetString()!;

    private static async Task<Guid> Id(HttpResponseMessage res) =>
        (await res.Content.ReadFromJsonAsync<JsonElement>()).GetProperty("id").GetGuid();

    private Task<int> Modifier(Guid room, TestUser p) =>
        api.Db.Scalar<int>($"select modifier from public.room_players where room_id = '{room}' and player_id = '{p.PlayerId}'");

    [Fact]
    public async Task Requires_a_token()
    {
        var res = await api.Client().PostAsJsonAsync("/modifier-adjustments", new { targetPlayerId = "x", delta = 1, reason = "r" });
        Assert.Equal(HttpStatusCode.Unauthorized, res.StatusCode);
    }

    [Fact]
    public async Task Log_inserts_a_trimmed_row_and_bumps_the_modifier()
    {
        var actor = await User("actor");
        var target = await User("target");
        var room = await TodayRoom(actor, target);
        var res = await Log(actor, target.PlayerId, 3, "  fair play  ");
        Assert.Equal(HttpStatusCode.OK, res.StatusCode);
        var id = await Id(res);
        Assert.Equal(3, await Modifier(room, target));
        Assert.Equal("fair play", await api.Db.Scalar<string>($"select reason from public.modifier_adjustments where id = '{id}'"));
        Assert.Equal(actor.PlayerId, await api.Db.Scalar<string>($"select actor_player_id from public.modifier_adjustments where id = '{id}'"));
        Assert.Equal(room, await api.Db.Scalar<Guid>($"select room_id from public.modifier_adjustments where id = '{id}'"));
    }

    [Fact]
    public async Task Zero_delta_is_RFB10_and_blank_reason_is_RFB11_and_nothing_is_written()
    {
        var actor = await User("actor");
        var target = await User("target");
        var room = await TodayRoom(actor, target);
        var zero = await Log(actor, target.PlayerId, 0, "r");
        Assert.Equal(HttpStatusCode.BadRequest, zero.StatusCode);
        Assert.Equal("adjustment_delta_zero", await Code(zero));
        foreach (var blank in new string?[] { "   ", "", null })
        {
            var res = await Log(actor, target.PlayerId, 1, blank);
            Assert.Equal(HttpStatusCode.BadRequest, res.StatusCode);
            Assert.Equal("adjustment_reason_required", await Code(res));
        }
        Assert.Equal(0, await Modifier(room, target));
    }

    [Fact]
    public async Task Target_outside_todays_room_is_RFB12()
    {
        var actor = await User("actor");
        var outsider = await User("outsider");
        await TodayRoom(actor);
        var res = await Log(actor, outsider.PlayerId, 1, "r");
        Assert.Equal((HttpStatusCode)422, res.StatusCode);
        Assert.Equal("adjustment_target_not_in_room", await Code(res));
    }

    [Fact]
    public async Task Undo_reverses_the_bump_and_deletes_the_row()
    {
        var actor = await User("actor");
        var target = await User("target");
        var room = await TodayRoom(actor, target);
        var id = await Id(await Log(actor, target.PlayerId, -2, "oops"));
        Assert.Equal(-2, await Modifier(room, target));
        var res = await api.Client(api.Token(actor)).DeleteAsync($"/modifier-adjustments/{id}");
        Assert.Equal(HttpStatusCode.NoContent, res.StatusCode);
        Assert.Equal(0, await Modifier(room, target));
        Assert.Equal(0L, await api.Db.Scalar<long>($"select count(*) from public.modifier_adjustments where id = '{id}'"));
    }

    [Fact]
    public async Task Undo_by_non_actor_is_RFB13_and_unknown_id_is_not_found()
    {
        var actor = await User("actor");
        var other = await User("other");
        var target = await User("target");
        await TodayRoom(actor, other, target);
        var id = await Id(await Log(actor, target.PlayerId, 1, "r"));
        var res = await api.Client(api.Token(other)).DeleteAsync($"/modifier-adjustments/{id}");
        Assert.Equal(HttpStatusCode.Forbidden, res.StatusCode);
        Assert.Equal("adjustment_not_actor", await Code(res));
        var missing = await api.Client(api.Token(other)).DeleteAsync($"/modifier-adjustments/{Guid.NewGuid()}");
        Assert.Equal(HttpStatusCode.NotFound, missing.StatusCode);
    }

    [Fact]
    public async Task Only_the_most_recent_can_be_undone_RFB14()
    {
        var actor = await User("actor");
        var target = await User("target");
        await TodayRoom(actor, target);
        var first = await Id(await Log(actor, target.PlayerId, 1, "one"));
        await Log(actor, target.PlayerId, 1, "two");
        var res = await api.Client(api.Token(actor)).DeleteAsync($"/modifier-adjustments/{first}");
        Assert.Equal((HttpStatusCode)422, res.StatusCode);
        Assert.Equal("adjustment_not_most_recent", await Code(res));
    }

    [Fact]
    public async Task Undo_after_five_minutes_is_RFB15()
    {
        var actor = await User("actor");
        var target = await User("target");
        var room = await TodayRoom(actor, target);
        var id = await Id(await Log(actor, target.PlayerId, 4, "late"));
        await api.Db.Execute($"update public.modifier_adjustments set created_at = now() - interval '6 minutes' where id = '{id}'");
        var res = await api.Client(api.Token(actor)).DeleteAsync($"/modifier-adjustments/{id}");
        Assert.Equal(HttpStatusCode.Conflict, res.StatusCode);
        Assert.Equal("adjustment_undo_window_passed", await Code(res));
        Assert.Equal(4, await Modifier(room, target));
    }

    [Fact]
    public async Task Admin_delete_ignores_actor_age_and_recency_and_writes_the_audit_row()
    {
        var admin = await User("admin", admin: true);
        var actor = await User("actor");
        var target = await User("target");
        var room = await TodayRoom(admin, actor, target);
        var old = await Id(await Log(actor, target.PlayerId, 5, "original"));
        await Log(actor, target.PlayerId, 1, "newer");
        await api.Db.Execute($"update public.modifier_adjustments set created_at = now() - interval '2 days' where id = '{old}'");
        var res = await api.Client(api.Token(admin)).PostAsJsonAsync($"/modifier-adjustments/{old}/admin-delete", new { reason = " cleanup " });
        Assert.Equal(HttpStatusCode.NoContent, res.StatusCode);
        Assert.Equal(1, await Modifier(room, target));
        Assert.Equal(0L, await api.Db.Scalar<long>($"select count(*) from public.modifier_adjustments where id = '{old}'"));
        Assert.Equal("cleanup", await api.Db.Scalar<string>($"select reason from public.admin_modifier_adjustment_deletions where adjustment_id = '{old}'"));
        Assert.Equal("original", await api.Db.Scalar<string>($"select original_reason from public.admin_modifier_adjustment_deletions where adjustment_id = '{old}'"));
        Assert.Equal(actor.PlayerId, await api.Db.Scalar<string>($"select original_actor_player_id from public.admin_modifier_adjustment_deletions where adjustment_id = '{old}'"));
        Assert.Equal(admin.PlayerId, await api.Db.Scalar<string>($"select actor_player_id from public.admin_modifier_adjustment_deletions where adjustment_id = '{old}'"));
    }

    [Fact]
    public async Task Admin_delete_errors_RFB19_RFB20_RFB21()
    {
        var admin = await User("admin", admin: true);
        var actor = await User("actor");
        var target = await User("target");
        await TodayRoom(admin, actor, target);
        var id = await Id(await Log(actor, target.PlayerId, 1, "r"));

        var notAdmin = await api.Client(api.Token(actor)).PostAsJsonAsync($"/modifier-adjustments/{id}/admin-delete", new { reason = "x" });
        Assert.Equal(HttpStatusCode.Forbidden, notAdmin.StatusCode);
        Assert.Equal("admin_required_delete_adjustment", await Code(notAdmin));

        var blank = await api.Client(api.Token(admin)).PostAsJsonAsync($"/modifier-adjustments/{id}/admin-delete", new { reason = "  " });
        Assert.Equal(HttpStatusCode.BadRequest, blank.StatusCode);
        Assert.Equal("delete_adjustment_reason_required", await Code(blank));

        var missing = await api.Client(api.Token(admin)).PostAsJsonAsync($"/modifier-adjustments/{Guid.NewGuid()}/admin-delete", new { reason = "x" });
        Assert.Equal(HttpStatusCode.NotFound, missing.StatusCode);
        Assert.Equal("adjustment_not_found", await Code(missing));
        Assert.Equal(1L, await api.Db.Scalar<long>($"select count(*) from public.modifier_adjustments where id = '{id}'"));
    }
}
