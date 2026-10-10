using Microsoft.EntityFrameworkCore;
using RollForBrew.Api.Auth;
using RollForBrew.Api.Data;
using RollForBrew.Api.Problems;
using RollForBrew.Domain;

namespace RollForBrew.Api.Orders;

public static class OrderEndpoints
{
    public sealed record SubmitOrderRequest(string? DrinkType);
    public sealed record OrderResponse(string? DrinkType);

    public static IEndpointRouteBuilder MapOrders(this IEndpointRouteBuilder app)
    {
        app.MapPut("/rounds/{roundId:guid}/order", async (Guid roundId, SubmitOrderRequest body, HttpContext http, RoomStore store, CancellationToken ct) =>
        {
            var caller = http.GetCaller();
            await store.Filler(caller, async s =>
            {
                var me = await s.CurrentPlayerId(ct: ct);
                var round = await s.Db.Set<RollForBrew.Api.Ratings.RatingRound>().AsNoTracking().SingleOrDefaultAsync(r => r.Id == roundId, ct);
                var laterResolved = round is not null && await s.Db.Set<RollForBrew.Api.Ratings.RatingRound>().AsNoTracking()
                    .AnyAsync(r => r.RoomId == round.RoomId && r.StartedAt > round.StartedAt && r.Status == "resolved", ct);

                switch (OrderWindow.Check(body.DrinkType, round?.Status, laterResolved))
                {
                    case OrderVerdict.DrinkTypeInvalid: throw Problem("RFB28");
                    case OrderVerdict.RoundNotOpen: throw Problem("RFB29");
                    case OrderVerdict.WindowClosed: throw Problem("RFB30");
                }

                var now = DateTime.UtcNow;
                var existing = await s.Db.Orders.SingleOrDefaultAsync(o => o.RoundId == roundId && o.PlayerId == me, ct);
                if (existing is null)
                    s.Db.Orders.Add(new Order { RoundId = roundId, PlayerId = me, DrinkType = body.DrinkType!, CreatedAt = now, UpdatedAt = now });
                else
                {
                    existing.DrinkType = body.DrinkType!;
                    existing.UpdatedAt = now;
                }
                await s.Db.SaveChangesAsync(ct);
                return 0;
            }, ct);
            return Results.NoContent();
        }).Produces(StatusCodes.Status204NoContent).WithName("submitOrder");

        app.MapGet("/rounds/{roundId:guid}/order", async (Guid roundId, HttpContext http, RoomStore store, CancellationToken ct) =>
        {
            var drink = await store.Read(http.GetCaller(), async s =>
            {
                var me = await s.CurrentPlayerId(ct: ct);
                return await s.Db.Orders.AsNoTracking()
                    .Where(o => o.RoundId == roundId && o.PlayerId == me)
                    .Select(o => o.DrinkType).SingleOrDefaultAsync(ct);
            }, ct);
            return Results.Ok(new OrderResponse(drink));
        }).Produces<OrderResponse>().WithName("getMyOrderForRound");

        app.MapGet("/orders/latest", async (HttpContext http, RoomStore store, CancellationToken ct) =>
        {
            var drink = await store.Read(http.GetCaller(), async s =>
            {
                var me = await s.CurrentPlayerId(ct: ct);
                return await s.Db.Orders.AsNoTracking()
                    .Where(o => o.PlayerId == me)
                    .OrderByDescending(o => o.UpdatedAt)
                    .Select(o => o.DrinkType).FirstOrDefaultAsync(ct);
            }, ct);
            return Results.Ok(new OrderResponse(drink));
        }).Produces<OrderResponse>().WithName("getMyMostRecentOrder");
        return app;
    }

    private static ProblemException Problem(string sqlState) =>
        ProblemException.FromInfo(ProblemCatalog.FromSqlState(sqlState)!, null);
}
