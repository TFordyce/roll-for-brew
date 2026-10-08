using RollForBrew.Api;
using RollForBrew.Api.Health;

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

var app = builder.Build();
app.UseCors();
app.MapHealth();
app.Run();

public partial class Program;
