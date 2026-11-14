using Npgsql;
using NpgsqlTypes;
using RollForBrew.Domain.Resolver;
using RollForBrew.Domain.Snapshot;

namespace RollForBrew.Api.Data;

/// <summary>The dumb persister (ADR 0010): one statement per <see cref="Write"/> case, no
/// decisions. Every statement writes the rows and shapes the SQL path also reads, so turning
/// the authority flag off mid-round stays safe.</summary>
internal static class WritePersister
{
    public static Task Apply(StoreSession s, Write write, CancellationToken ct) => write switch
    {
        InsertSpellCast w => InsertCast(s, w.Row, ct),
        UpdateCastFlags w => Run(s, """
            update public.spell_casts
               set negated = @negated, redirected_to_cast_id = @redirected, seized_by_cast_id = @seized,
                   copied_cast_id = @copied, target_player_id = @target, target_role = @role, target_pending = @pending,
                   cast_inputs = case when @kept then coalesce(cast_inputs, '{}'::jsonb) || '{"seized_kept": true}'::jsonb else cast_inputs end
             where id = @id
            """, ct, ("id", w.Flags.CastId), ("negated", w.Flags.Negated), ("redirected", w.Flags.RedirectedToCastId),
            ("seized", w.Flags.SeizedByCastId), ("copied", w.Flags.CopiedCastId), ("target", w.Flags.TargetPlayerId),
            ("role", w.Flags.TargetRole), ("pending", w.Flags.TargetPending), ("kept", w.Flags.SeizedKept)),
        SetRoomPlayerModifier w => Run(s,
            "update public.room_players set modifier = @value where room_id = @room and player_id = @player",
            ct, ("room", w.RoomId), ("player", w.PlayerId), ("value", w.Value)),
        SetRoundTraceAndSummary w => RunJson(s,
            "update public.rounds set resolution_trace = @trace, resolution_summary = @summary where id = @round",
            ct, [("trace", w.TraceJson), ("summary", w.SummaryJson)], ("round", w.RoundId)),
        SetRoundResolution w => Run(s, """
            update public.rounds
               set status = 'resolved', brewer_id = @brewer, cups_made = @cups, brewer_modifier_gain = @gain, resolved_at = @at
             where id = @round
            """, ct, ("round", w.RoundId), ("brewer", w.BrewerId), ("cups", w.CupsMade), ("gain", w.BrewerModifierGain), ("at", w.ResolvedAt)),
        IncrementRoomPlayerModifier w => Run(s,
            "update public.room_players set modifier = modifier + @delta where room_id = @room and player_id = @player",
            ct, ("room", w.RoomId), ("player", w.PlayerId), ("delta", w.Delta)),
        // Moves only while the victim still holds the card, and stamps the cast only if it moved.
        MoveHeistCard w => Run(s, """
            with moved as (
              update public.spell_deck_instances
                 set location = @location, held_by_player = @thief
               where id = @instance and location = 'held' and held_by_player = @victim
              returning id
            )
            update public.spell_casts
               set cast_inputs = cast_inputs || '{"heist_moved": true}'::jsonb
             where id = @cast and exists (select 1 from moved)
            """, ct, ("cast", w.CastId), ("instance", w.InstanceId), ("location", w.Location), ("thief", w.ThiefPlayerId), ("victim", w.VictimPlayerId)),
        // A new title row hanging off the override cast, so a Round Replay scrap removes it.
        TransferEarlTitle w => Run(s, """
            insert into public.spell_active_effects (
              id, room_id, target_player_id, caster_id, source_cast_id, card_id, effect_kind, effect_params, rounds_remaining
            )
            select @new_id, (select room_id from public.rounds where id = @round), @to, @to, @cast, old.card_id, 'brewer_immunity',
                   jsonb_build_object('mode', 'earl', 'persist', true, 'transferred_from_effect_id', old.id), null
              from public.spell_active_effects old
             where old.id = @old_id
               and not exists (
                 select 1 from public.spell_active_effects dup
                  where dup.source_cast_id = @cast and dup.effect_kind = 'brewer_immunity'
               )
            """, ct, ("new_id", w.ToEffectId), ("round", w.RoundId), ("to", w.ToPlayerId), ("cast", w.CastId), ("old_id", w.FromEffectId)),
        EndEarlTitles w => EndTitles(s, w, ct),
        SetBrewerSource w => Run(s,
            "update public.rounds set brewer_source = @source, brewer_source_cast_id = @cast where id = @round",
            ct, ("round", w.RoundId), ("source", w.Source), ("cast", w.CastId)),
        RecordPendingReplay w => Run(s, """
            insert into public.pending_round_replay (round_id, room_id, caster_id)
            values (@round, @room, @caster)
            on conflict (round_id) do nothing
            """, ct, ("round", w.RoundId), ("room", w.RoomId), ("caster", w.CasterId)),
        AdvanceTieLayer w => AdvanceTie(s, w, ct),
        SetRollValue w => Run(s,
            "update public.rolls set value = @value where round_id = @round and layer = @layer and player_id = @player",
            ct, ("round", w.RoundId), ("layer", w.Layer), ("player", w.PlayerId), ("value", w.Value)),
        SetCastRollTransform w => RunJson(s,
            "update public.spell_casts set cast_inputs = coalesce(cast_inputs, '{}'::jsonb) || jsonb_build_object('roll_transform', @transform) where id = @cast",
            ct, [("transform", w.RollTransformJson)], ("cast", w.CastId)),
        Bridge w => CallBridge(s, w, ct),
        // Round lifecycle (#550): the statements the SQL functions ran.
        InsertRoundParticipant w => Run(s,
            "insert into public.round_participants (round_id, player_id) values (@round, @player) on conflict (round_id, player_id) do nothing",
            ct, ("round", w.RoundId), ("player", w.PlayerId)),
        DeleteRoundParticipant w => Run(s,
            "delete from public.round_participants where round_id = @round and player_id = @player",
            ct, ("round", w.RoundId), ("player", w.PlayerId)),
        CloseRound w => Run(s, "update public.rounds set status = 'closed', closed_at = now() where id = @round", ct, ("round", w.RoundId)),
        CancelRound w => Run(s, "update public.rounds set status = 'cancelled' where id = @round and status in ('open', 'closed')", ct, ("round", w.RoundId)),
        ExcludeParticipant { Layer: 0 } w => Run(s,
            "update public.round_participants set excluded_at = now() where round_id = @round and player_id = @player and excluded_at is null",
            ct, ("round", w.RoundId), ("player", w.PlayerId)),
        ExcludeParticipant w => Run(s, """
            update public.round_layer_participants set excluded_at = now()
             where round_id = @round and layer = @layer and player_id = @player and excluded_at is null
            """, ct, ("round", w.RoundId), ("layer", w.Layer), ("player", w.PlayerId)),
        MarkReplayKept w => Run(s, """
            update public.spell_casts
               set cast_inputs = coalesce(cast_inputs, '{}'::jsonb) || '{"scrapped": false}'::jsonb
             where round_id = @round and effect_kind = 'round_replay'
            """, ct, ("round", w.RoundId)),
        ClearPendingReplay w => Run(s, "delete from public.pending_round_replay where round_id = @round", ct, ("round", w.RoundId)),
        // Roll submission (#551).
        InsertRoll w => Run(s, """
            insert into public.rolls (round_id, player_id, layer, value, input_mode, modifier_snapshot, discarded_value, entered_by_admin)
            values (@round, @player, @layer, @value, @mode, @modifier, @discarded, @admin)
            """, ct, ("round", w.RoundId), ("player", w.PlayerId), ("layer", w.Layer), ("value", w.Value), ("mode", w.InputMode),
            ("modifier", w.ModifierSnapshot), ("discarded", w.DiscardedValue), ("admin", w.EnteredByAdmin)),
        EnsureRoomPlayer w => Run(s,
            "insert into public.room_players (room_id, player_id) values (@room, @player) on conflict (room_id, player_id) do nothing",
            ct, ("room", w.RoomId), ("player", w.PlayerId)),
        // One statement so the recipient is chosen once: the hook spends a Marked for Brew mark when it fires.
        RecordCritDraw w => Run(s, """
            with recipient as (select public._apply_crit_redirect(@round, @player) as id)
            insert into public.pending_spell_draws (round_id, player_id, trigger)
            select @round, id, @trigger from recipient where id is not null
            on conflict (round_id, player_id) do nothing
            """, ct, ("round", w.RoundId), ("player", w.PlayerId), ("trigger", w.Trigger)),
        _ => throw new NotSupportedException($"no statement for write {write.GetType().Name}"),
    };

    public static async Task InsertCast(StoreSession session, SpellCastRow row, CancellationToken ct)
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
        // seq stays identity-assigned: rows go in Commit order, so the resolver's seq order holds.
        await using var cmd = new NpgsqlCommand(sql, session.Connection, session.Transaction);
        cmd.Parameters.AddWithValue("id", row.Id);
        cmd.Parameters.AddWithValue("round_id", row.RoundId);
        cmd.Parameters.AddWithValue("caster_id", row.CasterId);
        cmd.Parameters.AddWithValue("card_instance_id", row.CardInstanceId);
        cmd.Parameters.AddWithValue("target_player_id", (object?)row.TargetPlayerId ?? DBNull.Value);
        cmd.Parameters.AddWithValue("target_pending", row.TargetPending);
        cmd.Parameters.AddWithValue("effect_kind", (object?)row.EffectKind ?? DBNull.Value);
        cmd.Parameters.Add(new NpgsqlParameter("effect_params", NpgsqlDbType.Jsonb)
            { Value = row.EffectParams is { } ep ? ep.GetRawText() : DBNull.Value });
        cmd.Parameters.AddWithValue("parent_cast_id", (object?)row.ParentCastId ?? DBNull.Value);
        cmd.Parameters.AddWithValue("cast_at", row.CastAt);
        cmd.Parameters.AddWithValue("reaction_window_id", (object?)row.ReactionWindowId ?? DBNull.Value);
        cmd.Parameters.AddWithValue("negated", row.Negated);
        cmd.Parameters.AddWithValue("target_role", (object?)row.TargetRole ?? DBNull.Value);
        cmd.Parameters.Add(new NpgsqlParameter("cast_inputs", NpgsqlDbType.Jsonb)
            { Value = row.CastInputs is { } ci ? ci.GetRawText() : DBNull.Value });
        cmd.Parameters.AddWithValue("redirected_to_cast_id", (object?)row.RedirectedToCastId ?? DBNull.Value);
        cmd.Parameters.AddWithValue("seized_by_cast_id", (object?)row.SeizedByCastId ?? DBNull.Value);
        cmd.Parameters.AddWithValue("copied_cast_id", (object?)row.CopiedCastId ?? DBNull.Value);
        cmd.Parameters.AddWithValue("generation", row.Generation);
        cmd.Parameters.AddWithValue("source_cast_id", (object?)row.SourceCastId ?? DBNull.Value);
        await cmd.ExecuteNonQueryAsync(ct);
    }

    private static async Task EndTitles(StoreSession s, EndEarlTitles w, CancellationToken ct)
    {
        await using var cmd = new NpgsqlCommand(
            "update public.spell_active_effects set ended_in_round_id = @round where id = any(@ids)", s.Connection, s.Transaction);
        cmd.Parameters.AddWithValue("round", w.RoundId);
        cmd.Parameters.Add(new NpgsqlParameter("ids", NpgsqlDbType.Array | NpgsqlDbType.Uuid) { Value = w.EffectIds.ToArray() });
        await cmd.ExecuteNonQueryAsync(ct);
    }

    private static async Task AdvanceTie(StoreSession s, AdvanceTieLayer w, CancellationToken ct)
    {
        await using var cmd = new NpgsqlCommand("""
            with next as (
              update public.rounds set current_layer = current_layer + 1 where id = @round returning current_layer
            )
            insert into public.round_layer_participants (round_id, layer, player_id)
            select @round, next.current_layer, tied.player_id
              from next cross join unnest(@tied::text[]) as tied(player_id)
            on conflict do nothing
            """, s.Connection, s.Transaction);
        cmd.Parameters.AddWithValue("round", w.RoundId);
        cmd.Parameters.AddWithValue("tied", w.TiedPlayerIds.ToArray());
        await cmd.ExecuteNonQueryAsync(ct);
    }

    private static async Task CallBridge(StoreSession s, Bridge w, CancellationToken ct)
    {
        var args = string.Join(", ", w.Args.Select((_, i) => $"@a{i}"));
        await using var cmd = new NpgsqlCommand($"select public.{w.Function}({args})", s.Connection, s.Transaction);
        for (var i = 0; i < w.Args.Length; i++) cmd.Parameters.AddWithValue($"a{i}", w.Args[i]);
        await cmd.ExecuteNonQueryAsync(ct);
    }

    private static Task Run(StoreSession s, string sql, CancellationToken ct, params (string Name, object? Value)[] args) =>
        RunJson(s, sql, ct, [], args);

    private static async Task RunJson(
        StoreSession s, string sql, CancellationToken ct, (string Name, string Json)[] json, params (string Name, object? Value)[] args)
    {
        await using var cmd = new NpgsqlCommand(sql, s.Connection, s.Transaction);
        foreach (var (name, value) in json)
            cmd.Parameters.Add(new NpgsqlParameter(name, NpgsqlDbType.Jsonb) { Value = value });
        foreach (var (name, value) in args)
            cmd.Parameters.AddWithValue(name, value ?? DBNull.Value);
        await cmd.ExecuteNonQueryAsync(ct);
    }
}
