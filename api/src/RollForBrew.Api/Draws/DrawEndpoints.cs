using Npgsql;
using RollForBrew.Api.Auth;
using RollForBrew.Api.Data;
using RollForBrew.Api.Rolls;
using RollForBrew.Api.RoundCommands;
using RollForBrew.Domain.Commands;
using RollForBrew.Domain.Resolver;

namespace RollForBrew.Api.Draws;

/// <summary>Spell draws (spec #533, slice 4). Each runs under the round-row lock. C# owns the
/// checks and the deck claim, which keeps <c>for update skip locked</c>. The Draw Redirect rules
/// stay in SQL as two bridges: <c>_apply_crit_redirect</c> (Marked for Brew) picks a crit's
/// recipient, and <c>_land_drawn_instance</c> (Stale Biscuit, and where the card lands) places the
/// claimed card. Every successful call bumps <c>rooms.version</c> and sends <c>room-changed</c>.</summary>
public static class DrawEndpoints
{
    public sealed record RecordDrawRequest(string Trigger);
    public sealed record ManualDrawRequest(Guid CardId);
    public sealed record DrawAsRequest(string Trigger, string PlayerId, Guid? CardId);

    /// <summary><paramref name="InstanceId"/> is null when nothing was drawn (an empty deck).</summary>
    public sealed record DrawResponse(Guid? InstanceId, bool NeedsSwapDecision, long Version);

    public static IEndpointRouteBuilder MapDraws(this IEndpointRouteBuilder app)
    {
        app.MapPost("/rounds/{roundId:guid}/pending-draw", (Guid roundId, RecordDrawRequest body, HttpContext http, RoomStore store, CancellationToken ct) =>
            Run(http, store, roundId, async (s, round) =>
            {
                RequireTrigger(body.Trigger);
                var player = await s.CurrentPlayerId(roundId, ct: ct);
                await WritePersister.Apply(s, new RecordCritDraw(roundId, player, body.Trigger), ct);
                return new RoundCommandEndpoints.CommandResponse(await s.BumpAndAnnounce(round.RoomId, Announce.Required, ct));
            }, ct))
            .Produces<RoundCommandEndpoints.CommandResponse>().WithName("recordPendingSpellDraw");

        app.MapPost("/rounds/{roundId:guid}/draws", (Guid roundId, HttpContext http, RoomStore store, CancellationToken ct) =>
            Run(http, store, roundId, (s, round) => DrawPending(s, round, cardId: null, ct), ct))
            .Produces<DrawResponse>().WithName("drawPendingSpellCard");

        app.MapPost("/rounds/{roundId:guid}/draws/manual", (Guid roundId, ManualDrawRequest body, HttpContext http, RoomStore store, CancellationToken ct) =>
            Run(http, store, roundId, (s, round) => DrawPending(s, round, body.CardId, ct), ct))
            .Produces<DrawResponse>().WithName("drawPendingSpellCardManual");

        app.MapPost("/rounds/{roundId:guid}/draws/as", (Guid roundId, DrawAsRequest body, HttpContext http, RoomStore store, CancellationToken ct) =>
            Run(http, store, roundId, (s, round) => DrawAs(s, round, body, ct), ct))
            .Produces<DrawResponse>().WithName("drawSpellCardAs");
        return app;
    }

    private static async Task<IResult> Run<T>(
        HttpContext http, RoomStore store, Guid roundId, Func<StoreSession, RoundLock, Task<T>> work, CancellationToken ct) =>
        Results.Ok(await store.Advance(http.GetCaller(), roundId, (round, s) =>
            round is null ? throw new CommandRefusal("round_not_found", "round not found") : work(s, round), ct));

    /// <summary>The caller's Pending Spell Draw for the round: a random card, or the named one
    /// ("I drew this IRL"). The pending row goes once a card is claimed, or when the deck is empty;
    /// a named card that is not in the deck keeps it, so the player can retry.</summary>
    private static async Task<DrawResponse> DrawPending(StoreSession s, RoundLock round, Guid? cardId, CancellationToken ct)
    {
        var player = await s.CurrentPlayerId(round.RoundId, ct: ct);
        var trigger = await Scalar(s, ct,
            "select trigger from public.pending_spell_draws where round_id = @round and player_id = @player",
            ("round", round.RoundId), ("player", player)) as string
            ?? throw new CommandRefusal("no_pending_spell_draw", "caller has no pending spell draw for this round");
        await RequireNoSwapDecision(s, player, ct);

        var instance = await Claim(s, cardId, ct);
        await Exec(s, ct, "delete from public.pending_spell_draws where round_id = @round and player_id = @player",
            ("round", round.RoundId), ("player", player));
        return await Land(s, round, player, instance, trigger, ct);
    }

    /// <summary>The Test Room puppet path's crit: an admin draws now for another player, with no
    /// pending row. The crit's recipient is the redirect hook's, and a null recipient draws nothing.</summary>
    private static async Task<DrawResponse> DrawAs(StoreSession s, RoundLock round, DrawAsRequest body, CancellationToken ct)
    {
        await RollEndpoints.RequireAdmin(s, ct);
        if (await Scalar(s, ct, "select is_test from public.rooms where id = @room", ("room", round.RoomId)) is not true)
            throw new CommandRefusal("round_not_in_test_room", "round is not in the Test Room");
        RequireTrigger(body.Trigger);
        if (await Scalar(s, ct, "select exists (select 1 from public.players where id = @id)", ("id", body.PlayerId)) is not true)
            throw new CommandRefusal("target_player_not_found", "target player not found");

        var recipient = await Scalar(s, ct, "select public._apply_crit_redirect(@round, @player)",
            ("round", round.RoundId), ("player", body.PlayerId)) as string;
        if (recipient is null) return new DrawResponse(null, false, await s.BumpAndAnnounce(round.RoomId, Announce.Required, ct));
        await RequireNoSwapDecision(s, recipient, ct);

        var instance = await Claim(s, body.CardId, ct);
        return await Land(s, round, recipient, instance, body.Trigger, ct);
    }

    /// <summary>Claims one in-deck instance (the named card's, or any at random). Skip-locked, so
    /// two concurrent draws never claim one instance and neither waits on the other.</summary>
    private static async Task<Guid?> Claim(StoreSession s, Guid? cardId, CancellationToken ct)
    {
        if (cardId is null)
            return await Scalar(s, ct, """
                select id from public.spell_deck_instances
                 where location = 'in_deck'
                 order by random()
                 limit 1
                   for update skip locked
                """) as Guid?;
        return await Scalar(s, ct, """
            select id from public.spell_deck_instances
             where card_id = @card and location = 'in_deck'
             limit 1
               for update skip locked
            """, ("card", cardId.Value)) as Guid?
            ?? throw new CommandRefusal("card_not_in_deck", "that card is not currently in the deck");
    }

    private static async Task<DrawResponse> Land(
        StoreSession s, RoundLock round, string player, Guid? instance, string trigger, CancellationToken ct)
    {
        var needsSwap = instance is not null && await Scalar(s, ct,
            "select public._land_drawn_instance(@player, @instance, @trigger)",
            ("player", player), ("instance", instance.Value), ("trigger", trigger)) is true;
        return new DrawResponse(instance, needsSwap, await s.BumpAndAnnounce(round.RoomId, Announce.Required, ct));
    }

    private static async Task RequireNoSwapDecision(StoreSession s, string player, CancellationToken ct)
    {
        if (await Scalar(s, ct,
                "select exists (select 1 from public.spell_deck_instances where held_by_player = @player and location = 'pending_swap')",
                ("player", player)) is true)
            throw new CommandRefusal("pending_swap_decision_open", "player already has a pending keep-or-swap decision");
    }

    private static void RequireTrigger(string? trigger)
    {
        if (trigger is not ("nat1" or "nat20"))
            throw new CommandRefusal("invalid_draw_trigger", $"invalid trigger {trigger}");
    }

    /// <summary>The first column of the first row, or null for no row or a SQL null.</summary>
    private static async Task<object?> Scalar(StoreSession s, CancellationToken ct, string sql, params (string Name, object Value)[] args)
    {
        await using var cmd = new NpgsqlCommand(sql, s.Connection, s.Transaction);
        foreach (var (name, value) in args) cmd.Parameters.AddWithValue(name, value);
        return await cmd.ExecuteScalarAsync(ct) is { } v and not DBNull ? v : null;
    }

    private static async Task Exec(StoreSession s, CancellationToken ct, string sql, params (string Name, object Value)[] args)
    {
        await using var cmd = new NpgsqlCommand(sql, s.Connection, s.Transaction);
        foreach (var (name, value) in args) cmd.Parameters.AddWithValue(name, value);
        await cmd.ExecuteNonQueryAsync(ct);
    }
}
