using System.Diagnostics;
using Npgsql;
using RollForBrew.Api.Auth;
using RollForBrew.Api.Data;
using RollForBrew.Domain.Liveness;
using RollForBrew.Tests.Harness;

namespace RollForBrew.Tests;

public class RoundSnapshotLoaderTests : IAsyncLifetime
{
    private TestDatabase _db = null!;
    private NpgsqlDataSource _ds = null!;
    private RoomStore _store = null!;
    private TestUser _user = null!;

    public async Task InitializeAsync()
    {
        _db = await TestPostgres.CreateDatabase();
        _ds = RoomStore.BuildDataSource(_db.ApiConnectionString);
        _store = new RoomStore(_ds);
        _user = await _db.AddUser("g-snap");
    }

    public async Task DisposeAsync()
    {
        await _ds.DisposeAsync();
        await _db.DisposeAsync();
    }

    private Caller Caller => new(_user.AuthId.ToString(), $$"""{"sub":"{{_user.AuthId}}","role":"authenticated"}""");

    private const string RoomA = "00000000-0000-4000-8000-00000000000a";
    private const string RoomB = "00000000-0000-4000-8000-00000000000b";
    private const string EarlierRound = "00000000-0000-4000-8000-0000000000e1";
    private const string NowRound = "00000000-0000-4000-8000-0000000000e2";
    private const string Cast = "00000000-0000-4000-8000-0000000000c1";
    private const string Effect = "00000000-0000-4000-8000-0000000000f1";
    private const string Unrelated = "00000000-0000-4000-8000-0000000000f2";

    /// <summary>Room B (today) with a carried 3-round effect cast in Room A (earlier day); an unrelated third room stays out.</summary>
    private async Task Seed()
    {
        await _db.Execute($$"""
            insert into public.players (id, email) values ('g-other', 'o@example.test');
            insert into public.rooms (id, date) values ('{{RoomA}}', '2026-01-01'), ('{{RoomB}}', '2026-01-02'),
                                                       ('00000000-0000-4000-8000-0000000000dd', '2026-01-03');
            insert into public.rounds (id, room_id, started_by, status, started_at) values
              ('{{EarlierRound}}', '{{RoomA}}', 'g-snap', 'resolved', '2026-01-01 09:00+00'),
              ('{{NowRound}}',     '{{RoomB}}', 'g-snap', 'open',     '2026-01-02 09:00+00'),
              ('00000000-0000-4000-8000-0000000000e3', '00000000-0000-4000-8000-0000000000dd', 'g-other', 'resolved', '2026-01-03 09:00+00');
            insert into public.round_participants (round_id, player_id) values
              ('{{EarlierRound}}', 'g-snap'), ('{{EarlierRound}}', 'g-other'), ('{{NowRound}}', 'g-snap'),
              ('00000000-0000-4000-8000-0000000000e3', 'g-other');
            insert into public.room_players (room_id, player_id, modifier) values ('{{RoomB}}', 'g-snap', 2);
            insert into public.spell_deck_instances (id, card_id, location, held_by_player)
              select '00000000-0000-4000-8000-0000000000d1', id, 'held', 'g-snap' from public.spell_cards limit 1;
            insert into public.spell_casts (id, round_id, caster_id, card_instance_id, target_player_id, effect_kind, effect_params)
              values ('{{Cast}}', '{{EarlierRound}}', 'g-other', '00000000-0000-4000-8000-0000000000d1', 'g-snap', 'flat_modifier', '{}');
            insert into public.spell_active_effects (id, room_id, target_player_id, caster_id, source_cast_id, card_id, effect_kind, rounds_remaining)
              select '{{Effect}}', '{{RoomA}}', 'g-snap', 'g-other', '{{Cast}}', card_id, 'flat_modifier', 3
                from public.spell_deck_instances where id = '00000000-0000-4000-8000-0000000000d1';
            insert into public.spell_active_effects (id, room_id, target_player_id, caster_id, source_cast_id, card_id, effect_kind)
              select '{{Unrelated}}', '{{RoomA}}', 'g-other', 'g-other', '{{Cast}}', card_id, 'flat_modifier'
                from public.spell_deck_instances where id = '00000000-0000-4000-8000-0000000000d1';
            """);
    }

    [Fact]
    public async Task Loads_a_rooms_whole_state_including_bounded_carried_effects()
    {
        await Seed();
        var snap = await _store.Read(Caller, s => s.Load(Guid.Parse(RoomB)));

        Assert.Equal(Guid.Parse(RoomB), snap.RoomId);
        Assert.Equal(2, snap.Rounds.Count);                          // today's + the earlier-room round g-snap took part in
        Assert.DoesNotContain(snap.Rounds, r => r.Id == Guid.Parse("00000000-0000-4000-8000-0000000000e3"));
        Assert.Equal(2, snap.Rooms.Count);
        Assert.Single(snap.RoomPlayers);
        Assert.Equal(Guid.Parse(Cast), Assert.Single(snap.SpellCasts).Id);
        Assert.Equal(Guid.Parse(Effect), Assert.Single(snap.ActiveEffects).Id);   // carried (has a round count); the uncounted one stays home
        Assert.Single(snap.DeckInstances);
        Assert.NotEmpty(snap.SpellCards);
        Assert.NotEmpty(snap.SpellCardEffects);
        Assert.True(snap.DbNow > DateTimeOffset.UtcNow.AddMinutes(-5));
    }

    [Fact]
    public async Task Loaded_snapshot_answers_liveness_for_the_carried_effect()
    {
        await Seed();
        var snap = await _store.Read(Caller, s => s.Load(Guid.Parse(RoomB)));
        var live = ActiveEffects.AsOf(snap, snap.RoomId, Guid.Parse(NowRound));
        var one = Assert.Single(live);
        Assert.Equal(Guid.Parse(Effect), one.Id);
        Assert.Equal(snap.RoomId, one.RoomId);
    }

    [Fact]
    public async Task Load_is_a_single_round_trip()
    {
        await Seed();
        var commands = new List<string>();
        using var listener = new ActivityListener
        {
            ShouldListenTo = src => src.Name == "Npgsql",
            Sample = (ref ActivityCreationOptions<ActivityContext> _) => ActivitySamplingResult.AllDataAndRecorded,
            ActivityStopped = a =>
            {
                // The listener is process-wide: only count this test class's own database.
                if (a.GetTagItem("db.query.text") is string q && Equals(a.GetTagItem("db.namespace"), _db.Name)) commands.Add(q);
            },
        };
        ActivitySource.AddActivityListener(listener);

        var before = 0;
        await _store.Read(Caller, async s =>
        {
            before = commands.Count;
            return await s.Load(Guid.Parse(RoomB));
        });
        var during = commands.Skip(before).Where(q => q.Contains("jsonb_build_object")).ToList();
        Assert.Single(during);
        Assert.Equal(1, commands.Skip(before).Count(q => !q.StartsWith("select set_config")));
    }
}
