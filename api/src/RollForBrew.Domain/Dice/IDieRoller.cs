namespace RollForBrew.Domain.Dice;

/// <summary>
/// The only source of randomness the rules engine may use (ADR 0010). Evaluate asks for a die only when the
/// snapshot lacks a recorded one (today: Calami-Tea's per-round tick), so a re-evaluation over the same
/// snapshot and the same rolls is deterministic.
/// </summary>
public interface IDieRoller
{
    /// <summary>Roll one die with <paramref name="sides"/> faces; returns 1..sides.</summary>
    int Roll(int sides);
}

/// <summary>Production roller.</summary>
public sealed class RandomDieRoller : IDieRoller
{
    public int Roll(int sides) => Random.Shared.Next(1, sides + 1);
}

/// <summary>
/// Test roller that replays a fixed script and records every request, so tests can assert both the values
/// consumed and that no die was rolled when none was due. Running out of script, or a scripted value outside
/// 1..sides, is a test bug and throws.
/// </summary>
public sealed class ScriptedDieRoller : IDieRoller
{
    private readonly Queue<int> _script;
    private readonly List<int> _requests = [];

    public ScriptedDieRoller(params int[] script) => _script = new Queue<int>(script);

    /// <summary>The <c>sides</c> of every Roll call so far, in order.</summary>
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

/// <summary>A roller for evaluations that must not roll (a tie layer, a round with no due dice): any request throws.</summary>
public sealed class NoDiceRoller : IDieRoller
{
    public int Roll(int sides) => throw new InvalidOperationException($"Unexpected die roll (d{sides}).");
}
