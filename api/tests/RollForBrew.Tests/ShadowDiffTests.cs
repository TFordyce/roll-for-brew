using System.Text.Json.Nodes;
using RollForBrew.Api.RoundAdvance;
using RollForBrew.Domain.Dice;
using RollForBrew.Domain.Resolver;
using RollForBrew.Tests.Harness;

namespace RollForBrew.Tests;

/// <summary>
/// The shadow diff comparator (#546). The SQL side of each case is built from a
/// golden file -- the independent oracle -- so a green Compare means "SQL wrote what
/// the goldens' oracle says C# should have", not that the code agrees with itself.
/// </summary>
public class ShadowDiffTests
{
    private static readonly string Scenario = "3-forced-reroll-adopted";

    private static (Resolution Candidate, SqlSide Sql) Matching()
    {
        var fx = GoldenFixture.Load(Scenario);
        var candidate = Evaluator.Evaluate(fx.Snapshot, fx.RoundId, new ConstantDieRoller());
        var golden = JsonNode.Parse(fx.GoldenText())!;
        var labelToId = fx.Roster.ToDictionary(kv => kv.Value, kv => kv.Key);
        var outcome = golden["outcome"]!.GetValue<string>();
        var isTie = outcome is "tie" or "rolloff";
        var sql = new SqlSide(
            Layer: golden["layer"]!.GetValue<int>() + (isTie ? 1 : 0),
            Outcome: isTie ? "tie" : outcome,
            BrewerId: golden["brewer"] is { } b ? labelToId[b.GetValue<string>()] : null,
            // rounds.brewer_source only ever holds the brewer-record source; the
            // golden's brewerSource label is the resolver's in-memory value.
            BrewerSource: null,
            CupsMade: golden["cupsMade"]!.GetValue<int>(),
            Rolloff: outcome == "rolloff",
            TiedPlayerIds: [.. golden["tiedPlayers"]!.AsArray().Select(x => labelToId[x!.GetValue<string>()])],
            Trace: golden["trace"]!.DeepClone(),
            Summary: golden["players"] is { } p ? p.DeepClone() : null,
            ModifierGain: null);
        return (candidate, sql);
    }

    [Fact]
    public void A_resolution_that_matches_its_golden_produces_no_diff_against_the_same_outcome_from_sql()
    {
        var (candidate, sql) = Matching();
        Assert.Empty(ShadowDiff.Compare(candidate, sql, GoldenFixture.Load(Scenario).Roster));
    }

    [Fact]
    public void A_tampered_outcome_is_named()
    {
        var (candidate, sql) = Matching();
        Assert.Contains("outcome", ShadowDiff.Compare(candidate, sql with { Outcome = "tie" }, GoldenFixture.Load(Scenario).Roster));
    }

    [Fact]
    public void A_tampered_brewer_is_named()
    {
        var (candidate, sql) = Matching();
        Assert.Contains("brewer", ShadowDiff.Compare(candidate, sql with { BrewerId = "someone-else" }, GoldenFixture.Load(Scenario).Roster));
    }

    [Fact]
    public void A_tampered_cups_made_is_named()
    {
        var (candidate, sql) = Matching();
        Assert.Contains("cups", ShadowDiff.Compare(candidate, sql with { CupsMade = sql.CupsMade + 1 }, GoldenFixture.Load(Scenario).Roster));
    }

    [Fact]
    public void A_tampered_trace_is_named()
    {
        var (candidate, sql) = Matching();
        var trace = (JsonArray)sql.Trace!.DeepClone();
        trace.RemoveAt(trace.Count - 1);
        Assert.Contains("trace", ShadowDiff.Compare(candidate, sql with { Trace = trace }, GoldenFixture.Load(Scenario).Roster));
    }

    [Fact]
    public void Sql_number_rendering_never_produces_a_false_diff()
    {
        // SQL jsonb keeps numeric scale ("1.0") where C# renders "1"; the structural
        // equality the diff uses compares them as numbers.
        Assert.True(TraceNormaliser.NodesEqual(JsonNode.Parse("""{"total": 1}"""), JsonNode.Parse("""{"total": 1.0}""")));
        Assert.False(TraceNormaliser.NodesEqual(JsonNode.Parse("""{"total": 1}"""), JsonNode.Parse("""{"total": 2.0}""")));
    }

    [Fact]
    public void A_tampered_summary_is_named()
    {
        var (candidate, sql) = Matching();
        var roster = GoldenFixture.Load(Scenario).Roster;
        var summary = (JsonArray)sql.Summary!.DeepClone();
        ((JsonObject)summary[0]!)["total"] = 99;
        Assert.Contains("players", ShadowDiff.Compare(candidate, sql with { Summary = summary }, roster));
    }

    [Fact]
    public void A_tie_payload_differs_only_by_the_layer_sql_advanced_to()
    {
        var fx = GoldenFixture.Load("05-loose-leaf-rolloff");
        var candidate = Evaluator.Evaluate(fx.Snapshot, fx.RoundId, new ConstantDieRoller());
        var golden = JsonNode.Parse(fx.GoldenText())!;
        var labelToId = fx.Roster.ToDictionary(kv => kv.Value, kv => kv.Key);
        var sql = new SqlSide(
            Layer: golden["layer"]!.GetValue<int>() + 1,
            Outcome: "tie",
            BrewerId: null,
            BrewerSource: null,
            CupsMade: golden["cupsMade"]!.GetValue<int>(),
            Rolloff: true,
            TiedPlayerIds: [.. golden["tiedPlayers"]!.AsArray().Select(x => labelToId[x!.GetValue<string>()])],
            Trace: golden["trace"]!.DeepClone(),
            Summary: golden["players"] is { } p ? p.DeepClone() : null,
            ModifierGain: null);
        Assert.Empty(ShadowDiff.Compare(candidate, sql, fx.Roster));
    }
}
