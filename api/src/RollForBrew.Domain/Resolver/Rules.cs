using System.Text.Json;
using RollForBrew.Domain.Snapshot;

namespace RollForBrew.Domain.Resolver;

internal sealed record ClrRow(
    Guid CounterCastId, string CounterKind, long CounterSeq, bool CounterNegated, bool CounterSucceeded,
    bool CounterBackfired, int? CounterDcD20, int? CounterDc, string CounterCaster, Guid VictimGroup,
    Guid VictimCastId, string? VictimOrigTarget, string VictimCaster, string? RedirectTo);

internal sealed record Invocation(
    Guid CastId, string Kind, long Seq, string Caster, bool Negated, Guid? SourceParentCastId, Guid? SourceGroup,
    string? SourceCaster, bool SourceBroken, Guid? WardCastId, string? WardCardName);

internal sealed record BrewDebt(string DebtorPlayerId, Guid CastId, string CardName, Guid BrewIouRoundId);

internal static class Rules
{
    public static int TierDefaultDc(string tier) => tier switch { "common" => 2, "rare" => 5, _ => 10 };

    private sealed class Counter
    {
        public required WorkingCast Cast; public required string Kind; public required Guid TargetGroup;
        public required Guid OwnGroup; public required string? VictimOrigTarget; public required string VictimCaster;
        public int? DcD20; public int? Dc; public bool HasBackfire; public bool Succeeded; public bool IsNegated;
    }

    public static List<ClrRow> CastLogResolution(EvalContext ctx)
    {
        var counters = new List<Counter>();
        foreach (var c in ctx.Casts.Where(c => c.EffectKind is "contested_negate" or "redirect").OrderBy(c => c.Seq))
        {
            if (c.ParentCastId is not { } pid || !ctx.AllCasts.TryGetValue(pid, out var tgt)) continue;
            if (ctx.CardOfCast(tgt) is not { } tcard) continue;
            var isRedirect = c.EffectKind == "redirect";
            int? dc = isRedirect ? null : c.CastInputs.Int("dc") ?? TierDefaultDc(tcard.Tier);
            var d20 = c.CastInputs.Int("dc_d20");
            counters.Add(new Counter
            {
                Cast = c, Kind = c.EffectKind!, TargetGroup = tgt.CardInstanceId, OwnGroup = c.CardInstanceId,
                VictimOrigTarget = tgt.TargetPlayerId, VictimCaster = tgt.CasterId, DcD20 = d20, Dc = dc,
                HasBackfire = c.CastInputs.Has("backfire"),
                Succeeded = isRedirect || (d20 is { } v && v >= (c.CastInputs.Int("dc") ?? TierDefaultDc(tcard.Tier))),
            });
        }
        if (counters.Count == 0) return [];

        for (var pass = 1; pass <= 2 * counters.Count + 2; pass++)
        {
            var changed = false;
            foreach (var c in counters)
            {
                var neg = counters.Any(d => d.Kind == "contested_negate" && d.TargetGroup == c.OwnGroup
                    && d.Cast.Seq > c.Cast.Seq && d.Succeeded && !d.IsNegated);
                if (neg != c.IsNegated) { c.IsNegated = neg; changed = true; }
            }
            if (!changed) break;
        }

        return counters.Select(c => new ClrRow(
            c.Cast.Id, c.Kind, c.Cast.Seq, c.IsNegated, c.Succeeded, c.HasBackfire && !c.IsNegated, c.DcD20, c.Dc,
            c.Cast.CasterId, c.TargetGroup, c.Cast.ParentCastId!.Value, c.VictimOrigTarget, c.VictimCaster,
            c.Kind == "redirect" && !c.IsNegated ? c.VictimCaster : null)).ToList();
    }

    public static List<(string Player, Guid CastId, string CardName)> RollExemptions(EvalContext ctx, List<ClrRow> clr)
    {
        var participants = ctx.S.RoundParticipants.Where(p => p.RoundId == ctx.RoundId).Select(p => p.PlayerId).ToHashSet();
        var result = new List<(string, Guid, string)>();
        var seen = new HashSet<string>();
        foreach (var sc in ctx.Casts.OrderBy(c => c.CasterId, StringComparer.Ordinal).ThenBy(c => c.CastAt).ThenBy(c => c.Seq))
        {
            if (!participants.Contains(sc.CasterId) || seen.Contains(sc.CasterId)) continue;
            if (!sc.EffectParams.Flag("exempt_from_rolling") || sc.CastInputs.Has("is_copy")) continue;
            if (ctx.CardOfCast(sc) is not { } card) continue;
            var countered = clr.Any(r => r.VictimGroup == sc.CardInstanceId && r.CounterKind == "contested_negate"
                && r.CounterSucceeded && !r.CounterNegated && !r.CounterBackfired);
            if (countered) continue;
            seen.Add(sc.CasterId);
            result.Add((sc.CasterId, sc.Id, card.Name));
        }
        return result;
    }

    private sealed class InvEntry
    {
        public required string RowKind; public required WorkingCast Cast; public required Guid OwnGroup;
        public Guid TargetGroup; public bool Succeeded; public bool IsNegated;
        public string Kind = ""; public WorkingCast? Src;
    }

    public static List<Invocation> InvocationResolution(EvalContext ctx)
    {
        var set = new List<InvEntry>();
        foreach (var c in ctx.Casts.Where(c => c.EffectKind == "contested_negate"))
        {
            if (c.ParentCastId is not { } pid || !ctx.AllCasts.TryGetValue(pid, out var tgt) || ctx.CardOfCast(tgt) is not { } tcard) continue;
            var ok = c.CastInputs.Int("dc_d20") is { } d20 && d20 >= (c.CastInputs.Int("dc") ?? TierDefaultDc(tcard.Tier));
            set.Add(new InvEntry { RowKind = "counter", Cast = c, OwnGroup = c.CardInstanceId, TargetGroup = tgt.CardInstanceId, Succeeded = ok });
        }
        foreach (var c in ctx.Casts.Where(c => c.EffectKind is null && (c.CastInputs.Has("copied_cast_id") || c.CastInputs.Has("seized_cast_id"))))
        {
            WorkingCast? src = c.ParentCastId is { } p && ctx.AllCasts.TryGetValue(p, out var s) ? s : null;
            set.Add(new InvEntry
            {
                RowKind = "invocation", Cast = c, OwnGroup = c.CardInstanceId, Src = src,
                Kind = c.CastInputs.Has("seized_cast_id") ? "seize" : "copy",
            });
        }
        set = set.OrderBy(e => e.Cast.Seq).ToList();
        if (set.Count == 0) return [];

        for (var pass = 1; pass <= 2 * set.Count + 2; pass++)
        {
            var changed = false;
            foreach (var c in set)
            {
                var neg = set.Any(d => d.RowKind == "counter" && d.TargetGroup == c.OwnGroup
                    && d.Cast.Seq > c.Cast.Seq && d.Succeeded && !d.IsNegated);
                if (neg != c.IsNegated) { c.IsNegated = neg; changed = true; }
            }
            if (!changed) break;
        }

        var negatedGroups = set.Where(d => d.RowKind == "counter" && d.Succeeded && !d.IsNegated).Select(d => d.TargetGroup).ToHashSet();
        negatedGroups.UnionWith(set.Where(d => d.RowKind == "invocation" && d.IsNegated).Select(d => d.OwnGroup));

        var result = new List<Invocation>();
        foreach (var e in set.Where(e => e.RowKind == "invocation"))
        {
            var srcGroup = e.Src?.CardInstanceId;
            var srcCaster = e.Src?.CasterId;
            Guid? wardCast = null; string? wardName = null;
            if (srcCaster is not null)
            {
                var ward = ctx.S.ActiveEffects
                    .Where(a => a.RoomId == ctx.RoomId && a.TargetPlayerId == srcCaster && a.EffectKind == "ward"
                        && ((JsonElement?)a.EffectParams).Flag("block_copy")
                        && ctx.Card(a.CardId) is not null)
                    .OrderBy(a => a.CreatedAt).FirstOrDefault();
                if (ward is not null) { wardCast = ward.SourceCastId; wardName = ctx.Card(ward.CardId)!.Name; }
            }
            result.Add(new Invocation(
                e.Cast.Id, e.Kind, e.Cast.Seq, e.Cast.CasterId, e.IsNegated, e.Cast.ParentCastId, srcGroup, srcCaster,
                srcGroup is null || negatedGroups.Contains(srcGroup.Value), wardCast, wardName));
        }
        return result;
    }

    public static string IncomingPolarity(string kind, decimal? delta, decimal? multiplier, decimal? setValue, decimal? baseValue) => kind switch
    {
        "flat_modifier" or "dice_modifier" or "roll_swap" => delta > 0 ? "positive" : delta < 0 ? "negative" : "neutral",
        "modifier_multiplier" => multiplier > 1 ? "positive" : multiplier < 1 ? "negative" : "neutral",
        "set_modifier" => setValue > baseValue ? "positive" : setValue < baseValue ? "negative" : "neutral",
        "advantage" => "positive",
        "disadvantage" or "forced_reroll" => "negative",
        "lowest_gains_highest_modifier" => "positive",
        _ => "neutral",
    };

    public static string ElPolarity(ModEffect el, decimal baseValue) =>
        IncomingPolarity(el.Kind, el.Flat, el.Mult, el.Set, baseValue);

    public static Ward? WardHit(EvalContext ctx, string target, string domain, string polarity, long? beforeSeq) =>
        !ctx.WardMap.TryGetValue(target, out var wards) ? null
        : wards.FirstOrDefault(w =>
            polarity != "neutral" && w.Domain.ContainsString(domain) && w.Polarity.ContainsString(polarity)
            && (w.WardSeq is null || beforeSeq is null || w.WardSeq < beforeSeq));

    public static decimal Compose(decimal baseValue, IEnumerable<ModEffect> effects)
    {
        decimal? set = null; long setOrd = 0; var haveSet = false;
        decimal mult = 1, flat = 0;
        foreach (var e in effects)
        {
            if (e.Set is { } sv) { if (!haveSet || e.Ord >= setOrd) { set = sv; setOrd = e.Ord; haveSet = true; } }
            else if (e.Mult is { } m) mult *= m;
            else if (e.Flat is { } f) flat += f;
        }
        return set ?? baseValue * mult + flat;
    }

    public static decimal BaseModifier(EvalContext ctx, string playerId) =>
        ctx.S.Rounds
            .Where(r => r.RoomId == ctx.RoomId && r.BrewerId == playerId && r.Status == "resolved")
            .Sum(r => (decimal)r.BrewerModifierGain)
        + ctx.S.ModifierAdjustments
            .Where(m => m.RoomId == ctx.RoomId && m.TargetPlayerId == playerId)
            .Sum(m => (decimal)m.Delta);

    public static decimal SpellModifierDelta(EvalContext ctx, string playerId, Guid? excludeRoundId)
    {
        var rounds = ctx.S.Rounds.Where(r => r.RoomId == ctx.RoomId).ToDictionary(r => r.Id);
        decimal sum = 0;
        foreach (var sc in ctx.AllCasts.Values)
        {
            if (!rounds.TryGetValue(sc.RoundId, out var r)) continue;
            if (sc.TargetPlayerId != playerId) continue;
            if (sc.EffectKind is not ("persistent_modifier_transfer" or "persistent_modifier_spend")) continue;
            if (sc.Negated) continue;
            if (sc.Generation != r.ReplayGeneration) continue;
            if (excludeRoundId is { } ex && sc.RoundId == ex) continue;
            sum += sc.EffectParams.Dec("delta") ?? 0;
        }
        return sum;
    }

    public static BrewDebt? BrewDebtDue(EvalContext ctx)
    {
        if (ctx.S.Rolls.Any(r => r.RoundId == ctx.RoundId && r.Layer == 0)) return null;
        var asOf = ctx.Round.ClosedAt ?? ctx.S.DbNow;
        var roomIsTest = ctx.S.Rooms.FirstOrDefault(rm => rm.Id == ctx.RoomId)?.IsTest;
        var paid = ctx.S.Rounds
            .Where(r => r.BrewerSource == "brew_debt" && r.Id != ctx.RoundId && r.BrewerSourceCastId is not null)
            .Select(r => r.BrewerSourceCastId!.Value)
            .ToHashSet();

        var due = new List<(DateTimeOffset ResolvedAt, DateTimeOffset CastAt, long Seq, BrewDebt Debt)>();
        foreach (var player in ctx.S.RoundParticipants
                     .Where(p => p.RoundId == ctx.RoundId && p.ExcludedAt is null)
                     .Select(p => p.PlayerId).Distinct())
        {
            if (ctx.LiveEffects.Any(e => e.EffectKind == "brewer_immunity" && e.TargetPlayerId == player)) continue;
            foreach (var c in ctx.AllCasts.Values.Where(c => c.CasterId == player))
            {
                if (paid.Contains(c.Id)) continue;
                if (ctx.CardOfCast(c) is not { } card) continue;
                foreach (var iou in ctx.S.Rounds.Where(r => r.BrewerSource == "brew_iou" && r.BrewerSourceCastId == c.Id
                             && r.Id != ctx.RoundId && r.Status == "resolved"
                             && r.ResolvedAt is not null && r.ResolvedAt < asOf))
                    if (ctx.S.Rooms.FirstOrDefault(rm => rm.Id == iou.RoomId)?.IsTest == roomIsTest)
                        due.Add((iou.ResolvedAt!.Value, c.CastAt, c.Seq, new BrewDebt(player, c.Id, card.Name, iou.Id)));
            }
        }
        return due.OrderBy(d => d.ResolvedAt).ThenBy(d => d.CastAt).ThenBy(d => d.Seq).Select(d => d.Debt).FirstOrDefault();
    }

    public static List<string> PickLowest(IReadOnlyList<string> players, IReadOnlyList<int> rolls, IReadOnlyList<decimal> modifier, IReadOnlyList<bool>? diceReduced)    {
        bool Reduced(int i) => diceReduced is not null && i < diceReduced.Count && diceReduced[i];
        var idx = Enumerable.Range(0, players.Count).ToList();
        List<string> Named(IEnumerable<int> ix) => ix.Select(i => players[i]).OrderBy(p => p, StringComparer.Ordinal).ToList();

        var nat1 = idx.Where(i => rolls[i] == 1 && !Reduced(i)).ToList();
        if (nat1.Count > 0)
        {
            var min = nat1.Min(i => modifier[i]);
            return Named(nat1.Where(i => modifier[i] == min));
        }
        if (idx.All(i => rolls[i] == 20))
        {
            if (idx.Count == 0) return [];
            var min = idx.Min(i => modifier[i]);
            return Named(idx.Where(i => modifier[i] == min));
        }
        var rest = idx.Where(i => rolls[i] != 20).ToList();
        var lowest = rest.Min(i => rolls[i] + modifier[i]);
        return Named(rest.Where(i => rolls[i] + modifier[i] == lowest));
    }
}
