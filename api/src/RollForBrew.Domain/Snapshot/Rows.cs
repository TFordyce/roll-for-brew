using System.Text.Json;

namespace RollForBrew.Domain.Snapshot;

// Row shapes of the RoundSnapshot. Property names map to the snake_case column names, so a snapshot is
// the same JSON whether Postgres (to_jsonb) or the TS fixture emitter produced it. Only columns the rules
// engine reads are modelled; unknown columns are ignored on read.

/// <summary>Version is rooms.version (0160); absent in pre-0160 fixtures, so it defaults to 0.</summary>
public sealed record RoomRow(Guid Id, bool IsTest, long Version = 0);

public sealed record RoundRow(
    Guid Id, Guid RoomId, string StartedBy, string Status, DateTimeOffset StartedAt,
    DateTimeOffset? ResolvedAt, DateTimeOffset? ClosedAt, string? BrewerId, int? CupsMade,
    int CurrentLayer, int BrewerModifierGain, int ReplayGeneration,
    IReadOnlyList<string> ReplayFrozenRollers, string? BrewerSource, Guid? BrewerSourceCastId,
    JsonElement? ScrappedGenerations);

public sealed record RoundParticipantRow(Guid RoundId, string PlayerId, DateTimeOffset DeclaredAt, DateTimeOffset? ExcludedAt);

public sealed record RoundLayerParticipantRow(Guid RoundId, int Layer, string PlayerId, DateTimeOffset EnteredAt, DateTimeOffset? ExcludedAt);

public sealed record RollRow(
    Guid RoundId, string PlayerId, int Layer, int Value, string InputMode, int ModifierSnapshot,
    DateTimeOffset RolledAt, int? DiscardedValue, bool EnteredByAdmin, int Generation);

public sealed record SpellCastRow(
    Guid Id, Guid RoundId, string CasterId, Guid CardInstanceId, string? TargetPlayerId, bool TargetPending,
    string? EffectKind, JsonElement? EffectParams, Guid? ParentCastId, DateTimeOffset CastAt,
    Guid? ReactionWindowId, bool Negated, long Seq, string? TargetRole, JsonElement? CastInputs,
    Guid? RedirectedToCastId, Guid? SeizedByCastId, Guid? CopiedCastId, int Generation, Guid? SourceCastId);

public sealed record ActiveEffectRow(
    Guid Id, Guid RoomId, string TargetPlayerId, string CasterId, Guid SourceCastId, Guid CardId,
    string EffectKind, JsonElement EffectParams, int? RoundsRemaining, DateTimeOffset CreatedAt,
    bool IsUndispellable, Guid? EndedInRoundId);

public sealed record DeckInstanceRow(Guid Id, Guid CardId, string Location, string? HeldByPlayer);

public sealed record SpellCardRow(
    Guid Id, string Name, string CastingTime, string Target, string Tier, string EffectText,
    int? DurationRounds, string? Polarity);

public sealed record SpellCardEffectRow(Guid Id, Guid CardId, string TargetRole, string EffectKind, JsonElement EffectParams, int Ordinal);

public sealed record RoomPlayerRow(Guid RoomId, string PlayerId, int Modifier);

public sealed record ModifierAdjustmentRow(Guid Id, Guid RoomId, string TargetPlayerId, string ActorPlayerId, int Delta, string Reason, DateTimeOffset CreatedAt);
