using System.Net;
using System.Net.Http.Json;
using System.Text.Json;
using Npgsql;
using RollForBrew.Tests.Harness;

namespace RollForBrew.Tests;

/// <summary>Spec #533, slice 4 (#553): spell draws over HTTP, against real Postgres. Every test
/// owns a room and its own deck instances. The deck is global, so random draws assert only
/// on the instance they got back.</summary>
public class SpellDrawHttpTests(ApiHost api) : IClassFixture<ApiHost>
{
    private static int _seq;

    private sealed record Table(Guid Room, TestUser Starter, TestUser Guest, Guid Round);

    private async Task<TestUser> User(string tag, bool admin = false) => await api.Db.AddUser($"{tag}-{Interlocked.Increment(ref _seq)}", admin);

    /// <summary>A room with a closed round the starter and guest declared into.</summary>
    private async Task<Table> Round(bool testRoom = false)
    {
        var starter = await User("starter");
        var guest = await User("guest");
        var room = Guid.NewGuid();
        var day = new DateOnly(2031, 1, 1).AddDays(Interlocked.Increment(ref _seq));
        var round = Guid.NewGuid();
        await api.Db.Execute($"""
            insert into public.rooms (id, date, is_test) values ('{room}', '{day:yyyy-MM-dd}', {(testRoom ? "true" : "false")});
            insert into public.room_players (room_id, player_id) values ('{room}', '{starter.PlayerId}'), ('{room}', '{guest.PlayerId}');
            insert into public.rounds (id, room_id, started_by, status, closed_at) values ('{round}', '{room}', '{starter.PlayerId}', 'closed', now());
            insert into public.round_participants (round_id, player_id) values ('{round}', '{starter.PlayerId}'), ('{round}', '{guest.PlayerId}');
            """);
        return new Table(room, starter, guest, round);
    }

    /// <summary>A fresh deck instance of a card that no other test claims by name.</summary>
    private async Task<(Guid Instance, Guid Card)> Instance(string location = "in_deck", TestUser? holder = null)
    {
        var instance = Guid.NewGuid();
        var card = await api.Db.Scalar<Guid>("select id from public.spell_cards order by name limit 1");
        await api.Db.Execute($"""
            insert into public.spell_deck_instances (id, card_id, location, held_by_player)
            values ('{instance}', '{card}', '{location}', {(holder is null ? "null" : $"'{holder.PlayerId}'")});
            """);
        return (instance, card);
    }

    private Task Pending(Guid round, TestUser who, string trigger = "nat20") =>
        api.Db.Execute($"insert into public.pending_spell_draws (round_id, player_id, trigger) values ('{round}', '{who.PlayerId}', '{trigger}')");

    private Task<long> PendingCount(Guid round, TestUser who) =>
        api.Db.Scalar<long>($"select count(*) from public.pending_spell_draws where round_id = '{round}' and player_id = '{who.PlayerId}'");

    private async Task<(string? Location, string? Holder)> Where(Guid instance)
    {
        var location = await api.Db.Scalar<string>($"select location from public.spell_deck_instances where id = '{instance}'");
        var holder = await api.Db.Scalar<string>($"select held_by_player from public.spell_deck_instances where id = '{instance}'");
        return (location, holder);
    }

    /// <summary>A live draw-redirect mark of <paramref name="trigger"/> by caster on target, cast
    /// in an earlier resolved round of the room (what cast_spell_card plus resolution leaves).</summary>
    private async Task<Guid> Mark(Guid room, TestUser caster, TestUser target, string trigger)
    {
        var castRound = Guid.NewGuid();
        var cast = Guid.NewGuid();
        var name = trigger == "next_crit" ? "Marked for Brew" : "Stale Biscuit";
        var card = await api.Db.Scalar<Guid>($"select id from public.spell_cards where name = '{name}'");
        var instance = Guid.NewGuid();
        var parameters = trigger == "next_crit"
            ? """{"persist": true, "trigger": "next_crit", "participated_rounds_after_cast": 5}"""
            : """{"persist": true, "trigger": "next_draw"}""";
        await api.Db.Execute($"""
            insert into public.rounds (id, room_id, started_by, status, started_at, closed_at, resolved_at)
              values ('{castRound}', '{room}', '{caster.PlayerId}', 'resolved', now() - interval '2 hours', now() - interval '2 hours', now() - interval '1 hour');
            insert into public.round_participants (round_id, player_id) values ('{castRound}', '{caster.PlayerId}'), ('{castRound}', '{target.PlayerId}');
            insert into public.spell_deck_instances (id, card_id, location) values ('{instance}', '{card}', 'benched');
            insert into public.spell_casts (id, round_id, caster_id, card_instance_id, target_player_id, effect_kind, effect_params)
              values ('{cast}', '{castRound}', '{caster.PlayerId}', '{instance}', '{target.PlayerId}', 'draw_redirect', '{parameters}');
            insert into public.spell_active_effects (room_id, target_player_id, caster_id, source_cast_id, card_id, effect_kind, effect_params, created_at)
              values ('{room}', '{target.PlayerId}', '{caster.PlayerId}', '{cast}', '{card}', 'draw_redirect', '{parameters}', now() - interval '2 hours');
            """);
        return cast;
    }

    private Task<string?> Outcome(Guid cast) =>
        api.Db.Scalar<string>($"select cast_inputs ->> 'draw_redirect_outcome' from public.spell_casts where id = '{cast}'");

    private Task<HttpResponseMessage> Send(TestUser who, string path, object? body = null) =>
        api.Client(api.Token(who)).PostAsync(path, body is null ? null : JsonContent.Create(body));

    private static async Task<JsonElement> Json(HttpResponseMessage res) => await res.Content.ReadFromJsonAsync<JsonElement>();

    private static async Task<string> Code(HttpResponseMessage res) => (await Json(res)).GetProperty("code").GetString()!;

    private static Guid? InstanceOf(JsonElement body) =>
        body.GetProperty("instanceId").ValueKind == JsonValueKind.Null ? null : body.GetProperty("instanceId").GetGuid();

    [Fact]
    public async Task Requires_a_token()
    {
        var res = await api.Client().PostAsync($"/rounds/{Guid.NewGuid()}/draws", null);
        Assert.Equal(HttpStatusCode.Unauthorized, res.StatusCode);
    }

    // ---- Recording a crit's Pending Spell Draw

    [Fact]
    public async Task Recording_a_crit_leaves_a_pending_draw_for_the_roller_and_announces_it()
    {
        var t = await Round();

        var res = await Send(t.Guest, $"/rounds/{t.Round}/pending-draw", new { trigger = "nat1" });

        Assert.Equal(HttpStatusCode.OK, res.StatusCode);
        Assert.Equal("nat1", await api.Db.Scalar<string>($"select trigger from public.pending_spell_draws where round_id = '{t.Round}' and player_id = '{t.Guest.PlayerId}'"));
        Assert.Equal(new[] { (await Json(res)).GetProperty("version").GetInt64() }, await api.Db.RoomChangedVersions(t.Room));
    }

    [Fact]
    public async Task Recording_twice_keeps_one_pending_draw()
    {
        var t = await Round();

        await Send(t.Guest, $"/rounds/{t.Round}/pending-draw", new { trigger = "nat20" });
        var again = await Send(t.Guest, $"/rounds/{t.Round}/pending-draw", new { trigger = "nat20" });

        Assert.Equal(HttpStatusCode.OK, again.StatusCode);
        Assert.Equal(1, await PendingCount(t.Round, t.Guest));
    }

    [Fact]
    public async Task Recording_refuses_a_bad_trigger_and_a_missing_round()
    {
        var t = await Round();

        var bad = await Send(t.Guest, $"/rounds/{t.Round}/pending-draw", new { trigger = "nat2" });
        var missing = await Send(t.Guest, $"/rounds/{Guid.NewGuid()}/pending-draw", new { trigger = "nat20" });

        Assert.Equal(HttpStatusCode.BadRequest, bad.StatusCode);
        Assert.Equal("invalid_draw_trigger", await Code(bad));
        Assert.Equal(HttpStatusCode.NotFound, missing.StatusCode);
        Assert.Equal("round_not_found", await Code(missing));
        Assert.Equal(0, await PendingCount(t.Round, t.Guest));
        Assert.Empty(await api.Db.RoomChangedVersions(t.Room));
    }

    [Fact]
    public async Task A_marked_rollers_crit_is_recorded_for_the_marks_caster()
    {
        var t = await Round();
        var cast = await Mark(t.Room, t.Starter, t.Guest, "next_crit");

        var res = await Send(t.Guest, $"/rounds/{t.Round}/pending-draw", new { trigger = "nat20" });

        Assert.Equal(HttpStatusCode.OK, res.StatusCode);
        Assert.Equal(0, await PendingCount(t.Round, t.Guest));
        Assert.Equal(1, await PendingCount(t.Round, t.Starter));
        Assert.Equal("redirected", await Outcome(cast));
    }

    // ---- Drawing against the Pending Spell Draw

    [Fact]
    public async Task Drawing_lands_a_card_in_an_empty_hand_logs_it_and_clears_the_pending_draw()
    {
        var t = await Round();
        await Pending(t.Round, t.Guest);

        var res = await Send(t.Guest, $"/rounds/{t.Round}/draws");

        Assert.Equal(HttpStatusCode.OK, res.StatusCode);
        var body = await Json(res);
        var instance = InstanceOf(body)!.Value;
        Assert.False(body.GetProperty("needsSwapDecision").GetBoolean());
        Assert.Equal(("held", t.Guest.PlayerId), await Where(instance));
        Assert.Equal("nat20", await api.Db.Scalar<string>($"select trigger from public.spell_draws where card_instance_id = '{instance}' and player_id = '{t.Guest.PlayerId}'"));
        Assert.Equal(0, await PendingCount(t.Round, t.Guest));
        Assert.Equal(new[] { body.GetProperty("version").GetInt64() }, await api.Db.RoomChangedVersions(t.Room));
    }

    [Fact]
    public async Task A_nat_20_with_a_card_in_hand_parks_the_new_one_for_keep_or_swap()
    {
        var t = await Round();
        var (held, _) = await Instance("held", t.Guest);
        await Pending(t.Round, t.Guest, "nat20");

        var body = await Json(await Send(t.Guest, $"/rounds/{t.Round}/draws"));

        Assert.True(body.GetProperty("needsSwapDecision").GetBoolean());
        Assert.Equal(("pending_swap", t.Guest.PlayerId), await Where(InstanceOf(body)!.Value));
        Assert.Equal(("held", t.Guest.PlayerId), await Where(held));
    }

    [Fact]
    public async Task A_nat_1_with_a_card_in_hand_forces_the_swap()
    {
        var t = await Round();
        var (held, _) = await Instance("held", t.Guest);
        await Pending(t.Round, t.Guest, "nat1");

        var body = await Json(await Send(t.Guest, $"/rounds/{t.Round}/draws"));

        Assert.False(body.GetProperty("needsSwapDecision").GetBoolean());
        Assert.Equal(("held", t.Guest.PlayerId), await Where(InstanceOf(body)!.Value));
        Assert.Equal(("in_deck", (string?)null), await Where(held));
    }

    [Fact]
    public async Task Drawing_with_no_pending_draw_or_an_open_swap_decision_is_409()
    {
        var t = await Round();
        var none = await Send(t.Guest, $"/rounds/{t.Round}/draws");

        await Instance("pending_swap", t.Starter);
        await Pending(t.Round, t.Starter);
        var swap = await Send(t.Starter, $"/rounds/{t.Round}/draws");

        Assert.Equal(HttpStatusCode.Conflict, none.StatusCode);
        Assert.Equal("no_pending_spell_draw", await Code(none));
        Assert.Equal(HttpStatusCode.Conflict, swap.StatusCode);
        Assert.Equal("pending_swap_decision_open", await Code(swap));
        Assert.Equal(1, await PendingCount(t.Round, t.Starter));
        Assert.Empty(await api.Db.RoomChangedVersions(t.Room));
    }

    [Fact]
    public async Task Drawing_for_a_player_under_stale_biscuit_lands_the_card_with_the_caster()
    {
        var t = await Round();
        var cast = await Mark(t.Room, t.Starter, t.Guest, "next_draw");
        await Pending(t.Round, t.Guest);

        var body = await Json(await Send(t.Guest, $"/rounds/{t.Round}/draws"));

        Assert.False(body.GetProperty("needsSwapDecision").GetBoolean());
        Assert.Equal(("held", t.Starter.PlayerId), await Where(InstanceOf(body)!.Value));
        Assert.Equal("redirected", await Outcome(cast));
    }

    // ---- "I drew this IRL"

    [Fact]
    public async Task A_manual_draw_claims_the_named_card()
    {
        var t = await Round();
        var (instance, card) = await Instance();
        await api.Db.Execute($"update public.spell_deck_instances set location = 'benched' where card_id = '{card}' and id <> '{instance}' and location = 'in_deck'");
        await Pending(t.Round, t.Guest);

        var res = await Send(t.Guest, $"/rounds/{t.Round}/draws/manual", new { cardId = card });

        Assert.Equal(HttpStatusCode.OK, res.StatusCode);
        Assert.Equal(instance, InstanceOf(await Json(res)));
        Assert.Equal(("held", t.Guest.PlayerId), await Where(instance));
        Assert.Equal(0, await PendingCount(t.Round, t.Guest));
    }

    [Fact]
    public async Task A_manual_draw_of_a_card_not_in_the_deck_is_409_and_keeps_the_pending_draw()
    {
        var t = await Round();
        var card = await api.Db.Scalar<Guid>("select id from public.spell_cards where name = 'Marked for Brew'");
        await api.Db.Execute($"update public.spell_deck_instances set location = 'benched' where card_id = '{card}' and location = 'in_deck'");
        await Pending(t.Round, t.Guest);

        var res = await Send(t.Guest, $"/rounds/{t.Round}/draws/manual", new { cardId = card });

        Assert.Equal(HttpStatusCode.Conflict, res.StatusCode);
        Assert.Equal("card_not_in_deck", await Code(res));
        Assert.Equal(1, await PendingCount(t.Round, t.Guest));
    }

    // ---- Concurrency: deck claims are skip-locked

    [Fact]
    public async Task A_claim_skips_an_instance_another_draw_holds_instead_of_waiting_for_it()
    {
        var t = await Round();
        var card = await api.Db.Scalar<Guid>("select id from public.spell_cards where name = 'Stale Biscuit'");
        await api.Db.Execute($"update public.spell_deck_instances set location = 'benched' where card_id = '{card}' and location = 'in_deck'");
        var only = Guid.NewGuid();
        await api.Db.Execute($"insert into public.spell_deck_instances (id, card_id, location) values ('{only}', '{card}', 'in_deck')");
        await Pending(t.Round, t.Guest);

        // A concurrent draw has claimed the one instance and not committed yet.
        await using var other = new NpgsqlConnection(api.Db.AdminConnectionString);
        await other.OpenAsync();
        await using var tx = await other.BeginTransactionAsync();
        await using (var claim = new NpgsqlCommand($"select id from public.spell_deck_instances where id = '{only}' for update", other, tx))
            await claim.ExecuteScalarAsync();

        var res = await Send(t.Guest, $"/rounds/{t.Round}/draws/manual", new { cardId = card }).WaitAsync(TimeSpan.FromSeconds(20));
        await tx.RollbackAsync();

        Assert.Equal(HttpStatusCode.Conflict, res.StatusCode);
        Assert.Equal("card_not_in_deck", await Code(res));
        Assert.Equal(("in_deck", (string?)null), await Where(only));
    }

    [Fact]
    public async Task Concurrent_draws_in_different_rooms_never_claim_one_instance()
    {
        var tables = await Task.WhenAll(Enumerable.Range(0, 6).Select(_ => Round()));
        foreach (var t in tables) await Pending(t.Round, t.Guest);

        var bodies = await Task.WhenAll(tables.Select(async t => await Json(await Send(t.Guest, $"/rounds/{t.Round}/draws"))));

        var drawn = bodies.Select(InstanceOf).ToArray();
        Assert.All(drawn, d => Assert.NotNull(d));
        Assert.Equal(drawn.Length, drawn.Distinct().Count());
        foreach (var (t, instance) in tables.Zip(drawn))
            Assert.Equal(("held", t.Guest.PlayerId), await Where(instance!.Value));
    }

    // ---- Test Room puppet draw

    [Fact]
    public async Task An_admin_draws_now_for_a_test_room_player()
    {
        var t = await Round(testRoom: true);
        var admin = await User("admin", admin: true);

        var res = await Send(admin, $"/rounds/{t.Round}/draws/as", new { trigger = "nat20", playerId = t.Guest.PlayerId });

        Assert.Equal(HttpStatusCode.OK, res.StatusCode);
        var body = await Json(res);
        Assert.Equal(("held", t.Guest.PlayerId), await Where(InstanceOf(body)!.Value));
        Assert.Equal(new[] { body.GetProperty("version").GetInt64() }, await api.Db.RoomChangedVersions(t.Room));
    }

    [Fact]
    public async Task An_admin_puppet_draw_can_name_the_card()
    {
        var t = await Round(testRoom: true);
        var admin = await User("admin", admin: true);
        var (instance, card) = await Instance();
        await api.Db.Execute($"update public.spell_deck_instances set location = 'benched' where card_id = '{card}' and id <> '{instance}' and location = 'in_deck'");

        var body = await Json(await Send(admin, $"/rounds/{t.Round}/draws/as", new { trigger = "nat1", playerId = t.Guest.PlayerId, cardId = card }));

        Assert.Equal(instance, InstanceOf(body));
        Assert.Equal(("held", t.Guest.PlayerId), await Where(instance));
    }

    [Fact]
    public async Task A_puppet_crit_for_a_marked_player_goes_to_the_marks_caster()
    {
        var t = await Round(testRoom: true);
        var admin = await User("admin", admin: true);
        var cast = await Mark(t.Room, t.Starter, t.Guest, "next_crit");

        var body = await Json(await Send(admin, $"/rounds/{t.Round}/draws/as", new { trigger = "nat20", playerId = t.Guest.PlayerId }));

        Assert.Equal(("held", t.Starter.PlayerId), await Where(InstanceOf(body)!.Value));
        Assert.Equal("redirected", await Outcome(cast));
    }

    [Fact]
    public async Task A_puppet_draw_needs_an_admin_a_test_room_and_a_known_player()
    {
        var t = await Round(testRoom: true);
        var real = await Round();
        var admin = await User("admin", admin: true);

        var notAdmin = await Send(t.Starter, $"/rounds/{t.Round}/draws/as", new { trigger = "nat20", playerId = t.Guest.PlayerId });
        var notTest = await Send(admin, $"/rounds/{real.Round}/draws/as", new { trigger = "nat20", playerId = real.Guest.PlayerId });
        var nobody = await Send(admin, $"/rounds/{t.Round}/draws/as", new { trigger = "nat20", playerId = "nobody" });

        Assert.Equal(HttpStatusCode.Forbidden, notAdmin.StatusCode);
        Assert.Equal("admin_required", await Code(notAdmin));
        Assert.Equal((HttpStatusCode)422, notTest.StatusCode);
        Assert.Equal("round_not_in_test_room", await Code(notTest));
        Assert.Equal(HttpStatusCode.NotFound, nobody.StatusCode);
        Assert.Equal("target_player_not_found", await Code(nobody));
    }

    // ---- Proxy Roll crits through the draw (parity audit: retired at #552, covered here)

    [Fact]
    public async Task A_proxied_nat_20_for_a_marked_player_is_the_casters_draw()
    {
        var t = await Round();
        var admin = await User("admin", admin: true);
        await api.Db.Execute($"insert into public.room_players (room_id, player_id) values ('{t.Room}', '{admin.PlayerId}')");
        var cast = await Mark(t.Room, t.Starter, t.Guest, "next_crit");

        var proxy = await Send(admin, $"/rounds/{t.Round}/rolls/proxy", new { playerId = t.Guest.PlayerId, value = 20 });
        var draw = await Send(t.Starter, $"/rounds/{t.Round}/draws");

        Assert.Equal(HttpStatusCode.OK, proxy.StatusCode);
        Assert.Equal(HttpStatusCode.OK, draw.StatusCode);
        Assert.Equal(0, await PendingCount(t.Round, t.Guest));
        Assert.Equal(("held", t.Starter.PlayerId), await Where(InstanceOf(await Json(draw))!.Value));
        Assert.Equal("redirected", await Outcome(cast));
    }

    [Fact]
    public async Task A_proxied_nat_20_drawn_by_a_player_under_stale_biscuit_goes_to_the_caster()
    {
        var t = await Round();
        var admin = await User("admin", admin: true);
        await api.Db.Execute($"insert into public.room_players (room_id, player_id) values ('{t.Room}', '{admin.PlayerId}')");
        var cast = await Mark(t.Room, t.Starter, t.Guest, "next_draw");

        var proxy = await Send(admin, $"/rounds/{t.Round}/rolls/proxy", new { playerId = t.Guest.PlayerId, value = 20 });
        var draw = await Send(t.Guest, $"/rounds/{t.Round}/draws");

        Assert.Equal(HttpStatusCode.OK, proxy.StatusCode);
        Assert.Equal(("held", t.Starter.PlayerId), await Where(InstanceOf(await Json(draw))!.Value));
        Assert.Equal("redirected", await Outcome(cast));
    }
}
