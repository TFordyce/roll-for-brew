-- get_last_drip_preview(uuid) -> jsonb
--
-- Issue #470: the cast-time notice for Last Drip. Who the card would name if
-- the round resolved now -- _last_drip_target's answer, unchanged, so the
-- notice reads the same rule the resolver does. A preview of the round as it
-- stands, not a promise: a later declare-in or Roll Exemption can change it,
-- and the Trace / Recap stays the record of what happened.
--
-- null unless the caller is holding Last Drip.
--
-- Canonical source: this file is the source of truth for the function body.
-- Edit here and run `npm run build:migrations` -- do not hand-edit the
-- generated migration. See db/sql/README.md.

create or replace function public.get_last_drip_preview(p_round_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_player_id text;
begin
  v_player_id := public.current_player_id(p_round_id);

  if not exists (
    select 1 from public.spell_deck_instances sdi
    join public.spell_cards sc on sc.id = sdi.card_id
     where sdi.held_by_player = v_player_id
       and sdi.location = 'held'
       and sc.name = 'Last Drip'
  ) then
    return null;
  end if;

  return public._last_drip_target(p_round_id);
end;
$$;

revoke execute on function public.get_last_drip_preview(uuid) from public, anon;
grant execute on function public.get_last_drip_preview(uuid) to authenticated;

comment on function public.get_last_drip_preview(uuid) is
  'Issue #470: Last Drip''s cast-time notice -- _last_drip_target for the round as it stands now ({ target_player_id, reason, passed_over }), or null unless the caller holds Last Drip.';
