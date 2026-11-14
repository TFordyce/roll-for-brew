using System.Text.Json;
using System.Text.Json.Nodes;
using RollForBrew.Domain.Dice;
using RollForBrew.Domain.Liveness;
using RollForBrew.Domain.Resolver;
using RollForBrew.Domain.Snapshot;

namespace RollForBrew.Domain.Commands;

/// <summary>
/// Roll submission (spec #533, slice 3b): what submit_roll, submit_manual_roll, their Test
/// Room <c>_as</c> twins and admin_proxy_roll decide, as writes and events (ADR 0012). Who the
/// roller is, and whether a caller is an admin, are resolved before the call (they read the JWT
/// and <c>players</c>, which the snapshot does not hold), so every method is pure given its
/// snapshot and dice. A roll that completes a Layer is advanced by the caller's next
/// AdvanceRound, as before.
/// </summary>
public static class RollSubmission
{
    private static readonly IReadOnlyList<RoomEvent> Changed = [new RoomEvent("room-changed", [])];

    /// <summary>The server rolls: advantage and disadvantage, a Fixed Roll and the wards against them.</summary>
    public static Decision<int> Auto(RoundSnapshot? s, Guid roundId, string player, IDieRoller dice, bool asAdmin = false)
    {
        var round = Rollable(s, roundId, player, asAdmin);
        var layer = round.CurrentLayer;
        var live = layer == 0 ? ActiveEffects.AsOf(s!, round.RoomId, roundId) : [];
        var casts = s!.SpellCasts.ToDictionary(c => c.Id);
        var mine = layer == 0
            ? s.SpellCasts.Where(c => c.RoundId == roundId && c.TargetPlayerId == player && !c.TargetPending).ToList()
            : [];

        static bool Conditional(SpellCastRow c) => ((JsonElement?)c.EffectParams).Has("condition");
        var plainAdvantage = mine.Where(c => c.EffectKind == "advantage" && !Conditional(c)).ToList();
        var plainDisadvantage = mine.Where(c => c.EffectKind == "disadvantage").ToList();
        var hasAdvantage = plainAdvantage.Count > 0;
        var hasDisadvantage = plainDisadvantage.Count > 0;

        JsonElement? condition = null;
        (Guid CastId, string CardName)? advWard = null, disWard = null;
        if (layer == 0)
        {
            // Rest-of-day persistent advantage (Prophe-Tea) is an active-effect projection, not a cast row.
            hasAdvantage |= live.Any(e => e.EffectKind == "advantage" && e.TargetPlayerId == player);
            hasDisadvantage |= live.Any(e => e.EffectKind == "disadvantage" && e.TargetPlayerId == player);
            condition = mine.Where(c => c.EffectKind == "advantage" && Conditional(c))
                .Select(c => ((JsonElement?)c.EffectParams).Get("condition")).FirstOrDefault();

            // A roll-domain ward wards a STATIC advantage / disadvantage off before the roll (#335).
            // A projection-only persistent advantage has no cast row to date the ward against.
            if (hasAdvantage && plainAdvantage.Count > 0)
                advWard = WardGate.Find(s, live, casts, roundId, player, "positive", plainAdvantage.Min(c => c.Seq));
            if (hasDisadvantage && plainDisadvantage.Count > 0)
                disWard = WardGate.Find(s, live, casts, roundId, player, "negative", plainDisadvantage.Min(c => c.Seq));
            if (advWard is not null) hasAdvantage = false;
            if (disWard is not null) hasDisadvantage = false;
        }

        var writes = new List<Write>();
        var first = dice.Roll(20);
        var value = first;
        var fixedApplied = false;

        // Fixed Roll (Steady Hand, Sleeping Camomile): pins the die unless a ward blocks it.
        var fixedCasts = mine.Where(c => c.EffectKind == "fixed_roll" && !c.Negated).OrderBy(c => c.Seq).ToList();
        if (layer == 0 && fixedCasts.FirstOrDefault() is { } pin && ((JsonElement?)pin.EffectParams).Int("value") is { } pinned)
        {
            var polarity = pinned > first ? "positive" : pinned < first ? "negative" : "neutral";
            var ward = WardGate.Find(s, live, casts, roundId, player, polarity, pin.Seq);
            var entry = ward is { } w
                ? new JsonObject
                {
                    ["player_id"] = player, ["before"] = first, ["after"] = first, ["warded"] = true, ["would_be_after"] = pinned,
                    ["ward_cast_id"] = w.CastId.ToString(), ["ward_card_name"] = w.CardName,
                }
                : new JsonObject { ["player_id"] = player, ["before"] = first, ["after"] = pinned };
            foreach (var c in fixedCasts) writes.Add(Transform(c.Id, "fixed_roll", 0, entry));
            if (ward is null) { value = pinned; fixedApplied = true; }
        }

        string? branch = null;
        int condAdv = 15, condDis = 5;
        if (condition is { } cond)
        {
            JsonElement? c = cond;
            condAdv = c.Int("advantage_at_or_above") ?? 15;
            condDis = c.Int("disadvantage_at_or_below") ?? 5;
            branch = first >= condAdv ? "advantage" : first <= condDis ? "disadvantage" : "none";
        }

        var effAdvantage = hasAdvantage || branch == "advantage";
        var effDisadvantage = hasDisadvantage || branch == "disadvantage";
        var cancelled = effAdvantage && effDisadvantage;

        int? second = null, discarded = null;
        if (!fixedApplied && effAdvantage != effDisadvantage)
        {
            second = dice.Roll(20);
            discarded = effAdvantage ? Math.Min(value, second.Value) : Math.Max(value, second.Value);
            value = effAdvantage ? Math.Max(value, second.Value) : Math.Min(value, second.Value);
        }

        writes.Add(new InsertRoll(roundId, player, layer, value, "in_app", Modifier(s, round.RoomId, player), discarded));

        var warded = advWard is not null || disWard is not null;
        if (!fixedApplied && (effAdvantage || effDisadvantage || condition is not null || warded))
        {
            var dieValues = cancelled || second is null ? new JsonArray(first) : new JsonArray(first, second.Value);
            foreach (var c in mine.Where(c => c.EffectKind is "advantage" or "disadvantage" && !Conditional(c)))
            {
                var wardHit = c.EffectKind == "advantage" ? advWard : disWard;
                var entry = wardHit is { } w
                    ? new JsonObject
                    {
                        ["player_id"] = player, ["before"] = first, ["after"] = first, ["warded"] = true, ["would_be_after"] = first,
                        ["ward_cast_id"] = w.CastId.ToString(), ["ward_card_name"] = w.CardName,
                    }
                    : new JsonObject { ["player_id"] = player, ["before"] = first, ["after"] = value };
                writes.Add(Transform(c.Id, c.EffectKind!, 1, entry, cancelled, dieValues));
            }

            if (condition is not null)
                foreach (var c in mine.Where(c => c.EffectKind == "advantage" && Conditional(c)))
                    writes.Add(Transform(c.Id, "advantage", 1,
                        new JsonObject { ["player_id"] = player, ["before"] = first, ["after"] = value }, cancelled, dieValues,
                        new JsonObject
                        {
                            ["first_die"] = first, ["branch"] = branch,
                            ["advantage_at_or_above"] = condAdv, ["disadvantage_at_or_below"] = condDis,
                        }));
        }

        return new Decision<int>(writes, Changed, value);
    }

    /// <summary>The roller reads the number off a physical die.</summary>
    public static Decision<bool> Manual(RoundSnapshot? s, Guid roundId, string player, int value, bool asAdmin = false)
    {
        CheckValue(value);
        var round = Rollable(s, roundId, player, asAdmin);
        return new Decision<bool>([new InsertRoll(roundId, player, round.CurrentLayer, value, "manual", Modifier(s!, round.RoomId, player))], Changed, true);
    }

    /// <summary>An admin enters the number a player at the table read out, folding them into a
    /// live round (#273). Eligible in the declaration window, or closed with nobody rolled yet.</summary>
    public static Decision<bool> Proxy(RoundSnapshot? s, Guid roundId, string player, int value)
    {
        CheckValue(value);
        var round = Find(s, roundId);
        if (round.Status is not ("open" or "closed") || s!.Rolls.Any(r => r.RoundId == roundId))
            throw new CommandRefusal("round_closed_for_proxy_roll", "admin_proxy_roll: round is no longer open for a proxy roll");
        // Nobody rolls during the Compelled Cast step (Brewmageddon, #440), a Proxy Roll included.
        if (round.Status == "closed"
            && LayerReadiness.Of(s, roundId, round.CurrentLayer).Holds.Any(h => h.Kind == LayerHoldKind.CompelledCast))
            throw new CommandRefusal("rolling_held_for_compelled_casts", "admin_proxy_roll: rolling is held until every compelled cast is in");

        // The target needs no prior login: this creates their seat and declaration if missing.
        List<Write> writes =
        [
            new EnsureRoomPlayer(round.RoomId, player),
            new InsertRoundParticipant(roundId, player),
            new InsertRoll(roundId, player, round.CurrentLayer, value, "manual", Modifier(s, round.RoomId, player), EnteredByAdmin: true),
        ];
        if (value is 1 or 20) writes.Add(new RecordCritDraw(roundId, player, value == 1 ? "nat1" : "nat20"));
        return new Decision<bool>(writes, Changed, true);
    }

    private static void CheckValue(int value)
    {
        if (value is < 1 or > 20)
            throw new CommandRefusal("roll_value_out_of_range", "a roll must be between 1 and 20");
    }

    private static RoundRow Find(RoundSnapshot? s, Guid roundId) =>
        s?.Rounds.FirstOrDefault(r => r.Id == roundId) ?? throw new CommandRefusal("round_not_found", "round not found");

    /// <summary>The checks every roll shares. A Test Room puppet ("_as") also needs a test room.</summary>
    private static RoundRow Rollable(RoundSnapshot? s, Guid roundId, string player, bool asAdmin)
    {
        var round = Find(s, roundId);
        if (asAdmin && !s!.Rooms.Any(r => r.Id == round.RoomId && r.IsTest))
            throw new CommandRefusal("round_not_in_test_room", "the round is not in the Test Room");
        if (round.Status != "closed")
            throw new CommandRefusal("round_not_open_for_rolling", "round is not closed for rolling");
        // A second roll in the same Layer is the same stale click as a roll out of turn.
        if (s!.Rolls.Any(r => r.RoundId == roundId && r.Layer == round.CurrentLayer && r.PlayerId == player)
            || !LayerReadiness.Of(s, roundId, round.CurrentLayer).MayRoll(player))
            throw new CommandRefusal("not_expected_roller", "player is not expected to roll in the current layer");
        return round;
    }

    private static int Modifier(RoundSnapshot s, Guid roomId, string player) =>
        s.RoomPlayers.FirstOrDefault(p => p.RoomId == roomId && p.PlayerId == player)?.Modifier ?? 0;

    private static SetCastRollTransform Transform(
        Guid castId, string kind, int order, JsonObject player, bool? cancelled = null, JsonArray? dice = null, JsonObject? condition = null)
    {
        var t = new JsonObject { ["kind"] = kind, ["order"] = order };
        if (cancelled is { } c) t["cancelled"] = c;
        if (condition is not null) t["condition"] = condition;
        if (dice is not null) t["dice"] = dice.DeepClone();
        t["players"] = new JsonArray(player.DeepClone());
        return new SetCastRollTransform(castId, t.ToJsonString());
    }
}
