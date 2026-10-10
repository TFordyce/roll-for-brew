using System.Security.Cryptography;
using System.Text;
using System.Text.Json;

namespace RollForBrew.Domain.Resolver.Phases;

internal sealed class Phase3PreDiceTick : EvalPhase
{
    public override string Id => "3-pre";
    public override void Run(EvalContext ctx)
    {
        foreach (var e in ctx.LiveEffects.Where(e => e.EffectKind == "per_round_dice_tick")
                     .OrderBy(e => e.CreatedAt).ThenBy(e => e.Id, Jb.UuidOrder))
        {
            if (!ctx.Players.Contains(e.TargetPlayerId)) continue;
            if (!ctx.AllCasts.TryGetValue(e.SourceCastId, out var src)) continue;
            var ep = (JsonElement?)e.EffectParams;
            var die = ep.Int("die") ?? 4;
            var sign = ep.Int("sign") ?? -1;

            if (ctx.AllCasts.Values.Any(t => t.RoundId == ctx.RoundId && t.SourceCastId == e.SourceCastId
                    && t.CastInputs.Flag("dice_tick") && t.Generation == ctx.Gen))
                continue;

            var rolled = ctx.Dice.Roll(die);
            var ward = Rules.WardHit(ctx, e.TargetPlayerId, "roll", "negative", null);
            var victim = e.TargetPlayerId;

            var inputs = JsonSerializer.SerializeToElement(new Dictionary<string, object?>
            {
                ["dice_tick"] = true,
                ["roll_transform"] = new Dictionary<string, object?>
                {
                    ["kind"] = "per_round_dice_tick", ["order"] = 2, ["die"] = die, ["sign"] = sign, ["rolled"] = rolled,
                    ["players"] = new[]
                    {
                        new Dictionary<string, object?>
                        {
                            ["player_id"] = victim, ["before"] = null, ["after"] = null, ["warded"] = ward is not null,
                        },
                    },
                },
            });
            ctx.AddCast(seq => new WorkingCast
            {
                Id = new Guid(MD5.HashData(Encoding.UTF8.GetBytes($"rfb-dice-tick:{e.SourceCastId}:{ctx.Gen}"))),
                RoundId = ctx.RoundId, CasterId = e.CasterId, CardInstanceId = src.CardInstanceId, TargetPlayerId = victim,
                EffectKind = "per_round_dice_tick",
                EffectParams = JsonSerializer.SerializeToElement(new Dictionary<string, object?> { ["die"] = die, ["sign"] = sign, ["rolled"] = rolled }),
                CastAt = ctx.S.DbNow, Seq = seq, CastInputs = inputs, SourceCastId = e.SourceCastId, Generation = ctx.Gen,
                Negated = ward is not null, Synthesized = true,
            });

            if (ward is null) continue;
            decimal? roll = ctx.S.Rolls.FirstOrDefault(r => r.RoundId == ctx.RoundId && r.Layer == 0 && r.PlayerId == victim)?.Value;
            ctx.Emit("warded", new SourceCast(null, null, "Calami-Tea", e.CasterId), victim, TraceValue.Roll(roll), TraceValue.Roll(roll),
                ("blocked_cast_id", null), ("ward_cast_id", ward.WardCastId), ("ward_card_name", ward.WardCardName),
                ("target", victim), ("would_be_before", roll), ("would_be_after", roll is null ? null : Math.Max(1, roll.Value + sign * rolled)),
                ("outcome", "blocked"));
        }
    }
}

internal sealed class Phase3RollInputs : EvalPhase
{
    private static readonly HashSet<string> Kinds =
        ["advantage", "disadvantage", "forced_reroll", "roll_flip", "roll_swap", "fixed_roll", "roll_pair_transform", "per_round_dice_tick"];

    public override string Id => "3";

    private sealed record Row(
        WorkingCast Cast, string CardName, int Ord, string? PairOp, decimal? PBefore, decimal? PAfter, bool Warded,
        decimal? WouldBeAfter, string? WardCastId, string? WardCardName, JsonElement? Condition,
        decimal? TickRolled, decimal? TickSign, int? TickDie);

    public override void Run(EvalContext ctx)
    {
        for (var i = 0; i < ctx.Players.Count; i++)
        {
            var pid = ctx.Players[i];
            decimal? running = null;

            if (!ctx.Casts.Any(c => c.TargetPlayerId == pid && !c.TargetPending && c.EffectKind is "advantage" or "disadvantage"))
            {
                foreach (var e in ctx.LiveEffects.Where(e => e.EffectKind is "advantage" or "disadvantage" && e.TargetPlayerId == pid)
                             .OrderBy(e => e.CreatedAt))
                {
                    if (ctx.Card(e.CardId) is not { } pcard) continue;
                    var l0 = ctx.S.Rolls.FirstOrDefault(r => r.RoundId == ctx.RoundId && r.Layer == 0 && r.PlayerId == pid);
                    var first = RowsFor(ctx, pid).FirstOrDefault();
                    decimal? kept = first?.PBefore is { } fb ? Math.Round(fb, MidpointRounding.AwayFromZero) : l0?.Value;
                    decimal? pAfter = kept, pBefore;
                    if (l0?.DiscardedValue is not { } disc) pBefore = pAfter;
                    else pBefore = e.EffectKind == "advantage" ? Math.Min(kept ?? 0, disc) : Math.Max(kept ?? 0, disc);
                    running = pAfter;
                    ctx.Emit(e.EffectKind, new SourceCast(null, e.Id, pcard.Name, e.CasterId), pid, TraceValue.Roll(pBefore), TraceValue.Roll(pAfter));
                }
            }

            foreach (var row in RowsFor(ctx, pid))
            {
                decimal? before, after;
                if (row.Warded)
                {
                    before = running ?? row.PBefore;
                    ctx.Emit("warded", Src(row.Cast, row.CardName), pid, TraceValue.Roll(before), TraceValue.Roll(before),
                        ("blocked_cast_id", row.Cast.Id), ("ward_cast_id", row.WardCastId), ("ward_card_name", row.WardCardName),
                        ("target", pid), ("would_be_before", before), ("would_be_after", row.WouldBeAfter ?? before), ("outcome", "blocked"));
                    continue;
                }
                if (row.Cast.Negated) { running ??= row.PBefore; continue; }

                if (row.Cast.EffectKind == "per_round_dice_tick")
                {
                    var tb = running ?? ctx.Rolls[i];
                    var ta = Math.Max(1, tb + (row.TickSign ?? -1) * (row.TickRolled ?? 0));
                    running = ta;
                    if (ta < tb) ctx.DiceReduced[i] = true;
                    ctx.Emit("dice_tick", Src(row.Cast, row.CardName), pid, TraceValue.Roll(tb), TraceValue.Roll(ta),
                        ("die", row.TickDie), ("rolled", row.TickRolled), ("sign", row.TickSign ?? -1));
                    continue;
                }

                before = running ?? row.PBefore;
                after = row.PAfter;
                running = after;
                var kind = row.Cast.EffectKind!;
                if (row.Condition is not null)
                    kind = row.Condition.Text("branch") switch { "advantage" => "advantage", "disadvantage" => "disadvantage", _ => "conditional_advantage" };
                var extras = row.PairOp is not null ? new (string, object?)[] { ("op", row.PairOp) }
                    : row.Condition is not null ? [("condition", row.Condition)]
                    : [];
                ctx.Emit(kind, Src(row.Cast, row.CardName), pid, TraceValue.Roll(before), TraceValue.Roll(after), extras);
            }

            if (ctx.HasCounters)
            {
                foreach (var bf in ctx.ClrRows.Where(r => r.CounterBackfired && r.CounterCaster == pid).OrderBy(r => r.CounterSeq))
                {
                    var counter = ctx.AllCasts[bf.CounterCastId];
                    if (ctx.CardOfCast(counter) is not { } card) continue;
                    var transforms = counter.CastInputs.Get("backfire").Get("transforms").Items()
                        .OrderBy(t => ((JsonElement?)t).Int("order") ?? int.MaxValue);
                    foreach (var t in transforms)
                    {
                        JsonElement? te = t;
                        decimal Die(int k) => te.Get("extra_dice").Items().ElementAtOrDefault(k) is { ValueKind: JsonValueKind.Number } d ? d.GetDecimal() : 0;
                        var before = running ?? ctx.Rolls[i];
                        var tk = te.Text("kind");
                        var after = tk switch
                        {
                            "disadvantage" => Math.Min(before, Math.Min(Die(0), Die(1))),
                            "advantage" => Math.Max(before, Math.Max(Die(0), Die(1))),
                            "forced_reroll" => Die(0),
                            "roll_flip" => 21 - before,
                            _ => before,
                        };
                        running = after;
                        ctx.Emit(tk ?? "unknown", new SourceCast(counter.Id, null, card.Name, counter.CasterId), pid,
                            TraceValue.Roll(before), TraceValue.Roll(after), ("backfire", true));
                    }
                }
            }

            if (running is { } r) ctx.Rolls[i] = (int)Math.Round(r, MidpointRounding.AwayFromZero);
        }
    }

    private static IEnumerable<Row> RowsFor(EvalContext ctx, string pid)
    {
        var rows = new List<Row>();
        foreach (var c in ctx.Casts)
        {
            if (c.EffectKind is null || !Kinds.Contains(c.EffectKind) || !c.CastInputs.Has("roll_transform")) continue;
            if (ctx.CardOfCast(c) is not { } card) continue;
            var rt = c.CastInputs.Get("roll_transform");
            foreach (var pe in rt.Get("players").Items())
            {
                JsonElement? p = pe;
                if (p.Text("player_id") != pid) continue;
                rows.Add(new Row(c, card.Name, rt.Int("order") ?? int.MaxValue, rt.Text("op"), p.Dec("before"), p.Dec("after"),
                    p.Get("warded") is { ValueKind: JsonValueKind.True }, p.Dec("would_be_after"), p.Text("ward_cast_id"),
                    p.Text("ward_card_name"), rt.Get("condition") is { ValueKind: not JsonValueKind.Null } cond ? cond : null,
                    rt.Dec("rolled"), rt.Dec("sign"), rt.Int("die")));
            }
        }
        return rows.OrderBy(r => r.Ord).ThenBy(r => r.Cast.Seq);
    }
}
