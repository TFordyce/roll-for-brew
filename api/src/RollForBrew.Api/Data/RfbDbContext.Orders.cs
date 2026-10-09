using Microsoft.EntityFrameworkCore;
using RollForBrew.Api.Orders;

namespace RollForBrew.Api.Data;

public sealed partial class RfbDbContext
{
    public DbSet<Order> Orders => Set<Order>();

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
    }
}
