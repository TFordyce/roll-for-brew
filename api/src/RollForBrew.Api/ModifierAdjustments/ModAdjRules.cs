using Microsoft.EntityFrameworkCore;
using Npgsql;
using RollForBrew.Api.Data;
using RollForBrew.Api.Problems;

namespace RollForBrew.Api.ModifierAdjustments;

public static class ModAdjRules
{
    private static ProblemException Problem(string sqlState) =>
        ProblemException.FromInfo(ProblemCatalog.FromSqlState(sqlState)!, null);

    public static async Task<Guid> Log(StoreSession s, string targetPlayerId, int delta, string? reason, CancellationToken ct)
    {
        var actor = await s.CurrentPlayerId(ct: ct);
        if (delta == 0) throw Problem("RFB10");
        var trimmed = (reason ?? "").Trim();
        if (trimmed.Length == 0) throw Problem("RFB11");

        await using var q = new NpgsqlCommand(
            "select id from public.rooms where date = ((now() at time zone 'Europe/London')::date)", s.Connection, s.Transaction);
        var roomId = (Guid?)await q.ExecuteScalarAsync(ct)
            ?? throw new ProblemException("no_room_today", ProblemClass.Missing, "No room exists for today.");

        var db = s.Db;
        if (!await db.Set<ModAdjRoomPlayer>().AnyAsync(p => p.RoomId == roomId && p.PlayerId == targetPlayerId, ct))
            throw Problem("RFB12");

        var row = new ModAdjRow { RoomId = roomId, TargetPlayerId = targetPlayerId, ActorPlayerId = actor, Delta = delta, Reason = trimmed };
        db.Set<ModAdjRow>().Add(row);
        await db.SaveChangesAsync(ct);
        await Bump(db, roomId, targetPlayerId, delta, ct);
        return row.Id;
    }

    public static async Task Undo(StoreSession s, Guid id, CancellationToken ct)
    {
        var actor = await s.CurrentPlayerId(ct: ct);
        var db = s.Db;
        var row = await db.Set<ModAdjRow>().AsNoTracking().SingleOrDefaultAsync(r => r.Id == id, ct)
                  ?? throw Problem("RFB21");
        if (row.ActorPlayerId != actor) throw Problem("RFB13");

        var latest = await db.Set<ModAdjRow>().AsNoTracking().Where(r => r.ActorPlayerId == actor)
            .OrderByDescending(r => r.CreatedAt).ThenByDescending(r => r.Id).Select(r => r.Id).FirstAsync(ct);
        if (latest != id) throw Problem("RFB14");

        await using var q = new NpgsqlCommand(
            "select now() - created_at > interval '5 minutes' from public.modifier_adjustments where id = @id", s.Connection, s.Transaction);
        q.Parameters.AddWithValue("id", id);
        if ((bool)(await q.ExecuteScalarAsync(ct))!) throw Problem("RFB15");

        await Bump(db, row.RoomId, row.TargetPlayerId, -row.Delta, ct);
        await db.Set<ModAdjRow>().Where(r => r.Id == id).ExecuteDeleteAsync(ct);
    }

    public static async Task AdminDelete(StoreSession s, Guid id, string? reason, CancellationToken ct)
    {
        var caller = await s.CurrentPlayerId(ct: ct);
        var db = s.Db;
        var isAdmin = await db.Set<ModAdjPlayer>().Where(p => p.Id == caller).Select(p => p.IsAdmin).SingleOrDefaultAsync(ct);
        if (!isAdmin) throw Problem("RFB19");
        var trimmed = (reason ?? "").Trim();
        if (trimmed.Length == 0) throw Problem("RFB20");
        var row = await db.Set<ModAdjRow>().AsNoTracking().SingleOrDefaultAsync(r => r.Id == id, ct)
                  ?? throw Problem("RFB21");

        db.Set<ModAdjDeletion>().Add(new ModAdjDeletion
        {
            AdjustmentId = row.Id, RoomId = row.RoomId, TargetPlayerId = row.TargetPlayerId,
            OriginalActorPlayerId = row.ActorPlayerId, Delta = row.Delta, OriginalReason = row.Reason,
            ActorPlayerId = caller, Reason = trimmed,
        });
        await db.SaveChangesAsync(ct);
        await Bump(db, row.RoomId, row.TargetPlayerId, -row.Delta, ct);
        await db.Set<ModAdjRow>().Where(r => r.Id == id).ExecuteDeleteAsync(ct);
    }

    private static Task<int> Bump(RfbDbContext db, Guid roomId, string playerId, int by, CancellationToken ct) =>
        db.Set<ModAdjRoomPlayer>().Where(p => p.RoomId == roomId && p.PlayerId == playerId)
            .ExecuteUpdateAsync(u => u.SetProperty(p => p.Modifier, p => p.Modifier + by), ct);
}
