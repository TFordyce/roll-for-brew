namespace RollForBrew.Api.Health;

public static class HealthEndpoints
{
    public static IEndpointRouteBuilder MapHealth(this IEndpointRouteBuilder app)
    {
        // Liveness: process is up. No dependencies.
        app.MapGet("/health", () => Results.Ok(new { status = "ok" })).AllowAnonymous();

        // Startup probe: schema gate. Open when no gate is configured (local dev, tests).
        app.MapGet("/health/ready", async (IConfiguration cfg, ILogger<SchemaGateMarker> log, CancellationToken ct) =>
        {
            var file = cfg["SCHEMA_VERSION"];
            if (string.IsNullOrWhiteSpace(file)) return Results.Ok(new { status = "ok", gate = "disabled" });
            var expected = SchemaGate.ParseVersion(file);
            try
            {
                var cs = cfg.GetConnectionString("Postgres")
                    ?? throw new InvalidOperationException("ConnectionStrings:Postgres not set");
                using var timeout = CancellationTokenSource.CreateLinkedTokenSource(ct);
                timeout.CancelAfter(TimeSpan.FromSeconds(5));
                if (await SchemaGate.CheckAsync(cs, expected, timeout.Token))
                    return Results.Ok(new { status = "ok", schema = expected });
                return Results.Json(new { status = "waiting", expected }, statusCode: 503);
            }
            catch (Exception e)
            {
                log.LogWarning(e, "Schema gate check failed");
                return Results.Json(new { status = "unavailable", expected }, statusCode: 503);
            }
        }).AllowAnonymous();
        return app;
    }
}

public sealed class SchemaGateMarker;
