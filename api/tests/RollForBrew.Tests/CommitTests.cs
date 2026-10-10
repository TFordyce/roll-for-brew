using System.Text.Json;
using System.Text.Json.Nodes;
using RollForBrew.Domain.Dice;
using RollForBrew.Domain.Resolver;
using RollForBrew.Domain.Snapshot;
using RollForBrew.Tests.Harness;

namespace RollForBrew.Tests;

public class CommitTests
{
    [Fact]
    public void A_resolving_round_becomes_the_write_list_SQL_would_have_made()
    {
        var fx = GoldenFixture.Load("6-heist-moved");
        var res = Evaluator.Evaluate(fx.Snapshot, fx.RoundId, new ScriptedDieRoller());
        var fxRoot = JsonDocument.Parse(File.ReadAllText(Path.Combine(
            FindInputsDir(), "..", "6-heist-moved.json")));

        var writes = Committer.Commit(res);

        Assert.Equal(
        [
            typeof(SetRoundTraceAndSummary), typeof(SetRoundResolution), typeof(IncrementRoomPlayerModifier),
            typeof(MoveHeistCard), typeof(RecordPendingReplay),
        ], writes.Select(w => w.GetType()));

        var traceWrite = (SetRoundTraceAndSummary)writes.Single(w => w is SetRoundTraceAndSummary);
        var storedTrace = JsonDocument.Parse(traceWrite.TraceJson).RootElement;
        Assert.Equal(
            fxRoot.RootElement.GetProperty("trace").EnumerateArray().Select(t => t.GetProperty("display_kind").GetString()),
            storedTrace.EnumerateArray().Select(t => t.GetProperty("display_kind").GetString()));

        var resolutionWrite = (SetRoundResolution)writes.Single(w => w is SetRoundResolution);
        Assert.Equal(res.BrewerId, resolutionWrite.BrewerId);
        Assert.Equal(res.CupsMade, resolutionWrite.CupsMade);
        Assert.Equal(res.ModifierGain ?? res.CupsMade, resolutionWrite.BrewerModifierGain);
        Assert.Equal(fx.Snapshot.DbNow, resolutionWrite.ResolvedAt);

        var increment = (IncrementRoomPlayerModifier)writes.Single(w => w is IncrementRoomPlayerModifier);
        Assert.Equal(res.BrewerId, increment.PlayerId);
        Assert.Equal(resolutionWrite.BrewerModifierGain, increment.Delta);

        var move = (MoveHeistCard)writes.Single(w => w is MoveHeistCard);
        var heist = res.Derived.HeistMoves.Single();
        Assert.Equal(heist.CastId, move.CastId);
        Assert.Equal(heist.InstanceId, move.InstanceId);
        Assert.Equal("held", move.Location);
        Assert.Equal(res.BrewerId, move.ThiefPlayerId);
    }

    [Fact]
    public void Modifier_cache_writes_equal_the_recompute_from_base_plus_other_round_deltas()
    {
        var fx = GoldenFixture.Load("4b-pre-bitter-leech-tick-synthesis");
        var anchor = fx.Snapshot.SpellCasts.Single(c => c.EffectParams?.TryGetProperty("per_round_delta", out _) == true);
        var victim = anchor.TargetPlayerId!;
        var caster = anchor.CasterId;

        var res = Evaluator.Evaluate(fx.Snapshot, fx.RoundId, new ScriptedDieRoller());
        var writes = Committer.Commit(res);

        var expected = new Dictionary<string, int> { [caster] = 1, [victim] = -1 };
        var cacheWrites = writes.OfType<SetRoomPlayerModifier>().ToDictionary(w => w.PlayerId, w => w.Value);
        Assert.Equal(expected, cacheWrites);
        Assert.Equal(expected, res.Derived.RoomPlayerModifiers.ToDictionary(kv => kv.Key, kv => kv.Value));
    }

    [Fact]
    public void A_tie_advances_a_layer_and_writes_no_resolution()
    {
        var fx = GoldenFixture.Load("05-brewer-immunity-all-immune-tie");

        var res = Evaluator.Evaluate(fx.Snapshot, fx.RoundId, new ScriptedDieRoller());
        var writes = Committer.Commit(res);

        Assert.Equal("tie", res.Outcome);
        Assert.DoesNotContain(writes, w => w is SetRoundResolution or IncrementRoomPlayerModifier or RecordPendingReplay);
        var advance = Assert.IsType<AdvanceTieLayer>(writes.Single(w => w is AdvanceTieLayer));
        Assert.Equal(res.TiedPlayerIds, advance.TiedPlayerIds);
    }

    [Fact]
    public void A_brew_debt_round_writes_the_brewer_source_record()
    {
        var fx = GoldenFixture.Load("05-brew-debt-round-paid");

        var res = Evaluator.Evaluate(fx.Snapshot, fx.RoundId, new ScriptedDieRoller());
        var writes = Committer.Commit(res);

        var source = Assert.IsType<SetBrewerSource>(writes.Single(w => w is SetBrewerSource));
        Assert.Equal("brew_debt", source.Source);
        Assert.Equal(res.BrewerRecord!.CastId, source.CastId);
    }

    [Fact]
    public void Commit_is_pure_and_leaves_the_resolution_untouched()
    {
        var fx = GoldenFixture.Load("4b-persistent-modifier-transfer-rest-of-day");
        var res = Evaluator.Evaluate(fx.Snapshot, fx.RoundId, new ScriptedDieRoller());
        var before = res.Derived.SynthesizedCasts.Count;

        var a = Committer.Commit(res);
        var b = Committer.Commit(res);

        Assert.Equal(a.Select(w => w.ToString()), b.Select(w => w.ToString()));
        Assert.Equal(before, res.Derived.SynthesizedCasts.Count);
    }

    private static string FindInputsDir()
    {
        var dir = new DirectoryInfo(AppContext.BaseDirectory);
        while (dir is not null && !Directory.Exists(Path.Combine(dir.FullName, "tests", "snapshots", "inputs")))
            dir = dir.Parent!;
        return Path.Combine(dir!.FullName, "tests", "snapshots", "inputs");
    }
}

public class Phase6HeistTests
{
    [Fact]
    public void A_thief_with_a_full_hand_fizzles_the_heist()
    {
        var fx = GoldenFixture.Load("6-heist-moved");
        var heist = fx.Snapshot.SpellCasts.Single(c => c.EffectKind == "card_heist");
        var thief = heist.CasterId;
        var snapshot = fx.Snapshot with
        {
            DeckInstances =
            [
                .. fx.Snapshot.DeckInstances,
                new DeckInstanceRow(Guid.NewGuid(), Guid.NewGuid(), "held", thief),
                new DeckInstanceRow(Guid.NewGuid(), Guid.NewGuid(), "pending_swap", thief),
            ],
        };

        var res = Evaluator.Evaluate(snapshot, fx.RoundId, new ScriptedDieRoller());

        Assert.Empty(res.Derived.HeistMoves);
        var step = res.Trace.Single(s => s.DisplayKind == "card_heist");
        Assert.Equal("fizzled", step.After.Value);
        Assert.Equal("thief_hand_full", step.Extras["heist_reason"]);
        Assert.Equal("no-op", step.Extras["outcome"]);
    }
}
