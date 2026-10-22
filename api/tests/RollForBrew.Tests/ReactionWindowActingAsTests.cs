using Npgsql;
using RollForBrew.Tests.Harness;

namespace RollForBrew.Tests;

/// <summary>
/// Issue #591: pass_reaction_window must resolve its caller with the round in
/// scope, so an admin playing a test room via acting-as passes as the player
/// they act for. The bare current_player_id() it called before recorded the
/// admin — whose pass never counts as a Reaction Source, so the window could
/// never close via Pass and the eligible holder's alreadyPassed stayed false.
/// </summary>
public class ReactionWindowActingAsTests(ApiHost api) : IClassFixture<ApiHost>
{
    [Fact]
    public async Task An_admin_passing_under_acting_as_records_the_test_players_pass_and_closes_the_window()
    {
        var admin = await api.Db.AddUser("g-rwa-admin", admin: true);
        await api.Db.AddUser("g-rwa-target");
        var round = await SeedOpenWindow("g-rwa-admin", "g-rwa-target", withActingAs: true);

        var closed = await PassAs(admin.AuthId, round);

        Assert.True(closed);
        Assert.Equal(1L, await PassCount(round, "g-rwa-target"));
        Assert.Equal(0L, await PassCount(round, "g-rwa-admin"));
        Assert.Equal("closed",
            await api.Db.Scalar<string>($"select status from public.spell_reaction_windows where round_id = '{round}'"));
    }

    [Fact]
    public async Task Without_acting_as_the_admin_passes_as_themselves_and_the_window_stays_open()
    {
        var admin = await api.Db.AddUser("g-rww-admin", admin: true);
        await api.Db.AddUser("g-rww-target");
        var round = await SeedOpenWindow("g-rww-admin", "g-rww-target", withActingAs: false);

        var closed = await PassAs(admin.AuthId, round);

        Assert.False(closed);
        Assert.Equal(1L, await PassCount(round, "g-rww-admin"));
        Assert.Equal(0L, await PassCount(round, "g-rww-target"));
        Assert.Equal("open",
            await api.Db.Scalar<string>($"select status from public.spell_reaction_windows where round_id = '{round}'"));
    }

    /// <summary>Calls pass_reaction_window as the authenticated caller behind
    /// <paramref name="authId"/>, the same way PostgREST presents the JWT.</summary>
    private async Task<bool> PassAs(Guid authId, Guid round)
    {
        await using var conn = new NpgsqlConnection(api.Db.AdminConnectionString);
        await conn.OpenAsync();
        await using var tx = await conn.BeginTransactionAsync();
        await using (var set = new NpgsqlCommand("select set_config('request.jwt.claims', @c, true)", conn, tx))
        {
            set.Parameters.AddWithValue("c", $$"""{"sub":"{{authId}}","role":"authenticated"}""");
            await set.ExecuteNonQueryAsync();
        }

        await using var call = new NpgsqlCommand($"select public.pass_reaction_window('{round}')", conn, tx);
        var closed = (bool)(await call.ExecuteScalarAsync())!;
        await tx.CommitAsync();
        return closed;
    }

    private async Task<long> PassCount(Guid round, string playerId) =>
        await api.Db.Scalar<long>($"""
            select count(*) from public.spell_reaction_passes p
            join public.spell_reaction_windows w on w.id = p.window_id
            where w.round_id = '{round}' and p.player_id = '{playerId}'
            """);

    /// <summary>A test room with an open layer-0 window; <paramref name="targetId"/>
    /// holds a Reaction card, so they are the window's one eligible holder.</summary>
    private async Task<Guid> SeedOpenWindow(string adminId, string targetId, bool withActingAs)
    {
        if (withActingAs)
            await api.Db.Execute(
                $"insert into public.admin_acting_as (admin_player_id, acting_as_player_id) values ('{adminId}', '{targetId}')");

        var room = Guid.NewGuid();
        var round = Guid.NewGuid();
        await api.Db.Execute($"""
            insert into public.rooms (id, date, is_test) values ('{room}', '{DateTime.UtcNow.AddDays(Random.Shared.Next(1, 100000)):yyyy-MM-dd}', true);
            insert into public.rounds (id, room_id, started_by, status) values ('{round}', '{room}', '{adminId}', 'open');
            insert into public.round_participants (round_id, player_id) values ('{round}', '{adminId}'), ('{round}', '{targetId}');
            insert into public.room_players (room_id, player_id, modifier) values ('{room}', '{adminId}', 0), ('{room}', '{targetId}', 0);
            insert into public.spell_deck_instances (id, card_id, location, held_by_player)
              select '{Guid.NewGuid()}', id, 'held', '{targetId}' from public.spell_cards where name = 'Six Sugars';
            insert into public.spell_reaction_windows (id, round_id, layer, status, poll_round, opened_at)
              values ('{Guid.NewGuid()}', '{round}', 0, 'open', 1, now());
            """);
        return round;
    }
}
