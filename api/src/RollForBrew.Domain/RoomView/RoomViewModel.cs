using System.Text.Json;

namespace RollForBrew.Domain.RoomView;


public sealed record RoomViewResponse(long Version, RoomPart Room, ViewerPart Viewer);


public sealed record RoomPart(
    Guid RoomId,
    bool IsTest,
    IReadOnlyList<RosterEntry> Roster,
    ActiveRoundView? ActiveRound,
    IReadOnlyList<HistoryEntry> History,
    DateTimeOffset? NextStallDeadline,
    DateTimeOffset DbNow);

public sealed record RosterEntry(
    string PlayerId, string? DisplayName, string? Email, string? AvatarUrl, int Modifier, bool IsTest,
    IReadOnlyList<EffectBadge> EffectBadges);

public sealed record EffectBadge(Guid EffectId, string CardName, string Tier, string Polarity, int? RoundsRemaining);

public sealed record ParticipantView(
    string PlayerId, string? DisplayName, string? Email, string? AvatarUrl, int Modifier,
    DateTimeOffset DeclaredAt, DateTimeOffset? ExcludedAt, bool HasRolled);

public sealed record TiedParticipantView(
    string PlayerId, string? DisplayName, string? Email, string? AvatarUrl, int Modifier, DateTimeOffset? ExcludedAt, bool HasRolled);

public sealed record ActiveRoundView(
    Guid RoundId, string StartedBy, string Status, DateTimeOffset StartedAt, DateTimeOffset? ClosedAt,
    int CurrentLayer, bool IsTiePhase,
    IReadOnlyList<ParticipantView> Participants,
    IReadOnlyList<TiedParticipantView> TiedParticipants,
    IReadOnlyList<string> RolledPlayerIds);

public sealed record HistoryEntry(
    Guid RoundId, DateTimeOffset? ResolvedAt, int? CupsMade, string? BrewerId, string? BrewerName);


public sealed record ViewerPart(
    string PlayerId,
    bool HasDeclared,
    bool IsStarter,
    bool CanDeclare,
    bool CanWithdraw,
    bool CanClose,
    int NeedMoreToClose,
    bool CanDeclareLate,
    bool CanStartRound,
    bool IsTied,
    int? OwnRoll,
    int? LayerZeroOwnRoll,
    bool IsExpectedToRoll,
    bool IsPlayersTurnToRoll,
    bool NeedsRollInput,
    string? RollInputMode,
    Guid? OrderRoundId,
    string? MyOrderForRound,
    string? MyMostRecentOrder,
    bool OrderCue,
    IReadOnlyList<MenuEntryView> Menu,
    IReadOnlyList<ParticipantView> MenuParticipants,
    RateableRoundView? RateableRound,
    IReadOnlyList<HeldCard> HeldCards,
    HeldCard? HeldReactionCard,
    PendingSpellDrawView? PendingSpellDraw,
    IReadOnlyList<PendingCastRow> PendingCasts,
    IReadOnlyList<PendingDieRow> PendingSpellDice,
    string? SpellDieRollInputMode,
    CompelledCastView? CompelledCast,
    string? TeaPartyRevoltPickerId,
    IReadOnlyList<DispellableRow> DispellableEffects,
    IReadOnlyList<string> HeistTargetIds,
    LastDripPreviewRow? LastDripPreview,
    ReactionView? Reaction,
    PendingReplayView? PendingRoundReplay,
    Panels Panels);

public sealed record MenuEntryView(string PlayerId, string DrinkType, string? Milk, string? Sugar, bool Decaf, bool NoPreferenceSet);

public sealed record RateableRoundView(Guid RoundId, string? BrewerDisplayName, string? BrewerEmail, DateTimeOffset ResolvedAt, int? MyScore);

public sealed record PendingSpellDrawView(Guid RoundId, string Trigger, int OtherCount, IReadOnlyList<string> CatalogNames);

public sealed record CompelledCastView(
    CompelledCastRow? Mine,
    Guid RoundId,
    IReadOnlyList<string> WaitingOnOthers,
    DateTimeOffset? StepEndedAt);

public sealed record ReactionView(
    Guid WindowId, int Layer, int PollRound, bool Eligible, bool AlreadyPassed,
    IReadOnlyList<ReactionStackRow> Stack,
    IReadOnlyList<PendingPlayerRow> PendingPlayers,
    SkipVoteRow? SkipVote,
    IReadOnlyList<CourageTokenRow> CourageTokens,
    bool Compelled);

public sealed record PendingReplayView(Guid RoundId, string CasterId, string? CasterDisplayName, bool IsCaster, DateTimeOffset CreatedAt);

public sealed record Panels(
    bool BrewRating,
    bool Menu,
    bool SpellDrawChoice,
    bool RoundReplayPrompt,
    bool PendingSpellDie,
    bool CompelledCast,
    bool TeaPartyRevolt,
    bool SpellCards,
    bool TieBanner,
    bool RoundReveal,
    bool LateDeclare,
    bool WhosIn,
    bool RollInput,
    bool ReactionBanner,
    bool IdleRoom);
