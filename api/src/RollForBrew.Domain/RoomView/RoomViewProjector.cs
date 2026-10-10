using RollForBrew.Domain.Snapshot;

namespace RollForBrew.Domain.RoomView;

public static class RoomViewProjector
{
    public static RoomViewResponse Project(RoomViewInput input)
    {
        var s = input.Snapshot;
        var me = input.ViewerId;
        var x = input.Extras;
        var r = input.Reads;
        var room = s.Rooms.Single(rm => rm.Id == s.RoomId);

        var players = x.Players.ToDictionary(p => p.Id);
        PlayerInfo? P(string id) => players.GetValueOrDefault(id);
        var modifiers = s.RoomPlayers.Where(rp => rp.RoomId == s.RoomId).ToDictionary(rp => rp.PlayerId, rp => rp.Modifier);
        int Mod(string id) => modifiers.GetValueOrDefault(id);

        var active = s.Rounds.SingleOrDefault(rd => rd.RoomId == s.RoomId && (rd.Status == "open" || rd.Status == "closed"));
        var isOpen = active?.Status == "open";
        var isClosed = active?.Status == "closed";
        var layer = active?.CurrentLayer ?? 0;
        var isTiePhase = isClosed && layer > 0;

        var badges = r.EffectBadges.Where(b => b.Polarity is not null)
            .GroupBy(b => b.TargetPlayerId)
            .ToDictionary(g => g.Key, g => (IReadOnlyList<EffectBadge>)g
                .Select(b => new EffectBadge(b.EffectId, b.CardName, b.Tier, b.Polarity!, b.RoundsRemaining)).ToList());
        var roster = s.RoomPlayers.Where(rp => rp.RoomId == s.RoomId)
            .OrderByDescending(rp => rp.Modifier).ThenBy(rp => rp.PlayerId, StringComparer.Ordinal)
            .Select(rp => new RosterEntry(rp.PlayerId, P(rp.PlayerId)?.DisplayName, P(rp.PlayerId)?.Email,
                P(rp.PlayerId)?.AvatarUrl, rp.Modifier, P(rp.PlayerId)?.IsTest ?? false,
                badges.GetValueOrDefault(rp.PlayerId) ?? []))
            .ToList();

        var rolls = active is null
            ? new List<RollRow>()
            : s.Rolls.Where(ro => ro.RoundId == active.Id && ro.Generation == active.ReplayGeneration).ToList();
        var rolledThisLayer = rolls.Where(ro => ro.Layer == layer).Select(ro => ro.PlayerId).ToHashSet();
        IReadOnlyList<ParticipantView> ParticipantsOf(Guid roundId) =>
            s.RoundParticipants.Where(p => p.RoundId == roundId).OrderBy(p => p.DeclaredAt).ThenBy(p => p.PlayerId, StringComparer.Ordinal)
                .Select(p => new ParticipantView(p.PlayerId, P(p.PlayerId)?.DisplayName, P(p.PlayerId)?.Email,
                    P(p.PlayerId)?.AvatarUrl, Mod(p.PlayerId), p.DeclaredAt, p.ExcludedAt,
                    active?.Id == roundId && rolledThisLayer.Contains(p.PlayerId)))
                .ToList();
        IReadOnlyList<ParticipantView> participants = active is null ? [] : ParticipantsOf(active.Id);
        var hasDeclared = participants.Any(p => p.PlayerId == me);
        var isStarter = active?.StartedBy == me;
        IReadOnlyList<TiedParticipantView> tied = active is not null && isTiePhase
            ? s.RoundLayerParticipants.Where(p => p.RoundId == active.Id && p.Layer == layer)
                .OrderBy(p => p.EnteredAt).ThenBy(p => p.PlayerId, StringComparer.Ordinal)
                .Select(p => new TiedParticipantView(p.PlayerId, P(p.PlayerId)?.DisplayName, P(p.PlayerId)?.Email,
                    P(p.PlayerId)?.AvatarUrl, Mod(p.PlayerId), p.ExcludedAt, rolledThisLayer.Contains(p.PlayerId)))
                .ToList()
            : [];
        var isTied = tied.Any(t => t.PlayerId == me);

        var canClose = isOpen && isStarter && participants.Count >= 2;
        var canDeclareLate = isClosed && !hasDeclared && rolls.Count == 0;

        int? OwnRollAt(int l) => rolls.Where(ro => ro.PlayerId == me && ro.Layer == l).Select(ro => (int?)ro.Value).FirstOrDefault();
        int? ownRoll = active is null ? null
            : isTiePhase ? (isTied ? OwnRollAt(layer) : null)
            : isClosed && hasDeclared ? OwnRollAt(0) : null;
        int? layerZeroOwnRoll = !isTiePhase ? ownRoll : isClosed && hasDeclared ? OwnRollAt(0) : null;

        var compelledRound = isClosed && layer == 0 ? active : null;
        var step = r.CompelledStep;
        IReadOnlyList<string> stepWaiting = step?.WaitingOn ?? [];
        var myCompelled = compelledRound is null ? null : r.CompelledCast;
        var revoltPicker = compelledRound is null ? null : r.RevoltPickerId;

        var isExpectedToRoll = isClosed
            && !(layer == 0 && stepWaiting.Count > 0)
            && r.ExpectedRollerIds.Contains(me);
        var isPlayersTurn = isExpectedToRoll && ownRoll is null;
        var rollInputMode = isPlayersTurn ? x.RollInputMode ?? "in_app_only" : null;
        var needsRollInput = isPlayersTurn && !isTiePhase;

        var orderRound = active ?? s.Rounds.Where(rd => rd.RoomId == s.RoomId && rd.Status == "resolved")
            .OrderByDescending(rd => rd.ResolvedAt).FirstOrDefault();
        var orderRoundId = orderRound?.Id;
        IReadOnlyList<MenuEntryView> menu = orderRoundId is null
            ? []
            : x.Menu.Select(m => new MenuEntryView(m.PlayerId, m.DrinkType, m.Milk, m.Sugar, m.Decaf, m.NoPreferenceSet)).ToList();
        IReadOnlyList<ParticipantView> menuParticipants = active is not null ? participants
            : orderRoundId is { } oid ? ParticipantsOf(oid) : [];
        var myOrderForRound = orderRoundId is null ? null : x.MyOrderForRound;
        var myMostRecent = orderRoundId is not null && myOrderForRound is null ? x.MyMostRecentOrder : null;

        var held = r.HeldCards;
        bool Holds(string name) => held.Any(c => c.Location == "held" && c.CardName == name);
        var heldReaction = held.FirstOrDefault(c => c.Location == "held" && c.CastingTime == "R");
        var castWindowOpenForAction = active is not null && (isOpen || myCompelled?.CastingTime == "A");

        var pendingDraw = r.PendingSpellDraw is { } d
            ? new PendingSpellDrawView(d.RoundId, d.Trigger, d.OtherCount, s.SpellCards
                .OrderBy(c => c.Tier, StringComparer.Ordinal).ThenBy(c => c.Name, StringComparer.OrdinalIgnoreCase)
                .Select(c => c.Name).ToList())
            : null;
        IReadOnlyList<PendingCastRow> pendingCasts = isClosed ? r.PendingCasts : [];
        IReadOnlyList<PendingDieRow> pendingDice = active is null ? [] : r.PendingDice;
        var spellDieMode = pendingDice.Count > 0 ? x.RollInputMode ?? "in_app_only" : null;
        IReadOnlyList<DispellableRow> dispellable = castWindowOpenForAction ? r.Dispellable : [];
        IReadOnlyList<string> heist = castWindowOpenForAction && Holds("Tea Heist") ? r.HeistTargetIds : [];
        var lastDrip = castWindowOpenForAction && Holds("Last Drip") ? r.LastDripPreview : null;

        var window = isClosed ? r.ReactionWindow : null;
        var reaction = window is null ? null : new ReactionView(window.WindowId, window.Layer, window.PollRound,
            window.Eligible, window.AlreadyPassed, r.ReactionStack, r.ReactionPendingPlayers, r.SkipVote,
            window.Layer == 0 ? r.CourageTokens : [], myCompelled?.CastingTime == "R");

        var compelledView = compelledRound is null ? null : new CompelledCastView(myCompelled, compelledRound.Id,
            stepWaiting.Where(id => id != me).ToList(), step?.EndedAt);

        var replay = x.PendingReplay is { } pr
            ? new PendingReplayView(pr.RoundId, pr.CasterId, P(pr.CasterId)?.DisplayName, pr.CasterId == me, pr.CreatedAt)
            : null;

        var rateable = x.Rateable is { } rt
            ? new RateableRoundView(rt.RoundId, rt.BrewerDisplayName, rt.BrewerEmail, rt.ResolvedAt, rt.MyScore)
            : null;

        IReadOnlyList<HistoryEntry> history = room.IsTest
            ? []
            : s.Rounds.Where(rd => rd.RoomId == s.RoomId && rd.Status == "resolved" && rd.BrewerId is not null)
                .OrderByDescending(rd => rd.ResolvedAt)
                .Select(rd => new HistoryEntry(rd.Id, rd.ResolvedAt, rd.CupsMade, rd.BrewerId,
                    P(rd.BrewerId!)?.DisplayName ?? P(rd.BrewerId!)?.Email))
                .ToList();

        var layerEntered = active is not null && layer > 0
            ? s.RoundLayerParticipants.Where(p => p.RoundId == active.Id && p.Layer == layer).Select(p => (DateTimeOffset?)p.EnteredAt).Min()
            : null;
        var deadline = StallDeadline.Next(new StallClockInput(
            s.DbNow, active?.Status, active?.StartedAt, active?.ClosedAt, layer, layerEntered,
            layer == 0 && stepWaiting.Count > 0, step?.EndedAt, r.LayerZeroWindowClosedAt,
            window is not null ? r.SkipVote?.PollRoundStartedAt : null, x.PendingReplay?.CreatedAt));

        var panels = new Panels(
            BrewRating: rateable is not null,
            Menu: orderRoundId is not null,
            SpellDrawChoice: pendingDraw is not null,
            RoundReplayPrompt: replay is not null,
            PendingSpellDie: active is not null && spellDieMode is not null,
            CompelledCast: compelledRound is not null,
            TeaPartyRevolt: active is not null && revoltPicker is not null,
            SpellCards: true,
            TieBanner: isTiePhase && tied.Count > 0,
            RoundReveal: isClosed,
            LateDeclare: canDeclareLate,
            WhosIn: isOpen,
            RollInput: needsRollInput && rollInputMode is not null,
            ReactionBanner: active is not null && reaction is not null,
            IdleRoom: active is null);

        var activeView = active is null ? null : new ActiveRoundView(active.Id, active.StartedBy, active.Status, active.StartedAt,
            active.ClosedAt, layer, isTiePhase, participants, tied, rolledThisLayer.OrderBy(i => i, StringComparer.Ordinal).ToList());

        return new RoomViewResponse(
            input.Version,
            new RoomPart(s.RoomId, room.IsTest, roster, activeView, history, deadline, s.DbNow),
            new ViewerPart(
                me, hasDeclared, isStarter,
                CanDeclare: isOpen && !hasDeclared,
                CanWithdraw: isOpen && hasDeclared && !isStarter,
                CanClose: canClose,
                NeedMoreToClose: isOpen && isStarter ? Math.Max(0, 2 - participants.Count) : 0,
                CanDeclareLate: canDeclareLate,
                CanStartRound: active is null,
                IsTied: isTied, OwnRoll: ownRoll, LayerZeroOwnRoll: layerZeroOwnRoll,
                IsExpectedToRoll: isExpectedToRoll, IsPlayersTurnToRoll: isPlayersTurn, NeedsRollInput: needsRollInput,
                RollInputMode: rollInputMode,
                OrderRoundId: orderRoundId, MyOrderForRound: myOrderForRound, MyMostRecentOrder: myMostRecent,
                OrderCue: orderRoundId is not null && myOrderForRound is null,
                Menu: menu, MenuParticipants: menuParticipants, RateableRound: rateable,
                HeldCards: held, HeldReactionCard: heldReaction, PendingSpellDraw: pendingDraw,
                PendingCasts: pendingCasts, PendingSpellDice: pendingDice, SpellDieRollInputMode: spellDieMode,
                CompelledCast: compelledView, TeaPartyRevoltPickerId: revoltPicker,
                DispellableEffects: dispellable, HeistTargetIds: heist, LastDripPreview: lastDrip,
                Reaction: reaction, PendingRoundReplay: replay, Panels: panels));
    }
}
