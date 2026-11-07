using System.Text.Json.Nodes;
using RollForBrew.Domain.Resolver;

namespace RollForBrew.Domain.Commands;

/// <summary>A broadcast the command sends if it commits. The store stamps <c>version</c>
/// onto the payload, so a decision never needs to know the room's version.</summary>
public sealed record RoomEvent(string Name, JsonObject Payload);

/// <summary>The whole command contract (ADR 0012). An empty write list means no version bump
/// and no broadcast. <paramref name="ReloadAfterWrite"/> applies the writes, re-reads the
/// snapshot in the same transaction and decides again: how a decision reads what a bridge
/// wrote. The last pass's result wins; every pass's writes and events count.</summary>
public sealed record Decision<T>(
    IReadOnlyList<Write> Writes,
    IReadOnlyList<RoomEvent> Events,
    T Result,
    bool ReloadAfterWrite = false);
