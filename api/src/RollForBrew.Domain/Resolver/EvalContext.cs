using System.Text.Json;
using RollForBrew.Domain.Dice;
using RollForBrew.Domain.Liveness;
using RollForBrew.Domain.Snapshot;

namespace RollForBrew.Domain.Resolver;

/// <summary>A cast row the pipeline may change. SQL mutates spell_casts mid-evaluation and later phases read the mutation back; this is that table, privately.</summary>
internal sealed class WorkingCast
{
    public required Guid Id { get; init; }
    public required Guid RoundId { get; init; }
    public required string CasterId { get; init; }
    public required Guid CardInstanceId { get; init; }
    public string? TargetPlayerId { get; set; }
    public bool TargetPending { get; set; }
    public string? EffectKind { get; init; }
    public JsonElement? EffectParams { get; init; }
    public Guid? ParentCastId { get; init; }
    public DateTimeOffset CastAt { get; init; }
    public Guid? ReactionWindowId { get; init; }
    public bool Negated { get; set; }
    public long Seq { get; init; }
    public string? TargetRole { get; set; }
    public JsonElement? CastInputs { get; init; }
    public Guid? RedirectedToCastId { get; set; }
    public Guid? SeizedByCastId { get; set; }
    public Guid? CopiedCastId { get; set; }
    public int Generation { get; init; }
    public Guid? SourceCastId { get; init; }
    /// <summary>cast_inputs.seized_kept - the one cast_inputs key the pipeline writes, held as a flag.</summary>
    public bool SeizedKept { get; set; }
    public bool Synthesized { get; init; }

    /// <summary>Issue #439: a Courage Token spend shares its gift's card instance but is not part of that card's group.</summary>
    public bool IsCourageSpend => CastInputs.Has("courage_token_cast_id");

    public static WorkingCast From(SpellCastRow r) => new()
    {
        Id = r.Id, RoundId = r.RoundId, CasterId = r.CasterId, CardInstanceId = r.CardInstanceId,
        TargetPlayerId = r.TargetPlayerId, TargetPending = r.TargetPending, EffectKind = r.EffectKind,
        EffectParams = r.EffectParams, ParentCastId = r.ParentCastId, CastAt = r.CastAt,
        ReactionWindowId = r.ReactionWindowId, Negated = r.Negated, Seq = r.Seq, TargetRole = r.TargetRole,
        CastInputs = r.CastInputs, RedirectedToCastId = r.RedirectedToCastId, SeizedByCastId = r.SeizedByCastId,
        CopiedCastId = r.CopiedCastId, Generation = r.Generation, SourceCastId = r.SourceCastId,
        SeizedKept = r.CastInputs.Flag("seized_kept"),
    };

    public SpellCastRow ToRow() => new(
        Id, RoundId, CasterId, CardInstanceId, TargetPlayerId, TargetPending, EffectKind, EffectParams,
        ParentCastId, CastAt, ReactionWindowId, Negated, Seq, TargetRole, CastInputs, RedirectedToCastId,
        SeizedByCastId, CopiedCastId, Generation, SourceCastId);

    public CastFlags Flags() => new(Id, Negated, RedirectedToCastId, SeizedByCastId, CopiedCastId, TargetPlayerId, TargetRole, TargetPending);
}

/// <summary>An entry of Phase 2's ward map (SQL v_ward_map).</summary>
internal sealed record Ward(
    JsonElement? Domain, JsonElement? Polarity, bool BlockEarnedModifier, long? WardSeq, Guid WardCastId, string WardCardName);

/// <summary>A normalised Phase 4a effect element (SQL v_el).</summary>
internal sealed record ModEffect(
    long Ord, string Kind, Guid? CastId, Guid? ActiveEffectId, string? CardName, string? CasterPlayerId,
    string TargetPlayer, decimal? Flat, decimal? Mult, decimal? Set, bool Backfire, bool CourageToken);

/// <summary>
/// The private working copy of one layer-0 evaluation: the immutable snapshot plus every mutable thing the SQL
/// kept in plpgsql variables, temp tables and cache columns. A phase reads and writes this and nothing else.
/// </summary>
internal sealed class EvalContext
{
    public EvalContext(RoundSnapshot snapshot, RoundRow round, IDieRoller dice)
    {
        S = snapshot; Round = round; RoundId = round.Id; RoomId = round.RoomId; Gen = round.ReplayGeneration; Dice = dice;
        _instances = snapshot.DeckInstances.ToDictionary(d => d.Id);
        _cards = snapshot.SpellCards.ToDictionary(c => c.Id);
        AllCasts = snapshot.SpellCasts.Select(WorkingCast.From).ToDictionary(c => c.Id);
        Casts = AllCasts.Values.Where(c => c.RoundId == RoundId).OrderBy(c => c.Seq).ToList();
        _live = new Lazy<IReadOnlyList<ActiveEffectRow>>(() =>
            ActiveEffects.AsOf(snapshot, RoomId, RoundId).Where(e => e.RoomId == RoomId).ToList());
    }

    public RoundSnapshot S { get; }
    public RoundRow Round { get; }
    public Guid RoundId { get; }
    public Guid RoomId { get; }
    public int Gen { get; }
    public IDieRoller Dice { get; }

    // ---- the Cast Log, as SQL's spell_casts: every known cast by id, and this round's casts in seq order
    public Dictionary<Guid, WorkingCast> AllCasts { get; }
    public List<WorkingCast> Casts { get; }
    private long _nextSeq;
    public WorkingCast AddCast(Func<long, WorkingCast> make)
    {
        if (_nextSeq == 0) _nextSeq = AllCasts.Values.Select(c => c.Seq).DefaultIfEmpty(0).Max();
        var c = make(++_nextSeq);
        AllCasts[c.Id] = c;
        Casts.Add(c);
        return c;
    }

    // ---- catalog lookups
    private readonly Dictionary<Guid, DeckInstanceRow> _instances;
    private readonly Dictionary<Guid, SpellCardRow> _cards;
    public SpellCardRow? CardOfInstance(Guid instanceId) =>
        _instances.TryGetValue(instanceId, out var i) && _cards.TryGetValue(i.CardId, out var c) ? c : null;
    public SpellCardRow? CardOfCast(WorkingCast c) => CardOfInstance(c.CardInstanceId);
    public SpellCardRow? Card(Guid cardId) => _cards.GetValueOrDefault(cardId);

    // ---- live effects as of this round (liveness is a pure function of the snapshot, so computed once)
    private readonly Lazy<IReadOnlyList<ActiveEffectRow>> _live;
    public IReadOnlyList<ActiveEffectRow> LiveEffects => _live.Value;

    // ---- layer-0 per-player working arrays (SQL v_players ... v_dice_reduced), indexed together
    public List<string> Players { get; } = [];
    public List<int> Rolls { get; } = [];
    public List<decimal> Base { get; } = [];
    public List<decimal> Composed { get; } = [];
    public List<decimal> Snapshots { get; } = [];
    public List<bool> DiceReduced { get; } = [];
    public Dictionary<string, List<ModEffect>> Effects { get; } = [];

    // ---- phase-to-phase state
    public bool HasInvocations { get; set; }
    public bool HasCounters { get; set; }
    public List<ClrRow> ClrRows { get; set; } = [];
    public HashSet<Guid> NegatedGroups { get; } = [];
    /// <summary>SQL v_redirect_map: victim cast id -> new target player.</summary>
    public Dictionary<Guid, string> RedirectMap { get; } = [];
    public Dictionary<string, List<Ward>> WardMap { get; } = [];
    /// <summary>SQL v_skip_map: player -> (active effect, caster) of their earliest live targeting_skip.</summary>
    public Dictionary<string, (Guid AeId, string CasterId)> SkipMap { get; } = [];
    public Dictionary<string, int> RoomPlayerModifierWrites { get; } = [];

    // ---- the Trace being built; v_step_index is always Trace.Count
    public List<TraceStep> Trace { get; } = [];
    public TraceStep Emit(
        string kind, SourceCast source, string? target, TraceValue before, TraceValue after,
        params (string Key, object? Value)[] extras)
    {
        var step = TraceStep.Create(Trace.Count, kind, source, target, before, after, extras);
        Trace.Add(step);
        return step;
    }

    // ---- the Resolution Summary and the outcome, set by the closing phases
    public List<SummaryEntry> Summary { get; } = [];
    public string Outcome { get; set; } = "brewer";
    public string? BrewerId { get; set; }
    public string? BrewerSource { get; set; }
    public List<string>? TiedPlayers { get; set; }
    public int? ModifierGain { get; set; }
    public EarlTransfer? EarlTransfer { get; set; }
    public BrewerRecord? BrewerRecord { get; set; }

    public int ParticipantCount => S.RoundParticipants.Count(p => p.RoundId == RoundId);
    public int PlayerIndex(string player) => Players.IndexOf(player);
}
