using System.Text.Json;
using System.Text.Json.Nodes;
using RollForBrew.Domain.Dice;
using RollForBrew.Domain.Liveness;
using RollForBrew.Domain.Resolver;
using RollForBrew.Domain.Snapshot;

namespace RollForBrew.Domain.Commands;

/// <summary>
/// The eager roll-input shim (ADR 0005): forced rerolls, then flip, then swap, then chosen
/// pair, each recording its before and after on the cast. Ported from apply_forced_reroll,
/// apply_roll_flip, apply_roll_swap and apply_roll_pair_transform. Runs before
/// <see cref="Evaluator"/>, which only reads transforms already recorded.
/// </summary>
internal sealed class RollShim
{
    private readonly RoundSnapshot _s;
    private readonly Guid _roundId;
    private readonly int _layer;
    private readonly Dictionary<string, int> _rolls;
    private readonly Dictionary<Guid, JsonObject> _transforms = [];
    private readonly List<Write> _writes = [];
    private readonly List<SpellCastRow> _windowCasts;
    private readonly IReadOnlyList<ActiveEffectRow> _liveEffects;
    private readonly IReadOnlyDictionary<Guid, SpellCastRow> _casts;

    private RollShim(RoundSnapshot s, RoundRow round, int layer)
    {
        _s = s;
        _roundId = round.Id;
        _layer = layer;
        _rolls = s.Rolls.Where(r => r.RoundId == round.Id && r.Layer == layer).ToDictionary(r => r.PlayerId, r => r.Value);
        var windows = s.Windows.Where(w => w.RoundId == round.Id && w.Layer == layer).Select(w => w.Id).ToHashSet();
        _windowCasts = [.. s.SpellCasts.Where(c => c.ReactionWindowId is { } id && windows.Contains(id) && !c.Negated)];
        _liveEffects = ActiveEffects.AsOf(s, round.RoomId, round.Id);
        _casts = s.SpellCasts.ToDictionary(c => c.Id);
    }

    public static (RoundSnapshot Snapshot, IReadOnlyList<Write> Writes) Apply(RoundSnapshot s, RoundRow round, int layer, IDieRoller dice)
    {
        var shim = new RollShim(s, round, layer);
        shim.ForcedRerolls(dice);
        if (shim.CastsOf("roll_flip").Count > 0) shim.Flip();
        if (shim.CastsOf("roll_swap").Count > 0) shim.Swap();
        shim.ChosenPairs();
        return (shim.Result(), shim._writes);
    }

    private List<SpellCastRow> CastsOf(string kind) => [.. _windowCasts.Where(c => c.EffectKind == kind)];

    private static long? MinSeq(IEnumerable<SpellCastRow> casts) => casts.Select(c => (long?)c.Seq).Min();

    private void ForcedRerolls(IDieRoller dice)
    {
        var all = CastsOf("forced_reroll").Where(c => c.TargetPlayerId is not null).ToList();
        foreach (var player in all.Select(c => c.TargetPlayerId!).Distinct().Order(StringComparer.Ordinal))
        {
            if (!_rolls.TryGetValue(player, out var old))
                throw new InvalidOperationException($"apply_forced_reroll: no existing roll for {player} at round {_roundId}, layer {_layer}");

            var casts = all.Where(c => c.TargetPlayerId == player).ToList();
            JsonObject entry;
            if (Ward(player, "negative", MinSeq(casts)) is { } ward)
            {
                entry = Warded(player, old, old, ward);
            }
            else
            {
                var value = dice.Roll(20);
                SetRoll(player, value);
                entry = Moved(player, old, value);
            }
            Record(casts, "forced_reroll", 2, [entry]);
        }
    }

    private void Flip()
    {
        var casts = CastsOf("roll_flip");
        var before = MinSeq(casts);
        var players = new List<JsonObject>();
        foreach (var (player, value) in _rolls.OrderBy(r => r.Key, StringComparer.Ordinal).ToList())
        {
            // 21 - v > v exactly when v <= 10, so that is a raise.
            var polarity = value <= 10 ? "positive" : "negative";
            if (Ward(player, polarity, before) is { } ward)
            {
                players.Add(Warded(player, value, 21 - value, ward));
                continue;
            }
            SetRoll(player, 21 - value);
            players.Add(Moved(player, value, 21 - value));
        }
        Record(casts, "roll_flip", 3, players);
    }

    private void Swap()
    {
        var ranked = _rolls.ToList();
        if (ranked.Count == 0) return;
        var high = ranked.OrderByDescending(r => r.Value).ThenBy(r => r.Key, StringComparer.Ordinal).First();
        var low = ranked.OrderBy(r => r.Value).ThenBy(r => r.Key, StringComparer.Ordinal).First();
        if (high.Key == low.Key) return;

        var casts = CastsOf("roll_swap");
        var before = MinSeq(casts);
        // A swap can't conserve values with one end warded, so a ward on either cancels it.
        var ward = Ward(high.Key, "negative", before) ?? Ward(low.Key, "positive", before);
        if (ward is { } w)
        {
            Record(casts, "roll_swap", 4, [Warded(high.Key, high.Value, low.Value, w), Warded(low.Key, low.Value, high.Value, w)]);
            return;
        }
        SetRoll(high.Key, low.Value);
        SetRoll(low.Key, high.Value);
        Record(casts, "roll_swap", 4, [Moved(high.Key, high.Value, low.Value), Moved(low.Key, low.Value, high.Value)]);
    }

    private void ChosenPairs()
    {
        foreach (var cast in CastsOf("roll_pair_transform").OrderBy(c => c.Seq))
        {
            var op = cast.EffectParams.Text("op") ?? "swap";
            var pair = cast.CastInputs.Get("pair").Items().ToList();
            var a = pair.ElementAtOrDefault(0) is { ValueKind: JsonValueKind.String } pa ? pa.GetString() : null;
            var b = pair.ElementAtOrDefault(1) is { ValueKind: JsonValueKind.String } pb ? pb.GetString() : null;

            // Not two distinct players who both rolled: the by-name cast paths validate this
            // away. The empty transform keeps the cast in the Cast Log with no Trace step.
            if (a is null || b is null || a == b || !_rolls.TryGetValue(a, out var av) || !_rolls.TryGetValue(b, out var bv))
            {
                Record([cast], "roll_pair_transform", 5, [], op);
                continue;
            }

            var (aAfter, bAfter) = op switch
            {
                "min" => (Math.Min(av, bv), Math.Min(av, bv)),
                "max" => (Math.Max(av, bv), Math.Max(av, bv)),
                _ => (bv, av),
            };
            var ward = Ward(a, Polarity(av, aAfter), cast.Seq) ?? Ward(b, Polarity(bv, bAfter), cast.Seq);
            if (ward is { } w)
            {
                Record([cast], "roll_pair_transform", 5, [Warded(a, av, aAfter, w), Warded(b, bv, bAfter, w)], op);
                continue;
            }
            SetRoll(a, aAfter);
            SetRoll(b, bAfter);
            Record([cast], "roll_pair_transform", 5, [Moved(a, av, aAfter), Moved(b, bv, bAfter)], op);
        }
    }

    private static string Polarity(int before, int after) => after > before ? "positive" : after < before ? "negative" : "neutral";

    /// <summary>The earliest matching ward on a player that predates the transform
    /// (_rr_active_ward_gate). A neutral change is never warded.</summary>
    private (Guid CastId, string CardName)? Ward(string player, string polarity, long? beforeSeq)
    {
        if (polarity == "neutral") return null;
        var hit = _liveEffects
            .Where(e => e.TargetPlayerId == player && e.EffectKind == "ward")
            .Where(e =>
            {
                JsonElement? ep = e.EffectParams;
                return ep.Get("domain").ContainsString("roll") && ep.Get("polarity").ContainsString(polarity);
            })
            .Where(e => !_casts.TryGetValue(e.SourceCastId, out var wc) || wc.RoundId != _roundId || beforeSeq is null || wc.Seq < beforeSeq)
            .OrderBy(e => e.CreatedAt)
            .FirstOrDefault();
        return hit is null ? null : (hit.SourceCastId, _s.SpellCards.First(c => c.Id == hit.CardId).Name);
    }

    private void SetRoll(string player, int value)
    {
        _rolls[player] = value;
        _writes.Add(new SetRollValue(_roundId, _layer, player, value));
    }

    private static JsonObject Moved(string player, int before, int after) =>
        new() { ["player_id"] = player, ["before"] = before, ["after"] = after };

    private static JsonObject Warded(string player, int value, int wouldBe, (Guid CastId, string CardName) ward) => new()
    {
        ["player_id"] = player, ["before"] = value, ["after"] = value, ["warded"] = true, ["would_be_after"] = wouldBe,
        ["ward_cast_id"] = ward.CastId.ToString(), ["ward_card_name"] = ward.CardName,
    };

    private void Record(IEnumerable<SpellCastRow> casts, string kind, int order, IReadOnlyList<JsonObject> players, string? op = null)
    {
        foreach (var cast in casts)
        {
            var transform = new JsonObject { ["kind"] = kind, ["order"] = order };
            if (op is not null) transform["op"] = op;
            transform["players"] = new JsonArray([.. players.Select(p => (JsonNode?)p.DeepClone())]);
            _transforms[cast.Id] = transform;
            _writes.Add(new SetCastRollTransform(cast.Id, transform.ToJsonString()));
        }
    }

    private RoundSnapshot Result() => _s with
    {
        Rolls = [.. _s.Rolls.Select(r => r.RoundId == _roundId && r.Layer == _layer ? r with { Value = _rolls[r.PlayerId] } : r)],
        SpellCasts = [.. _s.SpellCasts.Select(c => _transforms.TryGetValue(c.Id, out var t) ? c with { CastInputs = Merged(c.CastInputs, t) } : c)],
    };

    private static JsonElement Merged(JsonElement? inputs, JsonObject transform)
    {
        var merged = inputs is { ValueKind: JsonValueKind.Object } o ? JsonNode.Parse(o.GetRawText())!.AsObject() : [];
        merged["roll_transform"] = transform.DeepClone();
        return JsonSerializer.SerializeToElement(merged);
    }
}
