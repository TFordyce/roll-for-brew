using Npgsql;
using RollForBrew.Api.Auth;
using RollForBrew.Api.Data;
using RollForBrew.Domain.Commands;
using RollForBrew.Domain.Dice;

namespace RollForBrew.Api.Rolls;

/// <summary>Roll submission (spec #533, slice 3b). Each runs through the round-locked command
/// path. The roller is the JWT's player (Acting As included), resolved by SQL inside the lock;
/// the <c>_as</c> and proxy variants name their target and need an admin. A roll that completes
/// a Layer is advanced by the caller's next <c>advanceLayer</c> call, as the SQL path was.</summary>
public static class RollEndpoints
{
    public sealed record RollResponse(int Value, long? Version);
    public sealed record ManualRollRequest(int Value);
    public sealed record RollAsRequest(string PlayerId);
    public sealed record ManualRollAsRequest(string PlayerId, int Value);
    public sealed record ProxyRollRequest(string PlayerId, int Value);

    public static IEndpointRouteBuilder MapRolls(this IEndpointRouteBuilder app)
    {
        app.MapPost("/rounds/{roundId:guid}/rolls", (Guid roundId, HttpContext http, RoomStore store, CancellationToken ct) =>
            Run(http, store, roundId, async (s, round) =>
                await Auto(s, round, roundId, await s.CurrentPlayerId(roundId, ct: ct), asAdmin: false, ct), ct))
            .Produces<RollResponse>().WithName("submitRoll");

        app.MapPost("/rounds/{roundId:guid}/rolls/as", (Guid roundId, RollAsRequest body, HttpContext http, RoomStore store, CancellationToken ct) =>
            Run(http, store, roundId, async (s, round) =>
            {
                await RequireAdmin(s, ct);
                return await Auto(s, round, roundId, body.PlayerId, asAdmin: true, ct);
            }, ct))
            .Produces<RollResponse>().WithName("submitRollAs");

        app.MapPost("/rounds/{roundId:guid}/rolls/manual", (Guid roundId, ManualRollRequest body, HttpContext http, RoomStore store, CancellationToken ct) =>
            Run(http, store, roundId, async (s, round) =>
                await Manual(s, round, roundId, await s.CurrentPlayerId(roundId, ct: ct), body.Value, asAdmin: false, ct), ct))
            .Produces<RollResponse>().WithName("submitManualRoll");

        app.MapPost("/rounds/{roundId:guid}/rolls/manual/as", (Guid roundId, ManualRollAsRequest body, HttpContext http, RoomStore store, CancellationToken ct) =>
            Run(http, store, roundId, async (s, round) =>
            {
                RequireValue(body.Value);
                await RequireAdmin(s, ct);
                return await Manual(s, round, roundId, body.PlayerId, body.Value, asAdmin: true, ct);
            }, ct))
            .Produces<RollResponse>().WithName("submitManualRollAs");

        app.MapPost("/rounds/{roundId:guid}/rolls/proxy", (Guid roundId, ProxyRollRequest body, HttpContext http, RoomStore store, CancellationToken ct) =>
            Run(http, store, roundId, async (s, round) =>
            {
                RequireValue(body.Value);
                await RequireAdmin(s, ct);
                await using var exists = new NpgsqlCommand("select exists (select 1 from public.players where id = @id)", s.Connection, s.Transaction);
                exists.Parameters.AddWithValue("id", body.PlayerId);
                if (!(bool)(await exists.ExecuteScalarAsync(ct))!)
                    throw new CommandRefusal("target_player_not_found", "target player not found");
                var outcome = await RoomStore.CommandUnderLock(s, round, snap => RollSubmission.Proxy(snap, roundId, body.PlayerId, body.Value), ct);
                return new RollResponse(body.Value, outcome.Version);
            }, ct))
            .Produces<RollResponse>().WithName("adminProxyRoll");
        return app;
    }

    private static async Task<IResult> Run(
        HttpContext http, RoomStore store, Guid roundId, Func<StoreSession, RoundLock?, Task<RollResponse>> work, CancellationToken ct) =>
        Results.Ok(await store.Advance(http.GetCaller(), roundId, (round, s) => work(s, round), ct));

    private static async Task<RollResponse> Auto(
        StoreSession s, RoundLock? round, Guid roundId, string player, bool asAdmin, CancellationToken ct)
    {
        var outcome = await RoomStore.CommandUnderLock(s, round,
            snap => RollSubmission.Auto(snap, roundId, player, new RandomDieRoller(), asAdmin), ct);
        return new RollResponse(outcome.Result, outcome.Version);
    }

    private static async Task<RollResponse> Manual(
        StoreSession s, RoundLock? round, Guid roundId, string player, int value, bool asAdmin, CancellationToken ct)
    {
        var outcome = await RoomStore.CommandUnderLock(s, round,
            snap => RollSubmission.Manual(snap, roundId, player, value, asAdmin), ct);
        return new RollResponse(value, outcome.Version);
    }

    private static void RequireValue(int value)
    {
        if (value is < 1 or > 20)
            throw new CommandRefusal("roll_value_out_of_range", "a roll must be between 1 and 20");
    }

    /// <summary>The caller (not the puppet) must be an admin, as <c>current_player_id()</c> with no round says.</summary>
    private static async Task RequireAdmin(StoreSession s, CancellationToken ct)
    {
        var caller = await s.CurrentPlayerId(ct: ct);
        await using var cmd = new NpgsqlCommand("select is_admin from public.players where id = @id", s.Connection, s.Transaction);
        cmd.Parameters.AddWithValue("id", caller);
        if (await cmd.ExecuteScalarAsync(ct) is not true)
            throw new CommandRefusal("admin_required", "caller is not an admin");
    }
}
