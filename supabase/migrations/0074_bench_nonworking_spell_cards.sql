-- Bench the 39 non-working spell cards from the draw pool (issue #284,
-- interim safety fix out of the T1 spell audit #279, child of #278).
--
-- draw_spell_card picks a uniformly-random spell_deck_instances row where
-- location = 'in_deck' (0026:1264). 39 of the 71 catalog cards do nothing
-- in a live game:
--   * 37 have zero spell_card_effects rows — cast_spell_card discards the
--     held instance before the effect loop, which then runs zero times:
--     no spell_casts row, no error, the player just loses the card.
--   * 2 map to a dead effect_kind and cast without error but have no
--     mechanical effect: Cloud of Cream (hidden_modifier, excluded from
--     get_round_modifier_effects) and Kettle Crash (reset_persistent_modifier,
--     inserts a bare row nothing reads).
--
-- Park those 39 cards' deck instances at a new sentinel location, 'benched',
-- so the `where location = 'in_deck'` draw query skips them. Nothing else
-- reads a fourth location value, so no downstream RPC needs to change.
--
-- FULLY REVERSIBLE: flip an instance back to 'in_deck' as each card is
-- implemented (Kettle Crash / Yorkshire Terror already have fix issues
-- filed; the rest wait on T2). Collection/catalog pages read spell_cards,
-- not the deck, so they are unaffected and keep showing all 71.

alter table public.spell_deck_instances drop constraint spell_deck_instances_location_check;
alter table public.spell_deck_instances add constraint spell_deck_instances_location_check
  check (location in ('in_deck', 'held', 'pending_swap', 'benched'));

do $$
declare
  v_benched_names text[] := array[
    -- No effect rows (37)
    -- Common (6)
    'Bes-Tea', 'Tea Party Revolt', 'Last Drip', 'Saving Steep',
    'Brew-tal Swap', 'Yorkshire Terror',
    -- Rare (20)
    'Tea Cosy', 'Tea Leaf', 'Spillage', 'Chai-nge of Heart', 'Bag for Life',
    'Loose Leaf', 'Stir the Pot', 'PG Tipped', 'Jinxed Biscuit',
    'Marked for Brew', 'Sleeping Camomile', 'Steaming Mug Bond',
    'Tea-tally Spent', 'Loaf of Lipton', 'Brew IOU', 'Tea Heist',
    'Stale Biscuit', 'Saucerer''s Apprentice', 'Bitter Leech',
    'Liquid Courage',
    -- Epic (5)
    'Eternal Steep', 'The Last Cuppa', 'Earl of Earl Grey', 'Prophe-Tea',
    'Genie in the Teapot',
    -- v2 (6)
    'Gambler''s Infusion', 'Steady Hand', 'Brew-merang', 'Tea for Two',
    'Cast-Iron Kettle', 'Brewmageddon',
    -- Dead effect kind (2)
    'Cloud of Cream', 'Kettle Crash'
  ];
  v_matched integer;
  v_benched integer;
begin
  select count(*) into v_matched
    from public.spell_cards
   where name = any(v_benched_names);

  if v_matched <> array_length(v_benched_names, 1) then
    raise exception
      'bench list resolved % of % catalog cards — name drift, aborting',
      v_matched, array_length(v_benched_names, 1);
  end if;

  -- Only touch instances sitting in the deck. A card a player currently
  -- holds (location in ('held', 'pending_swap')) is left alone — it returns
  -- to 'in_deck' naturally on discard, and a follow-up run can bench it
  -- then if it's still unimplemented.
  update public.spell_deck_instances sdi
     set location = 'benched',
         held_by_player = null
   where sdi.location = 'in_deck'
     and sdi.card_id in (
       select id from public.spell_cards where name = any(v_benched_names)
     );

  get diagnostics v_benched = row_count;
  raise notice 'benched % of % non-working spell-card instances (rest currently held)',
    v_benched, array_length(v_benched_names, 1);
end $$;
