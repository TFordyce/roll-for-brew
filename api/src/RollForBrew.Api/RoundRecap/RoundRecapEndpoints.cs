using System.Text.Json;
using System.Text.Json.Nodes;
using Npgsql;
using RollForBrew.Api.Auth;
using RollForBrew.Api.Data;
using RollForBrew.Api.Problems;
using RollForBrew.Domain.Recap;

namespace RollForBrew.Api.RoundRecap;

public static class RoundRecapEndpoints
{
    public static IEndpointRouteBuilder MapRoundRecap(this IEndpointRouteBuilder app)
    {
        app.MapGet("/rounds/{roundId:guid}/recap", async (Guid roundId, HttpContext http, RoomStore store, CancellationToken ct) =>
        {
            http.Response.Headers.CacheControl = "no-store";
            return Results.Json(await RoundRecapReader.Read(store, http.GetCaller(), roundId, ct));
        }).Produces<JsonObject>().WithName("getRoundRecap");
        return app;
    }
}

public static class RoundRecapReader
{
    public static Task<JsonObject> Read(RoomStore store, Caller caller, Guid roundId, CancellationToken ct = default) =>
        store.ReadConsistent(caller, async session =>
        {
            var viewer = await session.CurrentPlayerId(roundId, ct: ct);
            var (roomId, stored) = await RoundHead(session, roundId, ct)
                ?? throw ProblemException.FromInfo(ProblemCatalog.FromSqlState("RFB18")!, null);
            var snapshot = await session.Load(roomId, ct);
            var round = snapshot.Rounds.First(r => r.Id == roundId);
            if (!RoundRecapPreview.MayRead(snapshot, round, viewer))
                throw new ProblemException("recap_not_in_room", ProblemClass.Auth, "You are not in this round's room.");
            return RoundRecapPreview.Build(snapshot, round, stored, await ReactionSkips(session, roundId, ct));
        }, ct);

    private static async Task<(Guid RoomId, StoredResolution Stored)?> RoundHead(StoreSession session, Guid roundId, CancellationToken ct)
    {
        await using var cmd = new NpgsqlCommand(
            "select room_id, resolution_trace::text, resolution_summary::text from public.rounds where id = @round", session.Connection, session.Transaction);
        cmd.Parameters.AddWithValue("round", roundId);
        await using var r = await cmd.ExecuteReaderAsync(ct);
        if (!await r.ReadAsync(ct)) return null;
        return (r.GetGuid(0), new StoredResolution(Json(r, 1), Json(r, 2)));

        static JsonElement? Json(NpgsqlDataReader r, int column) =>
            r.IsDBNull(column) ? null : JsonSerializer.Deserialize<JsonElement>(r.GetString(column));
    }

    /// <summary>Who the round's latest Layer 0 window stopped waiting on, and why.</summary>
    private static async Task<IReadOnlyList<ReactionSkip>> ReactionSkips(StoreSession session, Guid roundId, CancellationToken ct)
    {
        await using var cmd = new NpgsqlCommand("""
            select p.player_id, p.reason
              from public.spell_reaction_passes p
             where p.reason <> 'pass'
               and p.window_id = (
                 select w.id from public.spell_reaction_windows w
                  where w.round_id = @round and w.layer = 0
                  order by w.opened_at desc
                  limit 1)
             order by p.player_id
            """, session.Connection, session.Transaction);
        cmd.Parameters.AddWithValue("round", roundId);
        await using var r = await cmd.ExecuteReaderAsync(ct);
        var skips = new List<ReactionSkip>();
        while (await r.ReadAsync(ct)) skips.Add(new ReactionSkip(r.GetString(0), r.GetString(1)));
        return skips;
    }
}
