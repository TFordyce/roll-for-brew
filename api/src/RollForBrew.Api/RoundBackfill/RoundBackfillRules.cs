using Npgsql;
using RollForBrew.Api.Auth;
using RollForBrew.Api.Data;
using RollForBrew.Api.Problems;
using RollForBrew.Domain.Commands;
using RollForBrew.Domain.Resolver;

namespace RollForBrew.Api.RoundBackfill;

public sealed record BackfillEntry(string? PlayerId, int? Value);

public sealed record BackfillRequest(IReadOnlyList<string>? ParticipantIds, IReadOnlyList<IReadOnlyList<BackfillEntry>>? Layers);

public sealed record BackfillResponse(Guid RoundId);

/// <summary>
/// An admin bulk-records a whole same-day round played with physical dice: admin_backfill_round.
/// No spells and no Evaluate, so it leaves no Trace. Each message matches SQL's, because the
/// form shows it. Any failure rolls the whole transaction back, today's room included.
/// </summary>
public static class RoundBackfillRules
{
    private const string Prefix = "admin_backfill_round: ";

    private static ProblemException Problem(string sqlState, string message) =>
        ProblemException.FromInfo(ProblemCatalog.FromSqlState(sqlState)!, Prefix + message);

    /// <summary>Only an empty roster reaches this: it passes the roster checks with nothing to
    /// match, so the rolls it names belong to nobody in the round.</summary>
    private static ProblemException NotInRound(string message) =>
        new("backfill_not_resolvable", ProblemClass.Rule, "Those rolls do not belong to the round's participants.", message);

    public static Task<Guid> Run(RoomStore store, Caller caller, BackfillRequest request, CancellationToken ct = default) =>
        store.Filler(caller, async s =>
        {
            var admin = await s.CurrentPlayerId(ct: ct);
            if (!await IsAdmin(s, admin, ct)) throw Problem("RFB33", "caller is not an admin");

            var roster = request.ParticipantIds;
            // An empty roster is let through on purpose: SQL's array_length is null there.
            if (roster is null || roster.Count == 1) throw Problem("RFB34", "at least 2 participants required");
            var layers = request.Layers ?? [];
            if (layers.Count < 1) throw Problem("RFB35", "at least one layer of rolls is required");

            var roomId = await TodaysRoom(s, ct);
            if (await HasLiveRound(s, roomId, ct)) throw Problem("RFB36", "another round is already in progress in today's room");

            await AddToRoom(s, roomId, roster, ct);
            var roundId = await InsertRound(s, roomId, admin, roster, ct);
            var modifiers = await Modifiers(s, roomId, ct);
            var at = await Now(s, ct);

            IReadOnlyList<string> expected = roster;
            for (var i = 0; i < layers.Count; i++)
            {
                var rolls = await InsertLayer(s, roundId, i, layers[i], expected, modifiers, ct);
                var lowest = BackfillLayer.Lowest(rolls);

                if (lowest.Count == 1)
                {
                    if (i != layers.Count - 1)
                        throw Problem("RFB39", $"round already resolved at layer {i} — no further layers expected");
                    if (!roster.Contains(lowest[0]))
                        throw NotInRound("resolve_round: brewer is not a participant in this round");

                    await WritePersister.Apply(s, new SetRoundResolution(roundId, lowest[0], roster.Count, roster.Count, at), ct);
                    await WritePersister.Apply(s, new IncrementRoomPlayerModifier(roomId, lowest[0], roster.Count), ct);
                }
                else
                {
                    if (i == layers.Count - 1)
                        throw Problem("RFB40", $"layer {i} is still tied — a further layer is required");
                    if (lowest.FirstOrDefault(p => !roster.Contains(p)) is { } stranger)
                        throw NotInRound($"advance_round_layer: {stranger} did not roll in the current layer");

                    await WritePersister.Apply(s, new AdvanceTieLayer(roundId, lowest), ct);
                    expected = lowest;
                }
            }

            await s.BumpAndAnnounce(roomId, ct);
            return roundId;
        }, ct);

    private static async Task<List<BackfillRoll>> InsertLayer(
        StoreSession s, Guid roundId, int layer, IReadOnlyList<BackfillEntry> entries, IReadOnlyList<string> expected,
        IReadOnlyDictionary<string, int> modifiers, CancellationToken ct)
    {
        // The same comparisons SQL makes: an empty roster expects nothing and so checks nothing,
        // and a null player compares as unknown, which never counts as missing.
        if (entries.Count == 0 || (expected.Count > 0 && entries.Count != expected.Count))
            throw Problem("RFB37", $"layer {layer} must have exactly the expected tied roster");
        if (expected.FirstOrDefault(e => entries.All(g => g.PlayerId is not null && g.PlayerId != e)) is { } missing)
            throw Problem("RFB37", $"layer {layer} is missing a roll for {missing}");

        var rolls = new List<BackfillRoll>();
        foreach (var entry in entries)
        {
            if (entry.Value is not (>= 1 and <= 20) || entry.Value is not { } value)
                throw Problem("RFB38", $"roll value for {entry.PlayerId} must be between 1 and 20");

            var modifier = entry.PlayerId is { } id ? modifiers.GetValueOrDefault(id) : 0;
            await using var cmd = new NpgsqlCommand("""
                insert into public.rolls (round_id, player_id, layer, value, input_mode, modifier_snapshot, entered_by_admin)
                values (@round, @player, @layer, @value, 'manual', @modifier, true)
                """, s.Connection, s.Transaction);
            cmd.Parameters.AddWithValue("round", roundId);
            cmd.Parameters.Add(new NpgsqlParameter("player", NpgsqlTypes.NpgsqlDbType.Text) { Value = (object?)entry.PlayerId ?? DBNull.Value });
            cmd.Parameters.AddWithValue("layer", layer);
            cmd.Parameters.AddWithValue("value", value);
            cmd.Parameters.AddWithValue("modifier", modifier);
            await cmd.ExecuteNonQueryAsync(ct);
            rolls.Add(new BackfillRoll(entry.PlayerId!, value, modifier));
        }
        return rolls;
    }

    private static async Task<bool> IsAdmin(StoreSession s, string playerId, CancellationToken ct)
    {
        await using var cmd = new NpgsqlCommand("select is_admin from public.players where id = @id", s.Connection, s.Transaction);
        cmd.Parameters.AddWithValue("id", playerId);
        return await cmd.ExecuteScalarAsync(ct) is true;
    }

    private static async Task<Guid> TodaysRoom(StoreSession s, CancellationToken ct)
    {
        await using var cmd = new NpgsqlCommand("""
            insert into public.rooms (date) values ((now() at time zone 'Europe/London')::date)
              on conflict (date) where not is_test do nothing;
            select id from public.rooms where date = (now() at time zone 'Europe/London')::date;
            """, s.Connection, s.Transaction);
        return (Guid)(await cmd.ExecuteScalarAsync(ct))!;
    }

    private static async Task<bool> HasLiveRound(StoreSession s, Guid roomId, CancellationToken ct)
    {
        await using var cmd = new NpgsqlCommand(
            "select exists (select 1 from public.rounds where room_id = @room and status in ('open', 'closed'))", s.Connection, s.Transaction);
        cmd.Parameters.AddWithValue("room", roomId);
        return (bool)(await cmd.ExecuteScalarAsync(ct))!;
    }

    private static async Task AddToRoom(StoreSession s, Guid roomId, IReadOnlyList<string> roster, CancellationToken ct)
    {
        await using var cmd = new NpgsqlCommand("""
            insert into public.room_players (room_id, player_id)
            select @room, unnest(@roster::text[])
            on conflict (room_id, player_id) do nothing
            """, s.Connection, s.Transaction);
        cmd.Parameters.AddWithValue("room", roomId);
        cmd.Parameters.AddWithValue("roster", roster.ToArray());
        await cmd.ExecuteNonQueryAsync(ct);
    }

    private static async Task<Guid> InsertRound(StoreSession s, Guid roomId, string admin, IReadOnlyList<string> roster, CancellationToken ct)
    {
        await using var cmd = new NpgsqlCommand("""
            with round as (
              insert into public.rounds (room_id, started_by, status, started_at, closed_at, current_layer, backfilled_by, backfilled_at)
              values (@room, @admin, 'closed', now(), now(), 0, @admin, now())
              returning id
            ), joined as (
              insert into public.round_participants (round_id, player_id)
              select round.id, p from round, unnest(@roster::text[]) p
            )
            select id from round
            """, s.Connection, s.Transaction);
        cmd.Parameters.AddWithValue("room", roomId);
        cmd.Parameters.AddWithValue("admin", admin);
        cmd.Parameters.AddWithValue("roster", roster.ToArray());
        return (Guid)(await cmd.ExecuteScalarAsync(ct))!;
    }

    private static async Task<Dictionary<string, int>> Modifiers(StoreSession s, Guid roomId, CancellationToken ct)
    {
        await using var cmd = new NpgsqlCommand("select player_id, modifier from public.room_players where room_id = @room", s.Connection, s.Transaction);
        cmd.Parameters.AddWithValue("room", roomId);
        await using var r = await cmd.ExecuteReaderAsync(ct);
        var modifiers = new Dictionary<string, int>();
        while (await r.ReadAsync(ct)) modifiers[r.GetString(0)] = r.GetInt32(1);
        return modifiers;
    }

    private static async Task<DateTimeOffset> Now(StoreSession s, CancellationToken ct)
    {
        await using var cmd = new NpgsqlCommand("select now()", s.Connection, s.Transaction);
        return new DateTimeOffset((DateTime)(await cmd.ExecuteScalarAsync(ct))!);
    }
}

public static class RoundBackfillEndpoints
{
    public static IEndpointRouteBuilder MapRoundBackfill(this IEndpointRouteBuilder app)
    {
        app.MapPost("/rounds/backfill", async (BackfillRequest body, HttpContext http, RoomStore store, CancellationToken ct) =>
            Results.Ok(new BackfillResponse(await RoundBackfillRules.Run(store, http.GetCaller(), body, ct))))
            .Produces<BackfillResponse>().WithName("adminBackfillRound");
        return app;
    }
}
