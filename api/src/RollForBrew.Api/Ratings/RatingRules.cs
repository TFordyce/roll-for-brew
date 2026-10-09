using Microsoft.EntityFrameworkCore;
using RollForBrew.Api.Data;
using RollForBrew.Api.Problems;

namespace RollForBrew.Api.Ratings;

public static class RatingRules
{
    private static ProblemException Problem(string sqlState) =>
        ProblemException.FromInfo(ProblemCatalog.FromSqlState(sqlState)!, null);

    private static void CheckScore(int? score, string sqlState)
    {
        if (score is null or < 1 or > 5) throw Problem(sqlState);
    }

    private static Task<bool> WindowClosed(RfbDbContext db, RatingRound round, CancellationToken ct) =>
        db.Set<RatingRound>().AnyAsync(r => r.RoomId == round.RoomId && r.Status == "resolved" && r.ResolvedAt > round.ResolvedAt, ct);

    private static async Task<Guid> Upsert(StoreSession s, string sql, Guid key, string? brewer, string rater, int score, CancellationToken ct)
    {
        await using var cmd = new Npgsql.NpgsqlCommand(sql, s.Connection, s.Transaction);
        cmd.Parameters.AddWithValue("a", key);
        if (brewer is not null) cmd.Parameters.AddWithValue("b", brewer);
        cmd.Parameters.AddWithValue("c", rater);
        cmd.Parameters.AddWithValue("d", score);
        return (Guid)(await cmd.ExecuteScalarAsync(ct))!;
    }

    public static async Task<Guid> SubmitBrewRating(StoreSession s, Guid roundId, int? score, CancellationToken ct)
    {
        var rater = await s.CurrentPlayerId(ct: ct);
        CheckScore(score, "RFB22");
        var db = s.Db;

        var round = await db.Set<RatingRound>().AsNoTracking().SingleOrDefaultAsync(r => r.Id == roundId, ct);
        if (round is null || round.Status != "resolved") throw Problem("RFB23");
        if (!await db.Set<RatingParticipant>().AnyAsync(p => p.RoundId == roundId && p.PlayerId == rater, ct))
            throw Problem("RFB24");
        if (round.BrewerId == rater) throw Problem("RFB25");

        var newerOwn = await (from r in db.Set<RatingRound>()
                              join p in db.Set<RatingParticipant>() on r.Id equals p.RoundId
                              where p.PlayerId == rater && r.Status == "resolved"
                                    && (r.BrewerId == null || r.BrewerId != rater)
                                    && r.ResolvedAt > round.ResolvedAt
                              select r.Id).AnyAsync(ct);
        if (newerOwn) throw Problem("RFB26");
        if (await WindowClosed(db, round, ct)) throw Problem("RFB27");

        return await Upsert(s, "insert into public.brew_ratings (round_id, brewer_id, rater_player_id, score) values (@a, @b, @c, @d) on conflict (round_id, rater_player_id) do update set score = excluded.score, updated_at = now() returning id", roundId, round.BrewerId, rater, score!.Value, ct);
    }

    public static async Task WithdrawBrewRating(StoreSession s, Guid roundId, CancellationToken ct)
    {
        var rater = await s.CurrentPlayerId(ct: ct);
        var db = s.Db;
        var round = await db.Set<RatingRound>().AsNoTracking().SingleOrDefaultAsync(r => r.Id == roundId, ct)
                    ?? throw Problem("RFB23");
        if (await WindowClosed(db, round, ct)) throw Problem("RFB27");
        await db.Set<BrewRating>().Where(r => r.RoundId == roundId && r.RaterPlayerId == rater).ExecuteDeleteAsync(ct);
    }

    public static async Task<int?> MyBrewRating(StoreSession s, Guid roundId, CancellationToken ct)
    {
        var me = await s.CurrentPlayerId(ct: ct);
        return await s.Db.Set<BrewRating>().AsNoTracking()
            .Where(r => r.RoundId == roundId && r.RaterPlayerId == me)
            .Select(r => (int?)r.Score).SingleOrDefaultAsync(ct);
    }

    public static async Task<Guid> RateSpellCard(StoreSession s, Guid cardId, int? score, CancellationToken ct)
    {
        var rater = await s.CurrentPlayerId(ct: ct);
        CheckScore(score, "RFB41");
        var db = s.Db;
        if (!await db.Set<RatingCard>().AnyAsync(c => c.Id == cardId, ct)) throw Problem("RFB42");

        var eligible = await (from c in db.Set<RatingCast>()
                              join i in db.Set<RatingDeckInstance>() on c.CardInstanceId equals i.Id
                              join r in db.Set<RatingRound>() on c.RoundId equals r.Id
                              join room in db.Set<RatingRoom>() on r.RoomId equals room.Id
                              where c.CasterId == rater && !c.Negated && i.CardId == cardId
                                    && r.Status == "resolved" && !room.IsTest
                              select c.Id).AnyAsync(ct);
        if (!eligible) throw Problem("RFB43");

        return await Upsert(s, "insert into public.spell_card_ratings (card_id, rater_player_id, score) values (@a, @c, @d) on conflict (card_id, rater_player_id) do update set score = excluded.score, updated_at = now() returning id", cardId, null, rater, score!.Value, ct);
    }

    public static async Task WithdrawSpellCardRating(StoreSession s, Guid cardId, CancellationToken ct)
    {
        var rater = await s.CurrentPlayerId(ct: ct);
        await s.Db.Set<SpellCardRating>().Where(r => r.CardId == cardId && r.RaterPlayerId == rater).ExecuteDeleteAsync(ct);
    }

    public static async Task<int?> MySpellCardRating(StoreSession s, Guid cardId, CancellationToken ct)
    {
        var me = await s.CurrentPlayerId(ct: ct);
        return await s.Db.Set<SpellCardRating>().AsNoTracking()
            .Where(r => r.CardId == cardId && r.RaterPlayerId == me)
            .Select(r => (int?)r.Score).SingleOrDefaultAsync(ct);
    }
}
