using System.Text.Json;
using RollForBrew.Domain.RoomView;
using static RollForBrew.Tests.RoomView.ViewFixture;

namespace RollForBrew.Tests.RoomView;

/// <summary>The room page's derivations (src/app/page.tsx), one behaviour per test.</summary>
public class RoomViewProjectorTests
{
    private static ViewerReads Reads(Func<ViewerReads, ViewerReads> f) => f(ViewerReads.Empty);

    // ---- idle / open

    [Fact]
    public void Idle_room_offers_start_round_and_the_idle_panel_only()
    {
        var v = new ViewFixture().Project();
        Assert.Null(v.Room.ActiveRound);
        Assert.True(v.Viewer.CanStartRound);
        Assert.True(v.Viewer.Panels.IdleRoom);
        Assert.False(v.Viewer.Panels.WhosIn);
        Assert.False(v.Viewer.Panels.RoundReveal);
        Assert.True(v.Viewer.Panels.SpellCards);
        Assert.Null(v.Room.NextStallDeadline);
        Assert.Equal(7, v.Version);
    }

    [Fact]
    public void Roster_is_ordered_by_modifier_and_carries_only_polarised_effect_badges()
    {
        var f = new ViewFixture().With(r => r with
        {
            EffectBadges =
            [
                new(Guid.NewGuid(), "bob", "Hex", "common", "negative", 2),
                new(Guid.NewGuid(), "bob", "Silent", "rare", null, 1),
            ],
        });
        var v = f.Project();
        Assert.Equal(["ann", "bob", "cat"], v.Room.Roster.Select(r => r.PlayerId));
        Assert.Empty(v.Room.Roster[0].EffectBadges);
        Assert.Equal("Hex", Assert.Single(v.Room.Roster[1].EffectBadges).CardName);
    }

    [Fact]
    public void Open_round_the_starter_needs_two_declared_to_close()
    {
        var one = new ViewFixture().OpenRound("ann").Project();
        Assert.True(one.Viewer.IsStarter);
        Assert.False(one.Viewer.CanClose);
        Assert.Equal(1, one.Viewer.NeedMoreToClose);
        Assert.True(one.Viewer.Panels.WhosIn);
        Assert.False(one.Viewer.CanDeclare);
        Assert.False(one.Viewer.CanWithdraw); // the starter's row is owning the round

        var two = new ViewFixture().OpenRound("ann", "bob").Project();
        Assert.True(two.Viewer.CanClose);
        Assert.Equal(0, two.Viewer.NeedMoreToClose);
    }

    [Fact]
    public void Open_round_a_non_starter_can_declare_then_withdraw()
    {
        var before = new ViewFixture { Viewer = "bob" }.OpenRound("ann").Project();
        Assert.True(before.Viewer.CanDeclare);
        Assert.False(before.Viewer.CanWithdraw);
        Assert.False(before.Viewer.CanClose);

        var after = new ViewFixture { Viewer = "bob" }.OpenRound("ann", "bob").Project();
        Assert.False(after.Viewer.CanDeclare);
        Assert.True(after.Viewer.CanWithdraw);
        Assert.True(after.Viewer.HasDeclared);
    }

    // ---- late declare

    [Fact]
    public void Late_declare_is_offered_to_an_undeclared_viewer_until_any_roll_lands()
    {
        var f = new ViewFixture { Viewer = "cat" }.ClosedRound(0, "ann", "bob");
        Assert.True(f.Project().Viewer.CanDeclareLate);
        Assert.True(f.Project().Viewer.Panels.LateDeclare);

        f.Rolls.Add(Roll("ann", 9));
        Assert.False(f.Project().Viewer.CanDeclareLate);
    }

    [Fact]
    public void Late_declare_is_not_offered_to_someone_already_declared()
    {
        Assert.False(new ViewFixture().ClosedRound(0, "ann", "bob").Project().Viewer.CanDeclareLate);
    }

    // ---- turn to roll

    [Fact]
    public void Turn_to_roll_needs_expected_roller_and_no_roll_yet()
    {
        var f = new ViewFixture().ClosedRound(0, "ann", "bob").With(r => r with { ExpectedRollerIds = ["ann", "bob"] });
        var v = f.Project();
        Assert.True(v.Viewer.IsPlayersTurnToRoll);
        Assert.True(v.Viewer.NeedsRollInput);
        Assert.Equal("in_app_only", v.Viewer.RollInputMode); // the default when the viewer never opened Settings
        Assert.True(v.Viewer.Panels.RollInput);

        f.Extras = f.Extras with { RollInputMode = "both" };
        Assert.Equal("both", f.Project().Viewer.RollInputMode);

        f.Rolls.Add(Roll("ann", 9));
        var rolled = f.Project();
        Assert.False(rolled.Viewer.IsPlayersTurnToRoll);
        Assert.Equal(9, rolled.Viewer.OwnRoll);
        Assert.Null(rolled.Viewer.RollInputMode);
        Assert.False(rolled.Viewer.Panels.RollInput);
    }

    [Fact]
    public void An_exempt_or_excluded_viewer_is_not_expected_to_roll()
    {
        var v = new ViewFixture().ClosedRound(0, "ann", "bob", "cat").With(r => r with { ExpectedRollerIds = ["bob", "cat"] }).Project();
        Assert.False(v.Viewer.IsExpectedToRoll);
        Assert.False(v.Viewer.IsPlayersTurnToRoll);
    }

    [Fact]
    public void Nobody_rolls_while_the_compelled_cast_step_holds_layer_zero()
    {
        var v = new ViewFixture().ClosedRound(0, "ann", "bob").With(r => r with
        {
            ExpectedRollerIds = ["ann", "bob"],
            CompelledStep = new CompelledStepRow(["bob"], null),
        }).Project();
        Assert.False(v.Viewer.IsPlayersTurnToRoll);
        Assert.True(v.Viewer.Panels.CompelledCast);
        Assert.Equal(["bob"], v.Viewer.CompelledCast!.WaitingOnOthers);
    }

    [Fact]
    public void Compelled_waiting_list_excludes_the_viewer()
    {
        var v = new ViewFixture().ClosedRound(0, "ann", "bob").With(r => r with
        {
            CompelledStep = new CompelledStepRow(["ann", "bob"], null),
            CompelledCast = new CompelledCastRow("A", "Hex", "bob"),
        }).Project();
        Assert.Equal(["bob"], v.Viewer.CompelledCast!.WaitingOnOthers);
        Assert.Equal("A", v.Viewer.CompelledCast.Mine!.CastingTime);
    }

    // ---- tie phase

    [Fact]
    public void Tie_phase_reads_the_current_layer_roll_and_shows_the_tie_banner_not_the_roll_input_gate()
    {
        var f = new ViewFixture { Viewer = "bob" }.ClosedRound(1, "ann", "bob", "cat").With(r => r with { ExpectedRollerIds = ["ann", "bob"] });
        f.LayerParticipants.Add(new(RoundId, 1, "ann", T0.AddMinutes(1), null));
        f.LayerParticipants.Add(new(RoundId, 1, "bob", T0.AddMinutes(1), null));
        f.Rolls.Add(Roll("bob", 4, layer: 0));
        var v = f.Project();

        Assert.True(v.Room.ActiveRound!.IsTiePhase);
        Assert.Equal(["ann", "bob"], v.Room.ActiveRound.TiedParticipants.Select(t => t.PlayerId));
        Assert.True(v.Viewer.IsTied);
        Assert.True(v.Viewer.Panels.TieBanner);
        Assert.Null(v.Viewer.OwnRoll);              // no layer-1 roll yet
        Assert.Equal(4, v.Viewer.LayerZeroOwnRoll); // layer 0 stays visible to RoundReveal
        Assert.True(v.Viewer.IsPlayersTurnToRoll);
        Assert.False(v.Viewer.NeedsRollInput);      // the TieRollModal owns tie rolling

        f.Rolls.Add(Roll("bob", 12, layer: 1));
        Assert.Equal(12, f.Project().Viewer.OwnRoll);
    }

    [Fact]
    public void A_viewer_outside_the_tie_sees_no_current_layer_roll()
    {
        var f = new ViewFixture { Viewer = "cat" }.ClosedRound(1, "ann", "bob", "cat");
        f.LayerParticipants.Add(new(RoundId, 1, "ann", T0, null));
        f.Rolls.Add(Roll("cat", 6, layer: 0));
        var v = f.Project();
        Assert.False(v.Viewer.IsTied);
        Assert.Null(v.Viewer.OwnRoll);
        Assert.Equal(6, v.Viewer.LayerZeroOwnRoll);
    }

    [Fact]
    public void Rolled_player_ids_name_who_rolled_the_current_layer_without_values()
    {
        var f = new ViewFixture().ClosedRound(0, "ann", "bob");
        f.Rolls.Add(Roll("bob", 8));
        var a = f.Project().Room.ActiveRound!;
        Assert.Equal(["bob"], a.RolledPlayerIds);
        Assert.True(a.Participants.Single(p => p.PlayerId == "bob").HasRolled);
        Assert.False(a.Participants.Single(p => p.PlayerId == "ann").HasRolled);
    }

    [Fact]
    public void Rolls_from_a_scrapped_generation_do_not_count()
    {
        var f = new ViewFixture().ClosedRound(0, "ann", "bob");
        f.Rounds[0] = Round(RoundId, "closed", closed: T0, generation: 2);
        f.Rolls.Add(Roll("ann", 9, generation: 1));
        Assert.Empty(f.Project().Room.ActiveRound!.RolledPlayerIds);
        Assert.Null(f.Project().Viewer.OwnRoll);
    }

    // ---- tea party revolt, held cards and their gates

    [Fact]
    public void Tea_party_revolt_panel_needs_a_picker_in_a_closed_layer_zero_round()
    {
        var r = Reads(x => x with { RevoltPickerId = "bob" });
        Assert.True(new ViewFixture().ClosedRound(0, "ann", "bob").With(_ => r).Project().Viewer.Panels.TeaPartyRevolt);
        Assert.False(new ViewFixture().OpenRound("ann", "bob").With(_ => r).Project().Viewer.Panels.TeaPartyRevolt);
    }

    private static HeldCard Held(string name, string time = "A") =>
        new(Guid.NewGuid(), "held", name, time, "PLAYER", "common", "text", null, "4th");

    [Fact]
    public void Action_card_pickers_only_show_in_an_open_round_or_for_a_compelled_action()
    {
        var reads = Reads(x => x with
        {
            HeldCards = [Held("Tea Heist"), Held("Last Drip")],
            Dispellable = [new(Guid.NewGuid(), "bob", "BOB", "Hex", "common")],
            HeistTargetIds = ["bob"],
            LastDripPreview = new("bob", null, []),
        });

        var open = new ViewFixture().OpenRound("ann", "bob").With(_ => reads).Project().Viewer;
        Assert.Single(open.DispellableEffects);
        Assert.Equal(["bob"], open.HeistTargetIds);
        Assert.NotNull(open.LastDripPreview);

        var closed = new ViewFixture().ClosedRound(0, "ann", "bob").With(_ => reads).Project().Viewer;
        Assert.Empty(closed.DispellableEffects);
        Assert.Empty(closed.HeistTargetIds);
        Assert.Null(closed.LastDripPreview);

        var compelled = new ViewFixture().ClosedRound(0, "ann", "bob")
            .With(_ => reads with { CompelledCast = new CompelledCastRow("A", "Hex", "bob") }).Project().Viewer;
        Assert.Single(compelled.DispellableEffects);
        Assert.NotNull(compelled.LastDripPreview);
    }

    [Fact]
    public void Heist_targets_and_last_drip_notice_need_the_card_in_hand()
    {
        var reads = Reads(x => x with { HeldCards = [Held("Hex")], HeistTargetIds = ["bob"], LastDripPreview = new("bob", null, []) });
        var v = new ViewFixture().OpenRound("ann", "bob").With(_ => reads).Project().Viewer;
        Assert.Empty(v.HeistTargetIds);
        Assert.Null(v.LastDripPreview);
    }

    [Fact]
    public void Held_reaction_card_is_the_held_reaction_timed_one()
    {
        var reaction = Held("Counter", "R");
        var v = new ViewFixture().With(_ => Reads(x => x with { HeldCards = [Held("Hex"), reaction] })).Project().Viewer;
        Assert.Equal(reaction.InstanceId, v.HeldReactionCard!.InstanceId);
    }

    [Fact]
    public void Pending_casts_only_while_closed_and_pending_dice_need_an_active_round()
    {
        var reads = Reads(x => x with
        {
            PendingCasts = [new(Guid.NewGuid(), "Hex", "OPPONENT")],
            PendingDice = [new(Guid.NewGuid(), "Cold Tea", "1d6")],
        });
        var open = new ViewFixture().OpenRound("ann", "bob").With(_ => reads).Project().Viewer;
        Assert.Empty(open.PendingCasts);
        Assert.Single(open.PendingSpellDice);
        Assert.True(open.Panels.PendingSpellDie);
        Assert.Equal("in_app_only", open.SpellDieRollInputMode);

        var idle = new ViewFixture().With(_ => reads).Project().Viewer;
        Assert.Empty(idle.PendingSpellDice);
        Assert.False(idle.Panels.PendingSpellDie);

        Assert.Single(new ViewFixture().ClosedRound(0, "ann", "bob").With(_ => reads).Project().Viewer.PendingCasts);
    }

    [Fact]
    public void Spell_draw_choice_lists_the_catalog_names_in_tier_then_name_order()
    {
        var f = new ViewFixture().With(_ => Reads(x => x with { PendingSpellDraw = new(Guid.NewGuid(), "nat20", 1) }));
        f.Cards.Add(new(Guid.NewGuid(), "Zap", "A", "SELF", "common", "t", null, null));
        f.Cards.Add(new(Guid.NewGuid(), "Amp", "A", "SELF", "rare", "t", null, null));
        f.Cards.Add(new(Guid.NewGuid(), "Boo", "A", "SELF", "common", "t", null, null));
        var d = f.Project().Viewer.PendingSpellDraw!;
        Assert.Equal(["Boo", "Zap", "Amp"], d.CatalogNames);
        Assert.True(f.Project().Viewer.Panels.SpellDrawChoice);
    }

    // ---- reaction window

    [Fact]
    public void Reaction_window_exposes_stack_pending_players_and_skip_vote_while_closed()
    {
        var reads = Reads(x => x with
        {
            ReactionWindow = new(Guid.NewGuid(), 0, 2, true, false),
            ReactionPendingPlayers = [new("bob", "BOB")],
            SkipVote = new(T0, 1, 2, false, true, false),
            CourageTokens = [new(Guid.NewGuid(), "bob", "BOB", "1d6")],
            CompelledCast = new CompelledCastRow("R", "Counter", "bob"),
        });
        var v = new ViewFixture().ClosedRound(0, "ann", "bob").With(_ => reads).Project().Viewer;
        Assert.True(v.Panels.ReactionBanner);
        Assert.Equal(2, v.Reaction!.PollRound);
        Assert.Single(v.Reaction.PendingPlayers);
        Assert.Single(v.Reaction.CourageTokens);
        Assert.True(v.Reaction.Compelled);
    }

    [Fact]
    public void Courage_tokens_only_ride_a_layer_zero_window_and_an_open_round_has_no_window()
    {
        var window1 = Reads(x => x with
        {
            ReactionWindow = new(Guid.NewGuid(), 1, 1, true, false),
            CourageTokens = [new(Guid.NewGuid(), "bob", "BOB", "1d6")],
        });
        var f = new ViewFixture().ClosedRound(1, "ann", "bob").With(_ => window1);
        f.LayerParticipants.Add(new(RoundId, 1, "ann", T0, null));
        Assert.Empty(f.Project().Viewer.Reaction!.CourageTokens);

        Assert.Null(new ViewFixture().OpenRound("ann", "bob").With(_ => window1).Project().Viewer.Reaction);
    }

    // ---- orders, menu, rating, replay

    [Fact]
    public void Order_round_is_the_active_round_else_the_latest_resolved_one()
    {
        var older = Guid.NewGuid();
        var f = new ViewFixture { Viewer = "ann" };
        f.Rounds.Add(Round(older, "resolved", resolved: T0.AddMinutes(-30), brewer: "bob"));
        f.Rounds.Add(Round(RoundId, "resolved", resolved: T0.AddMinutes(-5), brewer: "cat"));
        f.Participants.Add(Participant("ann", RoundId));
        var v = f.Project().Viewer;
        Assert.Equal(RoundId, v.OrderRoundId);
        Assert.True(v.Panels.Menu);
        Assert.Single(v.MenuParticipants);
        Assert.True(v.OrderCue);

        var open = new ViewFixture().OpenRound("ann", "bob").Project().Viewer;
        Assert.Equal(RoundId, open.OrderRoundId);
        Assert.Null(new ViewFixture().Project().Viewer.OrderRoundId);
        Assert.False(new ViewFixture().Project().Viewer.Panels.Menu);
    }

    [Fact]
    public void Sticky_default_drink_applies_only_when_the_round_has_no_order_yet()
    {
        var none = new ViewFixture().OpenRound("ann", "bob").WithExtras(e => e with { MyMostRecentOrder = "coffee" }).Project().Viewer;
        Assert.Equal("coffee", none.MyMostRecentOrder);
        Assert.Null(none.MyOrderForRound);
        Assert.True(none.OrderCue);

        var placed = new ViewFixture().OpenRound("ann", "bob")
            .WithExtras(e => e with { MyOrderForRound = "tea", MyMostRecentOrder = "coffee" }).Project().Viewer;
        Assert.Equal("tea", placed.MyOrderForRound);
        Assert.Null(placed.MyMostRecentOrder);
        Assert.False(placed.OrderCue);
    }

    [Fact]
    public void Rating_and_replay_panels_follow_their_extras()
    {
        var f = new ViewFixture().WithExtras(e => e with
        {
            Rateable = new(RoundId, "BOB", "bob@x.test", T0, 4),
            PendingReplay = new(RoundId, "bob", T0),
        });
        var v = f.Project().Viewer;
        Assert.True(v.Panels.BrewRating);
        Assert.Equal(4, v.RateableRound!.MyScore);
        Assert.True(v.Panels.RoundReplayPrompt);
        Assert.False(v.PendingRoundReplay!.IsCaster);
        Assert.Equal("BOB", v.PendingRoundReplay.CasterDisplayName);

        f.Viewer = "bob";
        Assert.True(f.Project().Viewer.PendingRoundReplay!.IsCaster);
    }

    // ---- history

    [Fact]
    public void History_lists_resolved_rounds_newest_first_with_the_brewer_name()
    {
        var a = Guid.NewGuid();
        var f = new ViewFixture();
        f.Rounds.Add(Round(a, "resolved", resolved: T0.AddMinutes(-20), brewer: "bob"));
        f.Rounds.Add(Round(RoundId, "resolved", resolved: T0.AddMinutes(-10), brewer: "cat"));
        f.Rounds.Add(Round(Guid.NewGuid(), "cancelled"));

        var h = f.Project().Room.History;
        Assert.Equal([RoundId, a], h.Select(x => x.RoundId));
        Assert.Equal("CAT", h[0].BrewerName);
        Assert.Equal("BOB", h[1].BrewerName);
    }

    [Fact]
    public void The_test_room_has_no_history()
    {
        var f = new ViewFixture { IsTest = true };
        f.Rounds.Add(Round(RoundId, "resolved", resolved: T0, brewer: "bob"));
        Assert.Empty(f.Project().Room.History);
    }

    // ---- viewer identity

    [Fact]
    public void The_projection_is_computed_for_the_viewer_it_is_given()
    {
        // Acting As is resolved before projection: an admin acting as bob is simply viewer "bob".
        var f = new ViewFixture().ClosedRound(0, "ann", "bob").With(r => r with { ExpectedRollerIds = ["ann", "bob"] });
        f.Rolls.Add(Roll("ann", 9));
        f.Viewer = "bob";
        var asBob = f.Project();
        Assert.Equal("bob", asBob.Viewer.PlayerId);
        Assert.True(asBob.Viewer.IsPlayersTurnToRoll);
        Assert.Null(asBob.Viewer.OwnRoll);
    }
}
