using System.Text.Json;

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
        foreach (var h in HeistOutcomes(ctx))
        {
            var extras = new List<(string, object?)> { ("outcome", h.Outcome == "moved" ? "applied" : "no-op") };
            if (h.Reason is not null) extras.Add(("heist_reason", h.Reason));
            ctx.Emit("card_heist", new SourceCast(h.CastId, null, h.CardName, h.CasterId), h.VictimId,
                TraceValue.Status("held"), TraceValue.Status(h.Outcome), [.. extras]);
            if (h.Outcome == "moved" && h.Slot is { } slot)
                ctx.HeistMoves.Add(new HeistMove(h.CastId, h.InstanceId, slot, h.CasterId));
        }

        var round = ctx.RoundId.ToString();
        var marks = new List<(int KindOrder, long Seq, Guid Id, WorkingCast Cast, string CardName, string? Outcome)>();
        foreach (var c in ctx.AllCasts.Values.Where(c => c.EffectKind == "draw_redirect"))
        {
            if (ctx.CardOfCast(c) is not { } card) continue;
            if (c.RoundId == ctx.RoundId && c.TargetPlayerId is not null && !c.Negated && !c.CastInputs.Flag("is_copy"))
                marks.Add((0, c.Seq, c.Id, c, card.Name, "marked"));
            if (c.CastInputs.Text("consumed_by_round") == round)
                marks.Add((1, c.Seq, c.Id, c, card.Name, c.CastInputs.Text("draw_redirect_outcome")));
        }

        foreach (var m in marks.OrderBy(m => m.KindOrder).ThenBy(m => m.Seq).ThenBy(m => m.Id, Jb.UuidOrder))
        {
            var before = m.Outcome == "marked" ? null : "marked";
            ctx.Emit("draw_redirect", new SourceCast(m.Cast.Id, null, m.CardName, m.Cast.CasterId), m.Cast.TargetPlayerId,
                TraceValue.Status(before), TraceValue.Status(m.Outcome),
                ("outcome", m.Outcome == "fizzled" ? "no-op" : "applied"),
                ("redirect_trigger", ((JsonElement?)m.Cast.EffectParams).Text("trigger")));
        }
    }

    private sealed record HeistRow(
        Guid CastId, string CasterId, string? VictimId, Guid InstanceId, string CardName, string Outcome, string? Reason, string? Slot);

    private static IEnumerable<HeistRow> HeistOutcomes(EvalContext ctx)
    {
        foreach (var c in ctx.Casts
                     .Where(c => c.EffectKind == "card_heist" && c.CastInputs.Has("stolen_instance_id")
                         && !c.CastInputs.Flag("is_copy"))
                     .OrderBy(c => c.Seq))
        {
            if (ctx.CardOfCast(c) is not { } card) continue;
            if (!Guid.TryParse(c.CastInputs.Text("stolen_instance_id"), out var instanceId)) continue;
            var inst = ctx.S.DeckInstances.FirstOrDefault(d => d.Id == instanceId);
            var victim = c.TargetPlayerId;

            string outcome;
            string? reason = null;
            string? slot = null;
            if (c.CastInputs.Flag("heist_moved"))
            {
                outcome = "moved";
            }
            else if (inst is null || inst.Location != "held" || inst.HeldByPlayer != victim)
            {
                outcome = "fizzled";
                reason = "victim_played_first";
            }
            else if (c.Negated)
            {
                outcome = "countered";
            }
            else if (FreeHandSlot(ctx, c.CasterId) is not { } free)
            {
                outcome = "fizzled";
                reason = "thief_hand_full";
            }
            else
            {
                outcome = "moved";
                slot = free;
            }

            yield return new HeistRow(c.Id, c.CasterId, victim, instanceId, card.Name, outcome, reason, slot);
        }
    }

    internal static string? FreeHandSlot(EvalContext ctx, string player) =>
        !ctx.S.DeckInstances.Any(d => d.HeldByPlayer == player && d.Location == "held") ? "held"
        : !ctx.S.DeckInstances.Any(d => d.HeldByPlayer == player && d.Location == "pending_swap") ? "pending_swap"
        : null;
}
