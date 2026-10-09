using System.Text.Json;

namespace RollForBrew.Domain.RoomView;

// The wire contract of GET /rooms/{id}/view (camelCase JSON). Additive only: new members may appear,
// existing ones never change meaning. Secrecy lives in RoomViewProjector: nothing here is filled from
// data the viewer may not see.

public sealed record RoomViewResponse(long Version, RoomPart Room, ViewerPart Viewer);

// ---------------------------------------------------------------- room (the same for every viewer)

public sealed record RoomPart(
    Guid RoomId,
    bool IsTest,
    IReadOnlyList<RosterEntry> Roster,
    ActiveRoundView? ActiveRound,
    /// <summary>Resolved rounds of this Room, newest first.</summary>
    IReadOnlyList<HistoryEntry> History,
    /// <summary>The earliest instant a stall rule could fire, strictly after the database clock; null when no clock is running.</summary>
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
    /// <summary>The tied players rerolling the current layer (empty outside a tie phase).</summary>
    IReadOnlyList<TiedParticipantView> TiedParticipants,
    /// <summary>Who has rolled the current layer. Values are never included: rolls stay hidden until resolved.</summary>
    IReadOnlyList<string> RolledPlayerIds);

public sealed record HistoryEntry(
    Guid RoundId, DateTimeOffset? ResolvedAt, int? CupsMade, string? BrewerId, string? BrewerName);

// ---------------------------------------------------------------- viewer (the effective player's screen)

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
    /// <summary>The viewer's own roll for the current layer; null if none yet. Only ever the viewer's own.</summary>
    int? OwnRoll,
    /// <summary>The viewer's own layer-0 roll.</summary>
    int? LayerZeroOwnRoll,
    bool IsExpectedToRoll,
    bool IsPlayersTurnToRoll,
    bool NeedsRollInput,
    string? RollInputMode,
    Guid? OrderRoundId,
    /// <summary>The viewer's Order for the order round; null if none placed yet.</summary>
    string? MyOrderForRound,
    /// <summary>The sticky default drink (most recent Order anywhere), only when MyOrderForRound is null.</summary>
    string? MyMostRecentOrder,
    /// <summary>Show the "don't forget your Order" cue.</summary>
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
    /// <summary>The viewer's outstanding compelled card; null when the viewer owes nothing.</summary>
    CompelledCastRow? Mine,
    Guid RoundId,
    /// <summary>Other players the Compelled Cast step is still waiting on.</summary>
    IReadOnlyList<string> WaitingOnOthers,
    DateTimeOffset? StepEndedAt);

public sealed record ReactionView(
    Guid WindowId, int Layer, int PollRound, bool Eligible, bool AlreadyPassed,
    IReadOnlyList<ReactionStackRow> Stack,
    IReadOnlyList<PendingPlayerRow> PendingPlayers,
    SkipVoteRow? SkipVote,
    IReadOnlyList<CourageTokenRow> CourageTokens,
    /// <summary>True when the viewer is compelled to cast a Reaction card (Brewmageddon).</summary>
    bool Compelled);

public sealed record PendingReplayView(Guid RoundId, string CasterId, string? CasterDisplayName, bool IsCaster, DateTimeOffset CreatedAt);

/// <summary>Which of the room page's panels render for this viewer right now.</summary>
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
