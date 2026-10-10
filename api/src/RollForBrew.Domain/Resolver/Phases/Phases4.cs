using System.Text.Json;

namespace RollForBrew.Domain.Resolver.Phases;

internal sealed class Phase4aModifiers : EvalPhase
{
    private static readonly HashSet<string> ModKinds = ["flat_modifier", "dice_modifier", "modifier_multiplier", "set_modifier"];

    public override string Id => "4a";

    private sealed record Eff(
        long? Ord, DateTimeOffset Ts, string? Target, string Kind, JsonElement? Params, JsonElement? Inputs,
        Guid? CastId, Guid? AeId, string CardName, string Caster);

    public override void Run(EvalContext ctx)
    {
        var rows = new List<Eff>();
        foreach (var c in ctx.Casts.Where(c => !c.TargetPending && !c.Negated && c.EffectKind is not null && ModKinds.Contains(c.EffectKind)))
            if (ctx.CardOfCast(c) is { DurationRounds: null } card)
                rows.Add(new Eff(c.Seq, c.CastAt, c.TargetPlayerId, c.EffectKind!, c.EffectParams, c.CastInputs, c.Id, null, card.Name, c.CasterId));
        foreach (var e in ctx.LiveEffects.Where(e => ModKinds.Contains(e.EffectKind)))
            if (ctx.Card(e.CardId) is { } card)
                rows.Add(new Eff(null, e.CreatedAt, e.TargetPlayerId, e.EffectKind, e.EffectParams, null, null, e.Id, card.Name, e.CasterId));

        foreach (var row in rows.OrderBy(r => r.Ord is null ? 0 : 1).ThenBy(r => r.Ord ?? 0).ThenBy(r => r.Ts))
        {
            var target = row.CastId is { } cid && ctx.RedirectMap.TryGetValue(cid, out var redirected) ? redirected : row.Target;
            if (target is null || !ctx.Players.Contains(target)) continue;

            var el = new ModEffect(row.Ord ?? 0, row.Kind, row.CastId, row.AeId, row.CardName, row.Caster, target,
                Flat: row.Kind switch
                {
                    "flat_modifier" => row.Params.Dec("delta") ?? 0,
                    "dice_modifier" => row.Inputs.Has("dice_roll") ? (row.Inputs.Dec("dice_roll") ?? 0) * (row.Params.Dec("sign") ?? 1) : 0,
                    _ => null,
                },
                Mult: row.Kind == "modifier_multiplier" ? row.Params.Dec("multiplier") ?? 1 : null,
                Set: row.Kind == "set_modifier" ? row.Params.Dec("value") ?? 0 : null,
                Backfire: false, CourageToken: row.Inputs.Has("courage_token_cast_id"));

            if (WardBlocks(ctx, el, target, row.Ord, row.Caster)) continue;
            ctx.Effects[target].Add(el);
        }

        if (ctx.HasCounters)
        {
            foreach (var bf in ctx.ClrRows.Where(r => r.CounterBackfired).OrderBy(r => r.CounterSeq))
            {
                var counter = ctx.AllCasts[bf.CounterCastId];
                if (ctx.CardOfCast(counter) is not { } ccard) continue;
                var parents = ctx.AllCasts.Values
                    .Where(p => p.CardInstanceId == bf.VictimGroup && p.EffectKind is not null && ModKinds.Contains(p.EffectKind) && !p.IsCourageSpend)
                    .OrderBy(p => p.Seq);
                foreach (var pr in parents)
                {
                    if (!ctx.Players.Contains(bf.CounterCaster)) continue;
                    var diceRolls = counter.CastInputs.Get("backfire").Get("dice_rolls");
                    var el = new ModEffect(bf.CounterSeq, pr.EffectKind!, counter.Id, null, ccard.Name, counter.CasterId, bf.CounterCaster,
                        Flat: pr.EffectKind switch
                        {
                            "flat_modifier" => pr.EffectParams.Dec("delta") ?? 0,
                            "dice_modifier" => (diceRolls.Dec(pr.Id.ToString()) ?? 0) * (pr.EffectParams.Dec("sign") ?? 1),
                            _ => null,
                        },
                        Mult: pr.EffectKind == "modifier_multiplier" ? pr.EffectParams.Dec("multiplier") ?? 1 : null,
                        Set: pr.EffectKind == "set_modifier" ? pr.EffectParams.Dec("value") ?? 0 : null,
                        Backfire: true, CourageToken: false);
                    if (WardBlocks(ctx, el, bf.CounterCaster, bf.CounterSeq, counter.CasterId)) continue;
                    ctx.Effects[bf.CounterCaster].Add(el);
                }
            }
        }

        for (var i = 0; i < ctx.Players.Count; i++)
        {
            var pid = ctx.Players[i];
            var list = ctx.Effects[pid];
            var after = ctx.Base[i];
            for (var k = 0; k < list.Count; k++)
            {
                var el = list[k];
                var before = after;
                after = Rules.Compose(ctx.Base[i], list.Take(k + 1));
                var extras = el.Backfire ? new (string, object?)[] { ("backfire", true) }
                    : el.CourageToken ? [("courage_token", true)]
                    : [];
                ctx.Emit(el.Kind, new SourceCast(el.CastId, el.ActiveEffectId, el.CardName, el.CasterPlayerId), pid,
                    TraceValue.Modifier(before), TraceValue.Modifier(after), extras);
            }
            ctx.Composed[i] = after;
        }

        ctx.SkipMap.Clear();
        foreach (var g in ctx.LiveEffects.Where(e => e.EffectKind == "targeting_skip").GroupBy(e => e.TargetPlayerId))
        {
            var first = g.OrderBy(e => e.CreatedAt).First();
            ctx.SkipMap[g.Key] = (first.Id, first.CasterId);
        }
    }

    private bool WardBlocks(EvalContext ctx, ModEffect el, string target, long? ord, string caster)
    {
        if (!ctx.WardMap.ContainsKey(target)) return false;
        var idx = ctx.Players.IndexOf(target);
        var hit = Rules.WardHit(ctx, target, "modifier", Rules.ElPolarity(el, ctx.Base[idx]), ord);
        if (hit is null) return false;

        var wbBefore = ctx.Base[idx];
        var wbAfter = Rules.Compose(wbBefore, [el]);
        var extras = new List<(string, object?)>
        {
            ("blocked_cast_id", el.CastId), ("ward_cast_id", hit.WardCastId), ("ward_card_name", hit.WardCardName),
            ("target", target), ("would_be_before", wbBefore), ("would_be_after", wbAfter), ("outcome", "blocked"),
        };
        if (el.Backfire) extras.Add(("backfire", true));
        ctx.Emit("warded", new SourceCast(el.CastId, el.ActiveEffectId, el.CardName, el.CasterPlayerId), target,
            TraceValue.Modifier(wbBefore), TraceValue.Modifier(wbAfter), [.. extras]);
        return true;
    }
}

internal sealed class Phase4cLowestGainsHighest : EvalPhase
{
    public override string Id => "4c";
    public override void Run(EvalContext ctx)
    {
        if (ctx.Players.Count == 0) return;
        if (!ctx.Casts.Any(c => c.EffectKind == "lowest_gains_highest_modifier" && !c.Negated && c.ReactionWindowId is not null)) return;
        var cast = ctx.Casts
            .Where(c => c.EffectKind == "lowest_gains_highest_modifier" && !c.Negated && c.ReactionWindowId is not null
                && ctx.CardOfCast(c) is not null)
            .OrderBy(c => c.Seq)
            .FirstOrDefault();
        if (cast is null) return;
        var card = ctx.CardOfCast(cast)!;

        var lowestRoll = ctx.Rolls.Min();
        var order = Enumerable.Range(0, ctx.Players.Count)
            .OrderByDescending(i => ctx.Rolls[i])
            .ThenBy(i => ctx.Players[i], StringComparer.Ordinal)
            .ToList();
        var plainHigh = order[0];
        var high = order.FirstOrDefault(i => !ctx.SkipMap.ContainsKey(ctx.Players[i]), -1);
        if (high < 0) high = plainHigh;
        var highComposed = ctx.Composed[high];

        if (plainHigh != high && ctx.SkipMap.ContainsKey(ctx.Players[plainHigh]))
            EmitSkip(ctx, ctx.Players[plainHigh]);

        var natural = Enumerable.Range(0, ctx.Players.Count)
            .Where(i => ctx.Rolls[i] == lowestRoll)
            .OrderBy(i => ctx.Players[i], StringComparer.Ordinal)
            .Select(i => ctx.Players[i])
            .ToList();

        List<string> beneficiaries;
        if (ctx.SkipMap.Count == 0 || !natural.Any(ctx.SkipMap.ContainsKey))
        {
            beneficiaries = natural;
        }
        else
        {
            beneficiaries = Enumerable.Range(0, ctx.Players.Count)
                .Where(i => !ctx.SkipMap.ContainsKey(ctx.Players[i]))
                .OrderBy(i => ctx.Rolls[i])
                .ThenBy(i => ctx.Players[i], StringComparer.Ordinal)
                .Select(i => ctx.Players[i])
                .Take(natural.Count)
                .ToList();
            if (beneficiaries.Count == 0) beneficiaries = natural;
        }

        foreach (var pid in natural)
            if (ctx.SkipMap.ContainsKey(pid) && !beneficiaries.Contains(pid))
                EmitSkip(ctx, pid);

        foreach (var pid in beneficiaries)
        {
            var i = ctx.PlayerIndex(pid);
            var src = new SourceCast(cast.Id, null, card.Name, cast.CasterId);
            var hit = Rules.WardHit(ctx, pid, "modifier", "positive", cast.Seq);
            if (hit is not null)
            {
                ctx.Emit("warded", src, pid, TraceValue.Modifier(ctx.Composed[i]), TraceValue.Modifier(ctx.Composed[i]),
                    ("blocked_cast_id", cast.Id), ("ward_cast_id", hit.WardCastId), ("ward_card_name", hit.WardCardName),
                    ("target", pid), ("would_be_before", ctx.Composed[i]), ("would_be_after", highComposed), ("outcome", "blocked"));
                continue;
            }

            var before = ctx.Composed[i];
            ctx.Composed[i] = highComposed;
            ctx.Emit("lowest_gains_highest_modifier", src, pid, TraceValue.Modifier(before), TraceValue.Modifier(highComposed));
        }
    }

    private static void EmitSkip(EvalContext ctx, string pid)
    {
        var (aeId, caster) = ctx.SkipMap[pid];
        ctx.Emit("targeting_skip", new SourceCast(null, aeId, "Cloud of Cream", caster), pid,
            TraceValue.Status("targetable"), TraceValue.Status("skipped"));
    }
}

internal sealed class Phase4bPreBitterLeech : EvalPhase
{
    public override string Id => "4b-pre";
    public override void Run(EvalContext ctx)
    {
        if (ctx.LiveEffects.Any(e => e.EffectKind == "persistent_modifier_transfer" && ((JsonElement?)e.EffectParams).Has("per_round_delta")))
            throw new PhasePendingException(Id, "Bitter Leech tick synthesis (#543)");
    }
}

internal sealed class Phase4bPersistentModifiers : EvalPhase
{
    public override string Id => "4b";
    public override void Run(EvalContext ctx)
    {
        if (ctx.Casts.Any(c => c.EffectKind is "persistent_modifier_transfer" or "persistent_modifier_spend" && c.TargetPlayerId is not null))
            throw new PhasePendingException(Id, "persistent modifier projection (#543)");
    }
}
