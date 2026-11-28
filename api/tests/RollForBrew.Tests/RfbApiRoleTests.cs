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
    public async Task The_SQL_functions_the_API_replaced_are_gone()
    {
        foreach (var name in new[]
        {
            "enter_todays_room", "set_acting_as", "advance_layer", "finalize_layer", "resolve_round",
            "_rr_resolve", "_rr_resolve_eval", "get_round_recap", "admin_backfill_round",
            "start_round", "declare_in", "declare_in_late", "withdraw_declaration", "close_round",
            "cancel_round", "exclude_round_participant", "confirm_round_replay", "decline_round_replay",
            "submit_roll", "submit_manual_roll", "submit_roll_as", "submit_manual_roll_as", "admin_proxy_roll",
        })
            Assert.False(await Flag($"select exists (select 1 from pg_proc where proname = '{name}' and pronamespace = 'public'::regnamespace)"), name);
    }

    [Fact]
    public async Task Role_has_execute_on_the_round_lifecycle_bridges()
    {
        foreach (var bridge in new[]
        {
            "_fan_out_table_placeholder_casts(uuid, uuid)", "_fix_compelled_set(uuid)",
            "_forfeit_compelled_card(uuid, text, text)", "_rr_scrap_round(uuid)",
        })
            Assert.True(await Flag($"select has_function_privilege('rfb_api', 'public.{bridge}', 'execute')"), bridge);
    }

    [Fact]
    public async Task Role_has_execute_on_the_crit_redirect_bridge()
    {
        foreach (var bridge in new[]
        {
            "_apply_crit_redirect(uuid, text)", "_rr_active_effects_as_of(uuid, uuid)",
            "_rr_participated_rounds_elapsed(uuid, text, timestamptz, timestamptz)",
        })
            Assert.True(await Flag($"select has_function_privilege('rfb_api', 'public.{bridge}', 'execute')"), bridge);
    }

    [Fact]
    public async Task Role_has_execute_on_the_card_landing_bridge_but_not_the_draw_entry_points()
    {
        foreach (var bridge in new[] { "_land_drawn_instance(text, uuid, text)", "_lock_next_draw_mark(text)", "_rr_free_hand_slot(text)" })
            Assert.True(await Flag($"select has_function_privilege('rfb_api', 'public.{bridge}', 'execute')"), bridge);
        foreach (var replaced in new[]
        {
            "record_pending_spell_draw(uuid, text)", "draw_pending_spell_card(uuid)",
            "draw_pending_spell_card_manual(uuid, uuid)", "draw_spell_card_as(text, uuid, text, uuid, uuid)",
        })
            Assert.False(await Flag($"select has_function_privilege('rfb_api', 'public.{replaced}', 'execute')"), replaced);
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
