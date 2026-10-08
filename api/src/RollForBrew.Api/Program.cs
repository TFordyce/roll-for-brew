using RollForBrew.Api;
using Npgsql;
using RollForBrew.Api.ActingAs;
using RollForBrew.Api.Auth;
using RollForBrew.Api.Data;
using RollForBrew.Api.Health;
using RollForBrew.Api.Orders;
using RollForBrew.Api.Problems;
using RollForBrew.Api.Ratings;

var builder = WebApplication.CreateBuilder(args);

// The image bakes the newest migration filename into schema-version.txt (see Dockerfile / cloudbuild.yaml).
var baked = Path.Combine(AppContext.BaseDirectory, "schema-version.txt");
if (File.Exists(baked) && string.IsNullOrWhiteSpace(builder.Configuration["SCHEMA_VERSION"]))
    builder.Configuration["SCHEMA_VERSION"] = File.ReadAllText(baked).Trim();

// Cloud Run injects the Secret Manager value as POSTGRES_CONNECTION_STRING.
var pg = builder.Configuration["POSTGRES_CONNECTION_STRING"];
if (!string.IsNullOrWhiteSpace(pg)) builder.Configuration["ConnectionStrings:Postgres"] = pg;

var corsOrigins = (builder.Configuration["CORS_ORIGINS"] ?? "")
    .Split(',', StringSplitOptions.RemoveEmptyEntries | StringSplitOptions.TrimEntries);
builder.Services.AddCors(o => o.AddDefaultPolicy(p =>
    p.SetIsOriginAllowed(origin => CorsOrigins.IsAllowed(origin, corsOrigins)).AllowAnyHeader().AllowAnyMethod()));

builder.Services.AddOpenApi();
builder.Services.AddSupabaseJwt(builder.Configuration);
builder.Services.AddSingleton<NpgsqlDataSource>(sp =>
    RoomStore.BuildDataSource(sp.GetRequiredService<IConfiguration>().GetConnectionString("Postgres")
        ?? throw new InvalidOperationException("ConnectionStrings:Postgres not set")));
builder.Services.AddSingleton<RoomStore>();

var app = builder.Build();
app.UseProblemHandling();
app.UseStatusCodeProblems();
app.UseCors();
app.UseAuthentication();
app.UseAuthorization();
app.MapHealth();
app.MapActingAs();
app.MapRatings();
app.MapOrders();
app.Run();

public partial class Program;
