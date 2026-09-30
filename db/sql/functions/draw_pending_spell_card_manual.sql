-- draw_pending_spell_card_manual(uuid, uuid) -> table (instance_id uuid, needs_swap_decision boolean)
--
-- "I drew this IRL" against the caller's pending_spell_draws row: claims a
-- named card from the deck (0036; forced nat-1 swap from 0070). Placement is
-- _land_drawn_instance's (issue #435) -- verbatim from migration 0070
-- otherwise.
--
-- Canonical source: this file is the source of truth for the function body.
-- Edit here and run `npm run build:migrations` -- do not hand-edit the
-- generated migration. See db/sql/README.md.

create or replace function public.draw_pending_spell_card_manual(p_round_id uuid, p_card_id uuid)
returns table (instance_id uuid, needs_swap_decision boolean)
language plpgsql
security definer
set search_path = public
as $$
declare
  v_player_id text;
  v_trigger text;
  v_new_instance_id uuid;
begin
  v_player_id := public.current_player_id(p_round_id);

  select trigger into v_trigger
    from public.pending_spell_draws
   where round_id = p_round_id and player_id = v_player_id;

  if v_trigger is null then
    raise exception 'draw_pending_spell_card_manual: caller has no pending spell draw for this round';
  end if;

  if exists (
    select 1 from public.spell_deck_instances
     where held_by_player = v_player_id and location = 'pending_swap'
  ) then
    raise exception 'draw_pending_spell_card_manual: caller already has a pending keep-or-swap decision';
  end if;

  select id into v_new_instance_id
    from public.spell_deck_instances
   where card_id = p_card_id and location = 'in_deck'
     for update skip locked;

  if v_new_instance_id is null then
    raise exception 'draw_pending_spell_card_manual: that card is not currently in the deck'
      using errcode = 'RFB06';
  end if;

  delete from public.pending_spell_draws where round_id = p_round_id and player_id = v_player_id;

  needs_swap_decision := public._land_drawn_instance(v_player_id, v_new_instance_id, v_trigger);
  instance_id := v_new_instance_id;
  return next;
end;
$$;

revoke execute on function public.draw_pending_spell_card_manual(uuid, uuid) from public, anon;
grant execute on function public.draw_pending_spell_card_manual(uuid, uuid) to authenticated;

comment on function public.draw_pending_spell_card_manual(uuid, uuid) is
  'Raises RFB06 when the claimed card has no currently-in-deck instance — a physical/digital desync the table needs to reconcile. The pending draw row is left in place so the player can retry.';
