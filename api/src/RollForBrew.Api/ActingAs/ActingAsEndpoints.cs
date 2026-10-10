using Microsoft.EntityFrameworkCore;
using RollForBrew.Api.Auth;
using RollForBrew.Api.Data;

namespace RollForBrew.Api.ActingAs;

public static class ActingAsEndpoints
{
    public sealed record ActingAsResponse(string? ActingAsPlayerId);

    public static IEndpointRouteBuilder MapActingAs(this IEndpointRouteBuilder app)
    {
        app.MapGet("/acting-as", async (HttpContext http, RoomStore store, CancellationToken ct) =>
        {
            var caller = http.GetCaller();
            var pointer = await store.Read(caller, async s =>
            {
                var me = await s.CurrentPlayerId(ct: ct);
                return await s.Db.AdminActingAs.AsNoTracking()
                    .Where(a => a.AdminPlayerId == me)
                    .Select(a => a.ActingAsPlayerId)
                    .SingleOrDefaultAsync(ct);
            }, ct);
            return Results.Ok(new ActingAsResponse(pointer));
        }).Produces<ActingAsResponse>().WithName("getActingAs");
        return app;
    }
}
