using RollForBrew.Domain.Commands;
using RollForBrew.Tests.Harness;

namespace RollForBrew.Tests;

/// <summary>
/// The slice 2b parity audit's open gaps (docs/port/slice-2b-parity-audit.md): TS integration
/// tests with no C# equivalent, each seeded the way the TS test seeds it and run through both
/// engines by <see cref="Parity"/>.
/// </summary>
public partial class AdvanceRoundParityTests
{
    private static string Id(int prefix, int n) => $"{prefix}0000000-0000-4000-8000-{n:D12}";

    /// <summary>A card instance and its cast in this round, on the closed window.</summary>
    private static Task SeedCast(TestDatabase db, int n, string card, string caster, string? target, string kind,
        string effectParams = "{}", string? castInputs = null, int? parent = null, string? role = null) =>
        db.Execute($$"""
            insert into public.spell_deck_instances (id, card_id, location)
              select '{{Id(4, n)}}', id, 'in_deck' from public.spell_cards where name = '{{card.Replace("'", "''")}}';
            insert into public.spell_casts (id, round_id, caster_id, card_instance_id, target_player_id, effect_kind, effect_params, cast_inputs, parent_cast_id, target_role, reaction_window_id)
              values ('{{Id(5, n)}}', '{{Round}}', '{{caster}}', '{{Id(4, n)}}', {{Sql(target)}}, {{Sql(kind)}}, '{{effectParams}}', {{Sql(castInputs)}},
                      {{Sql(parent is null ? null : Id(5, parent.Value))}}, {{Sql(role)}}, '{{Window}}');
            """);

    private static string Sql(string? value) => value is null ? "null" : $"'{value}'";

    /// <summary>A Room Effect from a resolved earlier round, as <c>seedActiveEffect</c> seeds it.</summary>
    private static Task SeedRoomEffect(TestDatabase db, int n, string card, string holder, string kind, string effectParams) =>
        db.Execute($$"""
            insert into public.rounds (id, room_id, started_by, status, resolved_at)
              values ('{{Id(2, n)}}', '{{Room}}', '{{holder}}', 'resolved', '2026-01-01 08:00+00');
            insert into public.spell_deck_instances (id, card_id, location)
              select '{{Id(4, n)}}', id, 'in_deck' from public.spell_cards where name = '{{card.Replace("'", "''")}}';
            insert into public.spell_casts (id, round_id, caster_id, card_instance_id, target_player_id, effect_kind, effect_params)
              values ('{{Id(5, n)}}', '{{Id(2, n)}}', '{{holder}}', '{{Id(4, n)}}', '{{holder}}', '{{kind}}', '{{effectParams}}');
            insert into public.spell_active_effects (id, room_id, target_player_id, caster_id, source_cast_id, card_id, effect_kind, effect_params)
              values ('{{Id(6, n)}}', '{{Room}}', '{{holder}}', '{{holder}}', '{{Id(5, n)}}',
                      (select id from public.spell_cards where name = '{{card}}'), '{{kind}}', '{{effectParams}}');
            """);

    /// <summary>One value off the first stored Trace step matching <paramref name="where"/>.</summary>
    private static Task<string?> TraceStep(TestDatabase db, string where, string value) =>
        db.Scalar<string>($"""
            select {value} from public.rounds r, jsonb_array_elements(r.resolution_trace) s
             where r.id = '{Round}' and {where} limit 1
            """);

    // ------------------------------------------------------------------
    // brew-iou.test.ts
    // ------------------------------------------------------------------

    private static async Task SeedIouIntoLooseLeaf(TestDatabase db)
    {
        // p-a names p-b with Brew IOU; p-b then names themself for a Loose Leaf roll-off.
        await SeedThree(db, a: 2, b: 19, c: 10);
        await SeedCast(db, 1, "Brew IOU", "p-a", "p-b", "tea_maker_override", """{"mode": "chosen"}""");
        await SeedCast(db, 2, "Loose Leaf", "p-b", "p-b", "named_tea_maker_rolloff");
    }

    [Fact]
    public async Task Brew_IOU_whose_target_goes_to_a_Loose_Leaf_roll_off_ties_without_a_debt()
    {
        var csharp = await Parity(SeedIouIntoLooseLeaf, Round, AdvanceRound.Entry.Finalize,
            payload => Assert.Equal("tie", (string?)payload["outcome"]));
        Assert.Null(await csharp.Scalar<string>($"select brewer_source from public.rounds where id = '{Round}'"));
    }

    [Fact]
    public async Task Brew_IOU_target_who_loses_the_Loose_Leaf_roll_off_brews_with_no_debt()
    {
        var csharp = await Parity(async db =>
        {
            await SeedIouIntoLooseLeaf(db);
            await db.Execute($"""
                select public.finalize_layer('{Round}');
                insert into public.rolls (round_id, player_id, layer, value, input_mode, modifier_snapshot) values
                  ('{Round}', 'p-b', 1, 3, 'manual', 0), ('{Round}', 'p-c', 1, 15, 'manual', 0);
                """);
        }, Round, AdvanceRound.Entry.Advance, payload => Assert.Equal("brewer", (string?)payload["outcome"]));
        Assert.Equal("p-b", await csharp.Scalar<string>($"select brewer_id from public.rounds where id = '{Round}'"));
        Assert.Null(await csharp.Scalar<string>($"select brewer_source from public.rounds where id = '{Round}'"));
        Assert.Equal(0, await csharp.Scalar<long>($"""
            select count(*) from public.rounds r, jsonb_array_elements(r.resolution_trace) s
             where r.id = '{Round}' and s ? 'brew_debt'
            """));
    }

    [Fact]
    public async Task A_brew_debt_from_a_real_room_is_not_paid_in_the_Test_Room()
    {
        var yesterday = Guid.Parse("10000000-0000-4000-8000-000000000002");
        var iouRound = Guid.Parse("20000000-0000-4000-8000-000000000002");
        var csharp = await Parity(async db =>
        {
            // p-b brewed for p-a's Brew IOU yesterday, so p-a owes. Today's room is the Test Room.
            await SeedThree(db, window: false);
            await db.Execute($$"""
                update public.rooms set is_test = true where id = '{{Room}}';
                insert into public.rooms (id, date) values ('{{yesterday}}', '2025-12-31');
                insert into public.rounds (id, room_id, started_by, status, started_at, closed_at, resolved_at, brewer_id, cups_made) values
                  ('{{iouRound}}', '{{yesterday}}', 'p-a', 'resolved', '2025-12-31 09:00+00', '2025-12-31 09:01+00', '2025-12-31 09:02+00', 'p-b', 2);
                insert into public.round_participants (round_id, player_id) values ('{{iouRound}}', 'p-a'), ('{{iouRound}}', 'p-b');
                insert into public.spell_deck_instances (id, card_id, location)
                  select '40000000-0000-4000-8000-000000000001', id, 'in_deck' from public.spell_cards where name = 'Brew IOU';
                insert into public.spell_casts (id, round_id, caster_id, card_instance_id, target_player_id, effect_kind, effect_params)
                  values ('50000000-0000-4000-8000-000000000001', '{{iouRound}}', 'p-a', '40000000-0000-4000-8000-000000000001', 'p-b', 'tea_maker_override', '{"mode": "chosen"}');
                update public.rounds set brewer_source = 'brew_iou', brewer_source_cast_id = '50000000-0000-4000-8000-000000000001' where id = '{{iouRound}}';
                """);
        }, Round, AdvanceRound.Entry.Advance);
        // The round is played: the lowest roller brews, and the debt is still owed.
        Assert.Equal("p-b", await csharp.Scalar<string>($"select brewer_id from public.rounds where id = '{Round}'"));
        Assert.Null(await csharp.Scalar<string>($"select brewer_source from public.rounds where id = '{Round}'"));
    }

    // ------------------------------------------------------------------
    // effect-invocation.test.ts
    // ------------------------------------------------------------------

    [Fact]
    public async Task A_block_copy_ward_blocks_a_seize_and_the_source_resolves_on_its_target()
    {
        var csharp = await Parity(async db =>
        {
            await SeedThree(db, a: 10, b: 10, c: 10);
            await SeedRoomEffect(db, 3, "Bag for Life", "p-a", "ward",
                """{"polarity": ["positive", "negative"], "domain": ["modifier"], "block_copy": true}""");
            await SeedCast(db, 1, "Brewer's Blessing", "p-a", "p-b", "flat_modifier", """{"delta": 5}""", role: "TARGET");
            await SeedCast(db, 2, "Brew-merang", "p-c", null, null,
                castInputs: $$"""{"seized_cast_id": "{{Id(5, 1)}}"}""", parent: 1, role: "CARD");
        }, Round, AdvanceRound.Entry.Finalize);
        Assert.Equal("blocked", await TraceStep(csharp, "s ->> 'display_kind' = 'warded' and s ->> 'invocation_kind' = 'seize'", "s ->> 'outcome'"));
        Assert.Equal("5", await TraceStep(csharp, "s ->> 'display_kind' = 'flat_modifier' and s ->> 'target_player' = 'p-b'", "s -> 'after' ->> 'value'"));
        Assert.Null(await csharp.Scalar<string>($"select seized_by_cast_id::text from public.spell_casts where id = '{Id(5, 1)}'"));
    }

    [Fact]
    public async Task A_Brew_merang_seizing_a_Brew_merang_terminates_with_the_inner_one_seized()
    {
        var csharp = await Parity(async db =>
        {
            await SeedThree(db, a: 10, b: 10, c: 10);
            await SeedCast(db, 1, "Brewer's Blessing", "p-a", "p-b", "flat_modifier", """{"delta": 5}""", role: "TARGET");
            await SeedCast(db, 2, "Brew-merang", "p-b", null, null,
                castInputs: $$"""{"seized_cast_id": "{{Id(5, 1)}}"}""", parent: 1, role: "CARD");
            // The deck has one Brew-merang, so the outer seize rides a donor instance.
            await SeedCast(db, 3, "Lucky Sip", "p-c", null, null,
                castInputs: $$"""{"seized_cast_id": "{{Id(5, 2)}}"}""", parent: 2, role: "CARD");
        }, Round, AdvanceRound.Entry.Finalize);
        Assert.Equal(Id(5, 3), await csharp.Scalar<string>($"select seized_by_cast_id::text from public.spell_casts where id = '{Id(5, 2)}'"));
    }

    // ------------------------------------------------------------------
    // last-drip.test.ts
    // ------------------------------------------------------------------

    private const string LastDripParams = """{"mode": "prev_round_highest", "modifier_gain": 0}""";

    /// <summary>An earlier round in this room, as <c>seedPastRound</c> seeds it. Rolls are
    /// (player, value, modifier snapshot).</summary>
    private static Task SeedPastRound(TestDatabase db, int n, string startedAt, string status, params (string Player, int Value, int Snapshot)[] rolls) =>
        db.Execute($"""
            insert into public.rounds (id, room_id, started_by, status, started_at, resolved_at)
              values ('{Id(2, n)}', '{Room}', '{rolls[0].Player}', '{status}', '{startedAt}', {(status == "resolved" ? $"'{startedAt}'" : "null")});
            insert into public.round_participants (round_id, player_id) values
              {string.Join(", ", rolls.Select(r => $"('{Id(2, n)}', '{r.Player}')"))};
            insert into public.rolls (round_id, player_id, layer, value, input_mode, modifier_snapshot) values
              {string.Join(", ", rolls.Select(r => $"('{Id(2, n)}', '{r.Player}', 0, {r.Value}, 'manual', {r.Snapshot})"))};
            """);

    private static async Task<string?> Brewer(TestDatabase db) =>
        await db.Scalar<string>($"select brewer_id from public.rounds where id = '{Round}'");

    [Fact]
    public async Task Last_Drip_reads_the_most_recent_resolved_round_ignoring_older_and_cancelled_ones()
    {
        var csharp = await Parity(async db =>
        {
            await SeedThree(db, a: 2, b: 11, c: 12);
            await SeedPastRound(db, 3, "2026-01-01 07:30+00", "resolved", ("p-a", 5, 0), ("p-b", 19, 0), ("p-c", 4, 0));
            await SeedPastRound(db, 4, "2026-01-01 08:00+00", "resolved", ("p-a", 5, 0), ("p-b", 6, 0), ("p-c", 17, 0));
            await SeedPastRound(db, 5, "2026-01-01 08:30+00", "cancelled", ("p-a", 5, 0), ("p-b", 20, 0));
            await SeedCast(db, 1, "Last Drip", "p-a", null, "tea_maker_override", LastDripParams);
        }, Round, AdvanceRound.Entry.Finalize);
        Assert.Equal("p-c", await Brewer(csharp));
    }

    [Fact]
    public async Task Last_Drip_breaks_a_full_tie_on_roll_and_snapshot_on_the_lowest_player_id()
    {
        var csharp = await Parity(async db =>
        {
            await SeedThree(db, a: 2, b: 11, c: 12);
            await SeedPastRound(db, 3, "2026-01-01 08:00+00", "resolved", ("p-a", 3, 0), ("p-b", 14, 2), ("p-c", 14, 2));
            await SeedCast(db, 1, "Last Drip", "p-a", null, "tea_maker_override", LastDripParams);
        }, Round, AdvanceRound.Entry.Finalize);
        Assert.Equal("p-b", await Brewer(csharp));
    }

    [Fact]
    public async Task Last_Drip_falling_through_to_an_immune_player_leaves_the_default_pick()
    {
        var csharp = await Parity(async db =>
        {
            // p-d won last round but is not in this one, so Last Drip falls through to p-b, who is immune.
            await SeedThree(db, a: 15, b: 14, c: 4);
            await db.Execute($"""
                insert into public.players (id, email) values ('p-d', 'd@x.test');
                insert into public.room_players (room_id, player_id, modifier) values ('{Room}', 'p-d', 0);
                """);
            await SeedRoomEffect(db, 6, "The Last Cuppa", "p-b", "brewer_immunity",
                """{"mode": "last_cuppa", "persist": true, "override_proof": true}""");
            await SeedPastRound(db, 3, "2026-01-01 08:00+00", "resolved", ("p-d", 19, 0), ("p-b", 12, 0), ("p-a", 5, 0));
            await SeedCast(db, 1, "Last Drip", "p-a", null, "tea_maker_override", LastDripParams);
        }, Round, AdvanceRound.Entry.Finalize);
        Assert.Equal("p-c", await Brewer(csharp));
        Assert.Null(await TraceStep(csharp, "s ->> 'display_kind' = 'tea_maker_override' and s ->> 'outcome' = 'applied'", "s ->> 'target_player'"));
        Assert.Equal("p-b", await TraceStep(csharp, "s ->> 'display_kind' = 'brewer_immunity'", "s ->> 'target_player'"));
    }

    [Fact]
    public async Task Genie_invoking_Last_Drip_makes_the_previous_winner_brew_with_no_gain()
    {
        var csharp = await Parity(async db =>
        {
            await SeedThree(db, a: 10, b: 15, c: 3);
            await SeedPastRound(db, 3, "2026-01-01 08:00+00", "resolved", ("p-a", 9, 0), ("p-b", 18, 0), ("p-c", 2, 0));
            await SeedCast(db, 1, "Genie in the Teapot", "p-a", null, "tea_maker_override", LastDripParams,
                castInputs: """{"invoked_card": "Last Drip"}""");
        }, Round, AdvanceRound.Entry.Finalize);
        Assert.Equal("p-b", await Brewer(csharp));
        Assert.Equal("p-b", await TraceStep(csharp, "s ->> 'display_kind' = 'tea_maker_override' and s ->> 'outcome' = 'applied'", "s ->> 'target_player'"));
        Assert.Equal(0, await csharp.Scalar<int>($"select brewer_modifier_gain from public.rounds where id = '{Round}'"));
    }

    // ------------------------------------------------------------------
    // tea-heist.test.ts
    // ------------------------------------------------------------------

    [Fact]
    public async Task A_heist_lands_as_keep_or_swap_when_the_thief_picked_up_a_card_mid_round()
    {
        var loot = Id(4, 2);
        var drawn = Id(4, 3);
        var csharp = await Parity(async db =>
        {
            await SeedThree(db, a: 5, b: 6, c: 12);
            // The thief's crit draw refilled their hand after they cast Tea Heist.
            await db.Execute($"""
                insert into public.spell_deck_instances (id, card_id, location, held_by_player)
                  select '{loot}', id, 'held', 'p-b' from public.spell_cards where name = 'Lucky Sip';
                insert into public.spell_deck_instances (id, card_id, location, held_by_player)
                  select '{drawn}', id, 'held', 'p-a' from public.spell_cards where name = 'Tannin Tantrum';
                """);
            await SeedCast(db, 1, "Tea Heist", "p-a", "p-b", "card_heist", castInputs: $$"""{"stolen_instance_id": "{{loot}}"}""");
        }, Round, AdvanceRound.Entry.Finalize, payload => Assert.Equal("brewer", (string?)payload["outcome"]));
        async Task<string?> At(string id) =>
            await csharp.Scalar<string>($"select location || ':' || coalesce(held_by_player, '') from public.spell_deck_instances where id = '{id}'");
        Assert.Equal("held:p-a", await At(drawn));
        Assert.Equal("pending_swap:p-a", await At(loot));
    }
}
