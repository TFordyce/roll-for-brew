-- Issue #541 (spec #533, slice 1 exit 4): retire the SQL path the room page used before room_view went live.
--
-- * get_room_pending_round_replay: the old page's only reader of the room's pending Round replay. The C#
--   room view reads the pending_round_replay table itself, so nothing calls it. (The other get_* reads the old
--   page used stay: RoomViewLoader still calls them, and C# may call SQL.)
-- * the room_view port_flags row: the page now always renders from the API, so the switch has nothing to switch.
--
-- Hand-authored (ADR 0006: only function definitions are generated).

drop function if exists public.get_room_pending_round_replay(uuid);

delete from public.port_flags where slice = 'room_view';
