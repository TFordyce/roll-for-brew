namespace RollForBrew.Domain.Resolver.Phases;

internal sealed class SummaryPhase : EvalPhase
{
    public override string Id => "summary";
    public override void Run(EvalContext ctx)
    {
        for (var i = 0; i < ctx.Players.Count; i++)
        {
            var roll = ctx.Rolls[i];
            var reduced = ctx.DiceReduced[i];
            ctx.Summary.Add(new SummaryEntry(
                ctx.Players[i], roll, ctx.Snapshots[i], ctx.Composed[i], roll + ctx.Composed[i],
                roll == 1 && !reduced ? "nat1" : roll == 20 ? "nat20" : null, reduced));
        }
    }
}

internal sealed class Phase6HeistsAndMarks : EvalPhase
{
    public override string Id => "6";
    public override void Run(EvalContext ctx)
    {
        var round = ctx.RoundId.ToString();
        if (ctx.Casts.Any(c => c.EffectKind is "card_heist" or "draw_redirect")
            || ctx.AllCasts.Values.Any(c => c.EffectKind == "draw_redirect" && c.CastInputs.Text("consumed_by_round") == round))
            throw new PhasePendingException(Id, "card_heist / draw_redirect trace steps (#545)");
    }
}
