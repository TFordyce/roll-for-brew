using System.Text.Json;
using RollForBrew.Domain.Commands;
using RollForBrew.Domain.Snapshot;

namespace RollForBrew.Tests;

/// <summary>Seam 1 for #465: one function answers "where is this Layer?". The noop reasons
/// themselves are pinned against SQL by <see cref="AdvanceRoundScenarioTests"/>; these pin the
/// shape nothing in SQL returns: who each hold waits on.</summary>
public class LayerReadinessTests
{
    private static readonly Guid Room = Guid.NewGuid();
    private static readonly Guid Round = Guid.NewGuid();
    private static readonly Guid Card = Guid.NewGuid();
    private static readonly Guid Instance = Guid.NewGuid();
    private static readonly DateTimeOffset Now = new(2026, 1, 1, 9, 0, 0, TimeSpan.Zero);

    private static RoundSnapshot Snapshot(int[] rolls, params SpellCastRow[] casts)
    {
        string[] players = ["p-a", "p-b"];
        return new RoundSnapshot(
            Room, Now, [new RoomRow(Room, false)],
            [new RoundRow(Round, Room, "p-a", "closed", Now, null, Now, null, null, 0, 0, 0, [], null, null, null)],
            [.. players.Select(p => new RoundParticipantRow(Round, p, Now, null))],
            [],
            [.. rolls.Select((v, i) => new RollRow(Round, players[i], 0, v, "in_app", 0, Now, null, false, 0))],
            casts, [],
            [new DeckInstanceRow(Instance, Card, "in_deck", null)],
            [new SpellCardRow(Card, "A Card", "A", "OPPONENT", "common", "", null, null)],
            [], [], []);
    }

    private static SpellCastRow Cast(string kind, string? target = null, bool pending = false, string? effectParams = null, string? inputs = null) =>
        new(Guid.NewGuid(), Round, "p-b", Instance, target, pending, kind,
            effectParams is null ? null : JsonDocument.Parse(effectParams).RootElement, null, Now, null, false, 1, null,
            inputs is null ? null : JsonDocument.Parse(inputs).RootElement, null, null, null, 0, null);

    [Fact]
    public void A_fully_rolled_layer_with_no_holds_is_complete()
    {
        var state = LayerReadiness.Of(Snapshot([3, 9]), Round, 0);
        Assert.True(state.IsComplete);
        Assert.Equal(["p-a", "p-b"], state.ExpectedRollerIds);
        Assert.Equal(["p-a", "p-b"], state.RolledIds);
        Assert.Empty(state.Holds);
    }

    [Fact]
    public void A_missing_roll_is_not_a_hold_but_the_layer_is_incomplete()
    {
        var state = LayerReadiness.Of(Snapshot([3]), Round, 0);
        Assert.False(state.IsComplete);
        Assert.Empty(state.Holds);
        Assert.Equal("layer_incomplete", state.HoldReason);
    }

    [Fact]
    public void A_pending_die_waits_on_its_caster()
    {
        var hold = Assert.Single(LayerReadiness.Of(Snapshot([3, 9], Cast("dice_modifier", "p-a")), Round, 0).Holds);
        Assert.Equal(LayerHoldKind.PendingDie, hold.Kind);
        Assert.Equal(["p-b"], hold.WaitingOn);
    }

    [Fact]
    public void A_deferred_target_waits_on_its_caster()
    {
        var hold = Assert.Single(LayerReadiness.Of(Snapshot([3, 9], Cast("forced_reroll", pending: true)), Round, 0).Holds);
        Assert.Equal(LayerHoldKind.DeferredTarget, hold.Kind);
        Assert.Equal(["p-b"], hold.WaitingOn);
    }

    [Fact]
    public void A_revolt_pick_waits_on_the_lowest_roller_once_everyone_has_rolled()
    {
        var revolt = Cast("tea_maker_override", effectParams: """{"mode": "chosen", "picker": "lowest_roller"}""");

        var rolled = LayerReadiness.Of(Snapshot([3, 9], revolt), Round, 0);
        Assert.Equal(["p-a"], Assert.Single(rolled.Holds).WaitingOn);
        Assert.Equal("revolt_pick_pending", rolled.HoldReason);

        var stillRolling = LayerReadiness.Of(Snapshot([3], revolt), Round, 0);
        Assert.Empty(Assert.Single(stillRolling.Holds).WaitingOn);
        Assert.Equal("layer_incomplete", stillRolling.HoldReason);
    }

    [Fact]
    public void An_owed_compelled_action_stops_rolling_but_the_players_stay_expected()
    {
        var compel = Cast("compel_cast", inputs: $$"""{"compelled": [{"player_id": "p-a", "card_instance_id": "{{Guid.NewGuid()}}", "casting_time": "A"}]}""");

        var state = LayerReadiness.Of(Snapshot([], compel), Round, 0);

        Assert.Equal(["p-a"], Assert.Single(state.Holds).WaitingOn);
        Assert.Contains("p-b", state.ExpectedRollerIds);
        Assert.False(state.MayRoll("p-b"));
    }

    [Fact]
    public void An_owed_compelled_reaction_holds_nothing_at_rolling_time()
    {
        var compel = Cast("compel_cast", inputs: $$"""{"compelled": [{"player_id": "p-a", "card_instance_id": "{{Guid.NewGuid()}}", "casting_time": "R"}]}""");
        var state = LayerReadiness.Of(Snapshot([], compel), Round, 0);
        Assert.Empty(state.Holds);
        Assert.True(state.MayRoll("p-a"));
    }

    [Fact]
    public void A_roll_exempt_caster_is_not_expected()
    {
        var exempt = Cast("flat_modifier", "p-b", effectParams: """{"exempt_from_rolling": true}""");
        var one = LayerReadiness.Of(Snapshot([3], exempt), Round, 0);
        Assert.Equal(["p-a"], one.ExpectedRollerIds);
        Assert.True(one.IsComplete);
    }
}
