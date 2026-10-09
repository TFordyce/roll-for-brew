using Microsoft.IdentityModel.Protocols;
using Microsoft.IdentityModel.Tokens;

namespace RollForBrew.Api.Auth;

public interface IJwksSource
{
    JsonWebKeySet GetKeys();
    void RequestRefresh();
}

public sealed class HttpJwksSource : IJwksSource
{
    private readonly ConfigurationManager<JsonWebKeySet> _manager;

    public HttpJwksSource(string jwksUrl, HttpClient? http = null)
    {
        _manager = new ConfigurationManager<JsonWebKeySet>(
            jwksUrl, new JwksRetriever(), new HttpDocumentRetriever(http ?? new HttpClient()) { RequireHttps = true })
        {
            AutomaticRefreshInterval = TimeSpan.FromHours(1),
            RefreshInterval = TimeSpan.FromMinutes(1),
        };
    }

    public JsonWebKeySet GetKeys() => _manager.GetConfigurationAsync(CancellationToken.None).GetAwaiter().GetResult();

    public void RequestRefresh() => _manager.RequestRefresh();

    private sealed class JwksRetriever : IConfigurationRetriever<JsonWebKeySet>
    {
        public async Task<JsonWebKeySet> GetConfigurationAsync(string address, IDocumentRetriever retriever, CancellationToken cancel)
            => new(await retriever.GetDocumentAsync(address, cancel));
    }
}

public sealed class StaticJwksSource(JsonWebKeySet keys) : IJwksSource
{
    public JsonWebKeySet GetKeys() => keys;
    public void RequestRefresh() { }
}

public sealed class UnconfiguredJwksSource : IJwksSource
{
    public JsonWebKeySet GetKeys() => throw new InvalidOperationException("JWKS_URL is not set.");
    public void RequestRefresh() { }
}
