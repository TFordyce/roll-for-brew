using System.Data;
using Microsoft.EntityFrameworkCore;
using Npgsql;
using RollForBrew.Api.Auth;
using RollForBrew.Api.Problems;

namespace RollForBrew.Api.Data;

/// <summary>
/// The one data module (ADR 0012). Hides the connection, pooler settings, the explicit transaction,
/// the claims GUC and RFBnn translation. Slice 0b ships the Read and Filler entry points;
/// Command (round lock, snapshot, write batch, broadcast) arrives with the first Command slice.
/// </summary>
public sealed class RoomStore
{
    private readonly NpgsqlDataSource _dataSource;

    public RoomStore(NpgsqlDataSource dataSource) => _dataSource = dataSource;

    /// <summary>Spec pooler settings, applied over whatever the configured string says.</summary>
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

    /// <summary>A read-only touch: one explicit READ ONLY transaction, always rolled back.</summary>
    public Task<T> Read<T>(Caller actor, Func<StoreSession, Task<T>> work, CancellationToken ct = default) =>
        Run(actor, readOnly: true, work, ct);

    /// <summary>A write to a Filler table (EF Core): one explicit transaction, committed on success.</summary>
    public Task<T> Filler<T>(Caller actor, Func<StoreSession, Task<T>> work, CancellationToken ct = default) =>
        Run(actor, readOnly: false, work, ct);

    private async Task<T> Run<T>(Caller actor, bool readOnly, Func<StoreSession, Task<T>> work, CancellationToken ct)
    {
        try
        {
            await using var conn = await _dataSource.OpenConnectionAsync(ct);
            await using var tx = await conn.BeginTransactionAsync(IsolationLevel.ReadCommitted, ct);

            // Transaction-local, so nothing leaks through the pooler to the next client.
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

    /// <summary>A SQL-raised RFBnn becomes its named problem; anything else is rethrown as-is (the handler hides it).</summary>
    public static Exception Translate(PostgresException e) =>
        ProblemCatalog.FromSqlState(e.SqlState) is { } info
            ? ProblemException.FromInfo(info, e.Detail ?? e.MessageText)
            : e;
}

/// <summary>One open transaction handed to a RoomStore entry point.</summary>
public sealed class StoreSession(NpgsqlConnection connection, NpgsqlTransaction transaction) : IAsyncDisposable
{
    private RfbDbContext? _db;

    public NpgsqlConnection Connection { get; } = connection;
    public NpgsqlTransaction Transaction { get; } = transaction;

    /// <summary>EF Core context bound to this transaction (Filler tables).</summary>
    public RfbDbContext Db => _db ??= CreateDb();

    /// <summary>
    /// The real or Acting-As player id, resolved by SQL current_player_id (ADR 0001, ADR 0009).
    /// Pass the round or room in scope so the Test Room override can apply.
    /// </summary>
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
