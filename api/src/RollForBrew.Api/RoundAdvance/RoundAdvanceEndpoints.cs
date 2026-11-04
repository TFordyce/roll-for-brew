using System.Text.Json.Nodes;
using Microsoft.Extensions.Logging;
using RollForBrew.Api.Auth;
using RollForBrew.Api.Data;
using RollForBrew.Api.Problems;
using RollForBrew.Domain.Commands;
using RollForBrew.Domain.Dice;

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
        if (await store.Read(caller, s => s.AdvanceIsAuthoritative(roundId, ct), ct))
        {
            var advance = new AdvanceRound(new RandomDieRoller());
            var entry = bridge == ShadowAdvance.Bridge.AdvanceLayer ? AdvanceRound.Entry.Advance : AdvanceRound.Entry.Finalize;
            var outcome = await store.Command(roundId, caller, s => advance.Decide(s, roundId, entry), ct);
            // Present only when this call committed: it tells the TS action the broadcasts have gone.
            if (outcome.Version is { } version) outcome.Result["version"] = version;
            return Results.Json(outcome.Result);
        }

        var shadow = new ShadowAdvance();
        var payload = await store.Advance(caller, roundId, (round, s) => shadow.Run(s, round, bridge, log, ct), ct);
        return Results.Json(payload);
    }
}
