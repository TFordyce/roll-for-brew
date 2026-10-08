using Npgsql;
using RollForBrew.Domain.Snapshot;

namespace RollForBrew.Api.Data;

/// <summary>
/// Loads a Room's RoundSnapshot in ONE statement (one round trip): a CTE chain bounds the cross-room data to
/// the Room's Participants and returns a single jsonb document built with to_jsonb, which is the
/// snapshot's wire shape. See <see cref="RoundSnapshot"/> for the bounds.
/// </summary>
public static class RoundSnapshotLoader
{
    public static async Task<RoundSnapshot> Load(this StoreSession session, Guid roomId, CancellationToken ct = default)
    {
        await using var cmd = new NpgsqlCommand(Sql, session.Connection, session.Transaction);
        cmd.Parameters.Add(new NpgsqlParameter("room", NpgsqlTypes.NpgsqlDbType.Uuid) { Value = roomId });
        var json = (string)(await cmd.ExecuteScalarAsync(ct))!;
        return RoundSnapshot.Parse(json);
    }

    private const string Sql = """
        with room_rounds as (select id from public.rounds where room_id = @room),
        participants as (
          select distinct player_id from public.round_participants where round_id in (select id from room_rounds)
        ),
        eff as (
          select e.* from public.spell_active_effects e
           where e.room_id = @room
              or (e.target_player_id in (select player_id from participants)
                  and (e.rounds_remaining is not null
                       or e.effect_params ->> 'participated_rounds_after_cast' is not null
                       or e.effect_params ->> 'participated_rounds_from_cast' is not null))
        ),
        casts as (
          select c.* from public.spell_casts c
           where c.round_id in (select id from room_rounds)
              or c.id in (select source_cast_id from eff)
              or (c.effect_kind = 'dispel' and c.effect_params ->> 'ended_effect_id' in (select id::text from eff))
              or c.cast_inputs ->> 'courage_token_cast_id' in (select source_cast_id::text from eff)
        ),
        rnds as (
          select r.* from public.rounds r
           where r.room_id = @room
              or r.id in (select round_id from public.round_participants where player_id in (select player_id from participants))
              or r.id in (select round_id from casts)
        ),
        rms as (
          select rm.* from public.rooms rm
           where rm.id = @room or rm.id in (select room_id from rnds) or rm.id in (select room_id from eff)
        )
        select jsonb_build_object(
          'room_id', @room,
          'db_now', now(),
          'rooms', (select coalesce(jsonb_agg(to_jsonb(t) order by t.id), '[]') from rms t),
          'rounds', (select coalesce(jsonb_agg(to_jsonb(t) order by t.started_at, t.id), '[]') from rnds t),
          'round_participants', (select coalesce(jsonb_agg(to_jsonb(t) order by t.round_id, t.player_id), '[]')
              from public.round_participants t
             where t.round_id in (select id from room_rounds)
                or (t.round_id in (select id from rnds) and t.player_id in (select player_id from participants))),
          'round_layer_participants', (select coalesce(jsonb_agg(to_jsonb(t) order by t.round_id, t.layer, t.player_id), '[]')
              from public.round_layer_participants t where t.round_id in (select id from room_rounds)),
          'rolls', (select coalesce(jsonb_agg(to_jsonb(t) order by t.round_id, t.layer, t.player_id), '[]')
              from public.rolls t where t.round_id in (select id from room_rounds)),
          'spell_casts', (select coalesce(jsonb_agg(to_jsonb(t) order by t.seq), '[]') from casts t),
          'active_effects', (select coalesce(jsonb_agg(to_jsonb(t) order by t.created_at, t.id), '[]') from eff t),
          'deck_instances', (select coalesce(jsonb_agg(to_jsonb(t) order by t.id), '[]')
              from public.spell_deck_instances t
             where t.held_by_player in (select player_id from participants)
                or t.id in (select card_instance_id from casts)),
          'spell_cards', (select coalesce(jsonb_agg(to_jsonb(t) order by t.id), '[]') from public.spell_cards t),
          'spell_card_effects', (select coalesce(jsonb_agg(to_jsonb(t) order by t.id), '[]') from public.spell_card_effects t),
          'room_players', (select coalesce(jsonb_agg(to_jsonb(t) order by t.player_id), '[]')
              from public.room_players t where t.room_id = @room),
          'modifier_adjustments', (select coalesce(jsonb_agg(to_jsonb(t) order by t.created_at, t.id), '[]')
              from public.modifier_adjustments t where t.room_id = @room)
        )::text
        """;
}
