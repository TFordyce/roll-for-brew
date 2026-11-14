using System.Text.Json;
using RollForBrew.Domain.Commands;
using RollForBrew.Domain.Dice;
using RollForBrew.Domain.Resolver;
using RollForBrew.Domain.Snapshot;

namespace RollForBrew.Tests;

/// <summary>Seam 1 for #551: what a roll submission decides, without a database. The same rules
/// run against real Postgres in <see cref="RollSubmissionHttpTests"/>.</summary>
public class RollSubmissionTests
{
    private static readonly Guid Room = Guid.NewGuid();
    private static readonly Guid Round = Guid.NewGuid();
    private static readonly Guid Card = Guid.NewGuid();
    private static readonly Guid Instance = Guid.NewGuid();
    private static readonly DateTimeOffset Now = new(2026, 1, 1, 9, 0, 0, TimeSpan.Zero);

    private static RoundSnapshot Snapshot(string status = "closed", int layer = 0, bool testRoom = false, int modifier = 0,
        IEnumerable<SpellCastRow>? casts = null, IEnumerable<ActiveEffectRow>? effects = null, params int[] alreadyRolled)
    {
        string[] players = ["p-a", "p-b"];
        return new RoundSnapshot(
            Room, Now, [new RoomRow(Room, testRoom)],
            [new RoundRow(Round, Room, "p-a", status, Now, null, Now, null, null, layer, 0, 0, [], null, null, null)],
            [.. players.Select(p => new RoundParticipantRow(Round, p, Now, null))],
            [.. players.Select(p => new RoundLayerParticipantRow(Round, 1, p, Now, null))],
            [.. alreadyRolled.Select((v, i) => new RollRow(Round, players[i], layer, v, "in_app", 0, Now, null, false, 0))],
            [.. casts ?? []], [.. effects ?? []],
            [new DeckInstanceRow(Instance, Card, "in_deck", null)],
            [new SpellCardRow(Card, "A Card", "A", "OPPONENT", "common", "", null, null)],
            [], [new RoomPlayerRow(Room, "p-b", modifier)], []);
    }

    private static SpellCastRow Cast(string kind, string target = "p-b", string? effectParams = null, long seq = 1, bool negated = false) =>
        new(Guid.NewGuid(), Round, "p-a", Instance, target, false, kind,
            effectParams is null ? null : JsonDocument.Parse(effectParams).RootElement, null, Now, null, negated, seq, null,
            null, null, null, null, 0, null);

    private static InsertRoll TheRoll(Decision<int> d) => Assert.IsType<InsertRoll>(Assert.Single(d.Writes, w => w is InsertRoll));

    private static JsonElement Transform(Decision<int> d, SpellCastRow cast) =>
        JsonDocument.Parse(Assert.Single(d.Writes.OfType<SetCastRollTransform>(), w => w.CastId == cast.Id).RollTransformJson).RootElement;

    [Fact]
    public void A_plain_roll_is_one_die_with_the_modifier_snapshot()
    {
        var d = RollSubmission.Auto(Snapshot(modifier: 3), Round, "p-b", new ScriptedDieRoller(11));

        Assert.Equal(11, d.Result);
        var roll = TheRoll(d);
        Assert.Equal(("p-b", 0, 11, "in_app", 3, (int?)null, false), (roll.PlayerId, roll.Layer, roll.Value, roll.InputMode, roll.ModifierSnapshot, roll.DiscardedValue, roll.EnteredByAdmin));
        Assert.Single(d.Writes);
        Assert.Equal("room-changed", Assert.Single(d.Events).Name);
    }

    [Fact]
    public void Advantage_keeps_the_higher_die_and_records_both()
    {
        var cast = Cast("advantage");
        var dice = new ScriptedDieRoller(4, 17);

        var d = RollSubmission.Auto(Snapshot(casts: [cast]), Round, "p-b", dice);

        Assert.Equal(17, d.Result);
        Assert.Equal(4, TheRoll(d).DiscardedValue);
        var t = Transform(d, cast);
        Assert.Equal("advantage", t.GetProperty("kind").GetString());
        Assert.False(t.GetProperty("cancelled").GetBoolean());
        Assert.Equal([4, 17], t.GetProperty("dice").EnumerateArray().Select(x => x.GetInt32()));
        Assert.Equal(17, t.GetProperty("players")[0].GetProperty("after").GetInt32());
    }

    [Fact]
    public void Disadvantage_keeps_the_lower_die()
    {
        var d = RollSubmission.Auto(Snapshot(casts: [Cast("disadvantage")]), Round, "p-b", new ScriptedDieRoller(15, 9));

        Assert.Equal(9, d.Result);
        Assert.Equal(15, TheRoll(d).DiscardedValue);
    }

    [Fact]
    public void Advantage_and_disadvantage_cancel_to_the_single_first_die()
    {
        var adv = Cast("advantage");
        var dis = Cast("disadvantage", seq: 2);
        var dice = new ScriptedDieRoller(8);

        var d = RollSubmission.Auto(Snapshot(casts: [adv, dis]), Round, "p-b", dice);

        Assert.Equal(8, d.Result);
        Assert.Null(TheRoll(d).DiscardedValue);
        Assert.Equal(0, dice.Remaining);
        Assert.True(Transform(d, adv).GetProperty("cancelled").GetBoolean());
        Assert.Equal([8], Transform(d, dis).GetProperty("dice").EnumerateArray().Select(x => x.GetInt32()));
    }

    [Fact]
    public void A_pending_target_is_not_yet_aimed_at_the_roller()
    {
        var pending = Cast("advantage") with { TargetPending = true };

        var d = RollSubmission.Auto(Snapshot(casts: [pending]), Round, "p-b", new ScriptedDieRoller(6));

        Assert.Equal(6, d.Result);
        Assert.Single(d.Writes);
    }

    [Fact]
    public void A_conditional_advantage_takes_a_second_die_only_when_the_first_clears_the_threshold()
    {
        var cast = Cast("advantage", effectParams: """{"condition": {"advantage_at_or_above": 15, "disadvantage_at_or_below": 5}}""");

        var high = RollSubmission.Auto(Snapshot(casts: [cast]), Round, "p-b", new ScriptedDieRoller(16, 3));
        Assert.Equal(16, high.Result);
        Assert.Equal(3, TheRoll(high).DiscardedValue);
        Assert.Equal("advantage", Transform(high, cast).GetProperty("condition").GetProperty("branch").GetString());

        var middling = RollSubmission.Auto(Snapshot(casts: [cast]), Round, "p-b", new ScriptedDieRoller(10));
        Assert.Equal(10, middling.Result);
        var branch = Transform(middling, cast).GetProperty("condition");
        Assert.Equal("none", branch.GetProperty("branch").GetString());
        Assert.Equal(10, branch.GetProperty("first_die").GetInt32());

        var low = RollSubmission.Auto(Snapshot(casts: [cast]), Round, "p-b", new ScriptedDieRoller(4, 12));
        Assert.Equal(4, low.Result);
        Assert.Equal(12, TheRoll(low).DiscardedValue);
        Assert.Equal("disadvantage", Transform(low, cast).GetProperty("condition").GetProperty("branch").GetString());
    }

    [Fact]
    public void A_fixed_roll_pins_the_die_and_takes_no_second_one()
    {
        var pin = Cast("fixed_roll", effectParams: """{"value": 12}""");
        var adv = Cast("advantage", seq: 2);
        var dice = new ScriptedDieRoller(3);

        var d = RollSubmission.Auto(Snapshot(casts: [pin, adv]), Round, "p-b", dice);

        Assert.Equal(12, d.Result);
        Assert.Null(TheRoll(d).DiscardedValue);
        var t = Transform(d, pin);
        Assert.Equal(0, t.GetProperty("order").GetInt32());
        Assert.Equal((3, 12), (t.GetProperty("players")[0].GetProperty("before").GetInt32(), t.GetProperty("players")[0].GetProperty("after").GetInt32()));
        Assert.DoesNotContain(d.Writes.OfType<SetCastRollTransform>(), w => w.CastId == adv.Id);
    }

    [Fact]
    public void A_negated_fixed_roll_does_not_pin()
    {
        var d = RollSubmission.Auto(Snapshot(casts: [Cast("fixed_roll", effectParams: """{"value": 12}""", negated: true)]), Round, "p-b", new ScriptedDieRoller(3));

        Assert.Equal(3, d.Result);
    }

    [Fact]
    public void A_roll_ward_blocks_a_fixed_roll_that_would_raise_the_die()
    {
        var pin = Cast("fixed_roll", effectParams: """{"value": 12}""", seq: 5);
        var wardCast = Guid.NewGuid();
        var ward = new ActiveEffectRow(Guid.NewGuid(), Room, "p-b", "p-b", wardCast, Card, "ward",
            JsonDocument.Parse("""{"domain": ["roll"], "polarity": ["positive", "negative"]}""").RootElement,
            null, Now.AddHours(-1), false, null);

        var wardSource = Cast("ward", seq: 1) with { Id = wardCast };

        var d = RollSubmission.Auto(Snapshot(casts: [wardSource, pin], effects: [ward]), Round, "p-b", new ScriptedDieRoller(3));

        Assert.Equal(3, d.Result);
        var entry = Transform(d, pin).GetProperty("players")[0];
        Assert.True(entry.GetProperty("warded").GetBoolean());
        Assert.Equal(12, entry.GetProperty("would_be_after").GetInt32());
        Assert.Equal(wardCast.ToString(), entry.GetProperty("ward_cast_id").GetString());
    }

    [Fact]
    public void A_tie_break_layer_roll_ignores_advantage_and_goes_in_the_current_layer()
    {
        var d = RollSubmission.Auto(Snapshot(layer: 1, casts: [Cast("advantage")]), Round, "p-b", new ScriptedDieRoller(9));

        Assert.Equal(9, d.Result);
        Assert.Equal(1, TheRoll(d).Layer);
        Assert.Single(d.Writes);
    }

    [Fact]
    public void Rolling_before_the_round_closes_or_out_of_turn_is_refused()
    {
        var open = Assert.Throws<CommandRefusal>(() => RollSubmission.Auto(Snapshot("open"), Round, "p-b", new NoDiceRoller()));
        Assert.Equal("round_not_open_for_rolling", open.Code);

        var stranger = Assert.Throws<CommandRefusal>(() => RollSubmission.Auto(Snapshot(), Round, "p-z", new NoDiceRoller()));
        Assert.Equal("not_expected_roller", stranger.Code);

        var twice = Assert.Throws<CommandRefusal>(() => RollSubmission.Auto(Snapshot(alreadyRolled: [5, 6]), Round, "p-b", new NoDiceRoller()));
        Assert.Equal("not_expected_roller", twice.Code);

        var missing = Assert.Throws<CommandRefusal>(() => RollSubmission.Auto(null, Round, "p-b", new NoDiceRoller()));
        Assert.Equal("round_not_found", missing.Code);
    }

    [Fact]
    public void An_owed_compelled_cast_holds_rolling_for_everyone()
    {
        var compel = Cast("compel_cast") with
        {
            CastInputs = JsonDocument.Parse($$"""{"compelled": [{"player_id": "p-a", "card_instance_id": "{{Guid.NewGuid()}}", "casting_time": "A"}]}""").RootElement,
        };

        var e = Assert.Throws<CommandRefusal>(() => RollSubmission.Auto(Snapshot(casts: [compel]), Round, "p-b", new NoDiceRoller()));

        Assert.Equal("not_expected_roller", e.Code);
    }

    [Fact]
    public void A_puppet_roll_needs_a_test_room()
    {
        var e = Assert.Throws<CommandRefusal>(() => RollSubmission.Auto(Snapshot(), Round, "p-b", new NoDiceRoller(), asAdmin: true));
        Assert.Equal("round_not_in_test_room", e.Code);

        Assert.Equal(6, RollSubmission.Auto(Snapshot(testRoom: true), Round, "p-b", new ScriptedDieRoller(6), asAdmin: true).Result);
    }

    [Fact]
    public void A_manual_roll_records_the_number_as_entered()
    {
        var d = RollSubmission.Manual(Snapshot(modifier: 2), Round, "p-b", 14);

        var roll = Assert.IsType<InsertRoll>(Assert.Single(d.Writes));
        Assert.Equal(("manual", 14, 2, false), (roll.InputMode, roll.Value, roll.ModifierSnapshot, roll.EnteredByAdmin));
    }

    [Theory]
    [InlineData(0)]
    [InlineData(21)]
    public void A_manual_value_outside_a_d20_is_refused_before_anything_else(int value)
    {
        var e = Assert.Throws<CommandRefusal>(() => RollSubmission.Manual(Snapshot("open"), Round, "p-b", value));
        Assert.Equal("roll_value_out_of_range", e.Code);
    }

    [Fact]
    public void A_proxy_roll_seats_declares_and_rolls_for_the_target_as_the_admin_entered()
    {
        var d = RollSubmission.Proxy(Snapshot("open"), Round, "p-new", 9);

        Assert.Equal(new Write[]
        {
            new EnsureRoomPlayer(Room, "p-new"),
            new InsertRoundParticipant(Round, "p-new"),
            new InsertRoll(Round, "p-new", 0, 9, "manual", 0, EnteredByAdmin: true),
        }, d.Writes);
    }

    [Theory]
    [InlineData(1, "nat1")]
    [InlineData(20, "nat20")]
    public void A_proxy_crit_also_records_the_draw(int value, string trigger)
    {
        var d = RollSubmission.Proxy(Snapshot("closed"), Round, "p-b", value);

        Assert.Equal(new RecordCritDraw(Round, "p-b", trigger), d.Writes.Last());
    }

    [Fact]
    public void A_proxy_roll_is_refused_once_anyone_has_rolled_or_the_round_is_over()
    {
        var rolled = Assert.Throws<CommandRefusal>(() => RollSubmission.Proxy(Snapshot(alreadyRolled: [5]), Round, "p-b", 9));
        Assert.Equal("round_closed_for_proxy_roll", rolled.Code);

        var resolved = Assert.Throws<CommandRefusal>(() => RollSubmission.Proxy(Snapshot("resolved"), Round, "p-b", 9));
        Assert.Equal("round_closed_for_proxy_roll", resolved.Code);
    }

    [Fact]
    public void A_proxy_roll_waits_for_the_compelled_cast_step_but_not_in_the_declaration_window()
    {
        var compel = Cast("compel_cast") with
        {
            CastInputs = JsonDocument.Parse($$"""{"compelled": [{"player_id": "p-a", "card_instance_id": "{{Guid.NewGuid()}}", "casting_time": "A"}]}""").RootElement,
        };

        var held = Assert.Throws<CommandRefusal>(() => RollSubmission.Proxy(Snapshot("closed", casts: [compel]), Round, "p-b", 9));
        Assert.Equal("rolling_held_for_compelled_casts", held.Code);

        Assert.NotEmpty(RollSubmission.Proxy(Snapshot("open", casts: [compel]), Round, "p-b", 9).Writes);
    }
}
