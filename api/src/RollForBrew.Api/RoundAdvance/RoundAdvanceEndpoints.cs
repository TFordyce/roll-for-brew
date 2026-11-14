using System.Text.Json.Nodes;
using RollForBrew.Api.Auth;
using RollForBrew.Api.Data;
using RollForBrew.Domain.Commands;
using RollForBrew.Domain.Dice;

namespace RollForBrew.Api.RoundAdvance;

public static class RoundAdvanceEndpoints
{
    public static IEndpointRouteBuilder MapRoundAdvance(this IEndpointRouteBuilder app)
    {
        app.MapPost("/rounds/{roundId:guid}/advance", (Guid roundId, HttpContext http, RoomStore store, CancellationToken ct) =>
            Run(store, AdvanceRound.Entry.Advance, roundId, http, ct))
            .Produces<JsonObject>().WithName("advanceLayer");

        app.MapPost("/rounds/{roundId:guid}/finalize", (Guid roundId, HttpContext http, RoomStore store, CancellationToken ct) =>
            Run(store, AdvanceRound.Entry.Finalize, roundId, http, ct))
            .Produces<JsonObject>().WithName("finalizeLayer");
        return app;
    }

    // The actor is the validated JWT's sub (set as the claims GUC inside the
    // transaction); nothing in the request can name a player (ADR 0001).
    private static async Task<IResult> Run(
        RoomStore store, AdvanceRound.Entry entry, Guid roundId, HttpContext http, CancellationToken ct)
    {
        var payload = await store.Advance(http.GetCaller(), roundId, async (round, s) =>
        {
            var advance = new AdvanceRound(new RandomDieRoller());
            var outcome = await RoomStore.CommandUnderLock(s, round, snapshot => advance.Decide(snapshot, roundId, entry), ct);
            // Present only when this call committed: it tells the TS action the broadcasts have gone.
            if (outcome.Version is { } version) outcome.Result["version"] = version;
            return (JsonNode?)outcome.Result;
        }, ct);
        return Results.Json(payload);
    }
}
