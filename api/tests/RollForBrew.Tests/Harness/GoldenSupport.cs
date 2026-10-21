using System.Text.Json;
using System.Text.Json.Nodes;
using System.Text.RegularExpressions;
using RollForBrew.Domain.Dice;
using RollForBrew.Domain.Resolver;
using RollForBrew.Domain.Snapshot;

namespace RollForBrew.Tests.Harness;

public sealed record GoldenFixture(string Name, RoundSnapshot Snapshot, Guid RoundId, IReadOnlyDictionary<string, string> Roster)
{
    public static string SnapshotsDir()
    {
        for (var dir = new DirectoryInfo(AppContext.BaseDirectory); dir is not null; dir = dir.Parent)
        {
            var candidate = Path.Combine(dir.FullName, "tests", "snapshots");
            if (Directory.Exists(Path.Combine(candidate, "inputs"))) return candidate;
        }
        throw new DirectoryNotFoundException("tests/snapshots/inputs not found above " + AppContext.BaseDirectory);
    }

    public static IReadOnlyList<string> AllNames() =>
        Directory.GetFiles(Path.Combine(SnapshotsDir(), "inputs"), "*.input.json")
            .Select(f => Path.GetFileName(f)[..^".input.json".Length])
            .Order(StringComparer.Ordinal).ToList();

    public static GoldenFixture Load(string name)
    {
        using var doc = JsonDocument.Parse(File.ReadAllText(Path.Combine(SnapshotsDir(), "inputs", name + ".input.json")));
        var root = doc.RootElement;
        return new GoldenFixture(
            name, RoundSnapshot.Parse(root.GetProperty("snapshot")), root.GetProperty("as_of_round_id").GetGuid(),
            root.GetProperty("roster").EnumerateObject().ToDictionary(p => p.Name, p => p.Value.GetString()!));
    }

    public string GoldenText() => File.ReadAllText(Path.Combine(SnapshotsDir(), Name + ".json"));
}

public sealed class ConstantDieRoller(int face = 1) : IDieRoller
{
    public int Roll(int sides) => Math.Min(face, sides);
}

public static partial class GoldenWriter
{
    public static string Render(string name, Resolution r, IReadOnlyDictionary<string, string> roster, JsonElement? scrapped = null)
    {
        string Label(string id) => roster.TryGetValue(id, out var l) ? l : "<unknown>";
        var doc = new JsonObject
        {
            ["scenario"] = name,
            ["outcome"] = r.Outcome,
            ["layer"] = r.Layer,
            ["brewer"] = r.BrewerId is { Length: > 0 } b ? Label(b) : null,
            ["brewerSource"] = r.BrewerSource,
            ["tiedPlayers"] = new JsonArray([.. (r.TiedPlayerIds ?? []).Select(Label).OrderBy(x => x, StringComparer.Ordinal).Select(x => (JsonNode?)x)]),
            ["cupsMade"] = r.CupsMade,
            ["noModifierGain"] = r.NoModifierGain,
            ["trace"] = TraceNormaliser.NormaliseTrace(TraceJson.ToNode(r.Trace), roster),
            ["players"] = r.Players is null ? null : TraceNormaliser.NormaliseSummary(TraceJson.ToNode(r.Players), roster),
        };
        if (scrapped is { ValueKind: JsonValueKind.Array } s && s.GetArrayLength() > 0)
            doc["scrappedGenerations"] = new JsonArray([.. s.EnumerateArray().Select(g =>
            {
                var brewer = g.TryGetProperty("brewer_id", out var bid) && bid.ValueKind == JsonValueKind.String ? Label(bid.GetString()!) : null;
                var players = g.TryGetProperty("players", out var ps) && ps.ValueKind == JsonValueKind.Array
                    ? TraceNormaliser.NormaliseSummary((JsonArray)TraceJson.Convert(ps)!, roster) : null;
                return (JsonNode?)new JsonObject { ["generation"] = g.GetProperty("generation").GetInt32(), ["brewer"] = brewer, ["players"] = players };
            })]);
        return TraceJson.Pretty(doc) + "\n";
    }
}
