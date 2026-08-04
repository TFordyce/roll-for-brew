-- Imports the user's updated v2 spell card catalog (issue #121, child of the
-- Spell Collection view spec map #120) — 6 new cards plus wording/mechanic
-- tweaks to 9 existing ones. Source: the user-authored print-deck tool
-- (tea-spell-cards-v2.html) and its accompanying 71-file art set, diffed
-- against the live catalog (0017 + confirmed no later migration inserts
-- into spell_cards). Catalog only — none of the 6 new cards get an
-- effect_kind/spell_card_effects mapping here; that's a data-access-ticket
-- follow-up, same as the 47 cards 0022 deliberately left unmapped.
--
-- New cards (2 Common / 2 Rare / 2 Epic), taking the catalog from 65 to 71:
insert into public.spell_cards (name, casting_time, target, tier, effect_text) values
  ('Gambler''s Infusion', 'A', 'SELF', 'common', 'Roll your d20. On a 15+, roll a second d20 and take the higher. On a 5 or lower, roll a second d20 and take the lower.'),
  ('Steady Hand', 'A', 'SELF', 'common', 'Skip your roll this round and treat your d20 as a 10.'),
  ('Brew-merang', 'R', 'CARD', 'rare', 'When another player plays a card, seize it — its effect resolves on its caster instead of the intended target.'),
  ('Tea for Two', 'A', 'PLAYER', 'rare', 'Link to a target. This round, you both count as having rolled the higher of your two dice.'),
  ('Cast-Iron Kettle', 'A', 'SELF', 'epic', 'For the next 5 rounds, you are immune to all harmful effects on your roll and modifier.'),
  ('Brewmageddon', 'A', 'TABLE', 'epic', 'All players must immediately play their spell card this round. Players holding no card are unaffected.')
on conflict (name) do nothing;

-- Wording/mechanic tweaks to existing cards, per the v2 source (user
-- confirmed the Tea Leaf/Spillage duration change — "rest of the day" to
-- "this round only" — is an intentional v2 balance change, not a v2-doc
-- typo). Neither card carries an effect_kind mapping yet, so this is a
-- display-text-only update; no spell_card_effects/engine change needed.
update public.spell_cards set effect_text = 'Force the winner of the previous round to make tea instead. They gain no modifier from this tea-making.'
 where name = 'Last Drip';

-- Cloud of Cream IS mapped (0020/0032: hidden_modifier, CASTER role) — the
-- new text drops the word "hidden" but describes the same mechanic (cards
-- targeting the highest/lowest modifier skip you), so effect_kind/
-- effect_params are unchanged; only the display text is refreshed.
update public.spell_cards set effect_text = 'For the next 2 rounds, cards that target the highest or lowest modifier can skip you and apply to the next player instead.'
 where name = 'Cloud of Cream';

update public.spell_cards set effect_text = 'Steal a target player''s entire current modifier for this round only.'
 where name = 'Tea Leaf';

update public.spell_cards set effect_text = 'Steal half of a target player''s current modifier, rounded down, for this round only.'
 where name = 'Spillage';

update public.spell_cards set effect_text = 'Choose a target. If they roll lower than you this round, they make tea regardless of anyone else. Target gains no modifier from this round.'
 where name = 'PG Tipped';

update public.spell_cards set effect_text = 'Target does not roll this round; their result counts as a natural 1.'
 where name = 'Sleeping Camomile';

update public.spell_cards set effect_text = 'Link to a target. This round, you both count as having rolled the lower of your two dice.'
 where name = 'Steaming Mug Bond';

update public.spell_cards set effect_text = 'Choose a target to make tea this round; you make it next round, no roll required.'
 where name = 'Brew IOU';

update public.spell_cards set effect_text = 'Give another player a d6. In the next 3 rounds they may use it as a Reaction to add to their roll.'
 where name = 'Liquid Courage';
