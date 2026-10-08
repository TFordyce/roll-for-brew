using Npgsql;
using Testcontainers.PostgreSql;

namespace RollForBrew.Tests.Harness;

/// <summary>
/// Seam 2 harness (spec #533). One plain-Postgres container per test run. The repo migrations are applied
/// once, over stubs for the Supabase-only pieces, into a template database; every test class then gets its
/// own database via CREATE DATABASE ... TEMPLATE, so classes run in parallel with no shared rows.
///
/// Usage: <c>await using var db = await TestPostgres.CreateDatabase();</c> in an IAsyncLifetime.
/// </summary>
public static class TestPostgres
{
    public const string ApiRolePassword = "rfb_api_test_pw";
    private const string Template = "rfb_template";

    private static readonly Lazy<Task<State>> Shared = new(Start);
    private static readonly SemaphoreSlim CloneLock = new(1, 1);
    private static int _counter;

    private sealed record State(PostgreSqlContainer Container, NpgsqlConnectionStringBuilder Admin);

    public static async Task<TestDatabase> CreateDatabase()
    {
        var s = await Shared.Value;
        var name = $"t_{Interlocked.Increment(ref _counter)}_{Guid.NewGuid():N}"[..30];
        await CloneLock.WaitAsync(); // CREATE DATABASE ... TEMPLATE needs the template idle; serialise the clones only
        try
        {
            await using var conn = new NpgsqlConnection(s.Admin.ConnectionString);
            await conn.OpenAsync();
            await using var cmd = new NpgsqlCommand($"create database \"{name}\" template {Template}", conn);
            await cmd.ExecuteNonQueryAsync();
        }
        finally { CloneLock.Release(); }
        return new TestDatabase(s.Admin, name);
    }

    private static async Task<State> Start()
    {
        var container = new PostgreSqlBuilder("postgres:17").Build();
        await container.StartAsync();
        var admin = new NpgsqlConnectionStringBuilder(container.GetConnectionString()) { Pooling = false, Database = "postgres" };

        await using (var conn = new NpgsqlConnection(admin.ConnectionString))
        {
            await conn.OpenAsync();
            await Exec(conn, $"create database {Template}");
        }

        var tpl = new NpgsqlConnectionStringBuilder(admin.ConnectionString) { Database = Template };
        await using (var conn = new NpgsqlConnection(tpl.ConnectionString))
        {
            await conn.OpenAsync();
            await Exec(conn, SupabaseStubs.Sql);
            foreach (var file in Directory.GetFiles(FindMigrationsDir(), "*.sql").OrderBy(Path.GetFileName, StringComparer.Ordinal))
                await Exec(conn, await File.ReadAllTextAsync(file), Path.GetFileName(file));
            // Hosted sets this by hand (docs/port/rfb-api-role-runbook.md); tests set a known one.
            await Exec(conn, $"alter role rfb_api password '{ApiRolePassword}'");
        }
        return new State(container, admin);
    }

    private static async Task Exec(NpgsqlConnection conn, string sql, string? label = null)
    {
        try
        {
            await using var cmd = new NpgsqlCommand(sql, conn);
            await cmd.ExecuteNonQueryAsync();
        }
        catch (Exception e)
        {
            throw new InvalidOperationException($"Template setup failed in {label ?? "stubs"}: {e.Message}", e);
        }
    }

    private static string FindMigrationsDir()
    {
        for (var dir = new DirectoryInfo(AppContext.BaseDirectory); dir is not null; dir = dir.Parent)
        {
            var candidate = Path.Combine(dir.FullName, "supabase", "migrations");
            if (Directory.Exists(candidate)) return candidate;
        }
        throw new DirectoryNotFoundException("supabase/migrations not found above " + AppContext.BaseDirectory);
    }
}

/// <summary>One per-class database. Connect as the owner for seeding, or as rfb_api to behave like the API.</summary>
public sealed class TestDatabase(NpgsqlConnectionStringBuilder admin, string name) : IAsyncDisposable
{
    public string Name { get; } = name;

    public string AdminConnectionString =>
        new NpgsqlConnectionStringBuilder(admin.ConnectionString) { Database = Name }.ConnectionString;

    /// <summary>The API's own login: what RoomStore and the HTTP host connect with.</summary>
    public string ApiConnectionString =>
        new NpgsqlConnectionStringBuilder(admin.ConnectionString)
        {
            Database = Name,
            Username = "rfb_api",
            Password = TestPostgres.ApiRolePassword,
        }.ConnectionString;

    public async Task Execute(string sql)
    {
        await using var conn = new NpgsqlConnection(AdminConnectionString);
        await conn.OpenAsync();
        await using var cmd = new NpgsqlCommand(sql, conn);
        await cmd.ExecuteNonQueryAsync();
    }

    public async Task<T?> Scalar<T>(string sql)
    {
        await using var conn = new NpgsqlConnection(AdminConnectionString);
        await conn.OpenAsync();
        await using var cmd = new NpgsqlCommand(sql, conn);
        var v = await cmd.ExecuteScalarAsync();
        return v is null or DBNull ? default : (T)v;
    }

    /// <summary>Creates an auth.users row; the migration trigger derives the players row (id = Google sub).</summary>
    public async Task<TestUser> AddUser(string googleSub, bool admin = false)
    {
        var id = Guid.NewGuid();
        await Execute($$"""
            insert into auth.users (id, email, raw_user_meta_data)
            values ('{{id}}', '{{googleSub}}@example.test', '{"sub":"{{googleSub}}","full_name":"{{googleSub}}"}');
            """);
        if (admin) await Execute($"update public.players set is_admin = true where id = '{googleSub}'");
        return new TestUser(id, googleSub);
    }

    public ValueTask DisposeAsync()
    {
        // The container (and every database in it) is reaped by Testcontainers at process end.
        return ValueTask.CompletedTask;
    }
}

/// <summary>AuthId is the Supabase user id (the JWT sub); PlayerId is the Google sub (players.id).</summary>
public sealed record TestUser(Guid AuthId, string PlayerId);
