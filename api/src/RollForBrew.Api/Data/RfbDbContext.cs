using Microsoft.EntityFrameworkCore;

namespace RollForBrew.Api.Data;

/// <summary>
/// EF Core model for the Filler tables (ADR 0012). Tables stay owned by the hand-written SQL migrations
/// until the consolidation slice, so every mapped entity is excluded from EF migrations.
/// </summary>
public sealed partial class RfbDbContext(DbContextOptions<RfbDbContext> options) : DbContext(options)
{
    public DbSet<AdminActingAs> AdminActingAs => Set<AdminActingAs>();

    protected override void OnModelCreating(ModelBuilder b)
    {
        RollForBrew.Api.Ratings.RatingsModel.Configure(b);
        ConfigureOrders(b);
        ConfigureRoomEntry(b);
        b.Entity<AdminActingAs>(e =>
        {
            e.ToTable("admin_acting_as", "public", t => t.ExcludeFromMigrations());
            e.HasKey(x => x.AdminPlayerId);
            e.Property(x => x.AdminPlayerId).HasColumnName("admin_player_id");
            e.Property(x => x.ActingAsPlayerId).HasColumnName("acting_as_player_id");
        });
    }
}

/// <summary>One row per admin; a null pointer means "acting as self".</summary>
public sealed class AdminActingAs
{
    public required string AdminPlayerId { get; set; }
    public string? ActingAsPlayerId { get; set; }
}
