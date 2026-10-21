using System.Text.Json;
using System.Text.Json.Nodes;
using System.Text.RegularExpressions;

namespace RollForBrew.Domain.Resolver;

/// <summary>
/// The goldens' normalized-JSON comparison, shared by the golden renderer and the
/// slice 2a shadow diff (#546): player ids become labels where a roster is given,
/// unknown uuids become stable cast#N / fx#N aliases, RNG-drawn values collapse to
/// &lt;rng&gt; (a fresh die can never produce a false diff), and unordered player sets
/// sort. The shadow compares C#'s Resolution against SQL's written trace/summary
/// through exactly this shape, so a shadow pass means "the goldens' oracle agrees".
/// </summary>
public static partial class TraceNormaliser
{
    [GeneratedRegex("^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$", RegexOptions.IgnoreCase)]
    private static partial Regex UuidRe();

    private static readonly HashSet<string> AlwaysRng = ["rolled"];
    private static readonly HashSet<string> CalamiRng = ["rolled", "would_be_after"];

    public static JsonArray NormaliseSummary(JsonArray players, IReadOnlyDictionary<string, string> roster) =>
        new([.. players.Select(p =>
        {
            var src = (JsonObject)p!;
            // Entries already in the normalized shape (keyed "player") pass through,
            // so an already-normalised SQL side can be re-run safely.
            if (src["player_id"] is null) return (JsonNode?)src.DeepClone();
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

    /// <summary>Structural equality with numeric tolerance (1 == 1.0), so SQL's jsonb
    /// number rendering can never produce a false diff.</summary>
    public static bool NodesEqual(JsonNode? a, JsonNode? b) => (a, b) switch
    {
        (null, null) => true,
        (null, _) or (_, null) => false,
        (JsonObject x, JsonObject y) => x.Count == y.Count && x.All(kv => y.TryGetPropertyValue(kv.Key, out var v) && NodesEqual(kv.Value, v)),
        (JsonArray x, JsonArray y) => x.Count == y.Count && x.Zip(y).All(p => NodesEqual(p.First, p.Second)),
        (JsonValue, JsonValue) => NumberOrText(a, b),
        _ => false,
    };

    private static bool NumberOrText(JsonNode a, JsonNode b)
    {
        var va = (JsonValue)a;
        var vb = (JsonValue)b;
        if (va.TryGetValue<decimal>(out var da) && vb.TryGetValue<decimal>(out var db)) return da == db;
        if (va.TryGetValue<string>(out var sa)) return vb.TryGetValue<string>(out var sb) && sa == sb;
        if (va.TryGetValue<bool>(out var ba)) return vb.TryGetValue<bool>(out var bb) && ba == bb;
        return va.ToJsonString() == vb.ToJsonString();
    }
}
