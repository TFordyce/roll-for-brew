namespace RollForBrew.Domain.RoomView;

/// <summary>What the stall clocks read. All instants are database time.</summary>
public sealed record StallClockInput(
    DateTimeOffset DbNow,
    string? RoundStatus,
    DateTimeOffset? RoundStartedAt,
    DateTimeOffset? RoundClosedAt,
    int CurrentLayer,
    /// <summary>Earliest round_layer_participants.entered_at of the current layer (layer above 0).</summary>
    DateTimeOffset? LayerEnteredAt,
    /// <summary>Brewmageddon's Compelled Cast step still holds rolling (layer 0).</summary>
    bool CompelledStepWaiting,
    DateTimeOffset? CompelledStepEndedAt,
    DateTimeOffset? LayerZeroWindowClosedAt,
    /// <summary>Start of the latest reaction poll round, while a window is open.</summary>
    DateTimeOffset? SkipVotePollStartedAt,
    /// <summary>When the room's pending Round Replay decision was recorded.</summary>
    DateTimeOffset? PendingReplayCreatedAt);

/// <summary>
/// The next instant a stall rule could fire (mirrors src/app/rounds/stallEnforcement.ts and the 5-minute
/// clock of src/lib/game/stallTimeout.ts). Pure: the clock is an input, never read here.
/// Clocks, by phase:
///  - open round: started_at.
///  - closed, layer 0, Compelled Cast step holding: closed_at.
///  - closed, layer 0: the later of (step end, else closed_at) and the layer-0 window close.
///  - closed, layer above 0: when the layer became current.
///  - closed with an open Reaction Window: the poll round start (the Skip vote backstop).
///  - a pending Round Replay decision: when it was recorded.
/// Returns the earliest deadline strictly after <see cref="StallClockInput.DbNow"/>. A deadline already
/// past is the server's to enforce (it does so on the next view) and is not offered back to the client,
/// which would otherwise refetch in a loop. Firing early is harmless (the view is simply unchanged);
/// firing late is not, so a clock that might not apply (everyone rolled) is still offered.
/// </summary>
public static class StallDeadline
{
    public static readonly TimeSpan Timeout = TimeSpan.FromMinutes(5);

    public static DateTimeOffset? Next(StallClockInput i)
    {
        var candidates = new List<DateTimeOffset>();

        switch (i.RoundStatus)
        {
            case "open":
                if (i.RoundStartedAt is { } started) candidates.Add(started + Timeout);
                break;
            case "closed":
                var layerStart = LayerStart(i);
                if (layerStart is { } ls) candidates.Add(ls + Timeout);
                if (i.CurrentLayer == 0 && i.SkipVotePollStartedAt is { } poll) candidates.Add(poll + Timeout);
                break;
        }
        if (i.PendingReplayCreatedAt is { } replay) candidates.Add(replay + Timeout);

        var future = candidates.Where(c => c > i.DbNow).ToList();
        return future.Count == 0 ? null : future.Min();
    }

    private static DateTimeOffset? LayerStart(StallClockInput i)
    {
        if (i.CurrentLayer > 0) return i.LayerEnteredAt;
        if (i.CompelledStepWaiting) return i.RoundClosedAt;
        var rollingOpened = i.CompelledStepEndedAt ?? i.RoundClosedAt;
        if (rollingOpened is null) return i.LayerZeroWindowClosedAt;
        if (i.LayerZeroWindowClosedAt is null) return rollingOpened;
        return rollingOpened > i.LayerZeroWindowClosedAt ? rollingOpened : i.LayerZeroWindowClosedAt;
    }
}
