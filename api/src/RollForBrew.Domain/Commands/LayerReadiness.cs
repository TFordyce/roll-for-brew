using RollForBrew.Domain.Dice;
using RollForBrew.Domain.Resolver;
using RollForBrew.Domain.Snapshot;

namespace RollForBrew.Domain.Commands;

public enum LayerHoldKind { PendingDie, DeferredTarget, CompelledCast, RevoltPick }

/// <summary>One thing keeping a rolled Layer from finalizing, and who it waits on. A Revolt
/// Pick waits on nobody until everyone has rolled, because the picker is the lowest roller.</summary>
public sealed record LayerHold(LayerHoldKind Kind, IReadOnlyList<string> WaitingOn);

/// <summary>Where a Layer is: the one place that knows what holds a Layer (#465). A new hold
/// kind is one entry in <see cref="LayerReadiness.Of"/>.</summary>
public sealed record LayerState(
    int Layer,
    IReadOnlyList<string> ExpectedRollerIds,
    IReadOnlyList<string> RolledIds,
    IReadOnlyList<LayerHold> Holds)
{
    /// <summary>Zero expected rollers at Layer 0 (a debt round, or all exempt) is complete
    /// as it stands: no hold there can wait on a roll.</summary>
    public bool IsComplete =>
        (Layer == 0 && ExpectedRollerIds.Count == 0)
        || (RolledIds.Count >= ExpectedRollerIds.Count && Holds.Count == 0);

    /// <summary>The noop reason for a Layer that is not complete.</summary>
    public string HoldReason =>
        Holds.Any(h => h.Kind == LayerHoldKind.RevoltPick && h.WaitingOn.Count > 0) ? "revolt_pick_pending" : "layer_incomplete";

    /// <summary>Who may roll right now. Deliberately narrower than
    /// <see cref="ExpectedRollerIds"/>: an owed compelled Action cast stops all rolling, yet
    /// those players are still who the Layer waits for, so they stay in the expected set and
    /// the count that decides completeness.</summary>
    public bool MayRoll(string playerId) =>
        ExpectedRollerIds.Contains(playerId) && Holds.All(h => h.Kind != LayerHoldKind.CompelledCast);
}

public static class LayerReadiness
{
    public static LayerState Of(RoundSnapshot s, Guid roundId, int layer)
    {
        var round = s.Rounds.First(r => r.Id == roundId);
        var ctx = new EvalContext(s, round, new NoDiceRoller());
        var rolled = s.Rolls.Where(r => r.RoundId == roundId && r.Layer == layer)
            .OrderBy(r => r.PlayerId, StringComparer.Ordinal).ToList();
        var clr = Rules.CastLogResolution(ctx);
        var expected = ExpectedRollers(ctx, layer, clr);

        var holds = new List<LayerHold>();
        if (layer == 0)
        {
            var pendingDie = ctx.Casts.Where(c => c.EffectKind == "dice_modifier" && !c.CastInputs.Has("dice_roll")).ToList();
            if (pendingDie.Count > 0) holds.Add(new LayerHold(LayerHoldKind.PendingDie, Casters(pendingDie)));

            var deferred = ctx.Casts.Where(c => c.EffectKind == "forced_reroll" && c.TargetPending && !c.Negated && c.ReactionWindowId is null).ToList();
            if (deferred.Count > 0) holds.Add(new LayerHold(LayerHoldKind.DeferredTarget, Casters(deferred)));

            var owed = OwedCompelledActions(ctx, clr);
            if (owed.Count > 0) holds.Add(new LayerHold(LayerHoldKind.CompelledCast, owed));

            var revolt = ctx.Casts.Where(c => c.EffectKind == "tea_maker_override"
                && c.EffectParams.Text("picker") == "lowest_roller" && !c.Negated
                && c.TargetPlayerId is null && !c.CastInputs.Has("revolt_pick_abandoned")).ToList();
            if (revolt.Count > 0)
            {
                var picker = rolled.Count < expected.Count ? null
                    : rolled.OrderBy(r => r.Value).ThenBy(r => r.PlayerId, StringComparer.Ordinal).FirstOrDefault()?.PlayerId;
                holds.Add(new LayerHold(LayerHoldKind.RevoltPick, picker is null ? [] : [picker]));
            }
        }

        return new LayerState(layer, expected, [.. rolled.Select(r => r.PlayerId)], holds);
    }

    private static List<string> Casters(IEnumerable<WorkingCast> casts) =>
        [.. casts.Select(c => c.CasterId).Distinct().Order(StringComparer.Ordinal)];

    private static IReadOnlyList<string> ExpectedRollers(EvalContext ctx, int layer, List<ClrRow> clr)
    {
        if (layer > 0)
            return [.. ctx.S.RoundLayerParticipants
                .Where(p => p.RoundId == ctx.RoundId && p.Layer == layer && p.ExcludedAt is null)
                .Select(p => p.PlayerId).Order(StringComparer.Ordinal)];

        if (Rules.BrewDebtDue(ctx) is not null) return [];

        // A counter can itself be countered until the window closes, so a countered exemption
        // only ends once it has: the caster rolls late from then on.
        var windowClosed = ctx.S.Windows.Any(w => w.RoundId == ctx.RoundId && w.Layer == 0 && w.Status == "closed");
        var exempt = Rules.RollExemptions(ctx, windowClosed ? clr : []).Select(e => e.Player).ToHashSet();
        return [.. ctx.S.RoundParticipants
            .Where(p => p.RoundId == ctx.RoundId && p.ExcludedAt is null && !exempt.Contains(p.PlayerId))
            .Select(p => p.PlayerId).Order(StringComparer.Ordinal)];
    }

    private static List<string> OwedCompelledActions(EvalContext ctx, List<ClrRow> clr)
    {
        var owed = new List<string>();
        foreach (var bm in ctx.Casts.Where(c => c.EffectKind == "compel_cast"))
        {
            var negated = bm.Negated || clr.Any(r => r.VictimGroup == bm.CardInstanceId
                && r.CounterKind == "contested_negate" && r.CounterSucceeded && !r.CounterNegated && !r.CounterBackfired);
            if (negated) continue;

            foreach (var entry in bm.CastInputs.Get("compelled").Items())
            {
                System.Text.Json.JsonElement? h = entry;
                if (h.Text("casting_time") != "A") continue;
                var player = h.Text("player_id");
                var instance = h.GuidOf("card_instance_id");
                var answered = ctx.Casts.Any(c => c.CasterId == player && c.CardInstanceId == instance
                    && c.CastInputs.Text("compelled_by") == bm.Id.ToString());
                if (!answered && player is not null) owed.Add(player);
            }
        }
        return [.. owed.Distinct().Order(StringComparer.Ordinal)];
    }
}
