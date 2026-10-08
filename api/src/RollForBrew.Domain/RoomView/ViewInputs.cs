using RollForBrew.Domain.Snapshot;

namespace RollForBrew.Domain.RoomView;

// Everything the projection reads that the RoundSnapshot does not hold. All JSON-parsed with
// RoundSnapshot.Json (snake_case), so the loader hands SQL rows through unchanged.

public sealed record PlayerInfo(string Id, string? DisplayName, string? Email, string? AvatarUrl, bool IsTest);

public sealed record MenuRow(string PlayerId, string DrinkType, string? Milk, string? Sugar, bool Decaf, bool NoPreferenceSet);

public sealed record RateableRoundRow(Guid RoundId, string? BrewerDisplayName, string? BrewerEmail, DateTimeOffset ResolvedAt, int? MyScore);

public sealed record PendingReplayRow(Guid RoundId, string CasterId, DateTimeOffset CreatedAt);

/// <summary>Direct table / view reads for the viewer and the Room (not in the snapshot, not bridged SQL functions).</summary>
public sealed record ViewExtras(
    IReadOnlyList<PlayerInfo> Players,
    string? MyOrderForRound,
    string? MyMostRecentOrder,
    IReadOnlyList<MenuRow> Menu,
    RateableRoundRow? Rateable,
    string? RollInputMode,
    PendingReplayRow? PendingReplay);

// ---- Read bridges: still-SQL read functions, called as the effective player (docs/port/room-view-bridges.md). ----

public sealed record HeldCard(Guid InstanceId, string Location, string CardName, string CastingTime, string Target,
    string Tier, string EffectText, string? EffectKind, string Edition);

public sealed record PendingSpellDrawRow(Guid RoundId, string Trigger, int OtherCount);
public sealed record PendingCastRow(Guid CastId, string CardName, string Target);
public sealed record PendingDieRow(Guid CastId, string CardName, string Dice);
public sealed record CompelledCastRow(string CastingTime, string CardName, string BrewmageddonCasterId);
public sealed record CompelledStepRow(IReadOnlyList<string>? WaitingOn, DateTimeOffset? EndedAt);
public sealed record DispellableRow(Guid EffectId, string TargetPlayerId, string TargetDisplayName, string CardName, string Tier);
public sealed record PassedOverRow(string PlayerId, string Reason);
public sealed record LastDripPreviewRow(string? TargetPlayerId, string? Reason, IReadOnlyList<PassedOverRow>? PassedOver);
public sealed record ReactionWindowRow(Guid WindowId, int Layer, int PollRound, bool Eligible, bool AlreadyPassed);
public sealed record ReactionStackRow(Guid CastId, string CardName, string CasterId, string CasterName, string TargetStamp,
    bool Negated, Guid? ParentCastId, long Seq);
public sealed record PendingPlayerRow(string PlayerId, string DisplayName);
public sealed record SkipVoteRow(DateTimeOffset PollRoundStartedAt, int Votes, int Threshold, bool HasVoted, bool CanVote, bool WaitedOn);
public sealed record CourageTokenRow(Guid EffectId, string GiverPlayerId, string GiverDisplayName, string Dice);
public sealed record EffectBadgeRow(Guid EffectId, string TargetPlayerId, string CardName, string Tier, string? Polarity, int? RoundsRemaining);

/// <summary>Results of the read bridges. Every list is empty / null when the function had nothing to say.</summary>
public sealed record ViewerReads(
    IReadOnlyList<HeldCard> HeldCards,
    PendingSpellDrawRow? PendingSpellDraw,
    IReadOnlyList<PendingCastRow> PendingCasts,
    IReadOnlyList<PendingDieRow> PendingDice,
    CompelledCastRow? CompelledCast,
    CompelledStepRow? CompelledStep,
    string? RevoltPickerId,
    IReadOnlyList<DispellableRow> Dispellable,
    IReadOnlyList<string> HeistTargetIds,
    LastDripPreviewRow? LastDripPreview,
    ReactionWindowRow? ReactionWindow,
    IReadOnlyList<ReactionStackRow> ReactionStack,
    IReadOnlyList<PendingPlayerRow> ReactionPendingPlayers,
    SkipVoteRow? SkipVote,
    IReadOnlyList<CourageTokenRow> CourageTokens,
    IReadOnlyList<string> ExpectedRollerIds,
    DateTimeOffset? LayerZeroWindowClosedAt,
    IReadOnlyList<EffectBadgeRow> EffectBadges)
{
    public static ViewerReads Empty { get; } = new([], null, [], [], null, null, null, [], [], null, null, [], [], null, [], [], null, []);
}

public sealed record RoomViewInput(
    RoundSnapshot Snapshot,
    long Version,
    string ViewerId,
    ViewExtras Extras,
    ViewerReads Reads);
