using System.Text.Json;
using System.Text.Json.Nodes;
using System.Text.RegularExpressions;
using Npgsql;
using RollForBrew.Api.Auth;
using RollForBrew.Api.Data;
using RollForBrew.Domain.Commands;
using RollForBrew.Domain.Dice;
using RollForBrew.Tests.Harness;

namespace RollForBrew.Tests;

/// <summary>
/// Handwritten advance and finalize scenarios (#547), each seeded by hand and run through the
/// C# <see cref="AdvanceRound"/>. They began as SQL-versus-C# parity cases; the SQL path is gone
/// (#549), so each now asserts the outcome the SQL used to pin. The golden scenarios are the
/// evaluator's oracle (<c>GoldenEvaluateTests</c>).
/// </summary>
public partial class AdvanceRoundScenarioTests
{
    // ------------------------------------------------------------------
    // The finalize shim: un-applied transforms the goldens never carry, because the corpus
    // captures its snapshots after the shim has run.
    // ------------------------------------------------------------------

    internal static readonly Guid Room = Guid.Parse("10000000-0000-4000-8000-000000000001");
    internal static readonly Guid Round = Guid.Parse("20000000-0000-4000-8000-000000000001");
    internal static readonly Guid Window = Guid.Parse("30000000-0000-4000-8000-000000000001");

    internal static async Task SeedThree(TestDatabase db, int a = 17, int b = 6, int c = 12, bool window = true)
    {
        await db.Execute($"""
            insert into public.players (id, email) values ('p-a', 'a@x.test'), ('p-b', 'b@x.test'), ('p-c', 'c@x.test');
            insert into public.rooms (id, date) values ('{Room}', '2026-01-01');
            insert into public.rounds (id, room_id, started_by, status, started_at, closed_at) values
              ('{Round}', '{Room}', 'p-a', 'closed', '2026-01-01 09:00+00', '2026-01-01 09:01+00');
            insert into public.round_participants (round_id, player_id) values ('{Round}', 'p-a'), ('{Round}', 'p-b'), ('{Round}', 'p-c');
            insert into public.room_players (room_id, player_id, modifier) values ('{Room}', 'p-a', 0), ('{Room}', 'p-b', 0), ('{Room}', 'p-c', 0);
            insert into public.rolls (round_id, player_id, layer, value, input_mode, modifier_snapshot) values
              ('{Round}', 'p-a', 0, {a}, 'in_app', 0), ('{Round}', 'p-b', 0, {b}, 'in_app', 0), ('{Round}', 'p-c', 0, {c}, 'in_app', 0);
            """);
        if (window)
            await db.Execute($"""
                insert into public.spell_reaction_windows (id, round_id, layer, status, poll_round, opened_at, closed_at)
                  values ('{Window}', '{Round}', 0, 'closed', 1, now(), now());
                """);
    }

    internal static Task SeedShimCast(TestDatabase db, string kind, string card, string caster = "p-c", string? target = null,
        string effectParams = "{}", string castInputs = "{}", int id = 1, bool attached = true) =>
        db.Execute($$"""
            insert into public.spell_deck_instances (id, card_id, location)
              select '40000000-0000-4000-8000-00000000000{{id}}', id, 'in_deck' from public.spell_cards where name = '{{card}}';
            insert into public.spell_casts (id, round_id, caster_id, card_instance_id, target_player_id, effect_kind, effect_params, cast_inputs, reaction_window_id)
              values ('50000000-0000-4000-8000-00000000000{{id}}', '{{Round}}', '{{caster}}', '40000000-0000-4000-8000-00000000000{{id}}',
                      {{(target is null ? "null" : $"'{target}'")}}, '{{kind}}', '{{effectParams}}', '{{castInputs}}', {{(attached ? $"'{Window}'" : "null")}});
            """);

    private static Task SeedWard(TestDatabase db, string target, string polarity, int id = 8) =>
        db.Execute($$"""
            insert into public.spell_deck_instances (id, card_id, location)
              select '40000000-0000-4000-8000-00000000000{{id}}', id, 'in_deck' from public.spell_cards where name = 'Cast-Iron Kettle';
            insert into public.spell_casts (id, round_id, caster_id, card_instance_id, target_player_id, effect_kind, effect_params)
              values ('50000000-0000-4000-8000-00000000000{{id}}', '{{Round}}', '{{target}}', '40000000-0000-4000-8000-00000000000{{id}}', '{{target}}',
                      'ward', '{"domain": ["roll"], "polarity": ["{{polarity}}"]}');
            insert into public.spell_active_effects (id, room_id, target_player_id, caster_id, source_cast_id, card_id, effect_kind, effect_params)
              values ('60000000-0000-4000-8000-00000000000{{id}}', '{{Room}}', '{{target}}', '{{target}}', '50000000-0000-4000-8000-00000000000{{id}}',
                      (select id from public.spell_cards where name = 'Cast-Iron Kettle'), 'ward', '{"domain": ["roll"], "polarity": ["{{polarity}}"]}');
            """);

    [Fact]
    public async Task An_unapplied_flip_is_recorded_and_flips_every_roll()
    {
        var csharp = await Run(async db =>
        {
            await SeedThree(db);
            await SeedShimCast(db, "roll_flip", "Yorkshire Terror");
        }, Round, AdvanceRound.Entry.Finalize);
        Assert.Equal(4, await csharp.Scalar<int>($"select value from public.rolls where round_id = '{Round}' and player_id = 'p-a'"));
    }

    [Fact]
    public async Task An_unapplied_swap_exchanges_high_and_low()
    {
        var csharp = await Run(async db =>
        {
            await SeedThree(db);
            await SeedShimCast(db, "roll_swap", "Yorkshire Terror");
        }, Round, AdvanceRound.Entry.Finalize);
        Assert.Equal(6, await csharp.Scalar<int>($"select value from public.rolls where round_id = '{Round}' and player_id = 'p-a'"));
    }

    [Theory]
    [InlineData("swap", 12)]
    [InlineData("min", 12)]
    [InlineData("max", 17)]
    public async Task An_unapplied_chosen_pair_transform_applies_its_op(string op, int expectedA)
    {
        var csharp = await Run(async db =>
        {
            await SeedThree(db);
            await SeedShimCast(db, "roll_pair_transform", "Yorkshire Terror",
                effectParams: $$"""{"op": "{{op}}"}""", castInputs: """{"pair": ["p-a", "p-c"]}""");
        }, Round, AdvanceRound.Entry.Finalize);
        Assert.Equal(expectedA, await csharp.Scalar<int>($"select value from public.rolls where round_id = '{Round}' and player_id = 'p-a'"));
    }

    [Fact]
    public async Task A_forced_reroll_takes_its_d20_from_the_die_roller_and_records_it()
    {
        var csharp = await Run(async db =>
        {
            await SeedThree(db);
            await SeedShimCast(db, "forced_reroll", "Yorkshire Terror", target: "p-a");
        }, Round, AdvanceRound.Entry.Finalize, null, 9);
        Assert.Equal(17, await csharp.Scalar<int>($"select (cast_inputs -> 'roll_transform' -> 'players' -> 0 ->> 'before')::int from public.spell_casts where effect_kind = 'forced_reroll'"));
        Assert.Equal(9, await csharp.Scalar<int>($"select (cast_inputs -> 'roll_transform' -> 'players' -> 0 ->> 'after')::int from public.spell_casts where effect_kind = 'forced_reroll'"));
    }

    [Theory]
    [InlineData("roll_flip", "negative", "p-a", "{}", "{}")]
    [InlineData("roll_swap", "negative", "p-a", "{}", "{}")]
    [InlineData("roll_swap", "positive", "p-b", "{}", "{}")]
    [InlineData("forced_reroll", "negative", "p-a", "{}", "{}")]
    [InlineData("roll_pair_transform", "negative", "p-a", """{"op": "min"}""", """{"pair": ["p-a", "p-c"]}""")]
    public async Task A_ward_older_than_the_transform_blocks_it_and_says_so(string kind, string polarity, string warded, string effectParams, string castInputs)
    {
        var csharp = await Run(async db =>
        {
            await SeedThree(db);
            await SeedWard(db, warded, polarity);
            await SeedShimCast(db, kind, "Yorkshire Terror", target: kind == "forced_reroll" ? warded : null,
                effectParams: effectParams, castInputs: castInputs);
        }, Round, AdvanceRound.Entry.Finalize);
        Assert.Equal(1L, await csharp.Scalar<long>(
            $"select count(*) from public.spell_casts where effect_kind = '{kind}' and cast_inputs -> 'roll_transform' -> 'players' @> '[{{\"warded\": true}}]'"));
    }

    [Fact]
    public async Task A_degenerate_pair_records_an_empty_transform()
    {
        await Run(async db =>
        {
            await SeedThree(db);
            await SeedShimCast(db, "roll_pair_transform", "Yorkshire Terror", castInputs: """{"pair": ["p-a", "p-a"]}""");
        }, Round, AdvanceRound.Entry.Finalize);
    }

    [Fact]
    public async Task Pre_roll_transforms_attach_to_the_window_the_bridge_opens_and_are_shimmed()
    {
        var csharp = await Run(async db =>
        {
            await SeedThree(db, window: false);
            await SeedShimCast(db, "roll_pair_transform", "Yorkshire Terror", attached: false,
                effectParams: """{"op": "swap"}""", castInputs: """{"pair": ["p-a", "p-c"]}""");
        }, Round, AdvanceRound.Entry.Advance);
        Assert.Equal(12, await csharp.Scalar<int>($"select value from public.rolls where round_id = '{Round}' and player_id = 'p-a'"));
    }

    // ------------------------------------------------------------------
    // Advancement: every outcome the entry points can return.
    // ------------------------------------------------------------------

    [Fact]
    public async Task A_tie_advances_the_layer_for_the_tied_players()
    {
        var csharp = await Run(db => SeedThree(db, a: 6, b: 6, c: 12), Round, AdvanceRound.Entry.Finalize);
        Assert.Equal(1, await csharp.Scalar<int>($"select current_layer from public.rounds where id = '{Round}'"));
    }

    [Fact]
    public async Task The_tie_break_layer_resolves_with_a_late_heist_moving_the_card()
    {
        var csharp = await Run(async db =>
        {
            await SeedThree(db, a: 6, b: 6, c: 12);
            await db.Execute($$"""
                update public.rounds set current_layer = 1 where id = '{{Round}}';
                insert into public.round_layer_participants (round_id, layer, player_id) values ('{{Round}}', 1, 'p-a'), ('{{Round}}', 1, 'p-b');
                insert into public.rolls (round_id, player_id, layer, value, input_mode, modifier_snapshot) values
                  ('{{Round}}', 'p-a', 1, 3, 'in_app', 0), ('{{Round}}', 'p-b', 1, 9, 'in_app', 0);
                insert into public.spell_deck_instances (id, card_id, location, held_by_player)
                  select '40000000-0000-4000-8000-000000000002', id, 'held', 'p-a' from public.spell_cards where name = 'Six Sugars';
                insert into public.spell_deck_instances (id, card_id, location)
                  select '40000000-0000-4000-8000-000000000001', id, 'in_deck' from public.spell_cards where name = 'Tea Heist';
                insert into public.spell_casts (id, round_id, caster_id, card_instance_id, target_player_id, effect_kind, cast_inputs)
                  values ('50000000-0000-4000-8000-000000000001', '{{Round}}', 'p-c', '40000000-0000-4000-8000-000000000001', 'p-a', 'card_heist',
                          '{"stolen_instance_id": "40000000-0000-4000-8000-000000000002"}');
                """);
        }, Round, AdvanceRound.Entry.Advance);
        Assert.Equal("p-c", await csharp.Scalar<string>("select held_by_player from public.spell_deck_instances where id = '40000000-0000-4000-8000-000000000002'"));
    }

    [Fact]
    public async Task A_surviving_round_replay_is_recorded_as_pending()
    {
        var csharp = await Run(async db =>
        {
            await SeedThree(db);
            await SeedShimCast(db, "round_replay", "Time for Brew", attached: false);
        }, Round, AdvanceRound.Entry.Finalize);
        Assert.Equal("p-c", await csharp.Scalar<string>($"select caster_id from public.pending_round_replay where round_id = '{Round}'"));
    }

    [Fact]
    public async Task A_held_reaction_card_keeps_the_window_open_with_nothing_resolved()
    {
        var csharp = await Run(async db =>
        {
            await SeedThree(db, window: false);
            await db.Execute("""
                insert into public.spell_deck_instances (id, card_id, location, held_by_player)
                  select '40000000-0000-4000-8000-000000000002', id, 'held', 'p-a' from public.spell_cards where name = 'Six Sugars';
                """);
        }, Round, AdvanceRound.Entry.Advance);
        Assert.Equal("open", await csharp.Scalar<string>($"select status from public.spell_reaction_windows where round_id = '{Round}'"));
    }

    [Theory]
    [InlineData(AdvanceRound.Entry.Advance)]
    [InlineData(AdvanceRound.Entry.Finalize)]
    public async Task An_open_window_noops(AdvanceRound.Entry entry) =>
        await Run(async db =>
        {
            await SeedThree(db, window: false);
            await db.Execute($"insert into public.spell_reaction_windows (id, round_id, layer, status, poll_round, opened_at) values ('{Window}', '{Round}', 0, 'open', 1, now())");
        }, Round, entry);

    [Fact]
    public async Task Finalize_with_no_window_noops() =>
        await Run(db => SeedThree(db, window: false), Round, AdvanceRound.Entry.Finalize);

    [Theory]
    [InlineData(AdvanceRound.Entry.Advance)]
    [InlineData(AdvanceRound.Entry.Finalize)]
    public async Task A_resolved_round_noops(AdvanceRound.Entry entry) =>
        await Run(async db =>
        {
            await SeedThree(db);
            await db.Execute($"update public.rounds set status = 'resolved', brewer_id = 'p-b' where id = '{Round}'");
        }, Round, entry);

    [Theory]
    [InlineData(AdvanceRound.Entry.Advance)]
    [InlineData(AdvanceRound.Entry.Finalize)]
    public async Task A_missing_roll_holds_the_layer(AdvanceRound.Entry entry) =>
        await Run(async db =>
        {
            await SeedThree(db);
            await db.Execute($"delete from public.rolls where round_id = '{Round}' and player_id = 'p-a'");
        }, Round, entry);

    [Theory]
    [InlineData("dice_modifier", "null", "{}", false)]
    [InlineData("forced_reroll", "null", "{}", true)]
    [InlineData("tea_maker_override", "null", """{"mode": "chosen", "picker": "lowest_roller"}""", false)]
    public async Task Each_hold_kind_noops_with_the_sql_reason(string kind, string target, string effectParams, bool pending) =>
        await Run(async db =>
        {
            await SeedThree(db, window: false);
            await db.Execute($$"""
                insert into public.spell_deck_instances (id, card_id, location)
                  select '40000000-0000-4000-8000-000000000001', id, 'in_deck' from public.spell_cards where name = 'Yorkshire Terror';
                insert into public.spell_casts (id, round_id, caster_id, card_instance_id, target_player_id, target_pending, effect_kind, effect_params)
                  values ('50000000-0000-4000-8000-000000000001', '{{Round}}', 'p-c', '40000000-0000-4000-8000-000000000001', {{target}}, {{pending}}, '{{kind}}', '{{effectParams}}');
                """);
        }, Round, AdvanceRound.Entry.Advance);

    [Fact]
    public async Task An_owed_compelled_action_cast_holds_the_layer() =>
        await Run(async db =>
        {
            await SeedThree(db, window: false);
            await db.Execute($$"""
                insert into public.spell_deck_instances (id, card_id, location)
                  select '40000000-0000-4000-8000-000000000001', id, 'in_deck' from public.spell_cards where name = 'Brewmageddon';
                insert into public.spell_casts (id, round_id, caster_id, card_instance_id, effect_kind, cast_inputs)
                  values ('50000000-0000-4000-8000-000000000001', '{{Round}}', 'p-c', '40000000-0000-4000-8000-000000000001', 'compel_cast',
                          '{"compelled": [{"player_id": "p-a", "card_instance_id": "40000000-0000-4000-8000-000000000009", "casting_time": "A"}]}');
                """);
        }, Round, AdvanceRound.Entry.Advance);

    [Fact]
    public async Task A_missing_round_noops() =>
        await Run(_ => Task.CompletedTask, Guid.Parse("20000000-0000-4000-8000-000000000099"), AdvanceRound.Entry.Advance);

    [Fact]
    public async Task A_seize_keeps_the_seized_cast_and_records_that_it_did()
    {
        var csharp = await Run(async db =>
        {
            await SeedThree(db);
            await SeedShimCast(db, "flat_modifier", "Yorkshire Terror", caster: "p-a", target: "p-b",
                effectParams: """{"delta": -2}""", attached: false);
            await db.Execute($$"""
                insert into public.spell_deck_instances (id, card_id, location)
                  select '40000000-0000-4000-8000-000000000002', id, 'in_deck' from public.spell_cards where name = 'Brew-merang';
                insert into public.spell_casts (id, round_id, caster_id, card_instance_id, parent_cast_id, cast_inputs, reaction_window_id)
                  values ('50000000-0000-4000-8000-000000000002', '{{Round}}', 'p-b', '40000000-0000-4000-8000-000000000002',
                          '50000000-0000-4000-8000-000000000001', '{"seized_cast_id": "50000000-0000-4000-8000-000000000001"}', '{{Window}}');
                """);
        }, Round, AdvanceRound.Entry.Finalize);
        Assert.True(await csharp.Scalar<bool>("select (cast_inputs ->> 'seized_kept')::boolean from public.spell_casts where id = '50000000-0000-4000-8000-000000000001'"));
    }

    [Fact]
    public async Task A_brew_debt_from_another_room_makes_this_a_debt_round()
    {
        // The IOU cast sits in yesterday's room: nothing today's room holds points at it.
        var yesterday = Guid.Parse("10000000-0000-4000-8000-000000000002");
        var iouRound = Guid.Parse("20000000-0000-4000-8000-000000000002");
        var csharp = await Run(async db =>
        {
            await SeedThree(db, window: false);
            await db.Execute($$"""
                delete from public.rolls where round_id = '{{Round}}';
                insert into public.rooms (id, date) values ('{{yesterday}}', '2025-12-31');
                insert into public.rounds (id, room_id, started_by, status, started_at, closed_at, resolved_at, brewer_id, cups_made, brewer_source, brewer_source_cast_id) values
                  ('{{iouRound}}', '{{yesterday}}', 'p-a', 'resolved', '2025-12-31 09:00+00', '2025-12-31 09:01+00', '2025-12-31 09:02+00', 'p-b', 2, null, null);
                insert into public.round_participants (round_id, player_id) values ('{{iouRound}}', 'p-a'), ('{{iouRound}}', 'p-b');
                insert into public.spell_deck_instances (id, card_id, location)
                  select '40000000-0000-4000-8000-000000000001', id, 'in_deck' from public.spell_cards where name = 'Brew IOU';
                insert into public.spell_casts (id, round_id, caster_id, card_instance_id, target_player_id, effect_kind, effect_params)
                  values ('50000000-0000-4000-8000-000000000001', '{{iouRound}}', 'p-a', '40000000-0000-4000-8000-000000000001', 'p-b', 'tea_maker_override', '{"mode": "chosen"}');
                update public.rounds set brewer_source = 'brew_iou', brewer_source_cast_id = '50000000-0000-4000-8000-000000000001' where id = '{{iouRound}}';
                """);
        }, Round, AdvanceRound.Entry.Advance, payload => Assert.Equal("brewer", (string?)payload["outcome"]));
        Assert.Equal("p-a", await csharp.Scalar<string>($"select brewer_id from public.rounds where id = '{Round}'"));
        Assert.Equal("brew_debt", await csharp.Scalar<string>($"select brewer_source from public.rounds where id = '{Round}'"));
    }

    // ------------------------------------------------------------------
    // The harness.
    // ------------------------------------------------------------------

    /// <summary>Seeds a fresh database, runs the C# advance once with the given dice, and hands
    /// back the database for the test's own assertions.</summary>
    private static async Task<TestDatabase> Run(
        Func<TestDatabase, Task> seed, Guid roundId, AdvanceRound.Entry entry, Action<JsonObject>? checkPayload = null, params int[] dice)
    {
        var db = await TestPostgres.CreateDatabase();
        await seed(db);
        var (payload, _) = await RunCSharp(db, roundId, entry, dice.Length == 0 ? new NoDiceRoller() : new ScriptedDieRoller(dice));
        checkPayload?.Invoke(payload);
        return db;
    }

    private static async Task<(JsonObject Payload, long? Version)> RunCSharp(TestDatabase db, Guid roundId, AdvanceRound.Entry entry, IDieRoller dice)
    {
        await db.Execute("""
            insert into auth.users (id, email, raw_user_meta_data)
            values ('00000000-0000-4000-8000-00000000abcd', 'runner@example.test', '{"sub": "g-runner", "full_name": "runner"}')
            on conflict do nothing;
            """);
        await using var ds = RoomStore.BuildDataSource(db.ApiConnectionString);
        var store = new RoomStore(ds);
        var caller = new Caller("00000000-0000-4000-8000-00000000abcd", """{"sub":"00000000-0000-4000-8000-00000000abcd","role":"authenticated"}""");
        var advance = new AdvanceRound(dice);
        var outcome = await store.Command(roundId, caller, s => advance.Decide(s, roundId, entry));
        return (outcome.Result, outcome.Version);
    }

    internal static string Canon(string json) => TraceJson(JsonNode.Parse(json));

    private static string TraceJson(JsonNode? node) => node switch
    {
        JsonObject o => "{" + string.Join(",", o.OrderBy(kv => kv.Key, StringComparer.Ordinal).Select(kv => $"\"{kv.Key}\":{TraceJson(kv.Value)}")) + "}",
        JsonArray a => "[" + string.Join(",", a.Select(TraceJson)) + "]",
        null => "null",
        _ => node.ToJsonString(),
    };

    /// <summary>Every row either engine can touch, jsonb-normalised as Postgres stores it, and
    /// compared to the byte. Only a timestamp set by now() is masked, because the two databases
    /// run at different moments: seeded dates stay, and null versus set still differs.</summary>
    internal static async Task<string> State(TestDatabase db) => NowStamp().Replace((await db.Scalar<string>("""
        select jsonb_pretty(jsonb_build_object(
          'rounds', (select coalesce(jsonb_agg(to_jsonb(t) order by t.id), '[]') from public.rounds t),
          'rolls', (select coalesce(jsonb_agg(to_jsonb(t) order by t.round_id, t.layer, t.player_id), '[]') from public.rolls t),
          'casts', (select coalesce(jsonb_agg(to_jsonb(t) - 'seq' order by t.seq), '[]') from public.spell_casts t),
          'effects', (select coalesce(jsonb_agg(to_jsonb(t) order by t.created_at, t.target_player_id), '[]') from public.spell_active_effects t),
          'deck', (select coalesce(jsonb_agg(to_jsonb(t) order by t.id), '[]') from public.spell_deck_instances t),
          'room_players', (select coalesce(jsonb_agg(to_jsonb(t) order by t.room_id, t.player_id), '[]') from public.room_players t),
          'layer_participants', (select coalesce(jsonb_agg(to_jsonb(t) order by t.round_id, t.layer, t.player_id), '[]') from public.round_layer_participants t),
          'windows', (select coalesce(jsonb_agg(to_jsonb(t) order by t.round_id, t.layer), '[]') from public.spell_reaction_windows t),
          'replay', (select coalesce(jsonb_agg(to_jsonb(t) - 'id' order by t.round_id), '[]') from public.pending_round_replay t)
        ))
        """))!, "<now>");

    // Today or tomorrow, so a run crossing UTC midnight still masks both databases alike.
    private static readonly Regex NowStampPattern = new(
        $@"({DateTime.UtcNow:yyyy-MM-dd}|{DateTime.UtcNow.AddDays(1):yyyy-MM-dd})T[0-9:.]+\+00:00");

    private static Regex NowStamp() => NowStampPattern;

    internal static string MaskNow(string text) => NowStamp().Replace(text, "<now>");

}
