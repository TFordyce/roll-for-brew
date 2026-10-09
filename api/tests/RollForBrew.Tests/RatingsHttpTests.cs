using System.Net;
using System.Net.Http.Json;
using System.Text.Json;
using RollForBrew.Tests.Harness;

namespace RollForBrew.Tests;

public class RatingsHttpTests(ApiHost api) : IClassFixture<ApiHost>
{
    private static int _seq;

    private sealed record Scene(Guid Room, Guid Round, TestUser Brewer, TestUser Rater, TestUser Other);

    private async Task<TestUser> User(string tag) => await api.Db.AddUser($"{tag}-{Interlocked.Increment(ref _seq)}");

    /// <summary>A room with one resolved round; brewer plus two non-brewer participants.</summary>
    private async Task<Scene> Resolved(int dayOffset = 0, bool testRoom = false)
    {
        var n = Interlocked.Increment(ref _seq);
        var brewer = await User("brewer");
        var rater = await User("rater");
        var other = await User("other");
        var room = Guid.NewGuid();
        var round = Guid.NewGuid();
        await api.Db.Execute($"""
            insert into public.rooms (id, date, is_test) values ('{room}', date '2030-01-01' + {n + dayOffset}, {(testRoom ? "true" : "false")});
            insert into public.rounds (id, room_id, started_by, status, resolved_at, brewer_id)
              values ('{round}', '{room}', '{brewer.PlayerId}', 'resolved', now() - interval '1 hour', '{brewer.PlayerId}');
            insert into public.round_participants (round_id, player_id) values
              ('{round}', '{brewer.PlayerId}'), ('{round}', '{rater.PlayerId}'), ('{round}', '{other.PlayerId}');
            """);
        return new Scene(room, round, brewer, rater, other);
    }

    private Task<HttpResponseMessage> Rate(TestUser u, Guid round, int? score) =>
        api.Client(api.Token(u)).PutAsJsonAsync($"/brew-ratings/{round}", new { score });

    private static async Task<string> Code(HttpResponseMessage res) =>
        (await res.Content.ReadFromJsonAsync<JsonElement>()).GetProperty("code").GetString()!;

    private async Task<int?> Mine(TestUser u, string path)
    {
        var res = await api.Client(api.Token(u)).GetAsync(path);
        Assert.Equal(HttpStatusCode.OK, res.StatusCode);
        var s = (await res.Content.ReadFromJsonAsync<JsonElement>()).GetProperty("score");
        return s.ValueKind == JsonValueKind.Null ? null : s.GetInt32();
    }

    [Fact]
    public async Task Requires_a_token()
    {
        var res = await api.Client().PutAsJsonAsync($"/brew-ratings/{Guid.NewGuid()}", new { score = 3 });
        Assert.Equal(HttpStatusCode.Unauthorized, res.StatusCode);
    }

    [Fact]
    public async Task Submit_then_resubmit_overwrites_one_row()
    {
        var s = await Resolved();
        var first = await Rate(s.Rater, s.Round, 2);
        Assert.Equal(HttpStatusCode.OK, first.StatusCode);
        var id1 = (await first.Content.ReadFromJsonAsync<JsonElement>()).GetProperty("id").GetGuid();
        var id2 = (await (await Rate(s.Rater, s.Round, 5)).Content.ReadFromJsonAsync<JsonElement>()).GetProperty("id").GetGuid();
        Assert.Equal(id1, id2);
        Assert.Equal(1, await api.Db.Scalar<long>($"select count(*) from public.brew_ratings where round_id = '{s.Round}'"));
        Assert.Equal(5, await Mine(s.Rater, $"/brew-ratings/{s.Round}/mine"));
        Assert.Equal(s.Brewer.PlayerId, await api.Db.Scalar<string>($"select brewer_id from public.brew_ratings where id = '{id1}'"));
    }

    [Theory]
    [InlineData(0)]
    [InlineData(6)]
    [InlineData(null)]
    public async Task Score_out_of_range_is_RFB22(int? score)
    {
        var s = await Resolved();
        var res = await Rate(s.Rater, s.Round, score);
        Assert.Equal(HttpStatusCode.BadRequest, res.StatusCode);
        Assert.Equal("brew_rating_score_out_of_range", await Code(res));
    }

    [Fact]
    public async Task Unknown_or_unresolved_round_is_RFB23()
    {
        var s = await Resolved();
        var unknown = await Rate(s.Rater, Guid.NewGuid(), 3);
        Assert.Equal(HttpStatusCode.NotFound, unknown.StatusCode);
        Assert.Equal("brew_rating_round_not_rateable", await Code(unknown));

        var open = Guid.NewGuid();
        await api.Db.Execute($"insert into public.rounds (id, room_id, started_by, status) values ('{open}', '{s.Room}', '{s.Brewer.PlayerId}', 'open')");
        Assert.Equal("brew_rating_round_not_rateable", await Code(await Rate(s.Rater, open, 3)));
    }

    [Fact]
    public async Task Non_participant_is_RFB24_and_brewer_is_RFB25()
    {
        var s = await Resolved();
        var outsider = await User("outsider");
        var np = await Rate(outsider, s.Round, 3);
        Assert.Equal(HttpStatusCode.Forbidden, np.StatusCode);
        Assert.Equal("brew_rating_not_participant", await Code(np));

        var self = await Rate(s.Brewer, s.Round, 3);
        Assert.Equal((HttpStatusCode)422, self.StatusCode);
        Assert.Equal("brew_rating_self", await Code(self));
    }

    [Fact]
    public async Task Newer_resolved_round_in_same_room_closes_the_window_RFB27()
    {
        var s = await Resolved();
        await api.Db.Execute($"""
            insert into public.rounds (room_id, started_by, status, resolved_at, brewer_id)
              values ('{s.Room}', '{s.Brewer.PlayerId}', 'resolved', now(), '{s.Brewer.PlayerId}');
            """);
        var res = await Rate(s.Rater, s.Round, 4);
        Assert.Equal(HttpStatusCode.Conflict, res.StatusCode);
        Assert.Equal("brew_rating_window_closed", await Code(res));
    }

    [Fact]
    public async Task Newer_own_non_brewer_round_elsewhere_is_RFB26()
    {
        var s = await Resolved();
        var later = Guid.NewGuid();
        var room2 = Guid.NewGuid();
        var n = Interlocked.Increment(ref _seq);
        await api.Db.Execute($"""
            insert into public.rooms (id, date) values ('{room2}', date '2031-01-01' + {n});
            insert into public.rounds (id, room_id, started_by, status, resolved_at, brewer_id)
              values ('{later}', '{room2}', '{s.Brewer.PlayerId}', 'resolved', now(), '{s.Brewer.PlayerId}');
            insert into public.round_participants (round_id, player_id) values ('{later}', '{s.Rater.PlayerId}');
            """);
        var res = await Rate(s.Rater, s.Round, 4);
        Assert.Equal((HttpStatusCode)422, res.StatusCode);
        Assert.Equal("brew_rating_not_most_recent", await Code(res));
    }

    [Fact]
    public async Task Withdraw_removes_only_own_rating_and_is_a_noop_when_absent()
    {
        var s = await Resolved();
        await Rate(s.Rater, s.Round, 3);
        await Rate(s.Other, s.Round, 1);

        var del = await api.Client(api.Token(s.Rater)).DeleteAsync($"/brew-ratings/{s.Round}");
        Assert.Equal(HttpStatusCode.NoContent, del.StatusCode);
        Assert.Null(await Mine(s.Rater, $"/brew-ratings/{s.Round}/mine"));
        Assert.Equal(1, await Mine(s.Other, $"/brew-ratings/{s.Round}/mine"));

        var again = await api.Client(api.Token(s.Rater)).DeleteAsync($"/brew-ratings/{s.Round}");
        Assert.Equal(HttpStatusCode.NoContent, again.StatusCode);
    }

    [Fact]
    public async Task Withdraw_after_window_closed_is_RFB27_and_unknown_round_RFB23()
    {
        var s = await Resolved();
        await Rate(s.Rater, s.Round, 3);
        await api.Db.Execute($"""
            insert into public.rounds (room_id, started_by, status, resolved_at, brewer_id)
              values ('{s.Room}', '{s.Brewer.PlayerId}', 'resolved', now(), '{s.Brewer.PlayerId}');
            """);
        var c = api.Client(api.Token(s.Rater));
        Assert.Equal("brew_rating_window_closed", await Code(await c.DeleteAsync($"/brew-ratings/{s.Round}")));
        Assert.Equal("brew_rating_round_not_rateable", await Code(await c.DeleteAsync($"/brew-ratings/{Guid.NewGuid()}")));
        Assert.Equal(3, await Mine(s.Rater, $"/brew-ratings/{s.Round}/mine"));
    }

    [Fact]
    public async Task Brew_rating_secrecy_the_brewer_and_others_never_see_a_score()
    {
        var s = await Resolved();
        await Rate(s.Rater, s.Round, 4);
        Assert.Null(await Mine(s.Brewer, $"/brew-ratings/{s.Round}/mine"));
        Assert.Null(await Mine(s.Other, $"/brew-ratings/{s.Round}/mine"));

        // Nothing in the request can name another rater.
        var c = api.Client(api.Token(s.Brewer));
        c.DefaultRequestHeaders.Add("X-Rater-Player-Id", s.Rater.PlayerId);
        var res = await c.GetAsync($"/brew-ratings/{s.Round}/mine?raterPlayerId={s.Rater.PlayerId}");
        var body = await res.Content.ReadAsStringAsync();
        Assert.DoesNotContain(s.Rater.PlayerId, body);
        Assert.Equal(JsonValueKind.Null, JsonDocument.Parse(body).RootElement.GetProperty("score").ValueKind);
    }

    // ---- Spell card ratings ----

    private async Task<(Guid Card, TestUser Caster, TestUser Stranger)> CastCard(bool negated = false, bool testRoom = false, string status = "resolved")
    {
        var s = await Resolved(testRoom: testRoom);
        if (status != "resolved") await api.Db.Execute($"update public.rounds set status = '{status}' where id = '{s.Round}'");
        var card = Guid.NewGuid();
        var inst = Guid.NewGuid();
        await api.Db.Execute($"""
            insert into public.spell_cards (id, name, casting_time, target, tier, effect_text)
              values ('{card}', 'card-{card}', 'A', 'SELF', 'common', 'x');
            insert into public.spell_deck_instances (id, card_id) values ('{inst}', '{card}');
            insert into public.spell_casts (round_id, caster_id, card_instance_id, negated)
              values ('{s.Round}', '{s.Rater.PlayerId}', '{inst}', {(negated ? "true" : "false")});
            """);
        return (card, s.Rater, s.Other);
    }

    private Task<HttpResponseMessage> RateCard(TestUser u, Guid card, int? score) =>
        api.Client(api.Token(u)).PutAsJsonAsync($"/spell-card-ratings/{card}", new { score });

    [Fact]
    public async Task Spell_card_rate_upserts_and_reads_back()
    {
        var (card, caster, _) = await CastCard();
        var a = await RateCard(caster, card, 2);
        Assert.Equal(HttpStatusCode.OK, a.StatusCode);
        var id1 = (await a.Content.ReadFromJsonAsync<JsonElement>()).GetProperty("id").GetGuid();
        var id2 = (await (await RateCard(caster, card, 4)).Content.ReadFromJsonAsync<JsonElement>()).GetProperty("id").GetGuid();
        Assert.Equal(id1, id2);
        Assert.Equal(4, await Mine(caster, $"/spell-card-ratings/{card}/mine"));
    }

    [Fact]
    public async Task Spell_card_errors_RFB41_42_43()
    {
        var (card, caster, stranger) = await CastCard();
        var bad = await RateCard(caster, card, 9);
        Assert.Equal("card_rating_score_out_of_range", await Code(bad));
        Assert.Equal(HttpStatusCode.BadRequest, bad.StatusCode);

        var missing = await RateCard(caster, Guid.NewGuid(), 3);
        Assert.Equal(HttpStatusCode.NotFound, missing.StatusCode);
        Assert.Equal("card_not_found", await Code(missing));

        var nocast = await RateCard(stranger, card, 3);
        Assert.Equal(HttpStatusCode.Forbidden, nocast.StatusCode);
        Assert.Equal("card_rating_no_eligible_cast", await Code(nocast));
    }

    [Fact]
    public async Task Negated_test_room_and_unresolved_casts_are_not_eligible()
    {
        var (c1, u1, _) = await CastCard(negated: true);
        Assert.Equal("card_rating_no_eligible_cast", await Code(await RateCard(u1, c1, 3)));
        var (c2, u2, _) = await CastCard(testRoom: true);
        Assert.Equal("card_rating_no_eligible_cast", await Code(await RateCard(u2, c2, 3)));
        var (c3, u3, _) = await CastCard(status: "cancelled");
        Assert.Equal("card_rating_no_eligible_cast", await Code(await RateCard(u3, c3, 3)));
    }

    [Fact]
    public async Task Spell_card_withdraw_needs_no_eligibility_and_is_own_only()
    {
        var (card, caster, stranger) = await CastCard();
        await RateCard(caster, card, 5);
        // Losing the qualifying cast must not trap the rating.
        await api.Db.Execute("delete from public.spell_casts");

        // Another player's withdraw cannot touch it.
        Assert.Equal(HttpStatusCode.NoContent, (await api.Client(api.Token(stranger)).DeleteAsync($"/spell-card-ratings/{card}")).StatusCode);
        Assert.Equal(5, await Mine(caster, $"/spell-card-ratings/{card}/mine"));

        Assert.Equal(HttpStatusCode.NoContent, (await api.Client(api.Token(caster)).DeleteAsync($"/spell-card-ratings/{card}")).StatusCode);
        Assert.Null(await Mine(caster, $"/spell-card-ratings/{card}/mine"));
    }

    [Fact]
    public async Task Spell_card_secrecy_other_players_see_null()
    {
        var (card, caster, stranger) = await CastCard();
        await RateCard(caster, card, 5);
        Assert.Null(await Mine(stranger, $"/spell-card-ratings/{card}/mine"));
    }
}
