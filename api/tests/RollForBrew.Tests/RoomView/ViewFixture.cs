using System.Text.Json;
using RollForBrew.Domain.RoomView;
using RollForBrew.Domain.Snapshot;

namespace RollForBrew.Tests.RoomView;

public sealed class ViewFixture
{
    public static readonly Guid RoomId = Guid.Parse("00000000-0000-4000-8000-000000000a01");
    public static readonly Guid RoundId = Guid.Parse("00000000-0000-4000-8000-000000000b01");
    public static readonly DateTimeOffset T0 = new(2026, 10, 9, 12, 0, 0, TimeSpan.Zero);

    public string Viewer = "ann";
    public bool IsTest;
    public DateTimeOffset Now = T0.AddMinutes(1);
    public string[] RoomPlayers = ["ann", "bob", "cat"];
    public List<RoundRow> Rounds = [];
    public List<RoundParticipantRow> Participants = [];
    public List<RoundLayerParticipantRow> LayerParticipants = [];
    public List<RollRow> Rolls = [];
    public List<SpellCardRow> Cards = [];
    public List<DeckInstanceRow> Deck = [];
    public ViewExtras Extras = null!;
    public ViewerReads Reads = ViewerReads.Empty;

    public ViewFixture()
    {
        Extras = new ViewExtras(
            RoomPlayers.Append("zed").Select(p => new PlayerInfo(p, p.ToUpperInvariant(), $"{p}@x.test", null, false)).ToList(),
            null, null, [], null, null, null);
    }

    public static RoundRow Round(Guid id, string status, string startedBy = "ann", int layer = 0, DateTimeOffset? started = null,
        DateTimeOffset? closed = null, DateTimeOffset? resolved = null, string? brewer = null, int generation = 1) =>
        new(id, RoomId, startedBy, status, started ?? T0, resolved, closed, brewer, null, layer, 0, generation, [], null, null, null);

    public static RoundParticipantRow Participant(string player, Guid? round = null, DateTimeOffset? at = null, DateTimeOffset? excluded = null) =>
        new(round ?? RoundId, player, at ?? T0, excluded);

    public static RollRow Roll(string player, int value, int layer = 0, Guid? round = null, int generation = 1) =>
        new(round ?? RoundId, player, layer, value, "in_app", 0, T0.AddSeconds(30), null, false, generation);

    public ViewFixture With(Func<ViewerReads, ViewerReads> reads) { Reads = reads(Reads); return this; }
    public ViewFixture WithExtras(Func<ViewExtras, ViewExtras> f) { Extras = f(Extras); return this; }

    public ViewFixture OpenRound(params string[] declared)
    {
        Rounds.Add(Round(RoundId, "open"));
        foreach (var p in declared) Participants.Add(Participant(p));
        return this;
    }

    public ViewFixture ClosedRound(int layer = 0, params string[] declared)
    {
        Rounds.Add(Round(RoundId, "closed", layer: layer, closed: T0.AddSeconds(20)));
        foreach (var p in declared) Participants.Add(Participant(p));
        return this;
    }

    public RoomViewResponse Project() => RoomViewProjector.Project(new RoomViewInput(
        new RoundSnapshot(RoomId, Now,
            [new RoomRow(RoomId, IsTest, 7)], Rounds, Participants, LayerParticipants, Rolls, [], [], Deck, Cards, [],
            RoomPlayers.Select((p, i) => new RoomPlayerRow(RoomId, p, 3 - i)).ToList(), []),
        7, Viewer, Extras, Reads));

    public string Json() => JsonSerializer.Serialize(Project(), new JsonSerializerOptions(JsonSerializerDefaults.Web));
}
