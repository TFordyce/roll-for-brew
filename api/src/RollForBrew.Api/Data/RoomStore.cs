using System.Data;
using Microsoft.EntityFrameworkCore;
using Npgsql;
using RollForBrew.Api.Auth;
using RollForBrew.Api.Problems;

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
        Run(actor, readOnly: true, work, ct);

    public Task<T> Filler<T>(Caller actor, Func<StoreSession, Task<T>> work, CancellationToken ct = default) =>
        Run(actor, readOnly: false, work, ct);

    private async Task<T> Run<T>(Caller actor, bool readOnly, Func<StoreSession, Task<T>> work, CancellationToken ct)
    {
        try
        {
            await using var conn = await _dataSource.OpenConnectionAsync(ct);
            await using var tx = await conn.BeginTransactionAsync(IsolationLevel.ReadCommitted, ct);

            await using (var cmd = new NpgsqlCommand("select set_config('request.jwt.claims', @c, true)", conn, tx))
            {
                cmd.Parameters.AddWithValue("c", actor.ClaimsJson);
                await cmd.ExecuteNonQueryAsync(ct);
            }
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
    }

    public static Exception Translate(PostgresException e) =>
        ProblemCatalog.FromSqlState(e.SqlState) is { } info
            ? ProblemException.FromInfo(info, e.Detail ?? e.MessageText)
            : e;
}

public sealed class StoreSession(NpgsqlConnection connection, NpgsqlTransaction transaction) : IAsyncDisposable
{
    private RfbDbContext? _db;

    public NpgsqlConnection Connection { get; } = connection;
    public NpgsqlTransaction Transaction { get; } = transaction;

    public RfbDbContext Db => _db ??= CreateDb();

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
