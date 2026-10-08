using Microsoft.EntityFrameworkCore;
using RollForBrew.Api.Auth;
using RollForBrew.Api.Data;

namespace RollForBrew.Api.ActingAs;

public static class ActingAsEndpoints
{
    public sealed record ActingAsResponse(string? ActingAsPlayerId);

    public static IEndpointRouteBuilder MapActingAs(this IEndpointRouteBuilder app)
    {
        // Same result as SQL get_acting_as(): the caller's own pointer, or null.
        // The caller is the validated JWT's player. Nothing in the request can name another admin or
        // another player to act as (ADR 0001); query, header and body are ignored.
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
        }).Produces<ActingAsResponse>().WithName("getActingAs"); // named for the generated TS client (api/openapi/)
        return app;
    }
}
