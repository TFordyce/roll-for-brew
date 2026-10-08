-- GENERATED FROM db/sql/functions/ -- DO NOT EDIT
--
-- Written by `npm run build:migrations` from the canonical resolver-function
-- sources under db/sql/functions/. To change any function below, edit its
-- db/sql/functions/<name>.sql and re-run the build. See db/sql/README.md.
--
-- Functions in this migration:
--   _land_drawn_instance
--   _lock_next_draw_mark
--   admin_allocate_spell_card

-- BEGIN db/sql/functions/_land_drawn_instance.sql
-- _land_drawn_instance(text, uuid, text) -> boolean
--
-- Issue #435 (spec #401 F6, #383 Q5): puts a just-drawn spell_deck_instances
-- row into p_player_id's hand and logs the draw. Returns needs_swap_decision.
-- Replaces the placement block the four draw RPCs (draw_spell_card,
-- draw_spell_card_as, draw_pending_spell_card, draw_pending_spell_card_manual)
-- each carried a copy of (0018 / 0034 / 0036, last restated in 0070):
--   * empty hand -> 'held';
--   * already holding a card, nat 20 -> parked as 'pending_swap' for the
--     keep-or-swap choice;
--   * already holding a card, nat 1 -> forced swap (0070, #267): the held card
--     goes back to 'in_deck' and the new one is seated as 'held', no choice.
-- Then one spell_draws row for the player.
--
-- The callers keep their own instance pick and their own "already has a
-- pending keep-or-swap decision" guard.
--
-- Issue #437 (Stale Biscuit): before placing, the oldest live `next_draw`
-- draw_redirect mark on p_player_id fires (_lock_next_draw_mark, #471, which
-- defines "live" and locks the mark). Firing spends the mark for good: the
-- source cast records cast_inputs.consumed_by_draw (the spell_draws row) and
-- draw_redirect_outcome:
--   * `redirected` -- the card lands with the beneficiary (the mark's caster)
--     in their free hand slot (_rr_free_hand_slot): 'held', or 'pending_swap'
--     for a keep-or-swap choice. The beneficiary did not roll, so a nat 1's
--     forced swap does not apply to them, and the drawer's own hand is
--     untouched. The spell_draws row names the beneficiary (it is their
--     card); the drawer gets needs_swap_decision = false.
--   * `fizzled`    -- the beneficiary's hand is full (held + pending_swap), so
--     the mark is spent and the drawer lands the card as normal.
-- Only one mark fires per draw.
--
-- Internal: no grant; only reached from the SECURITY DEFINER draw RPCs.
--
-- Canonical source: this file is the source of truth for the function body.
-- Edit here and run `npm run build:migrations` -- do not hand-edit the
-- generated migration. See db/sql/README.md.

create or replace function public._land_drawn_instance(
  p_player_id text, p_instance_id uuid, p_trigger text
)
returns boolean
language plpgsql
set search_path = public
as $$
declare
  v_mark record;
  v_slot text;
  v_outcome text;
  v_draw_id uuid;
  v_already_held boolean;
  v_needs_swap_decision boolean;
begin
  select * into v_mark from public._lock_next_draw_mark(p_player_id);

  if v_mark.source_cast_id is not null then
    v_slot := public._rr_free_hand_slot(v_mark.beneficiary_id);
    v_outcome := case when v_slot is null then 'fizzled' else 'redirected' end;

    if v_outcome = 'redirected' then
      update public.spell_deck_instances
         set location = v_slot, held_by_player = v_mark.beneficiary_id
       where id = p_instance_id;

      insert into public.spell_draws (player_id, card_instance_id, trigger)
      values (v_mark.beneficiary_id, p_instance_id, p_trigger)
      returning id into v_draw_id;

      v_needs_swap_decision := false;
    end if;
  end if;

  -- No mark, or it fizzled: the drawer lands the card as before.
  if v_outcome is distinct from 'redirected' then
    v_already_held := exists (
      select 1 from public.spell_deck_instances
       where held_by_player = p_player_id and location = 'held'
    );

    if v_already_held and p_trigger = 'nat1' then
      update public.spell_deck_instances
         set location = 'in_deck', held_by_player = null
       where held_by_player = p_player_id and location = 'held';

      update public.spell_deck_instances
         set location = 'held', held_by_player = p_player_id
       where id = p_instance_id;

      v_needs_swap_decision := false;
    else
      update public.spell_deck_instances
         set location = case when v_already_held then 'pending_swap' else 'held' end,
             held_by_player = p_player_id
       where id = p_instance_id;

      v_needs_swap_decision := v_already_held;
    end if;

    insert into public.spell_draws (player_id, card_instance_id, trigger)
    values (p_player_id, p_instance_id, p_trigger)
    returning id into v_draw_id;
  end if;

  if v_outcome is not null then
    update public.spell_casts
       set cast_inputs = coalesce(cast_inputs, '{}'::jsonb)
                         || jsonb_build_object(
                              'consumed_by_draw', v_draw_id,
                              'draw_redirect_outcome', v_outcome
                            )
     where id = v_mark.source_cast_id;
  end if;

  return v_needs_swap_decision;
end;
$$;

revoke execute on function public._land_drawn_instance(text, uuid, text) from public, anon, authenticated;

comment on function public._land_drawn_instance(text, uuid, text) is
  'Issue #435: places a just-drawn instance in the drawer''s hand (held / pending_swap / nat-1 forced swap) and logs the spell_draws row; returns needs_swap_decision. (#437) First fires the drawer''s oldest live next_draw Draw Redirect mark (Stale Biscuit): the card lands with the beneficiary''s free hand slot, or the redirect fizzles on a full hand; the mark is spent via cast_inputs.consumed_by_draw / draw_redirect_outcome. Internal.';
-- END db/sql/functions/_land_drawn_instance.sql

-- BEGIN db/sql/functions/_lock_next_draw_mark.sql
-- _lock_next_draw_mark(text) -> table(beneficiary_id text, source_cast_id uuid)
--
-- Issue #471: the one read of "does this player have a live Stale Biscuit
-- mark", shared by _land_drawn_instance (a draw fires it) and
-- admin_allocate_spell_card (an allocation warns about it, or fires it when
-- the admin picks the beneficiary). Lifted out of _land_drawn_instance (#437).
--
-- Returns the oldest live `next_draw` draw_redirect mark on p_player_id --
-- oldest first by created_at, then id -- or no row. "Live" is
-- _rr_active_effects_as_of in the mark's room as of that room's latest round
-- (not countered, not spent, not dispelled), and the mark's cast round has
-- resolved, so a counter still to come in that round cannot un-happen a
-- redirect. The mark's cast row is locked FOR UPDATE and re-checked unspent,
-- so two concurrent callers never spend one mark twice; the caller spends it
-- (cast_inputs.consumed_by_draw / draw_redirect_outcome) in the same
-- transaction, or leaves it live.
--
-- Internal: no grant; only reached from SECURITY DEFINER RPCs.
--
-- Canonical source: this file is the source of truth for the function body.
-- Edit here and run `npm run build:migrations` -- do not hand-edit the
-- generated migration. See db/sql/README.md.

create or replace function public._lock_next_draw_mark(p_player_id text)
returns table (beneficiary_id text, source_cast_id uuid)
language plpgsql
set search_path = public
as $$
declare
  v_mark record;
begin
  loop
    select m.caster_id as beneficiary_id, m.source_cast_id
      into v_mark
      from (
        select distinct sae.room_id
          from public.spell_active_effects sae
         where sae.target_player_id = p_player_id
           and sae.effect_kind = 'draw_redirect'
           and sae.effect_params ->> 'trigger' = 'next_draw'
      ) mark_room
      cross join lateral (
        select r.id from public.rounds r
         where r.room_id = mark_room.room_id
         order by r.started_at desc
         limit 1
      ) latest
      cross join lateral public._rr_active_effects_as_of(mark_room.room_id, latest.id) m
      join public.spell_casts src on src.id = m.source_cast_id
      join public.rounds src_round on src_round.id = src.round_id
     where m.target_player_id = p_player_id
       and m.effect_kind = 'draw_redirect'
       and m.effect_params ->> 'trigger' = 'next_draw'
       and src_round.resolved_at is not null
     order by m.created_at, m.id
     limit 1;

    if not found then
      return;
    end if;

    -- Still unspent once locked: return it. Otherwise a concurrent caller
    -- just spent it -- look again.
    perform 1 from public.spell_casts
     where id = v_mark.source_cast_id
       and cast_inputs ->> 'consumed_by_draw' is null
       for update;
    if found then
      beneficiary_id := v_mark.beneficiary_id;
      source_cast_id := v_mark.source_cast_id;
      return next;
      return;
    end if;
  end loop;
end;
$$;

revoke execute on function public._lock_next_draw_mark(text) from public, anon, authenticated;

comment on function public._lock_next_draw_mark(text) is
  'Issue #471: the player''s oldest live next_draw Draw Redirect mark (Stale Biscuit) -- beneficiary + source cast, its cast row locked and unspent -- or no row. Shared by _land_drawn_instance and admin_allocate_spell_card; the caller spends it. Internal.';
-- END db/sql/functions/_lock_next_draw_mark.sql

-- BEGIN db/sql/functions/admin_allocate_spell_card.sql
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
-- END db/sql/functions/admin_allocate_spell_card.sql

