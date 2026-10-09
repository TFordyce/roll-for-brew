using System.Globalization;
using System.Text;
using System.Text.Json;
using System.Text.Json.Nodes;

namespace RollForBrew.Domain.Resolver;

/// <summary>Who caused a Trace step. Every part is nullable (a ward, a tick, a frozen roll have no cast).</summary>
public sealed record SourceCast(Guid? CastId, Guid? ActiveEffectId, string? CardName, string? CasterPlayerId)
{
    public static readonly SourceCast None = new(null, null, null, null);
}

/// <summary>A before/after cell. <see cref="Type"/> is modifier|roll|status|target; Value is decimal, string or null.</summary>
public sealed record TraceValue(string Type, object? Value)
{
    public static TraceValue Modifier(decimal? v) => new("modifier", v);
    public static TraceValue Roll(decimal? v) => new("roll", v);
    public static TraceValue Status(string v) => new("status", v);
    public static TraceValue Target(string? v) => new("target", v);

    internal bool SameAs(TraceValue o) => Type == o.Type && TraceJson.ValueEquals(Value, o.Value);
}

/// <summary>
/// One Resolution Trace step. The fixed keys are typed; <see cref="Extras"/> carries the kind-specific top-level
/// keys (die, sign, ward_cast_id, would_be_after, redirected_to_cast_id, rest_of_day, op, condition ...) exactly as
/// SQL's <c>_rr_trace_step(...) || p_extra</c>: extras win on a key collision (e.g. an explicit "outcome").
/// Extra values may be string, bool, int/long/decimal, Guid, null, JsonElement, or lists / string-keyed
/// dictionaries of those. Serialised key order is jsonb's (length, then bytewise) - see <see cref="TraceJson"/>.
/// </summary>
public sealed record TraceStep(
    int Index,
    string DisplayKind,
    SourceCast SourceCast,
    string? TargetPlayer,
    TraceValue Before,
    TraceValue After,
    IReadOnlyDictionary<string, object?> Extras)
{
    /// <summary>"no-op" when before equals after, else "applied"; an extras "outcome" overrides it.</summary>
    public string Outcome =>
        Extras.TryGetValue("outcome", out var o) && o is string s ? s : Before.SameAs(After) ? "no-op" : "applied";

    public static readonly IReadOnlyDictionary<string, object?> NoExtras = new Dictionary<string, object?>();

    public static TraceStep Create(
        int index, string kind, SourceCast source, string? target, TraceValue before, TraceValue after,
        params (string Key, object? Value)[] extras) =>
        new(index, kind, source, target, before, after,
            extras.Length == 0 ? NoExtras : extras.ToDictionary(e => e.Key, e => e.Value));
}

/// <summary>
/// Trace/Summary to the frozen jsonb wire shape (ADR 0010: byte-for-byte). Two things differ from
/// System.Text.Json defaults and are deliberate: object keys follow Postgres jsonb order (shorter key first,
/// then bytewise), and the writer emits what JSON.stringify(x, null, 2) emits (literal non-ASCII and &lt; &gt; &amp;,
/// no trailing zeros on numbers) so TS-parsed goldens compare equal.
/// </summary>
public static class TraceJson
{
    /// <summary>Postgres jsonb object key order: byte length first, then memcmp (UTF-8 ordinal).</summary>
    public static readonly IComparer<string> KeyOrder = Comparer<string>.Create((a, b) =>
    {
        var la = Encoding.UTF8.GetByteCount(a);
        var lb = Encoding.UTF8.GetByteCount(b);
        if (la != lb) return la.CompareTo(lb);
        return string.CompareOrdinal(a, b); // UTF-16 ordinal == UTF-8 bytewise except for surrogate pairs; ids are ASCII
    });

    public static JsonArray ToNode(IEnumerable<TraceStep> trace) => new([.. trace.Select(ToNode)]);

    public static JsonArray ToNode(IEnumerable<SummaryEntry> summary) => new([.. summary.Select(ToNode)]);

    public static JsonObject ToNode(SummaryEntry e) => Obj(
        ("player_id", e.PlayerId), ("roll", e.Roll), ("snapshot", e.Snapshot), ("composed", e.Composed),
        ("total", e.Total), ("nat", e.Nat), ("dice_reduced", e.DiceReduced));

    public static JsonObject ToNode(TraceStep s)
    {
        var fields = new Dictionary<string, object?>
        {
            ["index"] = s.Index,
            ["display_kind"] = s.DisplayKind,
            ["source_cast"] = new Dictionary<string, object?>
            {
                ["cast_id"] = s.SourceCast.CastId,
                ["active_effect_id"] = s.SourceCast.ActiveEffectId,
                ["card_name"] = s.SourceCast.CardName,
                ["caster_player_id"] = s.SourceCast.CasterPlayerId,
            },
            ["target_player"] = s.TargetPlayer,
            ["before"] = new Dictionary<string, object?> { ["type"] = s.Before.Type, ["value"] = s.Before.Value },
            ["after"] = new Dictionary<string, object?> { ["type"] = s.After.Type, ["value"] = s.After.Value },
            ["outcome"] = s.Outcome,
        };
        foreach (var (k, v) in s.Extras) fields[k] = v;
        return (JsonObject)Convert(fields)!;
    }

    private static JsonObject Obj(params (string, object?)[] fields) =>
        (JsonObject)Convert(fields.ToDictionary(f => f.Item1, f => f.Item2))!;

    /// <summary>Converts a plain object graph to a JsonNode tree with every object's keys in jsonb order.</summary>
    public static JsonNode? Convert(object? v) => v switch
    {
        null => null,
        JsonNode n => n.DeepClone(),
        JsonElement e => FromElement(e),
        string s => JsonValue.Create(s),
        bool b => JsonValue.Create(b),
        Guid g => JsonValue.Create(g.ToString()),
        int i => JsonValue.Create(i),
        long l => JsonValue.Create(l),
        decimal d => JsonValue.Create(d),
        IReadOnlyDictionary<string, object?> d => SortedObject(d.Select(kv => (kv.Key, Convert(kv.Value)))),
        IEnumerable<KeyValuePair<string, object?>> kvs => SortedObject(kvs.Select(kv => (kv.Key, Convert(kv.Value)))),
        System.Collections.IEnumerable list => new JsonArray([.. list.Cast<object?>().Select(Convert)]),
        _ => throw new NotSupportedException($"cannot serialise {v.GetType()}"),
    };

    private static JsonObject SortedObject(IEnumerable<(string Key, JsonNode? Value)> fields)
    {
        var o = new JsonObject();
        foreach (var (k, val) in fields.OrderBy(f => f.Key, KeyOrder)) o[k] = val;
        return o;
    }

    private static JsonNode? FromElement(JsonElement e) => e.ValueKind switch
    {
        JsonValueKind.Null or JsonValueKind.Undefined => null,
        JsonValueKind.True => JsonValue.Create(true),
        JsonValueKind.False => JsonValue.Create(false),
        JsonValueKind.String => JsonValue.Create(e.GetString()),
        JsonValueKind.Number => JsonValue.Create(e.GetDecimal()),
        JsonValueKind.Array => new JsonArray([.. e.EnumerateArray().Select(FromElement)]),
        _ => SortedObject(e.EnumerateObject().Select(p => (p.Name, FromElement(p.Value)))),
    };

    internal static bool ValueEquals(object? a, object? b) => (a, b) switch
    {
        (null, null) => true,
        (null, _) or (_, null) => false,
        (string x, string y) => x == y,
        (string, _) or (_, string) => false,
        _ => System.Convert.ToDecimal(a, CultureInfo.InvariantCulture) == System.Convert.ToDecimal(b, CultureInfo.InvariantCulture),
    };

    /// <summary>JSON.stringify(node, null, 2) (no trailing newline). Preserves the node's key order.</summary>
    public static string Pretty(JsonNode? node)
    {
        var sb = new StringBuilder();
        Write(sb, node, 0);
        return sb.ToString();
    }

    private static void Write(StringBuilder sb, JsonNode? node, int depth)
    {
        switch (node)
        {
            case null: sb.Append("null"); break;
            case JsonObject o when o.Count == 0: sb.Append("{}"); break;
            case JsonObject o:
                sb.Append("{\n");
                var first = true;
                foreach (var (k, v) in o)
                {
                    if (!first) sb.Append(",\n");
                    first = false;
                    sb.Append(' ', (depth + 1) * 2);
                    WriteString(sb, k);
                    sb.Append(": ");
                    Write(sb, v, depth + 1);
                }
                sb.Append('\n').Append(' ', depth * 2).Append('}');
                break;
            case JsonArray a when a.Count == 0: sb.Append("[]"); break;
            case JsonArray a:
                sb.Append("[\n");
                for (var i = 0; i < a.Count; i++)
                {
                    if (i > 0) sb.Append(",\n");
                    sb.Append(' ', (depth + 1) * 2);
                    Write(sb, a[i], depth + 1);
                }
                sb.Append('\n').Append(' ', depth * 2).Append(']');
                break;
            case JsonValue v:
                if (v.TryGetValue<JsonElement>(out var je)) { WriteElementScalar(sb, je); break; }
                if (v.TryGetValue<string>(out var s)) WriteString(sb, s);
                else if (v.TryGetValue<bool>(out var b)) sb.Append(b ? "true" : "false");
                else if (v.TryGetValue<decimal>(out var d)) sb.Append(Number(d));
                else if (v.TryGetValue<int>(out var i32)) sb.Append(i32.ToString(CultureInfo.InvariantCulture));
                else if (v.TryGetValue<long>(out var i64)) sb.Append(i64.ToString(CultureInfo.InvariantCulture));
                else throw new NotSupportedException(v.ToJsonString());
                break;
        }
    }

    private static void WriteElementScalar(StringBuilder sb, JsonElement e)
    {
        switch (e.ValueKind)
        {
            case JsonValueKind.String: WriteString(sb, e.GetString()!); break;
            case JsonValueKind.Number: sb.Append(Number(e.GetDecimal())); break;
            case JsonValueKind.True: sb.Append("true"); break;
            case JsonValueKind.False: sb.Append("false"); break;
            default: sb.Append("null"); break;
        }
    }

    /// <summary>A number as JS prints it: no exponent, no trailing zeros (jsonb 1.0 and 1 both read back as 1).</summary>
    public static string Number(decimal d) => (d / 1.0000000000000000000000000000m).ToString(CultureInfo.InvariantCulture);

    private static void WriteString(StringBuilder sb, string s)
    {
        sb.Append('"');
        foreach (var c in s)
        {
            switch (c)
            {
                case '"': sb.Append("\\\""); break;
                case '\\': sb.Append("\\\\"); break;
                case '\b': sb.Append("\\b"); break;
                case '\f': sb.Append("\\f"); break;
                case '\n': sb.Append("\\n"); break;
                case '\r': sb.Append("\\r"); break;
                case '\t': sb.Append("\\t"); break;
                case < ' ': sb.Append("\\u").Append(((int)c).ToString("x4")); break;
                default: sb.Append(c); break;
            }
        }
        sb.Append('"');
    }
}
