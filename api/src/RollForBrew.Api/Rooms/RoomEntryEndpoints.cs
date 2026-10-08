using Microsoft.EntityFrameworkCore;
using RollForBrew.Api.Auth;
using RollForBrew.Api.Data;
using RollForBrew.Api.Problems;

namespace RollForBrew.Api.Rooms;

/// <summary>Read-only view of public.players (id, is_admin) for the set_acting_as admin check.</summary>
public sealed class PlayerRow
{
    public required string Id { get; set; }
    public bool IsAdmin { get; set; }
}

public static class RoomEntryEndpoints
{
    public sealed record EnterRoomResponse(Guid RoomId);
    public sealed record SetActingAsRequest(string? TargetPlayerId);

    public static IEndpointRouteBuilder MapRoomEntry(this IEndpointRouteBuilder app)
    {
        // Same result as SQL enter_todays_room (0027): idempotently create today's (Europe/London) room and the
        // caller's room_players row, return the room id. The caller is the validated JWT's player.
        app.MapPost("/rooms/today/entry", async (HttpContext http, RoomStore store, CancellationToken ct) =>
        {
            var roomId = await store.Filler(http.GetCaller(), async s =>
            {
                var me = await s.CurrentPlayerId(ct: ct);
                await s.Db.Database.ExecuteSqlRawAsync(
                    "insert into public.rooms (date) values ((now() at time zone 'Europe/London')::date) on conflict (date) where not is_test do nothing", ct);
                var id = await s.Db.Database
                    .SqlQuery<Guid>($"select id as \"Value\" from public.rooms where date = (now() at time zone 'Europe/London')::date and not is_test")
                    .SingleAsync(ct);
                await s.Db.Database.ExecuteSqlInterpolatedAsync(
                    $"insert into public.room_players (room_id, player_id) values ({id}, {me}) on conflict (room_id, player_id) do nothing", ct);
                return id;
            }, ct);
            return Results.Ok(new EnterRoomResponse(roomId));
        }).Produces<EnterRoomResponse>().WithName("enterTodaysRoom");

        // Same rules as SQL set_acting_as (0026): admin only; the target must exist; picking yourself clears the pointer.
        // The Test-Room-only half of the rule lives in current_player_id (the resolver), not here (ADR 0001).
        app.MapPut("/acting-as", async (SetActingAsRequest body, HttpContext http, RoomStore store, CancellationToken ct) =>
        {
            await store.Filler(http.GetCaller(), async s =>
            {
                var me = await s.CurrentPlayerId(ct: ct);
                var isAdmin = await s.Db.Set<PlayerRow>().AsNoTracking().Where(p => p.Id == me).Select(p => p.IsAdmin).SingleOrDefaultAsync(ct);
                if (!isAdmin)
                    throw new ProblemException("admin_required_set_acting_as", ProblemClass.Auth, "Only an admin can set Acting As.");
                if (body.TargetPlayerId is not null && !await s.Db.Set<PlayerRow>().AnyAsync(p => p.Id == body.TargetPlayerId, ct))
                    throw new ProblemException("acting_as_target_not_found", ProblemClass.Missing, "The target player was not found.");

                var pointer = body.TargetPlayerId == me ? null : body.TargetPlayerId;
                var row = await s.Db.AdminActingAs.SingleOrDefaultAsync(a => a.AdminPlayerId == me, ct);
                if (row is null) s.Db.AdminActingAs.Add(new AdminActingAs { AdminPlayerId = me, ActingAsPlayerId = pointer });
                else row.ActingAsPlayerId = pointer;
                await s.Db.SaveChangesAsync(ct);
                return 0;
            }, ct);
            return Results.NoContent();
        }).Produces(StatusCodes.Status204NoContent).WithName("setActingAs");
        return app;
    }
}
