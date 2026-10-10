using RollForBrew.Domain.Snapshot;

namespace RollForBrew.Domain.Resolver;

public sealed record Resolution(
    string Outcome,
    int Layer,
    string? BrewerId,
    string? BrewerSource,
    IReadOnlyList<string>? TiedPlayerIds,
    int CupsMade,
    int? ModifierGain,
    bool NoModifierGain,
    EarlTransfer? EarlTransfer,
    BrewerRecord? BrewerRecord,
    IReadOnlyList<TraceStep> Trace,
    IReadOnlyList<SummaryEntry>? Players,
    DerivedCastState Derived);

public sealed record EarlTransfer(Guid ActiveEffectId, string FromPlayerId, string ToPlayerId, Guid CastId);

public sealed record BrewerRecord(string Source, Guid CastId);

public sealed record SummaryEntry(
    string PlayerId, int Roll, decimal Snapshot, decimal Composed, decimal Total, string? Nat, bool DiceReduced);

public sealed record HeistMove(Guid CastId, Guid InstanceId, string Location, string ThiefPlayerId);

public sealed record DerivedCastState(
    IReadOnlyList<CastFlags> CastFlags,
    IReadOnlyList<SpellCastRow> SynthesizedCasts,
    IReadOnlyDictionary<string, int> RoomPlayerModifiers,
    Guid RoomId,
    Guid RoundId,
    DateTimeOffset DbNow,
    IReadOnlyList<HeistMove> HeistMoves)
{
    public static readonly DerivedCastState Empty = new([], [], new Dictionary<string, int>(), Guid.Empty, Guid.Empty, DateTimeOffset.MinValue, []);
}

public sealed record CastFlags(
    Guid CastId, bool Negated, Guid? RedirectedToCastId, Guid? SeizedByCastId, Guid? CopiedCastId,
    string? TargetPlayerId, string? TargetRole, bool TargetPending);

public sealed class ResolveException(string code, string message) : Exception(message)
{
    public string Code { get; } = code;
    public static ResolveException RoundNotFound() => new("resolve_round_not_found", "resolve_round: round not found");
    public static ResolveException NotAllRolled() => new("resolve_round_not_all_rolled", "resolve_round: not all participants have rolled yet");
}

public sealed class PhasePendingException(string phaseId, string reason)
    : Exception($"phase {phaseId} not ported yet: {reason}")
{
    public string PhaseId { get; } = phaseId;
}
