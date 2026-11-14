using System.Net;
using System.Net.Http.Json;
using System.Text.Json;
using RollForBrew.Tests.Harness;

namespace RollForBrew.Tests;

/// <summary>Spec #533, slice 3b (#551): roll submission over HTTP, against real Postgres.
/// Every test owns a room, so rounds never collide on the one-active-round index.</summary>
public class RollSubmissionHttpTests(ApiHost api) : IClassFixture<ApiHost>
{
    private static int _seq;

    private sealed record Table(Guid Room, TestUser Starter, TestUser Guest, Guid Round);

    private async Task<TestUser> User(string tag, bool admin = false) => await api.Db.AddUser($"{tag}-{Interlocked.Increment(ref _seq)}", admin);

    /// <summary>A room with a round the starter and guest declared into, in the given status.</summary>
    private async Task<Table> Round(string status = "closed", bool testRoom = false, int guestModifier = 0)
    {
        var starter = await User("starter");
        var guest = await User("guest");
        var room = Guid.NewGuid();
        var day = new DateOnly(2030, 1, 1).AddDays(Interlocked.Increment(ref _seq));
        var round = Guid.NewGuid();
        await api.Db.Execute($"""
            insert into public.rooms (id, date, is_test) values ('{room}', '{day:yyyy-MM-dd}', {(testRoom ? "true" : "false")});
            insert into public.room_players (room_id, player_id, modifier) values
              ('{room}', '{starter.PlayerId}', 0), ('{room}', '{guest.PlayerId}', {guestModifier});
            insert into public.rounds (id, room_id, started_by, status, closed_at)
              values ('{round}', '{room}', '{starter.PlayerId}', '{status}', {(status == "open" ? "null" : "now()")});
            insert into public.round_participants (round_id, player_id) values
              ('{round}', '{starter.PlayerId}'), ('{round}', '{guest.PlayerId}');
            """);
        return new Table(room, starter, guest, round);
    }

    private Task<HttpResponseMessage> Send(TestUser who, string path, object? body = null) =>
        api.Client(api.Token(who)).PostAsync(path, body is null ? null : JsonContent.Create(body));

    private static async Task<JsonElement> Json(HttpResponseMessage res) => await res.Content.ReadFromJsonAsync<JsonElement>();

    private static async Task<string> Code(HttpResponseMessage res) => (await Json(res)).GetProperty("code").GetString()!;

    private Task<long> Rolls(Guid round, TestUser u) =>
        api.Db.Scalar<long>($"select count(*) from public.rolls where round_id = '{round}' and player_id = '{u.PlayerId}'");

    [Fact]
    public async Task Requires_a_token()
    {
        var res = await api.Client().PostAsync($"/rounds/{Guid.NewGuid()}/rolls", null);
        Assert.Equal(HttpStatusCode.Unauthorized, res.StatusCode);
    }

    [Fact]
    public async Task Auto_roll_records_a_d20_with_the_modifier_snapshot_and_announces_it()
    {
        var t = await Round(guestModifier: 3);

        var res = await Send(t.Guest, $"/rounds/{t.Round}/rolls");

        Assert.Equal(HttpStatusCode.OK, res.StatusCode);
        var body = await Json(res);
        var value = body.GetProperty("value").GetInt32();
        Assert.InRange(value, 1, 20);
        Assert.Equal(value, await api.Db.Scalar<int>($"select value from public.rolls where round_id = '{t.Round}' and player_id = '{t.Guest.PlayerId}'"));
        Assert.Equal("in_app", await api.Db.Scalar<string>($"select input_mode from public.rolls where round_id = '{t.Round}' and player_id = '{t.Guest.PlayerId}'"));
        Assert.Equal(3, await api.Db.Scalar<int>($"select modifier_snapshot from public.rolls where round_id = '{t.Round}' and player_id = '{t.Guest.PlayerId}'"));
        Assert.Equal(new[] { body.GetProperty("version").GetInt64() }, await api.Db.RoomChangedVersions(t.Room));
    }

    [Fact]
    public async Task Auto_roll_under_advantage_keeps_the_better_die_and_records_the_transform()
    {
        var t = await Round();
        var instance = Guid.NewGuid();
        var cast = Guid.NewGuid();
        await api.Db.Execute($$"""
            insert into public.spell_deck_instances (id, card_id, location)
              select '{{instance}}', id, 'in_deck' from public.spell_cards limit 1;
            insert into public.spell_casts (id, round_id, caster_id, card_instance_id, target_player_id, effect_kind, effect_params)
              values ('{{cast}}', '{{t.Round}}', '{{t.Starter.PlayerId}}', '{{instance}}', '{{t.Guest.PlayerId}}', 'advantage', '{}');
            """);

        var res = await Send(t.Guest, $"/rounds/{t.Round}/rolls");

        Assert.Equal(HttpStatusCode.OK, res.StatusCode);
        var value = (await Json(res)).GetProperty("value").GetInt32();
        var discarded = await api.Db.Scalar<int?>($"select discarded_value from public.rolls where round_id = '{t.Round}' and player_id = '{t.Guest.PlayerId}'");
        Assert.NotNull(discarded);
        Assert.True(discarded <= value);
        var transform = await api.Db.Scalar<string>($"select cast_inputs -> 'roll_transform' ->> 'kind' from public.spell_casts where id = '{cast}'");
        Assert.Equal("advantage", transform);
        Assert.Equal(value, await api.Db.Scalar<int>($"select (cast_inputs -> 'roll_transform' -> 'players' -> 0 ->> 'after')::int from public.spell_casts where id = '{cast}'"));
    }

    [Fact]
    public async Task A_player_who_is_not_a_participant_is_not_an_expected_roller()
    {
        var t = await Round();
        var outsider = await User("outsider");

        var res = await Send(outsider, $"/rounds/{t.Round}/rolls");

        Assert.Equal(HttpStatusCode.Conflict, res.StatusCode);
        Assert.Equal("not_expected_roller", await Code(res));
        Assert.Empty(await api.Db.RoomChangedVersions(t.Room));
    }

    [Fact]
    public async Task Rolling_twice_in_a_layer_is_the_same_stale_refusal_and_keeps_the_first_roll()
    {
        var t = await Round();
        var first = await Send(t.Guest, $"/rounds/{t.Round}/rolls");
        var value = (await Json(first)).GetProperty("value").GetInt32();

        var second = await Send(t.Guest, $"/rounds/{t.Round}/rolls");

        Assert.Equal(HttpStatusCode.Conflict, second.StatusCode);
        Assert.Equal("not_expected_roller", await Code(second));
        Assert.Equal(1, await Rolls(t.Round, t.Guest));
        Assert.Equal(value, await api.Db.Scalar<int>($"select value from public.rolls where round_id = '{t.Round}' and player_id = '{t.Guest.PlayerId}'"));
    }

    [Fact]
    public async Task A_round_still_open_for_declarations_is_not_open_for_rolling()
    {
        var t = await Round("open");

        var res = await Send(t.Guest, $"/rounds/{t.Round}/rolls");

        Assert.Equal(HttpStatusCode.Conflict, res.StatusCode);
        Assert.Equal("round_not_open_for_rolling", await Code(res));
    }

    [Fact]
    public async Task An_unknown_round_is_404()
    {
        var u = await User("lost");

        var res = await Send(u, $"/rounds/{Guid.NewGuid()}/rolls");

        Assert.Equal(HttpStatusCode.NotFound, res.StatusCode);
        Assert.Equal("round_not_found", await Code(res));
    }

    [Fact]
    public async Task Manual_roll_records_the_number_read_off_the_die()
    {
        var t = await Round(guestModifier: 2);

        var res = await Send(t.Guest, $"/rounds/{t.Round}/rolls/manual", new { value = 14 });

        Assert.Equal(HttpStatusCode.OK, res.StatusCode);
        Assert.Equal("manual", await api.Db.Scalar<string>($"select input_mode from public.rolls where round_id = '{t.Round}' and player_id = '{t.Guest.PlayerId}'"));
        Assert.Equal(14, await api.Db.Scalar<int>($"select value from public.rolls where round_id = '{t.Round}' and player_id = '{t.Guest.PlayerId}'"));
        Assert.Equal(2, await api.Db.Scalar<int>($"select modifier_snapshot from public.rolls where round_id = '{t.Round}' and player_id = '{t.Guest.PlayerId}'"));
        Assert.Single(await api.Db.RoomChangedVersions(t.Room));
    }

    [Theory]
    [InlineData(0)]
    [InlineData(21)]
    public async Task Manual_roll_outside_1_to_20_is_400_and_writes_nothing(int value)
    {
        var t = await Round();

        var res = await Send(t.Guest, $"/rounds/{t.Round}/rolls/manual", new { value });

        Assert.Equal(HttpStatusCode.BadRequest, res.StatusCode);
        Assert.Equal("roll_value_out_of_range", await Code(res));
        Assert.Equal(0, await Rolls(t.Round, t.Guest));
    }

    // ---- Test Room puppets

    [Fact]
    public async Task Roll_as_needs_an_admin()
    {
        var t = await Round(testRoom: true);

        var res = await Send(t.Guest, $"/rounds/{t.Round}/rolls/as", new { playerId = t.Starter.PlayerId });

        Assert.Equal(HttpStatusCode.Forbidden, res.StatusCode);
        Assert.Equal("admin_required", await Code(res));
        Assert.Equal(0, await Rolls(t.Round, t.Starter));
    }

    [Fact]
    public async Task Roll_as_is_for_the_Test_Room_only()
    {
        var t = await Round();
        var admin = await User("admin", admin: true);

        var res = await Send(admin, $"/rounds/{t.Round}/rolls/as", new { playerId = t.Starter.PlayerId });

        Assert.Equal(HttpStatusCode.UnprocessableEntity, res.StatusCode);
        Assert.Equal("round_not_in_test_room", await Code(res));
    }

    [Fact]
    public async Task An_admin_rolls_for_a_Test_Room_player()
    {
        var t = await Round(testRoom: true);
        var admin = await User("admin", admin: true);

        var auto = await Send(admin, $"/rounds/{t.Round}/rolls/as", new { playerId = t.Starter.PlayerId });
        var manual = await Send(admin, $"/rounds/{t.Round}/rolls/manual/as", new { playerId = t.Guest.PlayerId, value = 7 });

        Assert.Equal(HttpStatusCode.OK, auto.StatusCode);
        Assert.Equal(HttpStatusCode.OK, manual.StatusCode);
        Assert.Equal(1, await Rolls(t.Round, t.Starter));
        Assert.Equal(7, await api.Db.Scalar<int>($"select value from public.rolls where round_id = '{t.Round}' and player_id = '{t.Guest.PlayerId}'"));
        Assert.Equal(0, await Rolls(t.Round, admin));
    }

    // ---- Proxy Roll

    [Fact]
    public async Task Proxy_roll_seats_and_declares_the_target_and_records_an_admin_entered_roll()
    {
        var t = await Round("open");
        var admin = await User("admin", admin: true);
        var walkIn = await User("walkin");

        var res = await Send(admin, $"/rounds/{t.Round}/rolls/proxy", new { playerId = walkIn.PlayerId, value = 12 });

        Assert.Equal(HttpStatusCode.OK, res.StatusCode);
        Assert.Equal(1, await api.Db.Scalar<long>($"select count(*) from public.room_players where room_id = '{t.Room}' and player_id = '{walkIn.PlayerId}'"));
        Assert.Equal(1, await api.Db.Scalar<long>($"select count(*) from public.round_participants where round_id = '{t.Round}' and player_id = '{walkIn.PlayerId}'"));
        Assert.True(await api.Db.Scalar<bool>($"select entered_by_admin from public.rolls where round_id = '{t.Round}' and player_id = '{walkIn.PlayerId}'"));
        Assert.Equal("manual", await api.Db.Scalar<string>($"select input_mode from public.rolls where round_id = '{t.Round}' and player_id = '{walkIn.PlayerId}'"));
        Assert.Equal(0, await api.Db.Scalar<long>($"select count(*) from public.pending_spell_draws where round_id = '{t.Round}'"));
        Assert.Single(await api.Db.RoomChangedVersions(t.Room));
    }

    [Theory]
    [InlineData(1, "nat1")]
    [InlineData(20, "nat20")]
    public async Task Proxy_crit_records_a_pending_spell_draw_for_the_target(int value, string trigger)
    {
        var t = await Round("open");
        var admin = await User("admin", admin: true);

        var res = await Send(admin, $"/rounds/{t.Round}/rolls/proxy", new { playerId = t.Guest.PlayerId, value });

        Assert.True(res.IsSuccessStatusCode, await res.Content.ReadAsStringAsync());
        Assert.Equal(trigger, await api.Db.Scalar<string>($"select trigger from public.pending_spell_draws where round_id = '{t.Round}' and player_id = '{t.Guest.PlayerId}'"));
    }

    [Fact]
    public async Task Proxy_roll_needs_an_admin_and_a_known_player()
    {
        var t = await Round("open");
        var admin = await User("admin", admin: true);

        var notAdmin = await Send(t.Guest, $"/rounds/{t.Round}/rolls/proxy", new { playerId = t.Starter.PlayerId, value = 5 });
        var unknown = await Send(admin, $"/rounds/{t.Round}/rolls/proxy", new { playerId = "nobody-here", value = 5 });

        Assert.Equal(HttpStatusCode.Forbidden, notAdmin.StatusCode);
        Assert.Equal("admin_required", await Code(notAdmin));
        Assert.Equal(HttpStatusCode.NotFound, unknown.StatusCode);
        Assert.Equal("target_player_not_found", await Code(unknown));
    }

    [Fact]
    public async Task Proxy_roll_after_someone_has_rolled_is_the_stale_round_refusal()
    {
        var t = await Round();
        var admin = await User("admin", admin: true);
        await Send(t.Guest, $"/rounds/{t.Round}/rolls");

        var res = await Send(admin, $"/rounds/{t.Round}/rolls/proxy", new { playerId = t.Starter.PlayerId, value = 5 });

        Assert.Equal(HttpStatusCode.Conflict, res.StatusCode);
        Assert.Equal("round_closed_for_proxy_roll", await Code(res));
        Assert.Equal(0, await Rolls(t.Round, t.Starter));
    }

    [Fact]
    public async Task Proxy_roll_out_of_range_is_400()
    {
        var t = await Round("open");
        var admin = await User("admin", admin: true);

        var res = await Send(admin, $"/rounds/{t.Round}/rolls/proxy", new { playerId = t.Guest.PlayerId, value = 21 });

        Assert.Equal(HttpStatusCode.BadRequest, res.StatusCode);
        Assert.Equal("roll_value_out_of_range", await Code(res));
    }
}
