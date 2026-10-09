using Microsoft.EntityFrameworkCore;

namespace RollForBrew.Api.ModifierAdjustments;

public static class ModAdjModel
{
    public static void Configure(ModelBuilder b)
    {
        b.Entity<ModAdjRow>(e =>
        {
            e.ToTable("modifier_adjustments", "public", t => t.ExcludeFromMigrations());
            e.HasKey(x => x.Id);
            e.Property(x => x.Id).HasColumnName("id").ValueGeneratedOnAdd();
            e.Property(x => x.RoomId).HasColumnName("room_id");
            e.Property(x => x.TargetPlayerId).HasColumnName("target_player_id");
            e.Property(x => x.ActorPlayerId).HasColumnName("actor_player_id");
            e.Property(x => x.Delta).HasColumnName("delta");
            e.Property(x => x.Reason).HasColumnName("reason");
            e.Property(x => x.CreatedAt).HasColumnName("created_at").ValueGeneratedOnAdd();
        });
        b.Entity<ModAdjDeletion>(e =>
        {
            e.ToTable("admin_modifier_adjustment_deletions", "public", t => t.ExcludeFromMigrations());
            e.HasKey(x => x.Id);
            e.Property(x => x.Id).HasColumnName("id").ValueGeneratedOnAdd();
            e.Property(x => x.AdjustmentId).HasColumnName("adjustment_id");
            e.Property(x => x.RoomId).HasColumnName("room_id");
            e.Property(x => x.TargetPlayerId).HasColumnName("target_player_id");
            e.Property(x => x.OriginalActorPlayerId).HasColumnName("original_actor_player_id");
            e.Property(x => x.Delta).HasColumnName("delta");
            e.Property(x => x.OriginalReason).HasColumnName("original_reason");
            e.Property(x => x.ActorPlayerId).HasColumnName("actor_player_id");
            e.Property(x => x.Reason).HasColumnName("reason");
        });
        b.Entity<ModAdjRoomPlayer>(e =>
        {
            e.ToTable("room_players", "public", t => t.ExcludeFromMigrations());
            e.HasKey(x => new { x.RoomId, x.PlayerId });
            e.Property(x => x.RoomId).HasColumnName("room_id");
            e.Property(x => x.PlayerId).HasColumnName("player_id");
            e.Property(x => x.Modifier).HasColumnName("modifier");
        });
        b.Entity<ModAdjPlayer>(e =>
        {
            e.ToTable("players", "public", t => t.ExcludeFromMigrations());
            e.HasKey(x => x.Id);
            e.Property(x => x.Id).HasColumnName("id");
            e.Property(x => x.IsAdmin).HasColumnName("is_admin");
        });
    }
}

public sealed class ModAdjRow
{
    public Guid Id { get; set; }
    public Guid RoomId { get; set; }
    public required string TargetPlayerId { get; set; }
    public required string ActorPlayerId { get; set; }
    public int Delta { get; set; }
    public required string Reason { get; set; }
    public DateTime CreatedAt { get; set; }
}

public sealed class ModAdjDeletion
{
    public Guid Id { get; set; }
    public Guid AdjustmentId { get; set; }
    public Guid RoomId { get; set; }
    public required string TargetPlayerId { get; set; }
    public required string OriginalActorPlayerId { get; set; }
    public int Delta { get; set; }
    public required string OriginalReason { get; set; }
    public required string ActorPlayerId { get; set; }
    public required string Reason { get; set; }
}

public sealed class ModAdjRoomPlayer
{
    public Guid RoomId { get; set; }
    public string PlayerId { get; set; } = "";
    public int Modifier { get; set; }
}

public sealed class ModAdjPlayer
{
    public string Id { get; set; } = "";
    public bool IsAdmin { get; set; }
}
