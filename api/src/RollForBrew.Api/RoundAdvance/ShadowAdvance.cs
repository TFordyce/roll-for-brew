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
/// The pre-writes are bridge fuel, not state: when the bridge outcome turns out not
/// to finalize anything, they are deleted again inside the same transaction, so the
/// next (finalizing) call re-runs <c>Evaluate</c> on the post-window snapshot and
/// pre-writes fresh. Diffs are logged at Error with everything needed to reproduce
/// them as a golden; skips log at Warning with the cause attached, so they survive
/// Cloud Run's default severity filter. Neither is ever served — the caller gets
/// SQL's payload unchanged.
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
        StoreSession session, RoundLock? round, Bridge bridge, ILogger logger, CancellationToken ct = default)
    {
        if (round is null) return Noop("round_not_found");
        var roundId = round.RoundId;

        var snapshotJson = await session.LoadJson(round.RoomId, ct);
        var snapshot = RoundSnapshot.Parse(snapshotJson);

        Resolution? candidate = null;
        string? skipReason = null;
        Exception? skipCause = null;
        try
        {
            candidate = _evaluate(snapshot, roundId, _dice);
        }
        catch (Exception e) when (e is ResolveException or PhasePendingException or ArgumentException or InvalidOperationException)
        {
            skipCause = e;
            skipReason = $"evaluate unavailable: {e.Message}";
        }

        var prewritten = new List<Guid>();
        if (candidate is not null)
        {
            foreach (var write in Committer.Commit(candidate).OfType<InsertSpellCast>())
            {
                // A warded tick's roll is never applied (the walk collapses it to
                // <rng>), so SQL needs no replay — and pre-writing it would suppress
                // SQL's own synthesis, whose warded step the candidate's trace does
                // carry. Leave warded ticks to SQL so both traces keep both steps.
                if (write.Row.EffectKind == "per_round_dice_tick" && write.Row.Negated) continue;
                await InsertCast(session, write.Row, ct);
                prewritten.Add(write.Row.Id);
            }
            if (skipReason is null && HasUnappliedShimTransforms(snapshot, roundId))
                skipReason = "unapplied roll-transform casts: the finalize shim will record transforms the candidate was not evaluated with";
        }

        var fn = bridge == Bridge.AdvanceLayer ? "advance_layer" : "finalize_layer";
        var payload = (await BridgeJson(session, fn, roundId, ct))!;

        var finalization = FinalizationOf(payload);
        if (finalization is null && prewritten.Count > 0)
            await DeleteCasts(session, prewritten, ct);

        if (finalization is not null)
        {
            // Warning, not Information: Cloud Run's default severity filter drops
            // Information entirely, and an invisible skip is how the die-replay
            // degradation hid through a whole capture attempt. The caught evaluate
            // exception rides along so the production log carries its stack.
            if (candidate is null || skipReason is not null)
                logger.LogWarning(skipCause,
                    "{Marker} shadow skipped: {Reason} (room {RoomId}, round {RoundId}, bridge {Bridge}, sql outcome {Outcome})",
                    SkipMarker, skipReason, round.RoomId, roundId, fn, (string?)finalization["outcome"]);
            else
                await DiffAgainstSql(session, round.RoomId, roundId, fn, snapshotJson, candidate, finalization, logger, ct);
        }

        return payload;
    }

    private static JsonNode Noop(string reason) => new JsonObject { ["outcome"] = "noop", ["reason"] = reason };

    /// <summary>The finalization a bridge outcome commits, or null when it commits
    /// none: <c>brewer</c>/<c>tie</c> at the top level, or <c>advance_layer</c>'s
    /// nested <c>finalization</c> block when the window opened and closed on the spot
    /// (nobody eligible to react, so no player could cast into it — the candidate
    /// evaluated the same state SQL resolves). A noop, or a window that stays open,
    /// finalizes nothing and the pre-writes must not survive it.</summary>
    private static JsonNode? FinalizationOf(JsonNode payload)
    {
        var block = (string?)payload["outcome"] == "windowOpened" ? payload["finalization"] : payload;
        return (string?)block?["outcome"] is "brewer" or "tie" ? block : null;
    }

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

    /// <summary>Removes the pre-writes by the exact ids they were inserted with,
    /// inside the bridge's transaction: a non-finalizing outcome must leave nothing
    /// synthesized behind (a tick frozen mid-window would dodge a ward cast as a
    /// reaction, and both engines would end up reusing the shadow's own rows).</summary>
    private static async Task DeleteCasts(StoreSession session, IReadOnlyList<Guid> ids, CancellationToken ct)
    {
        await using var cmd = new NpgsqlCommand(
            "delete from public.spell_casts where id = any(@ids)", session.Connection, session.Transaction);
        cmd.Parameters.Add(new NpgsqlParameter("ids", NpgsqlTypes.NpgsqlDbType.Array | NpgsqlTypes.NpgsqlDbType.Uuid)
            { Value = ids.ToArray() });
        await cmd.ExecuteNonQueryAsync(ct);
    }

    private static async Task DiffAgainstSql(
        StoreSession session, Guid roomId, Guid roundId, string bridge, string snapshotJson,
        Resolution candidate, JsonNode finalization, ILogger logger, CancellationToken ct)
    {
        var sql = await ReadSqlSide(session, roundId, finalization, ct);
        var roster = IdsAsRoster(candidate, sql);
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
                ["payload"] = finalization.DeepClone(),
                ["resolutionTrace"] = sql.Trace?.DeepClone(),
                ["resolutionSummary"] = sql.Summary?.DeepClone(),
            },
        };
        logger.LogError(
            "{Marker} room={RoomId} round={RoundId} fields={Fields} detail={Detail}",
            DiffMarker, roomId, roundId, string.Join(",", fields), detail.ToJsonString());
    }

    /// <summary>Maps a finalization outcome block — the payload's top level, or
    /// <c>advance_layer</c>'s nested <c>finalization</c> — the same way either way;
    /// the resolution columns (<c>brewer_source</c>, modifier gain, trace, summary)
    /// come off the rounds row both blocks committed.</summary>
    private static async Task<SqlSide> ReadSqlSide(StoreSession session, Guid roundId, JsonNode outcome, CancellationToken ct)
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
            Layer: outcome["layer"]?.GetValue<int>() ?? 0,
            Outcome: (string?)outcome["outcome"] ?? "",
            BrewerId: (string?)outcome["brewer_id"],
            BrewerSource: await r.IsDBNullAsync(3, ct) ? null : r.GetString(3),
            CupsMade: outcome["cups_made"]?.GetValue<int>() ?? 0,
            Rolloff: outcome["rolloff"]?.GetValue<bool>() ?? false,
            TiedPlayerIds: [.. (outcome["tied_player_ids"] as JsonArray ?? []).Select(x => x!.GetValue<string>())],
            Trace: await r.IsDBNullAsync(4, ct) ? null : JsonNode.Parse(r.GetString(4)),
            Summary: await r.IsDBNullAsync(5, ct) ? null : JsonNode.Parse(r.GetString(5)),
            ModifierGain: r.GetInt32(2));
    }

    /// <summary>The ids the diff can name, each mapped to itself — the roster shape
    /// <see cref="TraceNormaliser"/> wants (ids absent from it become stable aliases).</summary>
    private static IReadOnlyDictionary<string, string> IdsAsRoster(Resolution candidate, SqlSide sql)
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
