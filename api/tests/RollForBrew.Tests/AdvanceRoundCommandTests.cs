using System.Text.Json;
using Npgsql;
using RollForBrew.Api.Auth;
using RollForBrew.Api.Data;
using RollForBrew.Domain.Commands;
using RollForBrew.Domain.Dice;
using RollForBrew.Tests.Harness;

namespace RollForBrew.Tests;

/// <summary>Seam 2 for what SQL parity can't see: the broadcasts, each carrying the commit's
/// version in the shape the TS listeners read, and the round lock.</summary>
public class AdvanceRoundCommandTests : IAsyncLifetime
{
    private TestDatabase _db = null!;
    private NpgsqlDataSource _ds = null!;
    private RoomStore _store = null!;
    private Caller _caller = null!;
    private readonly Guid _room = Guid.NewGuid();
    private readonly Guid _round = Guid.NewGuid();

    public async Task InitializeAsync()
    {
        _db = await TestPostgres.CreateDatabase();
        _ds = RoomStore.BuildDataSource(_db.ApiConnectionString);
        _store = new RoomStore(_ds);
        var u = await _db.AddUser("p-a");
        _caller = new Caller(u.AuthId.ToString(), $$"""{"sub":"{{u.AuthId}}","role":"authenticated"}""");
    }

    public async Task DisposeAsync()
    {
        await _ds.DisposeAsync();
        await _db.DisposeAsync();
    }

    private Task Seed(int a = 17, int b = 6) => _db.Execute($"""
        insert into public.players (id, email) values ('p-b', 'b@x.test');
        insert into public.rooms (id, date) values ('{_room}', '2026-01-01');
        insert into public.rounds (id, room_id, started_by, status, started_at, closed_at) values
          ('{_round}', '{_room}', 'p-a', 'closed', '2026-01-01 09:00+00', '2026-01-01 09:01+00');
        insert into public.round_participants (round_id, player_id) values ('{_round}', 'p-a'), ('{_round}', 'p-b');
        insert into public.room_players (room_id, player_id, modifier) values ('{_room}', 'p-a', 0), ('{_room}', 'p-b', 0);
        insert into public.rolls (round_id, player_id, layer, value, input_mode, modifier_snapshot) values
          ('{_round}', 'p-a', 0, {a}, 'in_app', 0), ('{_round}', 'p-b', 0, {b}, 'in_app', 0);
        """);

    private Task<CommandOutcome<System.Text.Json.Nodes.JsonObject>> Advance(AdvanceRound.Entry entry = AdvanceRound.Entry.Advance)
    {
        var advance = new AdvanceRound(new NoDiceRoller());
        return _store.Command(_round, _caller, s => advance.Decide(s, _round, entry));
    }

    private async Task<List<(string Event, JsonElement Payload)>> Sent()
    {
        var json = await _db.Scalar<string>("select coalesce(jsonb_agg(jsonb_build_object('e', event, 'p', payload) order by seq), '[]')::text from realtime.messages");
        return [.. JsonDocument.Parse(json!).RootElement.EnumerateArray().Select(m => (m.GetProperty("e").GetString()!, m.GetProperty("p").Clone()))];
    }

    [Fact]
    public async Task A_window_that_closes_on_the_spot_reveals_the_raw_rolls_then_the_result_at_one_version()
    {
        await Seed();

        var outcome = await Advance();

        Assert.Equal(1, outcome.Version);
        var sent = await Sent();
        Assert.Equal(["layer-rolls-revealed", "round-revealed"], sent.Select(m => m.Event));

        var layerRolls = sent[0].Payload;
        Assert.Equal(_round.ToString(), layerRolls.GetProperty("roundId").GetString());
        Assert.Equal(0, layerRolls.GetProperty("layer").GetInt32());
        Assert.Equal(1, layerRolls.GetProperty("version").GetInt64());
        var roll = layerRolls.GetProperty("rolls")[0];
        Assert.Equal("p-a", roll.GetProperty("playerId").GetString());
        Assert.Equal(17, roll.GetProperty("value").GetInt32());
        Assert.Equal(JsonValueKind.Null, roll.GetProperty("discardedValue").ValueKind);
        Assert.False(roll.GetProperty("enteredByAdmin").GetBoolean());

        var revealed = sent[1].Payload;
        Assert.Equal("p-b", revealed.GetProperty("brewerId").GetString());
        Assert.Equal(2, revealed.GetProperty("cupsMade").GetInt32());
        Assert.Equal(1, revealed.GetProperty("version").GetInt64());
    }

    [Fact]
    public async Task A_tie_announces_the_new_layer_and_who_tied()
    {
        await Seed(a: 6, b: 6);
        await _db.Execute($"insert into public.spell_reaction_windows (round_id, layer, status, poll_round, opened_at, closed_at) values ('{_round}', 0, 'closed', 1, now(), now())");

        await Advance(AdvanceRound.Entry.Finalize);

        var (name, payload) = Assert.Single(await Sent());
        Assert.Equal("layer-tied", name);
        Assert.Equal(1, payload.GetProperty("layer").GetInt32());
        Assert.Equal(["p-a", "p-b"], payload.GetProperty("tiedPlayerIds").EnumerateArray().Select(p => p.GetString()));
    }

    [Fact]
    public async Task A_window_held_open_reveals_the_rolls_and_commits_the_window()
    {
        await Seed();
        await _db.Execute("""
            insert into public.spell_deck_instances (card_id, location, held_by_player)
              select id, 'held', 'p-a' from public.spell_cards where name = 'Six Sugars';
            """);

        var outcome = await Advance();

        Assert.Equal(1, outcome.Version);
        Assert.Equal(["layer-rolls-revealed"], (await Sent()).Select(m => m.Event));
        Assert.False((bool?)outcome.Result["window_closed"]);
        Assert.Equal("open", await _db.Scalar<string>($"select status from public.spell_reaction_windows where round_id = '{_round}'"));
    }

    [Fact]
    public async Task A_surviving_replay_also_sends_room_changed()
    {
        await Seed();
        await _db.Execute($$"""
            insert into public.spell_reaction_windows (round_id, layer, status, poll_round, opened_at, closed_at) values ('{{_round}}', 0, 'closed', 1, now(), now());
            insert into public.spell_deck_instances (id, card_id, location)
              select '40000000-0000-4000-8000-000000000001', id, 'in_deck' from public.spell_cards where name = 'Time for Brew';
            insert into public.spell_casts (round_id, caster_id, card_instance_id, effect_kind)
              values ('{{_round}}', 'p-a', '40000000-0000-4000-8000-000000000001', 'round_replay');
            """);

        var outcome = await Advance(AdvanceRound.Entry.Finalize);

        Assert.True((bool?)outcome.Result["replay_pending"]);
        Assert.Equal(["round-revealed", "room-changed"], (await Sent()).Select(m => m.Event));
    }

    [Fact]
    public async Task A_noop_sends_nothing()
    {
        await Seed();
        await _db.Execute($"delete from public.rolls where round_id = '{_round}' and player_id = 'p-a'");

        var outcome = await Advance();

        Assert.Equal("layer_incomplete", (string?)outcome.Result["reason"]);
        Assert.Null(outcome.Version);
        Assert.Empty(await Sent());
    }

    [Fact]
    public async Task Two_racing_calls_resolve_the_round_once()
    {
        await Seed();

        var outcomes = await Task.WhenAll(Advance(), Advance());

        Assert.Single(outcomes, o => (string?)o.Result["outcome"] == "windowOpened");
        Assert.Single(outcomes, o => (string?)o.Result["reason"] == "round_not_closed");
        Assert.Equal(1, await _db.Scalar<long>($"select version from public.rooms where id = '{_room}'"));
        Assert.Equal(2, await _db.Scalar<int>($"select modifier from public.room_players where room_id = '{_room}' and player_id = 'p-b'"));
        Assert.Equal(1L, await _db.Scalar<long>($"select count(*) from public.spell_reaction_windows where round_id = '{_round}'"));
    }
}
