using Npgsql;
using RollForBrew.Tests.Harness;

namespace RollForBrew.Tests;

public class RfbApiRoleTests : IAsyncLifetime
{
    private TestDatabase _db = null!;

    public async Task InitializeAsync() => _db = await TestPostgres.CreateDatabase();
    public Task DisposeAsync() => _db.DisposeAsync().AsTask();

    private Task<bool> Flag(string sql) => _db.Scalar<bool>(sql);

    [Fact]
    public async Task Role_bypasses_rls_but_is_not_superuser_or_ddl()
    {
        Assert.True(await Flag("select rolbypassrls from pg_roles where rolname = 'rfb_api'"));
        Assert.True(await Flag("select rolcanlogin from pg_roles where rolname = 'rfb_api'"));
        Assert.False(await Flag("select rolsuper from pg_roles where rolname = 'rfb_api'"));
        Assert.False(await Flag("select rolcreaterole or rolcreatedb from pg_roles where rolname = 'rfb_api'"));
        Assert.False(await Flag("select has_schema_privilege('rfb_api', 'public', 'create')"));
    }

    [Fact]
    public async Task Role_has_its_own_statement_timeout()
    {
        var cfg = await _db.Scalar<string[]>("select rolconfig from pg_roles where rolname = 'rfb_api'");
        Assert.Contains(cfg!, c => c.StartsWith("statement_timeout="));
    }

    [Fact]
    public async Task Role_has_no_authenticated_membership_and_no_auth_or_realtime_usage()
    {
        Assert.False(await Flag("select pg_has_role('rfb_api', 'authenticated', 'member')"));
        Assert.False(await Flag("select has_schema_privilege('rfb_api', 'auth', 'usage')"));
        Assert.False(await Flag("select exists (select 1 from pg_namespace where nspname = 'realtime') and has_schema_privilege('rfb_api', 'realtime', 'usage')"));
    }

    [Fact]
    public async Task Role_has_dml_on_public_and_execute_on_current_player_id_only_where_bridged()
    {
        Assert.True(await Flag("select has_table_privilege('rfb_api', 'public.admin_acting_as', 'select,insert,update,delete')"));
        Assert.True(await Flag("select has_function_privilege('rfb_api', 'public.current_player_id(uuid, uuid)', 'execute')"));
        Assert.False(await Flag("select has_function_privilege('rfb_api', 'public.get_acting_as()', 'execute')"));
    }

    [Fact]
    public async Task Login_works_and_cannot_create_objects_or_touch_auth()
    {
        await using var conn = new NpgsqlConnection(_db.ApiConnectionString);
        await conn.OpenAsync();
        await Assert.ThrowsAsync<PostgresException>(async () =>
        {
            await using var c = new NpgsqlCommand("create table public.nope (id int)", conn);
            await c.ExecuteNonQueryAsync();
        });
        await Assert.ThrowsAsync<PostgresException>(async () =>
        {
            await using var c = new NpgsqlCommand("select * from auth.users", conn);
            await c.ExecuteScalarAsync();
        });
    }
}
