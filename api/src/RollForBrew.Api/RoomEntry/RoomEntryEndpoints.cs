using Microsoft.EntityFrameworkCore;
using RollForBrew.Api.Auth;
using RollForBrew.Api.Data;

namespace RollForBrew.Api.RoomEntry;

public static class RoomEntryEndpoints
{
    public sealed record EnterRoomResponse(Guid RoomId);

    public static IEndpointRouteBuilder MapRoomEntry(this IEndpointRouteBuilder app)
    {
        app.MapPost("/rooms/today/entry", async (HttpContext http, RoomStore store, CancellationToken ct) =>
            Results.Ok(new EnterRoomResponse(await store.Filler(http.GetCaller(), s => Enter(s, ct), ct))))
            .Produces<EnterRoomResponse>().WithName("enterTodaysRoom");
        return app;
    }

    private const string LondonToday = "(now() at time zone 'Europe/London')::date";

    // SQL enter_todays_room (0027). No room argument to CurrentPlayerId, so the seat is always the real caller's.
    private static async Task<Guid> Enter(StoreSession s, CancellationToken ct)
    {
        var me = await s.CurrentPlayerId(ct: ct);
        var db = s.Db.Database;
        await db.ExecuteSqlRawAsync(
            $"insert into public.rooms (date) values ({LondonToday}) on conflict (date) where not is_test do nothing", ct);
        var roomId = await db
            .SqlQueryRaw<Guid>($"select id as \"Value\" from public.rooms where date = {LondonToday} and not is_test")
            .SingleAsync(ct);
        await db.ExecuteSqlInterpolatedAsync(
            $"insert into public.room_players (room_id, player_id) values ({roomId}, {me}) on conflict (room_id, player_id) do nothing", ct);
        return roomId;
    }
}
