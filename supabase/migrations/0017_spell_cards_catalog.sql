-- Spell Cards 1/5: card catalog schema (issue #66, child of the spell-cards
-- spec map #65). Seeds public.spell_cards from the physical-deck-verified
-- transcription (research/spell-cards-transcription.md, resolved by #59) —
-- 65 rows: 20 Common / 33 Rare / 12 Epic. This migration is data-model only;
-- draw/hold/swap RPCs land in 0018, casting in 0019.
--
-- effect_kind/effect_params are the tagged-enum + JSON-payload primitives the
-- map (#65) decided on, rather than per-effect columns or an opaque blob.
-- Per the map's explicit scope note, mapping all 65 cards to a concrete
-- effect_kind is a follow-up implementation task, not this migration's job —
-- only the handful of cards needed to exercise the pre-roll casting engine
-- (#67: self/opponent/player flat modifiers, a multiplier, advantage) are
-- mapped here; the rest are left with effect_kind null until that follow-up
-- lands, consistent with "tier corrections shouldn't require touching every
-- card's stored effect data" (user story 35) and the map's out-of-scope note.
create table if not exists public.spell_cards (
  id uuid primary key default gen_random_uuid(),
  name text not null unique,
  casting_time text not null check (casting_time in ('A', 'R')),
  target text not null
    check (target in ('SELF', 'OPPONENT', 'PLAYER', 'TABLE', 'CARD', 'WILD')),
  tier text not null check (tier in ('common', 'rare', 'epic')),
  effect_text text not null,
  effect_kind text
    check (effect_kind in ('flat_modifier', 'dice_modifier', 'modifier_multiplier', 'set_modifier', 'advantage', 'disadvantage')),
  effect_params jsonb
);

alter table public.spell_cards enable row level security;

-- Card names/effects aren't secret (only which physical instance a given
-- player holds is, per spell_deck_instances in 0018) — every authenticated
-- player can read the catalog to render a held card's name/effect text.
create policy "spell_cards are readable by authenticated users"
  on public.spell_cards for select
  to authenticated
  using (true);

insert into public.spell_cards (name, casting_time, target, tier, effect_text) values
  ('Bes-Tea', 'A', 'OPPONENT', 'common', 'Copy another player''s modifier for this round.'),
  ('Six Sugars', 'R', 'SELF', 'common', 'Add 1d6 to your roll this round.'),
  ('Lucky Sip', 'A', 'SELF', 'common', 'Add +3 to your roll this round.'),
  ('Caffeinated Focus', 'A', 'SELF', 'common', 'Add +5 to your roll this round.'),
  ('Double Dunk', 'R', 'SELF', 'common', 'Reroll your d20. Take the new result.'),
  ('Milk First?', 'R', 'OPPONENT', 'common', 'Target rerolls their d20. They must take the new result.'),
  ('Slipped Spoon', 'A', 'OPPONENT', 'common', 'Target rolls with disadvantage this round; you add 1d4 to your roll.'),
  ('Cold Tea', 'A', 'OPPONENT', 'common', 'Target subtracts 3 from their roll this round; you add 1d4 to yours.'),
  ('Sugar Rush', 'A', 'SELF', 'common', 'Roll with advantage this round.'),
  ('Brewer''s Blessing', 'A', 'PLAYER', 'common', 'Target player adds +5 to their roll this round.'),
  ('Fortune''s Flavour', 'A', 'PLAYER', 'common', 'Target player rolls with advantage this round.'),
  ('Tea Party Revolt', 'A', 'TABLE', 'common', 'The lowest roller chooses who makes tea this round.'),
  ('Re-Steep', 'R', 'SELF', 'common', 'Reroll your own d20. You must keep the new result.'),
  ('Last Drip', 'A', 'TABLE', 'common', 'Force the winner of the previous round (highest roller) to make tea instead. They gain no modifier from this tea-making.'),
  ('Tannin Tantrum', 'R', 'CARD', 'common', 'Roll a d20 to cancel that card. Meet the DC for its tier — Common 2, Rare 5, Epic 10 — and its effect is cancelled entirely. Fail and it resolves as normal.'),
  ('Saving Steep', 'R', 'CARD', 'common', 'Roll a d20. On 10+, the card has no effect. On a nat 1, the effect is doubled against you.'),
  ('Brew-tal Swap', 'R', 'OPPONENT', 'common', 'Swap your d20 result with another player''s.'),
  ('Yorkshire Terror', 'A', 'OPPONENT', 'common', 'Choose a target. After they roll, they must reroll and keep the new result.'),
  ('Lesser Detox', 'A', 'CARD', 'common', 'End an ongoing effect from a Common card on any player.'),
  ('Cloud of Cream', 'A', 'SELF', 'common', 'For the next 2 rounds your modifier is hidden; cards that target the highest or lowest modifier skip you and apply to the next player instead.'),
  ('Tea Cosy', 'A', 'SELF', 'rare', 'You are exempt from rolling this round. You cannot be the tea-maker.'),
  ('Boil Over', 'A', 'TABLE', 'rare', 'All players'' modifiers reset to 0 for this round only.'),
  ('Milky Brew', 'A', 'OPPONENT', 'rare', 'Target player''s modifier is 0 for this round.'),
  ('Double Shot', 'A', 'SELF', 'rare', 'Double your modifier for this round only.'),
  ('Tea-M Reroll', 'R', 'TABLE', 'rare', 'All players reroll their d20. New rolls determine the tea-maker.'),
  ('Dunkin Disaster', 'R', 'TABLE', 'rare', 'Force the highest and lowest rollers to swap their d20 results this round.'),
  ('Broken Biscuit', 'R', 'TABLE', 'rare', 'The lowest roller adds the highest modifier currently on the table to their roll this round.'),
  ('Tea Leaf', 'A', 'OPPONENT', 'rare', 'Steal a chosen player''s entire current modifier. Their modifier drops to 0 and the full amount is added to yours for the rest of the day.'),
  ('Spillage', 'A', 'OPPONENT', 'rare', 'Halve a target''s modifier, rounded down, for the rest of the day; add that removed amount to your roll next round.'),
  ('Chai-nge of Heart', 'A', 'OPPONENT', 'rare', 'Swap your modifier with a target''s for the rest of the day.'),
  ('Bag for Life', 'A', 'SELF', 'rare', 'Your modifier cannot be reduced, copied, or affected by any card for the rest of the day. You still gain modifier from making tea as normal.'),
  ('Drip Tray', 'R', 'TABLE', 'rare', 'Force the player with the highest current modifier to make tea instead. They gain no modifier from this tea-making.'),
  ('Loose Leaf', 'R', 'SELF', 'rare', 'When you are named tea-maker, force a roll-off against the second-lowest roller. Both roll d20 — the loser makes tea instead.'),
  ('Stir the Pot', 'A', 'OPPONENT', 'rare', 'Choose two other players. They swap their d20 results this round.'),
  ('PG Tipped', 'A', 'OPPONENT', 'rare', 'Choose a target. If they roll lower than you this round, they make tea regardless of anyone else. If forced to make tea by this card, they gain no modifier from it.'),
  ('Mug Shot', 'R', 'OPPONENT', 'rare', 'Negate a target''s modifier for this round only.'),
  ('Jinxed Biscuit', 'A', 'OPPONENT', 'rare', 'Curse a target. For the next 3 rounds, they cannot benefit from any buff card.'),
  ('Marked for Brew', 'A', 'OPPONENT', 'rare', 'Mark a target. Within the next 5 rounds they take part in, the first time they roll a nat 1 or nat 20, you draw the card instead.'),
  ('Inscribed Saucer', 'A', 'TABLE', 'rare', 'Declare a number 1–20 on play. The next player to roll that exact natural number makes tea, regardless of totals.'),
  ('Mug Mirror', 'R', 'CARD', 'rare', 'That card''s effect resolves on its caster instead of you.'),
  ('Sleeping Camomile', 'A', 'OPPONENT', 'rare', 'Target does not roll this round. Their result counts as a natural 1. If they make tea as a result, they gain no modifier from it.'),
  ('Steaming Mug Bond', 'A', 'OPPONENT', 'rare', 'Link to a target. This round, you both count as having rolled the lower of your two dice. If you are both tied at the lowest, roll off between yourselves to decide the tea-maker.'),
  ('Tea-tally Spent', 'R', 'SELF', 'rare', 'Spend any amount of your modifier and add that much to this round''s roll. Spent modifier is gone for the day.'),
  ('Loaf of Lipton', 'A', 'SELF', 'rare', 'Skip your roll this round and make tea automatically. You gain double the usual modifier.'),
  ('Brew IOU', 'A', 'OPPONENT', 'rare', 'Choose a target. They make tea this round on your behalf, regardless of the dice. In return, you must make tea on the next round you would have rolled, no roll required. Both parties gain +N modifier from rounds they make.'),
  ('Tea Heist', 'A', 'OPPONENT', 'rare', 'Steal a card from another player''s hand. They draw nothing in return.'),
  ('Stale Biscuit', 'A', 'OPPONENT', 'rare', 'Mark a target. The very next card they would draw goes to you instead.'),
  ('Saucerer''s Apprentice', 'R', 'CARD', 'rare', 'Copy that card''s effect. The original effect still resolves; your copy resolves immediately afterwards.'),
  ('Caffeine Crash', 'A', 'OPPONENT', 'rare', 'Target''s modifier is treated as −1 for the next 2 rounds. After 2 rounds, their modifier returns to its previous value.'),
  ('Bitter Leech', 'A', 'OPPONENT', 'rare', 'For the next 3 rounds, a target loses 1 modifier at the start of each round and you gain it.'),
  ('Scalding Pour', 'A', 'TABLE', 'rare', 'Every other player subtracts 3 from their roll this round.'),
  ('Calami-Tea', 'A', 'OPPONENT', 'rare', 'Choose up to 3 players. For the next 3 rounds, they each subtract 1d4 from their rolls.'),
  ('Liquid Courage', 'A', 'OPPONENT', 'rare', 'Give another player a d6. Once in the next 3 rounds, as a Reaction to any roll, they may roll it and add the result to that roll.'),
  ('Kettle Crash', 'A', 'TABLE', 'epic', 'All players'' modifiers reset to 0. The day starts again, mechanically.'),
  ('Wild Brew Surge', 'A', 'WILD', 'epic', 'Roll a d6 and apply the matching effect: 1. All modifiers reset to 0. 2. You gain +3 modifier for the rest of the day. 3. Swap modifiers with a random player. 4. Everyone rerolls this round''s d20. 5. Highest and lowest modifiers swap holders. 6. Choose who makes tea this round, regardless of the dice.'),
  ('Time for Brew', 'R', 'TABLE', 'epic', 'At the end of this round, after the tea-maker is announced, you may scrap the result. The round is replayed entirely — new rolls, new cards may be played.'),
  ('Zariel''s Fall', 'R', 'TABLE', 'epic', 'Every d20 flips to its opposite face (21 minus current value): 1→20, 5→16, 19→2. Tea-maker is decided from the flipped values. Original rolls still trigger any nat 1 or nat 20 card draws.'),
  ('Eternal Steep', 'A', 'OPPONENT', 'epic', 'Choose a target. Their modifier is frozen at its current value. They gain no modifier from tea-making, and no card can alter their modifier.'),
  ('The Last Cuppa', 'A', 'SELF', 'epic', 'You cannot be the tea-maker for the rest of the day under any circumstance. No card, force, mark, or curse can override this.'),
  ('Earl of Earl Grey', 'A', 'SELF', 'epic', 'Take the title of Earl. While Earl, you cannot be tea-maker — the next-lowest roller makes tea instead. If a card would force tea on you, pass the title to its caster: they become Earl, you lose immunity.'),
  ('Greater Detox', 'A', 'CARD', 'epic', 'End an ongoing Rare or Epic condition on any player.'),
  ('Prophe-Tea', 'A', 'SELF', 'epic', 'For the rest of the day, you roll every round with advantage.'),
  ('Topsy-Tea', 'A', 'TABLE', 'epic', 'This round only, the highest roller makes tea instead of the lowest.'),
  ('Genie in the Teapot', 'A', 'CARD', 'epic', 'Name any other non-Epic Action card in the deck and resolve its effect as if you had played it.'),
  ('Kettle Storm', 'A', 'TABLE', 'epic', 'Every other player subtracts 8 from their roll this round.')
on conflict (name) do nothing;

-- effect_kind/effect_params for the primitives #67's pre-roll casting engine
-- needs to exercise self/opponent/player targeting end-to-end: a flat
-- modifier (self and player-targeted), a modifier multiplier (self), a
-- direct modifier override (opponent-targeted), and advantage (self and
-- player-targeted). Every other card is intentionally left unmapped — see
-- the header comment above.
update public.spell_cards set effect_kind = 'flat_modifier', effect_params = '{"delta": 3}'::jsonb
 where name = 'Lucky Sip';
update public.spell_cards set effect_kind = 'flat_modifier', effect_params = '{"delta": 5}'::jsonb
 where name = 'Caffeinated Focus';
update public.spell_cards set effect_kind = 'flat_modifier', effect_params = '{"delta": 5}'::jsonb
 where name = 'Brewer''s Blessing';
update public.spell_cards set effect_kind = 'modifier_multiplier', effect_params = '{"multiplier": 2}'::jsonb
 where name = 'Double Shot';
update public.spell_cards set effect_kind = 'set_modifier', effect_params = '{"value": 0}'::jsonb
 where name = 'Milky Brew';
update public.spell_cards set effect_kind = 'advantage', effect_params = '{}'::jsonb
 where name = 'Sugar Rush';
update public.spell_cards set effect_kind = 'advantage', effect_params = '{}'::jsonb
 where name = 'Fortune''s Flavour';
