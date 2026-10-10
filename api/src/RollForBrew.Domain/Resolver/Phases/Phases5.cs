using System.Text.Json;
using RollForBrew.Domain.Snapshot;

namespace RollForBrew.Domain.Resolver.Phases;

internal sealed record ImmuneEntry(Guid AeId, string CasterId, string CardName, bool OverrideProof, string? Mode);

internal sealed class Phase5TeaMaker : EvalPhase
{
    public override string Id => "5";

    public override void Run(EvalContext ctx)
    {
        var debt = Rules.BrewDebtDue(ctx);
        var immune = ImmunityMap(ctx);
        bool Candidate(string pid) => !immune.ContainsKey(pid);

        string? brewer = null, brewerSource = null;
        var outcome = "brewer";
        int? modifierGain = null;
        List<string>? tied = null;
        EarlTransfer? earlTransfer = null;
        BrewerRecord? brewerRecord = null;
        string? iouDebtor = null, iouCard = null;

        if (debt is not null)
        {
            brewer = debt.DebtorPlayerId;
            brewerSource = "brew_debt";
            brewerRecord = new BrewerRecord("brew_debt", debt.CastId);
            ctx.Emit("brew_debt", new SourceCast(debt.CastId, null, debt.CardName, debt.DebtorPlayerId), brewer,
                TraceValue.Status("owes"), TraceValue.Status("brewer"), ("brew_debt", "paid"));
        }

        if (brewer is null)
        {
            foreach (var e in ctx.LiveEffects.Where(e => e.EffectKind == "declared_number_tea_maker")
                         .OrderBy(e => e.CreatedAt).ThenBy(e => e.Id, Jb.UuidOrder))
            {
                if (ctx.Card(e.CardId) is not { } card) continue;
                var number = ((JsonElement?)e.EffectParams).Int("number");
                if (number is null) continue;
                var matches = ctx.S.Rolls
                    .Where(r => r.RoundId == ctx.RoundId && r.Layer == 0 && r.Value == number)
                    .OrderBy(r => r.PlayerId, StringComparer.Ordinal).ToList();
                var hit = matches.FirstOrDefault(r => Candidate(r.PlayerId));
                if (hit is not null)
                {
                    brewer = hit.PlayerId;
                    brewerSource = "declared_number";
                    ctx.Emit("declared_number_tea_maker", new SourceCast(null, e.Id, card.Name, e.CasterId), brewer,
                        TraceValue.Status("pending"), TraceValue.Status("brewer"));
                    break;
                }
                foreach (var m in matches.Where(r => !Candidate(r.PlayerId)))
                    EmitImmunitySkip(ctx, immune, m.PlayerId, "declared_number", card.Name);
            }
        }

        var passedOver = new List<(string Player, string Reason)>();
        if (brewer is null)
        {
            var winner = default(WorkingCast);
            var winnerCard = default(SpellCardRow);
            var winnerGain = default(int?);
            var winnerCreatesDebt = false;
            var winnerLive = false;
            var target = default(string);

            foreach (var c in ctx.Casts
                         .Where(c => c.EffectKind == "tea_maker_override"
                             && (!c.Negated || (c.CastInputs.Has("revolt_pick_abandoned") && !ctx.HasCounters)))
                         .OrderByDescending(c => c.CastAt).ThenByDescending(c => c.Seq))
            {
                if (ctx.CardOfCast(c) is not { } card) continue;
                var ep = (JsonElement?)c.EffectParams;
                var mode = ep.Text("mode");
                var chosen = ctx.RedirectMap.TryGetValue(c.Id, out var redirected) ? redirected : c.TargetPlayerId;
                var picker = ep.Text("picker");
                var pickedBy = c.CastInputs.Text("revolt_picked_by");
                var pickAbandoned = c.CastInputs.Has("revolt_pick_abandoned");
                var createsDebt = ep.Flag("creates_brew_debt");
                var gain = ep.Int("modifier_gain")
                    ?? (ep.Int("modifier_gain_multiplier") is { } m ? m * ctx.ParticipantCount : (int?)null)
                    ?? (ep.Flag("no_modifier_gain") ? 0 : (int?)null);

                string? inertAfter = null;
                JsonElement? inertExtra = null;
                passedOver = [];
                target = null;

                if (mode == "prev_round_highest")
                {
                    var drip = LastDripTarget(ctx);
                    target = drip.Target;
                    passedOver = drip.PassedOver;
                    if (target is null)
                    {
                        inertAfter = "no effect";
                        var extra = new Dictionary<string, object?> { ["outcome"] = "no-op", ["override_reason"] = drip.Reason };
                        if (passedOver.Count > 0) extra["passed_over"] = JsonSerializer.SerializeToElement(
                            passedOver.Select(p => new Dictionary<string, object?> { ["player_id"] = p.Player, ["reason"] = p.Reason }));
                        inertExtra = JsonSerializer.SerializeToElement(extra);
                    }
                }
                else if (picker == "lowest_roller" && (pickAbandoned || c.TargetPlayerId is null))
                {
                    inertAfter = "no effect";
                    inertExtra = JsonSerializer.SerializeToElement(new Dictionary<string, object?>
                    {
                        ["outcome"] = "no-op",
                        ["override_reason"] = pickAbandoned ? "pick_abandoned" : "pick_pending",
                    });
                }
                else if (c.TargetPending)
                {
                }
                else if (mode == "chosen")
                {
                    target = chosen;
                }
                else if (mode == "conditional_chosen")
                {
                    var condition = ep.Text("condition");
                    if (condition != "target_below_caster")
                        throw new InvalidOperationException($"resolve_round: unsupported conditional_chosen condition {condition}");
                    var ti = ctx.PlayerIndex(chosen!);
                    var ci = ctx.PlayerIndex(c.CasterId);
                    var targetRoll = ti >= 0 ? ctx.Rolls[ti] : (int?)null;
                    var casterRoll = ci >= 0 ? ctx.Rolls[ci] : (int?)null;
                    target = chosen;
                    if (!(targetRoll < casterRoll))
                    {
                        inertAfter = "condition not met";
                        inertExtra = JsonSerializer.SerializeToElement(new Dictionary<string, object?>
                        {
                            ["outcome"] = "no-op", ["override_reason"] = "condition_not_met",
                            ["override_condition"] = condition, ["target_roll"] = targetRoll, ["caster_roll"] = casterRoll,
                        });
                    }
                }
                else if (mode == "highest_roll")
                {
                    target = Enumerable.Range(0, ctx.Players.Count)
                        .OrderByDescending(i => ctx.Rolls[i]).ThenBy(i => ctx.Players[i], StringComparer.Ordinal)
                        .Select(i => ctx.Players[i]).FirstOrDefault();
                }
                else if (mode == "highest_modifier")
                {
                    var raw = ctx.S.Rolls.Where(r => r.RoundId == ctx.RoundId && r.Layer == 0)
                        .OrderByDescending(r => r.ModifierSnapshot).ThenBy(r => r.PlayerId, StringComparer.Ordinal).ToList();
                    var plainHigh = raw.FirstOrDefault();
                    var high = raw.FirstOrDefault(r => !ctx.SkipMap.ContainsKey(r.PlayerId)) ?? plainHigh;
                    if (high is not null)
                    {
                        target = high.PlayerId;
                        if (plainHigh is not null && plainHigh.PlayerId != high.PlayerId && ctx.SkipMap.ContainsKey(plainHigh.PlayerId))
                        {
                            var (aeId, caster) = ctx.SkipMap[plainHigh.PlayerId];
                            ctx.Emit("targeting_skip", new SourceCast(null, aeId, "Cloud of Cream", caster), plainHigh.PlayerId,
                                TraceValue.Status("targetable"), TraceValue.Status("skipped"));
                        }
                    }
                }
                else
                {
                    throw new InvalidOperationException($"resolve_round: unsupported tea_maker_override mode {mode}");
                }

                if (inertAfter is not null)
                {
                    ctx.Emit("tea_maker_override", new SourceCast(c.Id, null, card.Name, c.CasterId), target,
                        TraceValue.Status("pending"), TraceValue.Status(inertAfter), ExtrasOf(inertExtra!.Value));
                    continue;
                }

                winner = c;
                winnerCard = card;
                winnerGain = gain;
                winnerCreatesDebt = createsDebt;
                winnerLive = !c.TargetPending;
                break;
            }

            if (winnerLive)
            {
                var ep = (JsonElement?)winner!.EffectParams;
                var pickedBy = winner.CastInputs.Text("revolt_picked_by");

                if (target is not null && immune.TryGetValue(target, out var entry) && entry.Mode == "earl"
                    && winner.CasterId != target)
                {
                    earlTransfer = new EarlTransfer(entry.AeId, target, winner.CasterId, winner.Id);
                    ctx.Emit("earl_transfer", new SourceCast(null, entry.AeId, entry.CardName, entry.CasterId), target,
                        TraceValue.Status("earl"), TraceValue.Status("title passed"),
                        ("new_earl_player_id", winner.CasterId), ("forcing_card_name", winnerCard!.Name));
                }

                if (target is not null && earlTransfer is null && !Candidate(target))
                {
                    EmitImmunitySkip(ctx, immune, target, "tea_maker_override", winnerCard!.Name);
                }
                else
                {
                    brewer = target;
                    modifierGain = winnerGain;
                    brewerSource = $"tea_maker_override:{ep.Text("mode")}";
                    if (winnerCreatesDebt && brewer is not null)
                    {
                        brewerRecord = new BrewerRecord("brew_iou", winner.Id);
                        iouDebtor = winner.CasterId;
                        iouCard = winnerCard!.Name;
                    }
                    ctx.Emit("tea_maker_override", new SourceCast(winner.Id, null, winnerCard!.Name, winner.CasterId), brewer,
                        TraceValue.Status("pending"),
                        TraceValue.Status(modifierGain == 0 ? "brewer (no modifier gain)" : "brewer"),
                        pickedBy is not null
                            ? [("picked_by", pickedBy)]
                            : passedOver.Count > 0
                                ? [("passed_over", JsonSerializer.SerializeToElement(
                                      passedOver.Select(p => new Dictionary<string, object?> { ["player_id"] = p.Player, ["reason"] = p.Reason })))]
                                : []);
                }
            }
        }

        if (brewer is null)
        {
            tied = Rules.PickLowest(ctx.Players, ctx.Rolls, ctx.Composed, ctx.DiceReduced);

            if (immune.Count > 0)
            {
                var pool = Enumerable.Range(0, ctx.Players.Count).Where(i => Candidate(ctx.Players[i])).ToList();
                if (pool.Count == 0)
                {
                    tied = ctx.S.RoundParticipants
                        .Where(p => p.RoundId == ctx.RoundId && p.ExcludedAt is null)
                        .Select(p => p.PlayerId).OrderBy(p => p, StringComparer.Ordinal).ToList();
                    ctx.Emit("brewer_immunity", SourceCast.None, null,
                        TraceValue.Status("immune"), TraceValue.Status(tied.Count > 1 ? "tie" : "brewer"),
                        ("immunity_tier", "all_immune"), ("skipped_card_name", null));
                }
                else
                {
                    foreach (var pid in tied.Where(pid => !Candidate(pid)))
                        EmitImmunitySkip(ctx, immune, pid, "lowest_roller", null);
                    tied = Rules.PickLowest(
                        pool.Select(i => ctx.Players[i]).ToList(),
                        pool.Select(i => ctx.Rolls[i]).ToList(),
                        pool.Select(i => ctx.Composed[i]).ToList(),
                        pool.Select(i => ctx.DiceReduced[i]).ToList());
                }
            }

            if (tied.Count > 1)
            {
                outcome = "tie";
                brewerSource = null;
                modifierGain = null;
            }
            else
            {
                brewer = tied[0];
                brewerSource = "default";
                tied = null;
            }
        }

        if (brewer is not null && debt is null)
        {
            var rolloff = ctx.Casts
                .Where(c => c.EffectKind == "named_tea_maker_rolloff" && !c.Negated && c.TargetPlayerId == brewer)
                .OrderBy(c => c.CastAt).ThenBy(c => c.Seq)
                .FirstOrDefault(c => ctx.CardOfCast(c) is not null);
            if (rolloff is { } rolloffCast && ctx.CardOfCast(rolloffCast) is { } rolloffCard)
            {
                var lineup = Enumerable.Range(0, ctx.Players.Count)
                    .Where(i => ctx.Players[i] == brewer || Candidate(ctx.Players[i])).ToList();
                var minLineup = ctx.Players.Contains(brewer) ? 3 : 2;
                List<string>? opponents = null;
                if (lineup.Count >= minLineup)
                {
                    var ordered = lineup.OrderBy(i => ctx.Rolls[i]).ThenBy(i => ctx.Composed[i]).ToList();
                    if (ordered.Count >= 2)
                    {
                        var second = ordered[1];
                        var found = ordered.Where(i => ctx.Players[i] != brewer
                                && ctx.Rolls[i] == ctx.Rolls[second] && ctx.Composed[i] == ctx.Composed[second])
                            .Select(i => ctx.Players[i]).OrderBy(p => p, StringComparer.Ordinal).ToList();
                        opponents = found.Count > 0 ? found : null;
                    }
                }

                ctx.Emit("named_tea_maker_rolloff", new SourceCast(rolloffCast.Id, null, rolloffCard.Name, rolloffCast.CasterId), brewer,
                    TraceValue.Status("brewer"), TraceValue.Status(opponents is not null ? "rolloff" : "no effect"),
                    opponents is not null
                        ? [("rolloff_opponent_ids", JsonSerializer.SerializeToElement(opponents))]
                        : [("outcome", "no-op"), ("rolloff_reason", "no_second_lowest")]);

                if (opponents is not null)
                {
                    outcome = "rolloff";
                    tied = [brewer, .. opponents];
                    brewer = null;
                    brewerSource = null;
                    modifierGain = null;
                    brewerRecord = null;
                }
            }
        }

        if (brewerRecord?.Source == "brew_iou" && iouDebtor is not null)
        {
            ctx.Emit("brew_debt", new SourceCast(brewerRecord.CastId, null, iouCard, iouDebtor), iouDebtor,
                TraceValue.Status("clear"), TraceValue.Status("owes"), ("brew_debt", "created"));
        }

        ctx.Outcome = brewer is not null ? "brewer" : outcome;
        ctx.BrewerId = brewer;
        ctx.BrewerSource = brewerSource;
        ctx.TiedPlayers = tied;
        ctx.ModifierGain = modifierGain;
        ctx.EarlTransfer = earlTransfer;
        ctx.BrewerRecord = brewerRecord;

        if (ctx.BrewerId is { } w && ctx.WardMap.TryGetValue(w, out var wards)
            && wards.FirstOrDefault(ward => ward.BlockEarnedModifier) is { } steep)
        {
            if (ctx.ModifierGain != 0)
                ctx.Emit("warded", new SourceCast(null, null, steep.WardCardName, null), w,
                    TraceValue.Status("brewer"), TraceValue.Status("brewer (no modifier gain)"),
                    ("blocked_cast_id", null), ("ward_cast_id", steep.WardCastId), ("ward_card_name", steep.WardCardName),
                    ("target", w), ("would_be_before", "brewer"), ("would_be_after", "brewer (no modifier gain)"), ("outcome", "blocked"));
            ctx.ModifierGain = 0;
        }
    }

    private static Dictionary<string, ImmuneEntry> ImmunityMap(EvalContext ctx)
    {
        var map = new Dictionary<string, ImmuneEntry>();
        foreach (var g in ctx.LiveEffects.Where(e => e.EffectKind == "brewer_immunity").GroupBy(e => e.TargetPlayerId))
        {
            ImmuneEntry? pick = null;
            foreach (var e in g.Select(e => (Row: e, Card: ctx.Card(e.CardId)))
                         .Where(x => x.Card is not null)
                         .OrderByDescending(x => ((JsonElement?)x.Row.EffectParams).Flag("override_proof"))
                         .ThenBy(x => ((JsonElement?)x.Row.EffectParams).Text("mode") == "earl")
                         .ThenBy(x => x.Row.CreatedAt).ThenBy(x => x.Row.Id, Jb.UuidOrder))
            {
                pick = new ImmuneEntry(e.Row.Id, e.Row.CasterId, e.Card!.Name,
                    ((JsonElement?)e.Row.EffectParams).Flag("override_proof"),
                    ((JsonElement?)e.Row.EffectParams).Text("mode"));
                break;
            }
            if (pick is not null) map[g.Key] = pick;
        }
        return map;
    }

    private static (string? Target, string? Reason, List<(string Player, string Reason)> PassedOver) LastDripTarget(EvalContext ctx)
    {
        var prev = ctx.S.Rounds
            .Where(r => r.RoomId == ctx.RoomId && r.Status == "resolved" && r.Id != ctx.RoundId && r.StartedAt < ctx.Round.StartedAt)
            .OrderByDescending(r => r.StartedAt).ThenBy(r => r.Id, Jb.UuidOrder)
            .FirstOrDefault();
        if (prev is null) return (null, "no_previous_round", []);

        var exempt = Rules.RollExemptions(ctx, ctx.ClrRows).Select(x => x.Player).ToHashSet();
        var passedOver = new List<(string, string)>();
        foreach (var r in ctx.S.Rolls.Where(x => x.RoundId == prev.Id && x.Layer == 0)
                     .OrderByDescending(x => x.Value).ThenBy(x => x.ModifierSnapshot).ThenBy(x => x.PlayerId, StringComparer.Ordinal))
        {
            var absent = !ctx.S.RoundParticipants.Any(p => p.RoundId == ctx.RoundId && p.PlayerId == r.PlayerId);
            if (!absent && !exempt.Contains(r.PlayerId)) return (r.PlayerId, null, passedOver);
            passedOver.Add((r.PlayerId, absent ? "absent" : "roll_exempt"));
        }
        return (null, "no_eligible_roller", passedOver);
    }

    private static void EmitImmunitySkip(EvalContext ctx, Dictionary<string, ImmuneEntry> immune, string pid, string tier, string? skippedCard)
    {
        var e = immune[pid];
        ctx.Emit("brewer_immunity", new SourceCast(null, e.AeId, e.CardName, e.CasterId), pid,
            TraceValue.Status("brewer"), TraceValue.Status("immune"),
            ("immunity_tier", tier), ("skipped_card_name", skippedCard));
    }

    private static (string, object?)[] ExtrasOf(JsonElement obj) =>
        obj.EnumerateObject().Select(p => (p.Name, (object?)p.Value.Clone())).ToArray();
}
