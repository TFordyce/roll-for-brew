using RollForBrew.Domain.Snapshot;

namespace RollForBrew.Domain.Resolver;

public abstract record Write;

public sealed record InsertSpellCast(SpellCastRow Row) : Write;
public sealed record UpdateCastFlags(CastFlags Flags) : Write;
public sealed record SetRoomPlayerModifier(Guid RoomId, string PlayerId, int Value) : Write;
public sealed record SetRoundTraceAndSummary(Guid RoundId, string TraceJson, string SummaryJson) : Write;
public sealed record SetRoundResolution(Guid RoundId, string? BrewerId, int CupsMade, int BrewerModifierGain, DateTimeOffset ResolvedAt) : Write;
public sealed record IncrementRoomPlayerModifier(Guid RoomId, string PlayerId, int Delta) : Write;
public sealed record MoveHeistCard(Guid CastId, Guid InstanceId, string Location, string ThiefPlayerId) : Write;
public sealed record TransferEarlTitle(Guid RoundId, Guid FromEffectId, Guid ToEffectId, string FromPlayerId, string ToPlayerId, Guid CastId) : Write;
public sealed record SetBrewerSource(Guid RoundId, string Source, Guid? CastId) : Write;
public sealed record RecordPendingReplay(Guid RoundId) : Write;
public sealed record AdvanceTieLayer(Guid RoundId, IReadOnlyList<string> TiedPlayerIds) : Write;

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

        if (resolution.Outcome == "brewer")
        {
            var gain = resolution.ModifierGain ?? resolution.CupsMade;
            writes.Add(new SetRoundResolution(d.RoundId, resolution.BrewerId, resolution.CupsMade, gain, d.DbNow));
            if (gain != 0 && resolution.BrewerId is not null)
                writes.Add(new IncrementRoomPlayerModifier(d.RoomId, resolution.BrewerId, gain));
            foreach (var move in d.HeistMoves)
                writes.Add(new MoveHeistCard(move.CastId, move.InstanceId, move.Location, move.ThiefPlayerId));
            if (resolution.EarlTransfer is { } earl)
                writes.Add(new TransferEarlTitle(d.RoundId, earl.ActiveEffectId, NewEarlEffectId(earl),
                    earl.FromPlayerId, earl.ToPlayerId, earl.CastId));
            if (resolution.BrewerRecord is { } record)
                writes.Add(new SetBrewerSource(d.RoundId, record.Source, record.CastId));
            writes.Add(new RecordPendingReplay(d.RoundId));
        }
        else
        {
            if (resolution.EarlTransfer is { } earl && resolution.Outcome == "rolloff")
                writes.Add(new TransferEarlTitle(d.RoundId, earl.ActiveEffectId, NewEarlEffectId(earl),
                    earl.FromPlayerId, earl.ToPlayerId, earl.CastId));
            if (resolution.TiedPlayerIds is { } tied)
                writes.Add(new AdvanceTieLayer(d.RoundId, tied));
        }

        return writes;
    }

    private static Guid NewEarlEffectId(EarlTransfer earl) =>
        new(System.Security.Cryptography.MD5.HashData(
            System.Text.Encoding.UTF8.GetBytes($"rfb-earl-title:{earl.CastId}:{earl.ToPlayerId}")));
}
