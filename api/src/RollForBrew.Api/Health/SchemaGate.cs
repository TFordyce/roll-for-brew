using Npgsql;

namespace RollForBrew.Api.Health;

/// <summary>
/// Deploy-ordering gate: the image bakes the newest migration filename; the instance is not ready
/// until that version is recorded in supabase_migrations.schema_migrations.
/// </summary>
public static class SchemaGate
{
    public static string ParseVersion(string migrationFileName)
    {
        var name = migrationFileName.Trim();
        var i = name.IndexOf('_');
        if (i <= 0 || !name[..i].All(char.IsDigit)) throw new FormatException($"Not a migration filename: '{name}'");
        return name[..i];
    }

    public static bool IsSatisfied(string expected, IReadOnlyCollection<string> applied) => applied.Contains(expected);

    public static async Task<bool> CheckAsync(string connectionString, string expected, CancellationToken ct)
    {
        await using var conn = new NpgsqlConnection(connectionString);
        await conn.OpenAsync(ct);
        await using var cmd = new NpgsqlCommand(
            "select exists (select 1 from supabase_migrations.schema_migrations where version = @v)", conn);
        cmd.Parameters.AddWithValue("v", expected);
        return (bool)(await cmd.ExecuteScalarAsync(ct))!;
    }
}
