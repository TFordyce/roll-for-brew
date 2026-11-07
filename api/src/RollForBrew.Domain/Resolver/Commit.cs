using System.Text.Json;
using RollForBrew.Domain.Liveness;
using RollForBrew.Domain.Snapshot;

namespace RollForBrew.Domain.Resolver;

public abstract record Write;

public sealed record InsertSpellCast(SpellCastRow Row) : Write;
public sealed record UpdateCastFlags(CastFlags Flags) : Write;
public sealed record SetRoomPlayerModifier(Guid RoomId, string PlayerId, int Value) : Write;
public sealed record SetRoundTraceAndSummary(Guid RoundId, string TraceJson, string SummaryJson) : Write;
public sealed record SetRoundResolution(Guid RoundId, string? BrewerId, int CupsMade, int BrewerModifierGain, DateTimeOffset ResolvedAt) : Write;
public sealed record IncrementRoomPlayerModifier(Guid RoomId, string PlayerId, int Delta) : Write;
public sealed record MoveHeistCard(Guid CastId, Guid InstanceId, string Location, string ThiefPlayerId, string VictimPlayerId) : Write;
public sealed record TransferEarlTitle(Guid RoundId, Guid FromEffectId, Guid ToEffectId, string FromPlayerId, string ToPlayerId, Guid CastId) : Write;
public sealed record SetBrewerSource(Guid RoundId, string Source, Guid? CastId) : Write;
public sealed record RecordPendingReplay(Guid RoundId, Guid RoomId, string CasterId) : Write;
public sealed record AdvanceTieLayer(Guid RoundId, IReadOnlyList<string> TiedPlayerIds) : Write;
public sealed record EndEarlTitles(Guid RoundId, IReadOnlyList<Guid> EffectIds) : Write;
public sealed record SetRollValue(Guid RoundId, int Layer, string PlayerId, int Value) : Write;
public sealed record SetCastRollTransform(Guid CastId, string RollTransformJson) : Write;

/// <summary>A still-SQL write, run in order with the rest (ADR 0012: bridges are data).</summary>
public sealed record Bridge(string Function, params object[] Args) : Write;

public static class Committer
{
    public static IReadOnlyList<Write> Commit(Resolution resolution)
    {
        var d = resolution.Derived;
        var writes = new List<Write>();

        foreach (var row in d.SynthesizedCasts.OrderBy(c => c.Seq))
            writes.Add(new InsertSpellCast(row));
        foreach (var flags in d.CastFlags)
            writes.Add(new UpdateCastFlags(flags));
        foreach (var (player, value) in d.RoomPlayerModifiers.OrderBy(kv => kv.Key, StringComparer.Ordinal))
            writes.Add(new SetRoomPlayerModifier(d.RoomId, player, value));

        if (resolution.Layer == 0)
            writes.Add(new SetRoundTraceAndSummary(
                d.RoundId,
                TraceJson.Pretty(TraceJson.ToNode(resolution.Trace)),
                TraceJson.Pretty(TraceJson.ToNode(resolution.Players ?? []))));

        if (resolution.EarlTransfer is { } earl && resolution.Outcome != "tie")
            writes.Add(new TransferEarlTitle(d.RoundId, earl.ActiveEffectId,
                Ids.Deterministic($"rfb-earl-title:{earl.CastId}:{earl.ToPlayerId}"),
                earl.FromPlayerId, earl.ToPlayerId, earl.CastId));

        if (resolution.Outcome == "brewer")
        {
            var gain = resolution.ModifierGain ?? resolution.CupsMade;
            writes.Add(new SetRoundResolution(d.RoundId, resolution.BrewerId, resolution.CupsMade, gain, d.DbNow));
            if (gain != 0 && resolution.BrewerId is not null)
                writes.Add(new IncrementRoomPlayerModifier(d.RoomId, resolution.BrewerId, gain));
            foreach (var move in d.HeistMoves)
                writes.Add(new MoveHeistCard(move.CastId, move.InstanceId, move.Location, move.ThiefPlayerId, move.VictimPlayerId));
            if (resolution.BrewerRecord is { } record)
                writes.Add(new SetBrewerSource(d.RoundId, record.Source, record.CastId));
            if (d.PendingReplayCaster is { } caster)
                writes.Add(new RecordPendingReplay(d.RoundId, d.RoomId, caster));
        }
        else if (resolution.TiedPlayerIds is { } tied)
        {
            writes.Add(new AdvanceTieLayer(d.RoundId, tied));
        }

        return writes;
    }

    /// <summary>One Earl (_rr_apply_earl_title): the open title rows older than the Earl this
    /// resolution leaves, so a later dispel of the new Earl can't hand the title back. Read
    /// as of the casts' final flags and any transfer, since either can change who that is.</summary>
    public static IReadOnlyList<Write> EndOlderEarlTitles(RoundSnapshot s, RoundRow round, Resolution resolution)
    {
        // A plain tie commits no title; a roll-off and a Tea Maker do (_rr_apply_earl_title).
        if (resolution.Outcome == "tie") return [];

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

        var ended = effects
            .Where(e => e.RoomId == round.RoomId && IsEarl(e) && e.EndedInRoundId is null && e.Id != earl.Id)
            .Where(e => e.CreatedAt < earl.CreatedAt || (e.CreatedAt == earl.CreatedAt && Jb.UuidOrder.Compare(e.Id, earl.Id) < 0))
            .Select(e => e.Id).ToList();
        return ended.Count > 0 ? [new EndEarlTitles(round.Id, ended)] : [];
    }
}
