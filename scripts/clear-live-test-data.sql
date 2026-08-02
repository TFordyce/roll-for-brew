-- Clears out game/session data accumulated while testing in the live DB.
-- Keeps public.whitelist, public.players, and the public.spell_cards catalog intact.
--
-- Run this in the Supabase SQL editor against the LIVE project.
-- It's wrapped in a transaction so you can inspect the row counts below
-- before deciding whether to COMMIT.

begin;

-- Sanity check: see what's about to be wiped before committing.
select 'rooms' as table_name, count(*) from public.rooms
union all select 'room_players', count(*) from public.room_players
union all select 'rounds', count(*) from public.rounds
union all select 'round_participants', count(*) from public.round_participants
union all select 'round_layer_participants', count(*) from public.round_layer_participants
union all select 'rolls', count(*) from public.rolls
union all select 'player_settings', count(*) from public.player_settings
union all select 'spell_deck_instances', count(*) from public.spell_deck_instances
union all select 'spell_draws', count(*) from public.spell_draws
union all select 'spell_casts', count(*) from public.spell_casts
union all select 'spell_active_effects', count(*) from public.spell_active_effects
union all select 'spell_reaction_windows', count(*) from public.spell_reaction_windows
union all select 'spell_reaction_passes', count(*) from public.spell_reaction_passes
union all select 'admin_acting_as', count(*) from public.admin_acting_as;

truncate table
  public.rooms,
  public.room_players,
  public.rounds,
  public.round_participants,
  public.round_layer_participants,
  public.rolls,
  public.player_settings,
  public.spell_deck_instances,
  public.spell_draws,
  public.spell_casts,
  public.spell_active_effects,
  public.spell_reaction_windows,
  public.spell_reaction_passes,
  public.admin_acting_as
cascade;

-- Review the row counts above, then either:
commit;
-- or, if something looks wrong:
-- rollback;
