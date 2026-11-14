using System.Net;
using System.Net.Http.Json;
using System.Text.Json;
using RollForBrew.Tests.Harness;

namespace RollForBrew.Tests;

/// <summary>Spec #533, slice 3a (#550): the round lifecycle commands over HTTP, against real
/// Postgres. Every test owns a room, so rounds never collide on the one-active-round index.</summary>
public class RoundLifecycleHttpTests(ApiHost api) : IClassFixture<ApiHost>
{
    private static int _seq;

    private sealed record Table(Guid Room, TestUser Starter, TestUser Guest, Guid Round);

    private async Task<TestUser> User(string tag) => await api.Db.AddUser($"{tag}-{Interlocked.Increment(ref _seq)}");

    private async Task<Guid> Room(params TestUser[] seated)
    {
        var room = Guid.NewGuid();
        var day = new DateOnly(2030, 1, 1).AddDays(Interlocked.Increment(ref _seq));
        await api.Db.Execute($"insert into public.rooms (id, date) values ('{room}', '{day:yyyy-MM-dd}')");
        foreach (var u in seated)
            await api.Db.Execute($"insert into public.room_players (room_id, player_id, modifier) values ('{room}', '{u.PlayerId}', 0)");
        return room;
    }

    /// <summary>A room with a round the starter opened and the guest has not declared into.</summary>
    private async Task<Table> Open(string status = "open")
    {
        var starter = await User("starter");
        var guest = await User("guest");
        var room = await Room(starter, guest);
        var round = Guid.NewGuid();
        await api.Db.Execute($"""
            insert into public.rounds (id, room_id, started_by, status, closed_at)
            values ('{round}', '{room}', '{starter.PlayerId}', '{status}', {(status == "open" ? "null" : "now()")});
            insert into public.round_participants (round_id, player_id) values ('{round}', '{starter.PlayerId}');
            """);
        return new Table(room, starter, guest, round);
    }

    private Task<HttpResponseMessage> Send(TestUser who, HttpMethod method, string path, object? body = null) =>
        api.Client(api.Token(who)).SendAsync(new HttpRequestMessage(method, path)
        {
            Content = body is null ? null : JsonContent.Create(body),
        });

    private static async Task<JsonElement> Json(HttpResponseMessage res) => await res.Content.ReadFromJsonAsync<JsonElement>();

    private static async Task<string> Code(HttpResponseMessage res) => (await Json(res)).GetProperty("code").GetString()!;

    private static async Task<long?> Version(HttpResponseMessage res) =>
        (await Json(res)).GetProperty("version") is { ValueKind: JsonValueKind.Number } v ? v.GetInt64() : null;

    private Task<string> Status(Guid round) => api.Db.Scalar<string>($"select status from public.rounds where id = '{round}'")!;

    private Task<long> Declared(Guid round, TestUser u) =>
        api.Db.Scalar<long>($"select count(*) from public.round_participants where round_id = '{round}' and player_id = '{u.PlayerId}'");

    // ---- start

    [Fact]
    public async Task Requires_a_token()
    {
        var res = await api.Client().PostAsync($"/rounds/{Guid.NewGuid()}/close", null);
        Assert.Equal(HttpStatusCode.Unauthorized, res.StatusCode);
    }

    [Fact]
    public async Task Start_opens_a_round_with_the_caller_declared_and_announces_it()
    {
        var starter = await User("start");
        var room = await Room(starter);

        var res = await Send(starter, HttpMethod.Post, "/rounds", new { roomId = room });

        Assert.Equal(HttpStatusCode.OK, res.StatusCode);
        var body = await Json(res);
        var round = body.GetProperty("roundId").GetGuid();
        Assert.Equal("open", await Status(round));
        Assert.Equal(starter.PlayerId, await api.Db.Scalar<string>($"select started_by from public.rounds where id = '{round}'"));
        Assert.Equal(1, await Declared(round, starter));
        Assert.Equal(new[] { body.GetProperty("version").GetInt64() }, await api.Db.RoomChangedVersions(room));
    }

    [Fact]
    public async Task Start_while_a_round_is_active_is_409_and_leaves_one_round()
    {
        var t = await Open();

        var res = await Send(t.Starter, HttpMethod.Post, "/rounds", new { roomId = t.Room });

        Assert.Equal(HttpStatusCode.Conflict, res.StatusCode);
        Assert.Equal("round_already_active", await Code(res));
        Assert.Equal(1, await api.Db.Scalar<long>($"select count(*) from public.rounds where room_id = '{t.Room}'"));
        Assert.Empty(await api.Db.RoomChangedVersions(t.Room));
    }

    [Fact]
    public async Task Start_with_no_room_today_is_404()
    {
        var u = await User("noroom");
        await api.Db.Execute("delete from public.rooms where date = (now() at time zone 'Europe/London')::date and not is_test");

        var res = await Send(u, HttpMethod.Post, "/rounds");

        Assert.Equal(HttpStatusCode.NotFound, res.StatusCode);
        Assert.Equal("no_room_today", await Code(res));
    }

    private async Task<Guid> PendingReplay(Guid room, TestUser caster, string age)
    {
        var resolved = Guid.NewGuid();
        await api.Db.Execute($"""
            insert into public.rounds (id, room_id, started_by, status, resolved_at)
            values ('{resolved}', '{room}', '{caster.PlayerId}', 'resolved', now());
            insert into public.pending_round_replay (round_id, room_id, caster_id, created_at)
            values ('{resolved}', '{room}', '{caster.PlayerId}', now() - interval '{age}');
            """);
        return resolved;
    }

    [Fact]
    public async Task Start_is_locked_while_a_replay_decision_is_pending()
    {
        var starter = await User("lock");
        var room = await Room(starter);
        await PendingReplay(room, starter, "1 minute");

        var res = await Send(starter, HttpMethod.Post, "/rounds", new { roomId = room });

        Assert.Equal(HttpStatusCode.Conflict, res.StatusCode);
        Assert.Equal("replay_decision_state", await Code(res));
    }

    [Fact]
    public async Task Start_clears_a_stalled_replay_decision_first()
    {
        var starter = await User("stale");
        var room = await Room(starter);
        var resolved = await PendingReplay(room, starter, "6 minutes");

        var res = await Send(starter, HttpMethod.Post, "/rounds", new { roomId = room });

        Assert.Equal(HttpStatusCode.OK, res.StatusCode);
        Assert.Equal(0, await api.Db.Scalar<long>($"select count(*) from public.pending_round_replay where round_id = '{resolved}'"));
    }

    // ---- declare in, withdraw

    [Fact]
    public async Task Declare_in_adds_the_caller_and_announces_a_version()
    {
        var t = await Open();

        var res = await Send(t.Guest, HttpMethod.Post, $"/rounds/{t.Round}/declaration");

        Assert.Equal(HttpStatusCode.OK, res.StatusCode);
        Assert.Equal(1, await Declared(t.Round, t.Guest));
        Assert.Equal(new[] { (await Version(res))!.Value }, await api.Db.RoomChangedVersions(t.Room));
    }

    [Fact]
    public async Task Declaring_twice_changes_nothing_and_announces_nothing()
    {
        var t = await Open();
        await Send(t.Guest, HttpMethod.Post, $"/rounds/{t.Round}/declaration");

        var again = await Send(t.Guest, HttpMethod.Post, $"/rounds/{t.Round}/declaration");

        Assert.Equal(HttpStatusCode.OK, again.StatusCode);
        Assert.Null(await Version(again));
        Assert.Single(await api.Db.RoomChangedVersions(t.Room));
    }

    [Fact]
    public async Task Declare_in_after_close_is_409_and_for_a_stranger_is_403()
    {
        var closed = await Open("closed");
        var late = await Send(closed.Guest, HttpMethod.Post, $"/rounds/{closed.Round}/declaration");
        Assert.Equal(HttpStatusCode.Conflict, late.StatusCode);
        Assert.Equal("round_not_open_for_declarations", await Code(late));

        var open = await Open();
        var stranger = await User("stranger");
        var res = await Send(stranger, HttpMethod.Post, $"/rounds/{open.Round}/declaration");
        Assert.Equal(HttpStatusCode.Forbidden, res.StatusCode);
        Assert.Equal("not_present_in_room", await Code(res));
        Assert.Equal(0, await Declared(open.Round, stranger));
    }

    [Fact]
    public async Task Declare_in_on_an_unknown_round_is_404()
    {
        var u = await User("ghost");
        var res = await Send(u, HttpMethod.Post, $"/rounds/{Guid.NewGuid()}/declaration");
        Assert.Equal(HttpStatusCode.NotFound, res.StatusCode);
        Assert.Equal("round_not_found", await Code(res));
    }

    [Fact]
    public async Task Late_declare_works_on_a_closed_round_nobody_has_rolled_in()
    {
        var t = await Open("closed");

        var res = await Send(t.Guest, HttpMethod.Post, $"/rounds/{t.Round}/declaration/late");

        Assert.Equal(HttpStatusCode.OK, res.StatusCode);
        Assert.Equal(1, await Declared(t.Round, t.Guest));
    }

    [Fact]
    public async Task Late_declare_after_a_roll_or_on_an_open_round_is_409()
    {
        var rolled = await Open("closed");
        await api.Db.Execute($"""
            insert into public.rolls (round_id, player_id, layer, value, input_mode, modifier_snapshot)
            values ('{rolled.Round}', '{rolled.Starter.PlayerId}', 0, 12, 'in_app', 0)
            """);
        var afterRoll = await Send(rolled.Guest, HttpMethod.Post, $"/rounds/{rolled.Round}/declaration/late");
        Assert.Equal(HttpStatusCode.Conflict, afterRoll.StatusCode);
        Assert.Equal("round_closed_for_late_declare", await Code(afterRoll));
        Assert.Equal(0, await Declared(rolled.Round, rolled.Guest));

        var open = await Open();
        var early = await Send(open.Guest, HttpMethod.Post, $"/rounds/{open.Round}/declaration/late");
        Assert.Equal("round_closed_for_late_declare", await Code(early));
    }

    [Fact]
    public async Task Withdraw_removes_a_declaration_but_never_the_starters()
    {
        var t = await Open();
        await Send(t.Guest, HttpMethod.Post, $"/rounds/{t.Round}/declaration");

        var res = await Send(t.Guest, HttpMethod.Delete, $"/rounds/{t.Round}/declaration");
        Assert.Equal(HttpStatusCode.OK, res.StatusCode);
        Assert.Equal(0, await Declared(t.Round, t.Guest));

        var starter = await Send(t.Starter, HttpMethod.Delete, $"/rounds/{t.Round}/declaration");
        Assert.Equal(HttpStatusCode.UnprocessableEntity, starter.StatusCode);
        Assert.Equal("starter_cannot_withdraw", await Code(starter));
        Assert.Equal(1, await Declared(t.Round, t.Starter));
    }

    [Fact]
    public async Task Withdraw_after_close_is_409()
    {
        var t = await Open("closed");
        var res = await Send(t.Guest, HttpMethod.Delete, $"/rounds/{t.Round}/declaration");
        Assert.Equal(HttpStatusCode.Conflict, res.StatusCode);
        Assert.Equal("round_not_open_for_declarations", await Code(res));
    }

    // ---- close

    [Fact]
    public async Task Close_locks_the_round_and_announces_it()
    {
        var t = await Open();
        await Send(t.Guest, HttpMethod.Post, $"/rounds/{t.Round}/declaration");

        var res = await Send(t.Starter, HttpMethod.Post, $"/rounds/{t.Round}/close");

        Assert.Equal(HttpStatusCode.OK, res.StatusCode);
        Assert.Equal("closed", await Status(t.Round));
        Assert.True(await api.Db.Scalar<bool>($"select closed_at is not null from public.rounds where id = '{t.Round}'"));
        Assert.Equal((await Version(res))!.Value, (await api.Db.RoomChangedVersions(t.Room)).Last());
    }

    [Fact]
    public async Task Close_refuses_a_non_starter_a_lone_player_and_a_round_already_closed()
    {
        var t = await Open();
        await Send(t.Guest, HttpMethod.Post, $"/rounds/{t.Round}/declaration");

        var notStarter = await Send(t.Guest, HttpMethod.Post, $"/rounds/{t.Round}/close");
        Assert.Equal(HttpStatusCode.Forbidden, notStarter.StatusCode);
        Assert.Equal("close_not_starter", await Code(notStarter));

        var alone = await Open();
        var tooFew = await Send(alone.Starter, HttpMethod.Post, $"/rounds/{alone.Round}/close");
        Assert.Equal(HttpStatusCode.UnprocessableEntity, tooFew.StatusCode);
        Assert.Equal("close_too_few_declared", await Code(tooFew));

        await Send(t.Starter, HttpMethod.Post, $"/rounds/{t.Round}/close");
        var twice = await Send(t.Starter, HttpMethod.Post, $"/rounds/{t.Round}/close");
        Assert.Equal(HttpStatusCode.Conflict, twice.StatusCode);
        Assert.Equal("round_not_open_for_declarations", await Code(twice));
        Assert.Equal("open", await Status(alone.Round));
    }

    // ---- cancel, exclude

    [Fact]
    public async Task Cancel_ends_a_stalled_round_and_is_idempotent()
    {
        var t = await Open("closed");

        var first = await Send(t.Starter, HttpMethod.Post, $"/rounds/{t.Round}/cancel");
        Assert.Equal("cancelled", await Status(t.Round));
        Assert.NotNull(await Version(first));

        var second = await Send(t.Starter, HttpMethod.Post, $"/rounds/{t.Round}/cancel");
        Assert.Equal(HttpStatusCode.OK, second.StatusCode);
        Assert.Null(await Version(second));
    }

    [Fact]
    public async Task Cancel_leaves_a_resolved_round_alone()
    {
        var t = await Open("resolved");
        var res = await Send(t.Starter, HttpMethod.Post, $"/rounds/{t.Round}/cancel");
        Assert.Equal("resolved", await Status(t.Round));
        Assert.Null(await Version(res));
    }

    [Fact]
    public async Task Exclude_marks_a_participant_out_once()
    {
        var t = await Open("closed");
        await api.Db.Execute($"insert into public.round_participants (round_id, player_id) values ('{t.Round}', '{t.Guest.PlayerId}')");

        var first = await Send(t.Starter, HttpMethod.Post, $"/rounds/{t.Round}/exclusions", new { playerId = t.Guest.PlayerId, layer = 0 });
        Assert.True(await api.Db.Scalar<bool>(
            $"select excluded_at is not null from public.round_participants where round_id = '{t.Round}' and player_id = '{t.Guest.PlayerId}'"));
        Assert.NotNull(await Version(first));

        var again = await Send(t.Starter, HttpMethod.Post, $"/rounds/{t.Round}/exclusions", new { playerId = t.Guest.PlayerId, layer = 0 });
        Assert.Null(await Version(again));
    }

    [Fact]
    public async Task Exclude_from_a_tie_layer_touches_only_that_layer()
    {
        var t = await Open("closed");
        await api.Db.Execute($"""
            insert into public.round_participants (round_id, player_id) values ('{t.Round}', '{t.Guest.PlayerId}');
            insert into public.round_layer_participants (round_id, layer, player_id) values ('{t.Round}', 1, '{t.Guest.PlayerId}');
            """);

        await Send(t.Starter, HttpMethod.Post, $"/rounds/{t.Round}/exclusions", new { playerId = t.Guest.PlayerId, layer = 1 });

        Assert.True(await api.Db.Scalar<bool>(
            $"select excluded_at is not null from public.round_layer_participants where round_id = '{t.Round}' and layer = 1 and player_id = '{t.Guest.PlayerId}'"));
        Assert.True(await api.Db.Scalar<bool>(
            $"select excluded_at is null from public.round_participants where round_id = '{t.Round}' and player_id = '{t.Guest.PlayerId}'"));
    }

    // ---- replay decision

    [Fact]
    public async Task Decline_keeps_the_round_and_clears_the_decision()
    {
        var caster = await User("caster");
        var room = await Room(caster);
        var round = await PendingReplay(room, caster, "1 minute");

        var res = await Send(caster, HttpMethod.Post, $"/rounds/{round}/replay/decline");

        Assert.Equal(HttpStatusCode.OK, res.StatusCode);
        Assert.NotNull(await Version(res));
        Assert.Equal(0, await api.Db.Scalar<long>($"select count(*) from public.pending_round_replay where round_id = '{round}'"));
        Assert.Equal("resolved", await Status(round));

        var again = await Send(caster, HttpMethod.Post, $"/rounds/{round}/replay/decline");
        Assert.Equal(HttpStatusCode.OK, again.StatusCode);
        Assert.Null(await Version(again));
    }

    [Fact]
    public async Task Only_the_caster_may_decide_the_replay()
    {
        var caster = await User("caster");
        var other = await User("other");
        var room = await Room(caster, other);
        var round = await PendingReplay(room, caster, "1 minute");

        foreach (var action in new[] { "confirm", "decline" })
        {
            var res = await Send(other, HttpMethod.Post, $"/rounds/{round}/replay/{action}");
            Assert.Equal(HttpStatusCode.Forbidden, res.StatusCode);
            Assert.Equal("replay_not_caster", await Code(res));
        }
        Assert.Equal(1, await api.Db.Scalar<long>($"select count(*) from public.pending_round_replay where round_id = '{round}'"));
    }

    [Fact]
    public async Task Confirm_with_nothing_pending_is_409()
    {
        var t = await Open("resolved");
        var res = await Send(t.Starter, HttpMethod.Post, $"/rounds/{t.Round}/replay/confirm");
        Assert.Equal(HttpStatusCode.Conflict, res.StatusCode);
        Assert.Equal("replay_decision_state", await Code(res));
    }

    [Fact]
    public async Task Confirm_scraps_the_round_back_to_a_closed_generation_one()
    {
        var caster = await User("scrapper");
        var room = await Room(caster);
        var round = await PendingReplay(room, caster, "1 minute");

        var res = await Send(caster, HttpMethod.Post, $"/rounds/{round}/replay/confirm");

        Assert.Equal(HttpStatusCode.OK, res.StatusCode);
        Assert.Equal("closed", await Status(round));
        Assert.Equal(1, await api.Db.Scalar<int>($"select replay_generation from public.rounds where id = '{round}'"));
        Assert.Equal(0, await api.Db.Scalar<long>($"select count(*) from public.pending_round_replay where round_id = '{round}'"));
        Assert.NotNull(await Version(res));
    }
}
