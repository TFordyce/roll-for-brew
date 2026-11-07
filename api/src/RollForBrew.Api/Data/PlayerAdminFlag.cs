namespace RollForBrew.Api.Data;

/// <summary>A player as the admin checks see one: EF's map of two `players` columns.</summary>
public sealed class PlayerAdminFlag
{
    public string Id { get; set; } = "";
    public bool IsAdmin { get; set; }
}
