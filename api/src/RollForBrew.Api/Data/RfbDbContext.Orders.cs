using Microsoft.EntityFrameworkCore;
using RollForBrew.Api.Orders;

namespace RollForBrew.Api.Data;

// Filler mappings live in one partial file per slice to keep parallel slices merge-clean.
// Each slice adds its own DbSets + `Configure<Slice>(ModelBuilder)` here-style and one call line in OnModelCreating.
public sealed partial class RfbDbContext
{
    public DbSet<Order> Orders => Set<Order>();
    public DbSet<OrderRound> OrderRounds => Set<OrderRound>();

    private static void ConfigureOrders(ModelBuilder b)
    {
        b.Entity<Order>(e =>
        {
            e.ToTable("orders", "public", t => t.ExcludeFromMigrations());
            e.HasKey(x => new { x.RoundId, x.PlayerId });
            e.Property(x => x.RoundId).HasColumnName("round_id");
            e.Property(x => x.PlayerId).HasColumnName("player_id");
            e.Property(x => x.DrinkType).HasColumnName("drink_type");
            e.Property(x => x.CreatedAt).HasColumnName("created_at").IsRequired();
            e.Property(x => x.UpdatedAt).HasColumnName("updated_at");
        });
        b.Entity<OrderRound>(e =>
        {
            e.ToTable("rounds", "public", t => t.ExcludeFromMigrations());
            e.HasKey(x => x.Id);
            e.Property(x => x.Id).HasColumnName("id");
            e.Property(x => x.RoomId).HasColumnName("room_id");
            e.Property(x => x.Status).HasColumnName("status");
            e.Property(x => x.StartedAt).HasColumnName("started_at");
        });
    }
}
