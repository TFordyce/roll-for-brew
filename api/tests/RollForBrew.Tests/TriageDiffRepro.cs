using System.Text.Json;
using System.Text.Json.Nodes;
using RollForBrew.Api.RoundAdvance;
using RollForBrew.Domain.Resolver;
using RollForBrew.Domain.Snapshot;
using RollForBrew.Tests.Harness;

namespace RollForBrew.Tests;

/// <summary>Replays the 2026-10-27 11:19Z production shadow diff (round
/// f9e9dac2, fields trace+players) from the snapshot reconstructed off
/// PostgREST during triage. The artefacts only exist on the triage machine;
/// CI skips silently. The seeded regression pin lives in
/// RoundAdvanceTests.A_layer_1_rolloff_resolution_diffs_clean_despite_layer_0_trace_and_summary.</summary>
public class TriageDiffRepro
{
    private const string Dir = "C:/Users/tomfo/AppData/Local/Temp";
    private static readonly Guid Round = new("f9e9dac2-e154-486f-952c-ba975ead3467");

    [Fact]
    public void The_production_artefacts_replay_clean()
    {
        if (!File.Exists($"{Dir}/rfb-snapshot.json")) return;
        var snapshot = RoundSnapshot.Parse(File.ReadAllText($"{Dir}/rfb-snapshot.json"));
        var candidate = Evaluator.Evaluate(snapshot, Round, new ConstantDieRoller(1));
        var sql = new SqlSide(
            Layer: 1,
            Outcome: "brewer",
            BrewerId: "101575159398539475027",
            BrewerSource: null,
            CupsMade: 4,
            Rolloff: false,
            TiedPlayerIds: [],
            Trace: JsonNode.Parse(File.ReadAllText($"{Dir}/rfb-sqltrace.json")),
            Summary: JsonNode.Parse(File.ReadAllText($"{Dir}/rfb-sqlsummary.json")),
            ModifierGain: 4);
        var fields = ShadowDiff.Compare(candidate, sql, Roster(candidate, sql));
        Assert.True(fields.Count == 0, $"shadow fields differ: {string.Join(",", fields)}");
    }

    private static IReadOnlyDictionary<string, string> Roster(Resolution candidate, SqlSide sql)
    {
        var ids = new SortedSet<string>(StringComparer.Ordinal);
        if (candidate.BrewerId is { } b) ids.Add(b);
        if (sql.BrewerId is { } sb) ids.Add(sb);
        foreach (var p in candidate.TiedPlayerIds ?? []) ids.Add(p);
        foreach (var t in sql.TiedPlayerIds) ids.Add(t);
        foreach (var step in TraceJson.ToNode(candidate.Trace).Cast<JsonObject>())
            if (step["target_player"] is JsonValue { } v && v.TryGetValue<string>(out var t)) ids.Add(t);
        if (candidate.Players is { } players)
            foreach (var e in players) ids.Add(e.PlayerId);
        if (sql.Summary is { } summary)
            foreach (var e in (summary as JsonArray ?? []).OfType<JsonObject>())
                if (e["player_id"] is JsonValue { } v && v.TryGetValue<string>(out var p)) ids.Add(p);
        return ids.ToDictionary(id => id, id => id);
    }
}
