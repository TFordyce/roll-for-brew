using RollForBrew.Api.Auth;
using RollForBrew.Api.Data;

namespace RollForBrew.Api.ModifierAdjustments;

public static class ModAdjEndpoints
{
    public sealed record LogRequest(string TargetPlayerId, int Delta, string? Reason);
    public sealed record AdminDeleteRequest(string? Reason);
    public sealed record AdjustmentIdResponse(Guid Id);

    public static IEndpointRouteBuilder MapModifierAdjustments(this IEndpointRouteBuilder app)
    {
        // Operation names match the TS wrappers (docs/port/port-flags.md).
        app.MapPost("/modifier-adjustments", async (HttpContext http, RoomStore store, LogRequest body, CancellationToken ct) =>
            Results.Ok(new AdjustmentIdResponse(await store.Filler(http.GetCaller(),
                s => ModAdjRules.Log(s, body.TargetPlayerId, body.Delta, body.Reason, ct), ct))))
            .Produces<AdjustmentIdResponse>().WithName("logModifierAdjustment");

        app.MapDelete("/modifier-adjustments/{id:guid}", async (HttpContext http, RoomStore store, Guid id, CancellationToken ct) =>
        {
            await store.Filler(http.GetCaller(), async s => { await ModAdjRules.Undo(s, id, ct); return 0; }, ct);
            return Results.NoContent();
        }).WithName("deleteModifierAdjustment");

        app.MapPost("/modifier-adjustments/{id:guid}/admin-delete", async (HttpContext http, RoomStore store, Guid id, AdminDeleteRequest body, CancellationToken ct) =>
        {
            await store.Filler(http.GetCaller(), async s => { await ModAdjRules.AdminDelete(s, id, body.Reason, ct); return 0; }, ct);
            return Results.NoContent();
        }).WithName("adminDeleteModifierAdjustment");
        return app;
    }
}
