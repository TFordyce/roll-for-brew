using System.Text.Json.Nodes;
using RollForBrew.Domain.Resolver;

namespace RollForBrew.Api.RoundAdvance;

/// <summary>What SQL wrote for a finalized layer: the bridge payload's outcome block
/// plus the resolution columns read back inside the same transaction. The payload's
/// <c>replay_pending</c> is deliberately absent: it follows from a surviving
/// <c>round_replay</c> cast, which the C# <c>Resolution</c> does not carry — any real
/// disagreement behind it already fires through negation or the trace.</summary>
public sealed record SqlSide(
    int Layer,
    string Outcome,
    string? BrewerId,
    string? BrewerSource,
    int CupsMade,
    bool Rolloff,
    IReadOnlyList<string> TiedPlayerIds,
    JsonNode? Trace,
    JsonNode? Summary,
    int? ModifierGain);

/// <summary>
/// Compares the C# shadow candidate against what SQL wrote, through the goldens'
/// normalized shape (<see cref="TraceNormaliser"/>): RNG-drawn values collapse to
/// &lt;rng&gt;, cast ids become stable aliases, player sets sort. Pure; returns the
/// named fields that differ, empty when the two engines agree.
/// </summary>
public static class ShadowDiff
{
    public static IReadOnlyList<string> Compare(Resolution candidate, SqlSide sql, IReadOnlyDictionary<string, string> roster)
    {
        var fields = new List<string>();

        var sqlOutcome = sql.Outcome;
        var candidateOutcome = sqlOutcome == "tie" && candidate.Outcome == "rolloff" ? "tie" : candidate.Outcome;
        if (candidateOutcome != sqlOutcome) fields.Add("outcome");

        // finalize_layer reports a tie with the layer it advanced TO; the candidate
        // carries the layer that tied.
        var candidateLayer = candidate.Layer + (sqlOutcome == "tie" ? 1 : 0);
        if (candidateLayer != sql.Layer) fields.Add("layer");

        if (sqlOutcome == "brewer")
        {
            if (candidate.BrewerId != sql.BrewerId) fields.Add("brewer");
            // rounds.brewer_source only ever holds the brewer-record source
            // ('brew_iou'/'brew_debt'); the resolver's 'default' label is not persisted.
            if (candidate.BrewerRecord?.Source != sql.BrewerSource) fields.Add("brewerSource");
            if (candidate.CupsMade != sql.CupsMade) fields.Add("cups");
            if ((candidate.ModifierGain ?? candidate.CupsMade) != (sql.ModifierGain ?? sql.CupsMade)) fields.Add("modifierGain");
        }
        else // tie / rolloff
        {
            if (candidate.TiedPlayerIds is null) fields.Add("tiedPlayerIds");
            else if (!candidate.TiedPlayerIds.OrderBy(x => x, StringComparer.Ordinal)
                         .SequenceEqual(sql.TiedPlayerIds.OrderBy(x => x, StringComparer.Ordinal)))
                fields.Add("tiedPlayerIds");
            if (candidate.Outcome == "rolloff" != sql.Rolloff) fields.Add("rolloff");
        }

        // Layer > 0 persists nothing (issue #219): rounds.resolution_trace and
        // resolution_summary keep their LAYER-0 content, which is not the output
        // of the resolution being compared — the 2026-10-27 Loose Leaf rolloff
        // diff compared C#'s fresh layer-1 resolution (no trace, no players)
        // against layer 0's columns. Only a layer-0 resolution owns them.
        if (sql.Layer == 0)
        {
            var candidateTrace = TraceNormaliser.NormaliseTrace(TraceJson.ToNode(candidate.Trace), roster);
            var sqlTrace = sql.Trace is null ? null : TraceNormaliser.NormaliseTrace((JsonArray)sql.Trace, roster);
            if (sqlTrace is null || !TraceNormaliser.NodesEqual(candidateTrace, sqlTrace)) fields.Add("trace");

            var candidateSummary = candidate.Players is null ? null : TraceNormaliser.NormaliseSummary(TraceJson.ToNode(candidate.Players), roster);
            var sqlSummary = sql.Summary is null ? null : TraceNormaliser.NormaliseSummary((JsonArray)sql.Summary, roster);
            if (!NodesEqualAllowingNull(candidateSummary, sqlSummary)) fields.Add("players");
        }

        return fields;
    }

    private static bool NodesEqualAllowingNull(JsonNode? a, JsonNode? b) =>
        a is null && b is null || a is not null && b is not null && TraceNormaliser.NodesEqual(a, b);
}
