namespace RollForBrew.Domain.Dice;

public interface IDieRoller
{
    int Roll(int sides);
}

public sealed class RandomDieRoller : IDieRoller
{
    public int Roll(int sides) => Random.Shared.Next(1, sides + 1);
}

public sealed class ScriptedDieRoller : IDieRoller
{
    private readonly Queue<int> _script;
    private readonly List<int> _requests = [];

    public ScriptedDieRoller(params int[] script) => _script = new Queue<int>(script);

    public IReadOnlyList<int> Requests => _requests;

    public int Remaining => _script.Count;

    public int Roll(int sides)
    {
        _requests.Add(sides);
        if (_script.Count == 0) throw new InvalidOperationException($"ScriptedDieRoller exhausted (asked for a d{sides}).");
        var v = _script.Dequeue();
        if (v < 1 || v > sides) throw new InvalidOperationException($"Scripted value {v} is not a valid d{sides}.");
        return v;
    }
}

public sealed class NoDiceRoller : IDieRoller
{
    public int Roll(int sides) => throw new InvalidOperationException($"Unexpected die roll (d{sides}).");
}
