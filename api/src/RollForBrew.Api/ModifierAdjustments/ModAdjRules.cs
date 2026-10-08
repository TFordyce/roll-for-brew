using Microsoft.EntityFrameworkCore;
using Npgsql;
using RollForBrew.Api.Data;
using RollForBrew.Api.Problems;

namespace RollForBrew.Api.ModifierAdjustments;

/// <summary>
/// Modifier Adjustment rules (ports log_modifier_adjustment, delete_modifier_adjustment,
/// admin_delete_modifier_adjustment; migrations 0052, 0056). Check order and RFBnn mirror the SQL.
/// The adjustment and the room_players.modifier bump happen in the one store transaction.
/// </summary>
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

        // "Today" is re-derived server-side (Europe/London), never a client room id.
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

    /// <summary>Self-serve undo: caller's own, most recent, within 5 minutes.</summary>
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

        // Database clock, as in SQL (now() - created_at > 5 minutes).
        await using var q = new NpgsqlCommand(
            "select now() - created_at > interval '5 minutes' from public.modifier_adjustments where id = @id", s.Connection, s.Transaction);
        q.Parameters.AddWithValue("id", id);
        if ((bool)(await q.ExecuteScalarAsync(ct))!) throw Problem("RFB15");

        await Bump(db, row.RoomId, row.TargetPlayerId, -row.Delta, ct);
        await db.Set<ModAdjRow>().Where(r => r.Id == id).ExecuteDeleteAsync(ct);
    }

    /// <summary>Admin-only unrestricted delete; the audit row is written before the adjustment is dropped.</summary>
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
