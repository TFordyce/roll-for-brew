using Microsoft.EntityFrameworkCore;

namespace RollForBrew.Api.Ratings;

/// <summary>
/// EF mapping for the rating tables (#566) plus the read-only slices of the tables the rating rules consult.
/// Tables stay owned by the hand-written SQL migrations (0058, 0073), so all are excluded from EF migrations.
/// </summary>
public static class RatingsModel
{
    public static void Configure(ModelBuilder b)
    {
        b.Entity<BrewRating>(e =>
        {
            e.ToTable("brew_ratings", "public", t => t.ExcludeFromMigrations());
            e.HasKey(x => x.Id);
            e.Property(x => x.Id).HasColumnName("id");
            e.Property(x => x.RoundId).HasColumnName("round_id");
            e.Property(x => x.BrewerId).HasColumnName("brewer_id");
            e.Property(x => x.RaterPlayerId).HasColumnName("rater_player_id");
            e.Property(x => x.Score).HasColumnName("score");
        });
        b.Entity<SpellCardRating>(e =>
        {
            e.ToTable("spell_card_ratings", "public", t => t.ExcludeFromMigrations());
            e.HasKey(x => x.Id);
            e.Property(x => x.Id).HasColumnName("id");
            e.Property(x => x.CardId).HasColumnName("card_id");
            e.Property(x => x.RaterPlayerId).HasColumnName("rater_player_id");
            e.Property(x => x.Score).HasColumnName("score");
        });
        b.Entity<RatingRound>(e =>
        {
            e.ToTable("rounds", "public", t => t.ExcludeFromMigrations());
            e.HasKey(x => x.Id);
            e.Property(x => x.Id).HasColumnName("id");
            e.Property(x => x.RoomId).HasColumnName("room_id");
            e.Property(x => x.Status).HasColumnName("status");
            e.Property(x => x.ResolvedAt).HasColumnName("resolved_at");
            e.Property(x => x.BrewerId).HasColumnName("brewer_id");
        });
        b.Entity<RatingParticipant>(e =>
        {
            e.ToTable("round_participants", "public", t => t.ExcludeFromMigrations());
            e.HasKey(x => new { x.RoundId, x.PlayerId });
            e.Property(x => x.RoundId).HasColumnName("round_id");
            e.Property(x => x.PlayerId).HasColumnName("player_id");
        });
        b.Entity<RatingCast>(e =>
        {
            e.ToTable("spell_casts", "public", t => t.ExcludeFromMigrations());
            e.HasKey(x => x.Id);
            e.Property(x => x.Id).HasColumnName("id");
            e.Property(x => x.RoundId).HasColumnName("round_id");
            e.Property(x => x.CasterId).HasColumnName("caster_id");
            e.Property(x => x.CardInstanceId).HasColumnName("card_instance_id");
            e.Property(x => x.Negated).HasColumnName("negated");
        });
        b.Entity<RatingDeckInstance>(e =>
        {
            e.ToTable("spell_deck_instances", "public", t => t.ExcludeFromMigrations());
            e.HasKey(x => x.Id);
            e.Property(x => x.Id).HasColumnName("id");
            e.Property(x => x.CardId).HasColumnName("card_id");
        });
        b.Entity<RatingCard>(e =>
        {
            e.ToTable("spell_cards", "public", t => t.ExcludeFromMigrations());
            e.HasKey(x => x.Id);
            e.Property(x => x.Id).HasColumnName("id");
        });
        b.Entity<RatingRoom>(e =>
        {
            e.ToTable("rooms", "public", t => t.ExcludeFromMigrations());
            e.HasKey(x => x.Id);
            e.Property(x => x.Id).HasColumnName("id");
            e.Property(x => x.IsTest).HasColumnName("is_test");
        });
    }
}

public sealed class BrewRating
{
    public Guid Id { get; set; }
    public Guid RoundId { get; set; }
    public required string BrewerId { get; set; }
    public required string RaterPlayerId { get; set; }
    public int Score { get; set; }
}

public sealed class SpellCardRating
{
    public Guid Id { get; set; }
    public Guid CardId { get; set; }
    public required string RaterPlayerId { get; set; }
    public int Score { get; set; }
}

// Read-only views of other tables, named for their use here so they cannot clash with other slices' entities.
public sealed class RatingRound
{
    public Guid Id { get; set; }
    public Guid RoomId { get; set; }
    public string Status { get; set; } = "";
    public DateTime? ResolvedAt { get; set; }
    public string? BrewerId { get; set; }
}

public sealed class RatingParticipant
{
    public Guid RoundId { get; set; }
    public string PlayerId { get; set; } = "";
}

public sealed class RatingCast
{
    public Guid Id { get; set; }
    public Guid RoundId { get; set; }
    public string CasterId { get; set; } = "";
    public Guid CardInstanceId { get; set; }
    public bool Negated { get; set; }
}

public sealed class RatingDeckInstance
{
    public Guid Id { get; set; }
    public Guid CardId { get; set; }
}

public sealed class RatingCard
{
    public Guid Id { get; set; }
}

public sealed class RatingRoom
{
    public Guid Id { get; set; }
    public bool IsTest { get; set; }
}
