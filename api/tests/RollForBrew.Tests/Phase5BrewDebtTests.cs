using System.Text.Json;
using RollForBrew.Domain.Dice;
using RollForBrew.Domain.Resolver;
using RollForBrew.Domain.Snapshot;
using RollForBrew.Tests.Harness;

namespace RollForBrew.Tests;

public class Phase5BrewDebtTests
{
    private static JsonElement J(object o) => JsonSerializer.SerializeToElement(o);

    private static readonly DateTimeOffset s_t0 = DateTimeOffset.Parse("2026-01-01T00:00:00Z");

    [Fact]
    public void A_debt_round_pays_the_oldest_due_debt_and_skips_the_ladder()
    {
        var fx = GoldenFixture.Load("05-brew-debt-round-paid");
        var debtor = fx.Snapshot.RoundParticipants.First(p => p.RoundId == fx.RoundId).PlayerId;

        var res = Evaluator.Evaluate(fx.Snapshot, fx.RoundId, new ScriptedDieRoller());

        Assert.Equal("brewer", res.Outcome);
        Assert.Equal(debtor, res.BrewerId);
        Assert.Equal("brew_debt", res.BrewerSource);
        Assert.NotNull(res.BrewerRecord);
        Assert.Equal("brew_debt", res.BrewerRecord!.Source);
        Assert.Contains(res.Trace, s => s.DisplayKind == "brew_debt" && s.Extras.TryGetValue("brew_debt", out var v) && v?.ToString() == "paid");
    }

    [Fact]
    public void A_debt_already_recorded_as_paid_is_not_due_again()
    {
        var fx = GoldenFixture.Load("05-brew-debt-round-paid");
        var castId = fx.Snapshot.SpellCasts.Single().Id;
        var paid = new RoundRow(
            Guid.NewGuid(), fx.Snapshot.RoomId, "p", "resolved", s_t0, s_t0, s_t0, "p", 1, 0, 1, 0, [],
            "brew_debt", castId, null);
        var snapshot = fx.Snapshot with { Rounds = [.. fx.Snapshot.Rounds, paid] };

        var e = Assert.Throws<ResolveException>(() => Evaluator.Evaluate(snapshot, fx.RoundId, new ScriptedDieRoller()));
        Assert.Equal("resolve_round_not_all_rolled", e.Code);
    }

    [Fact]
    public void An_immune_debtor_plays_normally_and_the_debt_stays_owed()
    {
        var fx = GoldenFixture.Load("05-brew-debt-round-paid");
        var debtor = fx.Snapshot.RoundParticipants.First(p => p.RoundId == fx.RoundId).PlayerId;
        var card = new SpellCardRow(Guid.NewGuid(), "The Last Cuppa", "reaction", "self", "1", "", null, null);
        var immunity = new ActiveEffectRow(
            Guid.NewGuid(), fx.Snapshot.RoomId, debtor, debtor, fx.Snapshot.SpellCasts.Single().Id, card.Id,
            "brewer_immunity", J(new { override_proof = true }), null, s_t0, false, null);
        var snapshot = fx.Snapshot with
        {
            SpellCards = [.. fx.Snapshot.SpellCards, card],
            ActiveEffects = [.. fx.Snapshot.ActiveEffects, immunity],
        };

        var e = Assert.Throws<ResolveException>(() => Evaluator.Evaluate(snapshot, fx.RoundId, new ScriptedDieRoller()));
        Assert.Equal("resolve_round_not_all_rolled", e.Code);
    }

    [Fact]
    public void A_round_that_has_started_rolling_is_not_a_debt_round()
    {
        var fx = GoldenFixture.Load("05-brew-debt-round-paid");
        var debtor = fx.Snapshot.RoundParticipants.First(p => p.RoundId == fx.RoundId).PlayerId;
        var other = fx.Snapshot.RoundParticipants.First(p => p.RoundId == fx.RoundId && p.PlayerId != debtor).PlayerId;
        var t = fx.Snapshot.Rounds.Single(r => r.Id == fx.RoundId).ClosedAt!.Value;
        var snapshot = fx.Snapshot with
        {
            Rolls = [.. fx.Snapshot.Rolls,
                new RollRow(fx.RoundId, debtor, 0, 20, "manual", 0, t, null, false, 0),
                new RollRow(fx.RoundId, other, 0, 3, "manual", 0, t, null, false, 0)],
        };

        var res = Evaluator.Evaluate(snapshot, fx.RoundId, new ScriptedDieRoller());

        Assert.Equal("default", res.BrewerSource);
        Assert.Equal(other, res.BrewerId);
    }

    [Fact]
    public void An_iou_resolved_after_the_round_closed_is_not_yet_due()
    {
        var fx = GoldenFixture.Load("05-brew-debt-round-paid");
        var closedAt = DateTimeOffset.Parse("2026-01-01T00:00:06Z");
        List<RoundRow> RoundsWithResolvedAt(DateTimeOffset resolvedAt)
        {
            return fx.Snapshot.Rounds
                .Select(r => r.BrewerSource == "brew_iou" ? r with { ResolvedAt = resolvedAt } : r).ToList();
        }

        var before = fx.Snapshot with { Rounds = RoundsWithResolvedAt(closedAt.AddSeconds(-1)) };
        Assert.Equal("brew_debt", Evaluator.Evaluate(before, fx.RoundId, new ScriptedDieRoller()).BrewerSource);

        var after = fx.Snapshot with { Rounds = RoundsWithResolvedAt(closedAt) };
        Assert.Throws<ResolveException>(() => Evaluator.Evaluate(after, fx.RoundId, new ScriptedDieRoller()));
    }
}
