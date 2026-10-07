-- admin_allocate_spell_card(uuid, text, text)
--   -> table(instance_id uuid, recipient_player_id text, draw_redirect_outcome text)
--
-- Admin spell card allocation (issue #154, migration 0047): assigns a catalog
-- card to a real player as "held", with a spell_draws row (trigger =
-- 'admin_allocation') so the Spell Collection page counts it as discovered.
-- Blocks rather than auto-reassigns: RFB07 when the card is already held by
-- someone, RFB08 when the recipient already holds / is mid-swap on a card.
--
-- Issue #471: an admin allocation is not a draw, so it bypasses a live
-- Stale Biscuit (`next_draw` Draw Redirect) mark -- but never silently. With
-- a live mark on the target (_lock_next_draw_mark) and no p_mark_choice it
-- raises RFB57 (beneficiary's name in the message, id in the detail), and
-- the admin re-submits with:
--   * 'target'      -- allocate to the target anyway; the mark stays live.
--   * 'beneficiary' -- the card lands where the mark sends it, as a draw
--     would (_land_drawn_instance): the beneficiary's free hand slot (held,
--     or pending_swap for a keep-or-swap choice), and the mark is spent. A
--     full hand fizzles: the mark is spent and the target gets the card --
--     still subject to RFB08, which rolls the whole allocation back (mark
--     left live) rather than overwrite the target's hand.
--     RFB58 when the mark is no longer live (spent since the warning).
-- Returns the recipient and the redirect outcome (null unless the
-- beneficiary option ran).
--
-- Canonical source: this file is the source of truth for the function body.
-- Edit here and run `npm run build:migrations` -- do not hand-edit the
-- generated migration. See db/sql/README.md.

create or replace function public.admin_allocate_spell_card(
  p_card_id uuid,
  p_player_id text,
  p_mark_choice text default null
)
returns table (instance_id uuid, recipient_player_id text, draw_redirect_outcome text)
language plpgsql
security definer
set search_path = public
as $$
declare
  v_caller text;
  v_is_admin boolean;
  v_instance_id uuid;
  v_current_location text;
  v_current_holder text;
  v_current_holder_name text;
  v_target_current_card text;
  v_mark record;
  v_beneficiary_name text;
  v_recipient text := p_player_id;
  v_slot text := 'held';
  v_outcome text;
  v_draw_id uuid;
begin
  v_caller := public.current_player_id();

  select is_admin into v_is_admin from public.players where id = v_caller;
  if not coalesce(v_is_admin, false) then
    raise exception 'admin_allocate_spell_card: caller is not an admin';
  end if;

  if p_mark_choice is not null and p_mark_choice not in ('target', 'beneficiary') then
    raise exception 'admin_allocate_spell_card: unknown mark choice %', p_mark_choice;
  end if;

  if not exists (select 1 from public.players where id = p_player_id) then
    raise exception 'admin_allocate_spell_card: target player does not exist';
  end if;

  select sdi.id, sdi.location, sdi.held_by_player
    into v_instance_id, v_current_location, v_current_holder
    from public.spell_deck_instances sdi
   where sdi.card_id = p_card_id
     for update;

  if v_instance_id is null then
    raise exception 'admin_allocate_spell_card: unknown card';
  end if;

  if v_current_location <> 'in_deck' then
    select coalesce(p.display_name, p.email) into v_current_holder_name
      from public.players p where p.id = v_current_holder;

    raise exception 'admin_allocate_spell_card: that card is already held by %',
      coalesce(v_current_holder_name, v_current_holder)
      using errcode = 'RFB07';
  end if;

  select * into v_mark from public._lock_next_draw_mark(p_player_id);

  if v_mark.source_cast_id is not null and p_mark_choice is null then
    select coalesce(p.display_name, p.email) into v_beneficiary_name
      from public.players p where p.id = v_mark.beneficiary_id;

    raise exception 'admin_allocate_spell_card: that player has a live Stale Biscuit mark from %',
      coalesce(v_beneficiary_name, v_mark.beneficiary_id)
      using errcode = 'RFB57', detail = v_mark.beneficiary_id;
  end if;

  if p_mark_choice = 'beneficiary' then
    if v_mark.source_cast_id is null then
      raise exception 'admin_allocate_spell_card: that player no longer has a live Stale Biscuit mark'
        using errcode = 'RFB58';
    end if;

    v_slot := public._rr_free_hand_slot(v_mark.beneficiary_id);
    if v_slot is null then
      v_outcome := 'fizzled';
      v_slot := 'held';
    else
      v_outcome := 'redirected';
      v_recipient := v_mark.beneficiary_id;
    end if;
  end if;

  if v_recipient = p_player_id then
    select sc.name into v_target_current_card
      from public.spell_deck_instances sdi
      join public.spell_cards sc on sc.id = sdi.card_id
     where sdi.held_by_player = p_player_id and sdi.location in ('held', 'pending_swap');

    if v_target_current_card is not null then
      raise exception 'admin_allocate_spell_card: that player already holds %', v_target_current_card
        using errcode = 'RFB08';
    end if;
  end if;

  update public.spell_deck_instances
     set location = v_slot, held_by_player = v_recipient
   where id = v_instance_id;

  insert into public.spell_draws (player_id, card_instance_id, trigger)
  values (v_recipient, v_instance_id, 'admin_allocation')
  returning id into v_draw_id;

  if v_outcome is not null then
    update public.spell_casts
       set cast_inputs = coalesce(cast_inputs, '{}'::jsonb)
                         || jsonb_build_object(
                              'consumed_by_draw', v_draw_id,
                              'draw_redirect_outcome', v_outcome
                            )
     where id = v_mark.source_cast_id;
  end if;

  instance_id := v_instance_id;
  recipient_player_id := v_recipient;
  draw_redirect_outcome := v_outcome;
  return next;
end;
$$;

revoke execute on function public.admin_allocate_spell_card(uuid, text, text) from public, anon;
grant execute on function public.admin_allocate_spell_card(uuid, text, text) to authenticated;

comment on function public.admin_allocate_spell_card(uuid, text, text) is
  'Raises RFB07 when the card is already held/pending-swap by someone else, RFB08 when the recipient already holds/is mid-swap-decision on a different card. Both require the admin to unassign first rather than auto-reassigning. (#471) Raises RFB57 (detail = beneficiary id) when the target has a live Stale Biscuit mark and p_mark_choice is null; ''target'' allocates anyway leaving the mark live, ''beneficiary'' lands the card in the beneficiary''s free hand slot and spends the mark (fizzling to the target on a full hand); RFB58 if the mark is no longer live. Returns the recipient and the redirect outcome.';
