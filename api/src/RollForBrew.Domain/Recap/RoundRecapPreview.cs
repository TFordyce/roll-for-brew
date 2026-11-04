using System.Text.Json;
using System.Text.Json.Nodes;
using RollForBrew.Domain.Commands;
using RollForBrew.Domain.Resolver;
using RollForBrew.Domain.Snapshot;

namespace RollForBrew.Domain.Recap;

public sealed record ReactionSkip(string PlayerId, string Reason);

/// <summary>
/// The Round Recap (the Ledger): what get_round_recap returned, key for key, so the TS parser
/// reads either. A live round whose Layer 0 is ready gets its Trace and Summary from the
/// resolver with no persister; anything else reads what is stored. Nothing here writes.
/// </summary>
public static class RoundRecapPreview
{
    /// <summary>The holds a Provisional Recap shows through (#466). A Revolt Pick is ignored
    /// because the resolver reports it itself, as pick_pending. A compelled Action cast is
    /// ignored because it stops all rolling, so the roll count holds the Recap back first.
    /// The exception is a Layer with nobody left to roll, which shows the Recap early.</summary>
    public static readonly IReadOnlySet<LayerHoldKind> IgnoredHolds =
        new HashSet<LayerHoldKind> { LayerHoldKind.RevoltPick, LayerHoldKind.CompelledCast };

    public static bool IsProvisional(RoundSnapshot s, RoundRow round)
    {
        if (round.Status != "closed" || round.CurrentLayer != 0 || round.ResolutionSummary is not null) return false;
        var layer = LayerReadiness.Of(s, round.Id, 0);
        return layer.RolledIds.Count >= layer.ExpectedRollerIds.Count && layer.Holds.All(h => IgnoredHolds.Contains(h.Kind));
    }

    /// <summary>Any member of the round's room may read it: a spectator follows the round too.</summary>
    public static bool MayRead(RoundSnapshot s, RoundRow round, string playerId) =>
        s.RoundParticipants.Any(p => p.RoundId == round.Id && p.PlayerId == playerId)
        || s.RoomPlayers.Any(p => p.RoomId == round.RoomId && p.PlayerId == playerId);

    public static JsonObject Build(RoundSnapshot s, RoundRow round, IReadOnlyList<ReactionSkip> skips)
    {
        JsonNode? trace = Stored(round.ResolutionTrace) ?? new JsonArray();
        var summary = Stored(round.ResolutionSummary);
        var provisional = IsProvisional(s, round);
        if (provisional)
        {
            var preview = Evaluator.Preview(s, round.Id);
            trace = TraceJson.ToNode(preview.Trace);
            summary = preview.Players is null ? null : TraceJson.ToNode(preview.Players);
        }

        return new JsonObject
        {
            ["resolved"] = round.Status == "resolved",
            ["layer_zero_outcome"] = round.Status != "resolved" ? null
                : s.Rolls.Any(r => r.RoundId == round.Id && r.Layer > 0) ? "tie" : "brewer",
            ["trace"] = trace,
            ["players"] = summary,
            ["provisional"] = provisional,
            ["casts"] = Casts(s, round),
            ["scrapped_generations"] = Stored(round.ScrappedGenerations) ?? new JsonArray(),
            ["layers"] = RevealedRolls(s, round),
            ["layer_participants"] = new JsonArray([.. s.RoundLayerParticipants.Where(p => p.RoundId == round.Id)
                .Select(p => (JsonNode?)new JsonObject { ["layer"] = p.Layer, ["player_id"] = p.PlayerId })]),
            ["reaction_skips"] = new JsonArray([.. skips
                .Select(x => (JsonNode?)new JsonObject { ["player_id"] = x.PlayerId, ["reason"] = x.Reason })]),
        };
    }

    private static JsonNode? Stored(JsonElement? json) =>
        json is { ValueKind: not JsonValueKind.Null } j ? JsonNode.Parse(j.GetRawText()) : null;

    private static JsonArray Casts(RoundSnapshot s, RoundRow round)
    {
        var instances = s.DeckInstances.ToDictionary(d => d.Id);
        var cards = s.SpellCards.ToDictionary(c => c.Id);
        return [.. s.SpellCasts.Where(c => c.RoundId == round.Id && instances.ContainsKey(c.CardInstanceId))
            .OrderBy(c => c.Seq)
            .Select(c => (JsonNode?)new JsonObject
            {
                ["cast_id"] = c.Id.ToString(),
                ["seq"] = c.Seq,
                ["card_name"] = cards[instances[c.CardInstanceId].CardId].Name,
                ["caster_player_id"] = c.CasterId,
                ["target_player_id"] = c.TargetPlayerId,
                ["target_pending"] = c.TargetPending,
                ["effect_kind"] = c.EffectKind,
                ["phase"] = c.ReactionWindowId is null ? "preroll" : "reaction",
                ["negated"] = c.Negated,
                ["redirected_to_cast_id"] = c.RedirectedToCastId?.ToString(),
                ["compelled_by_cast_id"] = c.CastInputs.Text("compelled_by"),
                ["on_stack"] = c.ReactionWindowId is not null || round.Status != "open",
            })];
    }

    /// <summary>Only Layers whose rolls are all in, so a Layer never leaks mid-roll.</summary>
    private static JsonArray RevealedRolls(RoundSnapshot s, RoundRow round)
    {
        var rolls = s.Rolls.Where(r => r.RoundId == round.Id).ToList();
        var revealed = rolls.GroupBy(r => r.Layer)
            .Where(g => g.Count() >= LayerReadiness.Of(s, round.Id, g.Key).ExpectedRollerIds.Count)
            .Select(g => g.Key).ToHashSet();
        return [.. rolls.Where(r => revealed.Contains(r.Layer))
            .Select(r => (JsonNode?)new JsonObject
            {
                ["player_id"] = r.PlayerId,
                ["layer"] = r.Layer,
                ["value"] = r.Value,
                ["modifier_snapshot"] = r.ModifierSnapshot,
                ["discarded_value"] = r.DiscardedValue,
                ["entered_by_admin"] = r.EnteredByAdmin,
            })];
    }
}
