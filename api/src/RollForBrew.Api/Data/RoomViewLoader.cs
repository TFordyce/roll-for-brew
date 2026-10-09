using System.Text.Json;
using Npgsql;
using NpgsqlTypes;
using RollForBrew.Domain.RoomView;
using RollForBrew.Domain.Snapshot;

namespace RollForBrew.Api.Data;

public static class RoomViewLoader
{
    public static async Task<RoomViewInput?> LoadView(this StoreSession session, Guid roomId, CancellationToken ct = default)
    {
        var snapshot = await session.Load(roomId, ct);
        var room = snapshot.Rooms.SingleOrDefault(r => r.Id == roomId);
        if (room is null) return null;

        var viewer = await session.CurrentPlayerId(roomId: roomId, ct: ct);

        var active = snapshot.Rounds.SingleOrDefault(r => r.RoomId == roomId && (r.Status == "open" || r.Status == "closed"));
        var extras = await ReadJson<ViewExtras>(session, Extras, ct,
            ("room", NpgsqlDbType.Uuid, roomId), ("me", NpgsqlDbType.Text, viewer));
        var reads = await ReadJson<ViewerReads>(session, Bridges, ct,
            ("room", NpgsqlDbType.Uuid, roomId),
            ("me", NpgsqlDbType.Text, viewer),
            ("round", NpgsqlDbType.Uuid, active?.Id),
            ("closed", NpgsqlDbType.Boolean, active?.Status == "closed"),
            ("layer", NpgsqlDbType.Integer, active?.CurrentLayer ?? 0));

        return new RoomViewInput(snapshot, room.Version, viewer, extras, reads);
    }

    private static async Task<T> ReadJson<T>(StoreSession session, string sql, CancellationToken ct,
        params (string Name, NpgsqlDbType Type, object? Value)[] args)
    {
        await using var cmd = new NpgsqlCommand(sql, session.Connection, session.Transaction);
        foreach (var (name, type, value) in args)
            cmd.Parameters.Add(new NpgsqlParameter(name, type) { Value = value ?? DBNull.Value });
        var json = (string)(await cmd.ExecuteScalarAsync(ct))!;
        return JsonSerializer.Deserialize<T>(json, RoundSnapshot.Json) ?? throw new InvalidDataException("empty view read");
    }

    private const string Extras = """
        with room_rounds as (select id, brewer_id from public.rounds where room_id = @room),
        order_round as (
          select coalesce(
            (select id from public.rounds where room_id = @room and status in ('open', 'closed')),
            (select id from public.rounds where room_id = @room and status = 'resolved' order by resolved_at desc limit 1)
          ) as id
        ),
        replay as (
          select round_id, caster_id, created_at from public.pending_round_replay
           where room_id = @room order by created_at limit 1
        ),
        rateable as (
          select r.id as round_id, r.room_id, r.resolved_at, r.brewer_id
            from public.rounds r
            join public.round_participants rp on rp.round_id = r.id and rp.player_id = @me
           where r.status = 'resolved' and r.brewer_id <> @me
           order by r.resolved_at desc limit 1
        ),
        rateable_open as (
          select * from rateable ra
           where not exists (select 1 from public.rounds n
                              where n.room_id = ra.room_id and n.status = 'resolved' and n.resolved_at > ra.resolved_at)
        ),
        wanted as (
          select player_id as id from public.room_players where room_id = @room
          union select player_id from public.round_participants where round_id in (select id from room_rounds)
          union select brewer_id from room_rounds where brewer_id is not null
          union select caster_id from replay
        )
        select jsonb_build_object(
          'players', (select coalesce(jsonb_agg(jsonb_build_object(
                'id', p.id, 'display_name', p.display_name, 'email', p.email, 'avatar_url', p.avatar_url, 'is_test', p.is_test)
                order by p.id), '[]')
              from public.players p where p.id in (select id from wanted)),
          'my_order_for_round', (select o.drink_type from public.orders o
                                  where o.round_id = (select id from order_round) and o.player_id = @me),
          'my_most_recent_order', (select o.drink_type from public.orders o
                                    where o.player_id = @me order by o.updated_at desc limit 1),
          'menu', (select coalesce(jsonb_agg(jsonb_build_object(
                'player_id', m.player_id, 'drink_type', m.drink_type, 'milk', m.milk, 'sugar', m.sugar,
                'decaf', m.decaf, 'no_preference_set', m.no_preference_set) order by m.player_id), '[]')
              from public.round_menu m where m.round_id = (select id from order_round)),
          'rateable', (select jsonb_build_object(
                'round_id', ro.round_id, 'brewer_display_name', b.display_name, 'brewer_email', b.email,
                'resolved_at', ro.resolved_at,
                'my_score', (select br.score from public.brew_ratings br where br.round_id = ro.round_id and br.rater_player_id = @me))
              from rateable_open ro left join public.players b on b.id = ro.brewer_id),
          'roll_input_mode', (select roll_input_mode from public.player_settings where player_id = @me),
          'pending_replay', (select to_jsonb(r) from replay r)
        )::text
        """;

    private const string Bridges = """
        select jsonb_build_object(
          'held_cards', coalesce((select jsonb_agg(to_jsonb(t)) from public.get_my_spell_cards(@room) t), '[]'),
          'pending_spell_draw', (select to_jsonb(t) from public.get_my_pending_spell_draw() t limit 1),
          'effect_badges', coalesce((select jsonb_agg(to_jsonb(t)) from public.get_room_active_effects(@room) t), '[]'),
          'pending_dice', case when @round is null then '[]'::jsonb
              else coalesce((select jsonb_agg(to_jsonb(t)) from public.get_my_pending_spell_dice(@round) t), '[]') end,
          'dispellable', case when @round is null then '[]'::jsonb
              else coalesce((select jsonb_agg(to_jsonb(t)) from public.get_dispellable_active_effects(@round) t), '[]') end,
          'heist_target_ids', case when @round is null then '[]'::jsonb
              else coalesce((select jsonb_agg(h) from public.get_heist_targets(@round) h), '[]') end,
          'last_drip_preview', case when @round is null then null
              else public.get_last_drip_preview(@round) end,
          'pending_casts', case when @round is null or not @closed then '[]'::jsonb
              else coalesce((select jsonb_agg(to_jsonb(t)) from public.get_my_pending_casts(@round) t), '[]') end,
          'compelled_cast', case when @round is null or not @closed then null
              else (select to_jsonb(t) from public.get_my_compelled_cast(@round) t limit 1) end,
          'compelled_step', case when @round is null or not @closed then null
              else (select to_jsonb(t) from public.get_compelled_cast_step(@round) t limit 1) end,
          'revolt_picker_id', case when @round is null or not @closed then null
              else to_jsonb(public.get_tea_party_revolt_picker(@round)) end,
          'reaction_window', case when @round is null or not @closed then null
              else (select to_jsonb(t) from public.get_open_reaction_window(@round) t limit 1) end,
          'reaction_stack', case when @round is null or not @closed then '[]'::jsonb
              else coalesce((select jsonb_agg(to_jsonb(t) order by t.seq) from public.get_reaction_stack(@round) t), '[]') end,
          'reaction_pending_players', case when @round is null or not @closed then '[]'::jsonb
              else coalesce((select jsonb_agg(to_jsonb(t)) from public.get_reaction_window_pending_players(@round) t), '[]') end,
          'skip_vote', case when @round is null or not @closed then null
              else (select to_jsonb(t) from public.get_reaction_window_skip_vote(@round) t limit 1) end,
          'courage_tokens', case when @round is null or not @closed then '[]'::jsonb
              else coalesce((select jsonb_agg(to_jsonb(t)) from public.get_my_courage_tokens(@round) t), '[]') end,
          'expected_roller_ids', case when @round is null or not @closed then '[]'::jsonb
              else coalesce((select jsonb_agg(t.player_id) from public.get_expected_layer_roller_ids(@round, @layer) t), '[]') end,
          'layer_zero_window_closed_at', case when @round is null or not @closed or @layer <> 0 then null
              else to_jsonb(public.get_layer_zero_window_closed_at(@round)) end
        )::text
        """;
}
