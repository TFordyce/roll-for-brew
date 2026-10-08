using System.Text.Json;
using RollForBrew.Domain.Dice;
using RollForBrew.Domain.Resolver;
using RollForBrew.Domain.Snapshot;
using RollForBrew.Tests.Harness;

namespace RollForBrew.Tests;

public class EvaluatePipelineTests
{
    [Fact]
    public void Phase_order_is_the_order_SQL_executes_including_4c_before_4b()
    {
        // _rr_resolve_eval order, NOT the ticket numbering: 0b and 2 follow 1; 4c runs before 4b; the 4b-pre tick
        // synthesis runs before the 4b projection that reads its rows; the Summary sits between 4b and Phase 5.
        Assert.Equal(
            ["load-rollers", "roll-frozen", "roll-exemption", "0a", "1", "1-ward-blocked-prepass", "1-brewmageddon-prepass",
             "0b", "2", "3-pre", "3", "4a", "4c", "4b-pre", "4b", "summary", "5", "6"],
            Evaluator.PhaseIds);
        Assert.True(Evaluator.PhaseIds.ToList().IndexOf("4c") < Evaluator.PhaseIds.ToList().IndexOf("4b"));
    }

    [Fact]
    public void Evaluate_is_deterministic_and_leaves_the_snapshot_untouched()
    {
        var fx = GoldenFixture.Load("0-spell-copy-onto-apprentice-caster"); // synthesises a copy row internally
        var before = fx.Snapshot.SpellCasts.ToList();
        var a = GoldenWriter.Render(fx.Name, Evaluator.Evaluate(fx.Snapshot, fx.RoundId, new NoDiceRoller()), fx.Roster);
        var b = GoldenWriter.Render(fx.Name, Evaluator.Evaluate(fx.Snapshot, fx.RoundId, new NoDiceRoller()), fx.Roster);
        Assert.Equal(a, b);
        Assert.Equal(before, fx.Snapshot.SpellCasts); // the working copy is private
        var derived = Evaluator.Evaluate(fx.Snapshot, fx.RoundId, new NoDiceRoller()).Derived;
        Assert.Single(derived.SynthesizedCasts); // the Apprentice copy, as derived cast state for Commit
    }

    [Fact]
    public void A_round_with_no_due_dice_never_touches_the_roller()
    {
        var fx = GoldenFixture.Load("1-contested-negate-succeeds");
        var roller = new ScriptedDieRoller();
        Evaluator.Evaluate(fx.Snapshot, fx.RoundId, roller);
        Assert.Empty(roller.Requests);
    }

    [Fact]
    public void Scripted_roller_replays_its_script_records_requests_and_rejects_bad_values()
    {
        var r = new ScriptedDieRoller(3, 4);
        Assert.Equal(3, r.Roll(4));
        Assert.Equal(4, r.Roll(4));
        Assert.Equal([4, 4], r.Requests);
        Assert.Throws<InvalidOperationException>(() => r.Roll(4)); // exhausted
        Assert.Throws<InvalidOperationException>(() => new ScriptedDieRoller(5).Roll(4)); // not a d4
    }

    // ---- tie layers: early return, empty trace -------------------------------------------------

    private static RoundSnapshot TieLayerSnapshot(int[] rolls, int[] snapshots, int layer = 1)
    {
        var room = Guid.NewGuid(); var round = Guid.NewGuid(); var t0 = DateTimeOffset.Parse("2026-01-01T00:00:00Z");
        var ids = rolls.Select((_, i) => $"p{i}").ToArray();
        return new RoundSnapshot(room, t0,
            [new RoomRow(room, false)],
            [new RoundRow(round, room, ids[0], "closed", t0, null, t0, null, null, layer, 0, 0, [], null, null, null)],
            ids.Select(p => new RoundParticipantRow(round, p, t0, null)).ToList(),
            ids.Select(p => new RoundLayerParticipantRow(round, layer, p, t0, null)).ToList(),
            ids.Select((p, i) => new RollRow(round, p, layer, rolls[i], "manual", snapshots[i], t0, null, false, 0)).ToList(),
            [], [], [], [], [], [], []);
    }

    [Fact]
    public void Tie_layer_with_one_lowest_roller_names_a_default_brewer_with_an_empty_trace_and_no_summary()
    {
        var r = Evaluator.Evaluate(TieLayerSnapshot([9, 4, 12], [0, 0, 0]), new NoDiceRoller());
        Assert.Equal("brewer", r.Outcome);
        Assert.Equal(1, r.Layer);
        Assert.Equal("p1", r.BrewerId);
        Assert.Equal("default", r.BrewerSource);
        Assert.Null(r.TiedPlayerIds);
        Assert.Equal(3, r.CupsMade);
        Assert.Empty(r.Trace);
        Assert.Null(r.Players);
        Assert.False(r.NoModifierGain);
        Assert.Null(r.ModifierGain);
    }

    [Fact]
    public void Tie_layer_with_equal_lowest_totals_ties_again_and_lists_the_tied_players_ordinally()
    {
        var r = Evaluator.Evaluate(TieLayerSnapshot([5, 5, 12], [1, 1, 0]), new NoDiceRoller());
        Assert.Equal("tie", r.Outcome);
        Assert.Null(r.BrewerId);
        Assert.Null(r.BrewerSource);
        Assert.Equal(["p0", "p1"], r.TiedPlayerIds);
        Assert.Empty(r.Trace);
        Assert.Null(r.Players);
    }

    [Fact]
    public void Tie_layer_natural_one_loses_before_totals_are_compared()
    {
        var r = Evaluator.Evaluate(TieLayerSnapshot([1, 2, 12], [9, 0, 0]), new NoDiceRoller());
        Assert.Equal("p0", r.BrewerId); // 1+9 > 2+0, but a natural 1 loses first
    }

    [Fact]
    public void Tie_layer_waits_for_every_expected_roller()
    {
        var s = TieLayerSnapshot([9, 4], [0, 0]);
        var short1 = s with { Rolls = s.Rolls.Take(1).ToList() };
        var e = Assert.Throws<ResolveException>(() => Evaluator.Evaluate(short1, new NoDiceRoller()));
        Assert.Equal("resolve_round_not_all_rolled", e.Code);
    }

    [Fact]
    public void Unknown_round_is_a_named_error()
    {
        var s = TieLayerSnapshot([9, 4], [0, 0]);
        var e = Assert.Throws<ResolveException>(() => Evaluator.Evaluate(s, Guid.NewGuid(), new NoDiceRoller()));
        Assert.Equal("resolve_round_not_found", e.Code);
    }

    // ---- Trace / Summary wire shape (frozen, ADR 0010) -----------------------------------------

    [Fact]
    public void Trace_step_keys_serialise_in_postgres_jsonb_order_length_then_bytewise()
    {
        var step = TraceStep.Create(3, "warded", new SourceCast(Guid.Parse("00000000-0000-4000-8000-000000000001"), null, "Kettle", "p1"),
            "p2", TraceValue.Modifier(1), TraceValue.Modifier(1),
            ("blocked_cast_id", null), ("ward_card_name", "Ward"), ("would_be_after", 2.5m), ("outcome", "blocked"), ("die", 4), ("rolled", 3));
        var json = TraceJson.Pretty(TraceJson.ToNode(step));
        var keys = JsonDocument.Parse(json).RootElement.EnumerateObject().Select(p => p.Name).ToList();
        Assert.Equal(
            ["die", "after", "index", "before", "rolled", "outcome", "source_cast", "display_kind", "target_player",
             "ward_card_name", "would_be_after", "blocked_cast_id"],
            keys);
        var inner = JsonDocument.Parse(json).RootElement.GetProperty("source_cast").EnumerateObject().Select(p => p.Name);
        Assert.Equal(["cast_id", "card_name", "active_effect_id", "caster_player_id"], inner);
    }

    [Fact]
    public void Step_outcome_is_noop_when_nothing_moved_applied_otherwise_and_extras_win()
    {
        TraceStep S(decimal a, decimal b, params (string, object?)[] x) =>
            TraceStep.Create(0, "flat_modifier", SourceCast.None, "p", TraceValue.Modifier(a), TraceValue.Modifier(b), x);
        Assert.Equal("no-op", S(2, 2.0m).Outcome);
        Assert.Equal("applied", S(2, 3).Outcome);
        Assert.Equal("blocked", S(2, 3, ("outcome", "blocked")).Outcome);
    }

    [Fact]
    public void Summary_entry_serialises_with_jsonb_key_order_and_js_style_numbers()
    {
        var json = TraceJson.Pretty(TraceJson.ToNode(new SummaryEntry("p1", 10, 0m, 6.0m, 16.0m, null, false)));
        Assert.Equal(
            "{\n  \"nat\": null,\n  \"roll\": 10,\n  \"total\": 16,\n  \"composed\": 6,\n  \"snapshot\": 0,\n  \"player_id\": \"p1\",\n  \"dice_reduced\": false\n}",
            json);
    }

    [Fact]
    public void Writer_matches_JSON_stringify_for_text_and_empty_containers()
    {
        var step = TraceStep.Create(0, "x", SourceCast.None, null, TraceValue.Status("a<b>&'é\"\\"), TraceValue.Status("b"),
            ("empty_list", new List<object?>()), ("empty_obj", new Dictionary<string, object?>()));
        var json = TraceJson.Pretty(TraceJson.ToNode(step));
        Assert.Contains("\"value\": \"a<b>&'é\\\"\\\\\"", json); // no HTML / non-ASCII escaping, like JSON.stringify
        Assert.Contains("\"empty_list\": []", json);
        Assert.Contains("\"empty_obj\": {}", json);
    }
}
