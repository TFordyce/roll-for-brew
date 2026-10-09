using System.Security.Cryptography;
using System.Text;
using System.Text.Json;

namespace RollForBrew.Domain.Resolver.Phases;

internal abstract class EvalPhase
{
    public abstract string Id { get; }
    public abstract void Run(EvalContext ctx);

    protected static SourceCast Src(WorkingCast c, string? cardName) => new(c.Id, null, cardName, c.CasterId);
}

internal sealed class LoadRollersPhase : EvalPhase
{
    public override string Id => "load-rollers";
    public override void Run(EvalContext ctx)
    {
        foreach (var r in ctx.S.Rolls.Where(r => r.RoundId == ctx.RoundId && r.Layer == 0).OrderBy(r => r.PlayerId, StringComparer.Ordinal))
        {
            ctx.Players.Add(r.PlayerId);
            ctx.Rolls.Add(r.Value);
            ctx.Base.Add(r.ModifierSnapshot);
            ctx.Composed.Add(r.ModifierSnapshot);
            ctx.Snapshots.Add(r.ModifierSnapshot);
            ctx.DiceReduced.Add(false);
            ctx.Effects[r.PlayerId] = [];
        }
    }
}

internal sealed class RollFrozenPhase : EvalPhase
{
    public override string Id => "roll-frozen";
    public override void Run(EvalContext ctx)
    {
        if (ctx.Gen <= 0 || ctx.Round.ReplayFrozenRollers.Count == 0) return;
        for (var i = 0; i < ctx.Players.Count; i++)
        {
            if (!ctx.Round.ReplayFrozenRollers.Contains(ctx.Players[i])) continue;
            ctx.Emit("roll_frozen", SourceCast.None, ctx.Players[i], TraceValue.Roll(ctx.Rolls[i]), TraceValue.Roll(ctx.Rolls[i]));
        }
    }
}

internal sealed class RollExemptionPhase : EvalPhase
{
    public override string Id => "roll-exemption";
    public override void Run(EvalContext ctx)
    {
        var clr = Rules.CastLogResolution(ctx);
        foreach (var ex in Rules.RollExemptions(ctx, clr).OrderBy(e => e.Player, StringComparer.Ordinal))
            ctx.Emit("roll_exemption", new SourceCast(ex.CastId, null, ex.CardName, ex.Player), ex.Player,
                TraceValue.Status("rolls"), TraceValue.Status("skipped"));
    }
}

internal sealed class Phase0aMaterialiseCopies : EvalPhase
{
    public override string Id => "0a";
    public override void Run(EvalContext ctx)
    {
        ctx.HasInvocations = ctx.Casts.Any(c => c.EffectKind is null && (c.CastInputs.Has("copied_cast_id") || c.CastInputs.Has("seized_cast_id")));
        if (!ctx.HasInvocations) return;

        foreach (var inv in Rules.InvocationResolution(ctx))
        {
            if (inv.Kind != "copy" || inv.Negated || inv.SourceBroken || inv.WardCastId is not null) continue;
            if (ctx.Casts.Any(c => c.SourceCastId == inv.CastId && c.CastInputs.Has("is_copy") && c.Generation == ctx.Gen)) continue;

            var invCast = ctx.AllCasts[inv.CastId];
            var byCast = invCast.CastInputs.Get("copy_inputs").Get("by_cast");

            foreach (var src in ctx.Casts.Where(c => c.CardInstanceId == inv.SourceGroup && !c.IsCourageSpend).OrderBy(c => c.Seq).ToList())
            {
                var counterLike = src.EffectKind is "contested_negate" or "redirect";
                var rowCp = byCast.Get(src.Id.ToString());
                var ci = new Dictionary<string, object?> { ["is_copy"] = true, ["copy_of_cast_id"] = src.Id };
                if (src.EffectKind == "contested_negate" && rowCp.Has("dc_d20")) { ci["dc_d20"] = rowCp.Int("dc_d20"); ci["dc"] = rowCp.Int("dc"); }
                else if (src.EffectKind == "dice_modifier" && rowCp.Has("dice_roll")) ci["dice_roll"] = rowCp.Int("dice_roll");
                else if (src.EffectKind is "advantage" or "disadvantage" or "forced_reroll" or "roll_flip" or "roll_swap" or "roll_pair_transform"
                         && rowCp.Has("roll_transform")) ci["roll_transform"] = rowCp.Get("roll_transform");

                ctx.AddCast(seq => new WorkingCast
                {
                    Id = DeterministicId(inv.CastId, src.Id, ctx.Gen), RoundId = ctx.RoundId, CasterId = inv.Caster,
                    CardInstanceId = invCast.CardInstanceId, TargetPlayerId = counterLike ? null : inv.Caster,
                    TargetPending = false, EffectKind = src.EffectKind, EffectParams = src.EffectParams,
                    ParentCastId = counterLike ? src.ParentCastId : null, CastAt = ctx.S.DbNow,
                    ReactionWindowId = src.ReactionWindowId, Seq = seq, TargetRole = counterLike ? "CARD" : "CASTER",
                    CastInputs = JsonSerializer.SerializeToElement(ci), SourceCastId = inv.CastId, Generation = ctx.Gen,
                    Synthesized = true,
                });
            }
        }
    }

    private static Guid DeterministicId(Guid invocation, Guid source, int gen) =>
        new(MD5.HashData(Encoding.UTF8.GetBytes($"rfb-copy:{invocation}:{source}:{gen}")));
}

internal sealed class Phase1CastLogResolution : EvalPhase
{
    public override string Id => "1";
    public override void Run(EvalContext ctx)
    {
        ctx.HasCounters = ctx.Casts.Any(c => c.EffectKind is "contested_negate" or "redirect");
        if (ctx.HasCounters)
        {
            ctx.NegatedGroups.Clear();
            ctx.RedirectMap.Clear();
            ctx.ClrRows = Rules.CastLogResolution(ctx);

            foreach (var r in ctx.ClrRows)
            {
                if (r.CounterKind == "contested_negate" && r.CounterSucceeded && !r.CounterNegated) ctx.NegatedGroups.Add(r.VictimGroup);
                if (r.RedirectTo is not null) ctx.RedirectMap[r.VictimCastId] = r.RedirectTo;
            }

            foreach (var c in ctx.Casts.Where(c => !c.IsCourageSpend)) c.Negated = ctx.NegatedGroups.Contains(c.CardInstanceId);
            foreach (var c in ctx.Casts) c.RedirectedToCastId = null;
            foreach (var r in ctx.ClrRows.Where(r => r.RedirectTo is not null))
                if (!ctx.NegatedGroups.Contains(r.VictimGroup) && ctx.AllCasts.TryGetValue(r.VictimCastId, out var v))
                    v.RedirectedToCastId = r.CounterCastId;

            foreach (var r in ctx.ClrRows.OrderBy(r => r.CounterSeq))
            {
                var counter = ctx.AllCasts[r.CounterCastId];
                if (ctx.CardOfCast(counter) is not { } card) continue;
                var source = new SourceCast(r.CounterCastId, null, card.Name, r.CounterCaster);
                if (r.CounterKind == "contested_negate")
                {
                    ctx.Emit("contested_negate", source, r.VictimOrigTarget, TraceValue.Status("cast"),
                        TraceValue.Status(r.CounterNegated ? "countered" : r.CounterBackfired ? "backfired" : r.CounterSucceeded ? "negated target" : "no effect"),
                        ("dc_d20", r.CounterDcD20), ("dc", r.CounterDc),
                        ("outcome", r.CounterBackfired ? "backfired" : !r.CounterNegated && r.CounterSucceeded ? "applied" : "no-op"));
                }
                else
                {
                    ctx.Emit("redirect", source, r.RedirectTo, TraceValue.Target(r.VictimOrigTarget),
                        TraceValue.Target(r.CounterNegated ? r.VictimOrigTarget : r.RedirectTo));
                }
            }

            foreach (var g in ctx.Casts.Where(c => ctx.NegatedGroups.Contains(c.CardInstanceId) && !c.IsCourageSpend)
                         .GroupBy(c => c.CardInstanceId).OrderBy(g => g.Key, Jb.UuidOrder))
            {
                var first = g.OrderBy(c => c.Seq).First();
                if (ctx.CardOfCast(first) is not { } card) continue;
                ctx.Emit(first.EffectKind ?? "unknown", new SourceCast(null, null, card.Name, first.CasterId), first.TargetPlayerId,
                    TraceValue.Status("negated"), TraceValue.Status("negated"), ("negated", true));
            }
        }

        foreach (var sp in ctx.Casts.Where(c => c.IsCourageSpend))
            if (sp.CastInputs.GuidOf("courage_token_cast_id") is { } gid && ctx.AllCasts.TryGetValue(gid, out var gift))
                sp.Negated = gift.Negated;
    }
}

internal sealed class WardBlockedPrepass : EvalPhase
{
    public override string Id => "1-ward-blocked-prepass";
    public override void Run(EvalContext ctx)
    {
        var groups = ctx.Casts.Where(c => c.CastInputs.Has("ward_blocked_by")).Select(c => c.CardInstanceId).ToHashSet();
        foreach (var c in ctx.Casts.Where(c => groups.Contains(c.CardInstanceId) && !c.IsCourageSpend)) c.Negated = true;

        foreach (var sc in ctx.Casts.Where(c => c.CastInputs.Has("ward_blocked_by") && c.CastInputs.Has("ward_target")).OrderBy(c => c.Seq))
        {
            if (ctx.CardOfCast(sc) is not { } card) continue;
            var before = sc.CastInputs.Dec("would_be_before");
            var target = sc.CastInputs.Text("ward_target");
            ctx.Emit("warded", Src(sc, card.Name), target, TraceValue.Modifier(before), TraceValue.Modifier(before),
                ("blocked_cast_id", sc.Id), ("ward_cast_id", sc.CastInputs.Text("ward_blocked_by")),
                ("ward_card_name", sc.CastInputs.Text("ward_card_name")), ("target", target),
                ("would_be_before", before), ("would_be_after", sc.CastInputs.Dec("would_be_after")), ("outcome", "blocked"));
        }
    }
}

internal sealed class BrewmageddonPrepass : EvalPhase
{
    public override string Id => "1-brewmageddon-prepass";
    public override void Run(EvalContext ctx)
    {
        foreach (var c in ctx.Casts.Where(c => (c.EffectKind == "compel_cast" && !c.Negated) || c.EffectKind == "forfeit").OrderBy(c => c.Seq))
        {
            if (ctx.CardOfCast(c) is not { } card) continue;
            var source = Src(c, card.Name);
            if (c.EffectKind == "compel_cast")
            {
                var compelled = c.CastInputs.Get("compelled").Items().ToList();
                var ids = compelled.Select(h => (JsonElement?)h).OrderBy(h => h.Text("player_id"), StringComparer.Ordinal)
                    .Select(h => (object?)h.Get("player_id")).ToList();
                ctx.Emit("compel_cast", source, null, TraceValue.Status("cast"), TraceValue.Status("compelled"),
                    ("compelled_player_ids", ids), ("outcome", compelled.Count > 0 ? "applied" : "no-op"));
            }
            else
            {
                ctx.Emit("forfeit", source, c.CasterId, TraceValue.Status("held"), TraceValue.Status("forfeited"),
                    ("compelled_by", c.CastInputs.Get("compelled_by")), ("reason", c.CastInputs.Get("reason")), ("outcome", "no-op"));
            }
        }
    }
}

internal sealed class Phase0bInvocationOutcomes : EvalPhase
{
    private static readonly HashSet<string> RollKinds = ["advantage", "disadvantage", "forced_reroll", "roll_flip", "roll_swap", "roll_pair_transform"];

    public override string Id => "0b";
    public override void Run(EvalContext ctx)
    {
        if (!ctx.HasInvocations) return;
        foreach (var inv in Rules.InvocationResolution(ctx))
        {
            var invSource = new SourceCast(inv.CastId, null, inv.Kind == "seize" ? "Brew-merang" : "Saucerer's Apprentice", inv.Caster);

            if (inv.WardCastId is not null)
            {
                ClearCaches(ctx, inv);
                var t = inv.SourceCaster ?? inv.Caster;
                ctx.Emit("warded", invSource, t, TraceValue.Status("cast"), TraceValue.Status("blocked"),
                    ("blocked_cast_id", inv.CastId), ("ward_cast_id", inv.WardCastId), ("ward_card_name", inv.WardCardName),
                    ("target", t), ("invocation_kind", inv.Kind), ("outcome", "blocked"));
                continue;
            }

            if (inv.Negated || inv.SourceBroken)
            {
                ClearCaches(ctx, inv);
                ctx.Emit(inv.Kind, invSource, inv.SourceCaster ?? inv.Caster, TraceValue.Status("cast"), TraceValue.Status("no effect"),
                    ("invocation_kind", inv.Kind), ("outcome", "no-op"), ("reason", inv.Negated ? "countered" : "source broken"));
                continue;
            }

            if (inv.Kind == "copy")
            {
                ctx.AllCasts[inv.CastId].CopiedCastId = inv.SourceParentCastId;
                ctx.Emit("copy", invSource, inv.Caster, TraceValue.Status("cast"), TraceValue.Status("copied"),
                    ("copied_cast_id", inv.SourceParentCastId), ("landed_on", inv.Caster), ("outcome", "applied"));
                continue;
            }

            var group = ctx.Casts.Where(c => c.CardInstanceId == inv.SourceGroup && !c.IsCourageSpend).ToList();
            if (!ctx.Casts.Any(c => c.CardInstanceId == inv.SourceGroup && c.SeizedByCastId == inv.CastId))
            {
                var ranked = group
                    .GroupBy(c => (c.EffectKind, Params: c.EffectParams.Canon()))
                    .SelectMany(g => g.OrderBy(c => c.Seq).Select((c, i) => (Cast: c, Rn: i + 1)))
                    .ToList();
                foreach (var (c, rn) in ranked)
                {
                    var keep = rn == 1 && c.EffectKind is not null && !RollKinds.Contains(c.EffectKind);
                    if (keep) { c.TargetPlayerId = inv.SourceCaster; c.TargetRole = "CASTER"; }
                    c.TargetPending = false;
                    if (!keep) c.Negated = true;
                    c.SeizedByCastId = inv.CastId;
                    if (keep) c.SeizedKept = true;
                }
            }
            foreach (var c in ctx.Casts.Where(c => c.SeizedByCastId == inv.CastId && !c.SeizedKept)) c.Negated = true;

            ctx.Emit("seize", invSource, inv.SourceCaster, TraceValue.Status("cast"), TraceValue.Status("seized"),
                ("seized_by_cast_id", inv.CastId), ("source_caster", inv.SourceCaster), ("outcome", "applied"));
        }
    }

    private static void ClearCaches(EvalContext ctx, Invocation inv)
    {
        foreach (var c in ctx.Casts.Where(c => c.SeizedByCastId == inv.CastId || c.Id == inv.CastId))
        { c.SeizedByCastId = null; c.CopiedCastId = null; }
    }
}

internal sealed class Phase2WardProjection : EvalPhase
{
    public override string Id => "2";
    public override void Run(EvalContext ctx)
    {
        ctx.WardMap.Clear();
        foreach (var g in ctx.LiveEffects.Where(e => e.EffectKind == "ward" && ctx.Players.Contains(e.TargetPlayerId)).GroupBy(e => e.TargetPlayerId))
        {
            var wards = new List<Ward>();
            foreach (var sae in g.OrderBy(e => e.CreatedAt))
            {
                if (ctx.Card(sae.CardId) is not { } card) continue;
                var wc = ctx.AllCasts.GetValueOrDefault(sae.SourceCastId);
                JsonElement? p = sae.EffectParams;
                wards.Add(new Ward(p.Get("domain"), p.Get("polarity"), p.Flag("block_earned_modifier"),
                    wc is not null && wc.RoundId == ctx.RoundId ? wc.Seq : null, sae.SourceCastId, card.Name));
            }
            if (wards.Count > 0) ctx.WardMap[g.Key] = wards;
        }
    }
}
