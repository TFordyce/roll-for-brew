using System.Security.Cryptography;
using System.Text;

namespace RollForBrew.Domain.Resolver;

internal static class Ids
{
    public static Guid Deterministic(string salt) => new(MD5.HashData(Encoding.UTF8.GetBytes(salt)));
}
