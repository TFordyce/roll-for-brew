using Microsoft.EntityFrameworkCore;
using RollForBrew.Api.Auth;
using RollForBrew.Api.Data;
using RollForBrew.Api.ModifierAdjustments;
using RollForBrew.Api.Problems;

namespace RollForBrew.Api.ActingAs;

public static class ActingAsEndpoints
{
    public sealed record ActingAsResponse(string? ActingAsPlayerId);
    public sealed record SetActingAsRequest(string? TargetPlayerId);

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

        app.MapPut("/acting-as", async (SetActingAsRequest body, HttpContext http, RoomStore store, CancellationToken ct) =>
        {
            await store.Filler(http.GetCaller(), async s => { await Set(s, body.TargetPlayerId, ct); return 0; }, ct);
            return Results.NoContent();
        }).Produces(StatusCodes.Status204NoContent).WithName("setActingAs");
        return app;
    }

    // SQL set_acting_as (0026). The Test-Room-only half of ADR 0001 lives in current_player_id, which ignores the pointer
    // outside a Test Room; with no room argument here the caller is always the real admin.
    private static async Task Set(StoreSession s, string? target, CancellationToken ct)
    {
        var me = await s.CurrentPlayerId(ct: ct);
        var players = s.Db.Set<PlayerAdminFlag>().AsNoTracking();
        if (!await players.AnyAsync(p => p.Id == me && p.IsAdmin, ct))
            throw new ProblemException("admin_required_set_acting_as", ProblemClass.Auth, "Only an admin can set Acting As.");
        if (target is not null && !await players.AnyAsync(p => p.Id == target, ct))
            throw new ProblemException("acting_as_target_not_found", ProblemClass.Missing, "The target player was not found.");

        var pointer = target == me ? null : target;
        await s.Db.Database.ExecuteSqlInterpolatedAsync($"""
            insert into public.admin_acting_as (admin_player_id, acting_as_player_id) values ({me}, {pointer})
            on conflict (admin_player_id) do update set acting_as_player_id = excluded.acting_as_player_id
            """, ct);
    }
}
