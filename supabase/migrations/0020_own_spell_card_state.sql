-- Spell Cards 1/5 (issue #66): the read side of the docked-widget UI (US3).
-- A player's held card and any pending keep-or-swap decision, in one call.

-- Shared shape for "a deck instance's card face" (id/name/tier/casting-time/
-- target/effect text) — get_own_spell_card_state below needs this same
-- shape three times (the held card, and each side of a pending swap), so
-- it's a small stable function rather than three copies of the same join.
-- Deliberately NOT granted to authenticated/anon (revoked below, from every
-- role): it takes an arbitrary instance id with no ownership check of its
-- own, so a direct grant would let any authenticated caller look up any
-- card — including deck-blind in_deck/discarded instances — by id. It's
-- only ever reached from inside get_own_spell_card_state, which is itself
-- security definer and already restricts every id it passes in to ones it
-- looked up for the caller's own player id; calling it from there runs as
-- that function owner's role, so no grant is needed for that internal path.
create or replace function public.spell_deck_instance_json(p_instance_id uuid)
returns jsonb
language sql
stable
set search_path = public
as $$
  select jsonb_build_object(
    'instanceId', i.id,
    'name', c.name,
    'tier', c.tier,
    'castingTime', c.casting_time,
    'target', c.target,
    'effectText', c.effect_text
  )
  from public.spell_deck_instances i
  join public.spell_cards c on c.id = i.spell_card_id
  where i.id = p_instance_id;
$$;

-- Needed because the newly-drawn instance in a pending swap sits at
-- location = 'discarded' with held_by_player_id = null while the player is
-- deciding (0018's comment on draw_spell_card explains why) — the "readable
-- only by their current holder" RLS policy on spell_deck_instances
-- deliberately does not cover that row, so a direct table read can't
-- reconstruct "what am I being offered to swap for" for the player who
-- drew it. This is a security-definer RPC in the same "safe, narrowly-
-- scoped read" family as get_current_layer_rolls_if_complete: it derives the
-- caller's own player id internally (never a parameter) and only ever
-- returns that player's own held card and pending draw, so there is no way
-- to use it to peek at another player's hand or the deck's contents/count.
create or replace function public.get_own_spell_card_state()
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_player_id text;
  v_held_instance_id uuid;
  v_draw_id uuid;
  v_new_instance_id uuid;
  v_previous_instance_id uuid;
  v_pending jsonb;
begin
  v_player_id := public.current_player_id();

  select i.id into v_held_instance_id
    from public.spell_deck_instances i
   where i.held_by_player_id = v_player_id and i.location = 'held'
   limit 1;

  select d.id, d.drawn_instance_id, d.previously_held_instance_id
    into v_draw_id, v_new_instance_id, v_previous_instance_id
    from public.spell_draws d
   where d.player_id = v_player_id
     and d.swap_resolved_at is null
     and d.previously_held_instance_id is not null
   limit 1;

  if v_draw_id is not null then
    v_pending := jsonb_build_object(
      'drawId', v_draw_id,
      'newCard', public.spell_deck_instance_json(v_new_instance_id),
      'currentCard', public.spell_deck_instance_json(v_previous_instance_id)
    );
  end if;

  return jsonb_build_object(
    'held',
    case when v_held_instance_id is not null
      then public.spell_deck_instance_json(v_held_instance_id)
      else null
    end,
    'pendingSwap', v_pending
  );
end;
$$;

revoke execute on function public.spell_deck_instance_json(uuid) from public, anon, authenticated;
revoke execute on function public.get_own_spell_card_state() from public, anon;
grant execute on function public.get_own_spell_card_state() to authenticated;
