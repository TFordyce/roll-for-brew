using Npgsql;
using RollForBrew.Api.Auth;
using RollForBrew.Api.Data;
using RollForBrew.Api.Problems;
using RollForBrew.Domain.Commands;
using RollForBrew.Domain.Resolver;
using RollForBrew.Domain.Snapshot;
using RollForBrew.Tests.Harness;

namespace RollForBrew.Tests;

/// <summary>Seam 2 for the command path (#547): round lock, snapshot, decide, write batch,
/// version bump and in-transaction broadcast, all in one transaction.</summary>
public class RoomStoreCommandTests : IAsyncLifetime
{
    private TestDatabase _db = null!;
    private NpgsqlDataSource _ds = null!;
    private RoomStore _store = null!;
    private Caller _caller = null!;
    private Guid _room;
    private Guid _round;

    public async Task InitializeAsync()
    {
        _db = await TestPostgres.CreateDatabase();
        _ds = RoomStore.BuildDataSource(_db.ApiConnectionString);
        _store = new RoomStore(_ds);
        var u = await _db.AddUser("g-cmd");
        _caller = new Caller(u.AuthId.ToString(), $$"""{"sub":"{{u.AuthId}}","role":"authenticated"}""");
        _room = Guid.NewGuid();
        _round = Guid.NewGuid();
        await _db.Execute($"""
            insert into public.rooms (id, date) values ('{_room}', '2026-01-01');
            insert into public.rounds (id, room_id, started_by, status, started_at, closed_at) values
              ('{_round}', '{_room}', 'g-cmd', 'closed', '2026-01-01 09:00+00', '2026-01-01 09:01+00');
            insert into public.room_players (room_id, player_id, modifier) values ('{_room}', 'g-cmd', 0);
            """);
    }

    public async Task DisposeAsync()
    {
        await _ds.DisposeAsync();
        await _db.DisposeAsync();
    }

    private Task<long> Version() => _db.Scalar<long>($"select version from public.rooms where id = '{_room}'");
    private Task<long> Messages() => _db.Scalar<long>("select count(*) from realtime.messages");

    private Decision<string> Touch(string result = "done") => new(
        [new SetRoomPlayerModifier(_room, "g-cmd", 7)],
        [new RoomEvent("room-changed", [])],
        result);

    [Theory]
    [InlineData("resolve_round_not_participant", 422)]
    [InlineData("resolve_round_not_all_rolled", 409)]
    [InlineData("resolve_round_not_found", 404)]
    public async Task A_resolver_refusal_becomes_a_problem_and_rolls_back(string code, int status)
    {
        var ex = await Assert.ThrowsAsync<ProblemException>(() => _store.Command<string>(_round, _caller,
            _ => throw new ResolveException(code, "resolve_round: the message")));

        Assert.Equal(code, ex.Code);
        Assert.Equal(status, ex.Status);
        Assert.Equal("resolve_round: the message", ex.ProblemDetail);
    }

    [Fact]
    public async Task A_committed_write_bumps_the_version_and_delivers_the_event_with_it()
    {
        var outcome = await _store.Command(_round, _caller, _ => Touch());

        Assert.Equal("done", outcome.Result);
        Assert.Equal(1, outcome.Version);
        Assert.Equal(1, await Version());
        Assert.Equal(7, await _db.Scalar<int>($"select modifier from public.room_players where room_id = '{_room}'"));
        Assert.Equal(1, await Messages());
        Assert.Equal($"room:{_room}", await _db.Scalar<string>("select topic from realtime.messages"));
        Assert.Equal("room-changed", await _db.Scalar<string>("select event from realtime.messages"));
        Assert.Equal(1L, await _db.Scalar<long>("select (payload ->> 'version')::bigint from realtime.messages"));
        Assert.False(await _db.Scalar<bool>("select private from realtime.messages"));
    }

    [Fact]
    public async Task A_rolled_back_command_delivers_nothing_and_keeps_the_version()
    {
        // The send has already run when the transaction fails: force the failure at commit
        // with a deferred check, so a rollback has to undo a message that was really sent.
        await _db.Execute("""
            create function realtime.fail_on_commit() returns trigger language plpgsql as $f$
            begin raise exception 'commit failed'; end $f$;
            create constraint trigger fail_on_commit after insert on realtime.messages
              deferrable initially deferred for each row execute function realtime.fail_on_commit();
            """);

        await Assert.ThrowsAsync<PostgresException>(() => _store.Command(_round, _caller, _ => Touch()));

        Assert.Equal(0, await Messages());
        Assert.Equal(0, await Version());
        Assert.Equal(0, await _db.Scalar<int>($"select modifier from public.room_players where room_id = '{_room}'"));
    }

    [Fact]
    public async Task An_empty_write_list_bumps_nothing_and_sends_nothing()
    {
        var outcome = await _store.Command(_round, _caller, _ => new Decision<string>([], [new RoomEvent("room-changed", [])], "noop"));

        Assert.Equal("noop", outcome.Result);
        Assert.Null(outcome.Version);
        Assert.Equal(0, await Version());
        Assert.Equal(0, await Messages());
    }

    [Fact]
    public async Task A_swallowed_send_failure_is_an_error_and_rolls_the_command_back()
    {
        // Hosted realtime.send catches everything and RAISEs a WARNING instead.
        await _db.Execute("""
            create or replace function realtime.send(payload jsonb, event text, topic text, private boolean default true)
            returns void language plpgsql as $f$
            begin raise warning 'ErrorSendingBroadcastMessage: boom'; end $f$;
            """);

        var ex = await Assert.ThrowsAsync<ProblemException>(() => _store.Command(_round, _caller, _ => Touch()));

        Assert.Equal("broadcast_failed", ex.Code);
        Assert.Equal(0, await Version());
        Assert.Equal(0, await _db.Scalar<int>($"select modifier from public.room_players where room_id = '{_room}'"));
    }

    [Fact]
    public async Task A_missing_round_decides_on_a_null_snapshot()
    {
        var calls = 0;
        RoundSnapshot? seen = null;
        var outcome = await _store.Command(Guid.NewGuid(), _caller, s =>
        {
            calls++;
            seen = s;
            return new Decision<string>([], [], "missing");
        });
        Assert.Equal(1, calls);
        Assert.Null(seen);
        Assert.Equal("missing", outcome.Result);
    }

    [Fact]
    public async Task Reload_after_write_decides_again_on_the_fresh_snapshot_with_one_bump_and_all_events()
    {
        var passes = new List<int>();
        var outcome = await _store.Command(_round, _caller, s =>
        {
            var modifier = s!.RoomPlayers.Single().Modifier;
            passes.Add(modifier);
            return modifier == 0
                ? new Decision<string>([new SetRoomPlayerModifier(_room, "g-cmd", 3)], [new RoomEvent("first", [])], "pending", ReloadAfterWrite: true)
                : new Decision<string>([], [new RoomEvent("second", [])], $"saw {modifier}");
        });

        Assert.Equal([0, 3], passes);
        Assert.Equal("saw 3", outcome.Result);
        Assert.Equal(1, outcome.Version);
        Assert.Equal(1, await Version());
        Assert.Equal(2, await Messages());
        Assert.Equal(2L, await _db.Scalar<long>("select count(*) from realtime.messages where (payload ->> 'version')::bigint = 1"));
    }

    [Fact]
    public async Task The_broadcast_wrapper_is_definer_owned_and_only_rfb_api_can_call_it()
    {
        Assert.Equal("postgres", await _db.Scalar<string>(
            "select pg_get_userbyid(proowner)::text from pg_proc where proname = 'rfb_broadcast'"));
        Assert.True(await _db.Scalar<bool>("select prosecdef from pg_proc where proname = 'rfb_broadcast'"));
        Assert.Equal("search_path=\"\"", await _db.Scalar<string>("select proconfig[1] from pg_proc where proname = 'rfb_broadcast'"));
        foreach (var role in new[] { "anon", "authenticated", "service_role" })
            Assert.False(await _db.Scalar<bool>($"select has_function_privilege('{role}', 'public.rfb_broadcast(text, text, jsonb)', 'execute')"));
        Assert.True(await _db.Scalar<bool>("select has_function_privilege('rfb_api', 'public.rfb_broadcast(text, text, jsonb)', 'execute')"));
        Assert.False(await _db.Scalar<bool>("select has_schema_privilege('rfb_api', 'realtime', 'usage')"));
    }

    [Fact]
    public async Task The_authority_flag_is_seeded_off_and_separate_from_the_shadow_flag()
    {
        Assert.False(await _db.Scalar<bool>("select enabled from public.port_flags where slice = 'advanceRoundAuthoritative' and room_id is null"));
        Assert.False(await _db.Scalar<bool>("select enabled from public.port_flags where slice = 'advanceRound' and room_id is null"));
    }
}
