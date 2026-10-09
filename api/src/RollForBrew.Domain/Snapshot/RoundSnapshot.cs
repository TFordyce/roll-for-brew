using System.Text.Json;

namespace RollForBrew.Domain.Snapshot;

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
