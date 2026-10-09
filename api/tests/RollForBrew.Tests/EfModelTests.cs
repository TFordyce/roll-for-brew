using Microsoft.EntityFrameworkCore;
using Microsoft.EntityFrameworkCore.Infrastructure;
using Microsoft.EntityFrameworkCore.Metadata;
using Microsoft.EntityFrameworkCore.Migrations;
using Microsoft.Extensions.DependencyInjection;
using RollForBrew.Api.Data;

namespace RollForBrew.Tests;

/// <summary>
/// CI gate for ADR 0012 (the `ef-model` job runs these). While every Filler table is owned by the
/// hand-written supabase/migrations, each mapped entity is ExcludeFromMigrations, so EF must have nothing
/// to script. The day an entity drops that flag (an additive Filler change), the scripted SQL becomes
/// non-empty and this test fails until the script is committed as the next numbered supabase/migrations file
/// and this test is taught to compare against it.
/// </summary>
[Trait("Category", "EfModel")]
public class EfModelTests
{
    private static RfbDbContext Ctx() => new(new DbContextOptionsBuilder<RfbDbContext>()
        .UseNpgsql("Host=unused;Database=unused").Options);

    [Fact]
    public void Model_scripts_no_ddl_while_tables_are_owned_by_SQL_migrations()
    {
        using var db = Ctx();
        var differ = db.GetService<IMigrationsModelDiffer>();
        var generator = db.GetService<IMigrationsSqlGenerator>();
        var model = db.GetService<IDesignTimeModel>().Model;
        var ops = differ.GetDifferences(null, model.GetRelationalModel());
        var sql = string.Join("\n", generator.Generate(ops, model).Select(c => c.CommandText));
        Assert.True(ops.Count == 0, "EF now scripts DDL; commit it as the next supabase/migrations file:\n" + sql);
    }

    [Fact]
    public void Every_mapped_table_is_excluded_from_EF_migrations()
    {
        using var db = Ctx();
        foreach (var t in db.GetService<IDesignTimeModel>().Model.GetEntityTypes())
            Assert.True(t.IsTableExcludedFromMigrations(), $"{t.ClrType.Name} is not ExcludeFromMigrations");
    }
}
