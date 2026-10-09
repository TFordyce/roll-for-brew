using RollForBrew.Domain.Resolver;
using RollForBrew.Tests.Harness;
using Xunit.Abstractions;

namespace RollForBrew.Tests;

public class GoldenEvaluateTests(ITestOutputHelper output)
{
    public static IEnumerable<object[]> Scenarios() => GoldenFixture.AllNames().Select(n => new object[] { n });

    private enum Result { Match, Mismatch, Pending }

    private static (Result Result, string Detail) Run(string name)
    {
        var fx = GoldenFixture.Load(name);
        try
        {
            var resolution = Evaluator.Evaluate(fx.Snapshot, fx.RoundId, new ConstantDieRoller());
            var round = fx.Snapshot.Rounds.Single(r => r.Id == fx.RoundId);
            var actual = GoldenWriter.Render(name, resolution, fx.Roster, round.ScrappedGenerations);
            return actual == fx.GoldenText() ? (Result.Match, "") : (Result.Mismatch, actual);
        }
        catch (PhasePendingException e)
        {
            return (Result.Pending, e.Message);
        }
    }

    [Theory]
    [MemberData(nameof(Scenarios))]
    public void Evaluate_matches_the_golden_byte_for_byte_or_is_listed_pending(string name)
    {
        var (result, detail) = Run(name);
        if (PendingGoldens.Names.Contains(name))
        {
            Assert.True(result != Result.Match, $"{name} now matches its golden: remove it from PendingGoldens.");
            return;
        }
        Assert.True(result == Result.Match,
            result == Result.Pending ? $"{name} hit an unported phase but is not listed pending: {detail}" : $"{name} differs from its golden. Actual:\n{detail}");
    }

    [Fact]
    public void The_pending_set_is_named_counted_and_only_names_real_goldens()
    {
        var all = GoldenFixture.AllNames();
        Assert.Empty(PendingGoldens.Names.Except(all));
        Assert.Equal(PendingGoldens.Names.Count, PendingGoldens.Names.Distinct().Count());
        var passing = all.Count - PendingGoldens.Names.Count;
        output.WriteLine($"golden scenarios: {all.Count}; passing: {passing}; pending: {PendingGoldens.Names.Count}");
        foreach (var n in PendingGoldens.Names.Order(StringComparer.Ordinal)) output.WriteLine($"  pending: {n}");
        Assert.Equal(72, all.Count);
    }

    [Theory]
    [InlineData("0-spell-copy-onto-apprentice-caster")]
    [InlineData("1-brewmageddon-compelled-cast-and-forfeit")]
    [InlineData("1-contested-negate-fails-is-noop-step")]
    [InlineData("1-contested-negate-succeeds")]
    [InlineData("1-counter-of-counter-depth-2")]
    [InlineData("1-nat1-backfire-reapplies-onto-reactor")]
    [InlineData("1-redirect-retargets-modifier-cast")]
    [InlineData("2-ward-blocks-modifier-cast")]
    [InlineData("2-ward-blocks-roll-transform")]
    public void Ticket_542_phase_0_1_2_scenarios_pass_now(string name)
    {
        Assert.DoesNotContain(name, PendingGoldens.Names);
        var (result, detail) = Run(name);
        Assert.True(result == Result.Match, detail);
    }
}
