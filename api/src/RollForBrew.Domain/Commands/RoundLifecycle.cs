using RollForBrew.Domain.Dice;
using RollForBrew.Domain.Resolver;
using RollForBrew.Domain.Snapshot;

namespace RollForBrew.Domain.Commands;

/// <summary>A command the rules refuse. <paramref name="code"/> is the problem code the API
/// answers with; the API maps it to a status.</summary>
public sealed class CommandRefusal(string code, string message) : Exception(message)
{
    public string Code { get; } = code;
}

/// <summary>
/// The round lifecycle commands (spec #533, slice 3a): what declare_in, declare_in_late,
/// withdraw_declaration, close_round, cancel_round, exclude_round_participant and the replay
/// decision decide, as writes and events (ADR 0012). Each takes the locked round's snapshot
/// and the acting player. An empty write list is a no-op the store neither bumps nor announces.
/// </summary>
public static class RoundLifecycle
{
    private static readonly IReadOnlyList<RoomEvent> Changed = [new RoomEvent("room-changed", [])];

    public static Decision<bool> DeclareIn(RoundSnapshot? s, Guid roundId, string me, bool late)
    {
        var round = Find(s, roundId);
        if (late)
        {
            // Closed and nobody has rolled yet: the window Late Declare exists for.
            if (round.Status != "closed" || s!.Rolls.Any(r => r.RoundId == roundId))
                throw new CommandRefusal("round_closed_for_late_declare", "declare_in_late: round is no longer open for a late declare");
        }
        else if (round.Status != "open")
            throw new CommandRefusal("round_not_open_for_declarations", "declare_in: round is not open for declarations");

        if (!s!.RoomPlayers.Any(p => p.RoomId == round.RoomId && p.PlayerId == me))
            throw new CommandRefusal("not_present_in_room", "caller is not present in this round's room");

        // Declaring twice is fine: nothing changes, so nothing is announced.
        if (s.RoundParticipants.Any(p => p.RoundId == roundId && p.PlayerId == me)) return None();
        return Some(new InsertRoundParticipant(roundId, me));
    }

    public static Decision<bool> Withdraw(RoundSnapshot? s, Guid roundId, string me)
    {
        var round = Find(s, roundId);
        if (round.Status != "open")
            throw new CommandRefusal("round_not_open_for_declarations", "withdraw_declaration: round is not open for declarations");
        if (round.StartedBy == me)
            throw new CommandRefusal("starter_cannot_withdraw", "the round starter cannot withdraw their own declaration");
        if (!s!.RoundParticipants.Any(p => p.RoundId == roundId && p.PlayerId == me)) return None();
        return Some(new DeleteRoundParticipant(roundId, me));
    }

    /// <summary>Locks the roster and fans out table-wide placeholder casts against it. Fixing
    /// Brewmageddon's compelled set stays in SQL, so it is a bridge; a debt round has nobody
    /// casting, so it skips it (issue #432).</summary>
    public static Decision<bool> Close(RoundSnapshot? s, Guid roundId, string me)
    {
        var round = Find(s, roundId);
        if (round.Status != "open")
            throw new CommandRefusal("round_not_open_for_declarations", "close_round: round is not open");
        if (round.StartedBy != me)
            throw new CommandRefusal("close_not_starter", "close_round: only the round starter can close declarations");
        if (s!.RoundParticipants.Count(p => p.RoundId == roundId) < 2)
            throw new CommandRefusal("close_too_few_declared", "close_round: at least 2 players must declare in before closing");

        var writes = new List<Write> { new CloseRound(roundId), new Bridge("_fan_out_table_placeholder_casts", roundId) };
        if (Rules.BrewDebtDue(new EvalContext(s, round, new NoDiceRoller())) is null)
            writes.Add(new Bridge("_fix_compelled_set", roundId));
        return new Decision<bool>(writes, Changed, true);
    }

    /// <summary>Idempotent: a round that already left open or closed is left alone.</summary>
    public static Decision<bool> Cancel(RoundSnapshot? s, Guid roundId)
    {
        var round = s?.Rounds.FirstOrDefault(r => r.Id == roundId);
        return round is { Status: "open" or "closed" } ? Some(new CancelRound(roundId)) : None();
    }

    /// <summary>Idempotent. Excluding from Layer 0 also forfeits the player's outstanding compelled cast.</summary>
    public static Decision<bool> Exclude(RoundSnapshot? s, Guid roundId, string playerId, int layer)
    {
        if (s is null) return None();
        var fresh = layer == 0
            ? s.RoundParticipants.Any(p => p.RoundId == roundId && p.PlayerId == playerId && p.ExcludedAt is null)
            : s.RoundLayerParticipants.Any(p => p.RoundId == roundId && p.Layer == layer && p.PlayerId == playerId && p.ExcludedAt is null);
        if (!fresh) return None();

        List<Write> writes = [new ExcludeParticipant(roundId, playerId, layer)];
        if (layer == 0) writes.Add(new Bridge("_forfeit_compelled_card", roundId, playerId, "excluded"));
        return new Decision<bool>(writes, Changed, true);
    }

    /// <summary>The caster scraps the resolved round. The scrap itself (snapshot, delete pass,
    /// back to a closed generation 1) stays in SQL as a bridge.</summary>
    public static Decision<bool> ConfirmReplay(Guid roundId, string me, string? pendingCaster)
    {
        if (pendingCaster is null)
            throw new CommandRefusal("replay_decision_state", "confirm_round_replay: no replay decision is pending for this round");
        if (pendingCaster != me)
            throw new CommandRefusal("replay_not_caster", "confirm_round_replay: only the Time for Brew caster can scrap the round");
        return new Decision<bool>([new Bridge("_rr_scrap_round", roundId), new ClearPendingReplay(roundId)], Changed, true);
    }

    /// <summary>The caster keeps the round. Idempotent: nothing pending means nothing to do.</summary>
    public static Decision<bool> DeclineReplay(Guid roundId, string me, string? pendingCaster)
    {
        if (pendingCaster is null) return None();
        if (pendingCaster != me)
            throw new CommandRefusal("replay_not_caster", "decline_round_replay: only the Time for Brew caster can keep or scrap the round");
        return new Decision<bool>([new MarkReplayKept(roundId), new ClearPendingReplay(roundId)], Changed, true);
    }

    private static RoundRow Find(RoundSnapshot? s, Guid roundId) =>
        s?.Rounds.FirstOrDefault(r => r.Id == roundId) ?? throw new CommandRefusal("round_not_found", "round not found");

    private static Decision<bool> None() => new([], [], false);

    private static Decision<bool> Some(Write write) => new([write], Changed, true);
}
