using System.Text.Json;
using RollForBrew.Domain.Resolver;
using RollForBrew.Domain.Snapshot;

namespace RollForBrew.Domain.Commands;

/// <summary>The earliest matching roll-domain ward on a player that predates the change
/// (_rr_active_ward_gate), shared by the roll shim and roll submission. A neutral change is
/// never warded.</summary>
internal static class WardGate
{
    public static (Guid CastId, string CardName)? Find(
        RoundSnapshot s, IReadOnlyList<ActiveEffectRow> liveEffects, IReadOnlyDictionary<Guid, SpellCastRow> casts,
        Guid roundId, string player, string polarity, long? beforeSeq)
    {
        if (polarity == "neutral") return null;
        var hit = liveEffects
            .Where(e => e.TargetPlayerId == player && e.EffectKind == "ward")
            .Where(e =>
            {
                JsonElement? ep = e.EffectParams;
                return ep.Get("domain").ContainsString("roll") && ep.Get("polarity").ContainsString(polarity);
            })
            .Where(e => !casts.TryGetValue(e.SourceCastId, out var wc) || wc.RoundId != roundId || beforeSeq is null || wc.Seq < beforeSeq)
            .OrderBy(e => e.CreatedAt)
            .FirstOrDefault();
        return hit is null ? null : (hit.SourceCastId, s.SpellCards.First(c => c.Id == hit.CardId).Name);
    }
}
