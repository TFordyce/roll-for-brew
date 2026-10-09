using System.Text.Json;
using RollForBrew.Domain.Liveness;
using RollForBrew.Domain.Snapshot;

namespace RollForBrew.Tests;

public class ActiveEffectsTests
{
    private static readonly DateTimeOffset T0 = new(2026, 1, 1, 0, 0, 0, TimeSpan.Zero);
    private static int _n;
    private static Guid Id() => new(++_n, 0, 0, [0, 0, 0, 0, 0, 0, 0, 0]);
    private static JsonElement J(string json) => JsonDocument.Parse(json).RootElement.Clone();

    private sealed class World
    {
        public readonly Guid Room = Id();
        public readonly List<RoomRow> Rooms = [];
        public readonly List<RoundRow> Rounds = [];
        public readonly List<RoundParticipantRow> Parts = [];
        public readonly List<SpellCastRow> Casts = [];
        public readonly List<ActiveEffectRow> Effects = [];

        public World() => Rooms.Add(new RoomRow(Room, false));

        public Guid OtherRoom(bool isTest = false)
        {
            var id = Id();
            Rooms.Add(new RoomRow(id, isTest));
            return id;
        }

        public RoundRow Round(int minute, string status = "resolved", Guid? room = null, params string[] players)
        {
            var r = new RoundRow(Id(), room ?? Room, "a", status, T0.AddMinutes(minute), null, null, null, null, 0, 0, 0, [], null, null, null);
            Rounds.Add(r);
            foreach (var p in players) Parts.Add(new RoundParticipantRow(r.Id, p, T0, null));
            return r;
        }

        public SpellCastRow Cast(RoundRow round, string? kind = null, string? ep = null, string? ci = null, bool negated = false)
        {
            var c = new SpellCastRow(Id(), round.Id, "a", Id(), null, false, kind, ep is null ? null : J(ep), null, T0, null, negated,
                Casts.Count, null, ci is null ? null : J(ci), null, null, null, 0, null);
            Casts.Add(c);
            return c;
        }

        public ActiveEffectRow Effect(SpellCastRow src, Guid? room = null, string target = "t", string kind = "flat_modifier",
            string ep = "{}", int? remaining = null, int createdMinute = 0, bool undispellable = false, Guid? endedIn = null)
        {
            var e = new ActiveEffectRow(Id(), room ?? Room, target, "a", src.Id, Id(), kind, J(ep), remaining,
                T0.AddMinutes(createdMinute), undispellable, endedIn);
            Effects.Add(e);
            return e;
        }

        public IReadOnlyList<ActiveEffectRow> Live(RoundRow asOf, Guid? room = null) =>
            ActiveEffects.AsOf(new RoundSnapshot(Room, T0, Rooms, Rounds, Parts, [], [], Casts, Effects, [], [], [], [], []),
                room ?? Room, asOf.Id);
    }

    [Fact]
    public void Unbounded_effect_is_live()
    {
        var w = new World();
        var r1 = w.Round(0);
        var e = w.Effect(w.Cast(r1));
        var r2 = w.Round(10);
        Assert.Equal([e.Id], w.Live(r2).Select(x => x.Id));
    }

    [Fact]
    public void Negated_source_cast_is_not_live()
    {
        var w = new World();
        var r1 = w.Round(0);
        w.Effect(w.Cast(r1, negated: true));
        Assert.Empty(w.Live(w.Round(10)));
    }

    [Fact]
    public void Duration_runs_on_the_targets_participation_not_the_room()
    {
        var w = new World();
        var src = w.Round(0, "resolved", null, "t");
        var e = w.Effect(w.Cast(src), remaining: 3);
        w.Round(10, "resolved", null, "other");
        w.Round(20, "resolved", null, "t");
        var asOf = w.Round(30, "open", null, "t");
        Assert.Equal([e.Id], w.Live(asOf).Select(x => x.Id));
        w.Round(25, "resolved", null, "t");
        Assert.Empty(w.Live(asOf));
    }

    [Fact]
    public void Clock_counts_the_source_round_inclusive_and_the_as_of_round_exclusive_and_only_resolved()
    {
        var w = new World();
        var src = w.Round(0, "resolved", null, "t");
        w.Effect(w.Cast(src), remaining: 1);
        var asOfSame = w.Round(5, "open", null, "t");
        Assert.Empty(w.Live(asOfSame));
        var w2 = new World();
        var open = w2.Round(0, "open", null, "t");
        w2.Effect(w2.Cast(open), remaining: 1);
        Assert.Single(w2.Live(w2.Round(5, "open", null, "t")));
    }

    [Fact]
    public void Dispel_ends_the_effect_from_the_dispelling_round_on_unless_undispellable_or_negated()
    {
        var w = new World();
        var r1 = w.Round(0);
        var e = w.Effect(w.Cast(r1));
        var u = w.Effect(w.Cast(r1), undispellable: true);
        var r2 = w.Round(10);
        w.Cast(r2, "dispel", $$"""{"ended_effect_id":"{{e.Id}}"}""");
        w.Cast(r2, "dispel", $$"""{"ended_effect_id":"{{u.Id}}"}""");
        var r3 = w.Round(20);
        Assert.Equal([u.Id], w.Live(r3).Select(x => x.Id));
        Assert.Equal([e.Id, u.Id], w.Live(r1).Select(x => x.Id).Order().ToArray());
    }

    [Fact]
    public void Negated_dispel_does_not_end_the_effect()
    {
        var w = new World();
        var r1 = w.Round(0);
        var e = w.Effect(w.Cast(r1));
        w.Cast(w.Round(10), "dispel", $$"""{"ended_effect_id":"{{e.Id}}"}""", negated: true);
        Assert.Single(w.Live(w.Round(20)));
    }

    [Fact]
    public void Spent_one_shot_marks_are_dead_even_for_earlier_reads()
    {
        var w = new World();
        var r1 = w.Round(0);
        w.Effect(w.Cast(r1, ci: """{"consumed_by_round":"x"}"""));
        w.Effect(w.Cast(r1, ci: """{"consumed_by_draw":"x"}"""));
        Assert.Empty(w.Live(r1));
    }

    [Fact]
    public void Spent_courage_token_is_bounded_by_the_as_of_round()
    {
        var w = new World();
        var r1 = w.Round(0);
        var gift = w.Cast(r1);
        var token = w.Effect(gift, kind: "courage_token");
        var r2 = w.Round(10);
        w.Cast(r2, ci: $$"""{"courage_token_cast_id":"{{gift.Id}}"}""");
        var r3 = w.Round(20);
        Assert.Empty(w.Live(r3));
        Assert.Equal([token.Id], w.Live(r1).Select(x => x.Id));
    }

    [Fact]
    public void Ended_in_round_is_live_only_before_that_round_started()
    {
        var w = new World();
        var r1 = w.Round(0);
        var r2 = w.Round(10);
        var e = w.Effect(w.Cast(r1), endedIn: r2.Id);
        var r3 = w.Round(20);
        Assert.Equal([e.Id], w.Live(r1).Select(x => x.Id));
        Assert.Empty(w.Live(r2));
        Assert.Empty(w.Live(r3));
    }

    [Fact]
    public void Participated_rounds_after_cast_counts_from_the_next_round_and_is_live_in_the_cast_round()
    {
        var w = new World();
        var r1 = w.Round(0, "resolved", null, "t");
        var e = w.Effect(w.Cast(r1), ep: """{"participated_rounds_after_cast":1}""");
        Assert.Equal([e.Id], w.Live(r1).Select(x => x.Id));
        var r2 = w.Round(10, "resolved", null, "t");
        var r3 = w.Round(20, "open", null, "t");
        Assert.Equal([e.Id], w.Live(r2).Select(x => x.Id));
        Assert.Empty(w.Live(r3));
    }

    [Fact]
    public void Participated_rounds_from_cast_counts_the_cast_round_once_resolved()
    {
        var w = new World();
        var r1 = w.Round(0, "resolved", null, "t");
        w.Effect(w.Cast(r1), kind: "courage_token", ep: """{"participated_rounds_from_cast":1}""");
        Assert.Empty(w.Live(w.Round(10, "open", null, "t")));
    }

    [Fact]
    public void Carried_effect_follows_the_target_into_a_later_room_of_the_same_kind_only()
    {
        var w = new World();
        var earlier = w.OtherRoom();
        var src = w.Round(0, "resolved", earlier, "t");
        var e = w.Effect(w.Cast(src), room: earlier, remaining: 3);
        var rest = w.Effect(w.Cast(src), room: earlier);
        var now = w.Round(100, "open", null, "t");
        var live = w.Live(now);
        Assert.Equal([e.Id], live.Select(x => x.Id));
        Assert.All(live, x => Assert.Equal(w.Room, x.RoomId));
        Assert.Contains(rest.Id, w.Live(src, earlier).Select(x => x.Id));
    }

    [Fact]
    public void Carried_effect_never_leaks_back_to_an_earlier_room_or_across_test_kind()
    {
        var w = new World();
        var later = w.OtherRoom();
        var testRoom = w.OtherRoom(isTest: true);
        var early = w.Round(0, "resolved", null, "t");
        var src = w.Round(50, "resolved", later, "t");
        w.Effect(w.Cast(src), room: later, remaining: 3);
        Assert.Empty(w.Live(early));
        var tsrc = w.Round(60, "resolved", testRoom, "t");
        w.Effect(w.Cast(tsrc), room: testRoom, remaining: 3);
        Assert.DoesNotContain(w.Live(w.Round(100, "open", null, "t")), x => x.RoomId != w.Room);
        Assert.Single(w.Live(w.Round(100, "open", null, "t")));
    }

    [Fact]
    public void One_earl_the_newest_title_wins_and_a_negated_newer_one_leaves_the_older_standing()
    {
        var w = new World();
        var r1 = w.Round(0);
        var old = w.Effect(w.Cast(r1), kind: "brewer_immunity", ep: """{"mode":"earl"}""", createdMinute: 1);
        var r2 = w.Round(10);
        var newer = w.Effect(w.Cast(r2), kind: "brewer_immunity", ep: """{"mode":"earl"}""", createdMinute: 2);
        var r3 = w.Round(20);
        Assert.Equal([newer.Id], w.Live(r3).Select(x => x.Id));
        Assert.Equal(new[] { old.Id, newer.Id }.Order(), w.Live(r1).Select(x => x.Id).Order());
        var nc = w.Casts.First(c => c.Id == newer.SourceCastId);
        w.Casts[w.Casts.IndexOf(nc)] = nc with { Negated = true };
        Assert.Equal([old.Id], w.Live(r3).Select(x => x.Id));
    }

    [Fact]
    public void Earl_tie_on_created_at_breaks_on_uuid_bytes()
    {
        var w = new World();
        var r1 = w.Round(0);
        var a = w.Effect(w.Cast(r1), kind: "brewer_immunity", ep: """{"mode":"earl"}""");
        var b = w.Effect(w.Cast(r1), kind: "brewer_immunity", ep: """{"mode":"earl"}""");
        var expected = string.CompareOrdinal(a.Id.ToString("N"), b.Id.ToString("N")) > 0 ? a.Id : b.Id;
        Assert.Equal([expected], w.Live(w.Round(10)).Select(x => x.Id));
    }
}
