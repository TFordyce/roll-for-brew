using RollForBrew.Api.Auth;
using RollForBrew.Api.Data;
using RollForBrew.Api.Problems;
using RollForBrew.Domain.RoomView;

namespace RollForBrew.Api.RoomView;

public static class RoomViewEndpoints
{
    public static IEndpointRouteBuilder MapRoomView(this IEndpointRouteBuilder app)
    {
        app.MapGet("/rooms/{roomId:guid}/view", async (Guid roomId, HttpContext http, RoomStore store, CancellationToken ct) =>
        {
            var caller = http.GetCaller();
            var input = await store.Read(caller, s => s.LoadView(roomId, ct), ct)
                ?? throw new ProblemException("room_not_found", ProblemClass.Missing, "Room not found.");
            http.Response.Headers.CacheControl = "no-store";
            return Results.Ok(RoomViewProjector.Project(input));
        }).Produces<RoomViewResponse>().WithName("getRoomView");
        return app;
    }
}
