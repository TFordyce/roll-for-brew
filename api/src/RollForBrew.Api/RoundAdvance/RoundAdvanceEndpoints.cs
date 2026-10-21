using System.Text.Json.Nodes;
using Microsoft.Extensions.Logging;
using RollForBrew.Api.Auth;
using RollForBrew.Api.Data;
using RollForBrew.Api.Problems;

namespace RollForBrew.Api.RoundAdvance;

public static class RoundAdvanceEndpoints
{
    public static IEndpointRouteBuilder MapRoundAdvance(this IEndpointRouteBuilder app)
    {
        app.MapPost("/rounds/{roundId:guid}/advance", (Guid roundId, HttpContext http, RoomStore store, ILogger<ShadowAdvance> log, CancellationToken ct) =>
            Run(store, log, ShadowAdvance.Bridge.AdvanceLayer, roundId, http, ct))
            .Produces<JsonObject>().WithName("advanceLayer");

        app.MapPost("/rounds/{roundId:guid}/finalize", (Guid roundId, HttpContext http, RoomStore store, ILogger<ShadowAdvance> log, CancellationToken ct) =>
            Run(store, log, ShadowAdvance.Bridge.FinalizeLayer, roundId, http, ct))
            .Produces<JsonObject>().WithName("finalizeLayer");
        return app;
    }

    // The actor is the validated JWT's sub (set as the claims GUC inside the
    // transaction); nothing in the request can name a player (ADR 0001).
    private static async Task<IResult> Run(
        RoomStore store, ILogger log, ShadowAdvance.Bridge bridge, Guid roundId, HttpContext http, CancellationToken ct)
    {
        var caller = http.GetCaller();
        var shadow = new ShadowAdvance();
        var payload = await store.Advance(caller, roundId, (round, s) => shadow.Run(s, round, roundId, bridge, log, ct), ct);
        return Results.Json(payload);
    }
}
