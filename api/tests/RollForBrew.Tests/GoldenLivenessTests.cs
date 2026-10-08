using System.Text.Json;
using RollForBrew.Domain.Liveness;
using RollForBrew.Domain.Snapshot;

namespace RollForBrew.Tests;

/// <summary>
/// Golden-driven liveness (#537). "In scope" = every corpus scenario that has an input fixture
/// (tests/snapshots/inputs/*.input.json, emitted by the TS runner from the state each golden resolved from).
/// For each, the C# port of _rr_active_effects_as_of, run in memory over the fixture, must produce byte-for-byte
/// the live-effect id list that SQL returned for the same round (the oracle stored in the fixture). Evaluate
/// output (Trace / Summary vs the goldens themselves) comes with #542; this slice never reads or writes a golden.
/// </summary>
public class GoldenLivenessTests
{
    private static string SnapshotsDir()
    {
        for (var dir = new DirectoryInfo(AppContext.BaseDirectory); dir is not null; dir = dir.Parent)
        {
            var candidate = Path.Combine(dir.FullName, "tests", "snapshots");
            if (Directory.Exists(Path.Combine(candidate, "inputs"))) return candidate;
        }
        throw new DirectoryNotFoundException("tests/snapshots/inputs not found above " + AppContext.BaseDirectory);
    }

    public static IEnumerable<object[]> Scenarios() =>
        Directory.GetFiles(Path.Combine(SnapshotsDir(), "inputs"), "*.input.json")
            .Select(f => Path.GetFileName(f)[..^".input.json".Length])
            .Order(StringComparer.Ordinal)
            .Select(n => new object[] { n });

    /// <summary>Same shape as JSON.stringify(ids, null, 2) + "\n" so the comparison is on bytes, not parsed values.</summary>
    private static string Canonical(IEnumerable<Guid> ids)
    {
        var list = ids.Select(i => i.ToString()).Order(StringComparer.Ordinal).ToList();
        return list.Count == 0 ? "[]\n" : "[\n" + string.Join(",\n", list.Select(i => $"  \"{i}\"")) + "\n]\n";
    }

    [Theory]
    [MemberData(nameof(Scenarios))]
    public void Live_effects_match_the_sql_oracle_byte_for_byte(string scenario)
    {
        var dir = SnapshotsDir();
        Assert.True(File.Exists(Path.Combine(dir, scenario + ".json")), $"no golden for fixture {scenario}");

        using var doc = JsonDocument.Parse(File.ReadAllText(Path.Combine(dir, "inputs", scenario + ".input.json")));
        var snapshot = RoundSnapshot.Parse(doc.RootElement.GetProperty("snapshot"));
        var asOf = doc.RootElement.GetProperty("as_of_round_id").GetGuid();
        var expected = doc.RootElement.GetProperty("expected").GetProperty("live_effect_ids")
            .EnumerateArray().Select(e => e.GetGuid());

        var actual = ActiveEffects.AsOf(snapshot, snapshot.RoomId, asOf).Select(e => e.Id);

        Assert.Equal(Canonical(expected), Canonical(actual));
    }

    [Fact]
    public void Every_golden_has_an_input_fixture()
    {
        var dir = SnapshotsDir();
        var goldens = Directory.GetFiles(dir, "*.json").Select(f => Path.GetFileNameWithoutExtension(f)).ToHashSet();
        var fixtures = Scenarios().Select(o => (string)o[0]).ToHashSet();
        Assert.Empty(goldens.Except(fixtures));
        Assert.Empty(fixtures.Except(goldens));
    }

    [Fact]
    public void The_corpus_exercises_liveness_not_just_empty_sets()
    {
        var withLive = Scenarios().Count(o =>
        {
            using var doc = JsonDocument.Parse(File.ReadAllText(Path.Combine(SnapshotsDir(), "inputs", (string)o[0] + ".input.json")));
            return doc.RootElement.GetProperty("expected").GetProperty("live_effect_ids").GetArrayLength() > 0;
        });
        Assert.True(withLive >= 10, $"only {withLive} fixtures have live effects");
    }
}
