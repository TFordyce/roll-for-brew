using System.Text.Json;
using System.Text.Json.Nodes;
using Microsoft.Extensions.Logging;
using Npgsql;
using RollForBrew.Api.Data;
using RollForBrew.Domain.Dice;
using RollForBrew.Domain.Resolver;
using RollForBrew.Domain.Snapshot;

namespace RollForBrew.Api.RoundAdvance;

/// <summary>
/// Slice 2a's evaluator shadow (#546): inside one transaction, load the snapshot,
/// run C# <c>Evaluate</c> beside SQL, pre-write only the roll-bearing writes (the
/// synthesized casts, so SQL replays C#'s rolls instead of rolling its own — "existing
/// tick rows mean only missing ticks roll"), then let the bridged SQL function commit
/// authoritative state and diff the C# <c>Resolution</c> against what SQL wrote.
/// Diffs are logged at Error with everything needed to reproduce them as a golden;
/// they are never served — the caller gets SQL's payload unchanged.
/// </summary>
public sealed class ShadowAdvance
{
    public const string DiffMarker = "rfb-shadow-diff";
    public const string SkipMarker = "rfb-shadow-skip";

    public enum Bridge { AdvanceLayer, FinalizeLayer }

    private static readonly Func<RoundSnapshot, Guid, IDieRoller, Resolution> DefaultEvaluate = Evaluator.Evaluate;

    private readonly IDieRoller _dice;
    private readonly Func<RoundSnapshot, Guid, IDieRoller, Resolution> _evaluate;

    /// <param name="dice">Production default is the platform RNG; tests script it.</param>
    /// <param name="evaluate">Production default is <see cref="Evaluator.Evaluate"/>;
    /// the seam exists only so tests can force a mismatch to exercise the diff path.</param>
    public ShadowAdvance(IDieRoller? dice = null, Func<RoundSnapshot, Guid, IDieRoller, Resolution>? evaluate = null)
    {
        _dice = dice ?? new RandomDieRoller();
        _evaluate = evaluate ?? DefaultEvaluate;
    }

    public async Task<JsonNode?> Run(
        StoreSession session, RoundLock? round, Guid roundId, Bridge bridge, ILogger logger, CancellationToken ct = default)
    {
        if (round is null) return Noop("round_not_found");

        var snapshotJson = await session.LoadJson(round.RoomId, ct);
        var snapshot = RoundSnapshot.Parse(snapshotJson);

        Resolution? candidate = null;
        string? skipReason = null;
        try
        {
            candidate = _evaluate(snapshot, roundId, _dice);
        }
        catch (Exception e) when (e is ResolveException or PhasePendingException or ArgumentException or InvalidOperationException)
        {
            skipReason = $"evaluate unavailable: {e.Message}";
        }

        if (candidate is not null)
        {
            foreach (var write in Committer.Commit(candidate).OfType<InsertSpellCast>())
                await InsertCast(session, write.Row, ct);
            if (skipReason is null && HasUnappliedShimTransforms(snapshot, roundId))
                skipReason = "unapplied roll-transform casts: the finalize shim will record transforms the candidate was not evaluated with";
        }

        var fn = bridge == Bridge.AdvanceLayer ? "advance_layer" : "finalize_layer";
        var payload = (await BridgeJson(session, fn, roundId, ct))!;

        var outcome = (string?)payload["outcome"];
        if (outcome is "brewer" or "tie")
        {
            if (candidate is null || skipReason is not null)
                logger.LogInformation(
                    "{Marker} shadow skipped: {Reason} (room {RoomId}, round {RoundId}, bridge {Bridge}, sql outcome {Outcome})",
                    SkipMarker, skipReason, round.RoomId, roundId, fn, outcome);
            else
                await DiffAgainstSql(session, round.RoomId, roundId, fn, snapshotJson, candidate, payload, logger, ct);
        }

        return payload;
    }

    private static JsonNode Noop(string reason) => new JsonObject { ["outcome"] = "noop", ["reason"] = reason };

    /// <summary>The finalize shim (forced reroll, flip, swap, chosen-pair) records roll
    /// transforms onto casts at bridge time; a cast still waiting for one means the
    /// candidate was evaluated without SQL's shim work, so comparing the two engines
    /// can only produce a false diff. SQL stays authoritative; the diff is skipped and
    /// the skip is logged — never silently ignored.</summary>
    private static bool HasUnappliedShimTransforms(RoundSnapshot snapshot, Guid roundId) =>
        snapshot.SpellCasts.Any(c => c.RoundId == roundId
            && c.EffectKind is "forced_reroll" or "roll_flip" or "roll_swap" or "roll_pair_transform"
            && (c.CastInputs is not { } ci || ci.ValueKind != JsonValueKind.Object || !ci.TryGetProperty("roll_transform", out _)));

    private static async Task InsertCast(StoreSession session, SpellCastRow row, CancellationToken ct)
    {
        const string sql = """
            insert into public.spell_casts
              (id, round_id, caster_id, card_instance_id, target_player_id, target_pending, effect_kind,
               effect_params, parent_cast_id, cast_at, reaction_window_id, negated, target_role, cast_inputs,
               redirected_to_cast_id, seized_by_cast_id, copied_cast_id, generation, source_cast_id)
            values (@id, @round_id, @caster_id, @card_instance_id, @target_player_id, @target_pending, @effect_kind,
                    @effect_params, @parent_cast_id, @cast_at, @reaction_window_id, @negated, @target_role, @cast_inputs,
                    @redirected_to_cast_id, @seized_by_cast_id, @copied_cast_id, @generation, @source_cast_id)
            """;
        // seq stays identity-assigned (the rows are inserted in Commit order, so the
        // resolver's seq ordering matches the candidate's); the flag columns ride along
        // exactly as the candidate computed them, and SQL's own idempotency guards
        // (is_copy / dice_tick + generation) make a re-run a no-op.
        await using var cmd = new NpgsqlCommand(sql, session.Connection, session.Transaction);
        cmd.Parameters.AddWithValue("id", row.Id);
        cmd.Parameters.AddWithValue("round_id", row.RoundId);
        cmd.Parameters.AddWithValue("caster_id", row.CasterId);
        cmd.Parameters.AddWithValue("card_instance_id", row.CardInstanceId);
        cmd.Parameters.AddWithValue("target_player_id", (object?)row.TargetPlayerId ?? DBNull.Value);
        cmd.Parameters.AddWithValue("target_pending", row.TargetPending);
        cmd.Parameters.AddWithValue("effect_kind", (object?)row.EffectKind ?? DBNull.Value);
        cmd.Parameters.Add(new NpgsqlParameter("effect_params", NpgsqlTypes.NpgsqlDbType.Jsonb)
            { Value = row.EffectParams is { } ep ? ep.GetRawText() : DBNull.Value });
        cmd.Parameters.AddWithValue("parent_cast_id", (object?)row.ParentCastId ?? DBNull.Value);
        cmd.Parameters.AddWithValue("cast_at", row.CastAt);
        cmd.Parameters.AddWithValue("reaction_window_id", (object?)row.ReactionWindowId ?? DBNull.Value);
        cmd.Parameters.AddWithValue("negated", row.Negated);
        cmd.Parameters.AddWithValue("target_role", (object?)row.TargetRole ?? DBNull.Value);
        cmd.Parameters.Add(new NpgsqlParameter("cast_inputs", NpgsqlTypes.NpgsqlDbType.Jsonb)
            { Value = row.CastInputs is { } ci ? ci.GetRawText() : DBNull.Value });
        cmd.Parameters.AddWithValue("redirected_to_cast_id", (object?)row.RedirectedToCastId ?? DBNull.Value);
        cmd.Parameters.AddWithValue("seized_by_cast_id", (object?)row.SeizedByCastId ?? DBNull.Value);
        cmd.Parameters.AddWithValue("copied_cast_id", (object?)row.CopiedCastId ?? DBNull.Value);
        cmd.Parameters.AddWithValue("generation", row.Generation);
        cmd.Parameters.AddWithValue("source_cast_id", (object?)row.SourceCastId ?? DBNull.Value);
        await cmd.ExecuteNonQueryAsync(ct);
    }

    private static async Task DiffAgainstSql(
        StoreSession session, Guid roomId, Guid roundId, string bridge, string snapshotJson,
        Resolution candidate, JsonNode payload, ILogger logger, CancellationToken ct)
    {
        var sql = await ReadSqlSide(session, roundId, payload, ct);
        var roster = RosterOf(candidate, sql);
        var fields = ShadowDiff.Compare(candidate, sql, roster);
        if (fields.Count == 0) return;

        // Enough context to reproduce as a golden: the raw snapshot, the normalized
        // C# resolution and SQL's jsonb, beside the ids that scope it. Error severity
        // is what fires the alert (Cloud Run error reporting); the marker greps.
        var detail = new JsonObject
        {
            ["roomId"] = roomId.ToString(),
            ["roundId"] = roundId.ToString(),
            ["bridge"] = bridge,
            ["fields"] = new JsonArray([.. fields.Select(f => (JsonNode?)f)]),
            ["snapshot"] = JsonNode.Parse(snapshotJson),
            ["csharp"] = new JsonObject
            {
                ["outcome"] = candidate.Outcome,
                ["layer"] = candidate.Layer,
                ["brewer"] = candidate.BrewerId,
                ["brewerSource"] = candidate.BrewerSource,
                ["tiedPlayerIds"] = candidate.TiedPlayerIds is null ? null : new JsonArray([.. candidate.TiedPlayerIds.OrderBy(x => x, StringComparer.Ordinal).Select(x => (JsonNode?)x)]),
                ["cupsMade"] = candidate.CupsMade,
                ["modifierGain"] = candidate.ModifierGain,
                ["trace"] = TraceNormaliser.NormaliseTrace(TraceJson.ToNode(candidate.Trace), roster),
                ["players"] = candidate.Players is null ? null : TraceNormaliser.NormaliseSummary(TraceJson.ToNode(candidate.Players), roster),
            },
            ["sql"] = new JsonObject
            {
                ["payload"] = payload.DeepClone(),
                ["resolutionTrace"] = sql.Trace?.DeepClone(),
                ["resolutionSummary"] = sql.Summary?.DeepClone(),
            },
        };
        logger.LogError(
            "{Marker} room={RoomId} round={RoundId} fields={Fields} detail={Detail}",
            DiffMarker, roomId, roundId, string.Join(",", fields), detail.ToJsonString());
    }

    private static async Task<SqlSide> ReadSqlSide(StoreSession session, Guid roundId, JsonNode payload, CancellationToken ct)
    {
        await using var cmd = new NpgsqlCommand("""
            select brewer_id, cups_made, brewer_modifier_gain, brewer_source,
                   resolution_trace::text, resolution_summary::text
              from public.rounds where id = @round
            """, session.Connection, session.Transaction);
        cmd.Parameters.Add(new NpgsqlParameter("round", NpgsqlTypes.NpgsqlDbType.Uuid) { Value = roundId });
        await using var r = await cmd.ExecuteReaderAsync(ct);
        await r.ReadAsync(ct);
        return new SqlSide(
            Layer: payload["layer"]?.GetValue<int>() ?? 0,
            Outcome: (string?)payload["outcome"] ?? "",
            BrewerId: (string?)payload["brewer_id"],
            BrewerSource: await r.IsDBNullAsync(3, ct) ? null : r.GetString(3),
            CupsMade: payload["cups_made"]?.GetValue<int>() ?? 0,
            Rolloff: payload["rolloff"]?.GetValue<bool>() ?? false,
            TiedPlayerIds: [.. (payload["tied_player_ids"] as JsonArray ?? []).Select(x => x!.GetValue<string>())],
            Trace: await r.IsDBNullAsync(4, ct) ? null : JsonNode.Parse(r.GetString(4)),
            Summary: await r.IsDBNullAsync(5, ct) ? null : JsonNode.Parse(r.GetString(5)),
            ModifierGain: r.GetInt32(2));
    }

    private static IReadOnlyDictionary<string, string> RosterOf(Resolution candidate, SqlSide sql)
    {
        var ids = new SortedSet<string>(StringComparer.Ordinal);
        if (candidate.BrewerId is { } b) ids.Add(b);
        if (sql.BrewerId is { } sb) ids.Add(sb);
        foreach (var p in candidate.TiedPlayerIds ?? []) ids.Add(p);
        foreach (var t in sql.TiedPlayerIds) ids.Add(t);
        foreach (var step in TraceJson.ToNode(candidate.Trace).Cast<JsonObject>())
            if (step["target_player"] is JsonValue { } v && v.TryGetValue<string>(out var t)) ids.Add(t);
        if (candidate.Players is { } players)
            foreach (var e in players) ids.Add(e.PlayerId);
        if (sql.Summary is { } summary)
            foreach (var e in (summary as JsonArray ?? []).OfType<JsonObject>())
                if (e["player_id"] is JsonValue { } v && v.TryGetValue<string>(out var p)) ids.Add(p);
        return ids.ToDictionary(id => id, id => id);
    }
    private static async Task<JsonNode?> BridgeJson(StoreSession session, string fn, Guid roundId, CancellationToken ct)
    {
        await using var cmd = new NpgsqlCommand($"select public.{fn}(@round)", session.Connection, session.Transaction);
        cmd.Parameters.Add(new NpgsqlParameter("round", NpgsqlTypes.NpgsqlDbType.Uuid) { Value = roundId });
        var json = await cmd.ExecuteScalarAsync(ct);
        return json is null or DBNull ? null : JsonNode.Parse((string)json);
    }
}
