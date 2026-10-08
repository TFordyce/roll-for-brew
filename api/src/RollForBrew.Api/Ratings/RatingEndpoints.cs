using RollForBrew.Api.Auth;
using RollForBrew.Api.Data;

namespace RollForBrew.Api.Ratings;

public static class RatingEndpoints
{
    public sealed record ScoreRequest(int? Score);
    public sealed record RatingIdResponse(Guid Id);
    public sealed record MyRatingResponse(int? Score);

    public static IEndpointRouteBuilder MapRatings(this IEndpointRouteBuilder app)
    {
        // Operation names match the TS wrappers (docs/port/port-flags.md).
        app.MapPut("/brew-ratings/{roundId:guid}", async (HttpContext http, RoomStore store, Guid roundId, ScoreRequest body, CancellationToken ct) =>
            Results.Ok(new RatingIdResponse(await store.Filler(http.GetCaller(),
                s => RatingRules.SubmitBrewRating(s, roundId, body.Score, ct), ct))))
            .Produces<RatingIdResponse>().WithName("submitBrewRating");

        app.MapDelete("/brew-ratings/{roundId:guid}", async (HttpContext http, RoomStore store, Guid roundId, CancellationToken ct) =>
        {
            await store.Filler(http.GetCaller(), async s => { await RatingRules.WithdrawBrewRating(s, roundId, ct); return 0; }, ct);
            return Results.NoContent();
        }).WithName("withdrawBrewRating");

        app.MapGet("/brew-ratings/{roundId:guid}/mine", async (HttpContext http, RoomStore store, Guid roundId, CancellationToken ct) =>
            Results.Ok(new MyRatingResponse(await store.Read(http.GetCaller(), s => RatingRules.MyBrewRating(s, roundId, ct), ct))))
            .Produces<MyRatingResponse>().WithName("getMyBrewRating");

        app.MapPut("/spell-card-ratings/{cardId:guid}", async (HttpContext http, RoomStore store, Guid cardId, ScoreRequest body, CancellationToken ct) =>
            Results.Ok(new RatingIdResponse(await store.Filler(http.GetCaller(),
                s => RatingRules.RateSpellCard(s, cardId, body.Score, ct), ct))))
            .Produces<RatingIdResponse>().WithName("rateSpellCard");

        app.MapDelete("/spell-card-ratings/{cardId:guid}", async (HttpContext http, RoomStore store, Guid cardId, CancellationToken ct) =>
        {
            await store.Filler(http.GetCaller(), async s => { await RatingRules.WithdrawSpellCardRating(s, cardId, ct); return 0; }, ct);
            return Results.NoContent();
        }).WithName("withdrawSpellCardRating");

        app.MapGet("/spell-card-ratings/{cardId:guid}/mine", async (HttpContext http, RoomStore store, Guid cardId, CancellationToken ct) =>
            Results.Ok(new MyRatingResponse(await store.Read(http.GetCaller(), s => RatingRules.MySpellCardRating(s, cardId, ct), ct))))
            .Produces<MyRatingResponse>().WithName("getMySpellCardRating");
        return app;
    }
}
