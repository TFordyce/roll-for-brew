namespace RollForBrew.Domain.Commands;

public sealed record BackfillRoll(string PlayerId, int Value, int Modifier);

/// <summary>Who a backfilled Layer leaves in the running: one player brews, more roll again.
/// A natural 1 forces it among the natural 1s, lowest modifier; all natural 20s go to the lowest
/// modifier; otherwise natural 20s are out and the lowest total decides. Backfill plays no spells,
/// so this is not the resolver's Phase 5.</summary>
public static class BackfillLayer
{
    public static IReadOnlyList<string> Lowest(IReadOnlyList<BackfillRoll> rolls)
    {
        var nat1s = rolls.Where(r => r.Value == 1).ToList();
        if (nat1s.Count > 0) return LowestBy(nat1s, r => r.Modifier);
        if (rolls.All(r => r.Value == 20)) return LowestBy(rolls, r => r.Modifier);
        return LowestBy([.. rolls.Where(r => r.Value != 20)], r => r.Value + r.Modifier);
    }

    private static List<string> LowestBy(IReadOnlyList<BackfillRoll> rolls, Func<BackfillRoll, int> key)
    {
        var lowest = rolls.Min(key);
        return [.. rolls.Where(r => key(r) == lowest).Select(r => r.PlayerId)];
    }
}
