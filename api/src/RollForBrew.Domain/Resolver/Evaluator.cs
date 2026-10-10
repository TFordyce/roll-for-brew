using RollForBrew.Domain.Dice;
using RollForBrew.Domain.Resolver.Phases;
using RollForBrew.Domain.Snapshot;

namespace RollForBrew.Domain.Resolver;

public static class Evaluator
{
    private static readonly IReadOnlyList<EvalPhase> Pipeline =
    [
        new LoadRollersPhase(),
        new RollFrozenPhase(),
        new RollExemptionPhase(),
        new Phase0aMaterialiseCopies(),
        new Phase1CastLogResolution(),
        new WardBlockedPrepass(),
        new BrewmageddonPrepass(),
        new Phase0bInvocationOutcomes(),
        new Phase2WardProjection(),
        new Phase3PreDiceTick(),
        new Phase3RollInputs(),
        new Phase4aModifiers(),
        new Phase4cLowestGainsHighest(),
        new Phase4bPreBitterLeech(),
        new Phase4bPersistentModifiers(),
        new SummaryPhase(),
        new Phase5TeaMaker(),
        new Phase6HeistsAndMarks(),
    ];

    public static IReadOnlyList<string> PhaseIds { get; } = Pipeline.Select(p => p.Id).ToList();

    public static Resolution Evaluate(RoundSnapshot snapshot, IDieRoller dice)
    {
        var closed = snapshot.Rounds.Where(r => r.RoomId == snapshot.RoomId && r.Status == "closed").ToList();
        if (closed.Count != 1)
            throw new ArgumentException($"expected exactly one closed round in the room, found {closed.Count}; use Evaluate(snapshot, roundId, dice)");
        return Evaluate(snapshot, closed[0].Id, dice);
    }

    public static Resolution Evaluate(RoundSnapshot snapshot, Guid roundId, IDieRoller dice)
    {
        var round = snapshot.Rounds.FirstOrDefault(r => r.Id == roundId) ?? throw ResolveException.RoundNotFound();
        var ctx = new EvalContext(snapshot, round, dice);

        if (round.CurrentLayer > 0) return TieLayer(ctx);

        CheckAllRolled(ctx);
        foreach (var phase in Pipeline) phase.Run(ctx);
        return Build(ctx);
    }

    private static Resolution TieLayer(EvalContext ctx)
    {
        var layer = ctx.Round.CurrentLayer;
        var expected = ctx.S.RoundLayerParticipants.Count(p => p.RoundId == ctx.RoundId && p.Layer == layer && p.ExcludedAt is null);
        var rolls = ctx.S.Rolls.Where(r => r.RoundId == ctx.RoundId && r.Layer == layer).OrderBy(r => r.PlayerId, StringComparer.Ordinal).ToList();
        if (rolls.Count < expected) throw ResolveException.NotAllRolled();

        var tied = Rules.PickLowest(rolls.Select(r => r.PlayerId).ToList(), rolls.Select(r => r.Value).ToList(),
            rolls.Select(r => (decimal)r.ModifierSnapshot).ToList(), null);
        var one = tied.Count == 1;
        return new Resolution(
            one ? "brewer" : "tie", layer, one ? tied[0] : null, one ? "default" : null, one ? null : tied,
            ctx.ParticipantCount, null, false, null, null, [], null, DerivedCastState.Empty);
    }

    private static void CheckAllRolled(EvalContext ctx)
    {
        var rollCount = ctx.S.Rolls.Count(r => r.RoundId == ctx.RoundId && r.Layer == 0);
        var exempt = Rules.RollExemptions(ctx, Rules.CastLogResolution(ctx)).Select(e => e.Player).ToHashSet();
        var expected = ctx.S.RoundParticipants.Count(p => p.RoundId == ctx.RoundId && p.ExcludedAt is null && !exempt.Contains(p.PlayerId));
        if (rollCount >= expected) return;
        if (ctx.S.Rounds.Any(r => r.BrewerSource == "brew_iou"))
            throw new PhasePendingException("5", "Brew Debt round (#544)");
        throw ResolveException.NotAllRolled();
    }

    private static Resolution Build(EvalContext ctx)
    {
        var flags = ctx.Casts.Where(c => !c.Synthesized).Select(c => (Cast: c, Orig: ctx.S.SpellCasts.First(r => r.Id == c.Id)))
            .Where(x => x.Cast.Negated != x.Orig.Negated || x.Cast.RedirectedToCastId != x.Orig.RedirectedToCastId
                || x.Cast.SeizedByCastId != x.Orig.SeizedByCastId || x.Cast.CopiedCastId != x.Orig.CopiedCastId
                || x.Cast.TargetPlayerId != x.Orig.TargetPlayerId || x.Cast.TargetRole != x.Orig.TargetRole
                || x.Cast.TargetPending != x.Orig.TargetPending)
            .Select(x => x.Cast.Flags()).ToList();
        var derived = new DerivedCastState(flags, ctx.Casts.Where(c => c.Synthesized).Select(c => c.ToRow()).ToList(),
            new Dictionary<string, int>(ctx.RoomPlayerModifierWrites));

        return new Resolution(
            ctx.Outcome, 0, ctx.BrewerId, ctx.BrewerSource, ctx.TiedPlayers, ctx.ParticipantCount, ctx.ModifierGain,
            ctx.ModifierGain == 0, ctx.EarlTransfer, ctx.BrewerRecord, ctx.Trace, ctx.Summary, derived);
    }
}
