using System.Text.Json;
using System.Text.Json.Nodes;
using System.Text.RegularExpressions;
using RollForBrew.Domain.Dice;
using RollForBrew.Domain.Resolver;
using RollForBrew.Domain.Snapshot;

namespace RollForBrew.Tests.Harness;

/// <summary>One scenario's input fixture (tests/snapshots/inputs/*.input.json) and its golden path.</summary>
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

/// <summary>A die roller for goldens: every die shows the same face. The two Calami-Tea scenarios redact the die.</summary>
public sealed class ConstantDieRoller(int face = 1) : IDieRoller
{
    public int Roll(int sides) => Math.Min(face, sides);
}

/// <summary>
/// C# port of the TS golden writer (tests/snapshots/corpus/framework.ts: normaliseTrace, normaliseSummary,
/// normaliseScrappedGenerations, snapshotDocument), so the C# Resolution renders to the very text the goldens hold:
/// players become P:label, cast / effect ids become cast#N / fx#N by first appearance in the trace, other
/// uuids uuid#N, RNG values "&lt;rng&gt;"; output is JSON.stringify(doc, null, 2) + "\n".
/// </summary>
public static partial class GoldenWriter
{
    [GeneratedRegex("^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$", RegexOptions.IgnoreCase)]
    private static partial Regex UuidRe();

    private static readonly HashSet<string> AlwaysRng = ["rolled"];
    private static readonly HashSet<string> CalamiRng = ["rolled", "would_be_after"];

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
            ["trace"] = NormaliseTrace(TraceJson.ToNode(r.Trace), roster),
            ["players"] = r.Players is null ? null : NormaliseSummary(TraceJson.ToNode(r.Players), roster),
        };
        if (scrapped is { ValueKind: JsonValueKind.Array } s && s.GetArrayLength() > 0)
            doc["scrappedGenerations"] = new JsonArray([.. s.EnumerateArray().Select(g =>
            {
                var brewer = g.TryGetProperty("brewer_id", out var bid) && bid.ValueKind == JsonValueKind.String ? Label(bid.GetString()!) : null;
                var players = g.TryGetProperty("players", out var ps) && ps.ValueKind == JsonValueKind.Array
                    ? NormaliseSummary((JsonArray)TraceJson.Convert(ps)!, roster) : null;
                return (JsonNode?)new JsonObject { ["generation"] = g.GetProperty("generation").GetInt32(), ["brewer"] = brewer, ["players"] = players };
            })]);
        return TraceJson.Pretty(doc) + "\n";
    }

    public static JsonArray NormaliseSummary(JsonArray players, IReadOnlyDictionary<string, string> roster) =>
        new([.. players.Select(p =>
        {
            var src = (JsonObject)p!;
            var o = new JsonObject { ["player"] = roster.TryGetValue(src["player_id"]!.GetValue<string>(), out var l) ? l : "<unknown>" };
            foreach (var (k, v) in src) if (k != "player_id") o[k] = v?.DeepClone();
            return (JsonNode?)o;
        }).OrderBy(n => n!["player"]!.GetValue<string>(), StringComparer.InvariantCulture)]);

    public static JsonArray NormaliseTrace(JsonArray trace, IReadOnlyDictionary<string, string> roster)
    {
        var map = roster.ToDictionary(kv => kv.Key, kv => $"P:{kv.Value}");
        int castN = 0, fxN = 0, otherN = 0;

        void Assign(JsonNode? v, string kind)
        {
            if (v is not JsonValue jv || !jv.TryGetValue<string>(out var s) || !UuidRe().IsMatch(s) || map.ContainsKey(s)) return;
            map[s] = kind switch { "cast" => $"cast#{++castN}", "fx" => $"fx#{++fxN}", _ => $"uuid#{++otherN}" };
        }

        foreach (var step in trace.Cast<JsonObject>())
        {
            Assign(step["source_cast"]?["cast_id"], "cast");
            Assign(step["source_cast"]?["active_effect_id"], "fx");
            Assign(step["ward_cast_id"], "cast");
            Assign(step["blocked_cast_id"], "cast");
            Assign(step["redirected_to_cast_id"], "cast");
        }

        JsonNode? Walk(JsonNode? value, HashSet<string> rngKeys, string? key = null)
        {
            if (key is not null && rngKeys.Contains(key) && value is JsonValue rv
                && (rv.TryGetValue<string>(out _) || rv.TryGetValue<decimal>(out _) || rv.TryGetValue<int>(out _) || rv.TryGetValue<long>(out _)))
                return "<rng>";
            switch (value)
            {
                case JsonValue v when v.TryGetValue<string>(out var s):
                    if (map.TryGetValue(s, out var mapped)) return mapped;
                    if (UuidRe().IsMatch(s)) { Assign(v, "other"); return map[s]; }
                    return s;
                case JsonArray a when a.Count > 0 && a.All(x => x is JsonValue xv && xv.TryGetValue<string>(out var xs) && roster.ContainsKey(xs)):
                    return new JsonArray([.. a.Select(x => map[x!.GetValue<string>()]).OrderBy(x => x, StringComparer.Ordinal).Select(x => (JsonNode?)x)]);
                case JsonArray a:
                    return new JsonArray([.. a.Select(x => Walk(x, rngKeys))]);
                case JsonObject o:
                    var outObj = new JsonObject();
                    foreach (var (k, v) in o) outObj[k] = Walk(v, rngKeys, k);
                    return outObj;
                default:
                    return value?.DeepClone();
            }
        }

        return new JsonArray([.. trace.Cast<JsonObject>().Select(step =>
            Walk(step, step["source_cast"]?["card_name"]?.GetValue<string>() == "Calami-Tea" ? CalamiRng : AlwaysRng))]);
    }
}
