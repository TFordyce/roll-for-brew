using RollForBrew.Api.Health;

namespace RollForBrew.Tests;

public class SchemaGateTests
{
    [Theory]
    [InlineData("0154_generated_resolver_functions.sql", "0154")]
    [InlineData("0154_generated_resolver_functions.sql\n", "0154")]
    [InlineData("  0099_x.sql ", "0099")]
    public void Parses_version_from_migration_filename(string file, string version) =>
        Assert.Equal(version, SchemaGate.ParseVersion(file));

    [Fact]
    public void Unparseable_filename_throws() =>
        Assert.Throws<FormatException>(() => SchemaGate.ParseVersion("README.md"));

    [Fact]
    public void Gate_is_open_only_when_expected_version_is_applied()
    {
        Assert.True(SchemaGate.IsSatisfied("0154", ["0153", "0154"]));
        Assert.False(SchemaGate.IsSatisfied("0155", ["0153", "0154"]));
    }
}
