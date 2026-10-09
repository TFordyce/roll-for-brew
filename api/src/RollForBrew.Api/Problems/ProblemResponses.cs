using System.Text.Json;
using Microsoft.AspNetCore.Diagnostics;

namespace RollForBrew.Api.Problems;

/// <summary>RFC 9457 application/problem+json writer with a stable `code` extension member.</summary>
public static class ProblemResponses
{
    public const string ContentType = "application/problem+json";

    public static async Task WriteAsync(HttpContext ctx, int status, string code, string title, string? detail = null)
    {
        ctx.Response.StatusCode = status;
        ctx.Response.ContentType = ContentType;
        var body = new Dictionary<string, object?>
        {
            ["type"] = $"urn:rfb:problem:{code}",
            ["title"] = title,
            ["status"] = status,
            ["code"] = code,
        };
        if (detail is not null) body["detail"] = detail;
        await ctx.Response.WriteAsync(JsonSerializer.Serialize(body));
    }

    public static IApplicationBuilder UseProblemHandling(this IApplicationBuilder app) =>
        app.UseExceptionHandler(b => b.Run(async ctx =>
        {
            var ex = ctx.Features.Get<IExceptionHandlerFeature>()?.Error;
            if (ex is ProblemException p)
                await WriteAsync(ctx, p.Status, p.Code, p.Title, p.ProblemDetail);
            else
                await WriteAsync(ctx, 500, "internal_error", "Something went wrong.");
        }));

    /// <summary>Bodyless 401/403/404/405 responses become problem+json too.</summary>
    public static IApplicationBuilder UseStatusCodeProblems(this IApplicationBuilder app) =>
        app.UseStatusCodePages(async c =>
        {
            var ctx = c.HttpContext;
            if (ctx.Response.ContentType is not null) return;
            var (code, title) = ctx.Response.StatusCode switch
            {
                401 => ("unauthenticated", "Sign in again."),
                403 => ("forbidden", "You do not have access to that."),
                404 => ("not_found", "Not found."),
                405 => ("method_not_allowed", "Method not allowed."),
                _ => ("error", "The request failed."),
            };
            await WriteAsync(ctx, ctx.Response.StatusCode, code, title);
        });
}
