using System.Security.Cryptography;
using Microsoft.AspNetCore.Mvc.Testing;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.DependencyInjection.Extensions;
using Microsoft.IdentityModel.JsonWebTokens;
using Microsoft.IdentityModel.Tokens;
using RollForBrew.Api.Auth;

namespace RollForBrew.Tests.Harness;

public sealed class ApiHost : IAsyncLifetime
{
    public const string Issuer = "https://test-project.supabase.co/auth/v1";

    private readonly ECDsa _ecdsa = ECDsa.Create(ECCurve.NamedCurves.nistP256);
    private readonly ECDsa _foreignEcdsa = ECDsa.Create(ECCurve.NamedCurves.nistP256);
    private ECDsaSecurityKey Key => new(_ecdsa) { KeyId = "test-key" };

    public TestDatabase Db { get; private set; } = null!;
    public WebApplicationFactory<Program> Factory { get; private set; } = null!;

    public async Task InitializeAsync()
    {
        Db = await TestPostgres.CreateDatabase();
        var jwks = new JsonWebKeySet();
        jwks.Keys.Add(JsonWebKeyConverter.ConvertFromECDsaSecurityKey(Key));
        Factory = new WebApplicationFactory<Program>().WithWebHostBuilder(b =>
        {
            b.UseSetting("ConnectionStrings:Postgres", Db.ApiConnectionString);
            b.UseSetting("JWT_ISSUER", Issuer);
            b.ConfigureServices(s => s.Replace(ServiceDescriptor.Singleton<IJwksSource>(new StaticJwksSource(jwks))));
        });
    }

    public HttpClient Client(string? bearer = null)
    {
        var c = Factory.CreateClient();
        if (bearer is not null) c.DefaultRequestHeaders.Authorization = new("Bearer", bearer);
        return c;
    }

    public string Token(TestUser user, TimeSpan? lifetime = null, string audience = "authenticated", string issuer = Issuer) =>
        Mint(Key, user, lifetime ?? TimeSpan.FromMinutes(5), audience, issuer);

    public string Foreign(TestUser user) =>
        Mint(new ECDsaSecurityKey(_foreignEcdsa) { KeyId = "test-key" }, user, TimeSpan.FromMinutes(5), "authenticated", Issuer);

    private static string Mint(SecurityKey key, TestUser user, TimeSpan lifetime, string audience, string issuer)
    {
        var now = DateTime.UtcNow;
        var expires = now + lifetime;
        return new JsonWebTokenHandler().CreateToken(new SecurityTokenDescriptor
        {
            Issuer = issuer,
            Audience = audience,
            NotBefore = expires < now ? expires - TimeSpan.FromMinutes(5) : now,
            IssuedAt = expires < now ? expires - TimeSpan.FromMinutes(5) : now,
            Expires = expires,
            Claims = new Dictionary<string, object> { ["sub"] = user.AuthId.ToString(), ["role"] = "authenticated" },
            SigningCredentials = new SigningCredentials(key, SecurityAlgorithms.EcdsaSha256),
        });
    }

    public async Task DisposeAsync()
    {
        await Factory.DisposeAsync();
        await Db.DisposeAsync();
        _ecdsa.Dispose();
        _foreignEcdsa.Dispose();
    }
}
