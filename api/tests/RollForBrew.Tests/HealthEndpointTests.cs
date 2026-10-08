using System.Net;
using Microsoft.AspNetCore.Mvc.Testing;

namespace RollForBrew.Tests;

public class HealthEndpointTests(WebApplicationFactory<Program> factory) : IClassFixture<WebApplicationFactory<Program>>
{
    [Fact]
    public async Task Health_returns_200()
    {
        var res = await factory.CreateClient().GetAsync("/health");
        Assert.Equal(HttpStatusCode.OK, res.StatusCode);
    }

    [Fact]
    public async Task Ready_is_200_when_no_gate_is_configured()
    {
        var res = await factory.CreateClient().GetAsync("/health/ready");
        Assert.Equal(HttpStatusCode.OK, res.StatusCode);
    }

    [Fact]
    public async Task Ready_is_503_when_gate_configured_but_db_unreachable()
    {
        var f = factory.WithWebHostBuilder(b =>
        {
            b.UseSetting("SCHEMA_VERSION", "0154_x.sql");
            b.UseSetting("ConnectionStrings:Postgres", "Host=127.0.0.1;Port=1;Username=x;Password=x;Timeout=1");
        });
        var res = await f.CreateClient().GetAsync("/health/ready");
        Assert.Equal(HttpStatusCode.ServiceUnavailable, res.StatusCode);
    }
}
