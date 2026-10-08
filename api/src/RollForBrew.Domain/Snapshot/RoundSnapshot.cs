using System.Text.Json;

namespace RollForBrew.Domain.Snapshot;

/// <summary>
/// Everything the rules engine needs about one Room, loaded in one round trip and immutable afterwards.
/// Cross-room data is bounded to the Room's Participants: the rounds they took part in (the Participation
/// Clock), Carried Effect rows targeting them and those rows' source casts, and the dispel / Courage spend
/// casts that name those rows. Casts include negated ones (the liveness rules read the flag).
/// <see cref="DbNow"/> is the database clock at load time, so rules never read the wall clock.
/// </summary>
public sealed record RoundSnapshot(
    Guid RoomId,
    DateTimeOffset DbNow,
    IReadOnlyList<RoomRow> Rooms,
    IReadOnlyList<RoundRow> Rounds,
    IReadOnlyList<RoundParticipantRow> RoundParticipants,
    IReadOnlyList<RoundLayerParticipantRow> RoundLayerParticipants,
    IReadOnlyList<RollRow> Rolls,
    IReadOnlyList<SpellCastRow> SpellCasts,
    IReadOnlyList<ActiveEffectRow> ActiveEffects,
    IReadOnlyList<DeckInstanceRow> DeckInstances,
    IReadOnlyList<SpellCardRow> SpellCards,
    IReadOnlyList<SpellCardEffectRow> SpellCardEffects,
    IReadOnlyList<RoomPlayerRow> RoomPlayers,
    IReadOnlyList<ModifierAdjustmentRow> ModifierAdjustments)
{
    public static readonly JsonSerializerOptions Json = new()
    {
        PropertyNamingPolicy = JsonNamingPolicy.SnakeCaseLower,
        PropertyNameCaseInsensitive = true,
    };

    public static RoundSnapshot Parse(string json) =>
        JsonSerializer.Deserialize<RoundSnapshot>(json, Json) ?? throw new InvalidDataException("empty snapshot");

    public static RoundSnapshot Parse(JsonElement json) =>
        json.Deserialize<RoundSnapshot>(Json) ?? throw new InvalidDataException("empty snapshot");
}
