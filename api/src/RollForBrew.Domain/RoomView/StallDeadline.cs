namespace RollForBrew.Domain.RoomView;

public sealed record StallClockInput(
    DateTimeOffset DbNow,
    string? RoundStatus,
    DateTimeOffset? RoundStartedAt,
    DateTimeOffset? RoundClosedAt,
    int CurrentLayer,
    DateTimeOffset? LayerEnteredAt,
    bool CompelledStepWaiting,
    DateTimeOffset? CompelledStepEndedAt,
    DateTimeOffset? LayerZeroWindowClosedAt,
    DateTimeOffset? SkipVotePollStartedAt,
    DateTimeOffset? PendingReplayCreatedAt);

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
