using System.Text.Json;
using RollForBrew.Domain.Dice;
using RollForBrew.Domain.Resolver;
using RollForBrew.Domain.Snapshot;
using RollForBrew.Tests.Harness;

namespace RollForBrew.Tests;

public class Phase4bTests
{
    private static JsonElement J(object o) => JsonSerializer.SerializeToElement(o);

    private static SpellCastRow LeechAnchor(RoundSnapshot s) =>
        s.SpellCasts.Single(c => c.EffectKind == "persistent_modifier_transfer" && c.EffectParams?.TryGetProperty("per_round_delta", out _) == true);

    private static SpellCastRow TickRow(Guid roundId, SpellCastRow anchor, string target, decimal delta, long seq) => new(
        Guid.NewGuid(), roundId, anchor.CasterId, anchor.CardInstanceId, target, false,
        "persistent_modifier_transfer", J(new { delta }), null, s_castAt, null, false, seq, null,
        J(new { bitter_leech_tick = true }), null, null, null, 0, anchor.Id);

    private static readonly DateTimeOffset s_castAt = DateTimeOffset.Parse("2026-01-02T00:00:00Z");

    [Fact]
    public void Bitter_leech_synthesises_the_pair_and_projects_both_caches_without_dice()
    {
        var fx = GoldenFixture.Load("4b-pre-bitter-leech-tick-synthesis");
        var anchor = LeechAnchor(fx.Snapshot);
        var roller = new ScriptedDieRoller();

        var res = Evaluator.Evaluate(fx.Snapshot, fx.RoundId, roller);

        Assert.Empty(roller.Requests);
        var synth = res.Derived.SynthesizedCasts.OrderBy(c => c.TargetPlayerId, StringComparer.Ordinal).ToList();
        Assert.Equal(2, synth.Count);
        Assert.Equal(anchor.CasterId, synth[0].TargetPlayerId);
        Assert.Equal(1, synth[0].EffectParams?.GetProperty("delta").GetDecimal());
        Assert.Equal(anchor.TargetPlayerId, synth[1].TargetPlayerId);
        Assert.Equal(-1, synth[1].EffectParams?.GetProperty("delta").GetDecimal());
        Assert.Equal(anchor.CasterId, synth[1].CasterId);
        Assert.All(synth, c => Assert.True(c.CastInputs?.GetProperty("bitter_leech_tick").GetBoolean()));
        Assert.All(synth, c => Assert.Equal(anchor.Id, c.SourceCastId));
        Assert.Equal(-1, res.Derived.RoomPlayerModifiers[anchor.TargetPlayerId!]);
        Assert.Equal(1, res.Derived.RoomPlayerModifiers[anchor.CasterId]);
    }

    [Fact]
    public void An_existing_tick_row_for_this_generation_suppresses_resynthesis()
    {
        var fx = GoldenFixture.Load("4b-pre-bitter-leech-tick-synthesis");
        var anchor = LeechAnchor(fx.Snapshot);
        var existing = TickRow(fx.RoundId, anchor, anchor.TargetPlayerId!, -1, anchor.Seq + 1);
        var snapshot = fx.Snapshot with { SpellCasts = [.. fx.Snapshot.SpellCasts, existing] };
        var roller = new ScriptedDieRoller();

        var res = Evaluator.Evaluate(snapshot, fx.RoundId, roller);

        Assert.Empty(roller.Requests);
        Assert.Empty(res.Derived.SynthesizedCasts);
        Assert.Equal(-1, res.Derived.RoomPlayerModifiers[anchor.TargetPlayerId!]);
        Assert.False(res.Derived.RoomPlayerModifiers.ContainsKey(anchor.CasterId));
    }

    [Fact]
    public void The_gain_lands_only_when_the_caster_took_part_in_this_round()
    {
        var fx = GoldenFixture.Load("4b-pre-bitter-leech-tick-synthesis");
        var anchor = LeechAnchor(fx.Snapshot);
        var snapshot = fx.Snapshot with
        {
            RoundParticipants = fx.Snapshot.RoundParticipants.Where(p => p.PlayerId != anchor.CasterId).ToList(),
        };

        var res = Evaluator.Evaluate(snapshot, fx.RoundId, new ScriptedDieRoller());

        var synth = res.Derived.SynthesizedCasts;
        var row = Assert.Single(synth);
        Assert.Equal(anchor.TargetPlayerId, row.TargetPlayerId);
        Assert.Equal(-1, row.EffectParams?.GetProperty("delta").GetDecimal());
        Assert.Equal(-1, res.Derived.RoomPlayerModifiers[anchor.TargetPlayerId!]);
        Assert.False(res.Derived.RoomPlayerModifiers.ContainsKey(anchor.CasterId));
    }

    [Fact]
    public void A_warded_tick_negates_the_pair_and_reverts_both_caches()
    {
        var fx = GoldenFixture.Load("4b-pre-bitter-leech-tick-synthesis");
        var anchor = LeechAnchor(fx.Snapshot);
        var victim = anchor.TargetPlayerId!;
        var wardCard = new SpellCardRow(Guid.NewGuid(), "Porcelain Aegis", "reaction", "self", "1", "", null, null);
        var ward = new ActiveEffectRow(
            Guid.NewGuid(), fx.Snapshot.RoomId, victim, anchor.CasterId, anchor.Id, wardCard.Id,
            "ward", J(new { domain = "modifier", polarity = "negative" }), null, s_castAt, false, null);
        var snapshot = fx.Snapshot with
        {
            SpellCards = [.. fx.Snapshot.SpellCards, wardCard],
            ActiveEffects = [.. fx.Snapshot.ActiveEffects, ward],
        };

        var res = Evaluator.Evaluate(snapshot, fx.RoundId, new ScriptedDieRoller());

        Assert.All(res.Derived.SynthesizedCasts, c => Assert.True(c.Negated));
        var step = Assert.Single(res.Trace);
        Assert.Equal("warded", step.DisplayKind);
        Assert.Equal(victim, step.TargetPlayer);
        Assert.Equal("Bitter Leech", step.SourceCast.CardName);
        Assert.Null(step.SourceCast.CasterPlayerId);
        Assert.Equal(0m, step.Before.Value);
        Assert.Equal(0m, step.After.Value);
        Assert.Equal(-1m, step.Extras["would_be_after"]);
        Assert.Equal("blocked", step.Extras["outcome"]);
        Assert.Equal("Porcelain Aegis", step.Extras["ward_card_name"]);
        Assert.Equal(0, res.Derived.RoomPlayerModifiers[victim]);
        Assert.Equal(0, res.Derived.RoomPlayerModifiers[anchor.CasterId]);
    }

    [Fact]
    public void Projection_recomputes_from_base_plus_other_round_deltas_not_the_live_cache()
    {
        var fx = GoldenFixture.Load("4b-persistent-modifier-transfer-rest-of-day");
        var player = fx.Snapshot.SpellCasts.Single().TargetPlayerId!;
        var priorRound = Guid.NewGuid();
        var t0 = DateTimeOffset.Parse("2026-01-01T00:00:00Z");
        var prior = new RoundRow(
            priorRound, fx.Snapshot.RoomId, player, "resolved", t0, t0, t0, player, 2, 0, 2, 0, [], null, null, null);
        var priorCast = new SpellCastRow(
            Guid.NewGuid(), priorRound, player, fx.Snapshot.SpellCasts.Single().CardInstanceId, player, false,
            "persistent_modifier_transfer", J(new { delta = 5 }), null, t0, null, false, 1, null, null, null, null, null, 0, null);
        var snapshot = fx.Snapshot with
        {
            Rounds = [.. fx.Snapshot.Rounds, prior],
            SpellCasts = [.. fx.Snapshot.SpellCasts, priorCast],
        };

        var res = Evaluator.Evaluate(snapshot, fx.RoundId, new ScriptedDieRoller());

        var step = res.Trace.Single(s => s.DisplayKind == "persistent_modifier_transfer");
        Assert.Equal(7m, step.Before.Value);
        Assert.Equal(10m, step.After.Value);
        Assert.Equal(3m, step.Extras["delta"]);
        Assert.Equal(true, step.Extras["rest_of_day"]);
        Assert.Equal(10, res.Derived.RoomPlayerModifiers[player]);
    }

    [Fact]
    public void A_fully_negated_transfer_still_reverts_the_targets_cache()
    {
        var fx = GoldenFixture.Load("4b-persistent-modifier-transfer-rest-of-day");
        var cast = fx.Snapshot.SpellCasts.Single();
        var player = cast.TargetPlayerId!;
        var snapshot = fx.Snapshot with
        {
            SpellCasts = [cast with { Negated = true }],
        };

        var res = Evaluator.Evaluate(snapshot, fx.RoundId, new ScriptedDieRoller());

        Assert.DoesNotContain(res.Trace, s => s.DisplayKind == "persistent_modifier_transfer");
        Assert.Equal(0, res.Derived.RoomPlayerModifiers[player]);
    }
}
