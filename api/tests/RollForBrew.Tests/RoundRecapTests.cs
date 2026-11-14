using System.Text.Json.Nodes;
using System.Text.RegularExpressions;
using Npgsql;
using RollForBrew.Api.Auth;
using RollForBrew.Api.Data;
using RollForBrew.Api.Problems;
using RollForBrew.Api.RoundRecap;
using RollForBrew.Tests.Harness;
using static RollForBrew.Tests.AdvanceRoundScenarioTests;

namespace RollForBrew.Tests;

/// <summary>
/// The Round Recap (#548) read through C#: provisional and stored, the states the golden snapshots
/// never hold, and the refusals. They began as comparisons with get_round_recap; that SQL is gone
/// (#549), so each now asserts the Recap itself. Every read also proves the preview left the
/// database untouched.
/// </summary>
public class RoundRecapTests
{
    // ------------------------------------------------------------------
    // Handwritten: states the goldens' captured snapshots never hold.
    // ------------------------------------------------------------------

    private static async Task<(TestDatabase Db, TestUser Viewer)> Three(int a = 17, int b = 6, int c = 12, bool window = true)
    {
        var db = await TestPostgres.CreateDatabase();
        await SeedThree(db, a, b, c, window);
        return (db, await db.AddUser("p-a"));
    }

    private static async Task<(TestDatabase Db, TestUser Viewer)> Exempt(string casters, bool rolled, bool immune = true)
    {
        var (db, viewer) = await Three(window: false);
        var id = 1;
        foreach (var caster in casters.Split(','))
        {
            await SeedShimCast(db, "brewer_immunity", "Tea Cosy", caster: caster, target: caster,
                effectParams: """{"mode": "tea_cosy", "exempt_from_rolling": true}""", id: id++, attached: false);
            await db.Execute($"delete from public.rolls where round_id = '{Round}' and player_id = '{caster}'");
            if (immune)
                await db.Execute($$"""
                    insert into public.spell_active_effects (id, room_id, target_player_id, caster_id, source_cast_id, card_id, effect_kind, effect_params)
                      values ('60000000-0000-4000-8000-00000000000{{id - 1}}', '{{Room}}', '{{caster}}', '{{caster}}', '50000000-0000-4000-8000-00000000000{{id - 1}}',
                              (select id from public.spell_cards where name = 'Tea Cosy'), 'brewer_immunity', '{"mode": "tea_cosy", "exempt_from_rolling": true}');
                    """);
        }
        if (!rolled) await db.Execute($"delete from public.rolls where round_id = '{Round}'");
        return (db, viewer);
    }

    [Fact]
    public async Task A_round_with_nothing_rolled_is_not_provisional_and_reveals_nothing()
    {
        var (db, viewer) = await Three();
        await db.Execute($"delete from public.rolls where round_id = '{Round}' and player_id = 'p-a'");
        var recap = await Same(db, Round, viewer);
        Assert.False((bool)recap["provisional"]!);
        Assert.Empty(recap["layers"]!.AsArray());
    }

    [Fact]
    public async Task An_open_round_reads_as_armed_casts_off_the_stack()
    {
        var (db, viewer) = await Three();
        await db.Execute($"update public.rounds set status = 'open', closed_at = null where id = '{Round}'; delete from public.rolls where round_id = '{Round}'");
        await SeedShimCast(db, "flat_modifier", "Yorkshire Terror", caster: "p-b", target: "p-a", attached: false);
        var recap = await Same(db, Round, viewer);
        Assert.False((bool)recap["casts"]![0]!["on_stack"]!);
    }

    [Fact]
    public async Task A_calami_tea_tick_in_a_preview_rolls_nothing_and_writes_nothing()
    {
        var (db, viewer) = await Three();
        await db.Execute($$"""
            insert into public.spell_deck_instances (id, card_id, location)
              select '40000000-0000-4000-8000-000000000001', id, 'in_deck' from public.spell_cards where name = 'Calami-Tea';
            insert into public.spell_casts (id, round_id, caster_id, card_instance_id, target_player_id, effect_kind, effect_params)
              values ('50000000-0000-4000-8000-000000000001', '{{Round}}', 'p-c', '40000000-0000-4000-8000-000000000001', 'p-a', 'per_round_dice_tick', '{"die": 4, "sign": -1}');
            insert into public.spell_active_effects (id, room_id, target_player_id, caster_id, source_cast_id, card_id, effect_kind, effect_params)
              values ('60000000-0000-4000-8000-000000000001', '{{Room}}', 'p-a', 'p-c', '50000000-0000-4000-8000-000000000001',
                      (select id from public.spell_cards where name = 'Calami-Tea'), 'per_round_dice_tick', '{"die": 4, "sign": -1}');
            """);
        var ticks = $"select count(*) from public.spell_casts where cast_inputs ? 'dice_tick'";
        var recap = await Same(db, Round, viewer);
        var tick = recap["trace"]!.AsArray().First(s => (string?)s!["display_kind"] == "dice_tick");
        Assert.Null(tick!["rolled"]);
        Assert.Equal(0L, await db.Scalar<long>(ticks));
    }

    [Fact]
    public async Task A_countered_exemption_stays_exempt_until_the_window_closes()
    {
        var (db, viewer) = await Exempt("p-a", rolled: true);
        await db.Execute($$"""
            insert into public.spell_reaction_windows (id, round_id, layer, status, poll_round, opened_at)
              values ('{{Window}}', '{{Round}}', 0, 'open', 1, now());
            insert into public.spell_deck_instances (id, card_id, location)
              select '40000000-0000-4000-8000-000000000005', id, 'in_deck' from public.spell_cards where name = 'Yorkshire Terror';
            insert into public.spell_casts (id, round_id, caster_id, card_instance_id, parent_cast_id, effect_kind, cast_inputs, reaction_window_id)
              values ('50000000-0000-4000-8000-000000000005', '{{Round}}', 'p-b', '40000000-0000-4000-8000-000000000005',
                      '50000000-0000-4000-8000-000000000001', 'contested_negate', '{"dc_d20": 20}', '{{Window}}');
            """);
        var open = await Same(db, Round, viewer);
        Assert.True((bool)open["provisional"]!);
        Assert.Contains(open["trace"]!.AsArray(), s => (string?)s!["display_kind"] == "roll_exemption");

        await db.Execute($"update public.spell_reaction_windows set status = 'closed', closed_at = now() where id = '{Window}'");
        await Same(db, Round, viewer);
    }

    [Fact]
    public async Task A_debt_round_previews_its_debtor()
    {
        var yesterday = Guid.Parse("10000000-0000-4000-8000-000000000002");
        var iou = Guid.Parse("20000000-0000-4000-8000-000000000002");
        var (db, viewer) = await Three(window: false);
        await db.Execute($$"""
            delete from public.rolls where round_id = '{{Round}}';
            insert into public.rooms (id, date) values ('{{yesterday}}', '2025-12-31');
            insert into public.rounds (id, room_id, started_by, status, started_at, closed_at, resolved_at, brewer_id, cups_made) values
              ('{{iou}}', '{{yesterday}}', 'p-a', 'resolved', '2025-12-31 09:00+00', '2025-12-31 09:01+00', '2025-12-31 09:02+00', 'p-b', 2);
            insert into public.round_participants (round_id, player_id) values ('{{iou}}', 'p-a'), ('{{iou}}', 'p-b');
            insert into public.spell_deck_instances (id, card_id, location)
              select '40000000-0000-4000-8000-000000000001', id, 'in_deck' from public.spell_cards where name = 'Brew IOU';
            insert into public.spell_casts (id, round_id, caster_id, card_instance_id, target_player_id, effect_kind, effect_params)
              values ('50000000-0000-4000-8000-000000000001', '{{iou}}', 'p-a', '40000000-0000-4000-8000-000000000001', 'p-b', 'tea_maker_override', '{"mode": "chosen"}');
            update public.rounds set brewer_source = 'brew_iou', brewer_source_cast_id = '50000000-0000-4000-8000-000000000001' where id = '{{iou}}';
            """);
        Assert.True((bool)(await Same(db, Round, viewer))["provisional"]!);
    }

    [Fact]
    public async Task The_latest_windows_skips_name_who_was_not_heard_from()
    {
        var (db, viewer) = await Three();
        await db.Execute($"""
            insert into public.spell_reaction_passes (window_id, player_id, poll_round, reason) values
              ('{Window}', 'p-c', 1, 'timeout'), ('{Window}', 'p-b', 1, 'vote'), ('{Window}', 'p-a', 1, 'pass');
            """);
        var recap = await Same(db, Round, viewer);
        Assert.Equal(2, recap["reaction_skips"]!.AsArray().Count);
    }

    // ------------------------------------------------------------------
    // #466: which holds keep a Provisional Recap back, and which it shows through.
    // ------------------------------------------------------------------

    private static Task SeedHold(TestDatabase db, string kind, string effectParams = "{}", bool pending = false, string? inputs = null) =>
        db.Execute($$"""
            insert into public.spell_deck_instances (id, card_id, location)
              select '40000000-0000-4000-8000-000000000007', id, 'in_deck' from public.spell_cards where name = 'Yorkshire Terror';
            insert into public.spell_casts (id, round_id, caster_id, card_instance_id, target_pending, effect_kind, effect_params, cast_inputs)
              values ('50000000-0000-4000-8000-000000000007', '{{Round}}', 'p-c', '40000000-0000-4000-8000-000000000007', {{pending}}, '{{kind}}', '{{effectParams}}', '{{inputs ?? "{}"}}');
            """);

    private const string OwesAction = """{"compelled": [{"player_id": "p-a", "card_instance_id": "40000000-0000-4000-8000-000000000009", "casting_time": "A"}]}""";

    [Theory]
    [InlineData("dice_modifier", "{}", false)]
    [InlineData("forced_reroll", "{}", true)]
    public async Task A_pending_die_or_a_deferred_target_holds_the_recap_back(string kind, string effectParams, bool pending)
    {
        var (db, viewer) = await Three(window: false);
        await SeedHold(db, kind, effectParams, pending);
        Assert.False((bool)(await Same(db, Round, viewer))["provisional"]!);
    }

    [Fact]
    public async Task A_revolt_pick_shows_through_as_pick_pending()
    {
        var (db, viewer) = await Three(window: false);
        await SeedHold(db, "tea_maker_override", """{"mode": "chosen", "picker": "lowest_roller"}""");
        var recap = await Same(db, Round, viewer);
        Assert.True((bool)recap["provisional"]!);
        Assert.Contains("pick_pending", recap["trace"]!.ToJsonString());
    }

    [Fact]
    public async Task An_owed_compelled_cast_is_held_back_by_the_roll_count_while_rolling_is_held()
    {
        var (db, viewer) = await Three(window: false);
        await SeedHold(db, "compel_cast", inputs: OwesAction);
        await db.Execute($"delete from public.rolls where round_id = '{Round}'");
        Assert.False((bool)(await Same(db, Round, viewer))["provisional"]!);
    }

    [Fact]
    public async Task An_owed_compelled_cast_shows_through_when_nobody_is_left_to_roll()
    {
        // The one way past the roll count: everyone exempt, so zero rolls are enough.
        var (db, viewer) = await Exempt("p-a,p-b,p-c", rolled: false);
        await SeedHold(db, "compel_cast", inputs: OwesAction);
        Assert.True((bool)(await Same(db, Round, viewer))["provisional"]!);
    }

    [Fact]
    public async Task A_spectator_in_the_room_may_read_and_nobody_else()
    {
        var (db, _) = await Three();
        var spectator = await db.AddUser("g-spectator");
        await db.Execute($"insert into public.room_players (room_id, player_id) values ('{Room}', 'g-spectator')");
        await Same(db, Round, spectator);

        var stranger = await db.AddUser("g-stranger");
        var problem = await Assert.ThrowsAsync<ProblemException>(() => CSharpRecap(db, Round, stranger));
        Assert.Equal("recap_not_in_room", problem.Code);
        Assert.Equal(403, problem.Status);
    }

    [Fact]
    public async Task A_missing_round_is_refused()
    {
        var (db, viewer) = await Three();
        var missing = Guid.NewGuid();
        var problem = await Assert.ThrowsAsync<ProblemException>(() => CSharpRecap(db, missing, viewer));
        Assert.Equal("round_not_found", problem.Code);
    }

    [Fact]
    public async Task An_admin_acting_as_a_player_in_the_test_room_reads_as_that_player()
    {
        var (db, _) = await Three();
        var admin = await db.AddUser("g-admin", admin: true);
        await db.Execute($"""
            update public.rooms set is_test = true, date = null where id = '{Room}';
            insert into public.admin_acting_as (admin_player_id, acting_as_player_id) values ('g-admin', 'p-a');
            """);
        Assert.True((bool)(await Same(db, Round, admin))["provisional"]!);
    }

    [Fact]
    public async Task A_recap_reads_a_scrapped_generation_through_untouched()
    {
        var (db, viewer) = await Three();
        await db.Execute($$"""
            update public.rounds
               set scrapped_generations = '[{"generation": 0, "brewer_id": "p-b", "cups_made": 3, "resolution_trace": [], "rolls": [], "layer_participants": [], "x": 1.50}]'
             where id = '{{Round}}';
            """);
        var recap = await Same(db, Round, viewer);
        Assert.Contains("1.50", recap["scrapped_generations"]!.ToJsonString());
    }

    [Fact]
    public async Task A_preview_bumps_no_version_and_sends_nothing()
    {
        var (db, viewer) = await Three();
        await CSharpRecap(db, Round, viewer);
        Assert.Equal(0L, await db.Scalar<long>($"select version from public.rooms where id = '{Room}'"));
        Assert.Equal(0L, await db.Scalar<long>("select count(*) from realtime.messages"));
    }

    [Fact]
    public async Task Everyone_exempt_with_nobody_immune_previews_no_brewer()
    {
        var (db, viewer) = await Exempt("p-a,p-b,p-c", rolled: false, immune: false);
        Assert.True((bool)(await Same(db, Round, viewer))["provisional"]!);
    }

    [Fact]
    public async Task A_recap_read_does_not_wait_on_a_round_being_finalized()
    {
        var (db, viewer) = await Three();
        await using var conn = new NpgsqlConnection(db.AdminConnectionString);
        await conn.OpenAsync();
        await using var tx = await conn.BeginTransactionAsync();
        await using (var hold = new NpgsqlCommand($"select 1 from public.rounds where id = '{Round}' for update", conn, tx))
            await hold.ExecuteScalarAsync();

        var read = CSharpRecap(db, Round, viewer);
        var first = await Task.WhenAny(read, Task.Delay(TimeSpan.FromSeconds(10)));

        Assert.Same(read, first);
        Assert.True((bool)(await read)["provisional"]!);
    }

    [Fact]
    public async Task A_resolved_round_with_no_stored_summary_reads_the_same()
    {
        var (db, viewer) = await Three();
        await db.Execute($"""
            update public.rounds set status = 'resolved', resolved_at = now(), brewer_id = 'p-b', cups_made = 3,
                   resolution_trace = null, resolution_summary = null where id = '{Round}'
            """);

        var recap = await Same(db, Round, viewer);

        Assert.False((bool)recap["provisional"]!);
        Assert.Null(recap["players"]);
        Assert.Empty(recap["trace"]!.AsArray());
    }

    /// <summary>Reads the Recap through C# and proves the read wrote nothing.</summary>
    internal static async Task<JsonObject> Same(TestDatabase db, Guid roundId, TestUser viewer)
    {
        var before = await State(db);
        var recap = await CSharpRecap(db, roundId, viewer);
        Assert.Equal(before, await State(db));
        return recap;
    }

    internal static async Task<JsonObject> CSharpRecap(TestDatabase db, Guid roundId, TestUser viewer)
    {
        await using var ds = RoomStore.BuildDataSource(db.ApiConnectionString);
        return await RoundRecapReader.Read(new RoomStore(ds), CallerOf(viewer), roundId);
    }

    internal static Caller CallerOf(TestUser u) =>
        new(u.AuthId.ToString(), $$"""{"sub":"{{u.AuthId}}","role":"authenticated"}""");

}
