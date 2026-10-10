namespace RollForBrew.Tests;

internal static class PendingGoldens
{
    public static readonly IReadOnlySet<string> Names = new HashSet<string>(StringComparer.Ordinal)
    {
        "6-heist-countered",
        "6-heist-fizzled-victim-played-first",
        "6-heist-moved",
        "6-marked-for-brew-fizzled",
        "6-marked-for-brew-placed",
        "6-marked-for-brew-redirected",
        "6-stale-biscuit-placed",
    };
}
