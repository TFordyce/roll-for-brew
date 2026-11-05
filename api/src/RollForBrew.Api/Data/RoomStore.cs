using System.Data;
using System.Text.Json.Nodes;
using Microsoft.EntityFrameworkCore;
using Npgsql;
using RollForBrew.Api.Auth;
using RollForBrew.Api.Problems;
using RollForBrew.Domain.Commands;
using RollForBrew.Domain.Resolver;
using RollForBrew.Domain.Snapshot;

namespace RollForBrew.Api.Data;

public sealed class RoomStore
{
    private readonly NpgsqlDataSource _dataSource;

    public RoomStore(NpgsqlDataSource dataSource) => _dataSource = dataSource;

    public static string ApplyPoolerSettings(string connectionString)
    {
        var b = new NpgsqlConnectionStringBuilder(connectionString)
        {
            MaxAutoPrepare = 0,
            NoResetOnClose = true,
            Multiplexing = false,
            MaxPoolSize = 5,
        };
        return b.ConnectionString;
    }

    public static NpgsqlDataSource BuildDataSource(string connectionString) =>
        new NpgsqlDataSourceBuilder(ApplyPoolerSettings(connectionString)).Build();

    public Task<T> Read<T>(Caller actor, Func<StoreSession, Task<T>> work, CancellationToken ct = default) =>
        InTransaction(actor, readOnly: true, work, ct);

    /// <summary>A read whose statements all see one moment, in a transaction the database
    /// refuses to write in. What a preview runs in: it takes no lock, so it never waits on
    /// a round being finalized, and it sees that commit whole or not at all.</summary>
    public Task<T> ReadConsistent<T>(Caller actor, Func<StoreSession, Task<T>> work, CancellationToken ct = default) =>
        InTransaction(actor, readOnly: true, work, ct, IsolationLevel.RepeatableRead);

    public Task<T> Filler<T>(Caller actor, Func<StoreSession, Task<T>> work, CancellationToken ct = default) =>
        InTransaction(actor, readOnly: false, work, ct);

    /// <summary>
    /// A write transaction that takes the round-row <c>for update</c> lock before the
    /// snapshot (ADR 0012). The lock is handed to <paramref name="work"/> as
    /// <c>null</c> when the round does not exist, so callers can answer with SQL's own
    /// noop shape instead of a 404. Slice 2a's minimal write path, kept while the flag can
    /// still pick the shadow: the choice is read under this lock, then either path runs.
    /// </summary>
    public Task<T> Advance<T>(Caller actor, Guid roundId, Func<RoundLock?, StoreSession, Task<T>> work, CancellationToken ct = default) =>
        InTransaction(actor, readOnly: false, async session =>
        {
            var round = await LockRound(session, roundId);
            return await work(round, session);
        }, ct);

    /// <summary>The write path every ported command uses (ADR 0012), in one transaction:
    /// round-row <c>for update</c>, snapshot, decide, write batch, <c>rooms.version</c>
    /// bump, broadcast. <paramref name="decide"/> sees a null snapshot when the round does
    /// not exist. No writes means no bump and no broadcast; the version comes back null.</summary>
    public Task<CommandOutcome<T>> Command<T>(
        Guid roundId, Caller actor, Func<RoundSnapshot?, Decision<T>> decide, CancellationToken ct = default) =>
        InTransaction(actor, readOnly: false, async session =>
            await CommandUnderLock(session, await LockRound(session, roundId), decide, ct), ct);

    /// <summary><see cref="Command"/> from the point the lock is held.</summary>
    internal static async Task<CommandOutcome<T>> CommandUnderLock<T>(
        StoreSession session, RoundLock? round, Func<RoundSnapshot?, Decision<T>> decide, CancellationToken ct)
    {
        var snapshot = round is null ? null : await session.Load(round.RoomId, ct);
        var wrote = false;
        var events = new List<RoomEvent>();

        for (var pass = 1; ; pass++)
        {
            var decision = decide(snapshot);
            foreach (var write in decision.Writes)
                await WritePersister.Apply(session, write, ct);
            wrote |= decision.Writes.Count > 0;
            events.AddRange(decision.Events);

            if (!decision.ReloadAfterWrite)
                return new CommandOutcome<T>(decision.Result, wrote ? await BumpAndBroadcast(session, round!.RoomId, events, ct) : null);
            if (pass == MaxDecidePasses || round is null)
                throw new InvalidOperationException($"a decision asked to reload after {pass} pass(es) on round {round?.RoundId}");
            snapshot = await session.Load(round.RoomId, ct);
        }
    }

    // AdvanceRound needs two: open the window through its bridge, then read whether it closed.
    private const int MaxDecidePasses = 3;

    internal static async Task<long> BumpAndBroadcast(StoreSession session, Guid roomId, IReadOnlyList<RoomEvent> events, CancellationToken ct)
    {
        await using var bump = new NpgsqlCommand(
            "update public.rooms set version = version + 1 where id = @room returning version", session.Connection, session.Transaction);
        bump.Parameters.AddWithValue("room", roomId);
        var version = (long)(await bump.ExecuteScalarAsync(ct))!;

        // realtime.send swallows every failure as a WARNING (ADR 0011). Unwatched, a failed
        // send would commit with nobody told.
        string? swallowed = null;
        void Watch(object sender, NpgsqlNoticeEventArgs e)
        {
            if (e.Notice.MessageText.Contains("SendingBroadcastMessage", StringComparison.Ordinal))
                swallowed = e.Notice.MessageText;
        }

        session.Connection.Notice += Watch;
        try
        {
            foreach (var e in events)
            {
                var payload = (JsonObject)e.Payload.DeepClone();
                payload["version"] = version;
                await using var send = new NpgsqlCommand(
                    "select public.rfb_broadcast(@topic, @event, @payload)", session.Connection, session.Transaction);
                send.Parameters.AddWithValue("topic", $"room:{roomId}");
                send.Parameters.AddWithValue("event", e.Name);
                send.Parameters.Add(new NpgsqlParameter("payload", NpgsqlTypes.NpgsqlDbType.Jsonb) { Value = payload.ToJsonString() });
                await send.ExecuteNonQueryAsync(ct);
                if (swallowed is not null)
                    throw new ProblemException("broadcast_failed", ProblemClass.Unavailable, "The change could not be announced, so it was not applied.", swallowed);
            }
        }
        finally
        {
            session.Connection.Notice -= Watch;
        }
        return version;
    }

    /// <summary>The shared transaction shell: open → begin → claims GUC → work →
    /// commit (rollback when read-only), with the SQL error translation. Kept minimal.</summary>
    private async Task<T> InTransaction<T>(
        Caller actor, bool readOnly, Func<StoreSession, Task<T>> work, CancellationToken ct, IsolationLevel isolation = IsolationLevel.ReadCommitted)
    {
        try
        {
            await using var conn = await _dataSource.OpenConnectionAsync(ct);
            await using var tx = await conn.BeginTransactionAsync(isolation, ct);
            await SetClaimsGuc(conn, tx, actor, ct);
            if (readOnly)
            {
                await using var ro = new NpgsqlCommand("set transaction read only", conn, tx);
                await ro.ExecuteNonQueryAsync(ct);
            }

            await using var session = new StoreSession(conn, tx);
            var result = await work(session);
            if (readOnly) await tx.RollbackAsync(ct); else await tx.CommitAsync(ct);
            return result;
        }
        catch (PostgresException e)
        {
            throw Translate(e);
        }
        catch (DbUpdateException e) when (e.InnerException is PostgresException pe)
        {
            throw Translate(pe);
        }
        catch (ResolveException e)
        {
            throw ProblemCatalog.FromResolveException(e);
        }
    }

    private static async Task<RoundLock?> LockRound(StoreSession session, Guid roundId)
    {
        await using var cmd = new NpgsqlCommand(
            "select room_id, status, current_layer from public.rounds where id = @id for update", session.Connection, session.Transaction);
        cmd.Parameters.Add(new NpgsqlParameter("id", NpgsqlTypes.NpgsqlDbType.Uuid) { Value = roundId });
        await using var r = await cmd.ExecuteReaderAsync();
        return await r.ReadAsync() ? new RoundLock(roundId, r.GetGuid(0), r.GetString(1), r.GetInt32(2)) : null;
    }

    private static async Task SetClaimsGuc(NpgsqlConnection conn, NpgsqlTransaction tx, Caller actor, CancellationToken ct)
    {
        await using var cmd = new NpgsqlCommand("select set_config('request.jwt.claims', @c, true)", conn, tx);
        cmd.Parameters.AddWithValue("c", actor.ClaimsJson);
        await cmd.ExecuteNonQueryAsync(ct);
    }

    public static Exception Translate(PostgresException e) =>
        ProblemCatalog.FromSqlState(e.SqlState) is { } info
            ? ProblemException.FromInfo(info, e.Detail ?? e.MessageText)
            : e;
}

public sealed record RoundLock(Guid RoundId, Guid RoomId, string Status, int CurrentLayer);

/// <summary>What a command returns; <paramref name="Version"/> is the bumped
/// <c>rooms.version</c>, or null when it wrote nothing.</summary>
public sealed record CommandOutcome<T>(T Result, long? Version);

public sealed class StoreSession(NpgsqlConnection connection, NpgsqlTransaction transaction) : IAsyncDisposable
{
    private RfbDbContext? _db;

    public NpgsqlConnection Connection { get; } = connection;
    public NpgsqlTransaction Transaction { get; } = transaction;

    public RfbDbContext Db => _db ??= CreateDb();

    /// <summary>Whether C# decides this round's advancement (#547). A room row beats the
    /// global row; no row means off. An unknown round reads the global row, and either path
    /// answers it with the same noop.</summary>
    public async Task<bool> AdvanceIsAuthoritative(Guid roundId, CancellationToken ct = default)
    {
        await using var cmd = new NpgsqlCommand("""
            select f.enabled
              from public.port_flags f
             where f.slice = 'advanceRoundAuthoritative'
               and (f.room_id is null or f.room_id = (select room_id from public.rounds where id = @round))
             order by f.room_id nulls last
             limit 1
            """, Connection, Transaction);
        cmd.Parameters.AddWithValue("round", roundId);
        return await cmd.ExecuteScalarAsync(ct) is true;
    }

    public async Task<string> CurrentPlayerId(Guid? roundId = null, Guid? roomId = null, CancellationToken ct = default)
    {
        await using var cmd = new NpgsqlCommand("select public.current_player_id(@round, @room)", Connection, Transaction);
        cmd.Parameters.Add(new NpgsqlParameter("round", NpgsqlTypes.NpgsqlDbType.Uuid) { Value = (object?)roundId ?? DBNull.Value });
        cmd.Parameters.Add(new NpgsqlParameter("room", NpgsqlTypes.NpgsqlDbType.Uuid) { Value = (object?)roomId ?? DBNull.Value });
        return (string)(await cmd.ExecuteScalarAsync(ct))!;
    }

    private RfbDbContext CreateDb()
    {
        var db = new RfbDbContext(new DbContextOptionsBuilder<RfbDbContext>().UseNpgsql(Connection).Options);
        db.Database.UseTransaction(Transaction);
        return db;
    }

    public async ValueTask DisposeAsync()
    {
        if (_db is not null) await _db.DisposeAsync();
    }
}
