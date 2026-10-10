using System.Text.Json;
using RollForBrew.Domain.Snapshot;
using static RollForBrew.Tests.RoomView.ViewFixture;

namespace RollForBrew.Tests.RoomView;

public class RoomViewSecrecyTests
{
    private static IEnumerable<long> IntegerLeaves(JsonElement e)
    {
        switch (e.ValueKind)
        {
            case JsonValueKind.Number when e.TryGetInt64(out var n): yield return n; break;
            case JsonValueKind.Object: foreach (var p in e.EnumerateObject()) foreach (var n in IntegerLeaves(p.Value)) yield return n; break;
            case JsonValueKind.Array: foreach (var i in e.EnumerateArray()) foreach (var n in IntegerLeaves(i)) yield return n; break;
        }
    }

    private static ViewFixture RolledRound(string viewer, params (string Player, int Value, int Layer)[] rolls)
    {
        var f = new ViewFixture { Viewer = viewer }.ClosedRound(0, "ann", "bob", "cat");
        foreach (var (p, v, l) in rolls) f.Rolls.Add(Roll(p, v, l));
        return f;
    }

    [Fact]
    public void Other_players_roll_values_never_appear_before_resolution()
    {
        var f = RolledRound("ann", ("ann", 5, 0), ("bob", 19, 0), ("cat", 20, 0));
        var leaves = IntegerLeaves(JsonDocument.Parse(f.Json()).RootElement).ToList();
        Assert.DoesNotContain(19L, leaves);
        Assert.DoesNotContain(20L, leaves);
        Assert.Contains(5L, leaves);
    }

    [Fact]
    public void Who_has_rolled_is_public_but_the_value_is_not_even_for_a_tie_layer()
    {
        var f = RolledRound("ann", ("bob", 18, 0), ("cat", 19, 0), ("bob", 20, 1));
        f.Rounds[0] = Round(RoundId, "closed", layer: 1, closed: T0);
        f.LayerParticipants.Add(new(RoundId, 1, "bob", T0, null));
        f.LayerParticipants.Add(new(RoundId, 1, "cat", T0, null));
        var json = JsonDocument.Parse(f.Json()).RootElement;
        var leaves = IntegerLeaves(json).ToList();
        Assert.DoesNotContain(18L, leaves);
        Assert.DoesNotContain(19L, leaves);
        Assert.DoesNotContain(20L, leaves);
        Assert.Contains("bob", json.GetProperty("room").GetProperty("activeRound").GetProperty("rolledPlayerIds").EnumerateArray().Select(x => x.GetString()));
    }

    [Fact]
    public void A_resolved_rounds_rolls_are_not_in_the_view_outside_its_recap()
    {
        var f = new ViewFixture { Viewer = "ann" };
        f.Rounds.Add(Round(RoundId, "resolved", resolved: T0, brewer: "bob"));
        f.Participants.Add(Participant("ann"));
        f.Rolls.Add(Roll("bob", 19));
        f.Rolls.Add(Roll("ann", 18));
        var leaves = IntegerLeaves(JsonDocument.Parse(f.Json()).RootElement).ToList();
        Assert.DoesNotContain(19L, leaves);
        Assert.DoesNotContain(18L, leaves);
    }

    [Fact]
    public void Other_players_hands_are_never_taken_from_the_snapshot_deck()
    {
        var bobsCard = Guid.NewGuid();
        var f = new ViewFixture { Viewer = "ann" };
        f.Deck.Add(new DeckInstanceRow(bobsCard, Guid.NewGuid(), "held", "bob"));
        var mine = new RollForBrew.Domain.RoomView.HeldCard(Guid.NewGuid(), "held", "Hex", "A", "PLAYER", "common", "x", null, "4th");
        f.Reads = f.Reads with { HeldCards = [mine] };
        var json = f.Json();
        Assert.DoesNotContain(bobsCard.ToString(), json);
        Assert.Contains(mine.InstanceId.ToString(), json);
    }

    [Fact]
    public void Heist_targets_are_not_revealed_to_a_viewer_without_the_card()
    {
        var f = new ViewFixture { Viewer = "ann" }.OpenRound("ann", "bob");
        f.Reads = f.Reads with { HeistTargetIds = ["bob"] };
        Assert.Empty(f.Project().Viewer.HeistTargetIds);
    }

    [Fact]
    public void Ratings_carry_only_the_viewers_own_score()
    {
        var f = new ViewFixture { Viewer = "ann" }.WithExtras(e => e with { Rateable = new(RoundId, "BOB", "bob@x.test", T0, 2) });
        var json = JsonDocument.Parse(f.Json()).RootElement;
        Assert.Equal(2, json.GetProperty("viewer").GetProperty("rateableRound").GetProperty("myScore").GetInt32());
        Assert.False(json.GetProperty("room").TryGetProperty("ratings", out _));
        Assert.False(json.GetProperty("viewer").GetProperty("rateableRound").TryGetProperty("scores", out _));
    }
}
