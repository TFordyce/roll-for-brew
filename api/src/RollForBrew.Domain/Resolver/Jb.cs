using System.Globalization;
using System.Text.Json;

namespace RollForBrew.Domain.Resolver;

/// <summary>
/// jsonb-flavoured reads over snapshot JSON, matching the Postgres operators the SQL uses: <c>Has</c> is
/// <c>?</c> (key exists, even with a null value), <c>Text</c> is <c>-&gt;&gt;</c> (JSON null and missing both
/// give null), <c>Get</c> is <c>-&gt;</c>.
/// </summary>
internal static class Jb
{
    public static bool Has(this JsonElement? j, string key) =>
        j is { ValueKind: JsonValueKind.Object } o && o.TryGetProperty(key, out _);

    public static JsonElement? Get(this JsonElement? j, string key) =>
        j is { ValueKind: JsonValueKind.Object } o && o.TryGetProperty(key, out var v) ? v : null;

    public static string? Text(this JsonElement? j, string key)
    {
        if (j.Get(key) is not { } v) return null;
        return v.ValueKind switch
        {
            JsonValueKind.Null or JsonValueKind.Undefined => null,
            JsonValueKind.String => v.GetString(),
            JsonValueKind.True => "true",
            JsonValueKind.False => "false",
            JsonValueKind.Number => v.GetDecimal().ToString(CultureInfo.InvariantCulture),
            _ => v.GetRawText(),
        };
    }

    public static decimal? Dec(this JsonElement? j, string key) =>
        j.Get(key) is { ValueKind: JsonValueKind.Number } v ? v.GetDecimal()
        : j.Text(key) is { } t && decimal.TryParse(t, NumberStyles.Float, CultureInfo.InvariantCulture, out var d) ? d : null;

    public static int? Int(this JsonElement? j, string key) => j.Dec(key) is { } d ? (int)Math.Round(d, MidpointRounding.AwayFromZero) : null;

    /// <summary>coalesce((j ->> key)::boolean, false)</summary>
    public static bool Flag(this JsonElement? j, string key) => j.Text(key) == "true";

    public static Guid? GuidOf(this JsonElement? j, string key) => Guid.TryParse(j.Text(key), out var g) ? g : null;

    /// <summary>Does the jsonb array (or bare string) contain this string, as the <c>?</c> operator tests it.</summary>
    public static bool ContainsString(this JsonElement? j, string s) => j is { } e && e.ValueKind switch
    {
        JsonValueKind.String => e.GetString() == s,
        JsonValueKind.Array => e.EnumerateArray().Any(x => x.ValueKind == JsonValueKind.String && x.GetString() == s),
        _ => false,
    };

    public static IEnumerable<JsonElement> Items(this JsonElement? j) =>
        j is { ValueKind: JsonValueKind.Array } a ? a.EnumerateArray() : [];

    /// <summary>Canonical text for jsonb equality (used as a grouping key): keys sorted, numbers normalised.</summary>
    public static string Canon(this JsonElement? j) =>
        j is null ? "null" : TraceJson.Pretty(TraceJson.Convert(j.Value));

    /// <summary>Postgres uuid ordering is bytewise over the canonical text.</summary>
    public static readonly IComparer<Guid> UuidOrder = Comparer<Guid>.Create((a, b) =>
        string.CompareOrdinal(a.ToString(), b.ToString()));
}
