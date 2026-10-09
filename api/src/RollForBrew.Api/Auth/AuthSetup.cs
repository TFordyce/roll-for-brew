using System.Text;
using Microsoft.AspNetCore.Authentication.JwtBearer;
using Microsoft.IdentityModel.JsonWebTokens;
using Microsoft.IdentityModel.Tokens;
using RollForBrew.Api.Problems;

namespace RollForBrew.Api.Auth;

/// <summary>The validated caller. ClaimsJson is the verified JWT payload, handed to Postgres as request.jwt.claims.</summary>
public sealed record Caller(string Subject, string ClaimsJson);

public static class AuthSetup
{
    private const string CallerKey = "rfb.caller";

    public static IServiceCollection AddSupabaseJwt(this IServiceCollection services, IConfiguration cfg)
    {
        services.AddSingleton<IJwksSource>(_ =>
        {
            var url = cfg["JWKS_URL"];
            // Unset (local dev, health-only tests): fail only when a token actually needs validating.
            return string.IsNullOrWhiteSpace(url) ? new UnconfiguredJwksSource() : new HttpJwksSource(url);
        });

        services.AddAuthentication(JwtBearerDefaults.AuthenticationScheme).AddJwtBearer();
        services.AddOptions<JwtBearerOptions>(JwtBearerDefaults.AuthenticationScheme)
            .Configure<IJwksSource>((o, jwks) =>
            {
                var issuer = cfg["JWT_ISSUER"];
                if (string.IsNullOrWhiteSpace(issuer))
                    issuer = $"https://{cfg["SUPABASE_PROJECT_REF"]}.supabase.co/auth/v1";
                o.MapInboundClaims = false;
                o.TokenValidationParameters = new TokenValidationParameters
                {
                    ValidateIssuer = true,
                    ValidIssuer = issuer,
                    ValidateAudience = true,
                    ValidAudience = cfg["JWT_AUDIENCE"] ?? "authenticated",
                    ValidateLifetime = true,
                    ClockSkew = TimeSpan.FromSeconds(30),
                    RequireSignedTokens = true,
                    ValidateIssuerSigningKey = true,
                    ValidAlgorithms = [SecurityAlgorithms.EcdsaSha256, SecurityAlgorithms.RsaSha256],
                    IssuerSigningKeyResolver = (_, _, kid, _) =>
                    {
                        var keys = jwks.GetKeys().GetSigningKeys().Where(k => k.KeyId == kid).ToList();
                        if (keys.Count == 0)
                        {
                            jwks.RequestRefresh();
                            keys = jwks.GetKeys().GetSigningKeys().Where(k => k.KeyId == kid).ToList();
                        }
                        return keys;
                    },
                };
                o.Events = new JwtBearerEvents
                {
                    OnTokenValidated = ctx =>
                    {
                        var jwt = (JsonWebToken)ctx.SecurityToken;
                        var sub = jwt.Subject;
                        if (string.IsNullOrEmpty(sub)) { ctx.Fail("no sub"); return Task.CompletedTask; }
                        var payload = Encoding.UTF8.GetString(Base64UrlEncoder.DecodeBytes(jwt.EncodedPayload));
                        ctx.HttpContext.Items[CallerKey] = new Caller(sub, payload);
                        return Task.CompletedTask;
                    },
                    OnChallenge = async ctx =>
                    {
                        ctx.HandleResponse();
                        await ProblemResponses.WriteAsync(ctx.HttpContext, 401, "unauthenticated", "Sign in again.");
                    },
                };
            });
        services.AddAuthorizationBuilder().SetFallbackPolicy(
            new Microsoft.AspNetCore.Authorization.AuthorizationPolicyBuilder().RequireAuthenticatedUser().Build());
        return services;
    }

    /// <summary>The validated caller. Throws when called on an unauthenticated request (a wiring bug).</summary>
    public static Caller GetCaller(this HttpContext ctx) =>
        ctx.Items[CallerKey] as Caller ?? throw new InvalidOperationException("No validated caller on this request.");
}
