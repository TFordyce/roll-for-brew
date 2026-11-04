using System.Text.Json;
using System.Text.Json.Nodes;
using System.Text.RegularExpressions;
using Npgsql;
using RollForBrew.Api.Data;
using RollForBrew.Api.Problems;
using RollForBrew.Api.RoundBackfill;
using RollForBrew.Tests.Harness;
using static RollForBrew.Tests.RoundRecapParityTests;

namespace RollForBrew.Tests;

/// <summary>
/// The oracle for Round Backfill (#548): each case goes through admin_backfill_round in one
/// database and C# in another, from identical rows. The error (code and message), or every row
/// written, must match. Only now() and the ids each engine generates are masked.
/// </summary>
public class RoundBackfillParityTests
{
    private const string A = "p-a", B = "p-b", C = "p-c";

    private static string L(params (string? Player, int? Value)[] rolls) =>
        new JsonArray([.. rolls.Select(r => (JsonNode?)new JsonObject { ["player_id"] = r.Player, ["value"] = r.Value })]).ToJsonString();

    private static string Layers(params string[] layers) => "[" + string.Join(",", layers) + "]";

    private static async Task<TestDatabase> Seed(Func<TestDatabase, Task>? more = null)
    {
        var db = await TestPostgres.CreateDatabase();
        await db.Execute("""
            insert into public.players (id, email) values ('p-a', 'a@x.test'), ('p-b', 'b@x.test'), ('p-c', 'c@x.test');
            insert into auth.users (id, email, raw_user_meta_data)
              values ('00000000-0000-4000-8000-00000000adad', 'boss@x.test', '{"sub": "g-boss", "full_name": "boss"}');
            update public.players set is_admin = true where id = 'g-boss';
            """);
        if (more is not null) await more(db);
        return db;
    }

    private const string Today = "(now() at time zone 'Europe/London')::date";

    private static readonly TestUser Boss = new(Guid.Parse("00000000-0000-4000-8000-00000000adad"), "g-boss");

    private static Task Modifiers(TestDatabase db, int a, int b, int c = 0) => db.Execute($"""
        insert into public.rooms (date) values ((now() at time zone 'Europe/London')::date);
        insert into public.room_players (room_id, player_id, modifier)
          select r.id, p.pid, p.m from public.rooms r, (values ('p-a', {a}), ('p-b', {b}), ('p-c', {c})) as p(pid, m) where r.date = {Today};
        """);

    public static TheoryData<string, string[], string> Rejections => new()
    {
        { "too few", [A], Layers(L((A, 5))) },
        { "no layers", [A, B], "[]" },
        { "wrong count", [A, B, C], Layers(L((A, 5), (B, 12))) },
        { "named the wrong player", [A, B], Layers(L((A, 5), (C, 12))) },
        { "said one player twice", [A, B], Layers(L((A, 5), (A, 12))) },
        { "an empty layer", [A, B], Layers("[]") },
        { "wrong tie-break roster", [A, B, C], Layers(L((A, 6), (B, 6), (C, 12)), L((A, 3), (C, 9))) },
        { "too low", [A, B], Layers(L((A, 0), (B, 12))) },
        { "too high", [A, B], Layers(L((A, 21), (B, 12))) },
        { "no value", [A, B], Layers(L((A, null), (B, 12))) },
        { "extra layer", [A, B], Layers(L((A, 5), (B, 12)), L((A, 8), (B, 9))) },
        { "still tied", [A, B], Layers(L((A, 10), (B, 10))) },
        { "still tied at the end", [A, B], Layers(L((A, 6), (B, 6)), L((A, 3), (B, 3))) },
        { "repeated participant", [A, A], Layers(L((A, 5), (B, 12))) },
        { "unknown participant", [A, "nobody"], Layers(L((A, 5), ("nobody", 12))) },
        { "a null player", [A, B], Layers(L((A, 5), (null, 12))) },
    };

    [Theory]
    [MemberData(nameof(Rejections))]
    public async Task A_bad_backfill_fails_the_same_way_and_leaves_nothing(string why, string[] roster, string layers)
    {
        _ = why;
        var (sqlDb, csDb) = (await Seed(), await Seed());
        var before = await Rows(sqlDb);
        var sql = await Sql(sqlDb, Boss, roster, layers);
        var cs = await CSharp(csDb, Boss, roster, layers);
        Assert.NotNull(sql.Error);
        Assert.Equal(sql.Error, cs.Error);
        Assert.Equal(before, await Rows(sqlDb));
        Assert.Equal(before, await Rows(csDb));
    }

    // array_length('{}', 1) is null, so an empty roster gets past RFB34 and past the roster
    // check. This is the one way to reach what advance_round_layer and resolve_round guard.
    public static TheoryData<string, string> EmptyRosters => new()
    {
        { "brewer is no participant", Layers(L((A, 5), (B, 12))) },
        { "tied players are no participants", Layers(L((A, 6), (B, 6)), L((A, 1), (B, 2))) },
        { "extra layer", Layers(L((A, 5), (B, 12)), L((A, 1))) },
        { "still tied", Layers(L((A, 6), (B, 6))) },
        { "an empty layer", Layers("[]") },
        { "unknown player", Layers(L(("nobody", 6), (B, 6))) },
    };

    [Theory]
    [MemberData(nameof(EmptyRosters))]
    public async Task An_empty_roster_fails_the_same_way_and_leaves_nothing(string why, string layers)
    {
        _ = why;
        var (sqlDb, csDb) = (await Seed(), await Seed());
        var before = await Rows(sqlDb);
        var sql = await Sql(sqlDb, Boss, [], layers);
        var cs = await CSharp(csDb, Boss, [], layers);
        Assert.NotNull(sql.Error);
        Assert.Equal(sql.Error, cs.Error);
        Assert.Equal(before, await Rows(csDb));
    }

    [Fact]
    public async Task A_non_admin_is_refused()
    {
        var (sqlDb, csDb) = (await Seed(), await Seed());
        var sql = await Sql(sqlDb, await sqlDb.AddUser("g-pleb"), [A, B], Layers(L((A, 5), (B, 12))));
        var cs = await CSharp(csDb, await csDb.AddUser("g-pleb"), [A, B], Layers(L((A, 5), (B, 12))));
        Assert.Equal("admin_required_backfill|admin_backfill_round: caller is not an admin", sql.Error);
        Assert.Equal(sql.Error, cs.Error);
    }

    [Theory]
    [InlineData("open")]
    [InlineData("closed")]
    public async Task A_live_round_in_todays_room_is_refused(string status)
    {
        Task Live(TestDatabase db) => db.Execute($"""
            insert into public.rooms (date) values ((now() at time zone 'Europe/London')::date);
            insert into public.rounds (room_id, started_by, status) select id, 'p-a', '{status}' from public.rooms where date = {Today};
            """);
        var (sqlDb, csDb) = (await Seed(Live), await Seed(Live));
        var sql = await Sql(sqlDb, Boss, [A, B], Layers(L((A, 5), (B, 12))));
        var cs = await CSharp(csDb, Boss, [A, B], Layers(L((A, 5), (B, 12))));
        Assert.StartsWith("backfill_round_in_progress|", sql.Error);
        Assert.Equal(sql.Error, cs.Error);
    }

    [Fact]
    public async Task A_resolved_round_in_todays_room_does_not_block_it()
    {
        Task Done(TestDatabase db) => db.Execute($"""
            insert into public.rooms (date) values ((now() at time zone 'Europe/London')::date);
            insert into public.rounds (room_id, started_by, status, started_at) select id, 'p-a', 'resolved', '2026-01-01 09:00+00' from public.rooms where date = {Today};
            """);
        await Parity(Done, [A, B], Layers(L((A, 5), (B, 12))), a => a.Brewer(A));
    }

    public static TheoryData<string, int, int, int, string[], string, string, int> Resolutions => new()
    {
        // why, modifiers a b c, roster, layers, brewer, final layer
        { "lowest total", 0, 0, 0, [A, B], Layers(L((A, 5), (B, 12))), A, 0 },
        { "modifiers count", 9, 0, 0, [A, B], Layers(L((A, 5), (B, 12))), B, 0 },
        { "a natural 1 beats a lower total", 0, -5, 0, [A, B], Layers(L((A, 1), (B, 2))), A, 0 },
        { "lowest modifier among natural 1s", 3, 2, 0, [A, B, C], Layers(L((A, 1), (B, 1), (C, 9))), B, 0 },
        { "tied natural 1s reroll", 2, 2, 0, [A, B, C], Layers(L((A, 1), (B, 1), (C, 9)), L((A, 3), (B, 9))), A, 1 },
        { "all natural 20s fall to the lowest modifier", 4, 1, 0, [A, B], Layers(L((A, 20), (B, 20))), B, 0 },
        { "tied natural 20s reroll", 1, 1, 0, [A, B], Layers(L((A, 20), (B, 20)), L((A, 7), (B, 3))), B, 1 },
        { "a natural 20 is no candidate", 0, 9, 0, [A, B], Layers(L((A, 20), (B, 19))), B, 0 },
        { "a tie breaks a layer later", 0, 0, 0, [A, B, C], Layers(L((A, 6), (B, 6), (C, 12)), L((A, 3), (B, 9))), A, 1 },
        { "a tie breaks two layers later", 0, 0, 0, [A, B, C], Layers(L((A, 6), (B, 6), (C, 6)), L((A, 3), (B, 3), (C, 9)), L((B, 2), (A, 7))), B, 2 },
    };

    [Theory]
    [MemberData(nameof(Resolutions))]
    public async Task A_round_resolves_the_same_in_both_engines(string why, int a, int b, int c, string[] roster, string layers, string brewer, int layer)
    {
        _ = why;
        await Parity(db => Modifiers(db, a, b, c), roster, layers, r =>
        {
            r.Brewer(brewer);
            Assert.Equal(layer, r.Round.GetProperty("current_layer").GetInt32());
            Assert.Equal(roster.Length, r.Round.GetProperty("cups_made").GetInt32());
            Assert.Equal(roster.Length, r.Round.GetProperty("brewer_modifier_gain").GetInt32());
            Assert.Equal("g-boss", r.Round.GetProperty("backfilled_by").GetString());
        });
    }

    [Fact]
    public async Task Nobody_needs_to_have_logged_in_today() =>
        await Parity(null, [A, B], Layers(L((A, 3), (B, 18))), r => r.Brewer(A));

    /// A Brew Debt holds a round with no Layer 0 rolls, so it must not hold this one, whose
    /// rolls are in before anything asks. Written out because advance_round_layer's roller
    /// check reads the debt, and a debtor who tied would otherwise look like a non-roller.
    [Fact]
    public async Task A_brew_debt_does_not_stop_a_debtor_tying_or_become_the_outcome()
    {
        var yesterday = Guid.Parse("10000000-0000-4000-8000-000000000002");
        var iou = Guid.Parse("20000000-0000-4000-8000-000000000002");
        Task Debt(TestDatabase db) => db.Execute($$"""
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
        await Parity(Debt, [A, B], Layers(L((A, 6), (B, 6)), L((A, 9), (B, 3))), r => r.Brewer(B));
    }

    [Fact]
    public async Task A_backfilled_round_commits_a_version_and_sends_nothing()
    {
        var db = await Seed();
        var result = await CSharp(db, Boss, [A, B], Layers(L((A, 5), (B, 12))));
        Assert.Null(result.Error);
        Assert.Equal(1L, await db.Scalar<long>($"select version from public.rooms where date = {Today}"));
        Assert.Equal(0L, await db.Scalar<long>("select count(*) from realtime.messages"));
    }

    [Fact]
    public async Task A_backfilled_round_reads_the_same_in_the_recap()
    {
        var db = await Seed();
        var result = await CSharp(db, Boss, [A, B, C], Layers(L((A, 6), (B, 6), (C, 12)), L((A, 3), (B, 9))));
        var recap = await Same(db, result.RoundId!.Value, await db.AddUser(A));
        Assert.Equal("tie", (string?)recap["layer_zero_outcome"]);
        Assert.Empty(recap["trace"]!.AsArray());
    }

    [Fact]
    public async Task The_sql_path_reads_a_round_c_sharp_backfilled()
    {
        var db = await Seed();
        await CSharp(db, Boss, [A, B], Layers(L((A, 5), (B, 12))));
        Assert.Equal(2m, await db.Scalar<decimal>($"select public._rr_base_modifier((select id from public.rooms where date = {Today}), 'p-a')::numeric"));
        // The next live round can start: nothing about this one is left open.
        Assert.Equal(0L, await db.Scalar<long>("select count(*) from public.rounds where status in ('open', 'closed')"));
    }

    // ------------------------------------------------------------------
    // The harness.
    // ------------------------------------------------------------------

    private sealed record Resolved(JsonElement Round)
    {
        public void Brewer(string id) => Assert.Equal(id, Round.GetProperty("brewer_id").GetString());
    }

    private static async Task Parity(Func<TestDatabase, Task>? seed, string[] roster, string layers, Action<Resolved> check)
    {
        var (sqlDb, csDb) = (await Seed(seed), await Seed(seed));
        var sql = await Sql(sqlDb, Boss, roster, layers);
        var cs = await CSharp(csDb, Boss, roster, layers);
        Assert.Null(sql.Error);
        Assert.Null(cs.Error);

        var known = Uuids.Matches(await Rows(await Seed(seed))).Select(m => m.Value).ToHashSet(StringComparer.OrdinalIgnoreCase);
        Assert.Equal(Masked(await Rows(sqlDb), known), Masked(await Rows(csDb), known));

        var round = (await sqlDb.Scalar<string>($"select to_jsonb(r)::text from public.rounds r where id = '{sql.RoundId}'"))!;
        using var doc = JsonDocument.Parse(round);
        check(new Resolved(doc.RootElement.Clone()));
    }

    private sealed record Result(Guid? RoundId, string? Error);

    private static async Task<Result> Sql(TestDatabase db, TestUser who, string[] roster, string layers)
    {
        await using var conn = new NpgsqlConnection(db.AdminConnectionString);
        await conn.OpenAsync();
        await using var tx = await conn.BeginTransactionAsync();
        await using (var claims = new NpgsqlCommand("select set_config('request.jwt.claims', @c, true)", conn, tx))
        {
            claims.Parameters.AddWithValue("c", CallerOf(who).ClaimsJson);
            await claims.ExecuteNonQueryAsync();
        }
        await using var cmd = new NpgsqlCommand("select public.admin_backfill_round(@ids, @layers)", conn, tx);
        cmd.Parameters.AddWithValue("ids", roster);
        cmd.Parameters.Add(new NpgsqlParameter("layers", NpgsqlTypes.NpgsqlDbType.Jsonb) { Value = layers });
        try
        {
            var id = (Guid)(await cmd.ExecuteScalarAsync())!;
            await tx.CommitAsync();
            return new Result(id, null);
        }
        catch (PostgresException e)
        {
            if (ProblemCatalog.FromSqlState(e.SqlState) is { } info) return new Result(null, $"{info.Code}|{e.MessageText}");
            return new Result(null, e.SqlState == "P0001" ? $"backfill_not_resolvable|{e.MessageText}" : e.SqlState);
        }
    }

    private static async Task<Result> CSharp(TestDatabase db, TestUser who, string[] roster, string layers)
    {
        var request = new BackfillRequest(roster, [.. JsonNode.Parse(layers)!.AsArray().Select(layer =>
            (IReadOnlyList<BackfillEntry>)[.. layer!.AsArray().Select(e =>
                new BackfillEntry((string?)e!["player_id"], (int?)e["value"]))])]);
        await using var ds = RoomStore.BuildDataSource(db.ApiConnectionString);
        try
        {
            return new Result(await RoundBackfillRules.Run(new RoomStore(ds), CallerOf(who), request), null);
        }
        catch (ProblemException e)
        {
            return new Result(null, $"{e.Code}|{e.ProblemDetail}");
        }
        catch (PostgresException e)
        {
            return new Result(null, e.SqlState);
        }
    }

    /// <summary>Every row backfill can write. rooms.version is left out: only C# bumps it.</summary>
    private static async Task<string> Rows(TestDatabase db) => AdvanceRoundParityTests.MaskNow((await db.Scalar<string>("""
        select jsonb_pretty(jsonb_build_object(
          'rooms', (select coalesce(jsonb_agg(to_jsonb(t) - 'version' order by t.date), '[]') from public.rooms t),
          'rounds', (select coalesce(jsonb_agg(to_jsonb(t) order by t.started_at, t.id), '[]') from public.rounds t),
          'participants', (select coalesce(jsonb_agg(to_jsonb(t) order by t.player_id, t.declared_at), '[]') from public.round_participants t),
          'layer_participants', (select coalesce(jsonb_agg(to_jsonb(t) order by t.layer, t.player_id), '[]') from public.round_layer_participants t),
          'rolls', (select coalesce(jsonb_agg(to_jsonb(t) order by t.layer, t.player_id), '[]') from public.rolls t),
          'room_players', (select coalesce(jsonb_agg(to_jsonb(t) order by t.player_id), '[]') from public.room_players t)
        ))
        """))!);

    private static readonly Regex Uuids = new("[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}", RegexOptions.IgnoreCase);

    private static string Masked(string text, HashSet<string> known)
    {
        var generated = new Dictionary<string, string>();
        return Uuids.Replace(text, m =>
        {
            if (known.Contains(m.Value)) return m.Value;
            if (!generated.TryGetValue(m.Value, out var alias)) generated[m.Value] = alias = $"<generated-{generated.Count}>";
            return alias;
        });
    }
}
