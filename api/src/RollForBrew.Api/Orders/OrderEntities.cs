namespace RollForBrew.Api.Orders;

public sealed class Order
{
    public Guid RoundId { get; set; }
    public required string PlayerId { get; set; }
    public required string DrinkType { get; set; }
    public DateTime CreatedAt { get; set; }
    public DateTime UpdatedAt { get; set; }
}
