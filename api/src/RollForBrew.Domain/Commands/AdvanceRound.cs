using System.Text.Json;
using System.Text.Json.Nodes;
using RollForBrew.Domain.Dice;
using RollForBrew.Domain.Liveness;
using RollForBrew.Domain.Resolver;
using RollForBrew.Domain.Snapshot;

namespace RollForBrew.Domain.Commands;

/// <summary>
/// C# deciding layer advancement and round resolution (ADR 0010): what advance_layer and
/// finalize_layer decide, with the same outcome payload, the writes as data and the
/// broadcasts as events. Opening the reaction window stays a bridge until slice 6, so that
/// path takes two passes: bridge, then read what the bridge did from the reloaded snapshot.
/// One instance per call, because the second pass needs the raw rolls the first one saw.
/// </summary>
public sealed class AdvanceRound(IDieRoller dice)
{
    public enum Entry { Advance, Finalize }

    private JsonObject? _layerRolls;
    private bool _openedWindow;

    public Decision<JsonObject> Decide(RoundSnapshot? s, Guid roundId, Entry entry)
    {
        if (s?.Rounds.FirstOrDefault(r => r.Id == roundId) is not { } round)
            return Nothing(Noop("round_not_found"));
        if (_openedWindow) return AfterWindowOpened(s, round);
        if (round.Status != "closed") return Nothing(Noop("round_not_closed"));
        return entry == Entry.Finalize ? AsDecision(Finalize(s, round)) : Advance(s, round);
    }

    private Decision<JsonObject> Advance(RoundSnapshot s, RoundRow round)
    {
        var layer = round.CurrentLayer;
        var readiness = LayerReadiness.Of(s, round.Id, layer);
        if (!readiness.IsComplete) return Nothing(Noop(readiness.HoldReason));
        if (IsDebtRound(s, round)) return AsDecision(Finalize(s, round));

        var window0 = s.Windows.Where(w => w.RoundId == round.Id && w.Layer == 0).ToList();
        if (layer == 0 && window0.Count > 0)
        {
            if (window0.Any(w => w.Status == "open")) return Nothing(Noop("window_open"));
            return AsDecision(Finalize(s, round));
        }

        // The first call to find this Layer complete reveals its raw rolls, before any transform.
        _layerRolls = new JsonObject { ["layer"] = layer, ["rolls"] = RollsJson(s, round.Id, layer) };

        if (layer > 0)
        {
            var finalized = Finalize(s, round);
            finalized.Payload["layer_rolls"] = _layerRolls;
            return new Decision<JsonObject>(finalized.Writes, [LayerRollsRevealed(round.Id), .. finalized.Events], finalized.Payload);
        }

        _openedWindow = true;
        return new Decision<JsonObject>(
            [new Bridge("_forfeit_untargetable_compelled_reactions", round.Id), new Bridge("open_reaction_window", round.Id, 0)],
            [], Noop("window_open"), ReloadAfterWrite: true);
    }

    private Decision<JsonObject> AfterWindowOpened(RoundSnapshot s, RoundRow round)
    {
        var closed = s.Windows.Where(w => w.RoundId == round.Id && w.Layer == 0).All(w => w.Status == "closed");
        var finalized = closed ? Finalize(s, round) : null;
        return new Decision<JsonObject>(
            finalized?.Writes ?? [],
            [LayerRollsRevealed(round.Id), .. finalized?.Events ?? []],
            new JsonObject
            {
                ["outcome"] = "windowOpened",
                ["layer"] = 0,
                ["window_closed"] = closed,
                ["finalization"] = finalized?.Payload,
                ["layer_rolls"] = _layerRolls,
            });
    }

    private sealed record Finalized(IReadOnlyList<Write> Writes, IReadOnlyList<RoomEvent> Events, JsonObject Payload);

    private Finalized Finalize(RoundSnapshot s, RoundRow round)
    {
        var layer = round.CurrentLayer;
        var debt = IsDebtRound(s, round);
        if (layer == 0 && !debt)
        {
            var windows = s.Windows.Where(w => w.RoundId == round.Id && w.Layer == 0).ToList();
            if (windows.Count == 0) return new Finalized([], [], Noop("no_window"));
            if (windows.Any(w => w.Status == "open")) return new Finalized([], [], Noop("window_open"));
        }

        var readiness = LayerReadiness.Of(s, round.Id, layer);
        if (!readiness.IsComplete) return new Finalized([], [], Noop(readiness.HoldReason));

        // A debt round has no rolls to transform.
        var (shimmed, shimWrites) = debt ? (s, (IReadOnlyList<Write>)[]) : RollShim.Apply(s, round, layer, dice);
        var resolution = Evaluator.Evaluate(shimmed, round.Id, dice);
        if (resolution.Outcome == "brewer" && !shimmed.RoundParticipants.Any(p => p.RoundId == round.Id && p.PlayerId == resolution.BrewerId))
            throw new ResolveException("resolve_round_not_participant", "resolve_round: brewer is not a participant in this round");

        var writes = new List<Write>(shimWrites);
        writes.AddRange(Committer.Commit(resolution));

        // A plain tie commits no title; a roll-off and a Tea Maker do (_rr_apply_earl_title).
        if (resolution.Outcome != "tie" && OlderEarlTitles(shimmed, round, resolution) is { Count: > 0 } ended)
            writes.Add(new EndEarlTitles(round.Id, ended));

        if (resolution.Outcome == "brewer")
        {
            var replayPending = resolution.Derived.PendingReplayCaster is not null;
            var rolls = RollsJson(shimmed, round.Id, layer);
            var payload = new JsonObject
            {
                ["outcome"] = "brewer",
                ["layer"] = layer,
                ["brewer_id"] = resolution.BrewerId,
                ["cups_made"] = resolution.CupsMade,
                ["rolls"] = rolls,
                ["replay_pending"] = replayPending,
            };
            var revealed = new RoomEvent("round-revealed", new JsonObject
            {
                ["roundId"] = round.Id.ToString(),
                ["layer"] = layer,
                ["brewerId"] = resolution.BrewerId,
                ["cupsMade"] = resolution.CupsMade,
                ["rolls"] = BroadcastRolls(rolls),
            });
            return new Finalized(writes, replayPending ? [revealed, new RoomEvent("room-changed", [])] : [revealed], payload);
        }

        var tied = new JsonArray([.. resolution.TiedPlayerIds!.Select(p => (JsonNode?)p)]);
        return new Finalized(writes,
            [new RoomEvent("layer-tied", new JsonObject
            {
                ["roundId"] = round.Id.ToString(),
                ["layer"] = layer + 1,
                ["tiedPlayerIds"] = tied.DeepClone(),
            })],
            new JsonObject
            {
                ["outcome"] = "tie",
                ["layer"] = layer + 1,
                ["tied_player_ids"] = tied,
                ["rolloff"] = resolution.Outcome == "rolloff",
            });
    }

    private static bool IsDebtRound(RoundSnapshot s, RoundRow round) =>
        round.CurrentLayer == 0 && Rules.BrewDebtDue(new EvalContext(s, round, new NoDiceRoller())) is not null;

    private static Decision<JsonObject> Nothing(JsonObject payload) => new([], [], payload);

    private static Decision<JsonObject> AsDecision(Finalized f) => new(f.Writes, f.Events, f.Payload);

    private static JsonObject Noop(string reason) => new() { ["outcome"] = "noop", ["reason"] = reason };

    private RoomEvent LayerRollsRevealed(Guid roundId) => new("layer-rolls-revealed", new JsonObject
    {
        ["roundId"] = roundId.ToString(),
        ["layer"] = _layerRolls!["layer"]!.DeepClone(),
        ["rolls"] = BroadcastRolls(_layerRolls["rolls"]!.AsArray()),
    });

    private static JsonArray RollsJson(RoundSnapshot s, Guid roundId, int layer) =>
        [.. s.Rolls.Where(r => r.RoundId == roundId && r.Layer == layer)
            .OrderBy(r => r.PlayerId, StringComparer.Ordinal)
            .Select(r => (JsonNode?)new JsonObject
            {
                ["player_id"] = r.PlayerId,
                ["value"] = r.Value,
                ["discarded_value"] = r.DiscardedValue,
                ["entered_by_admin"] = r.EnteredByAdmin,
            })];

    private static JsonArray BroadcastRolls(JsonArray rolls) =>
        [.. rolls.Select(r => (JsonNode?)new JsonObject
        {
            ["playerId"] = r!["player_id"]!.DeepClone(),
            ["value"] = r["value"]!.DeepClone(),
            ["discardedValue"] = r["discarded_value"]?.DeepClone(),
            ["enteredByAdmin"] = r["entered_by_admin"]!.DeepClone(),
        })];

    /// <summary>One Earl (_rr_apply_earl_title): the open title rows older than the Earl this
    /// resolution leaves, so a later dispel of the new Earl can't hand the title back. Read
    /// as of the casts' final flags and any transfer, since either can change who that is.</summary>
    private static IReadOnlyList<Guid> OlderEarlTitles(RoundSnapshot s, RoundRow round, Resolution resolution)
    {
        var flags = resolution.Derived.CastFlags.ToDictionary(f => f.CastId);
        var effects = s.ActiveEffects.ToList();
        if (resolution.EarlTransfer is { } transfer
            && !effects.Any(e => e.SourceCastId == transfer.CastId && e.EffectKind == "brewer_immunity")
            && effects.FirstOrDefault(e => e.Id == transfer.ActiveEffectId) is { } old)
        {
            effects.Add(old with
            {
                Id = Ids.Deterministic($"rfb-earl-title:{transfer.CastId}:{transfer.ToPlayerId}"),
                TargetPlayerId = transfer.ToPlayerId,
                CasterId = transfer.ToPlayerId,
                SourceCastId = transfer.CastId,
                EffectParams = JsonSerializer.SerializeToElement(new { mode = "earl", persist = true }),
                RoundsRemaining = null,
                CreatedAt = s.DbNow,
                IsUndispellable = false,
                EndedInRoundId = null,
            });
        }

        var after = s with
        {
            ActiveEffects = effects,
            SpellCasts = [.. s.SpellCasts.Select(c => flags.TryGetValue(c.Id, out var f) ? c with { Negated = f.Negated } : c)],
        };

        static bool IsEarl(ActiveEffectRow e) => e.EffectKind == "brewer_immunity" && ActiveEffects.Param(e.EffectParams, "mode") == "earl";
        if (ActiveEffects.AsOf(after, round.RoomId, round.Id).FirstOrDefault(IsEarl) is not { } earl) return [];

        return [.. effects
            .Where(e => e.RoomId == round.RoomId && IsEarl(e) && e.EndedInRoundId is null && e.Id != earl.Id)
            .Where(e => e.CreatedAt < earl.CreatedAt || (e.CreatedAt == earl.CreatedAt && Jb.UuidOrder.Compare(e.Id, earl.Id) < 0))
            .Select(e => e.Id)];
    }
}
