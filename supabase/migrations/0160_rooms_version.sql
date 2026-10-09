-- Room view (spec #533 / issue #538, ADR 0011): `rooms.version` and the read bridges.
--
-- rooms.version is the monotonic stamp the room view and every `room-changed { version }` broadcast
-- carry. API writes bump it inside their own transaction (a later slice); this migration only adds
-- the column. Additive: default 0, existing rows read as 0.
alter table public.rooms add column version bigint not null default 0;

-- Read bridges. GET /rooms/{id}/view calls these still-SQL read functions as the effective player
-- (the claims GUC is set per transaction, so current_player_id() resolves Acting As inside them).
-- The repo revokes PUBLIC execute, so rfb_api needs an explicit grant on each one. Revoke it here
-- again as each function is ported to C#. Listed in docs/port/room-view-bridges.md.
do $$
declare
  fn record;
begin
  for fn in
    select p.oid::regprocedure as sig
      from pg_proc p
      join pg_namespace n on n.oid = p.pronamespace
     where n.nspname = 'public'
       and p.proname in (
         'get_my_spell_cards',
         'get_my_pending_spell_draw',
         'get_my_pending_casts',
         'get_my_pending_spell_dice',
         'get_my_compelled_cast',
         'get_compelled_cast_step',
         'get_tea_party_revolt_picker',
         'get_dispellable_active_effects',
         'get_heist_targets',
         'get_last_drip_preview',
         'get_open_reaction_window',
         'get_reaction_stack',
         'get_reaction_window_pending_players',
         'get_reaction_window_skip_vote',
         'get_my_courage_tokens',
         'get_expected_layer_roller_ids',
         'get_layer_zero_window_closed_at',
         'get_room_active_effects'
       )
  loop
    execute format('grant execute on function %s to rfb_api', fn.sig);
  end loop;
end
$$;
