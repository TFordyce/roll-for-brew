using Microsoft.EntityFrameworkCore;
using Microsoft.EntityFrameworkCore.Infrastructure;
using Microsoft.EntityFrameworkCore.Metadata;
using Microsoft.EntityFrameworkCore.Migrations;
using Microsoft.Extensions.DependencyInjection;
using RollForBrew.Api.Data;

namespace RollForBrew.Tests;

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
