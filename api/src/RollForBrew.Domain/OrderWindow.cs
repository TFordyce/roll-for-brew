namespace RollForBrew.Domain;

public enum OrderVerdict { Accepted, DrinkTypeInvalid, RoundNotOpen, WindowClosed }

public static class OrderWindow
{
    public static bool IsValidDrinkType(string? drinkType) => drinkType is "tea" or "coffee";

    public static bool StatusAcceptsOrders(string? status) => status is "open" or "closed" or "resolved";

    public static OrderVerdict Check(string? drinkType, string? roundStatus, bool laterRoundResolved)
    {
        if (!IsValidDrinkType(drinkType)) return OrderVerdict.DrinkTypeInvalid;
        if (!StatusAcceptsOrders(roundStatus)) return OrderVerdict.RoundNotOpen;
        return laterRoundResolved ? OrderVerdict.WindowClosed : OrderVerdict.Accepted;
    }
}
