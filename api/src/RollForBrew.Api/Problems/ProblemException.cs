namespace RollForBrew.Api.Problems;

public sealed class ProblemException(string code, ProblemClass kind, string title, string? detail = null)
    : Exception(title)
{
    public string Code { get; } = code;
    public ProblemClass Kind { get; } = kind;
    public string Title { get; } = title;
    public string? ProblemDetail { get; } = detail;
    public int Status => (int)Kind;

    public static ProblemException FromInfo(ProblemInfo info, string? detail) =>
        new(info.Code, info.Class, info.Title, detail);
}
