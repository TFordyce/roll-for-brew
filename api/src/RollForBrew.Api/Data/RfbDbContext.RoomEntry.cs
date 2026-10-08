using Microsoft.EntityFrameworkCore;
using RollForBrew.Api.Rooms;

namespace RollForBrew.Api.Data;

// Room entry + set Acting As (#568). Rooms are already mapped once (RatingRoom, Ratings slice) and room entry
// uses SQL for the date-keyed upserts, so only players (read-only: id, is_admin) is added here.
public sealed partial class RfbDbContext
{
    private static void ConfigureRoomEntry(ModelBuilder b)
    {
        b.Entity<PlayerRow>(e =>
        {
            e.ToTable("players", "public", t => t.ExcludeFromMigrations());
            e.HasKey(x => x.Id);
            e.Property(x => x.Id).HasColumnName("id");
            e.Property(x => x.IsAdmin).HasColumnName("is_admin");
        });
    }
}
