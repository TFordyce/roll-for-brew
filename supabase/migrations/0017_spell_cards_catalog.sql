-- Spell Cards 1/5 (issue #66): the static card catalog, transcribed
-- verbatim from research/spell-cards-transcription.md (the physical/
-- photographed API All Stars 2026 deck) — 20 Common, 33 Rare, 12 Epic, 65
-- rows total. Reference data: readable by anyone, writable only via
-- migration (no insert/update/delete policy is granted to any app role).
create table if not exists public.spell_cards (
  id uuid primary key default gen_random_uuid(),
  name text not null unique,
  tier text not null check (tier in ('common', 'rare', 'epic')),
  casting_time text not null check (casting_time in ('action', 'reaction')),
  target text not null check (target in ('self', 'opponent', 'player', 'table', 'card', 'wild')),
  effect_text text not null,
  created_at timestamptz not null default now()
);

alter table public.spell_cards enable row level security;

create policy "spell_cards are readable by authenticated users"
  on public.spell_cards for select
  to authenticated
  using (true);

-- No insert/update/delete policies: the catalog is seeded below, once, by
-- this migration (which runs as the table owner) and only changes via a
-- future migration (e.g. #70's per-card effect_kind/effect_params mapping),
-- never through the app.

insert into public.spell_cards (name, tier, casting_time, target, effect_text) values
  -- Common (20)
  ('Bes-Tea', 'common', 'action', 'opponent', 'Copy another player''s modifier for this round.'),
  ('Six Sugars', 'common', 'reaction', 'self', 'Add 1d6 to your roll this round.'),
  ('Lucky Sip', 'common', 'action', 'self', 'Add +3 to your roll this round.'),
  ('Caffeinated Focus', 'common', 'action', 'self', 'Add +5 to your roll this round.'),
  ('Double Dunk', 'common', 'reaction', 'self', 'Reroll your d20. Take the new result.'),
  ('Milk First?', 'common', 'reaction', 'opponent', 'Target rerolls their d20. They must take the new result.'),
  ('Slipped Spoon', 'common', 'action', 'opponent', 'Target rolls with disadvantage this round; you add 1d4 to your roll.'),
  ('Cold Tea', 'common', 'action', 'opponent', 'Target subtracts 3 from their roll this round; you add 1d4 to yours.'),
  ('Sugar Rush', 'common', 'action', 'self', 'Roll with advantage this round.'),
  ('Brewer''s Blessing', 'common', 'action', 'player', 'Target player adds +5 to their roll this round.'),
  ('Fortune''s Flavour', 'common', 'action', 'player', 'Target player rolls with advantage this round.'),
  ('Tea Party Revolt', 'common', 'action', 'table', 'The lowest roller chooses who makes tea this round.'),
  ('Re-Steep', 'common', 'reaction', 'self', 'Reroll your own d20. You must keep the new result.'),
  ('Last Drip', 'common', 'action', 'table', 'Force the winner of the previous round (highest roller) to make tea instead. They gain no modifier from this tea-making.'),
  ('Tannin Tantrum', 'common', 'reaction', 'card', 'Roll a d20 to cancel that card. Meet the DC for its tier — Common 2, Rare 5, Epic 10 — and its effect is cancelled entirely. Fail and it resolves as normal.'),
  ('Saving Steep', 'common', 'reaction', 'card', 'Roll a d20. On 10+, the card has no effect. On a nat 1, the effect is doubled against you.'),
  ('Brew-tal Swap', 'common', 'reaction', 'opponent', 'Swap your d20 result with another player''s.'),
  ('Yorkshire Terror', 'common', 'action', 'opponent', 'Choose a target. After they roll, they must reroll and keep the new result.'),
  ('Lesser Detox', 'common', 'action', 'card', 'End an ongoing effect from a Common card on any player.'),
  ('Cloud of Cream', 'common', 'action', 'self', 'For the next 2 rounds your modifier is hidden; cards that target the highest or lowest modifier skip you and apply to the next player instead.'),

  -- Rare (33)
  ('Tea Cosy', 'rare', 'action', 'self', 'You are exempt from rolling this round. You cannot be the tea-maker.'),
  ('Boil Over', 'rare', 'action', 'table', 'All players'' modifiers reset to 0 for this round only.'),
  ('Milky Brew', 'rare', 'action', 'opponent', 'Target player''s modifier is 0 for this round.'),
  ('Double Shot', 'rare', 'action', 'self', 'Double your modifier for this round only.'),
  ('Tea-M Reroll', 'rare', 'reaction', 'table', 'All players reroll their d20. New rolls determine the tea-maker.'),
  ('Dunkin Disaster', 'rare', 'reaction', 'table', 'Force the highest and lowest rollers to swap their d20 results this round.'),
  ('Broken Biscuit', 'rare', 'reaction', 'table', 'The lowest roller adds the highest modifier currently on the table to their roll this round.'),
  ('Tea Leaf', 'rare', 'action', 'opponent', 'Steal a chosen player''s entire current modifier. Their modifier drops to 0 and the full amount is added to yours for the rest of the day.'),
  ('Spillage', 'rare', 'action', 'opponent', 'Halve a target''s modifier, rounded down, for the rest of the day; add that removed amount to your roll next round.'),
  ('Chai-nge of Heart', 'rare', 'action', 'opponent', 'Swap your modifier with a target''s for the rest of the day.'),
  ('Bag for Life', 'rare', 'action', 'self', 'Your modifier cannot be reduced, copied, or affected by any card for the rest of the day. You still gain modifier from making tea as normal.'),
  ('Drip Tray', 'rare', 'reaction', 'table', 'Force the player with the highest current modifier to make tea instead. They gain no modifier from this tea-making.'),
  ('Loose Leaf', 'rare', 'reaction', 'self', 'When you are named tea-maker, force a roll-off against the second-lowest roller. Both roll d20 — the loser makes tea instead.'),
  ('Stir the Pot', 'rare', 'action', 'opponent', 'Choose two other players. They swap their d20 results this round.'),
  ('PG Tipped', 'rare', 'action', 'opponent', 'Choose a target. If they roll lower than you this round, they make tea regardless of anyone else. If forced to make tea by this card, they gain no modifier from it.'),
  ('Mug Shot', 'rare', 'reaction', 'opponent', 'Negate a target''s modifier for this round only.'),
  ('Jinxed Biscuit', 'rare', 'action', 'opponent', 'Curse a target. For the next 3 rounds, they cannot benefit from any buff card.'),
  ('Marked for Brew', 'rare', 'action', 'opponent', 'Mark a target. Within the next 5 rounds they take part in, the first time they roll a nat 1 or nat 20, you draw the card instead.'),
  ('Inscribed Saucer', 'rare', 'action', 'table', 'Declare a number 1–20 on play. The next player to roll that exact natural number makes tea, regardless of totals.'),
  ('Mug Mirror', 'rare', 'reaction', 'card', 'That card''s effect resolves on its caster instead of you.'),
  ('Sleeping Camomile', 'rare', 'action', 'opponent', 'Target does not roll this round. Their result counts as a natural 1. If they make tea as a result, they gain no modifier from it.'),
  ('Steaming Mug Bond', 'rare', 'action', 'opponent', 'Link to a target. This round, you both count as having rolled the lower of your two dice. If you are both tied at the lowest, roll off between yourselves to decide the tea-maker.'),
  ('Tea-tally Spent', 'rare', 'reaction', 'self', 'Spend any amount of your modifier and add that much to this round''s roll. Spent modifier is gone for the day.'),
  ('Loaf of Lipton', 'rare', 'action', 'self', 'Skip your roll this round and make tea automatically. You gain double the usual modifier.'),
  ('Brew IOU', 'rare', 'action', 'opponent', 'Choose a target. They make tea this round on your behalf, regardless of the dice. In return, you must make tea on the next round you would have rolled, no roll required. Both parties gain +N modifier from rounds they make.'),
  ('Tea Heist', 'rare', 'action', 'opponent', 'Steal a card from another player''s hand. They draw nothing in return.'),
  ('Stale Biscuit', 'rare', 'action', 'opponent', 'Mark a target. The very next card they would draw goes to you instead.'),
  ('Saucerer''s Apprentice', 'rare', 'reaction', 'card', 'Copy that card''s effect. The original effect still resolves; your copy resolves immediately afterwards.'),
  ('Caffeine Crash', 'rare', 'action', 'opponent', 'Target''s modifier is treated as −1 for the next 2 rounds. After 2 rounds, their modifier returns to its previous value.'),
  ('Bitter Leech', 'rare', 'action', 'opponent', 'For the next 3 rounds, a target loses 1 modifier at the start of each round and you gain it.'),
  ('Scalding Pour', 'rare', 'action', 'table', 'Every other player subtracts 3 from their roll this round.'),
  ('Calami-Tea', 'rare', 'action', 'opponent', 'Choose up to 3 players. For the next 3 rounds, they each subtract 1d4 from their rolls.'),
  ('Liquid Courage', 'rare', 'action', 'opponent', 'Give another player a d6. Once in the next 3 rounds, as a Reaction to any roll, they may roll it and add the result to that roll.'),

  -- Epic (12)
  ('Kettle Crash', 'epic', 'action', 'table', 'All players'' modifiers reset to 0. The day starts again, mechanically.'),
  ('Wild Brew Surge', 'epic', 'action', 'wild', 'Roll a d6 and apply the matching effect: 1. All modifiers reset to 0. 2. You gain +3 modifier for the rest of the day. 3. Swap modifiers with a random player. 4. Everyone rerolls this round''s d20. 5. Highest and lowest modifiers swap holders. 6. Choose who makes tea this round, regardless of the dice.'),
  ('Time for Brew', 'epic', 'reaction', 'table', 'At the end of this round, after the tea-maker is announced, you may scrap the result. The round is replayed entirely — new rolls, new cards may be played.'),
  ('Zariel''s Fall', 'epic', 'reaction', 'table', 'Every d20 flips to its opposite face (21 minus current value): 1→20, 5→16, 19→2. Tea-maker is decided from the flipped values. Original rolls still trigger any nat 1 or nat 20 card draws.'),
  ('Eternal Steep', 'epic', 'action', 'opponent', 'Choose a target. Their modifier is frozen at its current value. They gain no modifier from tea-making, and no card can alter their modifier.'),
  ('The Last Cuppa', 'epic', 'action', 'self', 'You cannot be the tea-maker for the rest of the day under any circumstance. No card, force, mark, or curse can override this.'),
  ('Earl of Earl Grey', 'epic', 'action', 'self', 'Take the title of Earl. While Earl, you cannot be tea-maker — the next-lowest roller makes tea instead. If a card would force tea on you, pass the title to its caster: they become Earl, you lose immunity.'),
  ('Greater Detox', 'epic', 'action', 'card', 'End an ongoing Rare or Epic condition on any player.'),
  ('Prophe-Tea', 'epic', 'action', 'self', 'For the rest of the day, you roll every round with advantage.'),
  ('Topsy-Tea', 'epic', 'action', 'table', 'This round only, the highest roller makes tea instead of the lowest.'),
  ('Genie in the Teapot', 'epic', 'action', 'card', 'Name any other non-Epic Action card in the deck and resolve its effect as if you had played it.'),
  ('Kettle Storm', 'epic', 'action', 'table', 'Every other player subtracts 8 from their roll this round.');

grant select on public.spell_cards to authenticated;
grant all on public.spell_cards to service_role;
