using Npgsql;
using NpgsqlTypes;
using RollForBrew.Api.Auth;
using RollForBrew.Api.Data;
using RollForBrew.Domain.Commands;
using RollForBrew.Domain.Snapshot;

namespace RollForBrew.Api.RoundCommands;

/// <summary>Round lifecycle commands (spec #533, slice 3a). Each runs through
/// <see cref="RoomStore"/>'s locked command path and answers <c>{ version }</c>: the bumped
/// <c>rooms.version</c> the actor's client waits for, or null when the call changed nothing.</summary>
public static class RoundCommandEndpoints
{
    public sealed record CommandResponse(long? Version);
    public sealed record StartRoundRequest(Guid? RoomId);
    public sealed record StartRoundResponse(Guid RoundId, long Version);
    public sealed record ExcludeRequest(string PlayerId, int Layer);

    public static IEndpointRouteBuilder MapRoundCommands(this IEndpointRouteBuilder app)
    {
        app.MapPost("/rounds", async (StartRoundRequest? body, HttpContext http, RoomStore store, CancellationToken ct) =>
            Results.Ok(await store.Filler(http.GetCaller(), s => RoundStart.Start(s, body?.RoomId, ct), ct)))
            .Produces<StartRoundResponse>().WithName("startRound");

        app.MapPost("/rounds/{roundId:guid}/declaration", (Guid roundId, HttpContext http, RoomStore store, CancellationToken ct) =>
            AsActor(http, store, roundId, null, (s, me) => RoundLifecycle.DeclareIn(s, roundId, me, late: false), ct))
            .Produces<CommandResponse>().WithName("declareIn");

        app.MapPost("/rounds/{roundId:guid}/declaration/late", (Guid roundId, HttpContext http, RoomStore store, CancellationToken ct) =>
            AsActor(http, store, roundId, null, (s, me) => RoundLifecycle.DeclareIn(s, roundId, me, late: true), ct))
            .Produces<CommandResponse>().WithName("declareInLate");

        app.MapDelete("/rounds/{roundId:guid}/declaration", (Guid roundId, HttpContext http, RoomStore store, CancellationToken ct) =>
            AsActor(http, store, roundId, roundId, (s, me) => RoundLifecycle.Withdraw(s, roundId, me), ct))
            .Produces<CommandResponse>().WithName("withdrawDeclaration");

        app.MapPost("/rounds/{roundId:guid}/close", (Guid roundId, HttpContext http, RoomStore store, CancellationToken ct) =>
            AsActor(http, store, roundId, roundId, (s, me) => RoundLifecycle.Close(s, roundId, me), ct))
            .Produces<CommandResponse>().WithName("closeRound");

        // The caller has already decided the round stalled; like the SQL it replaces, this only applies it.
        app.MapPost("/rounds/{roundId:guid}/cancel", async (Guid roundId, HttpContext http, RoomStore store, CancellationToken ct) =>
            Respond(await store.Command(roundId, http.GetCaller(), s => RoundLifecycle.Cancel(s, roundId), ct)))
            .Produces<CommandResponse>().WithName("cancelRound");

        app.MapPost("/rounds/{roundId:guid}/exclusions", async (Guid roundId, ExcludeRequest body, HttpContext http, RoomStore store, CancellationToken ct) =>
            Respond(await store.Command(roundId, http.GetCaller(), s => RoundLifecycle.Exclude(s, roundId, body.PlayerId, body.Layer), ct)))
            .Produces<CommandResponse>().WithName("excludeRoundParticipant");

        app.MapPost("/rounds/{roundId:guid}/replay/confirm", (Guid roundId, HttpContext http, RoomStore store, CancellationToken ct) =>
            Replay(http, store, roundId, RoundLifecycle.ConfirmReplay, ct))
            .Produces<CommandResponse>().WithName("confirmRoundReplay");

        app.MapPost("/rounds/{roundId:guid}/replay/decline", (Guid roundId, HttpContext http, RoomStore store, CancellationToken ct) =>
            Replay(http, store, roundId, RoundLifecycle.DeclineReplay, ct))
            .Produces<CommandResponse>().WithName("declineRoundReplay");
        return app;
    }

    private static IResult Respond(CommandOutcome<bool> outcome) => Results.Ok(new CommandResponse(outcome.Version));

    /// <summary>The actor is the validated JWT's player, resolved by SQL inside the round lock
    /// (Acting As included). <paramref name="actorRound"/> is the round SQL passed to
    /// <c>current_player_id</c>: declare resolved it without one, the rest with it.</summary>
    private static async Task<IResult> AsActor(
        HttpContext http, RoomStore store, Guid roundId, Guid? actorRound,
        Func<RoundSnapshot?, string, Decision<bool>> decide, CancellationToken ct) =>
        Respond(await store.Advance(http.GetCaller(), roundId, async (round, s) =>
        {
            var me = await s.CurrentPlayerId(actorRound, ct: ct);
            return await RoomStore.CommandUnderLock(s, round, snap => decide(snap, me), ct);
        }, ct));

    private static async Task<IResult> Replay(
        HttpContext http, RoomStore store, Guid roundId, Func<Guid, string, string?, Decision<bool>> decide, CancellationToken ct) =>
        Respond(await store.Advance(http.GetCaller(), roundId, async (round, s) =>
        {
            var me = await s.CurrentPlayerId(roundId, ct: ct);
            var caster = await PendingCaster(s, roundId, ct);
            return await RoomStore.CommandUnderLock(s, round, _ => decide(roundId, me, caster), ct);
        }, ct));

    private static async Task<string?> PendingCaster(StoreSession s, Guid roundId, CancellationToken ct)
    {
        await using var cmd = new NpgsqlCommand(
            "select caster_id from public.pending_round_replay where round_id = @round for update", s.Connection, s.Transaction);
        cmd.Parameters.Add(new NpgsqlParameter("round", NpgsqlDbType.Uuid) { Value = roundId });
        return await cmd.ExecuteScalarAsync(ct) as string;
    }
}

/// <summary>start_round (0090). No round exists to lock yet, so it runs as a Filler; the
/// <c>rounds_one_active_per_room</c> unique index is what serialises two simultaneous starts.</summary>
public static class RoundStart
{
    public static async Task<RoundCommandEndpoints.StartRoundResponse> Start(StoreSession s, Guid? roomId, CancellationToken ct)
    {
        var room = roomId ?? await TodaysRoom(s, ct)
            ?? throw new CommandRefusal("no_room_today", "start_round: no room for today");

        // A pending replay decision locks new rounds. Clear any that stalled past 5 minutes first.
        await using (var sweep = new NpgsqlCommand("""
            with stale as (
              delete from public.pending_round_replay
               where round_id in (
                 select round_id from public.pending_round_replay
                  where now() - created_at >= interval '5 minutes' for update skip locked)
              returning round_id
            )
            update public.spell_casts
               set cast_inputs = coalesce(cast_inputs, '{}'::jsonb) || '{"scrapped": false}'::jsonb
             where effect_kind = 'round_replay' and round_id in (select round_id from stale)
            """, s.Connection, s.Transaction))
            await sweep.ExecuteNonQueryAsync(ct);

        await using (var pending = new NpgsqlCommand(
            "select exists (select 1 from public.pending_round_replay where room_id = @room)", s.Connection, s.Transaction))
        {
            pending.Parameters.Add(new NpgsqlParameter("room", NpgsqlDbType.Uuid) { Value = room });
            if ((bool)(await pending.ExecuteScalarAsync(ct))!)
                throw new CommandRefusal("replay_decision_state", "start_round: a round replay decision is still pending for this room");
        }

        var me = await s.CurrentPlayerId(roomId: room, ct: ct);
        Guid roundId;
        await using (var insert = new NpgsqlCommand(
            "insert into public.rounds (room_id, started_by, status) values (@room, @me, 'open') returning id", s.Connection, s.Transaction))
        {
            insert.Parameters.Add(new NpgsqlParameter("room", NpgsqlDbType.Uuid) { Value = room });
            insert.Parameters.AddWithValue("me", me);
            roundId = (Guid)(await insert.ExecuteScalarAsync(ct))!;
        }
        await using (var join = new NpgsqlCommand(
            "insert into public.round_participants (round_id, player_id) values (@round, @me)", s.Connection, s.Transaction))
        {
            join.Parameters.Add(new NpgsqlParameter("round", NpgsqlDbType.Uuid) { Value = roundId });
            join.Parameters.AddWithValue("me", me);
            await join.ExecuteNonQueryAsync(ct);
        }

        var version = await s.BumpAndAnnounce(room, Announce.Required, ct);
        return new RoundCommandEndpoints.StartRoundResponse(roundId, version);
    }

    private static async Task<Guid?> TodaysRoom(StoreSession s, CancellationToken ct)
    {
        await using var cmd = new NpgsqlCommand(
            "select id from public.rooms where date = (now() at time zone 'Europe/London')::date", s.Connection, s.Transaction);
        return await cmd.ExecuteScalarAsync(ct) as Guid?;
    }
}
