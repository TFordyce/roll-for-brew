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
        string effectParams = "{}", string castInputs = "{}", string? parent = null) =>
        db.Execute($$"""
            insert into public.spell_deck_instances (id, card_id, location)
              select '{{Id(4, n)}}', id, 'in_deck' from public.spell_cards where name = '{{card}}';
            insert into public.spell_casts (id, round_id, caster_id, card_instance_id, target_player_id, effect_kind, effect_params, cast_inputs, parent_cast_id, reaction_window_id)
              values ('{{Id(5, n)}}', '{{Round}}', '{{caster}}', '{{Id(4, n)}}', {{(target is null ? "null" : $"'{target}'")}},
                      {{(kind == "" ? "null" : $"'{kind}'")}}, '{{effectParams}}', '{{castInputs}}', {{(parent is null ? "null" : $"'{parent}'")}}, '{{Window}}');
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
}
