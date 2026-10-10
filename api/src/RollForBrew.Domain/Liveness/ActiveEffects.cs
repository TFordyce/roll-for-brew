using System.Text.Json;
using RollForBrew.Domain.Snapshot;

namespace RollForBrew.Domain.Liveness;

public static class ActiveEffects
{
    public static IReadOnlyList<ActiveEffectRow> AsOf(RoundSnapshot s, Guid roomId, Guid asOfRoundId)
    {
        var rounds = s.Rounds.ToDictionary(r => r.Id);
        var rooms = s.Rooms.ToDictionary(r => r.Id);
        var casts = s.SpellCasts.ToDictionary(c => c.Id);
        var participants = s.RoundParticipants
            .GroupBy(p => p.PlayerId)
            .ToDictionary(g => g.Key, g => g.Select(p => p.RoundId).ToHashSet());

        var asOfRound = rounds[asOfRoundId];
        var asOfStarted = asOfRound.StartedAt;
        var asOfIsTest = rooms[asOfRound.RoomId].IsTest;
        var kindIsTest = rooms[roomId].IsTest;

        int Elapsed(string player, DateTimeOffset? source, DateTimeOffset? asOf)
        {
            if (source is null || !participants.TryGetValue(player, out var mine)) return 0;
            return s.Rounds.Count(r =>
                mine.Contains(r.Id)
                && rooms[r.RoomId].IsTest == kindIsTest
                && r.Status == "resolved"
                && r.StartedAt >= source
                && (asOf is null || r.StartedAt < asOf));
        }

        var live = new List<ActiveEffectRow>();
        foreach (var sae in s.ActiveEffects)
        {
            if (!casts.TryGetValue(sae.SourceCastId, out var src)) continue;
            if (!rounds.TryGetValue(src.RoundId, out var srcRound)) continue;

            var after = Param(sae.EffectParams, "participated_rounds_after_cast");
            var from = Param(sae.EffectParams, "participated_rounds_from_cast");

            var inRoom = sae.RoomId == roomId
                || ((sae.RoundsRemaining is not null || after is not null || from is not null)
                    && srcRound.StartedAt < asOfStarted
                    && rooms.TryGetValue(sae.RoomId, out var effRoom) && effRoom.IsTest == asOfIsTest);
            if (!inRoom) continue;

            if (src.Negated) continue;
            if (Param(src.CastInputs, "consumed_by_round") is not null) continue;
            if (Param(src.CastInputs, "consumed_by_draw") is not null) continue;

            if (sae.RoundsRemaining is { } remaining
                && Elapsed(sae.TargetPlayerId, srcRound.StartedAt, asOfStarted) >= remaining) continue;

            if (after is not null)
            {
                DateTimeOffset? firstAfter = s.Rounds
                    .Where(nr => rooms[nr.RoomId].IsTest == asOfIsTest && nr.StartedAt > srcRound.StartedAt)
                    .Select(nr => (DateTimeOffset?)nr.StartedAt)
                    .Min();
                if (Elapsed(sae.TargetPlayerId, firstAfter, asOfStarted) >= int.Parse(after)) continue;
            }

            if (from is not null
                && Elapsed(sae.TargetPlayerId, srcRound.StartedAt, asOfStarted) >= int.Parse(from)) continue;

            if (sae.EffectKind == "courage_token"
                && s.SpellCasts.Any(sp =>
                    Param(sp.CastInputs, "courage_token_cast_id") == sae.SourceCastId.ToString()
                    && !sp.Negated
                    && rounds.TryGetValue(sp.RoundId, out var spr) && spr.StartedAt <= asOfStarted)) continue;

            var id = sae.Id.ToString();
            if (!sae.IsUndispellable
                && s.SpellCasts.Any(dc =>
                    dc.EffectKind == "dispel"
                    && Param(dc.EffectParams, "ended_effect_id") == id
                    && !dc.Negated
                    && rounds.TryGetValue(dc.RoundId, out var dr) && dr.StartedAt <= asOfStarted)) continue;

            if (sae.EndedInRoundId is { } endedId
                && rounds.TryGetValue(endedId, out var ended) && ended.StartedAt <= asOfStarted) continue;

            live.Add(sae);
        }

        static bool IsEarl(ActiveEffectRow e) => e.EffectKind == "brewer_immunity" && Param(e.EffectParams, "mode") == "earl";
        static bool Newer(ActiveEffectRow a, ActiveEffectRow b) =>
            a.CreatedAt != b.CreatedAt ? a.CreatedAt > b.CreatedAt
            : string.CompareOrdinal(a.Id.ToString("N"), b.Id.ToString("N")) > 0;

        return live
            .Where(l => !(IsEarl(l) && live.Any(n =>
                IsEarl(n) && Newer(n, l)
                && rounds[casts[n.SourceCastId].RoundId].StartedAt <= asOfStarted)))
            .Select(l => l with { RoomId = roomId })
            .OrderBy(l => l.CreatedAt).ThenBy(l => l.Id.ToString("N"), StringComparer.Ordinal)
            .ToList();
    }

    public static string? Param(JsonElement? obj, string key)
    {
        if (obj is not { ValueKind: JsonValueKind.Object } o || !o.TryGetProperty(key, out var v)) return null;
        return v.ValueKind switch
        {
            JsonValueKind.Null or JsonValueKind.Undefined => null,
            JsonValueKind.String => v.GetString(),
            _ => v.GetRawText(),
        };
    }
}
