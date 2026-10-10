namespace RollForBrew.Api;

public static class CorsOrigins
{
    public static bool IsAllowed(string origin, IEnumerable<string> patterns) =>
        patterns.Any(p => Matches(p, origin));

    private static bool Matches(string pattern, string origin)
    {
        var star = pattern.IndexOf('*');
        if (star < 0) return string.Equals(pattern, origin, StringComparison.OrdinalIgnoreCase);
        var prefix = pattern[..star];
        var suffix = pattern[(star + 1)..];
        return origin.Length >= prefix.Length + suffix.Length
            && origin.StartsWith(prefix, StringComparison.OrdinalIgnoreCase)
            && origin.EndsWith(suffix, StringComparison.OrdinalIgnoreCase)
            && !origin[prefix.Length..^suffix.Length].Contains('/');
    }
}
