using RollForBrew.Api;

namespace RollForBrew.Tests;

public class CorsOriginsTests
{
    private static readonly string[] Patterns = ["https://app.example.com", "https://rfb-*-team.vercel.app"];

    [Theory]
    [InlineData("https://app.example.com", true)]
    [InlineData("https://rfb-abc123-team.vercel.app", true)]
    [InlineData("https://evil.com", false)]
    [InlineData("https://rfb-a/evil.com/x-team.vercel.app", false)]
    public void Matches_exact_and_wildcard(string origin, bool expected) =>
        Assert.Equal(expected, CorsOrigins.IsAllowed(origin, Patterns));
}
