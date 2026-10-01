-- _compelled_card_has_legal_target
--
-- Whether a compelled holder's card has any legal target in this round. The
-- rules mirror what cast_spell_card / cast_reaction_spell_card /
-- end_active_effect would accept; a card with no cast path at all (an Action
-- CARD-target card other than a Detox) has no legal target either.
create or replace function public._compelled_card_has_legal_target(
  p_round_id uuid, p_player_id text, p_card_instance_id uuid
)
returns boolean
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_room_id uuid;
  v_card_id uuid;
  v_name text;
  v_casting_time text;
  v_target text;
  v_others integer;
  v_dispel_params jsonb;
begin
  select room_id into v_room_id from public.rounds where id = p_round_id;

  select sc.id, sc.name, sc.casting_time, sc.target
    into v_card_id, v_name, v_casting_time, v_target
    from public.spell_deck_instances sdi
    join public.spell_cards sc on sc.id = sdi.card_id
   where sdi.id = p_card_instance_id;

  select count(*) into v_others
    from public.round_participants
   where round_id = p_round_id and player_id <> p_player_id and excluded_at is null;

  if v_casting_time = 'R' then
    if v_target = 'CARD' then
      -- Another player's cast to answer. Brewmageddon itself always is one.
      return exists (
        select 1 from public.spell_casts c
         where c.round_id = p_round_id and c.caster_id <> p_player_id
           and c.effect_kind is distinct from 'forfeit'
      );
    elsif v_target = 'OPPONENT' then
      return v_others >= 1;
    end if;
    return v_target in ('SELF', 'PLAYER', 'TABLE');
  end if;

  -- A Detox (dispel) needs an active effect of a tier it can end -- and one
  -- that can be dispelled at all (issue #428: not The Last Cuppa's).
  select e.effect_params into v_dispel_params
    from public.spell_card_effects e
   where e.card_id = v_card_id and e.effect_kind = 'dispel'
   limit 1;
  if v_dispel_params is not null then
    return exists (
      select 1
        from public._rr_active_effects_as_of(v_room_id, p_round_id) sae
        join public.spell_cards sc2 on sc2.id = sae.card_id
       where sc2.tier in (select jsonb_array_elements_text(v_dispel_params -> 'tiers'))
         and not sae.is_undispellable
    );
  end if;

  if v_name = 'Stir the Pot' then
    return v_others >= 2;
  end if;

  if v_name = 'Tea Heist' then
    -- Only a player holding a card can be robbed (get_heist_targets /
    -- cast_spell_card's RFB53 check). Other compelled Action holders still
    -- hold theirs when the set is fixed.
    return exists (
      select 1 from public.round_participants rp
       where rp.round_id = p_round_id and rp.player_id <> p_player_id
         and rp.excluded_at is null
         and exists (
           select 1 from public.spell_deck_instances sdi
            where sdi.held_by_player = rp.player_id and sdi.location = 'held'
         )
    );
  end if;

  if v_name = 'Genie in the Teapot' then
    -- Any card Genie could name: mirrors cast_spell_card's Genie checks
    -- (keep the by-name list in sync with it).
    return exists (
      select 1
        from public.spell_cards sc
        join public.spell_deck_instances sdi on sdi.card_id = sc.id
       where sdi.location = 'in_deck'
         and sc.casting_time = 'A'
         and sc.tier <> 'epic'
         and sc.target <> 'WILD'
         and sc.name not in (
           'Genie in the Teapot', 'Bes-Tea', 'Tea Leaf', 'Spillage', 'Chai-nge of Heart',
           'Bitter Leech', 'Wild Brew Surge', 'Kettle Crash')
         and exists (
           select 1 from public.spell_card_effects e
            where e.card_id = sc.id and e.target_role <> 'WILD')
    );
  end if;

  if v_target = 'OPPONENT' then
    return v_others >= 1;
  end if;
  return v_target in ('SELF', 'PLAYER', 'CHOSEN_PLAYERS', 'TABLE', 'WILD');
end;
$$;

revoke execute on function public._compelled_card_has_legal_target(uuid, text, uuid) from public, anon, authenticated;
