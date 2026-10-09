using RollForBrew.Domain.Snapshot;

namespace RollForBrew.Domain.Resolver;

/// <summary>
/// The pure result of <see cref="Evaluator.Evaluate(RoundSnapshot, Dice.IDieRoller)"/> (ADR 0010): the Outcome,
/// the Resolution Trace, the layer-0 Resolution Summary and the derived cast state Commit will persist.
/// Field-for-field the jsonb object <c>_rr_resolve_eval</c> returns.
/// </summary>
public sealed record Resolution(
    string Outcome,                       // "brewer" | "tie" | "rolloff"
    int Layer,
    string? BrewerId,
    string? BrewerSource,                 // "default" | "declared_number" | "tea_maker_override:<mode>" | "brew_debt" | null
    IReadOnlyList<string>? TiedPlayerIds,
    int CupsMade,
    int? ModifierGain,                    // null = cups_made, 0 = none, else as given (#425)
    bool NoModifierGain,                  // compat alias: ModifierGain == 0
    EarlTransfer? EarlTransfer,
    BrewerRecord? BrewerRecord,
    IReadOnlyList<TraceStep> Trace,       // empty on a tie layer (layer > 0)
    IReadOnlyList<SummaryEntry>? Players, // null on a tie layer
    DerivedCastState Derived);

public sealed record EarlTransfer(Guid ActiveEffectId, string FromPlayerId, string ToPlayerId, Guid CastId);

public sealed record BrewerRecord(string Source, Guid CastId);

/// <summary>One layer-0 roller's final values (ADR 0007). jsonb keys: player_id, roll, snapshot, composed, total, nat, dice_reduced.</summary>
public sealed record SummaryEntry(
    string PlayerId, int Roll, decimal Snapshot, decimal Composed, decimal Total, string? Nat, bool DiceReduced);

/// <summary>
/// What <c>_rr_resolve_eval</c> writes back into the Cast Log / room caches as a side effect, as pure data for
/// Commit: flag changes on this round's casts, rows the pipeline synthesised (Apprentice copies, ticks), and the
/// room_players.modifier cache writes of Phase 4b. Empty for a tie layer.
/// </summary>
public sealed record DerivedCastState(
    IReadOnlyList<CastFlags> CastFlags,
    IReadOnlyList<SpellCastRow> SynthesizedCasts,
    IReadOnlyDictionary<string, int> RoomPlayerModifiers)
{
    public static readonly DerivedCastState Empty = new([], [], new Dictionary<string, int>());
}

/// <summary>The derived columns of one existing cast after evaluation (only casts that differ from the snapshot are listed).</summary>
public sealed record CastFlags(
    Guid CastId, bool Negated, Guid? RedirectedToCastId, Guid? SeizedByCastId, Guid? CopiedCastId,
    string? TargetPlayerId, string? TargetRole, bool TargetPending);

/// <summary>A tea-maker/phase rule raised an error the SQL raises as a plain exception; codes are new, never an RFBnn.</summary>
public sealed class ResolveException(string code, string message) : Exception(message)
{
    public string Code { get; } = code;
    public static ResolveException RoundNotFound() => new("resolve_round_not_found", "resolve_round: round not found");
    public static ResolveException NotAllRolled() => new("resolve_round_not_all_rolled", "resolve_round: not all participants have rolled yet");
}

/// <summary>
/// Thrown by a phase (or part of a phase) a later port ticket still owns, when the snapshot actually exercises it.
/// The golden harness turns it into a named "pending" scenario; production never ships with one reachable.
/// </summary>
public sealed class PhasePendingException(string phaseId, string reason)
    : Exception($"phase {phaseId} not ported yet: {reason}")
{
    public string PhaseId { get; } = phaseId;
}
