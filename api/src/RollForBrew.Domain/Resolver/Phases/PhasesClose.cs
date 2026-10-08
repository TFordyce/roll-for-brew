namespace RollForBrew.Domain.Resolver.Phases;

/// <summary>
/// The layer-0 Resolution Summary (issue #407, ADR 0007): each roller's final roll, snapshot, composed modifier,
/// total and nat standing, built from the working arrays after the modifier phases. Phase 5 moves none of them.
/// </summary>
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

/// <summary>
/// Phase 5 (ADR 0005): tea-maker selection by the Tea-Maker Precedence Ladder (issue #451), then Eternal Steep's
/// block_earned_modifier ward zeroing the gain. PORTED HERE: only tier 4, the default lowest roller, and the
/// Eternal Steep ward. NOT PORTED (#544): Brew Debt, tier 0 Brewer Immunity, tier 1 declared number, tier 2
/// overrides, tier 3 Loose Leaf roll-off, Earl transfer, brewer_record. The guard throws when the snapshot
/// engages any of those, so a default-pick answer is never given for a round that needs the ladder.
/// </summary>
internal sealed class Phase5TeaMaker : EvalPhase
{
    public override string Id => "5";
    public override void Run(EvalContext ctx)
    {
        Guard(ctx);

        var tied = Rules.PickLowest(ctx.Players, ctx.Rolls, ctx.Composed, ctx.DiceReduced);
        if (tied.Count > 1)
        {
            ctx.Outcome = "tie";
            ctx.TiedPlayers = tied;
            ctx.BrewerSource = null;
        }
        else
        {
            ctx.Outcome = "brewer";
            ctx.BrewerId = tied.FirstOrDefault();
            ctx.BrewerSource = "default";
        }

        // Issue #309: a block_earned_modifier ward on the brewer (Eternal Steep) zeroes their tea-making gain.
        if (ctx.BrewerId is { } brewer && ctx.WardMap.TryGetValue(brewer, out var wards) && wards.FirstOrDefault(w => w.BlockEarnedModifier) is { } ward)
        {
            if (ctx.ModifierGain != 0)
                ctx.Emit("warded", new SourceCast(null, null, ward.WardCardName, null), brewer,
                    TraceValue.Status("brewer"), TraceValue.Status("brewer (no modifier gain)"),
                    ("blocked_cast_id", null), ("ward_cast_id", ward.WardCastId), ("ward_card_name", ward.WardCardName),
                    ("target", brewer), ("would_be_before", "brewer"), ("would_be_after", "brewer (no modifier gain)"), ("outcome", "blocked"));
            ctx.ModifierGain = 0;
        }
    }

    private void Guard(EvalContext ctx)
    {
        if (ctx.S.Rounds.Any(r => r.BrewerSource == "brew_iou"))
            throw new PhasePendingException(Id, "Brew Debt pre-ladder rule (#544)");
        if (ctx.LiveEffects.Any(e => e.EffectKind is "brewer_immunity" or "declared_number_tea_maker"))
            throw new PhasePendingException(Id, "Brewer Immunity / declared number tiers (#544)");
        if (ctx.Casts.Any(c => c.EffectKind is "tea_maker_override" or "named_tea_maker_rolloff"))
            throw new PhasePendingException(Id, "tea_maker_override / Loose Leaf tiers (#544)");
    }
}

/// <summary>
/// Phase 6 (issues #438 / #436): Tea Heist outcome steps, then Marked for Brew / Stale Biscuit draw_redirect
/// steps. Trace only; the card move is Commit's. NOT PORTED (#545).
/// </summary>
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
