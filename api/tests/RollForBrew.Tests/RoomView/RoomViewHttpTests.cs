using System.Net;
using System.Net.Http.Json;
using System.Text.Json;
using RollForBrew.Tests.Harness;

namespace RollForBrew.Tests.RoomView;

/// <summary>Seam 3: GET /rooms/{id}/view over the real API and a real schema, as the rfb_api role.</summary>
public class RoomViewHttpTests(ApiHost api) : IClassFixture<ApiHost>
{
    private static int _n;
    private static string Sub(string stem) => $"{stem}-{Interlocked.Increment(ref _n)}";

    private async Task<Guid> NewRoom(long version = 0)
    {
        var id = Guid.NewGuid();
        var n = Interlocked.Increment(ref _n);
        await api.Db.Execute($"insert into public.rooms (id, date, version) values ('{id}', date '2031-01-01' + {n}, {version})");
        return id;
    }

    private Task Join(Guid room, TestUser u, int modifier = 0) =>
        api.Db.Execute($"insert into public.room_players (room_id, player_id, modifier) values ('{room}', '{u.PlayerId}', {modifier})");

    private async Task<Guid> NewRound(Guid room, string status, TestUser starter, int layer = 0)
    {
        var id = Guid.NewGuid();
        var closed = status == "open" ? "null" : "now()";
        await api.Db.Execute($"""
            insert into public.rounds (id, room_id, started_by, status, started_at, closed_at, current_layer)
            values ('{id}', '{room}', '{starter.PlayerId}', '{status}', now(), {closed}, {layer})
            """);
        return id;
    }

    private Task Declare(Guid round, TestUser u) =>
        api.Db.Execute($"insert into public.round_participants (round_id, player_id) values ('{round}', '{u.PlayerId}')");

    private Task Roll(Guid round, TestUser u, int value, int layer = 0) =>
        api.Db.Execute($"""
            insert into public.rolls (round_id, player_id, layer, value, input_mode, modifier_snapshot)
            values ('{round}', '{u.PlayerId}', {layer}, {value}, 'in_app', 0)
            """);

    private async Task<(HttpResponseMessage Res, JsonElement Body)> View(TestUser as_, Guid room, string query = "")
    {
        var res = await api.Client(api.Token(as_)).GetAsync($"/rooms/{room}/view{query}");
        var body = res.Content.Headers.ContentType?.MediaType is "application/json" or "application/problem+json"
            ? await res.Content.ReadFromJsonAsync<JsonElement>()
            : default;
        return (res, body);
    }

    [Fact]
    public async Task Requires_a_token()
    {
        var res = await api.Client().GetAsync($"/rooms/{Guid.NewGuid()}/view");
        Assert.Equal(HttpStatusCode.Unauthorized, res.StatusCode);
    }

    [Fact]
    public async Task Unknown_room_is_a_404_problem()
    {
        var u = await api.Db.AddUser(Sub("g-nf"));
        var (res, body) = await View(u, Guid.NewGuid());
        Assert.Equal(HttpStatusCode.NotFound, res.StatusCode);
        Assert.Equal("room_not_found", body.GetProperty("code").GetString());
    }

    [Fact]
    public async Task Idle_room_returns_version_room_and_viewer_with_no_store()
    {
        var ann = await api.Db.AddUser(Sub("g-ann"));
        var bob = await api.Db.AddUser(Sub("g-bob"));
        var room = await NewRoom(version: 5);
        await Join(room, ann, 2);
        await Join(room, bob, 1);

        var (res, body) = await View(ann, room);

        Assert.Equal(HttpStatusCode.OK, res.StatusCode);
        Assert.Contains("no-store", res.Headers.CacheControl!.ToString());
        Assert.Equal(5, body.GetProperty("version").GetInt64());
        Assert.Equal(room, body.GetProperty("room").GetProperty("roomId").GetGuid());
        Assert.Equal(new[] { ann.PlayerId, bob.PlayerId },
            body.GetProperty("room").GetProperty("roster").EnumerateArray().Select(r => r.GetProperty("playerId").GetString()));
        Assert.Equal(JsonValueKind.Null, body.GetProperty("room").GetProperty("activeRound").ValueKind);
        var v = body.GetProperty("viewer");
        Assert.Equal(ann.PlayerId, v.GetProperty("playerId").GetString());
        Assert.True(v.GetProperty("canStartRound").GetBoolean());
        Assert.True(v.GetProperty("panels").GetProperty("idleRoom").GetBoolean());
    }

    [Fact]
    public async Task Open_round_shows_whos_in_and_the_close_gate()
    {
        var ann = await api.Db.AddUser(Sub("g-ann"));
        var bob = await api.Db.AddUser(Sub("g-bob"));
        var room = await NewRoom();
        await Join(room, ann);
        await Join(room, bob);
        var round = await NewRound(room, "open", ann);
        await Declare(round, ann);

        var (_, asAnn) = await View(ann, room);
        Assert.Equal("open", asAnn.GetProperty("room").GetProperty("activeRound").GetProperty("status").GetString());
        Assert.True(asAnn.GetProperty("viewer").GetProperty("isStarter").GetBoolean());
        Assert.Equal(1, asAnn.GetProperty("viewer").GetProperty("needMoreToClose").GetInt32());

        var (_, asBob) = await View(bob, room);
        Assert.True(asBob.GetProperty("viewer").GetProperty("canDeclare").GetBoolean());
        Assert.True(asBob.GetProperty("viewer").GetProperty("panels").GetProperty("whosIn").GetBoolean());
    }

    [Fact]
    public async Task Closed_round_hides_other_players_roll_values()
    {
        var ann = await api.Db.AddUser(Sub("g-ann"));
        var bob = await api.Db.AddUser(Sub("g-bob"));
        var room = await NewRoom();
        await Join(room, ann);
        await Join(room, bob);
        var round = await NewRound(room, "closed", ann);
        await Declare(round, ann);
        await Declare(round, bob);
        await Roll(round, ann, 6);
        await Roll(round, bob, 19);

        var (res, body) = await View(ann, room);
        Assert.Equal(HttpStatusCode.OK, res.StatusCode);
        var text = body.GetRawText();
        Assert.Equal(6, body.GetProperty("viewer").GetProperty("ownRoll").GetInt32());
        Assert.Equal(new[] { ann.PlayerId, bob.PlayerId }.Order(),
            body.GetProperty("room").GetProperty("activeRound").GetProperty("rolledPlayerIds").EnumerateArray().Select(x => x.GetString()).Order());
        Assert.DoesNotContain("19", System.Text.RegularExpressions.Regex.Matches(text, @"(?<![\w-])19(?![\w-])").Select(m => m.Value));
        // Their numbers must not appear as a bare JSON number anywhere in the document.
        Assert.False(Leaves(body).Contains(19), "bob's roll leaked into ann's view");
    }

    private static IEnumerable<long> Leaves(JsonElement e)
    {
        switch (e.ValueKind)
        {
            case JsonValueKind.Number when e.TryGetInt64(out var n): yield return n; break;
            case JsonValueKind.Object: foreach (var p in e.EnumerateObject()) foreach (var n in Leaves(p.Value)) yield return n; break;
            case JsonValueKind.Array: foreach (var i in e.EnumerateArray()) foreach (var n in Leaves(i)) yield return n; break;
        }
    }

    [Fact]
    public async Task Turn_to_roll_comes_from_the_expected_roller_bridge()
    {
        var ann = await api.Db.AddUser(Sub("g-ann"));
        var bob = await api.Db.AddUser(Sub("g-bob"));
        var room = await NewRoom();
        await Join(room, ann);
        await Join(room, bob);
        var round = await NewRound(room, "closed", ann);
        await Declare(round, ann);
        await Declare(round, bob);

        var (_, before) = await View(bob, room);
        var v = before.GetProperty("viewer");
        Assert.True(v.GetProperty("isPlayersTurnToRoll").GetBoolean());
        Assert.True(v.GetProperty("needsRollInput").GetBoolean());
        Assert.Equal("in_app_only", v.GetProperty("rollInputMode").GetString());

        await Roll(round, bob, 11);
        var (_, after) = await View(bob, room);
        Assert.False(after.GetProperty("viewer").GetProperty("isPlayersTurnToRoll").GetBoolean());
        Assert.NotNull(after.GetProperty("room").GetProperty("nextStallDeadline").GetString());
    }

    [Fact]
    public async Task Tie_layer_reads_work_through_the_bridges()
    {
        var ann = await api.Db.AddUser(Sub("g-ann"));
        var bob = await api.Db.AddUser(Sub("g-bob"));
        var room = await NewRoom();
        await Join(room, ann);
        await Join(room, bob);
        var round = await NewRound(room, "closed", ann, layer: 1);
        await Declare(round, ann);
        await Declare(round, bob);
        await Roll(round, ann, 7);
        await Roll(round, bob, 7);
        await api.Db.Execute($"insert into public.round_layer_participants (round_id, layer, player_id) values ('{round}', 1, '{bob.PlayerId}'), ('{round}', 1, '{ann.PlayerId}')");

        var (res, body) = await View(bob, room);
        Assert.Equal(HttpStatusCode.OK, res.StatusCode);
        Assert.True(body.GetProperty("room").GetProperty("activeRound").GetProperty("isTiePhase").GetBoolean());
        Assert.Equal(2, body.GetProperty("room").GetProperty("activeRound").GetProperty("tiedParticipants").GetArrayLength());
        Assert.True(body.GetProperty("viewer").GetProperty("panels").GetProperty("tieBanner").GetBoolean());
        Assert.True(body.GetProperty("viewer").GetProperty("isPlayersTurnToRoll").GetBoolean());
        Assert.Equal(7, body.GetProperty("viewer").GetProperty("layerZeroOwnRoll").GetInt32());
    }

    [Fact]
    public async Task Hands_are_holder_only()
    {
        var ann = await api.Db.AddUser(Sub("g-ann"));
        var bob = await api.Db.AddUser(Sub("g-bob"));
        var room = await NewRoom();
        await Join(room, ann);
        await Join(room, bob);
        var annCard = Guid.NewGuid();
        var bobCard = Guid.NewGuid();
        await api.Db.Execute($"""
            insert into public.spell_deck_instances (id, card_id, location, held_by_player)
            select '{annCard}', id, 'held', '{ann.PlayerId}' from (select id from public.spell_cards order by name limit 1) c;
            insert into public.spell_deck_instances (id, card_id, location, held_by_player)
            select '{bobCard}', id, 'held', '{bob.PlayerId}' from (select id from public.spell_cards order by name desc limit 1) c;
            """);

        var (_, asAnn) = await View(ann, room);
        var annHeld = asAnn.GetProperty("viewer").GetProperty("heldCards");
        Assert.Equal(annCard, Assert.Single(annHeld.EnumerateArray()).GetProperty("instanceId").GetGuid());
        Assert.DoesNotContain(bobCard.ToString(), asAnn.GetRawText());

        var (_, asBob) = await View(bob, room);
        Assert.Equal(bobCard, Assert.Single(asBob.GetProperty("viewer").GetProperty("heldCards").EnumerateArray()).GetProperty("instanceId").GetGuid());
        Assert.DoesNotContain(annCard.ToString(), asBob.GetRawText());
    }

    [Fact]
    public async Task Ratings_are_rater_only_and_rateable_is_the_latest_non_brewer_round()
    {
        var ann = await api.Db.AddUser(Sub("g-ann"));
        var bob = await api.Db.AddUser(Sub("g-bob"));
        var cat = await api.Db.AddUser(Sub("g-cat"));
        var room = await NewRoom();
        await Join(room, ann);
        await Join(room, bob);
        await Join(room, cat);
        var round = Guid.NewGuid();
        await api.Db.Execute($"""
            insert into public.rounds (id, room_id, started_by, status, started_at, closed_at, resolved_at, brewer_id, cups_made)
            values ('{round}', '{room}', '{ann.PlayerId}', 'resolved', now() - interval '10 minutes', now() - interval '9 minutes', now() - interval '5 minutes', '{cat.PlayerId}', 3);
            """);
        await Declare(round, ann);
        await Declare(round, bob);
        await Declare(round, cat);
        await api.Db.Execute($"""
            insert into public.brew_ratings (round_id, brewer_id, rater_player_id, score) values
              ('{round}', '{cat.PlayerId}', '{ann.PlayerId}', 4), ('{round}', '{cat.PlayerId}', '{bob.PlayerId}', 1);
            """);

        var (_, asAnn) = await View(ann, room);
        var rate = asAnn.GetProperty("viewer").GetProperty("rateableRound");
        Assert.Equal(round, rate.GetProperty("roundId").GetGuid());
        Assert.Equal(4, rate.GetProperty("myScore").GetInt32());
        Assert.False(Leaves(asAnn).Contains(1) && asAnn.GetProperty("viewer").GetRawText().Contains("\"myScore\":1"));

        var (_, asCat) = await View(cat, room); // the brewer cannot rate their own round
        Assert.Equal(JsonValueKind.Null, asCat.GetProperty("viewer").GetProperty("rateableRound").ValueKind);

        var history = asAnn.GetProperty("room").GetProperty("history");
        Assert.Equal(round, Assert.Single(history.EnumerateArray()).GetProperty("roundId").GetGuid());
    }

    [Fact]
    public async Task Viewer_is_the_acting_as_player_in_the_test_room_and_never_client_supplied()
    {
        var admin = await api.Db.AddUser(Sub("g-admin"), admin: true);
        var target = await api.Db.AddUser(Sub("g-target"));
        var other = await api.Db.AddUser(Sub("g-other"));
        var testRoom = await api.Db.Scalar<Guid>("select id from public.rooms where is_test");
        await Join(testRoom, admin);
        await Join(testRoom, target);
        await Join(testRoom, other);
        await api.Db.Execute($"insert into public.admin_acting_as (admin_player_id, acting_as_player_id) values ('{admin.PlayerId}', '{target.PlayerId}')");

        // The client tries every channel it has to be someone else; none of it is read.
        var req = new HttpRequestMessage(HttpMethod.Get, $"/rooms/{testRoom}/view?viewer={other.PlayerId}&playerId={other.PlayerId}&actingAs={other.PlayerId}");
        req.Headers.Authorization = new("Bearer", api.Token(admin));
        req.Headers.Add("X-Acting-As", other.PlayerId);
        var res = await api.Factory.CreateClient().SendAsync(req);
        Assert.Equal(HttpStatusCode.OK, res.StatusCode);
        var body = await res.Content.ReadFromJsonAsync<JsonElement>();
        Assert.Equal(target.PlayerId, body.GetProperty("viewer").GetProperty("playerId").GetString());

        // A normal room is not affected by the pointer.
        var room = await NewRoom();
        await Join(room, admin);
        var (_, real) = await View(admin, room);
        Assert.Equal(admin.PlayerId, real.GetProperty("viewer").GetProperty("playerId").GetString());
    }

    [Fact]
    public async Task Orders_menu_settings_and_pending_replay_come_from_direct_reads()
    {
        var ann = await api.Db.AddUser(Sub("g-ann"));
        var bob = await api.Db.AddUser(Sub("g-bob"));
        var room = await NewRoom();
        await Join(room, ann);
        await Join(room, bob);
        var round = await NewRound(room, "open", ann);
        await Declare(round, ann);
        await Declare(round, bob);
        await api.Db.Execute($"""
            insert into public.orders (round_id, player_id, drink_type) values ('{round}', '{bob.PlayerId}', 'coffee');
            insert into public.player_settings (player_id, roll_input_mode) values ('{ann.PlayerId}', 'both');
            """);

        var (_, asAnn) = await View(ann, room);
        var v = asAnn.GetProperty("viewer");
        Assert.Equal(round, v.GetProperty("orderRoundId").GetGuid());
        Assert.True(v.GetProperty("orderCue").GetBoolean());
        var menu = Assert.Single(v.GetProperty("menu").EnumerateArray());
        Assert.Equal(bob.PlayerId, menu.GetProperty("playerId").GetString());
        Assert.Equal("coffee", menu.GetProperty("drinkType").GetString());
        Assert.True(menu.GetProperty("noPreferenceSet").GetBoolean());

        var (_, asBob) = await View(bob, room);
        Assert.Equal("coffee", asBob.GetProperty("viewer").GetProperty("myOrderForRound").GetString());
        Assert.False(asBob.GetProperty("viewer").GetProperty("orderCue").GetBoolean());

        // A pending Round Replay decision rides along for everyone; only the caster is flagged.
        await api.Db.Execute($"update public.rounds set status = 'resolved', resolved_at = now(), brewer_id = '{bob.PlayerId}', cups_made = 2 where id = '{round}'");
        await api.Db.Execute($"insert into public.pending_round_replay (round_id, room_id, caster_id) values ('{round}', '{room}', '{ann.PlayerId}')");
        var (_, replay) = await View(ann, room);
        Assert.True(replay.GetProperty("viewer").GetProperty("pendingRoundReplay").GetProperty("isCaster").GetBoolean());
        Assert.True(replay.GetProperty("viewer").GetProperty("panels").GetProperty("roundReplayPrompt").GetBoolean());
        Assert.NotNull(replay.GetProperty("room").GetProperty("nextStallDeadline").GetString());
    }

    [Fact]
    public async Task Version_follows_the_rooms_column()
    {
        var u = await api.Db.AddUser(Sub("g-ver"));
        var room = await NewRoom(version: 41);
        await Join(room, u);
        Assert.Equal(41, (await View(u, room)).Body.GetProperty("version").GetInt64());
        await api.Db.Execute($"update public.rooms set version = version + 1 where id = '{room}'");
        Assert.Equal(42, (await View(u, room)).Body.GetProperty("version").GetInt64());
    }
}
