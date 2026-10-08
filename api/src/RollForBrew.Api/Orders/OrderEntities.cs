namespace RollForBrew.Api.Orders;

/// <summary>An Order: who wants which drink in a round. Milk and sugar are a live join to usual_drinks (ADR 0003), not stored here.</summary>
public sealed class Order
{
    public Guid RoundId { get; set; }
    public required string PlayerId { get; set; }
    public required string DrinkType { get; set; }
    public DateTime CreatedAt { get; set; }
    public DateTime UpdatedAt { get; set; }
}

/// <summary>Read-only slice of rounds the Order Window needs. rounds stays owned by SQL until its own slice.</summary>
public sealed class OrderRound
{
    public Guid Id { get; set; }
    public Guid RoomId { get; set; }
    public required string Status { get; set; }
    public DateTime StartedAt { get; set; }
}
