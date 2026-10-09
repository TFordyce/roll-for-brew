using System.Text.RegularExpressions;
using RollForBrew.Api.Problems;

namespace RollForBrew.Tests;

public class ProblemCatalogTests
{
    private static string FindErrorCodesDoc()
    {
        for (var dir = new DirectoryInfo(AppContext.BaseDirectory); dir is not null; dir = dir.Parent)
        {
            var p = Path.Combine(dir.FullName, "docs", "port", "error-codes.md");
            if (File.Exists(p)) return p;
        }
        throw new FileNotFoundException("docs/port/error-codes.md");
    }

    [Fact]
    public void Catalog_matches_docs_port_error_codes()
    {
        var rows = Regex.Matches(File.ReadAllText(FindErrorCodesDoc()), @"^\| (RFB\d{2}) \| `([a-z_]+)` \| (\d{3}) \|", RegexOptions.Multiline)
            .Select(m => (Sql: m.Groups[1].Value, Code: m.Groups[2].Value, Status: int.Parse(m.Groups[3].Value)))
            .ToList();

        Assert.NotEmpty(rows);
        Assert.Equal(rows.Select(r => r.Sql), ProblemCatalog.All.Select(c => c.SqlState));
        foreach (var r in rows)
        {
            var info = ProblemCatalog.FromSqlState(r.Sql)!;
            Assert.Equal(r.Code, info.Code);
            Assert.Equal(r.Status, (int)info.Class);
        }
    }

    [Fact]
    public void Codes_are_unique()
    {
        Assert.Equal(ProblemCatalog.All.Count, ProblemCatalog.All.Select(c => c.Code).Distinct().Count());
    }

    [Fact]
    public void Unknown_sqlstate_is_not_mapped() => Assert.Null(ProblemCatalog.FromSqlState("23505"));
}
