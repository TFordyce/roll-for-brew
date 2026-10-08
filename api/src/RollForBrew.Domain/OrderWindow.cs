namespace RollForBrew.Domain;

public enum OrderVerdict { Accepted, DrinkTypeInvalid, RoundNotOpen, WindowClosed }

/// <summary>
/// Order rules (ADR 0004; SQL submit_order, 0062). A round accepts Orders from 'open' through 'resolved'.
/// The window closes the moment any later-started round in the same room resolves.
/// Checks run in SQL order: drink type, then round state, then window.
/// </summary>
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
